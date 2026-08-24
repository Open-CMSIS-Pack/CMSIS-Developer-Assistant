// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as vscode from 'vscode';
import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import { IDebugConfigurationManager } from './utils/debugConfigurationManager';
import { DebugState, formatBreakpointModifiers } from './debugState';
import { IDebuggingExecutor } from './debuggingExecutor';
import { HardwareTimeoutError, withTimeout } from './utils/timeout';
import { fileExists, flashWithPyocd, probePyocd } from './core/flashController';
import { redactExpressionResult, redactVariableValue, REDACTION_NOTICE } from './utils/secretRedaction';
import {
    DapScope,
    formatMissingNames,
    renderScopes,
    renderVariableNames,
    DEFAULT_LISTING_LIMITS,
    DEFAULT_NAME_LISTING_LIMIT,
    selectVariables,
} from './core/variableView';
import { shortenPath, truncateList } from './core/textBudget';
import { getRecentDiagnostics } from './utils/sessionStateTracker';
import { logger } from './utils/logger';

const HARD_HANDLER_CAP_MS = 60_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Wrap a handler body in an absolute deadline. On overshoot the wrapper
 * returns a structured timeout string rather than hanging the MCP call.
 * The underlying work may still be running on the VS Code side — there is
 * no way to cancel a DAP request mid-flight — but the agent regains control.
 */
async function withHandlerTimeout<T extends string>(
    label: string,
    timeoutMs: number | undefined,
    fn: () => Promise<T>,
): Promise<string> {
    const ms = (timeoutMs && timeoutMs > 0)
        ? Math.min(timeoutMs, HARD_HANDLER_CAP_MS)
        : DEFAULT_HANDLER_TIMEOUT_MS;

    let timer: NodeJS.Timeout | undefined;
    const fenced = new Promise<string>((resolve) => {
        timer = setTimeout(() => {
            resolve(`'${label}' did not complete within ${ms} ms (handler-level cap). ` +
                `The DAP probe or target may be unresponsive — call get_session_status / ` +
                `check_target_connection to confirm. Note: the underlying request may still ` +
                `be running on the server; consider restart_debugging if subsequent calls also stall.`);
        }, ms);
    });

    const work = fn().catch((err) => {
        // Surface failures as text so the race always yields a string.
        return `Error in '${label}': ${err instanceof Error ? err.message : String(err)}`;
    });

    try {
        return await Promise.race([work, fenced]);
    } finally {
        if (timer) { clearTimeout(timer); }
    }
}

/**
 * Interface for debugging handler operations
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string; timeoutMs?: number }): Promise<string>;
    handleStopDebugging(): Promise<string>;
    handleStepOver(args?: { timeoutMs?: number }): Promise<string>;
    handleStepInto(args?: { timeoutMs?: number }): Promise<string>;
    handleStepOut(args?: { timeoutMs?: number }): Promise<string>;
    handleContinue(args?: { timeoutMs?: number }): Promise<string>;
    handlePause(args?: { timeoutMs?: number }): Promise<string>;
    handleWaitForStop(args?: { timeoutMs?: number }): Promise<string>;
    handleRestart(args?: { timeoutMs?: number }): Promise<string>;
    handleReset(args: { method?: 'auto' | 'system' | 'core' | 'hardware'; halt?: boolean; timeoutMs?: number }): Promise<string>;
    handleAddBreakpoint(args: { fileFullPath: string; line?: number; condition?: string; lineContent?: string }): Promise<string>;
    handleAddLogpoint(args: { fileFullPath: string; line: number; logMessage: string; condition?: string }): Promise<string>;
    handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string>;
    handleClearAllBreakpoints(): Promise<string>;
    handleListBreakpoints(): Promise<string>;
    handleListVariableNames(args: { scope?: 'local' | 'global' | 'all'; timeoutMs?: number }): Promise<string>;
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all'; variableNames?: string[]; timeoutMs?: number }): Promise<string>;
    handleEvaluateExpression(args: { expression: string; timeoutMs?: number }): Promise<string>;
    handleReadMemory(args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }): Promise<string>;
    handleReadCoreRegisters(args?: { timeoutMs?: number }): Promise<string>;
    handleReadCycleCounter(args?: { timeoutMs?: number }): Promise<string>;
    handleReadPeripheralRegister(args: { peripheral: string; register?: string; timeoutMs?: number }): Promise<string>;
    handleGetFaultInfo(args?: { timeoutMs?: number }): Promise<string>;
    handleGetDeviceInfo(): Promise<string>;
    handleCheckTargetConnection(): Promise<string>;
    handleGetSessionStatus(): Promise<string>;
    handleGetCallStack(args: { threadId?: number; levels?: number; timeoutMs?: number }): Promise<string>;
    handleGetThreads(args?: { timeoutMs?: number }): Promise<string>;
    handleGetFrameVariables(args: { frameId: number; scope?: 'local' | 'global' | 'all'; variableNames?: string[]; timeoutMs?: number }): Promise<string>;
    handleCmsisCommand(args: { action: CmsisAction; timeoutMs?: number }): Promise<string>;
    handleFlash(args: { cbuildRunFile?: string; timeoutMs?: number }): Promise<string>;
}

export type CmsisAction =
    | 'build'
    | 'load'
    | 'erase'
    | 'load_and_run'
    | 'load_and_debug'
    | 'attach'
    | 'detach'
    | 'stop_run';

/**
 * Handles debugging operations using the executor and configuration manager
 */
export class DebuggingHandler implements IDebuggingHandler {
    private readonly numNextLines: number = 3;

    /**
     * The breakpoint list as last reported in a state snapshot. Motion tools
     * repeat it only when it changed; otherwise the compact state carries a
     * count. One per handler, i.e. per window — two agents on one window see
     * each other's "unchanged", which is harmless (the list is a call away).
     */
    private lastEmittedBreakpoints: string | null = null;

    /** Frames shown inline by get_call_stack when the caller did not ask for a depth. */
    private static readonly CALL_STACK_INLINE_FRAMES = 20;

    /** Threads shown inline by get_threads. */
    private static readonly THREADS_INLINE = 32;

    /** Full state, as when a session comes up; also seeds the breakpoint diff. */
    private fullState(state: DebugState): string {
        this.lastEmittedBreakpoints = state.breakpoints.join('\n');
        return state.toString();
    }

    /** Compact state for motion tools; the breakpoint list only when it changed. */
    private compactState(state: DebugState): string {
        const key = state.breakpoints.join('\n');
        const changed = key !== this.lastEmittedBreakpoints;
        this.lastEmittedBreakpoints = key;
        return state.toCompactString({ includeBreakpoints: changed });
    }

    /** Workspace roots, for shortening source paths in listings. */
    private workspaceRoots(): string[] {
        return vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
    }
    private readonly executionDelay: number = 300; // ms to wait for debugger updates
    private readonly timeoutInSeconds: number;

    constructor(
        private readonly executor: IDebuggingExecutor,
        private readonly configManager: IDebugConfigurationManager,
        timeoutInSeconds: number
    ) {
        this.timeoutInSeconds = timeoutInSeconds;
    }

    /**
     * The redaction callback to hand to the variable renderer, or undefined
     * when redaction is off.
     *
     * Read per call rather than cached at construction so toggling the setting
     * takes effect without a window reload. Only the *symbolic* paths are
     * gated: read_memory, read_core_registers, read_peripheral_register and
     * get_fault_info deliberately never pass through here. Those return raw
     * target state, and several SVDs name real registers KEY, KR or UNLOCK
     * (watchdog and flash-controller unlock registers) — withholding them
     * would break exactly the debugging they exist for, and a memory-mapped
     * register is not a credential.
     */
    private redactor(): ((name: string, value: string) => { value: string; redacted: boolean }) | undefined {
        const enabled = vscode.workspace
            .getConfiguration('cmsis-developer-assistant')
            .get<boolean>('redactSecrets', true);
        if (!enabled) { return undefined; }
        return (name, value) => redactVariableValue(name, value);
    }

    /**
     * Recent adapter-originated traffic (failed DAP responses, adapter
     * stderr/console output) as an error-message suffix, or '' when the
     * buffer is empty. Launch failures otherwise surface only as one nested
     * message line while the real cause sits in the extension-host log.
     */
    private diagnosticsSuffix(): string {
        const diag = getRecentDiagnostics();
        if (diag.length === 0) { return ''; }
        return `\nRecent adapter traffic (last ${diag.length} lines):\n  ${diag.join('\n  ')}`;
    }

    /**
     * Start a debugging session
     */
    public async handleStartDebugging(args: {
        fileFullPath?: string;
        workingDirectory: string;
        testName?: string;
        configurationName?: string;
        timeoutMs?: number;
    }): Promise<string> {
        const { fileFullPath, workingDirectory, testName, configurationName } = args;

        // Pre-check: refuse to start a second session on top of an active one.
        // Otherwise we end up with two debug sessions racing and the MCP tools
        // become unpredictable. The agent should explicitly stop or restart.
        if (this.executor.hasDebugSession()) {
            const status = await this.executor.getSessionStatus();
            return `A debug session is already active (name='${status.sessionName ?? '?'}', ` +
                `state=${status.state}). Refusing to start a second session. ` +
                `Use stop_debugging first, or call restart_debugging to reuse the current session, ` +
                `or proceed directly with inspection tools (get_variables_values, read_memory, …).`;
        }

        try {
            let selectedConfigName = configurationName ?? await this.configManager.promptForConfiguration(workingDirectory);
            
            // For named configurations (e.g. gdbtarget/CMSIS), pass the name directly
            // to vscode.debug.startDebugging without requiring fileFullPath
            if (selectedConfigName && selectedConfigName !== 'Default Configuration') {
                const started = await this.executor.startDebuggingByName(workingDirectory, selectedConfigName);
                if (started) {
                    const sessionActive = await this.waitForActiveDebugSession();
                    if (!sessionActive) {
                        throw new Error('Debug session started but failed to become active within timeout period');
                    }
                    const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
                    const target = fileFullPath || selectedConfigName;
                    return `Debug session started successfully for: ${target} using configuration '${selectedConfigName}'. Current state: ${this.fullState(currentState)}`;
                } else {
                    throw new Error(`Failed to start debug session with configuration '${selectedConfigName}'.`);
                }
            }

            if (!fileFullPath) {
                throw new Error('fileFullPath is required when no named configuration is provided.');
            }

            // Get debug configuration from launch.json or create default
            const debugConfig = await this.configManager.getDebugConfig(
                workingDirectory, 
                fileFullPath, 
                selectedConfigName,
                testName
            );

            const started = await this.executor.startDebugging(workingDirectory, debugConfig);
            if (started) {
                // Wait for debug session to become active using exponential backoff
                const sessionActive = await this.waitForActiveDebugSession();
                
                if (!sessionActive) {
                    throw new Error('Debug session started but failed to become active within timeout period');
                }
                
                // return also the current state
                const configInfo = selectedConfigName ? ` using configuration '${selectedConfigName}'` : ' with default configuration';
                const testInfo = testName ? ` (test: ${testName})` : '';
                const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
                return `Debug session started successfully for: ${fileFullPath}${configInfo}${testInfo}. Current state: ${this.fullState(currentState)}`;
            } else {
                throw new Error('Failed to start debug session. Make sure the appropriate language extension is installed.');
            }
        } catch (error) {
            throw new Error(`Error starting debug session: ${error}${this.diagnosticsSuffix()}`);
        }
    }

    /**
     * Stop the current debugging session
     */
    public async handleStopDebugging(): Promise<string> {
        try {
            // Use the synchronous session-existence check rather than the
            // stopped-state gate: stop_debugging must work even when the
            // target is currently running or the probe is unresponsive.
            if (!this.executor.hasDebugSession()) {
                return 'No active debug session to stop';
            }

            await this.executor.stopDebugging();

            // Add drill-down reminder
            return 'Debug session stopped successfully\n\n' + this.getRootCauseAnalysisCheckpointMessage();
        } catch (error) {
            throw new Error(`Error stopping debug session: ${error}`);
        }
    }

    /**
     * Clear all breakpoints
     */
    public async handleClearAllBreakpoints(): Promise<string> {
        try {
            const breakpointCount = this.executor.getBreakpoints().length;

            // Clear the VS Code model.
            this.executor.clearAllBreakpoints();

            // Also delete GDB-native breakpoints (those set via `-exec break`)
            // — otherwise the target keeps stopping at breakpoints the model
            // no longer lists. The adapter rarely echoes anything useful for
            // `delete`; a quiet reply is success, not a failure.
            let gdbNote = '';
            if (this.executor.hasDebugSession()) {
                const reply = await this.executor.clearAllBreakpointsViaGdb();
                // GDB `delete` is silent on success; only echo the reply when
                // it carries a real GDB message, not a harmless adapter quirk.
                gdbNote = /Deleted|Breakpoint|No source|No symbol/i.test(reply)
                    ? `\nGDB \`delete\` issued — ${reply}`
                    : `\nGDB \`delete\` issued — all GDB-native breakpoints removed.`;
            }

            if (breakpointCount === 0 && !gdbNote) {
                return 'No breakpoints to clear';
            }
            return `Cleared ${breakpointCount} breakpoint(s) from the model.${gdbNote}`;
        } catch (error) {
            throw new Error(`Error clearing breakpoints: ${error}`);
        }
    }

    /**
     * Throw an actionable error if the session is not in a state where
     * inspection/step/continue is valid. Replaces the historical vague
     * "Debug session is not ready" message with something that tells the
     * agent exactly which of the five session states it is in and what to
     * do next — and points it at `get_session_status` for confirmation.
     */
    private async ensureStoppedSession(operation: string): Promise<void> {
        if (await this.executor.hasActiveSession()) {
            return;
        }
        const status = await this.executor.getSessionStatus();
        let hint: string;
        switch (status.state) {
            case 'no-session':
                hint = 'No active debug session. Call start_debugging first.';
                break;
            case 'initializing':
                hint = 'The debug adapter is still starting. Wait briefly and retry; the session has not torn down.';
                break;
            case 'running':
                hint = 'The target is currently running. Add a breakpoint or wait for the previous continue/step to stop before issuing another inspection or step command.';
                break;
            case 'unresponsive':
                hint = 'The probe/GDB server is unresponsive. Call check_target_connection to confirm, then restart_debugging or stop_debugging.';
                break;
            case 'stopped':
                // Race: status flipped between the gate and the status query.
                hint = 'Session reports stopped — please retry the operation.';
                break;
        }
        throw new Error(
            `Cannot ${operation}: session state is '${status.state}'. ${hint} ` +
            `Use get_session_status for a definitive, never-failing classification.`
        );
    }

    /**
     * Execute step over command(s)
     */
    public async handleStepOver(args?: { timeoutMs?: number }): Promise<string> {
        try {
            await this.ensureStoppedSession('step over');
            await this.executor.stepOver(args?.timeoutMs);
            const result = await this.waitForTargetStopped(args?.timeoutMs);
            return await this.formatAfterExecutionWithHeal(result, 'step_over');
        } catch (error) {
            throw new Error(`Error executing step over: ${error}`);
        }
    }

    /**
     * Execute step into command
     */
    public async handleStepInto(args?: { timeoutMs?: number }): Promise<string> {
        try {
            await this.ensureStoppedSession('step into');
            await this.executor.stepInto(args?.timeoutMs);
            const result = await this.waitForTargetStopped(args?.timeoutMs);
            return await this.formatAfterExecutionWithHeal(result, 'step_into');
        } catch (error) {
            throw new Error(`Error executing step into: ${error}`);
        }
    }

    /**
     * Execute step out command
     */
    public async handleStepOut(args?: { timeoutMs?: number }): Promise<string> {
        try {
            await this.ensureStoppedSession('step out');
            await this.executor.stepOut(args?.timeoutMs);
            const result = await this.waitForTargetStopped(args?.timeoutMs);
            return await this.formatAfterExecutionWithHeal(result, 'step_out');
        } catch (error) {
            throw new Error(`Error executing step out: ${error}`);
        }
    }

    /**
     * Continue execution
     */
    public async handleContinue(args?: { timeoutMs?: number }): Promise<string> {
        try {
            await this.ensureStoppedSession('continue execution');
            await this.executor.continue(args?.timeoutMs);
            const result = await this.waitForTargetStopped(args?.timeoutMs);
            return await this.formatAfterExecutionWithHeal(result, 'continue_execution');
        } catch (error) {
            throw new Error(`Error executing continue: ${error}`);
        }
    }

    /**
     * Wrapper around formatAfterExecution that adds an automatic recovery
     * step on timeout: pause the running target, then report where its PC
     * actually is. Saves the agent a round-trip when the breakpoint wasn't hit.
     */
    private async formatAfterExecutionWithHeal(
        result: { state: DebugState; timedOut: boolean; sessionEnded: boolean },
        op: string
    ): Promise<string> {
        const base = this.formatAfterExecution(result, op);
        if (!result.timedOut || result.sessionEnded) {
            return base;
        }
        const recovery = await this.attemptRecoveryAfterTimeout(op);
        return `${base}${recovery}`;
    }

    /**
     * Pause a running target. Use this when you want to inspect state but
     * the target is currently executing (and DAP reads would be rejected).
     * No-op when the target is already stopped.
     */
    public async handlePause(args?: { timeoutMs?: number }): Promise<string> {
        if (!this.executor.hasDebugSession()) {
            throw new Error('No active debug session. Start debugging first.');
        }
        const status = await this.executor.getSessionStatus();
        if (status.state === 'stopped') {
            return `Target is already stopped (reason: ${status.detail ?? 'n/a'}). No pause needed — proceed with inspection tools.`;
        }
        if (status.state === 'unresponsive') {
            return `Cannot pause: probe/GDB server is unresponsive. Call check_target_connection or restart_debugging.`;
        }
        if (status.state === 'no-session') {
            throw new Error('No active debug session.');
        }
        if (status.state === 'initializing') {
            return `Cannot pause yet: session is still initializing. Wait briefly and retry.`;
        }

        // state === 'running' — issue the pause and wait for stop
        await this.executor.pause(args?.timeoutMs);
        const result = await this.waitForTargetStopped(args?.timeoutMs);
        if (result.timedOut) {
            return `Pause requested but target did not stop within the timeout. ` +
                `Probe may be unresponsive — call get_session_status / check_target_connection.`;
        }
        if (result.sessionEnded) {
            return `Pause requested but the debug session ended. The target may have crashed.`;
        }
        return `Target paused. ${this.compactState(result.state)}`;
    }

    /**
     * Block until the target next stops (breakpoint, fault, step-complete,
     * pause) and return the stop reason plus the current debug state, or a
     * structured timeout. Use after continue_execution returned while the
     * target was still running, after issuing execution through
     * evaluate_expression ("-exec continue"), or to catch the first
     * breakpoint of a free-running session — this replaces blind sleeping.
     * Issues no execution commands itself.
     */
    public async handleWaitForStop(args?: { timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('wait_for_stop', args?.timeoutMs, async () => {
            if (!this.executor.hasDebugSession()) {
                throw new Error('No active debug session. Start debugging first — wait_for_stop waits on a live session.');
            }
            // Leave a margin under the handler fence so the structured
            // timeout text wins over the generic fence message when both
            // would fire at the same deadline.
            const budget = args?.timeoutMs ? Math.max(args.timeoutMs - 1_500, 100) : 28_500;
            const result = await this.executor.waitForStop(budget);
            if (result.kind === 'timeout') {
                return 'Target did not stop within the timeout — it is still running (or the probe is unresponsive). ' +
                    'Options: call wait_for_stop again with a larger timeoutMs, pause_execution to see where it is, ' +
                    'or check_target_connection if other calls are also stalling.';
            }
            if (result.kind === 'ended') {
                return 'The debug session ended while waiting for a stop — the target may have crashed, the probe ' +
                    'disconnected, or the session was stopped in the UI. Call get_session_status to confirm.';
            }
            // Let VS Code surface the new frame before snapshotting (same
            // settle delay waitForTargetStopped uses).
            await new Promise(resolve => setTimeout(resolve, this.executionDelay));
            const state = await this.executor.getCurrentDebugState(this.numNextLines);
            const threadInfo = result.kind === 'stopped' && result.threadId !== null ? `, threadId=${result.threadId}` : '';
            const head = result.kind === 'already-stopped'
                ? `Target was already stopped (reason: ${result.reason ?? 'unknown'}).`
                : `Target stopped (reason: ${result.reason ?? 'unknown'}${threadInfo}).`;
            return `${head}\n\n${this.compactState(state)}`;
        });
    }

    /**
     * Restart the debugging session
     */
    public async handleRestart(_args?: { timeoutMs?: number }): Promise<string> {
        try {
            if (!this.executor.hasDebugSession()) {
                throw new Error('No active debug session to restart');
            }

            await this.executor.restart();

            // Wait for the debug session to become active again after restart.
            // The probe may take several seconds to reprogram/reset the target;
            // the fixed 300ms delay we previously used was far too optimistic
            // for embedded hardware and frequently returned before the session
            // was usable, causing the very next tool call to fail.
            const sessionActive = await this.waitForActiveDebugSession();
            if (!sessionActive) {
                throw new Error(
                    'Debug session restart issued but target did not become ready within the ' +
                    `${this.timeoutInSeconds}s timeout. The probe or target may be unresponsive.`
                );
            }

            return 'Debug session restarted successfully';
        } catch (error) {
            throw new Error(`Error restarting debug session: ${error}`);
        }
    }

    /**
     * Reset the target inside the live session and verify the reset took
     * effect (PC compared against the reset vector). Unlike restart_debugging
     * the debug session and its breakpoints survive. Reports honestly when
     * the target did not appear to reset — silent non-resets are common on
     * attach configurations.
     */
    public async handleReset(args: { method?: 'auto' | 'system' | 'core' | 'hardware'; halt?: boolean; timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('reset', args?.timeoutMs, async () => {
            if (!this.executor.hasDebugSession()) {
                throw new Error('No active debug session. Start debugging first — reset drives the target through the live probe.');
            }
            const outcome = await this.executor.resetTarget({
                method: args?.method ?? 'auto',
                halt: args?.halt,
                timeoutMs: args?.timeoutMs,
            });
            const commandsLine = outcome.commandsIssued.length > 0
                ? ` Commands: ${outcome.commandsIssued.map(c => `'${c}'`).join(', ')} (server: ${outcome.serverKind}).`
                : '';
            if (outcome.verified) {
                const next = args?.halt === false
                    ? ' Target resumed (halt=false).'
                    : ' Target is halted at the reset vector — use continue_execution to run.';
                return `Target reset verified. ${outcome.verificationDetail}. ` +
                    `Method(s) tried: ${outcome.methodsTried.join(', ')}.${commandsLine}${next}`;
            }
            return `⚠️ Reset was issued but the target does NOT appear to have reset. ${outcome.verificationDetail}. ` +
                `Method(s) tried: ${outcome.methodsTried.join(', ')}.${commandsLine} ` +
                `'hardware' requires nSRST wired from probe to target — if it is not connected, no software reset can ` +
                `recover this; power-cycle the board or reconnect the probe. ` +
                `Adapter replies: ${outcome.replies.join(' | ') || '<none>'}`;
        });
    }

    /**
     * Add a breakpoint at specified location
     */
    /**
     * Classify the raw text returned by a GDB `break`/`clear`/`delete` issued
     * through the DAP evaluate REPL. The adapter often returns nothing useful
     * even when the command succeeded, so:
     *   - 'bound'       — GDB echoed "Breakpoint N at 0x…": definitely set.
     *   - 'rejected'    — a definite GDB rejection (bad path / unknown symbol).
     *   - 'unconfirmed' — empty / generic adapter error: command very likely
     *                     ran (side effect happened), just no usable echo.
     * Only 'rejected' warrants a warning.
     */
    private static classifyGdbBreakpointReply(raw: string): 'bound' | 'rejected' | 'unconfirmed' {
        const t = (raw ?? '').trim();
        if (/Breakpoint\s+\d+\s+at\s+0x/i.test(t) || /Breakpoint\s+\d+\s+at/i.test(t)) {
            return 'bound';
        }
        if (/No source file named|No line\s+\d+\s+in|No symbol|Function\s+"[^"]*"\s+not defined|No such file|cannot be inserted|No default breakpoint address/i.test(t)) {
            return 'rejected';
        }
        return 'unconfirmed';
    }

    /**
     * Resolve the target line(s) for a breakpoint request.
     *
     * `line` is the supported form. `lineContent` is the deprecated original
     * form kept so existing agent prompts keep working: it substring-matches
     * every line in the file, which in C routinely matches dozens of lines
     * (`}`, `return;`, `break;`) and silently sets a breakpoint on all of them.
     */
    private static async resolveBreakpointLines(
        fileFullPath: string,
        line?: number,
        lineContent?: string,
    ): Promise<{ lines: number[]; usedFallback: boolean }> {
        if (typeof line === 'number') {
            if (!Number.isInteger(line) || line < 1) {
                throw new Error(`Invalid line number ${line}: must be a 1-based integer.`);
            }
            return { lines: [line], usedFallback: false };
        }

        if (!lineContent) {
            throw new Error(
                'No location given: pass `line` (1-based line number). ' +
                'The legacy `lineContent` form is still accepted but deprecated.',
            );
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath));
        const lines = document.getText().split(/\r?\n/);
        const matching: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(lineContent)) {
                matching.push(i + 1); // 1-based
            }
        }
        if (matching.length === 0) {
            throw new Error(`Could not find any lines containing: ${lineContent}`);
        }
        return { lines: matching, usedFallback: true };
    }

    /**
     * Translate a VS Code logpoint message into a GDB `dprintf` format string
     * plus its argument list.
     *
     * VS Code interpolates `{expr}` and infers the rendering from the runtime
     * type. GDB's `printf` has no such inference — it needs an explicit
     * conversion specifier per argument, and picking the wrong one prints
     * garbage rather than erroring. So:
     *
     *   - `{expr}`      → `%d`   (the overwhelmingly common embedded case)
     *   - `{expr:%s}`   → `%s`   (explicit specifier wins; use for strings,
     *                             `%f` for floats, `%p` for pointers, ...)
     *   - `{{` / `}}`   → literal `{` / `}`
     *
     * A literal `%` in the message is escaped to `%%` so it survives printf.
     */
    public static translateLogMessage(logMessage: string): { format: string; args: string[] } {
        const SPECIFIER = /^(.*):(%[-+ #0-9.]*(?:hh|h|ll|l|z|j|t|L)?[diouxXeEfgGaAcsp])$/;
        const args: string[] = [];
        let format = '';

        for (let i = 0; i < logMessage.length; i++) {
            const ch = logMessage[i];

            if ((ch === '{' || ch === '}') && logMessage[i + 1] === ch) {
                format += ch; // doubled brace → literal brace
                i++;
                continue;
            }

            if (ch === '{') {
                const close = logMessage.indexOf('}', i + 1);
                if (close === -1) {
                    throw new Error(
                        `Unbalanced '{' in logMessage at position ${i}. ` +
                        'Use {{ for a literal brace.',
                    );
                }
                const inner = logMessage.slice(i + 1, close).trim();
                if (!inner) {
                    throw new Error(`Empty interpolation '{}' in logMessage at position ${i}.`);
                }
                const withSpec = SPECIFIER.exec(inner);
                if (withSpec) {
                    format += withSpec[2];
                    args.push(withSpec[1].trim());
                } else {
                    format += '%d';
                    args.push(inner);
                }
                i = close;
                continue;
            }

            if (ch === '}') {
                throw new Error(
                    `Unbalanced '}' in logMessage at position ${i}. Use }} for a literal brace.`,
                );
            }

            // Escape for both the GDB command string and printf itself.
            if (ch === '%') { format += '%%'; }
            else if (ch === '"') { format += '\\"'; }
            else if (ch === '\\') { format += '\\\\'; }
            else if (ch === '\n') { format += '\\n'; }
            else { format += ch; }
        }

        return { format: `${format}\\n`, args };
    }

    /** Pull the breakpoint number out of a GDB `Dprintf N at 0x...` echo. */
    private static parseGdbBreakpointNumber(raw: string): number | null {
        const m = /(?:Dprintf|Breakpoint)\s+(\d+)\s+at/i.exec(raw ?? '');
        return m ? Number(m[1]) : null;
    }

    public async handleAddLogpoint(args: {
        fileFullPath: string;
        line: number;
        logMessage: string;
        condition?: string;
    }): Promise<string> {
        const { fileFullPath, line, logMessage, condition } = args;

        try {
            if (!Number.isInteger(line) || line < 1) {
                throw new Error(`Invalid line number ${line}: must be a 1-based integer.`);
            }

            const { format, args: printfArgs } = DebuggingHandler.translateLogMessage(logMessage);
            const uri = vscode.Uri.file(fileFullPath);

            // 1) VS Code model, so the logpoint shows in the gutter and in
            //    list_breakpoints like any other breakpoint.
            await this.executor.addBreakpoint(uri, line, { condition, logMessage });

            if (!this.executor.hasDebugSession()) {
                return `Logpoint added at ${fileFullPath}:${line}\n` +
                    `(No debug session yet — added to the breakpoint list. Re-add after the session is up ` +
                    `so it is bound GDB-native via \`dprintf\`.)`;
            }

            // 2) GDB-native `dprintf` — the path that actually fires on gdbtarget.
            const reply = await this.executor.setLogpointViaGdb(fileFullPath, line, format, printfArgs);
            const cls = DebuggingHandler.classifyGdbBreakpointReply(reply);

            const lines: string[] = [];
            lines.push(`Logpoint added at ${fileFullPath}:${line}`);
            lines.push(`  GDB: dprintf ${fileFullPath}:${line},"${format}"${printfArgs.length ? ',' + printfArgs.join(',') : ''}`);

            if (cls === 'rejected') {
                lines.push(`⚠️ GDB rejected the logpoint: ${reply}`);
                lines.push(
                    'Check that the path matches the ELF\'s compiled paths, and that every interpolated ' +
                    'expression is in scope at that line.',
                );
                return lines.join('\n');
            }

            if (condition) {
                // `dprintf` takes no inline `if` clause — the condition has to be
                // attached by breakpoint number afterwards.
                const bpNum = DebuggingHandler.parseGdbBreakpointNumber(reply);
                if (bpNum !== null) {
                    const condReply = await this.executor.setBreakpointConditionViaGdb(bpNum, condition);
                    lines.push(`  Condition applied to GDB breakpoint ${bpNum}: ${condition}` +
                        (condReply ? ` — ${condReply}` : ''));
                } else {
                    lines.push(
                        `⚠️ Condition "${condition}" was set on the VS Code breakpoint but NOT on the GDB ` +
                        `dprintf: the adapter did not echo a breakpoint number to attach it to. The logpoint ` +
                        `will fire unconditionally. Apply it manually with ` +
                        `evaluate_expression("-exec condition <n> ${condition}") after finding <n> via ` +
                        `evaluate_expression("-exec info breakpoints").`,
                    );
                }
            }

            lines.push(
                '\nℹ️ On Cortex-M a logpoint is not free: the core halts on every hit while GDB formats and ' +
                'prints, then resumes. In a hot loop or an ISR this distorts timing far more than it would in ' +
                'a host process. For high-rate tracing prefer read_cycle_counter around the region, or have ' +
                'the firmware fill a RAM buffer you read with read_memory.',
            );
            return lines.join('\n');
        } catch (error) {
            throw new Error(`Error adding logpoint: ${error}`);
        }
    }

    public async handleAddBreakpoint(args: {
        fileFullPath: string;
        line?: number;
        condition?: string;
        lineContent?: string;
    }): Promise<string> {
        const { fileFullPath, line, condition, lineContent } = args;

        try {
            const { lines: targetLines, usedFallback } =
                await DebuggingHandler.resolveBreakpointLines(fileFullPath, line, lineContent);

            const uri = vscode.Uri.file(fileFullPath);

            // 1) Add to VS Code's breakpoint model — keeps list_breakpoints and
            //    the editor gutter in sync.
            for (const lineNumber of targetLines) {
                await this.executor.addBreakpoint(uri, lineNumber, { condition });
            }

            // 2) Bind GDB-native via `-exec break`. On gdbtarget sessions the
            //    VS Code model's setBreakpoints request is not reliably
            //    forwarded to the adapter, so the model add alone leaves the
            //    target running straight through. The GDB break makes it bind
            //    for real — this is what actually stops the CPU. The condition
            //    rides along as GDB's native `if` clause so the core is not
            //    halted on every hit.
            const gdbReplies: string[] = [];
            let anyRejected = false;
            let anyConfirmed = false;
            if (this.executor.hasDebugSession()) {
                for (const lineNumber of targetLines) {
                    const reply = await this.executor.setBreakpointViaGdb(
                        fileFullPath, lineNumber, undefined, condition,
                    );
                    const cls = DebuggingHandler.classifyGdbBreakpointReply(reply);
                    if (cls === 'rejected') { anyRejected = true; }
                    if (cls === 'bound') { anyConfirmed = true; }
                    // Only echo the raw text when it is meaningful (a real
                    // binding or a real rejection). For 'unconfirmed' the text
                    // is just a harmless adapter quirk ("could not evaluate
                    // expression") — don't surface it, it reads like an error.
                    const shown = cls === 'unconfirmed' ? '<no echo from adapter — normal>' : reply;
                    gdbReplies.push(`line ${lineNumber}: ${shown} [${cls}]`);
                }
            }

            const condSuffix = condition ? ` [when: ${condition}]` : '';
            const locList = targetLines.join(', ');
            let head = targetLines.length === 1
                ? `Breakpoint added at ${fileFullPath}:${targetLines[0]}${condSuffix}`
                : `Breakpoints added at ${targetLines.length} locations in ${fileFullPath}: lines ${locList}${condSuffix}`;

            if (usedFallback) {
                head += `\n⚠️ Located via the deprecated \`lineContent\` match (${targetLines.length} line(s) matched). ` +
                    `Pass \`line\` instead — content matching hits every line containing the text.`;
            }

            if (!this.executor.hasDebugSession()) {
                return `${head}\n(No debug session yet — added to the breakpoint list. ` +
                    `It will be GDB-bound when you add it again after the session is up, or re-add after attach.)`;
            }
            if (anyRejected) {
                return `${head}\n⚠️ GDB rejected one or more breakpoints:\n  ${gdbReplies.join('\n  ')}\n` +
                    `"No source file" / "No line" means the path does not match the ELF's compiled paths — ` +
                    `try the path as the compiler saw it, or set by function name via evaluate_expression ("-exec break <function>").`;
            }
            if (anyConfirmed) {
                return `${head}\nGDB confirmed binding:\n  ${gdbReplies.join('\n  ')}`;
            }
            // No explicit GDB echo — normal for gdbtarget adapters, NOT a failure.
            return `${head}\nSent to GDB (\`break\`). The adapter did not echo a confirmation — this is ` +
                `normal for gdbtarget and does NOT mean it failed. The breakpoint is set; verify by running ` +
                `continue_execution (the target should stop) or list_breakpoints.\n  ${gdbReplies.join('\n  ')}`;
        } catch (error) {
            throw new Error(`Error adding breakpoint: ${error}`);
        }
    }

    /**
     * Remove a breakpoint from specified location
     */
    public async handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string> {
        const { fileFullPath, line } = args;
        
        try {
            const uri = vscode.Uri.file(fileFullPath);
            
            // Check if breakpoint exists at this location
            const breakpoints = this.executor.getBreakpoints();
            const existingBreakpoint = breakpoints.find(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    return bp.location.uri.toString() === uri.toString() && 
                           bp.location.range.start.line === line - 1;
                }
                return false;
            });
            
            if (!existingBreakpoint) {
                return `No breakpoint found at ${fileFullPath}:${line}`;
            }

            await this.executor.removeBreakpoint(uri, line);

            // Also clear the GDB-native breakpoint at this file:line. A quiet
            // adapter reply is success — `clear` rarely echoes anything.
            let gdbNote = '';
            if (this.executor.hasDebugSession()) {
                const reply = await this.executor.clearBreakpointViaGdb(fileFullPath, line);
                gdbNote = /Deleted|Breakpoint|No source|No symbol/i.test(reply)
                    ? `\nGDB \`clear ${fileFullPath}:${line}\` issued — ${reply}`
                    : `\nGDB \`clear ${fileFullPath}:${line}\` issued.`;
            }
            return `Breakpoint removed from ${fileFullPath}:${line}${gdbNote}`;
        } catch (error) {
            throw new Error(`Error removing breakpoint: ${error}`);
        }
    }

    /**
     * List all active breakpoints
     */
    public async handleListBreakpoints(): Promise<string> {
        try {
            const breakpoints = this.executor.getBreakpoints();
            
            if (breakpoints.length === 0) {
                return 'No breakpoints currently set';
            }

            let breakpointList = 'Active Breakpoints:\n';
            breakpoints.forEach((bp, index) => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop();
                    const line = bp.location.range.start.line + 1;
                    breakpointList += `${index + 1}. ${fileName}:${line}${formatBreakpointModifiers(bp)}\n`;
                } else if (bp instanceof vscode.FunctionBreakpoint) {
                    breakpointList += `${index + 1}. Function: ${bp.functionName}${formatBreakpointModifiers(bp)}\n`;
                }
            });

            return breakpointList;
        } catch (error) {
            throw new Error(`Error listing breakpoints: ${error}`);
        }
    }

    /**
     * Get variables from current debug context
     */
    /**
     * Read the scopes at the active frame, applying the 'global'-scope fallback
     * that several adapters need. Shared by get_variables_values and
     * list_variable_names so they can never disagree about what is in scope.
     */
    private async readActiveFrameScopes(
        scope: 'local' | 'global' | 'all',
        timeoutMs?: number,
    ): Promise<{ scopes: DapScope[]; globalFallback: boolean }> {
        const activeStackItem = vscode.debug.activeStackItem;
        if (!activeStackItem || !('frameId' in activeStackItem)) {
            throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
        }

        let variablesData = await this.executor.getVariables(activeStackItem.frameId, scope, timeoutMs);

        // If 'global' scope was requested but not available, fall back to all scopes.
        let globalFallback = false;
        if (scope === 'global' && (!variablesData.scopes || variablesData.scopes.length === 0)) {
            variablesData = await this.executor.getVariables(activeStackItem.frameId, 'all', timeoutMs);
            globalFallback = true;
        }

        return { scopes: (variablesData.scopes ?? []) as DapScope[], globalFallback };
    }

    public async handleListVariableNames(args: { scope?: 'local' | 'global' | 'all'; timeoutMs?: number }): Promise<string> {
        const { scope = 'all', timeoutMs } = args;

        return withHandlerTimeout('list_variable_names', timeoutMs, async () => {
            await this.ensureStoppedSession('list variable names');
            const { scopes } = await this.readActiveFrameScopes(scope, timeoutMs);
            if (scopes.length === 0) {
                return 'No variable scopes available at current execution point.';
            }
            return renderVariableNames(scopes, { maxVariables: DEFAULT_NAME_LISTING_LIMIT });
        });
    }

    public async handleGetVariables(args: {
        scope?: 'local' | 'global' | 'all';
        variableNames?: string[];
        timeoutMs?: number;
    }): Promise<string> {
        const { scope = 'all', variableNames, timeoutMs } = args;

        return withHandlerTimeout('get_variables_values', timeoutMs, async () => {
            await this.ensureStoppedSession('read variables');

            const { scopes, globalFallback } = await this.readActiveFrameScopes(scope, timeoutMs);
            if (scopes.length === 0) {
                return 'No variable scopes available at current execution point.';
            }

            const { scopes: selected, missing } = variableNames?.length
                ? selectVariables(scopes, variableNames)
                : { scopes, missing: [] as string[] };

            let out = '';
            if (globalFallback) {
                out += 'Note: No dedicated "Global" scope is available from this debug adapter. Showing all available scopes instead. Use evaluate_expression to inspect specific global variables by name.\n\n';
            }

            if (variableNames?.length && selected.length === 0) {
                return out + `None of the requested variables are in scope: ${variableNames.join(', ')}.\n` +
                    'Call list_variable_names to see what is available here.';
            }

            out += renderScopes(selected, {
                header: 'Variables',
                redact: this.redactor(),
                limits: variableNames?.length ? undefined : DEFAULT_LISTING_LIMITS,
            });
            out += formatMissingNames(missing);
            return out;
        });
    }

    /**
     * Evaluate an expression in current debug context
     */
    public async handleEvaluateExpression(args: { expression: string; timeoutMs?: number }): Promise<string> {
        const { expression, timeoutMs } = args;

        return withHandlerTimeout('evaluate_expression', timeoutMs, async () => {
            await this.ensureStoppedSession('evaluate expression');

            const activeStackItem = vscode.debug.activeStackItem;
            if (!activeStackItem || !('frameId' in activeStackItem)) {
                throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
            }

            const response = await this.executor.evaluateExpression(expression, activeStackItem.frameId, timeoutMs);

            if (response && response.result !== undefined) {
                // evaluate_expression is the trivial bypass for per-variable
                // redaction — `os.environ` or a bare `apiKey` returns the same
                // value the variable view withheld. Raw GDB CLI passthrough is
                // exempt: `-exec info registers` and friends return target
                // state, not program values, and must come back verbatim.
                const isGdbPassthrough = expression.trimStart().startsWith('-exec');
                const redact = this.redactor();
                const verdict = (redact && !isGdbPassthrough)
                    ? redactExpressionResult(expression, response.result)
                    : { value: String(response.result), redacted: false };

                let resultText = `Expression: ${expression}\n`;
                resultText += `Result: ${verdict.value}`;
                if (response.type) {
                    resultText += ` (${response.type})`;
                }
                if (verdict.redacted) {
                    resultText += `\n\n${REDACTION_NOTICE}`;
                }

                return resultText;
            } else {
                throw new Error('Failed to evaluate expression');
            }
        });
    }

    /**
     * Get current debug state
     */
    public async getCurrentDebugState(): Promise<DebugState> {
        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    /**
     * Check if debugging session is active
     */
    public async isDebuggingActive(): Promise<boolean> {
        return await this.executor.hasActiveSession();
    }

    /**
     * Wait for a debug session to come up after start/restart/load_and_debug.
     *
     * "Ready" means a live, responsive session — `stopped` OR `running`.
     * The earlier implementation required `hasActiveSession()`, which is true
     * only when the target is *stopped*; that wrongly timed out whenever the
     * firmware ran free (no `break main`) or when attaching to a running
     * target, reporting "no debug session became ready" for a session that
     * had in fact come up fine. We now poll `getSessionStatus()` and accept
     * any responsive state.
     */
    private async waitForActiveDebugSession(overrideMs?: number): Promise<boolean> {
        const baseDelay = 1000; // Start with 1 second
        const maxDelay = 10000; // Cap at 10 seconds
        const cap = 60_000;
        const def = this.timeoutInSeconds * 1000;
        const totalMs = (overrideMs && overrideMs > 0) ? Math.min(overrideMs, cap) : Math.min(def, cap);

        const startTime = Date.now();
        let attempt = 0;

        while (Date.now() - startTime < totalMs) {
            const status = await this.executor.getSessionStatus();
            if (status.state === 'stopped' || status.state === 'running') {
                logger.info(`Debug session is now active (state=${status.state})`);
                return true;
            }

            logger.info(`[Attempt ${attempt + 1}] Waiting for debug session to become active (state=${status.state})...`);

            // Calculate delay using exponential backoff with jitter
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            const jitteredDelay = delay + Math.random() * 200; // Add up to 200ms jitter

            await new Promise(resolve => setTimeout(resolve, jitteredDelay));
            attempt++;
        }

        return false; // Timeout reached
    }

    /**
     * Wait for the target to stop after a continue/step command.
     * Uses vscode.debug.onDidChangeActiveStackItem which fires when the debugger
     * stops and a stack frame becomes available — safe for embedded targets.
     *
     * Returns both the state snapshot and whether the wait timed out so that
     * callers can report a clear "target still running / probe stalled" message
     * instead of silently returning a stale state.
     */
    private async waitForTargetStopped(overrideMs?: number): Promise<{ state: DebugState; timedOut: boolean; sessionEnded: boolean }> {
        return new Promise((resolve) => {
            const cap = 60_000;
            const def = this.timeoutInSeconds * 1000;
            const timeoutMs = (overrideMs && overrideMs > 0) ? Math.min(overrideMs, cap) : Math.min(def, cap);
            let settled = false;
            let sessionEnded = false;
            let timedOut = false;

            const settle = async () => {
                if (settled) { return; }
                settled = true;
                stackDisposable.dispose();
                sessionDisposable.dispose();
                clearTimeout(timer);
                // No settle delay needed: getCurrentDebugState reads the location
                // from the DAP top stack frame, which is already correct at this
                // point. It used to scrape the editor cursor, which VS Code
                // updates asynchronously — hence the old 300 ms sleep here.
                const state = await this.executor.getCurrentDebugState(this.numNextLines);
                resolve({ state, timedOut, sessionEnded });
            };

            // Listen for when a stack frame becomes active (= target stopped)
            const stackDisposable = vscode.debug.onDidChangeActiveStackItem(() => {
                settle();
            });

            // Also listen for session termination
            const sessionDisposable = vscode.debug.onDidTerminateDebugSession(() => {
                sessionEnded = true;
                settle();
            });

            // Timeout fallback
            const timer = setTimeout(() => {
                timedOut = true;
                logger.warn(`waitForTargetStopped: target did not stop within ${timeoutMs}ms`);
                settle();
            }, timeoutMs);
        });
    }

    /**
     * Format the result of a step/continue command, annotating timeouts and
     * session termination so the MCP client sees an unambiguous outcome.
     */
    private formatAfterExecution(result: { state: DebugState; timedOut: boolean; sessionEnded: boolean }, op: string): string {
        const body = this.compactState(result.state);
        if (result.sessionEnded) {
            return `${body}\n\n⚠️ Debug session ended during '${op}'. The target may have run to completion, crashed, or lost its connection.`;
        }
        if (result.timedOut) {
            return `${body}\n\n⚠️ '${op}' did not complete within ${this.timeoutInSeconds}s. ` +
                'The target is still running or the probe is unresponsive. ' +
                'Consider adding a breakpoint, checking the hardware connection, or calling check_target_connection.';
        }
        return body;
    }

    /**
     * Recovery on a step/continue timeout: pause the running target, wait
     * briefly for it to stop, then report where the PC actually is. Lets the
     * agent see that the breakpoint was never hit because, say, the firmware
     * is sitting in a polling loop, an ISR, or has wandered off into the weeds.
     *
     * Returns a human-readable summary appended to the timeout message. Best
     * effort — if pause itself fails the original message stands.
     */
    private async attemptRecoveryAfterTimeout(op: string): Promise<string> {
        const lines: string[] = [];
        lines.push(`\n🩹 Recovery attempt: target did not stop on its own — issuing DAP pause to find out where it is.`);
        try {
            // Short timeout for the pause itself; we don't want to compound the wait.
            await this.executor.pause(5_000);
            // Wait for the stop event to propagate.
            const recovered = await this.waitForTargetStopped(5_000);
            if (recovered.sessionEnded) {
                lines.push(`Pause issued but the debug session ended. The target may have crashed during '${op}'.`);
                return lines.join('\n');
            }
            if (recovered.timedOut) {
                lines.push(`Pause did not produce a stop event within 5s — probe/GDB server may be unresponsive. ` +
                    `Call check_target_connection, then restart_debugging if needed.`);
                return lines.join('\n');
            }

            // Read PC and LR to localise the firmware — two registers, not
            // the full set; read_core_registers is a call away if needed.
            let pcText = '<unavailable>';
            let lrText = '';
            try {
                const regs = await this.executor.readCoreRegisters(5_000, ['pc', 'lr']);
                if (regs.pc) { pcText = this.normalizeRegToHex(regs.pc); }
                if (regs.lr) { lrText = `, LR = ${this.normalizeRegToHex(regs.lr)}`; }
            } catch (err) {
                pcText = `<read failed: ${err instanceof Error ? err.message : String(err)}>`;
            }

            const state = recovered.state;
            const frame = state.frameName ? ` in ${state.frameName}` : '';
            const loc = state.fileName && state.currentLine !== null
                ? ` at ${state.fileName}:${state.currentLine}`
                : '';
            lines.push(`Paused successfully. PC = ${pcText}${lrText}${frame}${loc}.`);
            if (state.currentLineContent) {
                lines.push(`  Current line: ${state.currentLineContent}`);
            }
            lines.push(`The breakpoint you expected was not hit — the firmware did not reach it. ` +
                `Verify the breakpoint location, check the call stack with get_call_stack, ` +
                `or step from here with step_over / continue_execution.`);
            return lines.join('\n');
        } catch (err) {
            lines.push(`Pause failed: ${err instanceof Error ? err.message : String(err)}. ` +
                `Probe / GDB server may be wedged — call check_target_connection.`);
            return lines.join('\n');
        }
    }

    /**
     * Get the universal drill-down reminder message
     */
    private getRootCauseAnalysisCheckpointMessage(): string {
        return `⚠️ **ROOT CAUSE ANALYSIS CHECKPOINT**

Before concluding your debugging session:

❓ **CRITICAL QUESTION:** Have you found the ROOT CAUSE or just a SYMPTOM?

🔍 **If you only identified WHERE it went wrong:**
- Variable is null/undefined
- Function returned unexpected value  
- Error occurred at specific line
- Condition evaluated incorrectly

➡️ **You likely found a SYMPTOM - Continue debugging!**

ROOT CAUSE means understanding WHY the issue occurred in the first place, for example due to:
- Incorrect variable initialization
- Logic error in function implementation
- Missing error handling
- Faulty assumptions in conditions

REQUIRED NEXT STEPS:
1. Use 'add_breakpoint' to set breakpoints at investigation points
2. Use 'start_debugging' to trace from the beginning
3. Investigate WHY the issue occurred, not just WHAT happened
4. Repeat the process as necessary until the ROOT CAUSE is identified`;
    }

    // ========== Embedded / Cortex-M tool handlers ==========

    /**
     * Read target memory
     */
    public async handleReadMemory(args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }): Promise<string> {
        const { address, length, format = 'hex', timeoutMs } = args;

        return withHandlerTimeout('read_memory', timeoutMs, async () => {
            await this.ensureStoppedSession('read memory');

            const data = await this.executor.readMemory(address, length, timeoutMs);

            // Normalize and parse address using BigInt to handle full 32-bit range
            const addrStr = address.startsWith('0x') || address.startsWith('0X') ? address : `0x${address}`;
            const baseAddr = BigInt(addrStr);

            let result = `Memory at ${addrStr} (${length} bytes):\n`;

            if (format === 'hex' || format === 'both') {
                result += '\nHex:\n';
                for (let i = 0; i < data.length; i += 16) {
                    const slice = data.subarray(i, Math.min(i + 16, data.length));
                    const addr = (baseAddr + BigInt(i)).toString(16).padStart(8, '0');
                    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
                    result += `  0x${addr}: ${hex}\n`;
                }
            }

            if (format === 'ascii' || format === 'both') {
                result += '\nASCII:\n  ';
                for (let i = 0; i < data.length; i++) {
                    const ch = data[i];
                    result += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : '.';
                    if ((i + 1) % 64 === 0) { result += '\n  '; }
                }
                result += '\n';
            }

            return result;
        });
    }

    /**
     * Normalize a GDB register value string to hex format.
     * Converts pure decimal to 0x hex, strips symbol annotations from hex values.
     * Keeps decoded formats (e.g. "[ Z C GE=0 ]") as-is.
     */
    private normalizeRegToHex(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed || trimmed === '<?>') { return trimmed; }

        // Decoded format like "[ Z C GE=0 EXC=0 T ]" — keep as-is
        if (trimmed.startsWith('[')) { return trimmed; }

        // Already hex (0x…) — strip symbol annotation like " <main+12>"
        if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
            const hexMatch = trimmed.match(/^(0x[0-9a-fA-F]+)/);
            return hexMatch ? hexMatch[1] : trimmed;
        }

        // Pure decimal — convert to 0x hex (32-bit unsigned)
        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 0) {
            return '0x' + (num >>> 0).toString(16).padStart(8, '0');
        }

        return trimmed;
    }

    /**
     * Read Cortex-M core registers
     */
    public async handleReadCoreRegisters(args?: { timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('read_core_registers', args?.timeoutMs, async () => {
            await this.ensureStoppedSession('read core registers');

            const regs = await this.executor.readCoreRegisters(args?.timeoutMs);

            let result = 'Core Registers:\n';
            const rows: string[][] = [
                ['r0', 'r1', 'r2', 'r3'],
                ['r4', 'r5', 'r6', 'r7'],
                ['r8', 'r9', 'r10', 'r11'],
                ['r12', 'sp', 'lr', 'pc'],
            ];
            for (const row of rows) {
                result += '  ' + row.map(r => `${r.padEnd(4)}= ${this.normalizeRegToHex(regs[r] || '<?>').padEnd(14)}`).join('') + '\n';
            }
            result += `  xpsr = ${regs['xpsr'] || '<?>'}\n`;
            result += `  msp  = ${this.normalizeRegToHex(regs['msp'] || '<?>')}\n`;
            result += `  psp  = ${this.normalizeRegToHex(regs['psp'] || '<?>')}\n`;
            result += `  control   = ${regs['control'] || '<?>'}\n`;
            result += `  faultmask = ${this.normalizeRegToHex(regs['faultmask'] || '<?>')}\n`;
            result += `  basepri   = ${this.normalizeRegToHex(regs['basepri'] || '<?>')}\n`;
            result += `  primask   = ${this.normalizeRegToHex(regs['primask'] || '<?>')}\n`;

            return result;
        });
    }

    /**
     * Read the DWT cycle counter for cycle-accurate timing. Enables trace +
     * CYCCNT on first use (a one-time, benign debug-unit state change).
     */
    public async handleReadCycleCounter(args?: { timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('read_cycle_counter', args?.timeoutMs, async () => {
            await this.ensureStoppedSession('read cycle counter');

            const reading = await this.executor.readCycleCounter(args?.timeoutMs);
            if (!reading.present) {
                return 'This core reports no DWT cycle counter (DWT_CTRL.NOCYCCNT=1) — read_cycle_counter is ' +
                    'unavailable. Use an RTOS tick or a timer peripheral for timing instead.';
            }

            const hex = `0x${reading.cycles.toString(16).padStart(8, '0')}`;
            let result = `DWT cycle counter: ${reading.cycles} (${hex})\n`;
            if (reading.enabledNow) {
                result += 'DWT was enabled during this call — deltas are valid from now.\n';
            }
            result += 'Wrap: 32-bit, wraps every 2^32 cycles (~10.7 s @ 400 MHz) — for longer spans, sample ' +
                'repeatedly and accumulate.\n';
            result += 'Note: CYCCNT stops while the core is halted and during WFE sleep — it counts ACTIVE ' +
                'cycles only.\n';
            result += 'To time a region: read here, continue_execution / wait_for_stop to the end point, read ' +
                'again, subtract (mod 2^32).';
            return result;
        });
    }

    /**
     * Read peripheral register(s) via Peripheral Inspector or memory fallback
     */
    public async handleReadPeripheralRegister(args: { peripheral: string; register?: string; timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('read_peripheral_register', args.timeoutMs, async () => {
            await this.ensureStoppedSession('read peripheral register');
            return await this.executor.readPeripheralRegister(args.peripheral, args.register, args.timeoutMs);
        });
    }

    /**
     * Read and decode Cortex-M fault registers
     */
    public async handleGetFaultInfo(args?: { timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('get_fault_info', args?.timeoutMs, async () => {
            await this.ensureStoppedSession('read fault info');
            return await this.executor.getFaultInfo(args?.timeoutMs);
        });
    }

    /**
     * Get debug target / session information.
     * Does NOT require the target to be stopped — only reads the launch
     * configuration object that VS Code already holds in memory.
     */
    public async handleGetDeviceInfo(): Promise<string> {
        try {
            if (!this.executor.hasDebugSession()) {
                throw new Error('No active debug session. Start debugging first.');
            }
            return await this.executor.getDeviceInfo();
        } catch (error) {
            throw new Error(`Error getting device info: ${error}`);
        }
    }

    /**
     * Run a low-cost connectivity probe against the target. Safe to call even
     * when other tool invocations have started failing — it never issues a
     * long-running DAP request and uses a short internal timeout.
     */
    public async handleCheckTargetConnection(): Promise<string> {
        try {
            return await this.executor.checkTargetConnection();
        } catch (error) {
            if (error instanceof HardwareTimeoutError) {
                return `check_target_connection: ${error.message}`;
            }
            throw new Error(`Error checking target connection: ${error}`);
        }
    }

    /**
     * Report the structured debug-session status. Never throws — designed to
     * be the agent's first port of call when it is unsure whether a session
     * is alive, running, stopped, or wedged.
     */
    /**
     * Return the full call stack of the active (or specified) thread.
     */
    public async handleGetCallStack(args: { threadId?: number; levels?: number; timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('get_call_stack', args.timeoutMs, async () => {
            await this.ensureStoppedSession('get call stack');
            const frames = await this.executor.getCallStack(args.threadId, args.levels ?? 50, args.timeoutMs);
            if (frames.length === 0) {
                return 'No stack frames available.';
            }
            // Paths workspace-relative; a deep stack collapsed unless the
            // caller asked for a depth — 50 frames of absolute paths is the
            // kind of result that compacts an agent's context for nothing.
            const roots = this.workspaceRoots();
            const { shown, hidden } = args.levels !== undefined
                ? { shown: frames, hidden: 0 }
                : truncateList(frames, DebuggingHandler.CALL_STACK_INLINE_FRAMES);
            const lines: string[] = [];
            lines.push(`Call stack (${frames.length} frame${frames.length === 1 ? '' : 's'}):`);
            shown.forEach((f, i) => {
                const loc = f.source ? `${shortenPath(f.source, roots)}:${f.line ?? '?'}` : `<no source>:${f.line ?? '?'}`;
                const fid = f.frameId !== undefined ? ` [frameId=${f.frameId}]` : '';
                lines.push(`  #${i.toString().padStart(2, ' ')}  ${f.name}  @ ${loc}${fid}`);
            });
            if (hidden > 0) {
                lines.push(`  … ${hidden} more frames — pass levels to see all`);
            }
            lines.push('');
            lines.push('Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.');
            return lines.join('\n');
        });
    }

    /**
     * List DAP threads. With an RTOS-aware GDB server (pyOCD --rtos, J-Link
     * RTOS plugin), each FreeRTOS/RTX/etc. task is enumerated as a thread.
     */
    public async handleGetThreads(args?: { timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('get_threads', args?.timeoutMs, async () => {
            await this.ensureStoppedSession('get threads');
            const threads = await this.executor.getThreads(args?.timeoutMs);
            if (threads.length === 0) {
                return 'No threads reported by the debug adapter.';
            }
            const roots = this.workspaceRoots();
            const { shown, hidden } = truncateList(threads, DebuggingHandler.THREADS_INLINE);
            const lines: string[] = [];
            lines.push(`Threads / RTOS tasks (${threads.length}):`);
            for (const t of shown) {
                const top = t.topFrame
                    ? `  → ${t.topFrame.name} @ ${t.topFrame.source ? shortenPath(t.topFrame.source, roots) : '<no source>'}:${t.topFrame.line ?? '?'}`
                    : '';
                lines.push(`  [${t.id}] ${t.name}${top}`);
            }
            if (hidden > 0) {
                lines.push(`  … ${hidden} more threads`);
            }
            lines.push('');
            lines.push('Tip: pass a threadId to get_call_stack to inspect a specific task.');
            return lines.join('\n');
        });
    }

    /**
     * Get variables for an explicit frame id (e.g. a caller frame from get_call_stack).
     */
    public async handleGetFrameVariables(args: {
        frameId: number;
        scope?: 'local' | 'global' | 'all';
        variableNames?: string[];
        timeoutMs?: number;
    }): Promise<string> {
        const { frameId, scope = 'all', variableNames, timeoutMs } = args;
        return withHandlerTimeout('get_frame_variables', timeoutMs, async () => {
            await this.ensureStoppedSession('get frame variables');
            const variablesData = await this.executor.getVariablesForFrame(frameId, scope, timeoutMs);
            const scopes = (variablesData.scopes ?? []) as DapScope[];
            if (scopes.length === 0) {
                return `No variable scopes available for frameId=${frameId}.`;
            }

            const { scopes: selected, missing } = variableNames?.length
                ? selectVariables(scopes, variableNames)
                : { scopes, missing: [] as string[] };

            if (variableNames?.length && selected.length === 0) {
                return `None of the requested variables are in scope at frameId=${frameId}: ${variableNames.join(', ')}.`;
            }

            return renderScopes(selected, {
                header: `Variables for frameId=${frameId}`,
                redact: this.redactor(),
                limits: variableNames?.length ? undefined : DEFAULT_LISTING_LIMITS,
            }) + formatMissingNames(missing);
        });
    }

    /**
     * Ask the CMSIS Solution extension whether a solution is currently active.
     * `cmsis-csolution.getSolutionFile` returns the extension's internal
     * `_activeSolution` and never throws — a truthy result means a csolution
     * project is loaded in THIS VS Code window. This is the authoritative
     * check; do not infer it from the presence of `.vscode/cmsis.json`, which
     * is legitimately empty/absent for single-target solutions.
     */
    private async queryActiveCmsisSolution(): Promise<{ active: boolean; describe: string }> {
        try {
            const result = await withTimeout(
                'cmsis getSolutionFile',
                5_000,
                Promise.resolve(vscode.commands.executeCommand('cmsis-csolution.getSolutionFile')),
            );
            if (!result) {
                return { active: false, describe: 'none' };
            }
            // _activeSolution may be a string path or an object — extract a path best-effort.
            let path: string | undefined;
            if (typeof result === 'string') {
                path = result;
            } else if (typeof result === 'object') {
                const r = result as Record<string, any>;
                path = r.solutionFile ?? r.fsPath ?? r.path ?? r.uri?.fsPath ?? r.uri?.path;
            }
            return { active: true, describe: path ?? '<active, path unknown>' };
        } catch (err) {
            // Command missing → CMSIS Solution extension not installed/active.
            return { active: false, describe: `query failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    /**
     * Confirm a freshly-created debug session actually survives — i.e. the
     * target is genuinely connected, not just that the debug adapter process
     * is alive. A `gdbtarget` `attach` with no GDB server behind the port
     * yields a session whose adapter answers a shallow DAP `threads` ping for
     * a few seconds and then terminates.
     *
     * Strategy: probe at two time points ~4 s apart. At each point require
     * (a) the session object still exists, and (b) `getSessionStatus()` is
     * `running`/`stopped`. A doomed session has collapsed to `no-session` by
     * the second probe. We never assert "stable" off a single observation.
     */
    private async confirmSessionSurvives(): Promise<{ stable: boolean; detail: string }> {
        // A zombie gdbtarget session — adapter process alive, GDB NOT connected
        // to a target — keeps the VS Code session object around for several
        // seconds and even answers a shallow DAP `threads` ping. But it
        // answers with an EMPTY thread list, because there is no target. A
        // real attached Cortex-M session always reports >= 1 thread (at least
        // the core). So the decisive signal is a non-empty thread list — not
        // "a session object exists" and not "the adapter answered".
        const probe = async (label: string): Promise<{ ok: boolean; detail: string }> => {
            if (!this.executor.hasDebugSession()) {
                return { ok: false, detail: `${label}: no session object` };
            }
            try {
                const threads = await this.executor.getThreads(5_000);
                if (threads.length >= 1) {
                    return { ok: true, detail: `${label}: ${threads.length} thread(s)` };
                }
                return { ok: false, detail: `${label}: session object present but 0 threads — adapter is not connected to a target` };
            } catch (err) {
                return { ok: false, detail: `${label}: thread probe failed — ${err instanceof Error ? err.message : String(err)}` };
            }
        };

        // Let the connect settle, then probe.
        await new Promise(r => setTimeout(r, 3_000));
        const first = await probe('t+3s');
        // Second probe after a gap. The LATER probe is decisive: a real
        // session is fully connected (threads populated) by t+6s; a zombie is
        // gone or still thread-less.
        await new Promise(r => setTimeout(r, 3_000));
        const second = await probe('t+6s');
        if (second.ok) {
            return { stable: true, detail: `${first.detail}, ${second.detail} — target threads present` };
        }
        return { stable: false, detail: `${first.detail}, then ${second.detail}` };
    }

    /**
     * Program the target flash via `pyocd load --cbuild-run` as a synchronous
     * operation: bytes programmed + structured error, not "check the output
     * channel". Refuses while a debug session is active — programming under
     * a live session wedges most probes.
     */
    public async handleFlash(args: { cbuildRunFile?: string; timeoutMs?: number }): Promise<string> {
        // Flash legitimately takes tens of seconds — default to the full
        // budget like cmsis_action build/load does.
        return withHandlerTimeout('flash', args?.timeoutMs ?? HARD_HANDLER_CAP_MS, async () => {
            if (this.executor.hasDebugSession()) {
                return 'Refusing to flash while a debug session is active — programming under a live session ' +
                    'wedges most probes. Call stop_debugging first, then flash, then cmsis_action attach or load_and_debug.';
            }
            const resolved = await this.resolveCbuildRunFile(args.cbuildRunFile);
            if ('error' in resolved) { return resolved.error; }
            const version = await probePyocd();
            if (!version) {
                return 'pyocd not found on PATH. Install it (pip install pyocd / pipx install pyocd), or use ' +
                    'cmsis_action load, which drives the CMSIS Solution extension\'s own flash pipeline.';
            }
            // Margin under the handler fence so the flash result (not the
            // generic fence text) is what the agent sees at the deadline.
            const budget = Math.max((args?.timeoutMs ?? HARD_HANDLER_CAP_MS) - 1_500, 1_000);
            const result = await flashWithPyocd(resolved.path, budget);
            if (result.timedOut) {
                return `Flash timed out after ${Math.round(budget / 1000)} s — the pyOCD process was killed.\n` +
                    `Output tail:\n  ${result.outputTail.join('\n  ') || '<no output>'}\n` +
                    `Retry, or investigate why programming stalls (probe connection, target held in reset).`;
            }
            if (result.ok) {
                const bytes = result.programmedBytes !== null ? ` — programmed ${result.programmedBytes} bytes` : '';
                const rate = result.kbps !== null ? ` at ${result.kbps} kB/s` : '';
                return `✅ Flash succeeded${bytes}${rate} (pyOCD ${version}: \`${result.commandLine}\`). ` +
                    `Use cmsis_action attach or load_and_debug to start a debug session.`;
            }
            return `❌ Flash FAILED (exit ${result.exitCode ?? 'unknown'}) — \`${result.commandLine}\`\n` +
                (result.errorLines.length > 0 ? `Errors:\n  ${result.errorLines.join('\n  ')}\n` : '') +
                `Output tail:\n  ${result.outputTail.join('\n  ') || '<no output>'}\n` +
                `This is a terminal result — fix the cause and re-run flash.`;
        });
    }

    /**
     * Resolve the cbuild-run.yml to program: the explicit argument, else the
     * active launch.json's `cmsis.cbuildRunFile` (${command:...} references
     * cannot be resolved here and are skipped, same as the SVD resolver),
     * else a recursive out/ scan (cbuild-run files nest as
     * out/<project>/<target>/<build>/). Ambiguity is an error that names the
     * candidates, never a silent pick.
     */
    private async resolveCbuildRunFile(explicit?: string): Promise<{ path: string } | { error: string }> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (explicit) {
            const resolved = path.isAbsolute(explicit)
                ? explicit
                : (workspaceFolder ? path.join(workspaceFolder.uri.fsPath, explicit) : explicit);
            if (!fileExists(resolved)) {
                return { error: `cbuild-run file not found: ${resolved}. Pass an existing path, or omit ` +
                    `cbuildRunFile to auto-resolve from launch.json / out/.` };
            }
            return { path: resolved };
        }
        if (!workspaceFolder) {
            return { error: 'No workspace folder open and no cbuildRunFile argument given — cannot resolve what to flash.' };
        }

        try {
            const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
            const doc = await vscode.workspace.openTextDocument(launchJsonPath);
            const launchConfig = jsonc.parse(doc.getText());
            const configs: any[] = Array.isArray(launchConfig?.configurations) ? launchConfig.configurations : [];
            for (const config of configs) {
                const candidate = config?.cmsis?.cbuildRunFile;
                if (typeof candidate === 'string' && candidate.length > 0 && !candidate.includes('${command:')) {
                    const resolved = path.isAbsolute(candidate) ? candidate : path.join(workspaceFolder.uri.fsPath, candidate);
                    if (fileExists(resolved)) { return { path: resolved }; }
                }
            }
        } catch {
            // No launch.json or unparseable — fall through to the out/ scan.
        }

        const matches = await vscode.workspace.findFiles('out/**/*.cbuild-run.yml', '**/node_modules/**', 10);
        if (matches.length === 1) {
            return { path: matches[0].fsPath };
        }
        if (matches.length > 1) {
            return { error: `Found ${matches.length} cbuild-run files under out/ — pass cbuildRunFile explicitly:\n` +
                `  ${matches.map(m => m.fsPath).join('\n  ')}` };
        }
        return { error: 'No cbuild-run file found (launch.json has no resolvable cmsis.cbuildRunFile and out/ has ' +
            'none). Build first (cmsis_action build), or pass cbuildRunFile explicitly.' };
    }

    /**
     * Drive the CMSIS Solution extension's flash / debug commands — the same
     * actions the buttons in the CMSIS Solution panel invoke. They operate on
     * the currently active csolution context (no arguments).
     */
    public async handleCmsisCommand(args: { action: CmsisAction; timeoutMs?: number }): Promise<string> {
        // build / load / erase / load_and_run run a cbuild/flash task that can
        // take tens of seconds. Give them the full handler budget by default
        // so the tool can wait for the task's real exit code and return a
        // terminal success/failure, rather than returning "issued" and
        // leaving the agent to guess (or idle) when the build is done.
        const runsBuildTask = args.action === 'build' || args.action === 'load'
            || args.action === 'erase' || args.action === 'load_and_run';
        const effectiveTimeoutMs = (args.timeoutMs && args.timeoutMs > 0)
            ? args.timeoutMs
            : (runsBuildTask ? HARD_HANDLER_CAP_MS : DEFAULT_HANDLER_TIMEOUT_MS);
        return withHandlerTimeout('cmsis_action', effectiveTimeoutMs, async () => {
            // Pre-check: refuse to flash+attach on top of an already-active session.
            if ((args.action === 'load_and_debug' || args.action === 'attach') && this.executor.hasDebugSession()) {
                const status = await this.executor.getSessionStatus();
                return `A debug session is already active (name='${status.sessionName ?? '?'}', state=${status.state}). ` +
                    `Refusing to ${args.action}. Use stop_debugging or restart_debugging first, or proceed with inspection.`;
            }

            // Pre-check: confirm the CMSIS Solution extension actually has an
            // active solution in this window, by asking the extension itself.
            const solution = await this.queryActiveCmsisSolution();
            if (!solution.active) {
                const diag = this.executor.getDiagnostics();
                return `CMSIS '${args.action}' not attempted: the CMSIS Solution extension reports no active ` +
                    `solution in this VS Code window (cmsis-csolution.getSolutionFile → ${solution.describe}). ` +
                    `cmsis_action operates on whatever solution that extension has active — it cannot select one. ` +
                    `Fixes: (1) open the folder containing the project's *.csolution.yml in the VS Code window ` +
                    `running this MCP server (serverVersion=${diag.serverVersion}); (2) in the CMSIS Solution panel, ` +
                    `confirm a solution + active context is selected; (3) if the solution is open in a different ` +
                    `window, drive cmsis_action from that window's MCP server.`;
            }

            const map: Record<CmsisAction, string> = {
                build:           'cmsis-csolution.build',
                load:            'cmsis-csolution.cmsisLoad',
                erase:           'cmsis-csolution.cmsisErase',
                load_and_run:    'cmsis-csolution.cmsisLoadAndRun',
                load_and_debug:  'cmsis-csolution.cmsisLoadAndDebug',
                attach:          'cmsis-csolution.cmsisAttachDebugger',
                detach:          'cmsis-csolution.cmsisDetachDebugger',
                stop_run:        'cmsis-csolution.cmsisStopRun',
            };
            const cmd = map[args.action];
            if (!cmd) {
                throw new Error(`Unknown CMSIS action: ${args.action}`);
            }

            // For build/flash actions, start listening for the cbuild/flash
            // TASK to finish *before* we issue the command — its exit code is
            // the one reliable "build done" signal, and a fast task could end
            // before we start waiting otherwise. Session actions and the
            // instant control ops (detach/stop_run) don't produce a task we
            // wait on, so this stays idle for them.
            const taskWaiter = runsBuildTask
                ? this.waitForCmsisTaskResult(Math.max(5_000, effectiveTimeoutMs - 3_000))
                : null;

            // Session actions still use FIRE-AND-RETURN: `cmsis-csolution.*`
            // launch commands run a long flash+attach pipeline, and awaiting
            // `executeCommand` to completion can hang on a CMSIS QuickPick
            // (select context / debugger) the agent can't answer. Those do a
            // short opportunistic check and hand off to get_session_status.
            let commandFailed: string | null = null;
            const commandPromise = (vscode.commands.executeCommand(cmd) as Promise<unknown>)
                .catch((error) => {
                    const msg = String(error);
                    if (/no active solution/i.test(msg)) {
                        // The CMSIS Solution extension has no solution context.
                        // It auto-activates a *.csolution.yml only when the
                        // workspace folder open in this window contains one.
                        const diag = this.executor.getDiagnostics();
                        commandFailed =
                            `CMSIS '${args.action}' failed: no active CMSIS solution. The CMSIS Solution extension ` +
                            `has no solution context in THIS VS Code window. Fixes:\n` +
                            `  1. Make sure the VS Code window running this MCP server (serverVersion=${diag.serverVersion}) ` +
                            `has the project's *.csolution.yml folder open — each window is independent.\n` +
                            `  2. In that window, open the CMSIS Solution panel and confirm a solution + active context ` +
                            `is selected (Manage Solution).\n` +
                            `  3. If the solution is open in a different window, drive cmsis_action from that window's ` +
                            `MCP server instead.\n` +
                            `cmsis_action operates on whatever solution the CMSIS Solution extension has active — it ` +
                            `cannot select one for you.`;
                    } else {
                        commandFailed = `CMSIS command '${cmd}' failed: ${error}. ` +
                            `Ensure the CMSIS Solution extension is installed and a solution context is active.` +
                            this.diagnosticsSuffix();
                    }
                });

            // Brief kick-off window — long enough to surface an immediate
            // command error, short enough not to feel like a hang.
            const kickOffMs = 4_000;
            await Promise.race([
                commandPromise,
                new Promise<void>((resolve) => setTimeout(resolve, kickOffMs)),
            ]);
            if (commandFailed) {
                throw new Error(commandFailed);
            }

            // For session-producing actions, do ONE short opportunistic wait
            // (not the full 30-60 s) so a fast bring-up is reported inline,
            // then hand off to get_session_status polling.
            if (args.action === 'load_and_debug' || args.action === 'attach') {
                const opportunisticMs = 8_000;
                const sessionActive = await this.waitForActiveDebugSession(opportunisticMs);
                if (sessionActive) {
                    // A session object appearing is NOT proof the target is
                    // connected. With no GDB server behind the port, `attach`
                    // produces a session whose adapter still answers a shallow
                    // DAP `threads` ping for a few seconds, then collapses.
                    // Probe at two time points spaced apart — a doomed session
                    // is gone by the second check.
                    const survived = await this.confirmSessionSurvives();
                    if (survived.stable) {
                        const state = await this.executor.getCurrentDebugState(this.numNextLines);
                        return `CMSIS '${args.action}' completed — debug session survived the connect ` +
                            `(${survived.detail}). State: ${this.fullState(state)}`;
                    }
                    return `CMSIS '${args.action}' started a debug session but it did NOT survive the initial ` +
                        `connect — ${survived.detail}. ` +
                        `For 'attach' this almost always means no GDB server is listening on the configured port: ` +
                        `start the GDB server first, or use 'load_and_debug' (which launches one). ` +
                        `Confirm with get_session_status / check_target_connection.` +
                        this.diagnosticsSuffix();
                }
                return `CMSIS '${args.action}' issued via '${cmd}'. The flash/connect pipeline is running in the ` +
                    `CMSIS extension (a multi-core flash + attach typically takes 20-40 s). This tool does not ` +
                    `block for the whole pipeline — poll get_session_status until it reports 'running' or ` +
                    `'stopped'. If get_session_status keeps reporting 'no-session' with liveSessionsInThisWindow=0, ` +
                    `the CMSIS panel is most likely showing a picker the user must resolve. Less often, this call ` +
                    `and the poll landed in different windows — check with list_debug_windows and pin one with ` +
                    `select_debug_window.`;
            }

            // build / load / erase / load_and_run — wait for the cbuild/flash
            // TASK to finish and report its real exit code. This is the fix
            // for the agent idling: we return a terminal success/failure, not
            // "issued — check the output channel" (which the agent cannot read
            // and would wait on forever).
            if (taskWaiter) {
                const nextStep: Record<string, string> = {
                    build:        ' The firmware is built — use cmsis_action load or load_and_debug to flash it.',
                    load:         ' Firmware flashed. Use cmsis_action attach or load_and_debug to start a debug session.',
                    erase:        ' Target flash erased.',
                    load_and_run: ' Firmware flashed and running (no debug session).',
                };
                const outcome = await taskWaiter;

                if (outcome.done && outcome.exitCode === 0) {
                    return `✅ CMSIS '${args.action}' succeeded (task '${outcome.taskName}' exited 0).` +
                        (nextStep[args.action] ?? '');
                }
                if (outcome.done && typeof outcome.exitCode === 'number') {
                    return `❌ CMSIS '${args.action}' FAILED — task '${outcome.taskName}' exited with code ` +
                        `${outcome.exitCode}. Open the CMSIS/cbuild terminal or the Problems panel to read the ` +
                        `compiler/linker errors, fix them in the source, then re-run cmsis_action ${args.action}. ` +
                        `This is a terminal result — do not wait for an output file.`;
                }
                if (outcome.done) {
                    // Task ended but the platform reported no exit code (e.g. it
                    // was cancelled) — don't claim success.
                    return `CMSIS '${args.action}' task '${outcome.taskName}' ended without an exit code ` +
                        `(it may have been cancelled). Re-run cmsis_action ${args.action} to get a definite result.`;
                }
                if (!outcome.started) {
                    // No cbuild/flash task ever started. Usually means the
                    // active context is already up to date (nothing to build),
                    // or the CMSIS panel is waiting on a manual picker.
                    return `CMSIS '${args.action}' issued via '${cmd}', but no cbuild/flash task ran within the ` +
                        `wait window. This usually means the active context is already up to date (nothing to ` +
                        `${args.action}), or the CMSIS Solution panel is showing a picker that needs manual ` +
                        `selection. This is a terminal result — do not wait for an output file. Re-run the ` +
                        `action or check the CMSIS panel.`;
                }
                // Task started but is still running at the deadline.
                const waitedS = Math.round((Math.max(5_000, effectiveTimeoutMs - 3_000)) / 1000);
                return `CMSIS '${args.action}' is still running after ${waitedS}s (task '${outcome.taskName ?? cmd}' ` +
                    `has not finished). Large clean builds can take longer than this. The tool returned so you are ` +
                    `not blocked — re-run cmsis_action ${args.action} to get the final exit status, or watch the ` +
                    `CMSIS terminal. Do NOT poll for an output file.`;
            }

            // detach / stop_run — instant control ops, nothing to wait on.
            return `CMSIS '${args.action}' command '${cmd}' issued. It runs in the CMSIS extension — ` +
                `check the CMSIS output channel if you need to confirm.`;
        });
    }

    /**
     * Wait for the cbuild/flash VS Code task kicked off by a cmsis_action to
     * finish, and surface its process exit code.
     *
     * `vscode.tasks.onDidEndTaskProcess` is the only reliable "the build is
     * done" signal available to the extension — it carries the child
     * process's exit code (0 = success). The alternatives are all worse: the
     * `cmsis-csolution.*` command promise does not reliably resolve on task
     * completion, and watching for an output artifact file to appear is
     * exactly the guess that leaves the agent idling.
     *
     * Resolves as soon as a matching task ends. On timeout, `started` tells
     * the caller whether a task ever ran (so it can distinguish "still
     * building" from "nothing to build / picker open").
     */
    private waitForCmsisTaskResult(
        timeoutMs: number,
    ): Promise<{ done: boolean; started: boolean; exitCode?: number; taskName?: string }> {
        return new Promise((resolve) => {
            let settled = false;
            let started = false;
            let startedTaskName: string | undefined;
            const disposables: vscode.Disposable[] = [];

            const finish = (result: { done: boolean; started: boolean; exitCode?: number; taskName?: string }) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                for (const d of disposables) {
                    try { d.dispose(); } catch { /* ignore */ }
                }
                resolve(result);
            };

            const isCmsisTask = (task: vscode.Task | undefined): boolean => {
                if (!task) { return false; }
                const haystack = `${task.name ?? ''} ${typeof task.source === 'string' ? task.source : ''} ` +
                    `${task.definition?.type ?? ''}`.toLowerCase();
                return /cmsis|cbuild/.test(haystack);
            };

            const timer = setTimeout(() => finish({ done: false, started, taskName: startedTaskName }), timeoutMs);

            disposables.push(vscode.tasks.onDidStartTaskProcess((e) => {
                if (isCmsisTask(e.execution.task)) {
                    started = true;
                    startedTaskName = e.execution.task.name;
                }
            }));
            disposables.push(vscode.tasks.onDidEndTaskProcess((e) => {
                if (isCmsisTask(e.execution.task)) {
                    finish({ done: true, started: true, exitCode: e.exitCode, taskName: e.execution.task.name });
                }
            }));
        });
    }

    public async handleGetSessionStatus(): Promise<string> {
        const status = await this.executor.getSessionStatus();
        const lines: string[] = [];
        lines.push(`State: ${status.state}`);
        if (status.sessionName) { lines.push(`Session: ${status.sessionName}`); }
        if (status.sessionType) { lines.push(`Type: ${status.sessionType}`); }
        if (status.configurationName) { lines.push(`Configuration: ${status.configurationName}`); }
        lines.push(`DAP responsive: ${status.dapResponsive}${status.dapProbeMs !== null ? ` (probe ${status.dapProbeMs}ms)` : ''}`);
        if (status.detail) { lines.push(`Detail: ${status.detail}`); }

        // Diagnostics — make it possible to tell a stale build / wrong-window
        // problem apart from a genuine no-session.
        const diag = this.executor.getDiagnostics();
        lines.push(
            `Diagnostics: serverVersion=${diag.serverVersion}, ` +
            `liveSessionsInThisWindow=${diag.liveSessionCount}` +
            (diag.liveSessionNames.length > 0 ? ` [${diag.liveSessionNames.join(', ')}]` : '') +
            `, vscodeActiveDebugSession=${diag.hasVscodeActiveSession ? 'set' : 'undefined'}`
        );

        // Add a hint so the agent knows what it can do next.
        switch (status.state) {
            case 'no-session':
                if (diag.liveSessionCount === 0) {
                    lines.push(
                        'Hint: no debug session is running in the VS Code window this call was routed to. ' +
                        'Start one with cmsis_action load_and_debug (CMSIS targets) or start_debugging. ' +
                        'If a session IS running and you expected to reach it, it is in a different ' +
                        'window: call list_debug_windows to see which windows are registered and which ' +
                        'one holds the session, then select_debug_window to pin it for this session. ' +
                        'If you just reinstalled the extension, reload the window so the new build is active.'
                    );
                } else {
                    lines.push('Hint: call start_debugging or cmsis_action load_and_debug to attach.');
                }
                break;
            case 'initializing':
                lines.push('Hint: the adapter is still starting — wait a moment and retry.');
                break;
            case 'running':
                lines.push('Hint: target is running. Add a breakpoint then continue_execution, or call pause_execution to inspect now.');
                break;
            case 'stopped':
                lines.push('Hint: full inspection (variables, memory, registers) is available.');
                break;
            case 'unresponsive':
                lines.push('Hint: probe/GDB server is hung. Try restart_debugging, stop_debugging, or check the physical connection.');
                break;
        }
        return lines.join('\n');
    }
}
