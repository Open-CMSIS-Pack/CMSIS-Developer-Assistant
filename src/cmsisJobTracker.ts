/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The window's record of CMSIS tasks (#47, #46, #12): which task executions
 * are alive, which `cmsis_action` job each one belongs to, and what holds
 * the probe.
 *
 * One tracker per window, shared by every `DebuggingHandler` of the window
 * (the router's and the worker's): `registerCmsisJobTracker` creates it at
 * activation so tasks started from the CMSIS panel are seen too, and
 * `windowJobTracker` creates it on first use where nothing activated the
 * extension (the transport harnesses).
 *
 * How a job is followed:
 *   - `begin` arms it before the command goes out; executions alive at that
 *     moment never complete it;
 *   - it binds the first execution of each expected kind that starts after
 *     that (`reduceJob` in `src/core/cmsisTasks.ts`); a build binds to the
 *     execution the build command returns, when it returns one;
 *   - other CMSIS executions of the window are noted, never the result;
 *   - a build, rebuild, clean, load or erase started elsewhere while no job
 *     of that action is open is adopted, so a repeated call waits for it
 *     instead of starting a second one;
 *   - `requestStop` marks the executions `cmsis_action stop_build` ends, so
 *     that their jobs count as stopped however the task closes;
 *   - the latest settled job of each action is kept until a newer one of
 *     that action settles; older settled jobs are kept 10 minutes; all in
 *     memory only.
 *
 * A build's result is completed after the job settled: an `onDidFinishJob`
 * listener hands its work to `completeWith` — the error lines of a failed
 * build (#15), or the check of a build that exited 0, which CMSIS Solution
 * reports for failed builds too — the job carries a pending `diagnosis`
 * meanwhile, and `waitFor` waits for it as it waits for the job. The window's tracker gets that listener from
 * `src/cmsisBuildDiagnosis.ts`; it reads the failed task's definition
 * (`definitionOf`) and stops its re-run when a build starts
 * (`onDidStartExecution`). `src/windowProblems.ts` journals failed jobs and
 * the error lines of failed builds for the problem journal (#48).
 *
 * The class reads its events from a `TaskEventSource` and time from a
 * `TrackerClock`; tests hand it fakes.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { attachBuildDiagnosis, vscodeDiagnosisHost } from './cmsisBuildDiagnosis';
import { samePath } from './core/bootstrapState';
import { problemJournal } from './core/problemJournal';
import { attachJobJournal } from './windowProblems';
import {
    armJob,
    BUILD_TASK_TYPE,
    classifyByLabelLoosely,
    classifyCmsisTask,
    CmsisTaskKind,
    isSettled,
    Job,
    JobAction,
    JobDiagnosis,
    JobEvent,
    JobState,
    nextTimeCheck,
    PENDING_DIAGNOSIS,
    ProbeOwner,
    reduceJob,
    settleJob,
    TaskFacts,
    withDiagnosis,
    WORKSPACE_SOURCE,
} from './core/cmsisTasks';
import { taskCommandWords } from './core/gdbServerPorts';
import { logger } from './utils/logger';

/** A task's definition: `type`, and for a build the fields cbuild's command line is made from. */
export type TaskDefinitionLike = { readonly type?: string; readonly setup?: unknown } & Readonly<Record<string, unknown>>;

/** The part of a `vscode.TaskExecution` the tracker reads. */
export interface ExecutionLike {
    readonly task: {
        readonly name: string;
        readonly source: string;
        readonly definition?: TaskDefinitionLike;
        /** `vscode.Task.execution`: what a shell or process task runs (`taskCommandWords`). */
        readonly execution?: unknown;
    };
    terminate(): void;
}

/** A subscription in the shape of `vscode.Event`. */
type Listen<T> = (listener: (event: T) => unknown) => { dispose(): unknown };

/** A task as `fetchTasks` lists it: enough for the label pre-check. */
export interface FetchedTask {
    readonly name: string;
    readonly source: string;
    readonly scope?: unknown;
}

/**
 * Where the tracker hears about tasks: `vscode.tasks`, or a fake. Every
 * member may be missing — the transport harnesses' `vscode` stubs offer
 * only some — and the tracker makes do with what is there.
 */
export interface TaskEventSource {
    onDidStartTask?: Listen<{ readonly execution: ExecutionLike }>;
    onDidStartTaskProcess?: Listen<{ readonly execution: ExecutionLike }>;
    onDidEndTaskProcess?: Listen<{ readonly execution: ExecutionLike; readonly exitCode?: number }>;
    onDidEndTask?: Listen<{ readonly execution: ExecutionLike }>;
    /** The executions alive now. */
    taskExecutions?(): readonly ExecutionLike[];
    /** Every task VS Code can run, for the label pre-check. */
    fetchTasks?(): Thenable<readonly FetchedTask[]>;
}

/** The tracker's time: the handler host's clock, or the system's. */
export interface TrackerClock {
    now(): number;
    /** Calls `fire` once after `ms`; the returned function cancels it. */
    startTimer(ms: number, fire: () => void): () => void;
}

/** One CMSIS task execution that is alive in this window. */
export interface LiveExecution {
    readonly key: number;
    readonly execution: ExecutionLike;
    readonly name: string;
    readonly kind: CmsisTaskKind;
    /** When the tracker first saw it. */
    readonly startedAt: number;
    /** Already running when the tracker started, so its real start is unknown. */
    readonly seeded: boolean;
    processStartedAt?: number;
}

/** What `waitForEnd` found: when each execution ended, and which are still alive. */
export interface EndReport {
    endedAt: Map<ExecutionLike, number>;
    alive: ExecutionLike[];
}

/**
 * Settled jobs other than the latest of their action are kept this long. The
 * latest of each action stays until a newer one settles: an agent may ask
 * `status` long after a build failed, while it waited for the user.
 */
export const JOB_RETENTION_MS = 10 * 60_000;
/** The label pre-check gives `fetchTasks` this long. */
export const LABEL_FETCH_MS = 3_000;
/** How often `waitForEnd` looks again when no end event arrives (executions the tracker does not classify). */
const END_POLL_MS = 250;

/** The job id prefix of each action: `b-3` is the third job of the window, a build. */
const ID_PREFIX: Readonly<Record<JobAction, string>> = {
    build: 'b', rebuild: 'rb', clean: 'c', load: 'l', erase: 'e', run: 'g', load_and_run: 'r', load_and_debug: 'd',
};

/** Executions started elsewhere that become jobs of their own, so that a repeated call attaches to them. */
const ADOPTED: ReadonlyMap<CmsisTaskKind, JobAction> = new Map<CmsisTaskKind, JobAction>([
    ['build', 'build'], ['rebuild', 'rebuild'], ['clean', 'clean'], ['load', 'load'], ['erase', 'erase'],
]);

/** Kinds that hold the probe while they are alive. */
const PROBE_KINDS: ReadonlySet<CmsisTaskKind> = new Set<CmsisTaskKind>(['run', 'loadRun', 'load', 'erase', 'targetInfo']);

/** The facts of an execution's task; undefined for anything that is not shaped like one. */
function factsOf(execution: unknown): TaskFacts | undefined {
    const task = (execution as { task?: unknown } | undefined)?.task as
        { name?: unknown; source?: unknown; definition?: { type?: unknown; setup?: unknown; clean?: unknown; rebuild?: unknown } } | undefined;
    if (typeof task?.name !== 'string') {
        return undefined;
    }
    return {
        name: task.name,
        source: typeof task.source === 'string' ? task.source : '',
        type: typeof task.definition?.type === 'string' ? task.definition.type : undefined,
        setup: task.definition?.setup === true,
        clean: task.definition?.clean === true,
        rebuild: task.definition?.rebuild === true,
    };
}

/** True for a value shaped like a `TaskExecution`, such as the one the build command returns. */
export function isExecutionLike(value: unknown): value is ExecutionLike {
    return factsOf(value) !== undefined && typeof (value as { terminate?: unknown }).terminate === 'function';
}

/** The modification time of the folder's `.vscode/tasks.json`, or -1 when there is none. */
function tasksJsonStamp(folder: string): number {
    try {
        return fs.statSync(path.join(folder, '.vscode', 'tasks.json')).mtimeMs;
    } catch {
        return -1;
    }
}

/**
 * Is a fetched task scoped to this workspace folder, as CMSIS Solution
 * requires of the tasks it runs? Compared as `samePath` compares: on Windows
 * VS Code's fsPath writes the drive letter in lower case (`c:\…`), a path from
 * elsewhere may not.
 */
function scopedTo(scope: unknown, folder: string): boolean {
    const fsPath = (scope as { uri?: { fsPath?: unknown } } | undefined)?.uri?.fsPath;
    return typeof fsPath === 'string' && samePath(fsPath, folder);
}

export class CmsisJobTracker {
    /** Alive CMSIS executions by key. */
    private readonly live = new Map<number, LiveExecution>();
    /** Every execution object seen, alive or ended, with its key. */
    private readonly keys = new WeakMap<object, number>();
    /** The key of the latest execution of each task object, for end events that come with a new wrapper. */
    private readonly taskKeys = new WeakMap<object, number>();
    private readonly jobs = new Map<string, Job>();
    private readonly waiters = new Map<string, Set<(job: Job) => void>>();
    private readonly checks = new Map<string, () => void>();
    private readonly endWatchers = new Set<() => void>();
    private readonly finishListeners = new Set<(job: Job) => void>();
    private readonly diagnosisListeners = new Set<(job: Job) => void>();
    private readonly startListeners = new Set<(execution: LiveExecution) => void>();
    /** Work that completes a settled job's result (#15), by job id. */
    private readonly followUps = new Map<string, Promise<void>>();
    /** The task definition of each CMSIS execution seen, by key, while a job or the live list refers to it. */
    private readonly definitions = new Map<number, TaskDefinitionLike>();
    /** The command words of each CMSIS execution seen, by key, kept as long as its definition. */
    private readonly commands = new Map<number, readonly string[]>();
    private readonly subscriptions: Array<{ dispose(): unknown }> = [];
    private readonly labelCache = new Map<string, { stamp: number; labels: ReadonlySet<string> }>();
    private flashes: Array<{ id: number; startedAt: number }> = [];
    private nextKey = 1;
    private jobCount = 0;
    private flashCount = 0;

    constructor(
        private readonly source: TaskEventSource,
        private readonly clock: TrackerClock,
        private readonly log: (message: string) => void = () => undefined,
    ) {
        this.listen(source.onDidStartTask, (event) => this.sight(event.execution, 'taskStart', false));
        this.listen(source.onDidStartTaskProcess, (event) => this.sight(event.execution, 'processStart', false));
        this.listen(source.onDidEndTaskProcess, (event) => this.ended(event.execution, event.exitCode));
        this.listen(source.onDidEndTask, (event) => this.ended(event.execution, undefined, true));
        for (const execution of this.aliveInVsCode() ?? []) {
            this.sight(execution, 'taskStart', true);
        }
    }

    // ── jobs ──

    /** Arm a job for a call that is about to issue its command. */
    begin(action: JobAction, target: string | undefined): Job {
        this.prune();
        const job = armJob({
            id: this.newId(action), action, target, origin: 'call', at: this.clock.now(), preexisting: [...this.live.keys()],
        });
        this.jobs.set(job.id, job);
        return job;
    }

    /** The command went out and its kick-off is over: the not-started window begins. */
    issued(id: string): void {
        this.apply(id, { type: 'issued', at: this.clock.now() });
    }

    /** The build command returned this; when it is a task execution, it is the job's build. */
    identify(id: string, returned: unknown): void {
        if (!isExecutionLike(returned)) {
            return;
        }
        const facts = factsOf(returned);
        const kind = facts ? this.kindOf(facts) : undefined;
        if (!facts || !kind) {
            return;
        }
        let key = this.liveKeyOf(returned);
        if (key === undefined) {
            this.sight(returned, 'taskStart', false);
            key = this.liveKeyOf(returned);
        }
        if (key !== undefined) {
            this.apply(id, { type: 'identity', key, name: facts.name, kind, at: this.clock.now() });
        }
    }

    /** Settle a job from outside: its command failed before any task could start. */
    settle(id: string, state: JobState, note?: string): void {
        const job = this.jobs.get(id);
        if (job) {
            this.store(job, settleJob(job, state, this.clock.now(), note));
        }
    }

    /** Forget an open job that turned out to have no task of its own: a load_and_debug without a pre-launch Load. */
    discard(id: string): void {
        const job = this.jobs.get(id);
        if (!job || isSettled(job.state)) {
            return;
        }
        this.jobs.delete(id);
        this.checks.get(id)?.();
        this.checks.delete(id);
        for (const wake of [...(this.waiters.get(id) ?? [])]) {
            wake(job);
        }
        this.waiters.delete(id);
    }

    /** The job as it is now. */
    job(id: string): Job | undefined {
        return this.jobs.get(id);
    }

    /**
     * Resolves with the job once it settled and the work that completes its
     * result (`completeWith`) is done, or with the job as it is when
     * `deadline` (the tracker's clock) passes first. Never rejects.
     */
    waitFor(id: string, deadline: number): Promise<Job | undefined> {
        const job = this.jobs.get(id);
        const remaining = deadline - this.clock.now();
        if (!job || this.isFinal(job) || remaining <= 0) {
            return Promise.resolve(job);
        }
        return new Promise((resolve) => {
            const waiting = this.waiters.get(id) ?? new Set<(job: Job) => void>();
            this.waiters.set(id, waiting);
            let cancel: () => void = () => undefined;
            const wake = (current: Job): void => {
                waiting.delete(wake);
                cancel();
                resolve(current);
            };
            waiting.add(wake);
            cancel = this.clock.startTimer(remaining, () => wake(this.jobs.get(id) ?? job));
        });
    }

    /** The latest open job, of `action` when given. */
    inFlight(action?: JobAction): Job | undefined {
        this.prune();
        let latest: Job | undefined;
        for (const job of this.jobs.values()) {
            if (!isSettled(job.state) && (action === undefined || job.action === action) && (!latest || job.armedAt >= latest.armedAt)) {
                latest = job;
            }
        }
        return latest;
    }

    /** Every open job, oldest first. */
    openJobs(): Job[] {
        this.prune();
        return [...this.jobs.values()].filter((job) => !isSettled(job.state)).sort((a, b) => a.armedAt - b.armedAt);
    }

    /** The latest settled job of `action`, however long ago it settled. */
    last(action: JobAction): Job | undefined {
        return this.recent().find((job) => job.action === action);
    }

    /** The latest settled job of each action, however long ago it settled, newest first. */
    recent(): Job[] {
        this.prune();
        return this.latestSettled().sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
    }

    /** The latest settled job of each action, in no particular order. */
    private latestSettled(): Job[] {
        const latest = new Map<JobAction, Job>();
        for (const job of this.jobs.values()) {
            if (!isSettled(job.state)) {
                continue;
            }
            const known = latest.get(job.action);
            if (!known || (job.settledAt ?? 0) >= (known.settledAt ?? 0)) {
                latest.set(job.action, job);
            }
        }
        return [...latest.values()];
    }

    /**
     * Called with each job that settles, before its waiters are woken, so
     * that a listener can still `completeWith` it; the home of #48's journal.
     */
    onDidFinishJob(listener: (job: Job) => void): { dispose(): void } {
        this.finishListeners.add(listener);
        return { dispose: () => this.finishListeners.delete(listener) };
    }

    /**
     * Make `work` part of the result of settled job `id` (#15): the job
     * carries a pending `diagnosis` until `work` resolves with the final one,
     * and `waitFor` waits for it. A rejected `work` becomes a diagnosis that
     * says so. A build that exited 0 whose check says `failed` becomes a
     * failed job (`withDiagnosis`). Meant for `onDidFinishJob` listeners;
     * once per job.
     */
    completeWith(id: string, work: Promise<JobDiagnosis>): void {
        const job = this.jobs.get(id);
        if (!job || !isSettled(job.state) || this.followUps.has(id)) {
            return;
        }
        this.jobs.set(id, { ...job, diagnosis: PENDING_DIAGNOSIS });
        const settled = work.then((diagnosis) => diagnosis, (caught: unknown) => failedDiagnosis(caught)).then((diagnosis) => {
            this.followUps.delete(id);
            const current = this.jobs.get(id);
            if (!current) {
                return;
            }
            const completed = withDiagnosis(current, diagnosis);
            this.jobs.set(id, completed);
            this.wake(id, completed);
            for (const listener of [...this.diagnosisListeners]) {
                try {
                    listener(completed);
                } catch (caught) {
                    logger.error(`CMSIS job tracker: a diagnosis listener failed on job ${id}`, caught);
                }
            }
        });
        this.followUps.set(id, settled);
    }

    /** True while work handed to `completeWith` for job `id` goes on. */
    isCompleting(id: string): boolean {
        return this.followUps.has(id);
    }

    /** Called with a job once the work handed to `completeWith` has put its final `diagnosis` on it (#15, for #48's journal). */
    onDidDiagnoseJob(listener: (job: Job) => void): { dispose(): void } {
        this.diagnosisListeners.add(listener);
        return { dispose: () => this.diagnosisListeners.delete(listener) };
    }

    /** The definition of the task an execution the tracker saw ran, by its key; kept while a job or the live list refers to it. */
    definitionOf(key: number): TaskDefinitionLike | undefined {
        return this.definitions.get(key);
    }

    /**
     * The program and arguments of the task an execution the tracker saw ran
     * (`taskCommandWords`), by its key; kept while a job or the live list
     * refers to it. Undefined for a task without a shell or process execution.
     */
    commandOf(key: number): readonly string[] | undefined {
        return this.commands.get(key);
    }

    /** Called with each CMSIS execution when the tracker first sees it start. */
    onDidStartExecution(listener: (execution: LiveExecution) => void): { dispose(): void } {
        this.startListeners.add(listener);
        return { dispose: () => this.startListeners.delete(listener) };
    }

    // ── executions and the probe ──

    /** The CMSIS executions alive in this window, oldest first. */
    liveExecutions(): LiveExecution[] {
        return [...this.live.values()].sort((a, b) => a.startedAt - b.startedAt);
    }

    /** What holds, or is about to hold, the probe: CMSIS Run, Load+Run, Load, Erase, TargetInfo, and `flash`. */
    probeOwners(): ProbeOwner[] {
        const owners: ProbeOwner[] = [];
        for (const execution of this.liveExecutions()) {
            if (PROBE_KINDS.has(execution.kind)) {
                owners.push({ name: execution.name, kind: execution.kind, startedAt: execution.seeded ? undefined : execution.startedAt });
            }
        }
        for (const flash of this.flashes) {
            owners.push({ name: 'flash', kind: 'flash', startedAt: flash.startedAt });
        }
        return owners;
    }

    /** Marks this window's `flash` as programming until the returned function is called. */
    beginFlash(): () => void {
        const id = ++this.flashCount;
        this.flashes.push({ id, startedAt: this.clock.now() });
        return () => {
            this.flashes = this.flashes.filter((flash) => flash.id !== id);
        };
    }

    /**
     * The executions `cmsis-csolution.cmsisStopRun` terminates: every one
     * whose name starts with "CMSIS". VS Code's own list when it offers one,
     * else the tracker's.
     */
    stoppableExecutions(): ExecutionLike[] {
        const listed = this.aliveInVsCode();
        const all = listed ?? this.liveExecutions().map((execution) => execution.execution);
        return all.filter((execution) => factsOf(execution)?.name.startsWith('CMSIS') === true);
    }

    /**
     * The executions of CMSIS Solution's build task type alive now — builds,
     * rebuilds, cleans and setups — which its Stop Build ends. VS Code's own
     * list when it offers one, else the tracker's.
     */
    buildExecutions(): ExecutionLike[] {
        const listed = this.aliveInVsCode();
        const all = listed ?? this.liveExecutions().map((execution) => execution.execution);
        return all.filter((execution) => factsOf(execution)?.type === BUILD_TASK_TYPE);
    }

    /**
     * `cmsis_action stop_build` is about to end these executions: each counts
     * as stopped in its job (state `cancelled`), whatever exit code its task
     * closes with. Returns the open jobs they are bound to.
     */
    requestStop(executions: readonly ExecutionLike[]): Job[] {
        const keys = executions.map((execution) => this.liveKeyOf(execution)).filter((key): key is number => key !== undefined);
        for (const key of keys) {
            this.dispatch({ type: 'stopRequested', key, at: this.clock.now() });
        }
        return this.openJobs().filter((job) => job.executions.some((execution) => execution.role !== undefined && keys.includes(execution.key)));
    }

    /** Resolves when every one of `executions` has ended, or after `ms` with those still alive. */
    waitForEnd(executions: readonly ExecutionLike[], ms: number): Promise<EndReport> {
        const endedAt = new Map<ExecutionLike, number>();
        const look = (): ExecutionLike[] => {
            const alive: ExecutionLike[] = [];
            for (const execution of executions) {
                if (endedAt.has(execution)) {
                    continue;
                }
                if (this.isAlive(execution)) {
                    alive.push(execution);
                } else {
                    endedAt.set(execution, this.clock.now());
                }
            }
            return alive;
        };
        const first = look();
        if (first.length === 0 || ms <= 0) {
            return Promise.resolve({ endedAt, alive: first });
        }
        return new Promise((resolve) => {
            let stopPoll: () => void = () => undefined;
            let stopDeadline: () => void = () => undefined;
            const finish = (alive: ExecutionLike[]): void => {
                this.endWatchers.delete(check);
                stopPoll();
                stopDeadline();
                resolve({ endedAt, alive });
            };
            const check = (): void => {
                const alive = look();
                if (alive.length === 0) {
                    finish(alive);
                }
            };
            const poll = (): void => {
                check();
                if (this.endWatchers.has(check)) {
                    stopPoll = this.clock.startTimer(END_POLL_MS, poll);
                }
            };
            this.endWatchers.add(check);
            stopPoll = this.clock.startTimer(END_POLL_MS, poll);
            stopDeadline = this.clock.startTimer(ms, () => finish(look()));
        });
    }

    /**
     * The labels of the tasks CMSIS Solution can run in `folder` (source
     * `Workspace`, scoped to the folder), from `fetchTasks` within 3 s and
     * cached until the folder's tasks.json changes; `fresh` reads them again
     * (after the tasks were rewritten, VS Code may list the new ones a moment
     * later than the file changed). Undefined when they could not be read, so
     * that the caller does not refuse on a guess.
     */
    async taskLabels(folder: string, fresh = false): Promise<ReadonlySet<string> | undefined> {
        const fetchTasks = this.source.fetchTasks;
        if (!fetchTasks) {
            return undefined;
        }
        const stamp = tasksJsonStamp(folder);
        const cached = this.labelCache.get(folder);
        if (!fresh && cached && cached.stamp === stamp) {
            return cached.labels;
        }
        let tasks: readonly FetchedTask[] | undefined;
        try {
            tasks = await this.within(LABEL_FETCH_MS, Promise.resolve(fetchTasks.call(this.source)));
        } catch (caught) {
            this.log(`CMSIS job tracker: fetchTasks failed (${caught instanceof Error ? caught.message : String(caught)}); no label pre-check`);
            return undefined;
        }
        if (tasks === undefined) {
            this.log('CMSIS job tracker: fetchTasks took longer than 3 s; no label pre-check');
            return undefined;
        }
        const labels = new Set(tasks.filter((task) => task.source === WORKSPACE_SOURCE && scopedTo(task.scope, folder)).map((task) => task.name));
        this.labelCache.set(folder, { stamp, labels });
        return labels;
    }

    dispose(): void {
        for (const subscription of this.subscriptions.splice(0)) {
            try {
                subscription.dispose();
            } catch {
                // A failing dispose must not keep the others.
            }
        }
        for (const cancel of this.checks.values()) {
            cancel();
        }
        this.checks.clear();
        for (const [id, waiting] of this.waiters) {
            const job = this.jobs.get(id);
            for (const wake of [...waiting]) {
                if (job) {
                    wake(job);
                }
            }
        }
    }

    // ── event handling ──

    private listen<T>(event: Listen<T> | undefined, handle: (value: T) => void): void {
        if (typeof event !== 'function') {
            return;
        }
        try {
            this.subscriptions.push(event((value) => {
                try {
                    handle(value);
                } catch (caught) {
                    logger.error('CMSIS job tracker: a task event could not be recorded', caught);
                }
            }));
        } catch (caught) {
            logger.warn('CMSIS job tracker: could not subscribe to a task event', caught);
        }
    }

    /** VS Code's list of alive executions, when the API offers one. */
    private aliveInVsCode(): readonly ExecutionLike[] | undefined {
        try {
            return this.source.taskExecutions?.();
        } catch {
            return undefined;
        }
    }

    private isAlive(execution: ExecutionLike): boolean {
        const listed = this.aliveInVsCode();
        if (listed) {
            return listed.includes(execution);
        }
        const key = this.keyOf(execution, true);
        return key !== undefined && this.live.has(key);
    }

    /** The CMSIS kind of a task; a label that matches only loosely is used and logged. */
    private kindOf(facts: TaskFacts): CmsisTaskKind | undefined {
        const exact = classifyCmsisTask(facts);
        if (exact) {
            return exact;
        }
        const loose = classifyByLabelLoosely(facts);
        if (loose) {
            this.log(`CMSIS job tracker: task '${facts.name}' (source '${facts.source}', type '${facts.type ?? '?'}') `
                + `taken as ${loose} by a case-insensitive label match`);
        }
        return loose;
    }

    /**
     * The key of an execution: by the object itself, else — for fakes and
     * proxies that hand a new object per event — an alive execution of the
     * same task object, else one of the same name. With `ended`, also the
     * latest execution of the task object that has ended.
     */
    private keyOf(execution: ExecutionLike, ended: boolean): number | undefined {
        const known = this.keys.get(execution);
        if (known !== undefined) {
            return known;
        }
        const alive = this.liveExecutions().reverse();
        const sameTask = alive.find((entry) => entry.execution.task === execution.task);
        if (sameTask) {
            return sameTask.key;
        }
        const sameName = alive.find((entry) => entry.name === execution.task?.name);
        if (sameName) {
            return sameName.key;
        }
        return ended && typeof execution.task === 'object' && execution.task !== null ? this.taskKeys.get(execution.task) : undefined;
    }

    private liveKeyOf(execution: ExecutionLike): number | undefined {
        const key = this.keyOf(execution, false);
        return key !== undefined && this.live.has(key) ? key : undefined;
    }

    private remember(execution: ExecutionLike, key: number): void {
        this.keys.set(execution, key);
        if (typeof execution.task === 'object' && execution.task !== null) {
            this.taskKeys.set(execution.task, key);
        }
    }

    /** A task or its process started (or was alive when the tracker started). */
    private sight(execution: ExecutionLike, type: 'taskStart' | 'processStart', seeded: boolean): void {
        const facts = factsOf(execution);
        const kind = facts ? this.kindOf(facts) : undefined;
        if (!facts || !kind) {
            return;
        }
        const known = this.keys.get(execution);
        if (known !== undefined && !this.live.has(known)) {
            return;
        }
        const now = this.clock.now();
        let entry = this.live.get(known ?? this.liveKeyOf(execution) ?? -1);
        const first = entry === undefined;
        if (!entry) {
            entry = { key: this.nextKey++, execution, name: facts.name, kind, startedAt: now, seeded };
            this.live.set(entry.key, entry);
            const definition = execution.task?.definition;
            if (definition && typeof definition === 'object') {
                this.definitions.set(entry.key, { ...definition });
            }
            const words = taskCommandWords(execution.task);
            if (words) {
                this.commands.set(entry.key, words);
            }
        }
        this.remember(execution, entry.key);
        if (type === 'processStart' && entry.processStartedAt === undefined) {
            entry.processStartedAt = now;
        }
        const event: JobEvent = { type, key: entry.key, name: entry.name, kind, at: now };
        this.dispatch(event);
        if (first && !this.isBound(entry.key)) {
            this.adopt(kind, event);
        }
        if (first) {
            this.announceStart(entry);
        }
    }

    private announceStart(entry: LiveExecution): void {
        for (const listener of [...this.startListeners]) {
            try {
                listener(entry);
            } catch (caught) {
                logger.error(`CMSIS job tracker: a start listener failed on '${entry.name}'`, caught);
            }
        }
    }

    /** A process ended (with its exit code) or a task ended. */
    private ended(execution: ExecutionLike, exitCode: number | undefined, taskEnd = false): void {
        const key = this.keyOf(execution, true);
        if (key === undefined) {
            return;
        }
        this.remember(execution, key);
        const at = this.clock.now();
        this.dispatch(taskEnd ? { type: 'taskEnd', key, at } : { type: 'processEnd', key, exitCode, at });
        // The process is what held the probe; a compound task without one ends with its task.
        this.live.delete(key);
        for (const watcher of [...this.endWatchers]) {
            watcher();
        }
    }

    private isBound(key: number): boolean {
        for (const job of this.jobs.values()) {
            if (job.executions.some((execution) => execution.key === key && execution.role !== undefined)) {
                return true;
            }
        }
        return false;
    }

    /** A build, rebuild, clean, load or erase nobody asked for: follow it as a job, unless one of that action is open. */
    private adopt(kind: CmsisTaskKind, event: JobEvent): void {
        const action = ADOPTED.get(kind);
        if (!action || this.inFlight(action)) {
            return;
        }
        const job = armJob({ id: this.newId(action), action, origin: 'adopted', at: event.at, preexisting: [] });
        this.jobs.set(job.id, job);
        this.apply(job.id, event);
    }

    private dispatch(event: JobEvent): void {
        for (const id of [...this.jobs.keys()]) {
            this.apply(id, event);
        }
    }

    private apply(id: string, event: JobEvent): void {
        const job = this.jobs.get(id);
        if (job) {
            this.store(job, reduceJob(job, event));
        }
    }

    /** Keep the new value of a job; re-arm its time check and tell the waiters when it settled. */
    private store(before: Job, after: Job): void {
        if (after === before) {
            return;
        }
        this.jobs.set(after.id, after);
        this.checks.get(after.id)?.();
        this.checks.delete(after.id);
        const due = nextTimeCheck(after);
        if (due !== undefined) {
            this.checks.set(after.id, this.clock.startTimer(Math.max(0, due - this.clock.now()), () => {
                this.checks.delete(after.id);
                this.apply(after.id, { type: 'tick', at: Math.max(this.clock.now(), due) });
            }));
        }
        if (!isSettled(before.state) && isSettled(after.state)) {
            this.finished(after);
        }
    }

    /** The listeners first, since one may `completeWith` the job; its waiters then wait for that work. */
    private finished(job: Job): void {
        for (const listener of [...this.finishListeners]) {
            try {
                listener(job);
            } catch (caught) {
                logger.error(`CMSIS job tracker: a listener failed on job ${job.id}`, caught);
            }
        }
        if (!this.followUps.has(job.id)) {
            this.wake(job.id, this.jobs.get(job.id) ?? job);
        }
    }

    private wake(id: string, job: Job): void {
        for (const wake of [...(this.waiters.get(id) ?? [])]) {
            wake(job);
        }
        this.waiters.delete(id);
    }

    /** Settled, and nothing handed to `completeWith` is still going. */
    private isFinal(job: Job): boolean {
        return isSettled(job.state) && !this.followUps.has(job.id);
    }

    private newId(action: JobAction): string {
        return `${ID_PREFIX[action]}-${++this.jobCount}`;
    }

    /**
     * Drop settled jobs older than the retention, except the latest of each
     * action, with anything still waiting on them, and definitions and
     * commands no one refers to.
     */
    private prune(): void {
        const cutoff = this.clock.now() - JOB_RETENTION_MS;
        const latest = new Set(this.latestSettled());
        for (const [id, job] of this.jobs) {
            if (isSettled(job.state) && (job.settledAt ?? 0) < cutoff && !latest.has(job) && !this.followUps.has(id)) {
                this.jobs.delete(id);
                this.waiters.delete(id);
            }
        }
        const referred = new Set<number>(this.live.keys());
        for (const job of this.jobs.values()) {
            for (const execution of job.executions) {
                referred.add(execution.key);
            }
        }
        for (const key of [...this.definitions.keys(), ...this.commands.keys()]) {
            if (!referred.has(key)) {
                this.definitions.delete(key);
                this.commands.delete(key);
            }
        }
    }

    /** `pending`, or undefined when it takes longer than `ms` on the tracker's clock. */
    private within<T>(ms: number, pending: Promise<T>): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            const cancel = this.clock.startTimer(ms, () => resolve(undefined));
            pending.then((value) => {
                cancel();
                resolve(value);
            }, (caught: unknown) => {
                cancel();
                reject(caught);
            });
        });
    }
}

/** What a job's result says when the work that was to complete it failed. */
function failedDiagnosis(caught: unknown): JobDiagnosis {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return {
        state: 'done', source: 'none', errors: [], warnings: [], errorCount: 0, warningCount: 0,
        note: `collecting the error lines failed: ${reason}`,
        text: `No error lines: collecting them failed (${reason}).`,
    };
}

// ── The window's tracker ────────────────────────────────────────────────────

const SYSTEM_CLOCK: TrackerClock = {
    now: () => Date.now(),
    startTimer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
    },
};

/** `vscode.tasks`, member by member: the transport stubs have no `tasks` or only part of it. */
function vscodeTaskSource(): TaskEventSource {
    const tasks: Partial<typeof vscode.tasks> | undefined = vscode.tasks;
    if (!tasks) {
        return {};
    }
    const fetchTasks = tasks.fetchTasks;
    return {
        onDidStartTask: tasks.onDidStartTask,
        onDidStartTaskProcess: tasks.onDidStartTaskProcess,
        onDidEndTaskProcess: tasks.onDidEndTaskProcess,
        onDidEndTask: tasks.onDidEndTask,
        taskExecutions: () => tasks.taskExecutions ?? [],
        fetchTasks: fetchTasks ? () => fetchTasks() : undefined,
    };
}

let windowTracker: CmsisJobTracker | undefined;
let windowDiagnosis: { dispose(): void } | undefined;
let windowJournal: { dispose(): void } | undefined;

/**
 * This window's tracker, created on first use, with the error lines of
 * failed builds (#15) and its failures journaled in the window's problem
 * journal (#48).
 */
export function windowJobTracker(): CmsisJobTracker {
    if (!windowTracker) {
        windowTracker = new CmsisJobTracker(vscodeTaskSource(), SYSTEM_CLOCK, (message) => logger.info(message));
        windowDiagnosis = attachBuildDiagnosis(windowTracker, vscodeDiagnosisHost(SYSTEM_CLOCK));
        windowJournal = attachJobJournal(windowTracker, problemJournal());
    }
    return windowTracker;
}

/**
 * Create the window's tracker at activation, so that executions started
 * from the CMSIS panel before the first tool call are known, and drop it
 * with the extension.
 */
export function registerCmsisJobTracker(context: vscode.ExtensionContext): void {
    const tracker = windowJobTracker();
    context.subscriptions.push({
        dispose: () => {
            if (windowTracker === tracker) {
                windowDiagnosis?.dispose();
                windowDiagnosis = undefined;
                windowJournal?.dispose();
                windowJournal = undefined;
                windowTracker = undefined;
            }
            tracker.dispose();
        },
    });
    logger.info('CMSIS job tracker registered (task events of this window)');
}
