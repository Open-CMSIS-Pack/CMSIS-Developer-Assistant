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
 * What agents read about CMSIS jobs (#47, #12, #46): the result of a job —
 * a ✅ line, a `TASK_FAILED` or `INVALID_ARGUMENT` error, or a `running`
 * reply that carries the job in `data` — the `status` report, the probe
 * guard's `PROBE_BUSY` refusals, and the task line of `get_session_status`.
 *
 * Every result names the task, its exit code, how long it ran and the job id,
 * so that a later `status` call can be matched to it. A failed build adds
 * the error lines of its diagnosis (#15, `src/cmsisBuildDiagnosis.ts`), or
 * says they are still being collected, and carries them in `data`. A build
 * that exited 0 is reported once its check is done (CMSIS Solution reports
 * exit 0 for failed builds too): ✅, ❌ with the error lines, or ⚠️ when an
 * image was not rewritten and the check could not decide. A rebuild reads
 * like a build; a clean says what it removed, or ⚠️ when an image is left. A
 * task that was stopped says so, and that its outputs are incomplete. The
 * hint after a failed Load or Erase follows the program the task ran:
 * pyOCD, J-Link — missing from the tasks' PATH when it failed at once — or
 * another one.
 */

import {
    ACTION_PHASES,
    BuildMessage,
    bystanders,
    executionIn,
    GuardVerdict,
    hasCmsisTasks,
    isBuildAction,
    Job,
    JobAction,
    JobDiagnosis,
    JobExecution,
    NOTHING_STARTED_MS,
    ProbeOwner,
    runtimeOf,
    wasStopped,
} from '../core/cmsisTasks';
import { DIAGNOSTIC_RERUN_CAP_MS } from '../core/buildFailure';
import { PROBE_SOFTWARE_STEPS, ProgramFacts, RESTART_VS_CODE } from '../core/programLookup';
import { JsonObject, ToolError, ToolReply, ToolText } from '../core/toolResult';
import type { LiveExecution } from '../cmsisJobTracker';

/** `0.6 s`, `9 s`, `140 s`, `3 min`, `2 h`. */
export function formatDuration(ms: number): string {
    const safe = Math.max(0, ms);
    if (safe < 1_000) {
        return `${(safe / 1_000).toFixed(1)} s`;
    }
    if (safe < 180_000) {
        return `${Math.round(safe / 1_000)} s`;
    }
    if (safe < 3 * 3_600_000) {
        return `${Math.round(safe / 60_000)} min`;
    }
    return `${Math.round(safe / 3_600_000)} h`;
}

/** What follows a success, by action. */
const AFTER_SUCCESS: Readonly<Record<JobAction, string>> = {
    build: ' The firmware is built — use cmsis_action load or load_and_debug to flash it.',
    rebuild: ' The firmware is rebuilt from scratch — use cmsis_action load or load_and_debug to flash it.',
    clean: ' It covers the whole solution (CMSIS Solution: "Clean All \'out\' and \'tmp\' Directories"), not only this target: '
        + 'cmsis_action build before load or flash.',
    load: ' Firmware flashed. Use cmsis_action attach or load_and_debug to start a debug session.',
    erase: ' Target flash erased.',
    run: ' CMSIS Run has ended; the GDB server is gone.',
    load_and_run: ' Firmware flashed and running (no debug session).',
    load_and_debug: ' Its pre-launch Load is done; the debug session starts next — poll get_session_status.',
};

const BUILD_FAILED_HINT = 'get_recent_problems lists what the Problems panel shows; otherwise ask the user for the errors in the cbuild terminal '
    + '— do not run cbuild yourself. Fix them, then cmsis_action build again. This is a terminal result — do not wait for an output file.';

/** After a failed build whose error lines the result shows. */
const BUILD_ERRORS_HINT = 'Fix the first error, then cmsis_action build again. This is a terminal result — do not wait for an output file.';
/** A build still running after this long gets the way out of a task that outlived its build. */
const LONG_BUILD_MS = 120_000;
/**
 * A Load or Erase task alive this long is stuck, not programming. Programming
 * a 2 MB image over SWD takes well under a minute; pyOCD's tasks wait without
 * a limit for a probe they cannot see or that another holds, and print their
 * "Waiting for a debug probe" once, in a terminal no tool reads (#69). In the
 * field such a Load ran 30 and 43 minutes while every status reply called it
 * merely running.
 */
export const LONG_FLASH_MS = 120_000;
/** The task kinds that program the target and then end; CMSIS Run and the single Load+Run task stay alive on purpose. */
const FLASH_KINDS: ReadonlySet<string> = new Set(['load', 'erase']);

/** csolution's word for files a component brings that are not there yet: `file '…/RTX_Config.c' not found; use --update-rte`. */
const NEEDS_RTE_UPDATE = /use --update-rte/;
const RTE_UPDATE_HINT = 'csolution misses files that a component brings ("use --update-rte"): cmsis_action refresh writes them — the Refresh '
    + '(Update RTE) of the CMSIS view — then cmsis_action build again.';

/** After a failed build whose error lines are still being collected. */
const BUILD_LINES_PENDING_HINT = 'Call cmsis_action {action:\'status\'} for the error lines — do not start another build to see them. '
    + 'This is a terminal result — do not wait for an output file.';

/** After a build that exited 0 but whose image the check could not confirm. */
const BUILD_UNVERIFIED_NEXT = 'Before you load this image, ask the user whether the build in the cbuild terminal succeeded — do not run cbuild yourself.';

/** After a clean that exited 0 but left an image behind. */
const CLEAN_UNVERIFIED_NEXT = 'Ask the user whether the clean in the cbuild terminal succeeded — do not delete the files yourself; '
    + 'a build compiles what is out of date either way.';

/** The next step of the refusal for a tasks.json without CMSIS tasks: the user chooses the debugger the tasks are written for. */
const CHOOSE_DEBUGGER_HINT = 'Ask the user to open Manage Solution Settings (command cmsis-csolution.manageSolution) and choose a debugger '
    + 'on its Debugger page; CMSIS Solution then writes the CMSIS tasks. Until then, flash programs the target.';

/** Messages of a diagnosis that go into `data`, of each kind. */
const DATA_MESSAGES = 10;

/** What "Waiting for a debug probe" in a task's output means: pyOCD prints it for a probe that is taken and for one it cannot see. */
const PROBE_WAIT_MEANING = '"Waiting for a debug probe" there means pyOCD sees no free probe: another task or session holds it '
    + '(cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks), or the probe is not connected or lacks its USB driver (ask the user).';

/** What J-Link Commander's two connect failures in a task's output mean. */
const JLINK_CONNECT_MEANING = '"Cannot connect to J-Link" there means J-Link finds no free probe: another task or session holds it '
    + '(cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks), or the probe is not connected or lacks its USB driver (ask the user); '
    + '"Cannot connect to target" means the probe answers but the device does not: its power, the cable, or the device name the task passes.';

/** The last sentence of a failed task's hint. */
const TERMINAL_RESULT = 'This is a terminal result — do not wait for an output file.';

/** `(searched: .cmsis/tools-environment.yml, VS Code's PATH)`, or nothing when no PATH was there to search. */
function searchedPlaces(searched: readonly string[]): string {
    return searched.length > 0 ? ` (searched: ${searched.join(', ')})` : '';
}

/** The hint after a failed J-Link task: its program missing from the tasks' PATH, or J-Link's own failure in the terminal. */
function jlinkFailedHint(task: string, facts: ProgramFacts): string {
    const program = facts.program ?? 'J-Link';
    const lookup = facts.lookup;
    if (lookup && !lookup.found) {
        const missing = `${program} is not on the PATH of the CMSIS tasks${searchedPlaces(lookup.searched)}, so '${task}' could not start it`;
        const next = lookup.installedIn
            ? `, but ${lookup.installedIn} holds it. Ask the user to add that folder to the system or user PATH, ${RESTART_VS_CODE}`
            : `. Ask the user to install the SEGGER J-Link Software or add its folder to the system or user PATH, ${RESTART_VS_CODE}`;
        return `${missing}${next}; ${PROBE_SOFTWARE_STEPS} ${TERMINAL_RESULT}`;
    }
    const ran = lookup?.found ? ` ${program} is on the PATH of the CMSIS tasks (${lookup.found.file}, from ${lookup.found.place}), so it ran and `
        + 'reported the failure there.' : '';
    return `Its output is in the '${task}' terminal, which no tool reads: ask the user for the terminal's last lines.${ran} `
        + `${JLINK_CONNECT_MEANING} ${TERMINAL_RESULT}`;
}

/**
 * The hint after a failed Load, Erase, single Load+Run task, or the Load
 * before a debug session. No tool reads a task terminal (#69). `facts` says
 * what the task ran (`src/handler/taskProgram.ts`): a pyOCD task, or one
 * whose command is not known, is pointed at `flash`, which returns pyOCD's
 * own lines; a J-Link task at its PATH or at J-Link's own messages; any
 * other at the terminal alone.
 */
export function flashFailedHint(task: string, facts?: ProgramFacts): string {
    if (facts?.kind === 'jlink') {
        return jlinkFailedHint(task, facts);
    }
    if (facts?.kind === 'fvp' || facts?.kind === 'other') {
        return `Its output is in the '${task}' terminal, which no tool reads: ask the user for the terminal's last lines. ${TERMINAL_RESULT}`;
    }
    return `Its output is in the '${task}' terminal, which no tool reads: call flash, which returns pyOCD's own error lines, `
        + `or ask the user for the terminal's last lines. ${PROBE_WAIT_MEANING} `
        + 'This is a terminal result — do not wait for an output file.';
}

const RUN_FAILED_HINT = 'A GDB server that ends at once usually finds the probe or its port taken, or no probe at all. Its output is in the '
    + '\'CMSIS Run\' terminal, which no tool reads: ask the user for its last lines when the cause is not clear. '
    + 'cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks; cmsis_action {action:\'stop_run\'} ends them.';

/**
 * What the adapters' CMSIS Run task does, so an agent does not promise more than the task keeps (#73).
 * The pyOCD and J-Link tasks are GDB servers; the FVP task is the bare model with the last-built image,
 * which hosts no GDB server (the plugin lives in the launch configuration), so attach has nothing to reach.
 */
const RUN_TASK_EFFECT = 'The flash is untouched; the pyOCD task resets the target and lets the firmware run (--reset-run), '
    + 'the J-Link task leaves it running as it was (-nohalt). The FVP task starts the model with the last-built image and '
    + 'hosts no GDB server: there, use load_and_debug for a session.';

/** How the reply reads the job's situation: target tag, clock, and what the call did. */
export interface ResultContext {
    /** ` on HE`, ` on HP@debug, switched from HE`, or empty. */
    tag: string;
    now: number;
    /** Put before the result, e.g. when the call attached to a job it did not start. */
    preface?: string;
    /** The command the call issued, for the not-started text. */
    command?: string;
    /** The labels of the solution's tasks, when known: a missing task is not a stuck panel. */
    labels?: ReadonlySet<string>;
    /** What a failed Load or Erase task ran, for its hint; asked only on a failure. */
    program?: (execution: JobExecution) => ProgramFacts | undefined;
}

function ranFor(execution: JobExecution, now: number): string {
    return formatDuration(runtimeOf(execution, now));
}

/** Executions and remarks that are not the result but worth knowing. */
function meanwhile(job: Job): string {
    const parts: string[] = [];
    const others = bystanders(job);
    if (others.some((execution) => execution.kind === 'setup')) {
        parts.push('a cbuild setup ran meanwhile');
    }
    const rest = others.filter((execution) => execution.kind !== 'setup').map((execution) => `'${execution.name}'`);
    if (rest.length > 0) {
        parts.push(`also started meanwhile: ${[...new Set(rest)].join(', ')}`);
    }
    const said = parts.length > 0 ? ` Note: ${parts.join('; ')} — not this call's result.` : '';
    return said + job.notes.map((note) => ` ${note}`).join('');
}

/** The task a job is waiting on now: its latest bound execution still going, else its main one. */
function currentTask(job: Job): JobExecution | undefined {
    const bound = job.executions.filter((execution) => execution.role !== undefined);
    const going = bound.filter((execution) => execution.processEndedAt === undefined && execution.endedAt === undefined);
    return going[going.length - 1] ?? executionIn(job, 'main') ?? bound[bound.length - 1];
}

/** The job as `data` of a reply: what a later status call needs to match it. */
export function jobData(job: Job, now: number): JsonObject {
    const task = currentTask(job);
    return {
        id: job.id,
        action: job.action,
        target: job.target ?? null,
        task: task?.name ?? null,
        state: job.state,
        origin: job.origin,
        startedAt: new Date(job.armedAt).toISOString(),
        elapsedMs: Math.max(0, now - job.armedAt),
    };
}

/** One Load or Erase task that has run `LONG_FLASH_MS` or more: what it is and how long it ran. */
interface StuckTask {
    name: string;
    ranMs: number;
}

/** The sentences for a stuck Load or Erase: why it is stuck, what that usually means, the way out. */
function stuckFlashText(stuck: StuckTask): string {
    return `'${stuck.name}' has run for ${formatDuration(stuck.ranMs)}, far longer than programming takes: it is stuck, almost always waiting for a `
        + `debug probe. Its terminal, which no tool reads, then shows "Waiting for a debug probe" or a probe error. ${PROBE_WAIT_MEANING} `
        + 'cmsis_action {action:\'stop_run\'} ends the task; load again only once the probe is free and visible.';
}

/** The job's Load or Erase task when it is still running and has run `LONG_FLASH_MS` or more. */
export function stuckFlashTask(job: Job, now: number): StuckTask | undefined {
    if (job.state !== 'armed' && job.state !== 'started') {
        return undefined;
    }
    const task = currentTask(job);
    if (!task || !FLASH_KINDS.has(task.kind) || task.processEndedAt !== undefined || task.endedAt !== undefined) {
        return undefined;
    }
    const ranMs = now - task.startedAt;
    return ranMs >= LONG_FLASH_MS ? { name: task.name, ranMs } : undefined;
}

/** A live Load or Erase task of the window that has run `LONG_FLASH_MS` or more; one already running at start-up never counts. */
function stuckLive(live: readonly LiveExecution[], now: number): StuckTask | undefined {
    const found = live.find((execution) => FLASH_KINDS.has(execution.kind) && !execution.seeded && now - execution.startedAt >= LONG_FLASH_MS);
    return found ? { name: found.name, ranMs: now - found.startedAt } : undefined;
}

/** A job that has not settled when the call's wait ends: status `running`, never an error (#12). */
export function stillRunning(job: Job, context: ResultContext): ToolReply {
    const elapsed = formatDuration(context.now - job.armedAt);
    const stuck = stuckFlashTask(job, context.now);
    if (stuck) {
        return {
            text: `${context.preface ?? ''}CMSIS '${job.action}'${context.tag} has not finished after ${elapsed} (job ${job.id}). ${stuckFlashText(stuck)}`,
            status: 'running',
            data: { job: { ...jobData(job, context.now), stuck: true } },
        };
    }
    const task = currentTask(job);
    const again = isBuildAction(job.action) ? `do not start another ${job.action}` : 'do not start it again';
    const head = task
        ? `CMSIS '${job.action}'${context.tag} is still running after ${elapsed} (task '${task.name}', job ${job.id}).`
        : `CMSIS '${job.action}'${context.tag} was issued ${elapsed} ago and its task has not started yet (job ${job.id}).`;
    // A build task can outlive its build: VS Code still lists it while no cbuild runs any more.
    const outlived = task && isBuildAction(job.action) && context.now - job.armedAt >= LONG_BUILD_MS
        ? ' If VS Code shows the build finished while this stays running, cmsis_action stop_build ends the task.'
        : '';
    return {
        text: `${context.preface ?? ''}${head} This is not a failure. Call cmsis_action {action:'status'} to wait for the result — ${again}.${outlived}`,
        status: 'running',
        data: { job: jobData(job, context.now) },
    };
}

/** The actions a debugger adapter offers, from the labels of its tasks. */
function offeredActions(labels: ReadonlySet<string>): string {
    const offered: string[] = [];
    for (const action of ['load', 'erase', 'run', 'load_and_run'] as const) {
        const label = ACTION_PHASES[action].label;
        if (label !== undefined && labels.has(label)) {
            offered.push(action);
        }
    }
    offered.push('load_and_debug');
    return offered.length > 1 ? `${offered.slice(0, -1).join(', ')} and ${offered[offered.length - 1]}` : offered[0];
}

/** Why a tasks.json has no CMSIS tasks, as the refusal says it: the cause, and the next step when it is not the choice of a debugger. */
export interface MissingTasksNote {
    reason: string;
    hint?: string;
}

/**
 * The label pre-check's refusal: the solution's tasks.json has no task for
 * this action. Without any CMSIS task, `missing` says why they could not be
 * written (`cmsis-csolution.updateDebugTasks` was tried once, or could not
 * be), and the next step is Manage Solution Settings.
 */
export function missingTaskRefusal(action: JobAction, tag: string, label: string, labels: ReadonlySet<string>, missing?: MissingTasksNote): ToolError {
    if (!hasCmsisTasks(labels)) {
        return new ToolError('INVALID_ARGUMENT',
            `CMSIS '${action}'${tag} not started: the solution's .vscode/tasks.json has no CMSIS tasks, so there is no '${label}' to run`
                + `${missing ? `; ${missing.reason}` : ''}.`,
            missing?.hint ?? CHOOSE_DEBUGGER_HINT);
    }
    return new ToolError('INVALID_ARGUMENT',
        `CMSIS '${action}'${tag} not started: this debugger adapter has no '${label}' task; it offers ${offeredActions(labels)}.`,
        'Use one of those, or flash. (Arm Debugger adapters offer only load_and_run and load_and_debug.)');
}

/**
 * The pre-check's refusal of `load_and_debug` and `attach`: CMSIS Solution has
 * no launch configuration to start, because it wrote no CMSIS tasks and
 * launch configurations (`missing` says why they could not be written) or
 * the setting that lets it write them is off.
 */
export function missingLaunchSetupRefusal(action: string, tag: string, missing?: MissingTasksNote): ToolError {
    return new ToolError('INVALID_ARGUMENT',
        `CMSIS '${action}'${tag} not started: CMSIS Solution has no launch configuration to start for this target`
            + `${missing ? `; ${missing.reason}` : ''}.`,
        missing?.hint ?? CHOOSE_DEBUGGER_HINT);
}

/** A build message as `data` carries it. */
function messageData(message: BuildMessage): JsonObject {
    const data: JsonObject = { severity: message.severity, message: message.message };
    if (message.file !== undefined) {
        data.file = message.file;
    }
    if (message.line !== undefined) {
        data.line = message.line;
    }
    if (message.column !== undefined) {
        data.column = message.column;
    }
    if (message.code !== undefined) {
        data.code = message.code;
    }
    if (message.context !== undefined) {
        data.context = message.context;
    }
    return data;
}

/** A failed build's diagnosis as `data` carries it: the first messages of each kind and the full counts. */
export function diagnosisData(diagnosis: JobDiagnosis): JsonObject {
    return {
        state: diagnosis.state,
        check: diagnosis.check ?? null,
        source: diagnosis.source,
        errorCount: diagnosis.errorCount,
        warningCount: diagnosis.warningCount,
        errors: diagnosis.errors.slice(0, DATA_MESSAGES).map(messageData),
        warnings: diagnosis.warnings.slice(0, DATA_MESSAGES).map(messageData),
        logFile: diagnosis.logFile ?? null,
        note: diagnosis.note ?? null,
    };
}

/** The lines a failed build's diagnosis adds to its result: its block, or that it is still coming. */
function diagnosisLines(diagnosis: JobDiagnosis): string {
    if (diagnosis.state === 'pending') {
        return `\nError lines: still being collected (a diagnostic re-run of cbuild with --log, at most ${DIAGNOSTIC_RERUN_CAP_MS / 1_000} s).`;
    }
    return `\n${diagnosis.text}`;
}

/** A failed build, rebuild or clean: its task line, and the lines of its diagnosis when there is one. */
function failedBuild(job: Job, context: ResultContext, decided: JobExecution): ToolError {
    const exited = decided.exitCode === 0
        ? `exited 0 after ${ranFor(decided, context.now)}, but the build failed (CMSIS Solution reports exit 0 for a failed build too)`
        : `exited with code ${decided.exitCode} after ${ranFor(decided, context.now)}`;
    const head = `${context.preface ?? ''}❌ CMSIS '${job.action}' FAILED${context.tag} — task '${decided.name}' ${exited} (job ${job.id}).${meanwhile(job)}`;
    const diagnosis = job.diagnosis;
    if (!diagnosis) {
        return new ToolError('TASK_FAILED', head, BUILD_FAILED_HINT);
    }
    const hint = diagnosis.state === 'pending' ? BUILD_LINES_PENDING_HINT
        : diagnosis.source === 'none' ? BUILD_FAILED_HINT
        : diagnosis.errors.some((error) => NEEDS_RTE_UPDATE.test(error.message)) ? RTE_UPDATE_HINT : BUILD_ERRORS_HINT;
    return new ToolError('TASK_FAILED', `${head}${diagnosisLines(diagnosis)}`, hint,
        { job: jobData(job, context.now), diagnosis: diagnosisData(diagnosis) });
}

function failed(job: Job, context: ResultContext, decided: JobExecution): ToolError {
    const { tag, now } = context;
    const preface = context.preface ?? '';
    const code = decided.exitCode;
    const id = job.id;
    if (job.action === 'load_and_run' && decided.role !== 'main') {
        if (decided.role === 'load') {
            return new ToolError('TASK_FAILED',
                `${preface}❌ CMSIS 'load_and_run' FAILED${tag} — '${decided.name}' exited with code ${code} after ${ranFor(decided, now)}, `
                    + `so 'CMSIS Run' was not started (job ${id}).${meanwhile(job)}`,
                flashFailedHint(decided.name, context.program?.(decided)));
        }
        const load = executionIn(job, 'load');
        const flashed = load ? `flashed ('${load.name}' exited 0 after ${ranFor(load, now)}), but ` : '';
        return new ToolError('TASK_FAILED',
            `${preface}❌ CMSIS 'load_and_run' FAILED${tag} — ${flashed}'${decided.name}' ended with code ${code} after ${ranFor(decided, now)}; `
                + `it hosts the GDB server and must stay up (job ${id}).${meanwhile(job)}`,
            RUN_FAILED_HINT);
    }
    if (job.action === 'run') {
        return new ToolError('TASK_FAILED',
            `${preface}❌ CMSIS 'run' FAILED${tag} — '${decided.name}' ended ${code === undefined ? 'without an exit code' : `with code ${code}`} `
                + `after ${ranFor(decided, now)}; it hosts the GDB server and must stay up (job ${id}).${meanwhile(job)}`,
            RUN_FAILED_HINT);
    }
    if (job.action === 'load_and_run' && code === undefined) {
        return new ToolError('TASK_FAILED',
            `${preface}❌ CMSIS 'load_and_run' FAILED${tag} — '${decided.name}' ended without a live 'CMSIS Run' (job ${id}).${meanwhile(job)}`,
            RUN_FAILED_HINT);
    }
    if (isBuildAction(job.action)) {
        return failedBuild(job, context, decided);
    }
    return new ToolError('TASK_FAILED',
        `${preface}❌ CMSIS '${job.action}' FAILED${tag} — task '${decided.name}' exited with code ${code} after ${ranFor(decided, now)} `
            + `(job ${id}).${meanwhile(job)}`,
        flashFailedHint(decided.name, context.program?.(decided)));
}

/**
 * A build, rebuild or clean that exited 0 whose check is still going (status
 * `running`), or whose result it could not confirm (⚠️, status ok);
 * undefined when the check confirmed it.
 */
function buildCheckResult(job: Job, context: ResultContext, task: JobExecution): ToolReply | undefined {
    const diagnosis = job.diagnosis;
    const action = job.action;
    const noun = action === 'clean' ? 'clean' : 'build';
    const ran = `task '${task.name}' exited 0 after ${ranFor(task, context.now)}`;
    const data = (): JsonObject => ({ job: jobData(job, context.now), ...(diagnosis ? { diagnosis: diagnosisData(diagnosis) } : {}) });
    if (diagnosis?.state === 'pending') {
        const how = action === 'clean' ? ''
            : ` (a diagnostic re-run of cbuild with --log when the image was not rewritten, at most ${DIAGNOSTIC_RERUN_CAP_MS / 1_000} s)`;
        return {
            text: `${context.preface ?? ''}CMSIS '${action}'${context.tag}: ${ran} (job ${job.id}); its result is still being checked${how}, `
                + `since CMSIS Solution reports exit 0 for a failed ${noun} too. Call cmsis_action {action:'status'} for the result — `
                + `do not start another ${action}.${meanwhile(job)}`,
            status: 'running',
            data: data(),
        };
    }
    if (diagnosis?.check === 'unverified') {
        return {
            text: `${context.preface ?? ''}⚠️ CMSIS '${action}'${context.tag}: ${ran} (job ${job.id}), but that does not confirm the ${noun}. `
                + `${diagnosis.text} ${action === 'clean' ? CLEAN_UNVERIFIED_NEXT : BUILD_UNVERIFIED_NEXT}${meanwhile(job)}`,
            status: 'ok',
            data: data(),
        };
    }
    return undefined;
}

/** What to do about a job whose task never started: a build is never "up to date", a launch may have met a message. */
function notStartedHint(action: JobAction): string {
    if (action === 'load_and_debug') {
        return 'CMSIS Solution may be showing a picker, or a message such as "Unable to start debugging" when it has no launch '
            + 'configuration for the target: ask the user what VS Code shows, then repeat the call.';
    }
    const picker = 'The CMSIS panel may be showing a picker or a save prompt: answer it in VS Code, then repeat the call.';
    return isBuildAction(action) ? `${picker} This does not mean "already up to date" — cbuild runs even when nothing changed.` : picker;
}

/**
 * The result of a job: a ✅ text when it settled well, a `running` reply
 * while it goes on, and a thrown `ToolError` when it failed, was cancelled
 * or never started. A load_and_debug job is only its pre-launch Load; the
 * handler adds the session.
 */
export function jobResult(job: Job, context: ResultContext): ToolText {
    const { tag, now } = context;
    const preface = context.preface ?? '';
    const decided = job.executions.find((execution) => execution.key === job.decidedBy);
    switch (job.state) {
        case 'armed':
        case 'started':
            return stillRunning(job, context);
        case 'ok': {
            const task = decided ?? currentTask(job);
            if (isBuildAction(job.action) && task && job.diagnosis) {
                const checkedBuild = buildCheckResult(job, context, task);
                if (checkedBuild) {
                    return checkedBuild;
                }
            }
            const ran = task ? `task '${task.name}' exited 0 after ${ranFor(task, now)}, ` : '';
            const check = job.diagnosis?.check;
            const upToDate = (check === 'up-to-date' || check === 'cleaned') && job.diagnosis?.text ? ` ${job.diagnosis.text}` : '';
            return `${preface}✅ CMSIS '${job.action}' succeeded${tag} (${ran}job ${job.id}).${upToDate}${AFTER_SUCCESS[job.action]}${meanwhile(job)}`;
        }
        case 'running-ok': {
            const load = executionIn(job, 'load');
            const run = executionIn(job, 'run');
            if (job.action === 'run') {
                return `${preface}✅ CMSIS 'run'${tag}: '${run?.name ?? 'CMSIS Run'}' started and stays active — with a probe adapter it hosts `
                    + `the GDB server (job ${job.id}); nothing was built or programmed. ${RUN_TASK_EFFECT} cmsis_action attach to debug; `
                    + `cmsis_action stop_run frees the probe.${meanwhile(job)}`;
            }
            const flashed = load ? `flashed ('${load.name}' exited 0 after ${ranFor(load, now)}); ` : '';
            return `${preface}✅ CMSIS 'load_and_run'${tag}: ${flashed}'${run?.name ?? 'CMSIS Run'}' started and stays active — `
                + `with a probe adapter it hosts the GDB server (job ${job.id}); an FVP runs the image without one. `
                + `cmsis_action attach to debug; cmsis_action stop_run frees the probe.${meanwhile(job)}`;
        }
        case 'failed':
            if (decided) {
                throw failed(job, context, decided);
            }
            throw new ToolError('TASK_FAILED', `${preface}❌ CMSIS '${job.action}' FAILED${tag} (job ${job.id}).${meanwhile(job)}`,
                `Re-run cmsis_action ${job.action} to get a definite result.`);
        case 'cancelled': {
            if (decided && wasStopped(decided)) {
                throw new ToolError('TASK_FAILED',
                    `${preface}CMSIS '${job.action}'${tag} — task '${decided.name}' was stopped after ${ranFor(decided, now)} (job ${job.id}), `
                        + `so its outputs are incomplete: cmsis_action build before load or flash.${meanwhile(job)}`,
                    `cmsis_action ${job.action} starts it again.`);
            }
            const task = decided ? `task '${decided.name}' ended without an exit code after ${ranFor(decided, now)}` : 'its task ended without an exit code';
            throw new ToolError('TASK_FAILED',
                `${preface}CMSIS '${job.action}'${tag} — ${task} (it may have been cancelled; job ${job.id}).${meanwhile(job)}`,
                `Re-run cmsis_action ${job.action} to get a definite result.`);
        }
        case 'not-started': {
            const label = ACTION_PHASES[job.action].label;
            if (label !== undefined && context.labels !== undefined && !context.labels.has(label)) {
                throw missingTaskRefusal(job.action, tag, label, context.labels);
            }
            const issued = context.command ? `'${context.command}'` : 'its command';
            throw new ToolError('TASK_FAILED',
                `${preface}CMSIS '${job.action}'${tag}: nothing started within ${formatDuration(NOTHING_STARTED_MS)} of issuing ${issued} `
                    + `(job ${job.id}).${meanwhile(job)}`,
                notStartedHint(job.action));
        }
    }
}

/** `✅ 2 min ago`, `❌ exit 2 5 s ago` … for the listings. */
function verdictMark(job: Job): string {
    switch (job.state) {
        case 'ok':
            if (job.diagnosis?.state === 'pending') {
                return 'exit 0, being checked';
            }
            return job.diagnosis?.check === 'unverified' ? '⚠️ exit 0, not confirmed' : '✅';
        case 'running-ok':
            return '✅';
        case 'failed': {
            const decided = job.executions.find((execution) => execution.key === job.decidedBy);
            if (decided?.exitCode === 0 && job.diagnosis?.check === 'failed') {
                return '❌ build errors (exit 0)';
            }
            return decided?.exitCode !== undefined ? `❌ exit ${decided.exitCode}` : '❌';
        }
        case 'cancelled': {
            const decided = job.executions.find((execution) => execution.key === job.decidedBy);
            return decided && wasStopped(decided) ? 'stopped' : '❌ cancelled';
        }
        case 'not-started':
            return '❌ nothing started';
        default:
            return 'running';
    }
}

function liveEntry(execution: LiveExecution, now: number, holds: (kind: string) => boolean): string {
    const age = execution.seeded ? '' : ` for ${formatDuration(now - execution.startedAt)}`;
    return `'${execution.name}'${age}${holds(execution.kind) ? ' (holds the probe)' : ''}`;
}

const PROBE_HOLDERS: ReadonlySet<string> = new Set(['run', 'loadRun', 'load', 'erase', 'targetInfo']);

/**
 * The `status` answer when no job is open: recent results with the error
 * lines of a failed build, and the live CMSIS tasks of the window.
 */
export function idleStatus(recent: readonly Job[], live: readonly LiveExecution[], now: number): string {
    const lines: string[] = [];
    if (recent.length === 0) {
        lines.push('No CMSIS job in this window: nothing is in flight and none has finished since the window started.');
    } else {
        const results = recent.map((job) => {
            const where = job.target ? ` on ${job.target}` : '';
            const task = job.executions.find((execution) => execution.key === job.decidedBy) ?? currentTask(job);
            const named = task ? `, '${task.name}'` : '';
            return `${job.action}${where} ${verdictMark(job)} ${formatDuration(now - (job.settledAt ?? now))} ago (job ${job.id}${named})`;
        });
        lines.push(`No CMSIS job in flight in this window. Last results: ${results.join('; ')}.`);
        for (const job of recent) {
            const diagnosis = job.diagnosis;
            const named = `${job.action} job ${job.id}`;
            const capitalized = `${named.charAt(0).toUpperCase()}${named.slice(1)}`;
            if (diagnosis?.state === 'pending') {
                lines.push(job.state === 'ok'
                    ? `The result of ${named} (exit 0) is still being checked — cmsis_action {action:'status'} again shows it.`
                    : `The error lines of ${named} are still being collected — cmsis_action {action:'status'} again shows them.`);
            } else if (diagnosis?.state === 'done' && job.state === 'failed') {
                lines.push(`${capitalized} failed: ${diagnosis.text}`);
            } else if (diagnosis?.check === 'unverified') {
                const next = job.action === 'clean' ? CLEAN_UNVERIFIED_NEXT : BUILD_UNVERIFIED_NEXT;
                lines.push(`${capitalized} exited 0, but that does not confirm it: ${diagnosis.text} ${next}`);
            }
        }
    }
    if (live.length === 0) {
        lines.push('No CMSIS task is running in this window.');
    } else {
        const entries = live.map((execution) => liveEntry(execution, now, (kind) => PROBE_HOLDERS.has(kind)));
        const stuck = stuckLive(live, now);
        const probe = !stuck && live.some((execution) => PROBE_HOLDERS.has(execution.kind)) ? ' cmsis_action {action:\'stop_run\'} ends them.' : '';
        lines.push(`CMSIS tasks running: ${entries.join('; ')}.${probe}`);
        if (stuck) {
            lines.push(stuckFlashText(stuck));
        }
    }
    return lines.join('\n');
}

/** The one line `get_session_status` adds; undefined when there is nothing to say. */
export function sessionTaskLine(recent: readonly Job[], live: readonly LiveExecution[], now: number): string | undefined {
    const parts = live.map((execution) => {
        const age = execution.seeded ? ' alive' : ` alive ${formatDuration(now - execution.startedAt)}`;
        return `'${execution.name}'${age}${PROBE_HOLDERS.has(execution.kind) ? ' (holds the probe)' : ''}`;
    });
    for (const job of recent) {
        parts.push(`last ${job.action} ${verdictMark(job)} ${formatDuration(now - (job.settledAt ?? now))} ago`);
    }
    if (parts.length === 0) {
        return undefined;
    }
    // A stuck Load comes before any advice to start a session: a new one would wait for the same probe.
    const stuck = stuckLive(live, now);
    return `CMSIS tasks: ${parts.join('; ')}${stuck ? `\n${stuckFlashText(stuck)}` : ''}`;
}

function ownerPhrase(owner: ProbeOwner, now: number): string {
    const age = owner.startedAt !== undefined ? ` (started ${formatDuration(now - owner.startedAt)} ago)` : '';
    return owner.kind === 'flash' ? `a flash call${age} is programming the target` : `the '${owner.name}' task${age}`;
}

/** The session a refusal names: its name and state, when there is one. */
export interface SessionFacts {
    name: string | null | undefined;
    state: string;
}

/**
 * The `PROBE_BUSY` refusal of the guard (#46): what holds the probe and the
 * step that frees it. `flash` words it as its own refusal.
 */
export function probeRefusal(
    action: string,
    tag: string,
    verdict: Exclude<GuardVerdict, { allowed: true }>,
    now: number,
    session?: SessionFacts,
): ToolError {
    const subject = action === 'flash' ? 'Refusing to flash' : `CMSIS '${action}'${tag} not started`;
    const owner = verdict.owner;
    if (verdict.reason === 'server' && owner) {
        return new ToolError('PROBE_BUSY', `${subject}: ${ownerPhrase(owner, now)} holds the probe.`,
            action === 'flash'
                ? 'cmsis_action {action:\'stop_run\'} first, then flash.'
                : 'cmsis_action {action:\'stop_run\'} first — or cmsis_action attach to debug the running firmware.');
    }
    if (verdict.reason === 'busy' && owner) {
        if (owner.kind === 'flash') {
            return new ToolError('PROBE_BUSY', `${subject}: ${ownerPhrase(owner, now)}.`, 'Wait for it: flash answers when programming ends.');
        }
        return new ToolError('PROBE_BUSY', `${subject}: ${ownerPhrase(owner, now)} is using the probe.`,
            'cmsis_action {action:\'status\'} waits for it.');
    }
    const named = session ? ` (name='${session.name ?? '?'}', state=${session.state})` : '';
    return new ToolError('PROBE_BUSY', `${subject}: a debug session is active${named} and holds the probe.`, 'Call stop_debugging first.');
}
