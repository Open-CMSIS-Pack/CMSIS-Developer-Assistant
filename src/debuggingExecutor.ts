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
 * The executor: the one layer of the extension that calls VS Code's debug API
 * and, through `customRequest`, the debug adapter of the session this window
 * acts on (`resolveActiveSession`: VS Code's focused session, else the most
 * recently started one). `DebuggingHandler` calls it for every debug tool and
 * turns what it returns into tool results.
 *
 * Every method keeps to the same rules:
 * - DAP traffic goes only through `customRequestWithTimeout` and `withTimeout`
 *   (src/utils/timeout.ts). A `HardwareTimeoutError` keeps its class unless the
 *   method wraps its errors in a message of its own; that wrap (`wrapError`)
 *   keeps the error code the cause carries or implies (#11).
 * - Deadlines come from `Budgets` (src/executor/common.ts): one per DAP request
 *   and, for reads that take several requests, a fence around the whole read.
 * - Thread and frame ids are those of VS Code's focused stack item (KB7). A
 *   frame lookup is a state snapshot, `stackTrace` request included (KB8).
 * - On the CMSIS Debugger (`gdbtarget`) nothing goes through VS Code's
 *   workbench commands: a request GDB refuses comes back to the caller
 *   instead of repeating itself as a toast (#13), and raw GDB commands use
 *   the adapter's `>` prefix (#56).
 * - A memory read that fails keeps the cause of each strategy it tried. On
 *   the CMSIS Debugger each public read then reads DHCSR once and fails as
 *   `PROBE_WEDGED` when the debug port does not answer, or as
 *   `INVALID_ARGUMENT` when only the address cannot be read (#3,
 *   src/executor/gdbMemory.ts). Nothing is retried or reconnected.
 *   `checkTargetConnection` reads DHCSR on a stopped CMSIS Debugger session
 *   too; the session tracker keeps the last read that got no answer.
 *
 * The contract types live in src/executor/contract.ts and are re-exported
 * here. The snapshot, the GDB command and word read, the reset and the
 * session reports have modules of their own under src/executor/.
 * `SERVER_VERSION` is read from package.json when the code is compiled or
 * bundled, so `npm version` (locally or in CI, from the release tag) is the
 * only place a version is set.
 */

import * as vscode from 'vscode';
import { architectureHasCycleCounter, DEMCR_TRCENA, DWT_ADDRESSES, DWT_CTRL_CYCCNTENA, DWT_CTRL_NOCYCCNT } from './core/dwt';
import { decodeFaultRegisters, FAULT_REGISTER_ADDRESSES, FaultRegisters } from './core/faultDecoder';
import { CMSIS_DEBUGGER_TYPE, gdbRequestRefusal, miQuoted, passthroughCommand } from './core/gdbDialect';
import { systemControlSpaceWords } from './core/memoryMap';
import { readPeripheralViaMemory } from './core/peripheralReader';
import { ResetMethod } from './core/resetAssist';
import { type DapVariable, isDapVariable } from './core/variableView';
import { DebugState, StackFrame } from './debugState';
import { logger } from './utils/logger';
import {
    AdoptedBreakpoint, adoptedBreakpointsOf, armFocusWatch, armStartFocusWatch, awaitBreakpointsApplied, expectAgentStart, forgetGdbLogpoints,
    FrameFocusWatch, GdbLogpoint, gdbLogpointsOf, getLiveSessionCount, getLiveSessionNames, getStoppedReason, isSessionStopped, rememberGdbLogpoint,
    resolveActiveSession, StartFocusWatch, StopWaitResult, waitForSessionEnd, waitForStopEvent,
} from './utils/sessionStateTracker';
import { customRequestWithTimeout, HardwareTimeoutError, withTimeout } from './utils/timeout';
import { ToolError, wrapError } from './core/toolResult';
import {
    Budgets, DEFAULT_HARDWARE_TIMEOUTS, EvaluateBody, FrameArg, frameArgOf, focusedThreadId, hex8, messageOf, NO_SESSION_TEXT, ReadMemoryBody, ScopeBody,
    ScopesBody, sessionOrThrow, StackTraceBody, ThreadsBody, toStackFrame, VariablesBody,
} from './executor/common';
import {
    AlreadyStopped, BreakpointBinding, BreakpointRemoval, DapThread, ExecutorDiagnostics, HardwareTimeouts, IDebuggingExecutor, MemoryRead,
    ResetOutcome, RestartOutcome, SessionStatus,
} from './executor/contract';
import { GdbReply, runGdbCommand } from './executor/gdbCommand';
import {
    bytesInRange, explainReadFailure, nthWordAddress, probeDebugPort, readWordThroughGdb, withEarlierAttempts, withHexPrefix,
} from './executor/gdbMemory';
import type { DebugPortProbe, ReadAttempt } from './core/probeWedge';
import { connectionReport, deviceReport, launchFolderFor, noLaunchFolderText, probeSession, takesRequests } from './executor/sessionReports';
import { captureDebugState } from './executor/snapshot';
import { performReset, programCounterFrom } from './executor/targetReset';
import { version as PACKAGE_VERSION } from '../package.json';

export { DEFAULT_HARDWARE_TIMEOUTS } from './executor/common';
export type {
    AdoptedBreakpoint, BreakpointBinding, BreakpointRemoval, DapThread, DebugPortProbe, ExecutorDiagnostics, FrameFocusWatch, GdbLogpoint, GdbReply,
    HardwareTimeouts, IDebuggingExecutor, MemoryRead, ResetOutcome, RestartOutcome, SessionState, SessionStatus, StartFocus, StartFocusWatch,
} from './executor/contract';

/** The version the MCP server, the server definition and the HTTP user agent report: package.json's `version` at build time. */
export const SERVER_VERSION: string = PACKAGE_VERSION;

type Motion = 'stepOver' | 'stepInto' | 'stepOut' | 'continue' | 'pause';

/**
 * Each run-control operation: the DAP request it sends, and the workbench
 * command it runs instead when that request fails for any reason but a
 * timeout, on adapters other than the CMSIS Debugger. The command acts on
 * VS Code's focused session and its outcome is not checked (KB1).
 */
const MOTIONS: Readonly<Record<Motion, { request: string; workbenchCommand: string }>> = {
    stepOver: { request: 'next', workbenchCommand: 'workbench.action.debug.stepOver' },
    stepInto: { request: 'stepIn', workbenchCommand: 'workbench.action.debug.stepInto' },
    stepOut: { request: 'stepOut', workbenchCommand: 'workbench.action.debug.stepOut' },
    continue: { request: 'continue', workbenchCommand: 'workbench.action.debug.continue' },
    pause: { request: 'pause', workbenchCommand: 'workbench.action.debug.pause' },
};

/** Restart on adapters other than the CMSIS Debugger: the workbench, on the focused session (KB2). */
const WORKBENCH_RESTART = 'workbench.action.debug.restart';

/** How long a restart waits for the stopped session to end before it starts the configuration again. */
const SESSION_END_WAIT_MS = 10_000;

/** How often `breakpointBinding` asks VS Code again while the adapter has not answered. */
const BINDING_POLL_MS = 50;

/** How long a model change waits for the adapter to answer VS Code's `setBreakpoints`. */
const BREAKPOINT_SYNC_MS = 2_000;

/** Registers `read_core_registers` returns when no names are given, in this order. */
const CORE_REGISTER_NAMES: readonly string[] =
    'r0 r1 r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 sp lr pc xpsr msp psp control faultmask basepri primask'.split(' ');

/** `getThreads` fetches top frames for this many threads, this many requests at a time. */
const TOP_FRAME_THREADS = 32;
const TOP_FRAME_BATCH = 4;

/** Default depth of `getCallStack`. */
const CALL_STACK_LEVELS = 50;

/** Size of the stacked exception frame (R0-R3, R12, LR, PC, xPSR). */
const EXCEPTION_FRAME_BYTES = 32;

/** The fault status registers in the order the read visits them, one word each. */
const FAULT_REGISTER_ORDER: ReadonlyArray<keyof FaultRegisters> = ['CFSR', 'HFSR', 'DFSR', 'MMFAR', 'BFAR', 'AFSR'];

/** The session a child session (a core of a multi-core launch) was started from, or the session itself. */
function rootSessionOf(session: vscode.DebugSession): vscode.DebugSession {
    let root = session;
    while (root.parentSession) {
        root = root.parentSession;
    }
    return root;
}

/** The distinct source files of these breakpoints, as file-system paths. */
function sourceFilesOf(breakpoints: readonly vscode.Breakpoint[]): string[] {
    const files = breakpoints.flatMap((entry) => entry instanceof vscode.SourceBreakpoint ? [entry.location.uri.fsPath] : []);
    return [...new Set(files)];
}

/**
 * The scopes a variables read covers, and the names of those it leaves out.
 * `local` and `global` keep each scope whose name contains the word, expensive
 * or not. `all` keeps every scope, except on the CMSIS Debugger: there it
 * leaves out an expensive register scope, which VS Code, too, reads only once
 * the user opens it — cdt-gdb-adapter's Registers scope, every core and FPU
 * register read over the probe — unless nothing else would be left. An
 * expensive scope of program variables (statics, globals) is read: `all`
 * asks for them (K03). Other adapters keep theirs: js-debug marks Global and
 * Module expensive, and Module holds an ES module's top-level variables.
 */
function scopesToRead(offered: ScopeBody[], scope: 'local' | 'global' | 'all' | undefined, sessionType: string): { kept: ScopeBody[]; skipped: string[] } {
    if (scope === 'local' || scope === 'global') {
        return { kept: offered.filter((candidate) => candidate.name.toLowerCase().includes(scope)), skipped: [] };
    }
    const registers = offered.filter((candidate) => candidate.expensive === true && isRegisterScope(candidate));
    if (sessionType !== CMSIS_DEBUGGER_TYPE || registers.length === 0 || registers.length === offered.length) {
        return { kept: offered, skipped: [] };
    }
    return { kept: offered.filter((candidate) => !registers.includes(candidate)), skipped: registers.map((candidate) => candidate.name) };
}

/** A scope of registers: DAP's `presentationHint` says so, or its name does (cdt-gdb-adapter's "Registers"). */
function isRegisterScope(scope: ScopeBody): boolean {
    return scope.presentationHint === 'registers' || /\bregisters?\b/i.test(scope.name);
}

const sleep = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

export class DebuggingExecutor implements IDebuggingExecutor {
    private readonly budgets: Budgets;

    /** Keys given in `timeouts` replace the defaults one by one. Touches no VS Code API. */
    constructor(timeouts?: Partial<HardwareTimeouts>) {
        this.budgets = new Budgets({ ...DEFAULT_HARDWARE_TIMEOUTS, ...timeouts });
    }

    // ── Session lifecycle ──────────────────────────────────────────────

    async startDebugging(folderPath: string, launch: vscode.DebugConfiguration): Promise<boolean> {
        try {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderPath));
            // A failed start then gives the agent its error instead of opening VS Code's modal dialog.
            expectAgentStart();
            return await vscode.debug.startDebugging(folder, launch);
        } catch (err) {
            throw wrapError('Starting the debug session failed', err);
        }
    }

    async startDebuggingByName(folderPath: string, launchName: string): Promise<boolean> {
        try {
            const folder = launchFolderFor(folderPath);
            if (!folder) {
                throw new ToolError('INVALID_ARGUMENT', noLaunchFolderText(folderPath));
            }
            // The name, not a configuration: VS Code looks it up in the folder's launch.json.
            expectAgentStart();
            return await vscode.debug.startDebugging(folder, launchName);
        } catch (err) {
            throw wrapError(`Failed to start debugging with configuration '${launchName}'`, err);
        }
    }

    async stopDebugging(which?: vscode.DebugSession): Promise<void> {
        try {
            const ending = which ?? resolveActiveSession();
            if (ending) {
                await vscode.debug.stopDebugging(ending);
            }
        } catch (err) {
            throw wrapError('Stopping the debug session failed', err);
        }
    }

    async restart(): Promise<RestartOutcome> {
        try {
            expectAgentStart();
            const session = resolveActiveSession();
            if (session?.type !== CMSIS_DEBUGGER_TYPE) {
                await vscode.commands.executeCommand(WORKBENCH_RESTART);
                return { via: 'workbench' };
            }
            // The whole launch, not one core of it: its root was started from the configuration.
            const root = rootSessionOf(session);
            const folder = root.workspaceFolder;
            const configuration = root.configuration;
            await vscode.debug.stopDebugging(root);
            if (!(await waitForSessionEnd(root, SESSION_END_WAIT_MS))) {
                throw new Error(`The session '${root.name}' did not end within ${SESSION_END_WAIT_MS / 1000} s of the stop request.`);
            }
            if (!(await vscode.debug.startDebugging(folder, configuration))) {
                throw new Error(`VS Code did not start the launch configuration '${configuration.name}' again.`);
            }
            return {
                via: 'relaunched',
                configurationName: configuration.name,
                preLaunchTask: typeof configuration.preLaunchTask === 'string' ? configuration.preLaunchTask : undefined,
            };
        } catch (err) {
            throw wrapError('Restarting the debug session failed', err);
        }
    }

    hasDebugSession(): boolean {
        return resolveActiveSession() !== undefined;
    }

    getActiveSession(): vscode.DebugSession | undefined {
        return resolveActiveSession();
    }

    // ── Readiness, status, diagnostics ─────────────────────────────────

    async hasActiveSession(): Promise<boolean> {
        const session = resolveActiveSession();
        if (!session) {
            return false;
        }
        let reply: unknown;
        try {
            // Whether it answers, and on the CMSIS Debugger whether it takes requests; the threads are not looked at.
            reply = await customRequestWithTimeout(session, 'threads', {}, this.budgets.probe());
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                logger.info('hasActiveSession: threads probe timed out — probe or target may be unresponsive');
            } else {
                logger.debug('hasActiveSession: threads probe failed', err);
            }
            return false;
        }
        if (!takesRequests(session, reply)) {
            logger.debug('hasActiveSession: the adapter answered the threads probe without a thread list; it takes no requests yet or any more');
            return false;
        }
        return isSessionStopped(session);
    }

    getSessionStatus(): Promise<SessionStatus> {
        return probeSession(this.budgets.probe());
    }

    /** The probe's report; on a stopped CMSIS Debugger session with one DHCSR read, as the target is not asked otherwise (#3). */
    async checkTargetConnection(): Promise<string> {
        const status = await this.getSessionStatus();
        const session = resolveActiveSession();
        if (status.state !== 'stopped' || session?.type !== CMSIS_DEBUGGER_TYPE) {
            return connectionReport(status);
        }
        const request: unknown = session.configuration?.request;
        return connectionReport(status, await probeDebugPort(session, this.budgets.request()), typeof request === 'string' ? request : undefined);
    }

    getDiagnostics(): ExecutorDiagnostics {
        return {
            serverVersion: SERVER_VERSION,
            liveSessionCount: getLiveSessionCount(),
            liveSessionNames: getLiveSessionNames(),
            // The only place that reads VS Code's focused session directly.
            hasVscodeActiveSession: vscode.debug.activeDebugSession !== undefined,
        };
    }

    async getDeviceInfo(): Promise<string> {
        return deviceReport(sessionOrThrow());
    }

    // ── Run control ────────────────────────────────────────────────────

    stepOver(overrideMs?: number): Promise<void> {
        return this.move('stepOver', overrideMs);
    }

    stepInto(overrideMs?: number): Promise<void> {
        return this.move('stepInto', overrideMs);
    }

    stepOut(overrideMs?: number): Promise<void> {
        return this.move('stepOut', overrideMs);
    }

    continue(overrideMs?: number): Promise<void> {
        return this.move('continue', overrideMs);
    }

    pause(overrideMs?: number): Promise<void> {
        return this.move('pause', overrideMs);
    }

    armStopWaiter(limitMs: number): Promise<StopWaitResult> {
        const session = sessionOrThrow();
        return waitForStopEvent(session, this.budgets.stopWait(limitMs));
    }

    async waitForStop(limitMs?: number): Promise<StopWaitResult | AlreadyStopped> {
        const session = sessionOrThrow();
        if (isSessionStopped(session)) {
            return { kind: 'already-stopped', reason: getStoppedReason(session) };
        }
        return waitForStopEvent(session, this.budgets.stopWait(limitMs));
    }

    watchFrameFocus(): FrameFocusWatch {
        const session = resolveActiveSession();
        return session ? armFocusWatch(session) : { selected: async () => false };
    }

    watchStartFocus(): StartFocusWatch {
        return armStartFocusWatch();
    }

    /** Sends the operation's request without waiting for the stop; the handler arms the waiter first. */
    private async move(motion: Motion, overrideMs: number | undefined): Promise<void> {
        const session = sessionOrThrow();
        const { request, workbenchCommand } = MOTIONS[motion];
        try {
            await customRequestWithTimeout(session, request, { threadId: focusedThreadId() }, this.budgets.request(overrideMs));
        } catch (err) {
            await this.rejectOrFallBack(session, request, workbenchCommand, err);
        }
    }

    /**
     * A run-control request the adapter did not carry out. A timeout is
     * passed on. On the CMSIS Debugger GDB's refusal is thrown as it is: the
     * workbench command would repeat the refused request from VS Code's UI,
     * where GDB's text becomes a toast and nothing comes back (#13). Other
     * adapters keep the workbench command.
     */
    private async rejectOrFallBack(session: vscode.DebugSession, request: string, workbenchCommand: string, err: unknown): Promise<void> {
        if (err instanceof HardwareTimeoutError) {
            throw err;
        }
        if (session.type === CMSIS_DEBUGGER_TYPE) {
            throw gdbRequestRefusal(request, messageOf(err));
        }
        await vscode.commands.executeCommand(workbenchCommand);
    }

    // ── Breakpoints: VS Code model ─────────────────────────────────────

    async addBreakpoint(file: vscode.Uri, line: number, extras?: { condition?: string; logMessage?: string }): Promise<vscode.SourceBreakpoint> {
        try {
            // A Position, not a Range: the transport stub's Location keeps its second argument as `range.start`.
            const anchor = new vscode.Location(file, new vscode.Position(line - 1, 0));
            const added = new vscode.SourceBreakpoint(anchor, true, extras?.condition, undefined, extras?.logMessage);
            vscode.debug.addBreakpoints([added]);
            return added;
        } catch (err) {
            throw wrapError('Adding the breakpoint failed', err);
        }
    }

    async removeBreakpoint(file: vscode.Uri, line: number, options?: { logpointsOnly?: boolean }): Promise<BreakpointRemoval> {
        try {
            const target = file.toString();
            const matching = vscode.debug.breakpoints.filter((entry) => entry instanceof vscode.SourceBreakpoint
                && entry.location.uri.toString() === target
                && entry.location.range.start.line === line - 1
                && (!options?.logpointsOnly || Boolean(entry.logMessage)));
            return await this.removeFromModel(matching);
        } catch (err) {
            throw wrapError('Removing the breakpoint failed', err);
        }
    }

    getBreakpoints(): ReadonlyArray<vscode.Breakpoint> {
        return vscode.debug.breakpoints;
    }

    adoptedBreakpoints(): AdoptedBreakpoint[] {
        return adoptedBreakpointsOf();
    }

    clearAllBreakpoints(): Promise<BreakpointRemoval> {
        return this.removeFromModel([...vscode.debug.breakpoints]);
    }

    /**
     * Removes `which` from VS Code's model. With a session, the wait for the
     * adapter's answers to the `setBreakpoints` requests VS Code sends is
     * armed before the change, so no answer can slip past it.
     */
    private async removeFromModel(which: readonly vscode.Breakpoint[]): Promise<BreakpointRemoval> {
        if (which.length === 0) {
            return { removed: 0 };
        }
        const session = resolveActiveSession();
        const applied = session ? awaitBreakpointsApplied(session, sourceFilesOf(which), BREAKPOINT_SYNC_MS) : undefined;
        vscode.debug.removeBreakpoints([...which]);
        return { removed: which.length, applied: applied ? await applied : undefined };
    }

    async breakpointBinding(breakpoint: vscode.Breakpoint, waitMs: number): Promise<BreakpointBinding | undefined> {
        const session = resolveActiveSession();
        if (!session) {
            return undefined;
        }
        if (typeof session.getDebugProtocolBreakpoint !== 'function') {
            return { reported: false, verified: false };
        }
        const deadline = Date.now() + Math.max(waitMs, 0);
        for (;;) {
            const remaining = deadline - Date.now();
            let reported: any;
            try {
                reported = await withTimeout('getDebugProtocolBreakpoint', Math.max(remaining, BINDING_POLL_MS),
                    Promise.resolve(session.getDebugProtocolBreakpoint(breakpoint)));
            } catch (err) {
                logger.debug('breakpointBinding: VS Code did not answer getDebugProtocolBreakpoint', err);
            }
            if (reported) {
                return {
                    reported: true,
                    verified: reported.verified === true,
                    message: typeof reported.message === 'string' && reported.message ? reported.message : undefined,
                    line: typeof reported.line === 'number' ? reported.line : undefined,
                    id: typeof reported.id === 'number' ? reported.id : undefined,
                };
            }
            if (Date.now() >= deadline) {
                return { reported: false, verified: false };
            }
            await sleep(Math.min(BINDING_POLL_MS, Math.max(deadline - Date.now(), 1)));
        }
    }

    // ── GDB's own breakpoints (logpoints on the CMSIS Debugger) ────────
    // Locations, formats and expressions go in as given; the handler escapes `format`.

    async insertDprintfViaGdb(location: string, format: string, values: readonly string[], overrideMs?: number): Promise<GdbReply> {
        const argumentList = values.map((value) => ` ${miQuoted(value)}`).join('');
        return this.gdb(`-dprintf-insert ${miQuoted(location)} "${format}"${argumentList}`, overrideMs);
    }

    async setBreakpointConditionViaGdb(breakpointNo: number, condition: string, overrideMs?: number): Promise<GdbReply> {
        return this.gdb(`condition ${breakpointNo} ${condition}`, overrideMs);
    }

    async deleteBreakpointsViaGdb(numbers: readonly number[], overrideMs?: number): Promise<GdbReply> {
        if (numbers.length === 0) {
            // A bare `delete` would take every breakpoint the adapter manages with it.
            return { text: '', errored: false };
        }
        return this.gdb(`delete ${numbers.join(' ')}`, overrideMs);
    }

    async listBreakpointsViaGdb(overrideMs?: number): Promise<GdbReply> {
        return this.gdb('-break-list', overrideMs);
    }

    gdbLogpoints(): GdbLogpoint[] {
        const session = resolveActiveSession();
        return session ? gdbLogpointsOf(session) : [];
    }

    rememberGdbLogpoint(logpoint: GdbLogpoint): void {
        const session = resolveActiveSession();
        if (session) {
            rememberGdbLogpoint(session, logpoint);
        }
    }

    forgetGdbLogpoints(numbers: readonly number[]): void {
        const session = resolveActiveSession();
        if (session) {
            forgetGdbLogpoints(session, numbers);
        }
    }

    /**
     * One GDB command in the prefix of the session's adapter, in the focused
     * frame (src/executor/gdbCommand.ts). An adapter error comes back as an
     * `errored` reply; only a timeout rejects.
     */
    private async gdb(command: string, overrideMs?: number): Promise<GdbReply> {
        const session = sessionOrThrow();
        const frame = await this.frameArg();
        return runGdbCommand(session, command, frame, this.budgets.request(overrideMs));
    }

    // ── State, stack, threads, variables, expressions ──────────────────

    getCurrentDebugState(lookahead = 3): Promise<DebugState> {
        return captureDebugState({ budgetMs: this.budgets.snapshot(), lookahead, withSource: true });
    }

    /** The focused frame's id, found by a snapshot without source text (KB8); null without a focused frame. */
    private async focusedFrameId(): Promise<number | null> {
        const snapshot = await captureDebugState({ budgetMs: this.budgets.snapshot(), lookahead: 0, withSource: false });
        return snapshot.frameId;
    }

    private async frameArg(): Promise<FrameArg> {
        return frameArgOf(await this.focusedFrameId());
    }

    async getCallStack(threadId?: number, levels: number = CALL_STACK_LEVELS, overrideMs?: number): Promise<StackFrame[]> {
        const session = sessionOrThrow();
        const reply = await customRequestWithTimeout<StackTraceBody | undefined>(session, 'stackTrace',
            { threadId: threadId ?? focusedThreadId(), startFrame: 0, levels }, this.budgets.request(overrideMs));
        return (reply?.stackFrames ?? []).map((frame) => toStackFrame(frame, true));
    }

    async getThreads(overrideMs?: number): Promise<DapThread[]> {
        const session = sessionOrThrow();
        const budgetMs = this.budgets.request(overrideMs);
        const reply = await customRequestWithTimeout<ThreadsBody | undefined>(session, 'threads', {}, budgetMs);
        const threads: DapThread[] = (reply?.threads ?? []).map((thread) => ({ id: thread.id, name: thread.name ?? `thread-${thread.id}` }));
        const framed = threads.slice(0, TOP_FRAME_THREADS);
        for (let first = 0; first < framed.length; first += TOP_FRAME_BATCH) {
            // One batch in flight at a time; a failed request just leaves its thread without a frame.
            await Promise.allSettled(framed.slice(first, first + TOP_FRAME_BATCH).map(async (thread) => {
                const trace = await customRequestWithTimeout<StackTraceBody | undefined>(session, 'stackTrace',
                    { threadId: thread.id, startFrame: 0, levels: 1 }, budgetMs);
                const innermost = trace?.stackFrames?.[0];
                if (innermost) {
                    thread.topFrame = toStackFrame(innermost, false);
                }
            }));
        }
        return threads;
    }

    async getVariables(frameId: number, scope?: 'local' | 'global' | 'all', overrideMs?: number): Promise<any> {
        try {
            const session = sessionOrThrow();
            const budgetMs = this.budgets.request(overrideMs);
            const reply = await customRequestWithTimeout<ScopesBody | undefined>(session, 'scopes', { frameId }, budgetMs);
            const offered = reply?.scopes;
            if (!offered || offered.length === 0) {
                return { scopes: [] };
            }
            const { kept, skipped } = scopesToRead(offered, scope, session.type);
            // One scope after the other; the adapter's scope objects are extended in place.
            for (const entry of kept) {
                try {
                    const content = await customRequestWithTimeout<VariablesBody | undefined>(session, 'variables',
                        { variablesReference: entry.variablesReference }, budgetMs);
                    entry.variables = content?.variables ?? [];
                } catch (err) {
                    entry.variables = [];
                    entry.error = messageOf(err);
                }
            }
            return skipped.length > 0 ? { scopes: kept, skipped } : { scopes: kept };
        } catch (err) {
            // Also flattens a `scopes` timeout (KB14): no longer a HardwareTimeoutError, though its code stays TIMEOUT.
            throw wrapError('Reading the variables failed', err);
        }
    }

    getVariablesForFrame(frameId: number, scope?: 'local' | 'global' | 'all', overrideMs?: number): Promise<any> {
        return this.getVariables(frameId, scope, overrideMs);
    }

    async getVariableChildren(variablesReference: number, overrideMs?: number): Promise<DapVariable[]> {
        try {
            const session = sessionOrThrow();
            const content = await customRequestWithTimeout<VariablesBody | undefined>(session, 'variables',
                { variablesReference }, this.budgets.request(overrideMs));
            return (content?.variables ?? []).filter(isDapVariable);
        } catch (err) {
            throw wrapError('Reading the fields failed', err);
        }
    }

    async evaluateExpression(expression: string, frameId: number, overrideMs?: number): Promise<any> {
        try {
            const session = sessionOrThrow();
            const command = passthroughCommand(expression);
            if (command !== undefined && session.type === CMSIS_DEBUGGER_TYPE) {
                // `-exec <cmd>` would be a C expression to cdt-gdb-adapter; `>` makes it a GDB command.
                const reply = await runGdbCommand(session, command, frameArgOf(frameId), this.budgets.request(overrideMs));
                if (reply.errored) {
                    throw new Error(reply.text);
                }
                return { result: reply.text, variablesReference: 0 };
            }
            // Verbatim, an agent's own `-exec …` on other adapters included.
            return await customRequestWithTimeout(session, 'evaluate', { expression, frameId, context: 'repl' }, this.budgets.request(overrideMs));
        } catch (err) {
            throw wrapError('Evaluating the expression failed', err);
        }
    }

    // ── Memory ─────────────────────────────────────────────────────────

    async readMemory(address: string, length: number, overrideMs?: number): Promise<MemoryRead> {
        const session = sessionOrThrow();
        const start = withHexPrefix(address);
        try {
            return await this.readMemoryOnce(session, start, length, overrideMs);
        } catch (err) {
            throw await explainReadFailure(session, start, err, this.budgets.request(overrideMs));
        }
    }

    /**
     * `readMemory` without the DHCSR read: the operation fence around DAP
     * `readMemory`, then the GDB ladder word by word. A range that touches
     * the System Control Space is read one aligned word at a time instead.
     * A failure carries the cause of every strategy.
     */
    private readMemoryOnce(session: vscode.DebugSession, start: string, length: number, overrideMs: number | undefined): Promise<MemoryRead> {
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readMemory', this.budgets.operation(overrideMs), async () => {
            // The Corstone FVP's GDB server answers SCS reads longer than one word with zeros.
            const scs = /^0x[0-9a-f]+$/i.test(start) ? systemControlSpaceWords(BigInt(start), length) : undefined;
            if (scs) {
                const words: Buffer[] = [];
                for (let index = 0; index < scs.words; index++) {
                    const bytes = Buffer.alloc(4);
                    bytes.writeUInt32LE(await this.readWordOnce(session, `0x${(scs.first + BigInt(index) * 4n).toString(16)}`, budgetMs) >>> 0, 0);
                    words.push(bytes);
                }
                return { bytes: Buffer.concat(words).subarray(scs.skip, scs.skip + length), offset: 0 };
            }
            const attempts: ReadAttempt[] = [];
            try {
                const reply = await customRequestWithTimeout<ReadMemoryBody | undefined>(session, 'readMemory',
                    { memoryReference: start, count: length }, budgetMs);
                // Where the reply says its bytes begin, even when that is later or they end sooner than asked (KB9).
                const read = bytesInRange(reply, BigInt(start), length);
                if (typeof read !== 'string') {
                    return read;
                }
                attempts.push({ strategy: 'DAP readMemory', cause: read });
            } catch (err) {
                if (err instanceof HardwareTimeoutError) {
                    throw err;
                }
                attempts.push({ strategy: 'DAP readMemory', cause: messageOf(err) });
            }
            try {
                return { bytes: await this.readWordsThroughGdb(session, start, length, budgetMs), offset: 0 };
            } catch (err) {
                throw withEarlierAttempts(err, attempts);
            }
        });
    }

    /** `readMemory`'s fallback: word by word through GDB; the first word that fails fails the read. */
    private async readWordsThroughGdb(session: vscode.DebugSession, start: string, length: number, budgetMs: number): Promise<Buffer> {
        const lookup = await this.frameArg();
        // Without a focused frame each word looks again.
        const shared = lookup.frameId === undefined ? undefined : lookup;
        const words: Buffer[] = [];
        for (let index = 0; index < Math.ceil(length / 4); index++) {
            const value = await this.wordThroughGdb(session, nthWordAddress(start, index), budgetMs, shared);
            const bytes = Buffer.alloc(4);
            bytes.writeUInt32LE(value >>> 0, 0);
            words.push(bytes);
        }
        return Buffer.concat(words).subarray(0, length);
    }

    private async wordThroughGdb(session: vscode.DebugSession, address: string, budgetMs: number, frame?: FrameArg): Promise<number> {
        return readWordThroughGdb(session, address, frame ?? await this.frameArg(), budgetMs);
    }

    async readMemoryWord(address: string, overrideMs?: number): Promise<number> {
        const session = sessionOrThrow();
        const at = withHexPrefix(address);
        const budgetMs = this.budgets.request(overrideMs);
        try {
            return await this.readWordOnce(session, at, budgetMs);
        } catch (err) {
            throw await explainReadFailure(session, at, err, budgetMs);
        }
    }

    /** `readMemoryWord` without the DHCSR read. No overall fence: each request has its own deadline. */
    private async readWordOnce(session: vscode.DebugSession, at: string, budgetMs: number): Promise<number> {
        const attempts: ReadAttempt[] = [];
        try {
            const reply = await customRequestWithTimeout<ReadMemoryBody | undefined>(session, 'readMemory',
                { memoryReference: at, count: 4 }, budgetMs);
            const bytes = reply?.data ? Buffer.from(reply.data, 'base64') : undefined;
            if (bytes && bytes.length >= 4) {
                return bytes.readUInt32LE(0);
            }
            attempts.push({ strategy: 'DAP readMemory', cause: bytes ? `short reply (${bytes.length} of 4 bytes)` : 'no data in the reply' });
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                throw err;
            }
            attempts.push({ strategy: 'DAP readMemory', cause: messageOf(err) });
        }
        try {
            return await this.wordThroughGdb(session, at, budgetMs);
        } catch (err) {
            throw withEarlierAttempts(err, attempts);
        }
    }

    async writeMemoryWord(address: string, value: number, overrideMs?: number): Promise<void> {
        const session = sessionOrThrow();
        const at = withHexPrefix(address);
        const budgetMs = this.budgets.request(overrideMs);
        const wanted = value >>> 0;
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32LE(wanted, 0);
        try {
            await customRequestWithTimeout(session, 'writeMemory', { memoryReference: at, data: bytes.toString('base64') }, budgetMs);
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                throw err;
            }
            // Whatever GDB answers is ignored (KB4): the read-back below decides.
            await this.gdb(`set {unsigned int}${at} = ${wanted}`, budgetMs);
        }
        const readBack = await this.readMemoryWord(at, budgetMs);
        if (readBack >>> 0 !== wanted) {
            throw new Error(`Write to ${at} did not stick (wrote ${hex8(wanted)}, read back ${hex8(readBack)})`);
        }
    }

    async readExceptionFrame(stackPointer: number, overrideMs?: number, stateOffset: number = 0): Promise<Buffer> {
        // The request budget becomes the nested read's override, so it also bounds that read's fence.
        const read = await this.readMemory(`0x${(stackPointer >>> 0).toString(16)}`, stateOffset + EXCEPTION_FRAME_BYTES,
            this.budgets.request(overrideMs));
        // Bytes that begin after the stack pointer are not the frame.
        return read.offset === 0 ? read.bytes : Buffer.alloc(0);
    }

    // ── Core registers, DWT, peripherals, fault status ─────────────────

    async readCoreRegisters(overrideMs?: number, names?: string[]): Promise<Record<string, string>> {
        const session = sessionOrThrow();
        const wanted = names && names.length > 0 ? names : CORE_REGISTER_NAMES;
        const frame = await this.frameArg();
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readCoreRegisters', this.budgets.operation(overrideMs), async () => {
            // All requests go out together, in list order.
            const values = await Promise.all(wanted.map((name) => this.registerText(session, name, frame, budgetMs)));
            const table: Record<string, string> = {};
            wanted.forEach((name, index) => {
                table[name] = values[index];
            });
            return table;
        });
    }

    /** GDB's text for `$<name>` as the adapter returns it, or a placeholder when the read failed. */
    private async registerText(session: vscode.DebugSession, name: string, frame: FrameArg, budgetMs: number): Promise<string> {
        try {
            const reply = await customRequestWithTimeout<EvaluateBody | undefined>(session, 'evaluate',
                { expression: `$${name}`, context: 'watch', ...frame }, budgetMs);
            if (!reply) {
                return '<unavailable>';
            }
            return reply.result as string;
        } catch (err) {
            return err instanceof HardwareTimeoutError ? '<timeout>' : '<unavailable>';
        }
    }

    async readCycleCounter(overrideMs?: number): Promise<{ cycles: number; enabledNow: boolean; present: boolean }> {
        sessionOrThrow();
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readCycleCounter', this.budgets.operation(overrideMs), async () => {
            // Armv6-M and Armv8-M Baseline never have one; nothing is written to them.
            if (!architectureHasCycleCounter(await this.readMemoryWord(DWT_ADDRESSES.CPUID, budgetMs))) {
                return { present: false, cycles: 0, enabledNow: false };
            }
            const demcr = await this.readMemoryWord(DWT_ADDRESSES.DEMCR, budgetMs);
            if ((demcr & DEMCR_TRCENA) === 0) {
                await this.writeMemoryWord(DWT_ADDRESSES.DEMCR, (demcr | DEMCR_TRCENA) >>> 0, budgetMs);
            }
            const control = await this.readMemoryWord(DWT_ADDRESSES.DWT_CTRL, budgetMs);
            if ((control & DWT_CTRL_NOCYCCNT) !== 0) {
                return { present: false, cycles: 0, enabledNow: false };
            }
            let enabledNow = false;
            if ((control & DWT_CTRL_CYCCNTENA) === 0) {
                await this.writeMemoryWord(DWT_ADDRESSES.DWT_CTRL, (control | DWT_CTRL_CYCCNTENA) >>> 0, budgetMs);
                enabledNow = true;
            }
            const cycles = (await this.readMemoryWord(DWT_ADDRESSES.DWT_CYCCNT, budgetMs)) >>> 0;
            return { present: true, cycles, enabledNow };
        });
    }

    async readPeripheralRegister(peripheral: string, register?: string, overrideMs?: number): Promise<string> {
        const session = sessionOrThrow();
        const frameId = await this.focusedFrameId();
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readPeripheralRegister', this.budgets.operation(overrideMs),
            () => readPeripheralViaMemory(session, peripheral, register, frameId, budgetMs));
    }

    /**
     * CFSR, HFSR, DFSR, MMFAR, BFAR and AFSR, one word each: they are word
     * registers, and the Corstone FVP's GDB server answers SCS reads longer
     * than one word with zeros. A failure is explained once, with the causes
     * of every strategy of the word that failed.
     */
    async readFaultRegisters(overrideMs?: number): Promise<FaultRegisters> {
        const session = sessionOrThrow();
        const budgetMs = this.budgets.request(overrideMs);
        try {
            return await withTimeout('readFaultRegisters', this.budgets.operation(overrideMs), async () => {
                const registers = {} as FaultRegisters;
                for (const name of FAULT_REGISTER_ORDER) {
                    registers[name] = await this.readWordOnce(session, FAULT_REGISTER_ADDRESSES[name], budgetMs);
                }
                return registers;
            });
        } catch (err) {
            throw await explainReadFailure(session, FAULT_REGISTER_ADDRESSES.CFSR, err, budgetMs);
        }
    }

    async probeDebugPort(overrideMs?: number): Promise<DebugPortProbe> {
        const session = resolveActiveSession();
        if (!session) {
            return { readable: false, timedOut: false, cause: NO_SESSION_TEXT };
        }
        return probeDebugPort(session, this.budgets.request(overrideMs));
    }

    async getFaultInfo(overrideMs?: number): Promise<string> {
        return decodeFaultRegisters(await this.readFaultRegisters(overrideMs));
    }

    // ── Reset ──────────────────────────────────────────────────────────

    async resetTarget(request: { method?: 'auto' | ResetMethod; halt?: boolean; timeoutMs?: number }): Promise<ResetOutcome> {
        const session = sessionOrThrow();
        return performReset(session, request, this.budgets.request(request.timeoutMs), {
            halt: (budgetMs) => this.pause(budgetMs),
            resume: (budgetMs) => this.continue(budgetMs),
            monitor: async (command, budgetMs) => (await this.gdb(command, budgetMs)).text,
            readWord: (address, budgetMs) => this.readMemoryWord(address, budgetMs),
            readPc: (budgetMs) => this.readProgramCounter(budgetMs),
        });
    }

    /** `$pc` in the focused frame, Thumb bit cleared; the budget is used as given. */
    private async readProgramCounter(budgetMs: number): Promise<number> {
        const session = sessionOrThrow();
        const frame = await this.frameArg();
        const reply = await customRequestWithTimeout<EvaluateBody | undefined>(session, 'evaluate',
            { expression: '$pc', context: 'watch', ...frame }, budgetMs);
        return programCounterFrom(reply?.result);
    }
}
