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
 * The debugging tools behind the MCP server: one `handle*` method per tool.
 * Each checks what state the session is in, asks the executor (and, for
 * `cmsis_action` and `flash`, the CMSIS Solution extension or pyOCD) and
 * answers with one text for the agent.
 *
 * `DebugMCPServer` calls a handler directly in the window that serves MCP;
 * a worker window's `ControlServer` calls it by op name with `args ?? {}`.
 * `src/core/opTable.ts` checks at compile time that the interface's method
 * names are exactly its `DEBUG_OPS`.
 *
 * How a call ends (#11, vocabulary in `src/core/toolResult.ts`):
 *   - with a text, or a `ToolReply` whose status is `timeout` (a wait ran out:
 *     `wait_for_stop`, a step or continue, pause, the fence cap of `reset`,
 *     `cmsis_action` and `flash`) or `running` (a CMSIS job goes on; the
 *     window's job tracker in `src/cmsisJobTracker.ts` follows it);
 *   - with a rejected `ToolError`: refusals such as "a session is already
 *     active" (`PROBE_BUSY`), the state gate (`NO_SESSION`, `TARGET_RUNNING`,
 *     …), failed tasks (`TASK_FAILED`), and the fence cap of the reads
 *     (`TIMEOUT`);
 *   - session, execution and breakpoint tools wrap a cause with `wrapError`
 *     as `<what failed>: <cause>`, keeping its code and hint; a `Refusal`
 *     (the state gate, "nothing to restart") needs no prefix and passes as
 *     it is.
 *
 * Steps, continue and pause wait only for the DAP `stopped` event the
 * executor arms before the request goes out; VS Code's stack-item events,
 * which also fire when the item is cleared on resume, never end a wait.
 *
 * Breakpoints live in VS Code's breakpoint model on every adapter, and the
 * answer reports how the adapter bound them. On the CMSIS Debugger a
 * logpoint is a GDB `dprintf` remembered under its number, and a breakpoint
 * change on a running target pauses it, applies the change and resumes it
 * (#13, #56). Behaviour that is known to be wrong is kept for now and listed
 * in the specification; each item is fixed in its own change.
 */

import * as vscode from 'vscode';
import type { DiscoveryRequest } from './core/deviceDiscovery';
import { runDeviceDiscovery } from './deviceDiscoveryHost';
import { DebugState, formatBreakpointModifiers, StackFrame } from './debugState';
import type { BreakpointBinding, GdbLogpoint, IDebuggingExecutor } from './debuggingExecutor';
import { PickerCancelled, type IDebugConfigurationManager } from './utils/debugConfigurationManager';
import { logger } from './utils/logger';
import { isSensitiveName, REDACTION_NOTICE, redactExpressionResult, redactVariableValue } from './utils/secretRedaction';
import { getStoppedReason, resolveActiveSession, StopWaitResult } from './utils/sessionStateTracker';
import { HardwareTimeoutError } from './utils/timeout';
import { currentCallContext } from './core/callContext';
import { decodeFault } from './core/faultDecoder';
import { classifyAddress, parseStackedFrame, renderDiagnosis, selectExceptionFrame, StackedFrame } from './core/faultTriage';
import { CMSIS_DEBUGGER_TYPE, passthroughCommand } from './core/gdbDialect';
import { isLockedUp, LOCKUP_NOTE } from './core/probeWedge';
import { renderResetOutcome } from './core/resetAssist';
import { lookupAddress, matchName, parseAddress, renderAddressHit, renderPeripheral, renderPeripheralList, renderRegister } from './core/svdLookup';
import { programmingNote, serialSessionLine } from './core/serialText';
import { findPeripheral, findRegister, listPeripheralNames, loadSvdForLookup, SvdDevice } from './core/svdParser';
import { shortenPath } from './core/textBudget';
import { Refusal, toToolError, ToolError, ToolText, wrapError } from './core/toolResult';
import {
    anyFieldRedacted,
    DapScope,
    DEFAULT_LISTING_LIMITS,
    DEFAULT_NAME_LISTING_LIMIT,
    expandFields,
    formatMissingNames,
    renderFields,
    renderScopes,
    renderVariableNames,
    selectVariables,
} from './core/variableView';
import { actionTimeoutMs, activeTargetName, CMSIS_FENCE_ADVICE, CmsisAction, runCmsisAction } from './handler/cmsisAction';
import { CapOutcome, failureText, fenced, fenceLimitMs, FenceOptions, LONG_LIMIT_CAP_MS } from './handler/fence';
import { FLASH_FENCE_ADVICE, flashTimeoutMs, runFlash } from './handler/flashTool';
import {
    breakpointTableFromMiReply, classifyGdbReply, DprintfCall, DprintfPlacement, dprintfFromMiReply, gdbRefusal, gdbSourceLocation, GdbTableEntry,
    translateLogMessage, unknownBreakpointNumbers,
} from './handler/gdbText';
import { HandlerHost, VSCODE_HOST } from './handler/host';
import { sessionTaskLine } from './handler/jobText';
import { PROBLEMS_DEFAULT_LIMIT, PROBLEMS_MAX_LIMIT, renderProblemPage } from './handler/problemText';
import { renderCallStack, renderSessionStatus, renderThreads, stoppedTargetRefusal } from './handler/sessionText';
import { bootstrapStatusLines, DEBUGGER_EXTENSION_ID, SOLUTION_EXTENSION_ID } from './core/bootstrapState';
import { normaliseRegister, registerNumber, renderCoreRegisters, renderCycleCounter, renderMemoryDump } from './handler/targetText';
import { PROBLEM_SEVERITIES, PROBLEM_SOURCES, problemJournal, ProblemJournal, ProblemSeverity, ProblemSource } from './core/problemJournal';
import { secondsText } from './core/windowHealth';
import { syncProblemsPanel } from './windowProblems';

export type { CmsisAction } from './handler/cmsisAction';
export { probeSchedule } from './handler/cmsisAction';

// ── Contract ───────────────────────────────────────────────────────────────

/** Every tool answers with a text or a reply with a status; a failure rejects with a `ToolError`. */
type Answer = Promise<ToolText>;
type VariableScope = 'local' | 'global' | 'all';

interface TimeoutArg { timeoutMs?: number }
interface StartRequest { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string; timeoutMs?: number }
interface ResetRequest { method?: 'auto' | 'system' | 'core' | 'hardware'; halt?: boolean; timeoutMs?: number }
interface BreakpointRequest { fileFullPath: string; line?: number; condition?: string; lineContent?: string }
interface LogpointRequest { fileFullPath: string; line: number; logMessage: string; condition?: string }
interface SourceLine { fileFullPath: string; line: number }
interface ScopeRequest { scope?: VariableScope; timeoutMs?: number }
interface ValuesRequest { scope?: VariableScope; variableNames?: string[]; timeoutMs?: number }
interface ExpressionRequest { expression: string; depth?: number; timeoutMs?: number }
interface MemoryRequest { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }
interface PeripheralReadRequest { peripheral: string; register?: string; timeoutMs?: number }
interface DiagnoseRequest { levels?: number; timeoutMs?: number }
interface PeripheralLookup { name?: string; address?: string; filter?: string; svdFile?: string; pname?: string; timeoutMs?: number }
interface RegisterLookup { peripheral: string; register: string; svdFile?: string; pname?: string; timeoutMs?: number }
interface StackRequest { threadId?: number; levels?: number; timeoutMs?: number }
interface FrameValuesRequest { frameId: number; scope?: VariableScope; variableNames?: string[]; timeoutMs?: number }
interface CmsisRequest { action: CmsisAction; target?: string; timeoutMs?: number; path?: string }
interface FlashRequest { cbuildRunFile?: string; timeoutMs?: number }
interface ProblemsRequest { sinceSeq?: number; sources?: ProblemSource[]; minSeverity?: ProblemSeverity; limit?: number }

/**
 * The debugging tools as the MCP server, the control server and the window
 * router see them. The member names must stay equal to `DEBUG_OPS`.
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: StartRequest): Answer;
    handleStopDebugging(): Answer;
    handleStepOver(args?: TimeoutArg): Answer;
    handleStepInto(args?: TimeoutArg): Answer;
    handleStepOut(args?: TimeoutArg): Answer;
    handleContinue(args?: TimeoutArg): Answer;
    handlePause(args?: TimeoutArg): Answer;
    handleWaitForStop(args?: TimeoutArg): Answer;
    handleRestart(args?: TimeoutArg): Answer;
    handleReset(args: ResetRequest): Answer;
    handleAddBreakpoint(args: BreakpointRequest): Answer;
    handleAddLogpoint(args: LogpointRequest): Answer;
    handleRemoveBreakpoint(args: SourceLine): Answer;
    handleClearAllBreakpoints(): Answer;
    handleListBreakpoints(): Answer;
    handleListVariableNames(args: ScopeRequest): Answer;
    handleGetVariables(args: ValuesRequest): Answer;
    handleEvaluateExpression(args: ExpressionRequest): Answer;
    handleReadMemory(args: MemoryRequest): Answer;
    handleReadCoreRegisters(args?: TimeoutArg): Answer;
    handleReadCycleCounter(args?: TimeoutArg): Answer;
    handleReadPeripheralRegister(args: PeripheralReadRequest): Answer;
    handleGetFaultInfo(args?: TimeoutArg): Answer;
    handleDiagnoseFault(args?: DiagnoseRequest): Answer;
    handleLookupPeripheral(args?: PeripheralLookup): Answer;
    handleLookupRegister(args: RegisterLookup): Answer;
    handleGetDeviceInfo(): Answer;
    handleDiscoverBoardOrDevice(args: DiscoveryRequest): Answer;
    handleCheckTargetConnection(): Answer;
    handleGetSessionStatus(): Answer;
    handleGetRecentProblems(args?: ProblemsRequest): Answer;
    handleGetCallStack(args: StackRequest): Answer;
    handleGetThreads(args?: TimeoutArg): Answer;
    handleGetFrameVariables(args: FrameValuesRequest): Answer;
    handleCmsisCommand(args: CmsisRequest): Answer;
    handleFlash(args: FlashRequest): Answer;
}

// ── Fixed texts ────────────────────────────────────────────────────────────

/** The launch.json entry name that means "synthesise a configuration for the file". */
const SYNTHESISED_CONFIGURATION = 'Default Configuration';

/** Waits for a session or a stop never exceed this, whatever the setting says. */
const WAIT_CAP_MS = 60_000;
/** The CMSIS actions that program or erase the target, which can make the probe's virtual COM port re-enumerate (#49). */
const PROGRAMMING_ACTIONS: ReadonlySet<string> = new Set<CmsisAction>(['load', 'erase', 'load_and_run']);
/** The recovery pause after a step or continue that did not stop. */
const RECOVERY_PAUSE_MS = 5_000;
/** `wait_for_stop` without `timeoutMs`, and the margin that lets its own text beat the fence. */
const WAIT_FOR_STOP_DEFAULT_MS = 28_500;
const WAIT_FOR_STOP_MARGIN_MS = 1_500;
/** Pause between a stop and reading the state, so VS Code has focused the new frame. */
const STOP_SETTLE_MS = 300;
/** How long a CMSIS Debugger target may take to stop before a breakpoint change or a restart. */
const CHANGE_PAUSE_MS = 5_000;
/** How long a new breakpoint waits for the adapter to report whether it bound (#13 proposal: 2 s). */
const BINDING_WAIT_MS = 2_000;
/** How long `stop_debugging` waits for VS Code to end the session before it answers (#14). */
const STOP_WAIT_MS = 10_000;
/** The most configuration names the hint of a closed picker lists. */
const PICKER_NAMES_LISTED = 10;
/** Registers `diagnose_fault` reads (`control` is read but not used). */
const TRIAGE_REGISTERS = ['sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'msplim', 'psplim'];

const NO_ACTIVE_SESSION = 'No active debug session.';
/** How to get a session: CMSIS projects start theirs through the CMSIS Solution extension (#20). */
const START_FIRST = 'Start a session first: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise.';
const NOTHING_TO_STOP = 'Nothing to stop — no debug session is active.';
const SESSION_STOPPED = 'The debug session has been stopped.';
/** A stop that VS Code did not confirm in time (#14). */
const STOP_UNCONFIRMED = `Stop requested, but the debug session did not end within ${STOP_WAIT_MS / 1000} s and is still listed. `
    + 'Call get_session_status to see whether it ends; stop_debugging may be called again.';
/** A configuration picker nobody answered (#14). */
const PICKER_UNANSWERED = 'without configurationName, start_debugging asks the user in a picker in that VS Code window, and nobody chose.';
const NOTHING_TO_RESTART = 'Nothing to restart — no debug session is active';
const SESSION_RESTARTED = 'The debug session has been restarted.';
const NO_FOCUSED_FRAME = 'There is no active stack frame.';
/** The frame is missing while VS Code has not yet shown the stop, or because the target runs after all. */
const NO_FOCUSED_FRAME_HINT = 'Call wait_for_stop, which returns once the target is stopped at a frame, '
    + 'or pause_execution if it is running; then retry.';
/** A step or continue whose session went away while it waited. */
const SESSION_ENDED_HINT = 'Call get_session_status to confirm; to debug again, start a session with '
    + 'cmsis_action load_and_debug (CMSIS projects) or start_debugging.';
const NO_SCOPES_HERE = 'The debug adapter reports no variable scopes at the current execution point.';
const NO_EVALUATION_RESULT = 'The debug adapter returned no result for this expression.';
const START_REFUSED = 'The debug session did not start. Make sure the debugger extension for this kind of file is installed.';
const NO_BREAKPOINTS = 'The breakpoint list is empty.';
const NOTHING_TO_CLEAR = 'Nothing to clear — no breakpoints are set.';
const NO_SESSION_YET = '(No debug session yet — added to VS Code\'s breakpoint list; the debugger binds it when a session starts.)';
const ADAPTER_SILENT = '⚠️ The debug adapter did not confirm the change within 2 s; list_breakpoints shows what it reports.';
const UNBOUND_ADVICE = 'An unverified breakpoint never stops the target: the line may have no code (a declaration, a comment, code the '
    + 'optimiser removed), the path may not match the ELF\'s compiled paths, or the FPB comparators may be used up.';
const LOGPOINT_COST = 'ℹ️ On Cortex-M a logpoint is not free: the core halts on every hit while GDB formats and prints, then resumes. '
    + 'In a hot loop or an ISR this distorts timing far more than it would in a host process. '
    + 'For high-rate tracing prefer read_cycle_counter around the region, or have the firmware fill a RAM buffer you read with read_memory.';

/** Appended to a successful stop: make sure the investigation reached a cause. */
const ROOT_CAUSE_CHECK = [
    '⚠️ **Root-cause check before you stop**',
    '',
    'Ask yourself one question before closing the investigation: did you find the cause of the problem, or only a symptom of it?',
    '',
    'Knowing only *where* things go wrong usually points to a symptom, so keep debugging if all you have is something like:',
    '- a variable that turns out null or undefined',
    '- a function that hands back a value nobody expected',
    '- an error raised at one particular line',
    '- a condition that took the wrong branch',
    '',
    'The root cause explains *why* it went wrong, for instance:',
    '- a variable that was initialised with the wrong value',
    '- faulty logic inside a function',
    '- an error path that is not handled',
    '- a condition built on a false assumption',
    '',
    'What to do next (required):',
    '1. Set breakpoints at the places worth investigating with `add_breakpoint`.',
    '2. Trace the run from its beginning with `start_debugging`.',
    '3. Work out why it happened, not only what happened.',
    '4. Repeat until the root cause is identified.',
].join('\n');

/** The execution requests the stop waiter drives, with their gate phrase and failure prefix. */
interface MotionSpec {
    tool: string;
    gate: string;
    failure: string;
    /**
     * What a wait that runs out means: a step should have stopped, so the
     * target is paused to find out where it went (`recover`); a continue is
     * meant to run, so the target is left running (`keep-running`).
     */
    onWaitOut: 'recover' | 'keep-running';
    send(executor: IDebuggingExecutor, timeoutMs: number | undefined): Promise<void>;
}

const STEP_OVER: MotionSpec = {
    tool: 'step_over', gate: 'step over', failure: 'Step over failed', onWaitOut: 'recover', send: (x, ms) => x.stepOver(ms),
};
const STEP_INTO: MotionSpec = {
    tool: 'step_into', gate: 'step into', failure: 'Step into failed', onWaitOut: 'recover', send: (x, ms) => x.stepInto(ms),
};
const STEP_OUT: MotionSpec = {
    tool: 'step_out', gate: 'step out', failure: 'Step out failed', onWaitOut: 'recover', send: (x, ms) => x.stepOut(ms),
};
const CONTINUE: MotionSpec = {
    tool: 'continue_execution', gate: 'continue execution', failure: 'Continue failed', onWaitOut: 'keep-running', send: (x, ms) => x.continue(ms),
};

/** How an execution request ended, with the state read afterwards. */
interface StopOutcome {
    state: DebugState;
    timedOut: boolean;
    /** How long the wait for the stop was allowed to take. */
    waitedMs: number;
    ended: boolean;
    /** Only for a real stop; undefined after a timeout or the session's end. */
    reason?: string | null;
}

type VariablesReply = { scopes?: DapScope[] } | undefined | null;
type EvaluateReply = { result?: unknown; type?: string; variablesReference?: number } | undefined | null;
type RedactCallback = (name: string, value: string) => { value: string; redacted: boolean };

/** The `redactSecrets` setting, read on every call. */
function redactionEnabled(): boolean {
    return vscode.workspace.getConfiguration('cmsis-developer-assistant').get<boolean>('redactSecrets', true);
}

/** A wait as the agent reads it: `600 ms`, `5 s`, `2.5 s`. */
function durationText(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${Number((ms / 1000).toFixed(1))} s`;
}

/** A positive override clamped to the cap, else the configured timeout under the same cap. */
function waitLimitMs(configuredSeconds: number, overrideMs: number | undefined): number {
    if (typeof overrideMs === 'number' && overrideMs > 0) {
        return Math.min(overrideMs, WAIT_CAP_MS);
    }
    return Math.min(configuredSeconds * 1000, WAIT_CAP_MS);
}

/** The last path segment, separated by `/` or `\`. */
function lastSegment(fsPath: string): string {
    return fsPath.replace(/^.*[\\/]/, '');
}

/** The hint of a picker nobody answered: the configurations the agent can name instead (#14). */
function configurationHint(offered: readonly string[]): string {
    const derived = `'${SYNTHESISED_CONFIGURATION}' with fileFullPath to derive one from the file type`;
    const cmsis = 'For a CMSIS solution, cmsis_action load_and_debug starts the session instead.';
    if (offered.length === 0) {
        return `.vscode/launch.json lists no configuration: pass configurationName ${derived}. ${cmsis}`;
    }
    const listed = offered.slice(0, PICKER_NAMES_LISTED).map((name) => `'${name}'`).join(', ');
    const more = offered.length > PICKER_NAMES_LISTED ? ` and ${offered.length - PICKER_NAMES_LISTED} more` : '';
    return `Pass configurationName: one of ${listed}${more} (from .vscode/launch.json), or ${derived}. ${cmsis}`;
}

function sourceLocationOf(bp: vscode.Breakpoint): vscode.Location | undefined {
    return bp instanceof vscode.SourceBreakpoint ? bp.location : undefined;
}

/** What a breakpoint change works with. */
interface ChangeContext {
    /** A debug session exists, so the adapter reports bindings. */
    live: boolean;
    /** It is a CMSIS Debugger session: logpoints are GDB dprintfs, and GDB numbers mean something to the agent. */
    cmsisDebugger: boolean;
}

/** What setting one CMSIS Debugger logpoint did. */
interface GdbLogpointOutcome {
    placed: DprintfPlacement;
    /** The GDB location it was set at. */
    location: string;
    condition?: string;
    /** VS Code logpoints at that line taken out of the model. */
    replaced: number;
}

/** A logpoint set as a GDB dprintf, or in VS Code's model with the adapter's binding. */
type LogpointOutcome =
    | { kind: 'dprintf'; dprintf: GdbLogpointOutcome }
    | { kind: 'model'; binding: BreakpointBinding | undefined; live: boolean };

/** A change's result, and the line that says the target was paused for it (empty when it was not). */
interface HaltedChange<T> {
    result: T;
    pausedNote: string;
}

/** How the adapter bound a breakpoint, for a list entry or an answer; `requestedLine` tells a moved one. */
function bindingText(binding: BreakpointBinding, requestedLine: number | undefined, gdbNumbers: boolean): string {
    if (!binding.reported) {
        return 'not reported by the adapter yet';
    }
    if (!binding.verified) {
        return `NOT verified${binding.message ? ` — ${binding.message}` : ''}`;
    }
    const number = gdbNumbers && binding.id !== undefined ? ` as GDB breakpoint ${binding.id}` : '';
    const moved = binding.line !== undefined && requestedLine !== undefined && binding.line !== requestedLine ? ` at line ${binding.line}` : '';
    return `verified${number}${moved}`;
}

/** `text` ending in a full stop, without doubling one it already has. */
function asSentence(text: string): string {
    return text.endsWith('.') ? text : `${text}.`;
}

/** The logpoints a location names: same file (as VS Code spells the URI) and line. */
function logpointsAt(logpoints: readonly GdbLogpoint[], place: vscode.Uri, line: number): GdbLogpoint[] {
    const wanted = place.toString();
    return logpoints.filter((logpoint) => logpoint.line === line && vscode.Uri.file(logpoint.file).toString() === wanted);
}

/** All scopes, or only the requested variables plus the names that matched nothing. */
function narrowScopes(scopes: DapScope[], names: string[] | undefined): { scopes: DapScope[]; missing: string[] } {
    return names ? selectVariables(scopes, names) : { scopes, missing: [] };
}

function requestedNames(names: string[] | undefined): string[] | undefined {
    return names && names.length > 0 ? names : undefined;
}

// ── The handler ────────────────────────────────────────────────────────────

export class DebuggingHandler
    implements IDebuggingHandler {

    private readonly dbg: IDebuggingExecutor;
    private readonly launchConfigs: IDebugConfigurationManager;
    private readonly configuredSeconds: number;
    /** The window's problem journal (#48), which `get_recent_problems` reads. */
    private readonly journal: ProblemJournal;
    /**
     * The breakpoint list the last state rendering showed, joined by line
     * feeds; undefined until the first one, which is not the same as an
     * empty list having been shown.
     */
    private shownBreakpoints: string | undefined;

    constructor(
        executor: IDebuggingExecutor,
        configurations: IDebugConfigurationManager,
        timeoutSeconds: number,
        journal: ProblemJournal = problemJournal(),
    ) {
        this.dbg = executor;
        this.launchConfigs = configurations;
        this.configuredSeconds = timeoutSeconds;
        this.journal = journal;
    }

    /** VS Code logpoint message → GDB `dprintf` format and arguments. */
    static translateLogMessage(logMessage: string): DprintfCall {
        return translateLogMessage(logMessage);
    }

    /** Clock, focused frame, task events and workspace; unit tests override this. */
    protected host(): HandlerHost {
        return VSCODE_HOST;
    }

    // ── shared machinery ──

    /** `onCap` is `reply` for tools that wait for something, `error` for reads (#11, decision 3). */
    private fence(
        label: string,
        timeoutMs: number | undefined,
        onCap: CapOutcome,
        body: () => Promise<ToolText>,
        options?: FenceOptions,
    ): Answer {
        return fenced(label, timeoutMs, this.host(), body, onCap, options);
    }

    /** Throws the state-specific refusal, a `ToolError` with the state's code and hint, unless the target is stopped. */
    private async requireStoppedTarget(operation: string): Promise<void> {
        if (await this.dbg.hasActiveSession()) {
            return;
        }
        const status = await this.dbg.getSessionStatus();
        throw stoppedTargetRefusal(operation, status.state, this.sessionRequest());
    }

    /** `configuration.request` of the session this window acts on, `launch` or `attach`: who owns the GDB server (#3). */
    private sessionRequest(): string | undefined {
        const request: unknown = this.dbg.getActiveSession()?.configuration?.request;
        return typeof request === 'string' ? request : undefined;
    }

    /** DHCSR.S_LOCKUP from one DHCSR read (#3); false when DHCSR cannot be read. */
    private async lockedUp(timeoutMs: number | undefined): Promise<boolean> {
        const port = await this.dbg.probeDebugPort(timeoutMs);
        return port.readable && isLockedUp(port.dhcsr);
    }

    /** The full state, remembering which breakpoint list it showed. */
    private fullState(state: DebugState): string {
        this.shownBreakpoints = state.breakpoints.join('\n');
        return state.toString();
    }

    /** The compact state; its breakpoint list only when it differs from the one shown last. */
    private compactState(state: DebugState): string {
        const listed = state.breakpoints.join('\n');
        const changed = listed !== this.shownBreakpoints;
        this.shownBreakpoints = listed;
        return state.toCompactString({ includeBreakpoints: changed });
    }

    private workspaceRoots(): string[] {
        return this.host().workspaceFolders().map((folder) => folder.uri.fsPath);
    }

    /** Poll until the session is running or stopped. The last backoff can overshoot the budget (KB10). */
    private async awaitLiveSession(overrideMs?: number): Promise<boolean> {
        const clock = this.host();
        const budgetMs = waitLimitMs(this.configuredSeconds, overrideMs);
        const began = clock.now();
        for (let attempt = 0; clock.now() - began < budgetMs; attempt++) {
            const { state } = await this.dbg.getSessionStatus();
            if (state === 'running' || state === 'stopped') {
                logger.info(`Debug session is live (state: ${state})`);
                return true;
            }
            logger.debug(`Waiting for the debug session to come up (attempt ${attempt}, state: ${state})`);
            await clock.sleep(Math.min(1000 * 2 ** attempt, 10_000) + Math.random() * 200);
        }
        return false;
    }

    /**
     * Arm the executor's stop waiter, send the request, then wait for the
     * armed DAP event (or its timeout, or the session's end). A request that
     * throws leaves the armed waiter to run out on its own.
     */
    private async sendAndAwaitStop(send: () => Promise<void>, overrideMs: number | undefined): Promise<StopOutcome> {
        const limitMs = waitLimitMs(this.configuredSeconds, overrideMs);
        const armed: Promise<StopWaitResult> = this.dbg.armStopWaiter(limitMs);
        armed.catch(() => undefined);
        await send();
        const result = await armed;
        if (result.kind === 'timeout') {
            logger.debug(`No DAP stopped event within ${limitMs} ms`);
        }
        let state: DebugState;
        try {
            state = await this.dbg.getCurrentDebugState(3);
        } catch {
            state = new DebugState();
        }
        return {
            state,
            timedOut: result.kind === 'timeout',
            waitedMs: limitMs,
            ended: result.kind === 'ended',
            reason: result.kind === 'stopped' ? result.reason : undefined,
        };
    }

    /**
     * A step or continue: gate, request, wait. When nothing stopped, a step
     * pauses the target to say where it went and answers with status
     * `timeout`; a continue leaves the target running and answers with
     * status `running`. A session that ends during the wait is a failure,
     * `NO_SESSION`, as for pause and `wait_for_stop`; the gate's own refusal
     * passes unwrapped.
     */
    private async move(spec: MotionSpec, args: TimeoutArg | undefined): Answer {
        let outcome: StopOutcome;
        try {
            await this.requireStoppedTarget(spec.gate);
            outcome = await this.sendAndAwaitStop(() => spec.send(this.dbg, args?.timeoutMs), args?.timeoutMs);
        } catch (caught) {
            throw wrapError(spec.failure, caught);
        }
        if (outcome.ended) {
            throw new ToolError('NO_SESSION', `Debug session ended during '${spec.tool}' — `
                + 'the target may have run to completion, crashed, or lost its connection.', SESSION_ENDED_HINT);
        }
        if (outcome.timedOut && spec.onWaitOut === 'keep-running') {
            return {
                text: `Target is running: no stop within ${durationText(outcome.waitedMs)} of '${spec.tool}', and it keeps running; `
                    + 'nothing was paused. Call wait_for_stop to wait for the next stop (a breakpoint, a fault), '
                    + 'or pause_execution to halt it and see where it is.',
                status: 'running',
            };
        }
        const body = outcome.reason
            ? `Target stopped (reason: ${outcome.reason}).\n\n${this.compactState(outcome.state)}`
            : this.compactState(outcome.state);
        if (outcome.timedOut) {
            const overrun = `\n\n⚠️ '${spec.tool}' did not complete within ${durationText(outcome.waitedMs)}. `
                + 'The target is still running or the probe is unresponsive. '
                + 'Consider adding a breakpoint, checking the hardware connection, or calling check_target_connection.';
            return { text: body + overrun + await this.locateRunawayTarget(spec.tool), status: 'timeout' };
        }
        return body;
    }

    /**
     * After a step that did not stop: pause the target and say
     * where it is. Reads the recovered state directly, so the breakpoint
     * diff of the compact state is not touched. Never throws.
     */
    private async locateRunawayTarget(tool: string): Promise<string> {
        const report = ['\n🩹 Recovery attempt: target did not stop on its own — issuing DAP pause to find out where it is.'];
        let paused: StopOutcome;
        try {
            paused = await this.sendAndAwaitStop(() => this.dbg.pause(RECOVERY_PAUSE_MS), RECOVERY_PAUSE_MS);
        } catch (caught) {
            report.push(`Pause failed: ${failureText(caught)}. Probe / GDB server may be wedged — call check_target_connection.`);
            return report.join('\n');
        }
        if (paused.ended) {
            report.push(`Pause issued but the debug session ended. The target may have crashed during '${tool}'.`);
        } else if (paused.timedOut) {
            report.push('Pause did not produce a stop event within 5s — probe/GDB server may be unresponsive. '
                + 'Call check_target_connection, then restart_debugging if needed.');
        } else {
            let pc: string;
            let lr: string | undefined;
            try {
                const registers = await this.dbg.readCoreRegisters(RECOVERY_PAUSE_MS, ['pc', 'lr']);
                pc = registers.pc ? normaliseRegister(registers.pc) : '<unavailable>';
                lr = registers.lr ? normaliseRegister(registers.lr) : undefined;
            } catch (caught) {
                pc = `<read failed: ${failureText(caught)}>`;
            }
            const where = paused.state;
            const lrPart = lr !== undefined ? `, LR = ${lr}` : '';
            const framePart = where.frameName ? ` in ${where.frameName}` : '';
            const filePart = where.fileName ? ` at ${where.fileName}:${where.currentLine}` : '';
            report.push(`Paused successfully. PC = ${pc}${lrPart}${framePart}${filePart}.`);
            if (where.currentLineContent) {
                report.push(`  Current line: ${where.currentLineContent}`);
            }
            report.push('The breakpoint you expected was not hit — the firmware did not reach it. '
                + 'Verify the breakpoint location, check the call stack with get_call_stack, '
                + 'or step from here with step_over / continue_execution.');
        }
        return report.join('\n');
    }

    /**
     * The frame id of the focused stack frame. Asked only after the state
     * gate found the target stopped, so a missing frame means VS Code has
     * not shown the stop yet, has a thread or another session in focus, or
     * saw the target resume without the adapter reporting it: the call needs
     * the target stopped at a frame first, hence `TARGET_RUNNING`.
     */
    private focusedFrame(): number {
        const frameId = this.host().focusedFrameId();
        if (frameId === undefined) {
            throw new Refusal('TARGET_RUNNING', NO_FOCUSED_FRAME, NO_FOCUSED_FRAME_HINT);
        }
        return frameId;
    }

    /** Scopes of the focused frame; a missing `global` scope widens to `all`. */
    private async focusedScopes(scope: VariableScope, timeoutMs: number | undefined): Promise<{ scopes: DapScope[]; widened: boolean }> {
        const frameId = this.focusedFrame();
        const hasScopes = (reply: VariablesReply): reply is { scopes: DapScope[] } =>
            Array.isArray(reply?.scopes) && reply.scopes.length > 0;
        let reply: VariablesReply = await this.dbg.getVariables(frameId, scope, timeoutMs);
        let widened = false;
        if (scope === 'global' && !hasScopes(reply)) {
            reply = await this.dbg.getVariables(frameId, 'all', timeoutMs);
            widened = true;
        }
        return { scopes: hasScopes(reply) ? reply.scopes : [], widened };
    }

    private variableRedactor(): RedactCallback | undefined {
        return redactionEnabled() ? (name, value) => redactVariableValue(name, value) : undefined;
    }

    // ── session ──

    async handleStartDebugging(args: StartRequest): Answer {
        if (this.dbg.hasDebugSession()) {
            const status = await this.dbg.getSessionStatus();
            throw new ToolError('PROBE_BUSY',
                `A debug session is already active (name='${status.sessionName ?? '?'}', state=${status.state}). `
                    + 'Refusing to start a second session.',
                'Use stop_debugging first, or call restart_debugging to reuse the current session, '
                    + 'or proceed directly with inspection tools (get_variables_values, read_memory, …).');
        }
        try {
            const chosen = args.configurationName ?? await this.chooseConfiguration(args);
            if (chosen && chosen !== SYNTHESISED_CONFIGURATION) {
                if (!(await this.dbg.startDebuggingByName(args.workingDirectory, chosen))) {
                    throw new Error(`Failed to start debug session with configuration '${chosen}'.`);
                }
                await this.requireLiveStart();
                const started = await this.dbg.getCurrentDebugState(3);
                const subject = args.fileFullPath ? args.fileFullPath : chosen;
                return `Debug session started successfully for: ${subject} using configuration '${chosen}'. `
                    + `Current state: ${this.fullState(started)}`;
            }
            if (!args.fileFullPath) {
                throw new ToolError('INVALID_ARGUMENT', 'fileFullPath is required when no named configuration is provided.');
            }
            const launch = await this.launchConfigs.getDebugConfig(args.workingDirectory, args.fileFullPath, chosen, args.testName);
            if (!(await this.dbg.startDebugging(args.workingDirectory, launch))) {
                throw new Error(START_REFUSED);
            }
            await this.requireLiveStart();
            const started = await this.dbg.getCurrentDebugState(3);
            const using = chosen ? ` using configuration '${chosen}'` : ' with default configuration';
            const forTest = args.testName ? ` for test '${args.testName}'` : '';
            return `Debug session started successfully for: ${args.fileFullPath}${using}${forTest}. `
                + `Current state: ${this.fullState(started)}`;
        } catch (caught) {
            // What the adapter and the GDB server said rides along as problem records (#48).
            throw wrapError('Error starting debug session', caught);
        }
    }

    private async requireLiveStart(): Promise<void> {
        if (!(await this.awaitLiveSession())) {
            throw new Error('Debug session started but failed to become active within timeout period');
        }
    }

    /**
     * The configuration picker, for as long as the call's `timeoutMs` says:
     * 30 s without, 60 s at most (#14). It waits for a person in a window the
     * agent cannot see; when nobody chooses in time it closes, and the call
     * fails with `INVALID_ARGUMENT` naming the configurations to pass.
     */
    private async chooseConfiguration(args: StartRequest): Promise<string | undefined> {
        const limitMs = fenceLimitMs(args.timeoutMs);
        const deadline = new vscode.CancellationTokenSource();
        const disarm = this.host().startTimer(limitMs, () => deadline.cancel());
        try {
            return await this.launchConfigs.promptForConfiguration(args.workingDirectory, deadline.token);
        } catch (caught) {
            if (caught instanceof PickerCancelled) {
                throw new ToolError('INVALID_ARGUMENT', `No debug configuration was chosen within ${secondsText(limitMs)}: ${PICKER_UNANSWERED}`,
                    configurationHint(caught.offered));
            }
            throw caught;
        } finally {
            disarm();
            deadline.dispose();
        }
    }

    /**
     * Stop the session and wait at most 10 s for VS Code to end it (#14). A
     * stop that does not settle in time, while the session is still listed,
     * answers with status `timeout`; one whose session is gone by then is a
     * success.
     */
    async handleStopDebugging(): Answer {
        try {
            if (!this.dbg.hasDebugSession()) {
                return NOTHING_TO_STOP;
            }
            const settled = await this.settlesWithin(this.dbg.stopDebugging(), STOP_WAIT_MS);
            if (!settled && this.dbg.hasDebugSession()) {
                logger.info(`stop_debugging: the session did not end within ${STOP_WAIT_MS} ms`);
                return { text: STOP_UNCONFIRMED, status: 'timeout' };
            }
            return `${SESSION_STOPPED}\n\n${ROOT_CAUSE_CHECK}`;
        } catch (caught) {
            throw wrapError('Could not stop the debug session', caught);
        }
    }

    /**
     * True when `work` settles within `limitMs` on the host's clock, false
     * when it does not; its rejection in time is thrown, a later one dropped.
     */
    private async settlesWithin(work: Promise<unknown>, limitMs: number): Promise<boolean> {
        let disarm: () => void = () => undefined;
        const expiry = new Promise<boolean>((settle) => {
            disarm = this.host().startTimer(limitMs, () => settle(false));
        });
        const done = work.then(() => true);
        // A second observer: once the timer has won, the race no longer waits for the work.
        done.catch(() => undefined);
        try {
            return await Promise.race([done, expiry]);
        } finally {
            disarm();
        }
    }

    /**
     * `timeoutMs` is accepted and ignored: the wait uses the configured
     * timeout (KB9). A running CMSIS Debugger target is paused first, so the
     * adapter lets go of a halted core; the executor then stops the session
     * and starts its launch configuration again (#13).
     */
    async handleRestart(_args?: TimeoutArg): Answer {
        try {
            if (!this.dbg.hasDebugSession()) {
                throw new Refusal('NO_SESSION', NOTHING_TO_RESTART);
            }
            const status = await this.dbg.getSessionStatus();
            const notes: string[] = [];
            if (status.sessionType === CMSIS_DEBUGGER_TYPE && status.state === 'running') {
                notes.push(await this.pauseBeforeRestart());
            }
            const logpoints = this.dbg.gdbLogpoints().length;
            const how = await this.dbg.restart();
            if (!(await this.awaitLiveSession())) {
                throw new Error(`Debug session restart issued but target did not become ready within ${durationText(waitLimitMs(this.configuredSeconds, undefined))}. `
                    + 'The probe or target may be unresponsive.');
            }
            if (how.via === 'relaunched') {
                notes.unshift(`It was stopped and its launch configuration${how.configurationName ? ` '${how.configurationName}'` : ''} started again.`);
                if (how.preLaunchTask) {
                    notes.push(`Its preLaunchTask "${how.preLaunchTask}" ran first; a CMSIS launch configuration flashes the image there `
                        + 'and resets the target in its initCommands.');
                }
                if (logpoints > 0) {
                    notes.push(`The ${logpoints} GDB dprintf logpoint(s) ended with the old session; add them again with add_logpoint.`);
                }
            }
            return [SESSION_RESTARTED, ...notes].join(' ');
        } catch (caught) {
            throw wrapError('Could not restart the debug session', caught);
        }
    }

    /** The pause before a restart; the restart goes ahead whatever it says. */
    private async pauseBeforeRestart(): Promise<string> {
        try {
            const paused = await this.pauseAndWait(CHANGE_PAUSE_MS);
            return paused.kind === 'stopped'
                ? 'The target was paused first.'
                : `⚠️ The target did not stop within ${CHANGE_PAUSE_MS / 1000} s of the pause request; the session was restarted anyway.`;
        } catch (caught) {
            return `⚠️ Pausing the target first failed (${failureText(caught)}); the session was restarted anyway.`;
        }
    }

    /** Arms the stop waiter, sends a pause and waits for the stop, the session's end or `limitMs`. */
    private async pauseAndWait(limitMs: number): Promise<StopWaitResult> {
        const armed = this.dbg.armStopWaiter(limitMs);
        armed.catch(() => undefined);
        await this.dbg.pause(limitMs);
        return armed;
    }

    handleReset(args: ResetRequest): Answer {
        return this.fence('reset', args.timeoutMs, 'reply', async () => {
            if (!this.dbg.hasDebugSession()) {
                throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION, `reset drives the target through the live probe. ${START_FIRST}`);
            }
            const outcome = await this.dbg.resetTarget({ method: args.method ?? 'auto', halt: args.halt, timeoutMs: args.timeoutMs });
            return renderResetOutcome(outcome, args.halt);
        });
    }

    /**
     * The session, plus one line on this window's CMSIS tasks when there is
     * anything to say (#46), and one on its serial port (#49). Without a
     * session, also what the window lacks for CMSIS work: a folder, the
     * CMSIS Solution or the CMSIS Debugger extension.
     */
    async handleGetSessionStatus(): Answer {
        const status = await this.dbg.getSessionStatus();
        const gaps = status.state === 'no-session' ? this.bootstrapLines() : [];
        return renderSessionStatus(status, this.dbg.getDiagnostics(), [...gaps, ...this.cmsisTaskLines(), ...this.serialLines()]);
    }

    /**
     * What the window lacks before CMSIS work can start, for a status without
     * a session: no folder open, the CMSIS Solution or CMSIS Debugger
     * extension not installed. Never throws, since that tool must not.
     */
    private bootstrapLines(): string[] {
        try {
            const host = this.host();
            const environment = host.toolEnvironment();
            return bootstrapStatusLines({
                folders: host.workspaceFolders().length,
                solutionExtension: environment.extension(SOLUTION_EXTENSION_ID) !== undefined,
                debuggerExtension: environment.extension(DEBUGGER_EXTENSION_ID) !== undefined,
            });
        } catch {
            return [];
        }
    }

    /**
     * `get_recent_problems` (#48): this window's problem journal from
     * `sinceSeq` on, at warning or above unless asked otherwise, the newest
     * 20 (at most 50). The Problems panel is read first when its source is
     * asked for, as it is when no source is named.
     */
    async handleGetRecentProblems(args: ProblemsRequest = {}): Answer {
        const known = <T>(values: readonly T[], value: unknown): value is T => values.includes(value as T);
        const sources = Array.isArray(args.sources) ? args.sources.filter((source) => known(PROBLEM_SOURCES, source)) : [];
        const minSeverity = known(PROBLEM_SEVERITIES, args.minSeverity) ? args.minSeverity : 'warning';
        const sinceSeq = Number.isInteger(args.sinceSeq) && (args.sinceSeq as number) >= 0 ? args.sinceSeq : undefined;
        const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit as number, 1), PROBLEMS_MAX_LIMIT) : PROBLEMS_DEFAULT_LIMIT;
        if (sources.length === 0 || sources.includes('problems')) {
            syncProblemsPanel(this.journal);
        }
        const chosen = sources.length > 0 ? sources : undefined;
        const page = this.journal.query({ sinceSeq, sources: chosen, minSeverity, limit });
        return renderProblemPage(page, { sinceSeq, sources: chosen, minSeverity });
    }

    /**
     * The serial line of `get_session_status`: the port this window holds,
     * for whom and how long idle, or why it was released; seen from the MCP
     * session that asks. Never throws, since that tool must not.
     */
    private serialLines(): string[] {
        try {
            const line = serialSessionLine(this.host().ownedSerial(), currentCallContext()?.sessionId);
            return line ? [line] : [];
        } catch (caught) {
            logger.warn('The serial line of get_session_status could not be built', caught);
            return [];
        }
    }

    /**
     * `work`'s answer with one more line when this window held a serial port
     * as it started (#49): programming can make the probe's virtual COM port
     * re-enumerate, which closes the port. A failure passes as it is.
     */
    private async noteHeldSerialPort(work: () => Answer): Answer {
        const serial = this.host().ownedSerial();
        const held = serial.hold()?.path;
        const outcome = await work();
        const note = held === undefined ? undefined : programmingNote(held, serial);
        if (note === undefined) {
            return outcome;
        }
        return typeof outcome === 'string' ? `${outcome}\n${note}` : { ...outcome, text: `${outcome.text}\n${note}` };
    }

    /** The CMSIS task line of `get_session_status`; never throws, since that tool must not. */
    private cmsisTaskLines(): string[] {
        try {
            const host = this.host();
            const jobs = host.cmsisJobs();
            const line = sessionTaskLine(jobs.recent(), jobs.liveExecutions(), host.now());
            return line ? [line] : [];
        } catch (caught) {
            logger.warn('The CMSIS task line of get_session_status could not be built', caught);
            return [];
        }
    }

    async handleCheckTargetConnection(): Answer {
        try {
            return await this.dbg.checkTargetConnection();
        } catch (caught) {
            if (caught instanceof HardwareTimeoutError) {
                return `check_target_connection: ${caught.message}`;
            }
            throw wrapError('Error checking target connection', caught);
        }
    }

    /** Catalog discovery works without a workspace, a solution or a stopped target. */
    handleDiscoverBoardOrDevice(args: DiscoveryRequest): Answer {
        return runDeviceDiscovery(args);
    }

    async handleGetDeviceInfo(): Answer {
        try {
            if (!this.dbg.hasDebugSession()) {
                throw new Refusal('NO_SESSION', NO_ACTIVE_SESSION, START_FIRST);
            }
            const info = await this.dbg.getDeviceInfo();
            const cmsisTarget = await activeTargetName();
            return cmsisTarget ? `${info.trimEnd()}\n  CMSIS target: ${cmsisTarget}` : info;
        } catch (caught) {
            throw wrapError('Error getting device info', caught);
        }
    }

    // ── execution ──

    handleStepOver(args?: TimeoutArg): Answer {
        return this.move(STEP_OVER, args);
    }

    handleStepInto(args?: TimeoutArg): Answer {
        return this.move(STEP_INTO, args);
    }

    handleStepOut(args?: TimeoutArg): Answer {
        return this.move(STEP_OUT, args);
    }

    handleContinue(args?: TimeoutArg): Answer {
        return this.move(CONTINUE, args);
    }

    /** Not fenced and not wrapped: refusals and errors keep their own text and code. */
    async handlePause(args?: TimeoutArg): Answer {
        if (!this.dbg.hasDebugSession()) {
            throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION, START_FIRST);
        }
        const status = await this.dbg.getSessionStatus();
        switch (status.state) {
            case 'stopped':
                return `Target is already stopped (reason: ${status.detail ?? 'n/a'}). No pause needed — proceed with inspection tools.`;
            case 'unresponsive':
                throw new ToolError('TIMEOUT', 'Cannot pause: probe/GDB server is unresponsive.', 'Call check_target_connection or restart_debugging.');
            case 'no-session':
                throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION);
            case 'initializing':
                throw new ToolError('NO_SESSION', 'Cannot pause yet: session is still initializing.', 'Wait briefly and retry.');
            case 'running':
                break;
        }
        const outcome = await this.sendAndAwaitStop(() => this.dbg.pause(args?.timeoutMs), args?.timeoutMs);
        if (outcome.timedOut) {
            return {
                text: 'Pause requested but target did not stop within the timeout. '
                    + 'Probe may be unresponsive — call get_session_status / check_target_connection.',
                status: 'timeout',
            };
        }
        if (outcome.ended) {
            throw new ToolError('NO_SESSION', 'Pause requested but the debug session ended. The target may have crashed.');
        }
        return `Target paused. ${this.compactState(outcome.state)}`;
    }

    handleWaitForStop(args?: TimeoutArg): Answer {
        return this.fence('wait_for_stop', args?.timeoutMs, 'reply', async () => {
            if (!this.dbg.hasDebugSession()) {
                throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION, `wait_for_stop waits on a live session. ${START_FIRST}`);
            }
            const budgetMs = args?.timeoutMs
                ? Math.max(args.timeoutMs - WAIT_FOR_STOP_MARGIN_MS, 100)
                : WAIT_FOR_STOP_DEFAULT_MS;
            const outcome = await this.dbg.waitForStop(budgetMs);
            if (outcome.kind === 'timeout') {
                return {
                    text: 'Target did not stop within the timeout — it is still running (or the probe is unresponsive). '
                        + 'Options: call wait_for_stop again with a larger timeoutMs, pause_execution to see where it is, '
                        + 'or check_target_connection if other calls are also stalling.',
                    status: 'timeout',
                };
            }
            if (outcome.kind === 'ended') {
                throw new ToolError('NO_SESSION',
                    'The debug session ended while waiting for a stop — the target may have crashed, the probe disconnected, '
                        + 'or the session was stopped in the UI.',
                    'Call get_session_status to confirm.');
            }
            await this.host().sleep(STOP_SETTLE_MS);
            const state = await this.dbg.getCurrentDebugState(3);
            const reason = outcome.reason ?? 'unknown';
            if (outcome.kind === 'already-stopped') {
                return `Target was already stopped (reason: ${reason}).\n\n${this.compactState(state)}`;
            }
            const thread = outcome.threadId !== null && outcome.threadId !== undefined ? `, threadId=${outcome.threadId}` : '';
            return `Target stopped (reason: ${reason}${thread}).\n\n${this.compactState(state)}`;
        });
    }

    // ── breakpoints ──

    /**
     * Runs a breakpoint change with the target halted where that is needed.
     * On a CMSIS Debugger session whose target runs, the target is paused
     * first and resumed afterwards, also when the change fails; the answer
     * then says so (#13). Without a session the change only touches VS
     * Code's model, and other adapters take changes while the target runs.
     */
    private async withTargetHalted<T>(operation: string, change: (context: ChangeContext) => Promise<T>): Promise<HaltedChange<T>> {
        if (!this.dbg.hasDebugSession()) {
            return { result: await change({ live: false, cmsisDebugger: false }), pausedNote: '' };
        }
        const status = await this.dbg.getSessionStatus();
        const context: ChangeContext = { live: status.state !== 'no-session', cmsisDebugger: status.sessionType === CMSIS_DEBUGGER_TYPE };
        if (!context.cmsisDebugger || status.state === 'stopped' || status.state === 'no-session') {
            return { result: await change(context), pausedNote: '' };
        }
        if (status.state === 'initializing') {
            throw new Refusal('NO_SESSION', `Cannot ${operation} yet: the session is still initializing.`, 'Wait briefly and retry.');
        }
        if (status.state === 'unresponsive') {
            throw new Refusal('TIMEOUT', `Cannot ${operation}: the probe/GDB server is unresponsive.`,
                'Call check_target_connection, then restart_debugging if needed.');
        }
        const began = this.host().now();
        const paused = await this.pauseAndWait(CHANGE_PAUSE_MS);
        if (paused.kind === 'ended') {
            throw new Refusal('NO_SESSION', `Cannot ${operation}: the debug session ended while the target was being paused for it.`);
        }
        if (paused.kind === 'timeout') {
            throw new Refusal('TIMEOUT', `Cannot ${operation}: the target did not stop within ${CHANGE_PAUSE_MS / 1000} s of the pause request.`,
                'Call check_target_connection; if the probe answers, pause_execution and retry.');
        }
        let result: T;
        try {
            result = await change(context);
        } catch (failure) {
            const stuck = await this.resumeAfterChange();
            if (!stuck) {
                throw failure;
            }
            const typed = toToolError(failure);
            throw new ToolError(typed.code, `${typed.message} The target was paused for this and could not be resumed: ${stuck}.`,
                'The target is halted: call continue_execution when ready.', typed.data);
        }
        const stuck = await this.resumeAfterChange();
        const seconds = ((this.host().now() - began) / 1000).toFixed(1);
        return {
            result,
            pausedNote: stuck
                ? `⚠️ The target was paused for this and could not be resumed: ${stuck}. It is halted — call continue_execution.`
                : `Target paused ${seconds} s to apply this, then resumed.`,
        };
    }

    /** Resumes the target after a change; the failure text, or undefined when it runs again. */
    private async resumeAfterChange(): Promise<string | undefined> {
        try {
            await this.dbg.continue(CHANGE_PAUSE_MS);
            return undefined;
        } catch (caught) {
            return failureText(caught);
        }
    }

    /** The 1-based lines a breakpoint request names: `line`, or every line containing the deprecated `lineContent`. */
    private async breakpointLines(args: BreakpointRequest): Promise<{ lines: number[]; matchedByContent: boolean }> {
        if (typeof args.line === 'number') {
            if (!Number.isInteger(args.line) || args.line < 1) {
                throw new ToolError('INVALID_ARGUMENT', `Invalid line number ${args.line}: must be a 1-based integer.`);
            }
            return { lines: [args.line], matchedByContent: false };
        }
        if (!args.lineContent) {
            throw new ToolError('INVALID_ARGUMENT',
                'No location given: pass `line` (1-based line number). The legacy `lineContent` form is still accepted but deprecated.');
        }
        const needle = args.lineContent;
        const source = (await vscode.workspace.openTextDocument(vscode.Uri.file(args.fileFullPath))).getText();
        const lines = source.split(/\r?\n/).flatMap((text, index) => text.includes(needle) ? [index + 1] : []);
        if (lines.length === 0) {
            throw new ToolError('INVALID_ARGUMENT', `Could not find any lines containing: ${needle}`);
        }
        return { lines, matchedByContent: true };
    }

    /**
     * Breakpoints go to VS Code's model on every adapter; the answer reports
     * how the adapter bound each of them (`getDebugProtocolBreakpoint`).
     */
    async handleAddBreakpoint(args: BreakpointRequest): Answer {
        try {
            const { lines, matchedByContent } = await this.breakpointLines(args);
            const place = vscode.Uri.file(args.fileFullPath);
            const change = await this.withTargetHalted('add a breakpoint', async (context) => {
                const added: vscode.SourceBreakpoint[] = [];
                for (const line of lines) {
                    added.push(await this.dbg.addBreakpoint(place, line, { condition: args.condition }));
                }
                if (!context.live) {
                    return undefined;
                }
                const bindings = await Promise.all(added.map((bp) => this.dbg.breakpointBinding(bp, BINDING_WAIT_MS)));
                return { bindings, cmsisDebugger: context.cmsisDebugger };
            });

            let head = lines.length === 1
                ? `Breakpoint added at ${args.fileFullPath}:${lines[0]}`
                : `Breakpoints added at ${lines.length} locations in ${args.fileFullPath}: lines ${lines.join(', ')}`;
            if (args.condition) {
                head += ` [when: ${args.condition}]`;
            }
            const report = [head];
            if (matchedByContent) {
                report.push(`⚠️ Located via the deprecated \`lineContent\` match (${lines.length} line(s) matched). `
                    + 'Pass `line` instead — content matching hits every line containing the text.');
            }
            const outcome = change.result;
            if (!outcome) {
                report.push(NO_SESSION_YET);
                return report.join('\n');
            }
            const bindings = outcome.bindings.map((binding) => binding ?? { reported: false, verified: false });
            const described = bindings.map((binding, index) => bindingText(binding, lines[index], outcome.cmsisDebugger));
            if (lines.length === 1) {
                report.push(`Adapter: ${asSentence(described[0])}`);
            } else {
                report.push('Adapter:', ...described.map((text, index) => `  line ${lines[index]}: ${text}`));
            }
            if (bindings.some((binding) => binding.reported && !binding.verified)) {
                report.push(UNBOUND_ADVICE);
            }
            if (bindings.some((binding) => !binding.reported)) {
                report.push('Call list_breakpoints later to see whether the adapter bound it.');
            }
            if (change.pausedNote) {
                report.push(change.pausedNote);
            }
            return report.join('\n');
        } catch (caught) {
            throw wrapError('Error adding breakpoint', caught);
        }
    }

    /**
     * On the CMSIS Debugger a logpoint is a GDB `dprintf`, which fills in the
     * `{expr}` values (cdt-gdb-adapter prints a VS Code logpoint's text as it
     * stands) and is remembered under its GDB number. Other adapters, and a
     * logpoint set before any session, use VS Code's model.
     */
    async handleAddLogpoint(args: LogpointRequest): Answer {
        try {
            if (!Number.isInteger(args.line) || args.line < 1) {
                throw new ToolError('INVALID_ARGUMENT', `Invalid line number ${args.line}: must be a 1-based integer.`);
            }
            const call = translateLogMessage(args.logMessage);
            const place = vscode.Uri.file(args.fileFullPath);
            const change = await this.withTargetHalted('add a logpoint', async (context): Promise<LogpointOutcome> => {
                if (context.cmsisDebugger) {
                    return { kind: 'dprintf', dprintf: await this.setGdbLogpoint(args, call, place) };
                }
                const added = await this.dbg.addBreakpoint(place, args.line, { condition: args.condition, logMessage: args.logMessage });
                const binding = context.live ? await this.dbg.breakpointBinding(added, BINDING_WAIT_MS) : undefined;
                return { kind: 'model', binding, live: context.live };
            });
            const report = [`Logpoint added at ${args.fileFullPath}:${args.line}`];
            const outcome = change.result;
            if (outcome.kind === 'dprintf') {
                report.push(...this.dprintfReport(args, call, outcome.dprintf));
            } else if (!outcome.live) {
                report.push('(No debug session yet — added to VS Code\'s breakpoint list. The CMSIS Debugger prints such a logpoint\'s '
                    + 'text without the {expr} values: call add_logpoint again once the session is up to set it as a GDB dprintf.)');
                return report.join('\n');
            } else {
                report.push(`Adapter: ${asSentence(bindingText(outcome.binding ?? { reported: false, verified: false }, args.line, false))}`);
            }
            if (change.pausedNote) {
                report.push(change.pausedNote);
            }
            report.push('', LOGPOINT_COST);
            return report.join('\n');
        } catch (caught) {
            throw wrapError('Could not add the logpoint', caught);
        }
    }

    /**
     * Sets one CMSIS Debugger logpoint: MI `-dprintf-insert` at a location
     * relative to the workspace, whose result names the new breakpoint, then
     * its condition. A condition GDB refuses takes the dprintf back out.
     */
    private async setGdbLogpoint(args: LogpointRequest, call: DprintfCall, place: vscode.Uri): Promise<GdbLogpointOutcome> {
        // A VS Code logpoint set here before the session would print its bare text next to the dprintf.
        const replaced = (await this.dbg.removeBreakpoint(place, args.line, { logpointsOnly: true })).removed;
        const location = gdbSourceLocation(args.fileFullPath, args.line, this.workspaceRoots());
        const inserted = await this.dbg.insertDprintfViaGdb(location, call.format, call.args);
        if (classifyGdbReply(inserted) !== 'done') {
            throw gdbRefusal('the logpoint', inserted);
        }
        const placed = dprintfFromMiReply(inserted.text);
        if (!placed) {
            throw new ToolError('INTERNAL', `GDB did not report the new dprintf: ${inserted.text || '<empty reply>'}`,
                'Check with evaluate_expression("-exec info breakpoints") and delete a stray dprintf with "-exec delete <n>".');
        }
        const condition = args.condition?.trim();
        if (condition) {
            const conditioned = await this.dbg.setBreakpointConditionViaGdb(placed.number, condition);
            if (classifyGdbReply(conditioned) !== 'done') {
                await this.dbg.deleteBreakpointsViaGdb([placed.number]);
                throw gdbRefusal('the logpoint condition', conditioned);
            }
        }
        this.dbg.rememberGdbLogpoint({ number: placed.number, file: args.fileFullPath, line: args.line, message: args.logMessage, condition });
        return { placed, location, condition, replaced };
    }

    /** The lines of an answer that describe a new CMSIS Debugger logpoint. */
    private dprintfReport(args: LogpointRequest, call: DprintfCall, outcome: GdbLogpointOutcome): string[] {
        const { placed, location, condition, replaced } = outcome;
        const where = placed.file && placed.line !== undefined ? `${placed.file}:${placed.line}` : location;
        const address = placed.locations === 1 && placed.address ? `, ${placed.address}` : '';
        const argumentList = call.args.length > 0 ? `,${call.args.join(',')}` : '';
        const lines = [`  GDB dprintf ${placed.number} (${where}${address}): dprintf ${location},"${call.format}"${argumentList}`];
        if (placed.locations > 1) {
            lines.push(`⚠️ GDB set it at ${placed.locations} locations: the location matched more than one place.`);
        }
        if (condition) {
            lines.push(`  Condition: ${condition}`);
        }
        if (replaced > 0) {
            lines.push('Replaced the VS Code logpoint set at this line before the session, which printed its text without the values.');
        }
        lines.push(`It prints to VS Code's Debug Console; list_breakpoints shows how often it fired. remove_breakpoint on ${args.fileFullPath}:${args.line} deletes it.`);
        return lines;
    }

    /** Deletes these CMSIS Debugger logpoints by number and forgets them; the line that says what GDB did. */
    private async deleteGdbLogpoints(logpoints: readonly GdbLogpoint[]): Promise<string> {
        const numbers = logpoints.map((logpoint) => logpoint.number);
        const reply = await this.dbg.deleteBreakpointsViaGdb(numbers);
        if (classifyGdbReply(reply) !== 'done') {
            throw gdbRefusal(`the delete of dprintf ${numbers.join(', ')}`, reply);
        }
        this.dbg.forgetGdbLogpoints(numbers);
        const gone = unknownBreakpointNumbers(reply.text).filter((number) => numbers.includes(number));
        const deleted = numbers.filter((number) => !gone.includes(number));
        const parts: string[] = [];
        if (deleted.length > 0) {
            parts.push(`Deleted GDB dprintf ${deleted.join(', ')}.`);
        }
        if (gone.length > 0) {
            parts.push(`GDB no longer had dprintf ${gone.join(', ')} (deleted outside these tools).`);
        }
        return parts.join(' ');
    }

    async handleRemoveBreakpoint(args: SourceLine): Answer {
        try {
            const place = vscode.Uri.file(args.fileFullPath);
            const wanted = place.toString();
            const inModel = this.dbg.getBreakpoints().some((bp) => {
                const location = sourceLocationOf(bp);
                return location !== undefined && location.uri.toString() === wanted && location.range.start.line === args.line - 1;
            });
            const logpoints = logpointsAt(this.dbg.gdbLogpoints(), place, args.line);
            if (!inModel && logpoints.length === 0) {
                return `Nothing to remove — no breakpoint is set at ${args.fileFullPath}:${args.line}.`;
            }
            const change = await this.withTargetHalted('remove a breakpoint', async () => {
                const notes: string[] = [];
                if (logpoints.length > 0) {
                    notes.push(await this.deleteGdbLogpoints(logpoints));
                }
                if (inModel && (await this.dbg.removeBreakpoint(place, args.line)).applied === false) {
                    notes.push(ADAPTER_SILENT);
                }
                return notes;
            });
            const head = `${inModel ? 'Breakpoint' : 'Logpoint'} removed from ${args.fileFullPath}:${args.line}`;
            return [head, ...change.result, change.pausedNote].filter((line) => line.length > 0).join('\n');
        } catch (caught) {
            throw wrapError('Could not remove the breakpoint', caught);
        }
    }

    /** Clears VS Code's model and deletes the session's GDB logpoints by number — never with a bare `delete`. */
    async handleClearAllBreakpoints(): Answer {
        try {
            const count = this.dbg.getBreakpoints().length;
            const logpoints = this.dbg.gdbLogpoints();
            if (count === 0 && logpoints.length === 0) {
                return NOTHING_TO_CLEAR;
            }
            const change = await this.withTargetHalted('clear the breakpoints', async () => {
                const notes: string[] = [];
                if (logpoints.length > 0) {
                    notes.push(await this.deleteGdbLogpoints(logpoints));
                }
                if (count > 0 && (await this.dbg.clearAllBreakpoints()).applied === false) {
                    notes.push(ADAPTER_SILENT);
                }
                return notes;
            });
            return [`Cleared ${count} breakpoint(s) from the model.`, ...change.result, change.pausedNote].filter((line) => line.length > 0).join('\n');
        } catch (caught) {
            throw wrapError('Could not clear the breakpoints', caught);
        }
    }

    /**
     * VS Code's breakpoints with the adapter's binding of each while a
     * session runs, then the CMSIS Debugger logpoints with GDB's hit count.
     * Kinds other than source and function breakpoints print nothing but
     * keep their number (KB15).
     */
    async handleListBreakpoints(): Answer {
        try {
            const all = this.dbg.getBreakpoints();
            const logpoints = this.dbg.gdbLogpoints();
            if (all.length === 0 && logpoints.length === 0) {
                return NO_BREAKPOINTS;
            }
            const live = this.dbg.hasDebugSession();
            let listing = 'Breakpoints that are set:\n';
            for (const [index, bp] of all.entries()) {
                const location = sourceLocationOf(bp);
                let entry: string;
                if (location) {
                    entry = `${index + 1}. ${lastSegment(location.uri.fsPath)}:${location.range.start.line + 1}${formatBreakpointModifiers(bp)}`;
                } else if (bp instanceof vscode.FunctionBreakpoint) {
                    entry = `${index + 1}. Function: ${bp.functionName}${formatBreakpointModifiers(bp)}`;
                } else {
                    continue;
                }
                const binding = live ? await this.dbg.breakpointBinding(bp, 0) : undefined;
                listing += binding ? `${entry} — ${bindingText(binding, location ? location.range.start.line + 1 : undefined, false)}\n` : `${entry}\n`;
            }
            if (logpoints.length > 0) {
                listing += 'GDB dprintf logpoints (they print to the Debug Console):\n';
                const table = live ? await this.gdbBreakpointTable() : undefined;
                const gone: number[] = [];
                logpoints.forEach((logpoint, index) => {
                    const entry = `${all.length + index + 1}. ${lastSegment(logpoint.file)}:${logpoint.line}`
                        + `${formatBreakpointModifiers({ condition: logpoint.condition, logMessage: logpoint.message })}`;
                    const row = table?.get(logpoint.number);
                    if (table && !row) {
                        gone.push(logpoint.number);
                        listing += `${entry} — dprintf ${logpoint.number} is gone from GDB (deleted outside these tools)\n`;
                    } else {
                        const hits = row?.hits !== undefined ? `, ${row.hits} hit${row.hits === 1 ? '' : 's'}` : '';
                        listing += `${entry} — GDB dprintf ${logpoint.number}${hits}\n`;
                    }
                });
                this.dbg.forgetGdbLogpoints(gone);
            }
            return listing;
        } catch (caught) {
            throw wrapError('Could not list the breakpoints', caught);
        }
    }

    /** GDB's breakpoint table by number (MI `-break-list`), or undefined when GDB did not give it. */
    private async gdbBreakpointTable(): Promise<Map<number, GdbTableEntry> | undefined> {
        try {
            const reply = await this.dbg.listBreakpointsViaGdb();
            const rows = reply.errored ? undefined : breakpointTableFromMiReply(reply.text);
            return rows ? new Map(rows.map((row) => [row.number, row])) : undefined;
        } catch (caught) {
            logger.debug('list_breakpoints: GDB\'s breakpoint table could not be read', caught);
            return undefined;
        }
    }

    // ── variables and expressions ──

    handleListVariableNames(args: ScopeRequest): Answer {
        return this.fence('list_variable_names', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('list variable names');
            const { scopes } = await this.focusedScopes(args.scope ?? 'all', args.timeoutMs);
            if (scopes.length === 0) {
                return NO_SCOPES_HERE;
            }
            return renderVariableNames(scopes, { maxVariables: DEFAULT_NAME_LISTING_LIMIT });
        });
    }

    handleGetVariables(args: ValuesRequest): Answer {
        return this.fence('get_variables_values', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read variables');
            const { scopes, widened } = await this.focusedScopes(args.scope ?? 'all', args.timeoutMs);
            if (scopes.length === 0) {
                return NO_SCOPES_HERE;
            }
            const names = requestedNames(args.variableNames);
            const picked = narrowScopes(scopes, names);
            const note = widened
                ? 'Note: No dedicated "Global" scope is available from this debug adapter. Showing all available scopes instead. '
                    + 'Use evaluate_expression to inspect specific global variables by name.\n\n'
                : '';
            if (names && picked.scopes.length === 0) {
                return `${note}None of the requested variables are in scope: ${names.join(', ')}.\n`
                    + 'Call list_variable_names to see what is available here.';
            }
            const listing = renderScopes(picked.scopes, {
                header: 'Variables',
                redact: this.variableRedactor(),
                limits: names ? undefined : DEFAULT_LISTING_LIMITS,
            });
            return note + listing + formatMissingNames(picked.missing);
        });
    }

    /** Any frame by id: no focused-frame check and no widening of `global`. */
    handleGetFrameVariables(args: FrameValuesRequest): Answer {
        return this.fence('get_frame_variables', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('get frame variables');
            const reply: VariablesReply = await this.dbg.getVariablesForFrame(args.frameId, args.scope ?? 'all', args.timeoutMs);
            const scopes = reply?.scopes;
            if (!Array.isArray(scopes) || scopes.length === 0) {
                return `No variable scopes available for frameId=${args.frameId}.`;
            }
            const names = requestedNames(args.variableNames);
            const picked = narrowScopes(scopes, names);
            if (names && picked.scopes.length === 0) {
                return `None of the requested variables are in scope at frameId=${args.frameId}: ${names.join(', ')}.`;
            }
            const listing = renderScopes(picked.scopes, {
                header: `Variables for frameId=${args.frameId}`,
                redact: this.variableRedactor(),
                limits: names ? undefined : DEFAULT_LISTING_LIMITS,
            });
            return listing + formatMissingNames(picked.missing);
        });
    }

    /**
     * A GDB command written `-exec <cmd>` or `><cmd>` goes to GDB (on the
     * CMSIS Debugger in its `>` spelling, with the text GDB printed as the
     * result) and is never redacted: it is a raw target read like read_memory.
     * A result with children (a struct, an array, a pointer) lists them under
     * `Fields:`, `depth` levels deep (one by default), capped and redacted
     * like a variable listing.
     */
    handleEvaluateExpression(args: ExpressionRequest): Answer {
        return this.fence('evaluate_expression', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('evaluate expression');
            const frameId = this.focusedFrame();
            const reply: EvaluateReply = await this.dbg.evaluateExpression(args.expression, frameId, args.timeoutMs);
            if (reply === undefined || reply === null || reply.result === undefined) {
                throw new Error(NO_EVALUATION_RESULT);
            }
            const passthrough = passthroughCommand(args.expression) !== undefined;
            const printedNothing = passthrough && String(reply.result).trim() === '';
            const redacting = redactionEnabled() && !passthrough;
            const shown = redacting
                ? redactExpressionResult(args.expression, reply.result)
                : { value: printedNothing ? '(GDB printed nothing)' : String(reply.result), redacted: false };
            let text = `Evaluated: ${args.expression}\nResult: ${shown.value}`;
            if (reply.type) {
                text += `\nType: ${reply.type}`;
            }
            let redacted = shown.redacted;
            const reference = typeof reply.variablesReference === 'number' ? reply.variablesReference : 0;
            // A struct, array or pointer: its fields below, never those of a withheld or credential-named value.
            if (reference > 0 && !passthrough && !shown.redacted && !(redacting && isSensitiveName(args.expression.trim()))) {
                const fields = await expandFields({
                    children: (ref) => this.dbg.getVariableChildren(ref, args.timeoutMs),
                    redact: redacting ? (name, value) => redactVariableValue(name, value) : undefined,
                    withholdChildren: redacting ? isSensitiveName : undefined,
                }, reference, args.depth ?? 1);
                if (fields.shown.length > 0 || fields.hidden > 0 || fields.error !== undefined) {
                    text += `\n${renderFields(fields)}`;
                }
                redacted ||= anyFieldRedacted(fields);
            }
            if (redacted) {
                text += `\n\n${REDACTION_NOTICE}`;
            }
            return text;
        });
    }

    // ── raw target reads (never redacted) ──

    handleReadMemory(args: MemoryRequest): Answer {
        return this.fence('read_memory', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read memory');
            const format = args.format ?? 'hex';
            const bytes = await this.dbg.readMemory(args.address, args.length, args.timeoutMs);
            return renderMemoryDump(args.address, args.length, bytes, format);
        });
    }

    handleReadCoreRegisters(args?: TimeoutArg): Answer {
        return this.fence('read_core_registers', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read core registers');
            return renderCoreRegisters(await this.dbg.readCoreRegisters(args?.timeoutMs));
        });
    }

    handleReadCycleCounter(args?: TimeoutArg): Answer {
        return this.fence('read_cycle_counter', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read cycle counter');
            return renderCycleCounter(await this.dbg.readCycleCounter(args?.timeoutMs));
        });
    }

    handleReadPeripheralRegister(args: PeripheralReadRequest): Answer {
        return this.fence('read_peripheral_register', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read peripheral register');
            return this.dbg.readPeripheralRegister(args.peripheral, args.register, args.timeoutMs);
        });
    }

    /** The decoded fault registers, and a lockup note when DHCSR says so; a wedged probe is the error itself (#3). */
    handleGetFaultInfo(args?: TimeoutArg): Answer {
        return this.fence('get_fault_info', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read fault info');
            const report = await this.dbg.getFaultInfo(args?.timeoutMs);
            return (await this.lockedUp(args?.timeoutMs)) ? `${report}\n${LOCKUP_NOTE}\n` : report;
        });
    }

    /**
     * One-call fault triage. Every read after the fault registers degrades to
     * a note instead of failing — except a wedged probe (#3), which is the
     * answer rather than a diagnosis built on registers that were not read.
     */
    handleDiagnoseFault(args?: DiagnoseRequest): Answer {
        return this.fence('diagnose_fault', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('diagnose the fault');
            const timeoutMs = args?.timeoutMs;
            const depth = args?.levels ?? 3;
            const decoded = decodeFault(await this.dbg.readFaultRegisters(timeoutMs));
            const lockup = await this.lockedUp(timeoutMs);
            const skipped: string[] = [];

            let raw: Record<string, string> = {};
            try {
                raw = await this.dbg.readCoreRegisters(timeoutMs, TRIAGE_REGISTERS);
            } catch {
                skipped.push('core registers');
            }
            const regs = {
                sp: registerNumber(raw.sp),
                lr: registerNumber(raw.lr),
                pc: registerNumber(raw.pc),
                xpsr: registerNumber(raw.xpsr),
                msp: registerNumber(raw.msp),
                psp: registerNumber(raw.psp),
                msplim: registerNumber(raw.msplim),
                psplim: registerNumber(raw.psplim),
            };

            const selection = selectExceptionFrame(regs.lr, regs.msp, regs.psp);
            let frame: StackedFrame | null = null;
            let frameNote: string | undefined;
            if (!selection.isExcReturn) {
                frameNote = regs.lr === undefined
                    ? 'LR unavailable — read_core_registers, then read_memory at PSP/MSP'
                    : 'LR is not an EXC_RETURN value — halted deeper inside the handler; get_call_stack has the frames';
            } else if (selection.sp === null) {
                frameNote = `${selection.source} unavailable — read_core_registers`;
            } else {
                try {
                    frame = parseStackedFrame(await this.dbg.readExceptionFrame(selection.sp, timeoutMs));
                    if (!frame) {
                        frameNote = `short read at ${selection.source}`;
                    }
                } catch (caught) {
                    if (caught instanceof ToolError && caught.code === 'PROBE_WEDGED') {
                        throw caught;
                    }
                    skipped.push('exception frame');
                }
            }

            let frames: StackFrame[] = [];
            try {
                frames = await this.dbg.getCallStack(undefined, depth, timeoutMs);
            } catch {
                skipped.push('call stack');
            }

            let device: SvdDevice | null = null;
            let svdNote: string | undefined;
            try {
                device = (await loadSvdForLookup({})).device;
                if (!device) {
                    svdNote = 'no SVD found — addresses are classified by the Cortex-M system map only; '
                        + 'pass svdFile to lookup_peripheral to resolve them';
                }
            } catch {
                svdNote = 'SVD could not be loaded';
            }

            const faultAddress = decoded.faultAddress ? classifyAddress(decoded.faultAddress.value, device) : undefined;
            const faultingPc = frame?.pc ?? regs.pc;
            const pcInfo = faultingPc !== undefined ? classifyAddress(faultingPc, device) : undefined;
            const session = resolveActiveSession();
            const stopReason = session ? getStoppedReason(session) : null;
            const roots = this.workspaceRoots();
            const shortened = frames.map((f) => (f.source ? { ...f, source: shortenPath(f.source, roots) } : f));
            return renderDiagnosis({
                decoded, frame, selection, regs, faultAddress, pcInfo, stopReason,
                frames: shortened, frameNote, skipped, svdNote, maxFrames: depth, lockup,
            });
        });
    }

    // ── SVD lookups (no session needed) ──

    handleLookupPeripheral(args?: PeripheralLookup): Answer {
        return this.fence('lookup_peripheral', args?.timeoutMs, 'error', async () => {
            const loaded = await loadSvdForLookup({ svdFile: args?.svdFile, pname: args?.pname });
            if (!loaded.device) {
                return missingSvdText(loaded.tried);
            }
            const device = loaded.device;
            if (args?.address) {
                const address = parseAddress(args.address);
                if (address === null) {
                    return `'${args.address}' is not an address — pass hex like 0x40005400 or a decimal number.`;
                }
                return renderAddressHit(address, lookupAddress(device, address), device.name);
            }
            if (args?.name) {
                const match = matchName(listPeripheralNames(device), args.name);
                const peripheral = match.exact ? findPeripheral(device, match.exact) : undefined;
                if (!peripheral) {
                    return `Peripheral '${args.name}' is not in the SVD of ${device.name}.${suggestionText(match.suggestions)}\n`
                        + 'Call lookup_peripheral without name for the full list.';
                }
                return renderPeripheral(peripheral, { filter: args.filter });
            }
            return renderPeripheralList(device, { filter: args?.filter });
        });
    }

    handleLookupRegister(args: RegisterLookup): Answer {
        return this.fence('lookup_register', args.timeoutMs, 'error', async () => {
            const loaded = await loadSvdForLookup({ svdFile: args.svdFile, pname: args.pname });
            if (!loaded.device) {
                return missingSvdText(loaded.tried);
            }
            const device = loaded.device;
            const peripheralMatch = matchName(listPeripheralNames(device), args.peripheral ?? '');
            const peripheral = peripheralMatch.exact ? findPeripheral(device, peripheralMatch.exact) : undefined;
            if (!peripheral) {
                return `Peripheral '${args.peripheral}' is not in the SVD of ${device.name}.${suggestionText(peripheralMatch.suggestions)}\n`
                    + 'Call lookup_peripheral without name for the full list.';
            }
            const registerMatch = matchName(peripheral.registers.map((r) => r.name), args.register ?? '');
            const register = registerMatch.exact ? findRegister(peripheral, registerMatch.exact) : undefined;
            if (!register) {
                return `Register '${args.register}' is not in ${peripheral.name}.${suggestionText(registerMatch.suggestions)}\n`
                    + `Call lookup_peripheral { name: '${peripheral.name}' } for its register map.`;
            }
            return renderRegister(peripheral, register);
        });
    }

    // ── stack and threads ──

    handleGetCallStack(args: StackRequest): Answer {
        return this.fence('get_call_stack', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('get call stack');
            const frames = await this.dbg.getCallStack(args.threadId, args.levels ?? 50, args.timeoutMs);
            return renderCallStack(frames, args.levels !== undefined, this.workspaceRoots());
        });
    }

    handleGetThreads(args?: TimeoutArg): Answer {
        return this.fence('get_threads', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('get threads');
            return renderThreads(await this.dbg.getThreads(args?.timeoutMs), this.workspaceRoots());
        });
    }

    // ── CMSIS Solution and pyOCD ──

    /**
     * One deadline for the whole call, up to 600 s (#12); the fence behind it
     * is a backstop. `load`, `erase` and `load_and_run` note a serial port
     * this window holds (#49).
     */
    handleCmsisCommand(args: CmsisRequest): Answer {
        const waitMs = actionTimeoutMs(args.action, args.timeoutMs);
        const run = (): Answer => this.fence('cmsis_action', waitMs, 'reply', () => runCmsisAction({
            executor: this.dbg,
            host: this.host(),
            awaitLiveSession: (overrideMs) => this.awaitLiveSession(overrideMs),
            renderFullState: (state) => this.fullState(state),
        }, args.action, args.target, waitMs, args.path), { capMs: LONG_LIMIT_CAP_MS, advice: CMSIS_FENCE_ADVICE });
        return PROGRAMMING_ACTIONS.has(args.action) ? this.noteHeldSerialPort(run) : run();
    }

    /** `flash`; it notes a serial port this window holds (#49). */
    handleFlash(args: FlashRequest): Answer {
        const waitMs = flashTimeoutMs(args.timeoutMs);
        return this.noteHeldSerialPort(() => this.fence('flash', waitMs, 'reply', () => runFlash(this.dbg, this.host(), args, waitMs),
            { capMs: LONG_LIMIT_CAP_MS, advice: FLASH_FENCE_ADVICE }));
    }
}

/** `Did you mean: A, B?` after a failed name lookup, or nothing. */
function suggestionText(suggestions: string[]): string {
    return suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
}

/** The lookup tools' answer when no device description could be found. */
function missingSvdText(tried: string[]): string {
    const where = tried.length > 0 ? `\nTried:\n  - ${tried.join('\n  - ')}` : '';
    return `No SVD file found for a lookup.${where}\n`
        + 'Pass svdFile (the device .svd from the DFP; ${CMSIS_PACK_ROOT} is expanded), '
        + 'or build the solution so out/<context>.cbuild-run.yml names it, or add "svdFile" to the launch configuration. '
        + 'For a multi-core device pass pname to pick the core.';
}
