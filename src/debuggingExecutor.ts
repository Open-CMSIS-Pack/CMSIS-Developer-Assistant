// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as vscode from 'vscode';
import { DebugState, StackFrame, formatBreakpointModifiers } from './debugState';
import { customRequestWithTimeout, HardwareTimeoutError, withTimeout } from './utils/timeout';
import {
    isSessionStopped, getStoppedReason, resolveActiveSession,
    getLiveSessionCount, getLiveSessionNames,
    waitForStopEvent, StopWaitResult,
} from './utils/sessionStateTracker';
import {
    buildResetCommands, detectGdbServerKind, replyLooksUnsupported,
    GdbServerKind, ResetMethod,
} from './core/resetAssist';
import { DEMCR_TRCENA, DWT_ADDRESSES, DWT_CTRL_CYCCNTENA, DWT_CTRL_NOCYCCNT } from './core/dwt';
import { logger } from './utils/logger';

/**
 * Per-operation timeouts for hardware-facing requests.
 * All values are in milliseconds.
 */
export interface HardwareTimeouts {
    /** Timeout for a single DAP request (stackTrace, evaluate, readMemory, ...). */
    dapRequestMs: number;
    /** Overall timeout for multi-request hardware reads (readMemory, readCoreRegisters). */
    memoryReadMs: number;
}

export const DEFAULT_HARDWARE_TIMEOUTS: HardwareTimeouts = {
    dapRequestMs: 10000,
    memoryReadMs: 30000,
};

/**
 * Interface for debugging execution operations
 */
/**
 * Cap a caller-supplied per-call timeout to the global 60 s policy and fall
 * back to the configured default when no override is provided.
 */
const HARD_CALL_CAP_MS = 60_000;
function capTimeout(override: number | undefined, fallback: number): number {
    if (override === undefined || override === null) { return fallback; }
    if (!Number.isFinite(override) || override <= 0) { return fallback; }
    return Math.min(override, HARD_CALL_CAP_MS);
}

export interface IDebuggingExecutor {
    startDebugging(workingDirectory: string, config: vscode.DebugConfiguration): Promise<boolean>;
    startDebuggingByName(workingDirectory: string, configurationName: string): Promise<boolean>;
    stopDebugging(session?: vscode.DebugSession): Promise<void>;
    stepOver(timeoutMs?: number): Promise<void>;
    stepInto(timeoutMs?: number): Promise<void>;
    stepOut(timeoutMs?: number): Promise<void>;
    continue(timeoutMs?: number): Promise<void>;
    pause(timeoutMs?: number): Promise<void>;
    waitForStop(timeoutMs?: number): Promise<StopWaitResult | { kind: 'already-stopped'; reason: string | null }>;
    restart(): Promise<void>;
    addBreakpoint(uri: vscode.Uri, line: number, options?: { condition?: string; logMessage?: string }): Promise<void>;
    removeBreakpoint(uri: vscode.Uri, line: number): Promise<void>;
    setBreakpointViaGdb(fileFullPath: string, line: number, timeoutMs?: number, condition?: string): Promise<string>;
    setLogpointViaGdb(fileFullPath: string, line: number, format: string, args: string[], timeoutMs?: number): Promise<string>;
    setBreakpointConditionViaGdb(breakpointNumber: number, condition: string, timeoutMs?: number): Promise<string>;
    clearBreakpointViaGdb(fileFullPath: string, line: number, timeoutMs?: number): Promise<string>;
    clearAllBreakpointsViaGdb(timeoutMs?: number): Promise<string>;
    getCurrentDebugState(numNextLines: number): Promise<DebugState>;
    getVariables(frameId: number, scope?: 'local' | 'global' | 'all', timeoutMs?: number): Promise<any>;
    evaluateExpression(expression: string, frameId: number, timeoutMs?: number): Promise<any>;
    getBreakpoints(): readonly vscode.Breakpoint[];
    clearAllBreakpoints(): void;
    hasActiveSession(): Promise<boolean>;
    getActiveSession(): vscode.DebugSession | undefined;
    readMemory(address: string, length: number, timeoutMs?: number): Promise<Buffer>;
    readMemoryWord(address: string, timeoutMs?: number): Promise<number>;
    writeMemoryWord(address: string, value: number, timeoutMs?: number): Promise<void>;
    resetTarget(options: { method?: 'auto' | ResetMethod; halt?: boolean; timeoutMs?: number }): Promise<ResetOutcome>;
    readCoreRegisters(timeoutMs?: number): Promise<Record<string, string>>;
    readCycleCounter(timeoutMs?: number): Promise<{ cycles: number; enabledNow: boolean; present: boolean }>;
    readPeripheralRegister(peripheral: string, register?: string, timeoutMs?: number): Promise<string>;
    getFaultInfo(timeoutMs?: number): Promise<string>;
    getDeviceInfo(): Promise<string>;
    checkTargetConnection(): Promise<string>;
    hasDebugSession(): boolean;
    getSessionStatus(): Promise<SessionStatus>;
    getDiagnostics(): ExecutorDiagnostics;
    getThreads(timeoutMs?: number): Promise<DapThread[]>;
    getCallStack(threadId?: number, levels?: number, timeoutMs?: number): Promise<StackFrame[]>;
    getVariablesForFrame(frameId: number, scope?: 'local' | 'global' | 'all', timeoutMs?: number): Promise<any>;
}

export interface DapThread {
    id: number;
    name: string;
    topFrame?: StackFrame;
}

/** Result of a verified target reset — see resetTarget(). */
export interface ResetOutcome {
    /** GDB server detected behind the session (drives the monitor-command dialect). */
    serverKind: GdbServerKind;
    /** Reset methods attempted, in order ('auto' escalates on failed verification). */
    methodsTried: ResetMethod[];
    /** Monitor commands sent, in order. */
    commandsIssued: string[];
    /** Raw adapter replies, one per issued command. */
    replies: string[];
    /** True only when PC was confirmed at the reset vector afterwards. */
    verified: boolean;
    /** Human-readable verification evidence (PC vs reset vector, or why it could not be checked). */
    verificationDetail: string;
    /** True when the target was running and we halted it to issue the reset. */
    haltedByUs: boolean;
}

/** Low-level diagnostics for telling a stale build / wrong-window apart from a genuine no-session. */
export interface ExecutorDiagnostics {
    serverVersion: string;
    liveSessionCount: number;
    liveSessionNames: string[];
    hasVscodeActiveSession: boolean;
}

/** Bumped in lockstep with package.json — surfaced by getDiagnostics() so the agent can confirm which build answered. */
export const SERVER_VERSION = '2.3.3';

/**
 * Coarse classification of the debug session, exposed to MCP clients so an
 * agent can decide whether the session is gone, the target is running, the
 * target is stopped (and DAP reads will work), or the probe is unresponsive.
 */
export type SessionState =
    | 'no-session'
    | 'initializing'
    | 'running'
    | 'stopped'
    | 'unresponsive';

export interface SessionStatus {
    state: SessionState;
    sessionName: string | null;
    sessionType: string | null;
    configurationName: string | null;
    /** Whether DAP traffic answered within the short probe timeout. */
    dapResponsive: boolean;
    /** Round-trip time of the DAP probe in milliseconds, when it succeeded. */
    dapProbeMs: number | null;
    /** Optional human-readable detail (e.g. error from the probe). */
    detail?: string;
}

/**
 * Responsible for executing VS Code debugging commands and managing debug sessions
 */
export class DebuggingExecutor implements IDebuggingExecutor {

    private readonly timeouts: HardwareTimeouts;

    constructor(timeouts: Partial<HardwareTimeouts> = {}) {
        this.timeouts = { ...DEFAULT_HARDWARE_TIMEOUTS, ...timeouts };
    }

    /**
     * Start a debugging session
     */
    public async startDebugging(
        workingDirectory: string, 
        config: vscode.DebugConfiguration
    ): Promise<boolean> {
        try {
            if (config.type === 'coreclr') {
                // Open the specific test file instead of the workspace folder
                const testFileUri = vscode.Uri.file(config.program);
                await vscode.commands.executeCommand('vscode.open', testFileUri);
                vscode.commands.executeCommand('testing.debugCurrentFile');
                return true;
            }
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workingDirectory));
            return await vscode.debug.startDebugging(workspaceFolder, config);
        } catch (error) {
            throw new Error(`Failed to start debugging: ${error}`);
        }
    }

    /**
     * Start a debugging session by configuration name (for gdbtarget/CMSIS configs)
     * Passes the config name directly to VS Code, letting it resolve from launch.json
     */
    public async startDebuggingByName(
        workingDirectory: string,
        configurationName: string
    ): Promise<boolean> {
        try {
            const workspaceFolder = this.resolveWorkspaceFolder(workingDirectory);
            if (!workspaceFolder) {
                const open = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
                throw new Error(
                    `No VS Code workspace folder matches workingDirectory '${workingDirectory}'. ` +
                    `Open workspace folders: ${open.length ? open.join(', ') : '(none)'}. ` +
                    `launch.json is resolved relative to an open workspace folder — open the project folder ` +
                    `(the one containing .vscode/launch.json) in this VS Code window.`
                );
            }
            return await vscode.debug.startDebugging(workspaceFolder, configurationName);
        } catch (error) {
            throw new Error(`Failed to start debugging with configuration '${configurationName}': ${error}`);
        }
    }

    /**
     * Robustly map a working-directory path to an open VS Code workspace
     * folder. `vscode.workspace.getWorkspaceFolder` requires the URI to be
     * inside a folder and is sensitive to trailing slashes / exact casing, so
     * a wrong `workingDirectory` argument silently yields `undefined` and VS
     * Code then throws "launch.json does not exist for passed workspace
     * folder". This tries, in order: exact API lookup → path-prefix match in
     * either direction → the sole workspace folder when there is only one.
     */
    private resolveWorkspaceFolder(workingDirectory: string): vscode.WorkspaceFolder | undefined {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) { return undefined; }

        // 1) Exact VS Code lookup.
        const direct = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workingDirectory));
        if (direct) { return direct; }

        // 2) Path-prefix match, trailing slashes normalised, in both directions
        //    (workingDirectory may be a parent of, or nested under, a folder).
        const norm = (p: string) => p.replace(/[/\\]+$/, '');
        const wd = norm(workingDirectory);
        for (const f of folders) {
            const fp = norm(f.uri.fsPath);
            if (fp === wd || wd.startsWith(fp + '/') || fp.startsWith(wd + '/')) {
                return f;
            }
        }

        // 3) Single-folder workspace — unambiguous, use it.
        if (folders.length === 1) { return folders[0]; }

        return undefined;
    }

    /**
     * Stop the debugging session
     */
    public async stopDebugging(session?: vscode.DebugSession): Promise<void> {
        try {
            const activeSession = session || resolveActiveSession();
            if (activeSession) {
                await vscode.debug.stopDebugging(activeSession);
            }
        } catch (error) {
            throw new Error(`Failed to stop debugging: ${error}`);
        }
    }

    /**
     * Execute step over command
     */
    public async stepOver(timeoutMs?: number): Promise<void> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await customRequestWithTimeout(session, 'next', { threadId }, capTimeout(timeoutMs, this.timeouts.dapRequestMs));
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            // Fallback to UI command for non-timeout failures
            await vscode.commands.executeCommand('workbench.action.debug.stepOver');
        }
    }

    /**
     * Execute step into command
     */
    public async stepInto(timeoutMs?: number): Promise<void> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await customRequestWithTimeout(session, 'stepIn', { threadId }, capTimeout(timeoutMs, this.timeouts.dapRequestMs));
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            await vscode.commands.executeCommand('workbench.action.debug.stepInto');
        }
    }

    /**
     * Execute step out command
     */
    public async stepOut(timeoutMs?: number): Promise<void> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await customRequestWithTimeout(session, 'stepOut', { threadId }, capTimeout(timeoutMs, this.timeouts.dapRequestMs));
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            await vscode.commands.executeCommand('workbench.action.debug.stepOut');
        }
    }

    /**
     * Execute continue command
     */
    public async continue(timeoutMs?: number): Promise<void> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await customRequestWithTimeout(session, 'continue', { threadId }, capTimeout(timeoutMs, this.timeouts.dapRequestMs));
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            // Fallback to UI command for non-timeout failures
            await vscode.commands.executeCommand('workbench.action.debug.continue');
        }
    }

    /**
     * Pause a running target via DAP `pause`. Used to halt the CPU so
     * inspection tools (variables / memory / registers) become valid.
     */
    public async pause(timeoutMs?: number): Promise<void> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await customRequestWithTimeout(session, 'pause', { threadId }, capTimeout(timeoutMs, this.timeouts.dapRequestMs));
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            // Fallback to UI command for non-timeout failures
            await vscode.commands.executeCommand('workbench.action.debug.pause');
        }
    }

    /**
     * Block until the target next stops (breakpoint, fault, step-complete,
     * pause) and report the stop reason, or until the timeout / session end.
     * If the target is already stopped the agent's question is answered —
     * return the recorded reason rather than waiting for a *future* event.
     * Issues no execution commands itself.
     */
    public async waitForStop(timeoutMs?: number): Promise<StopWaitResult | { kind: 'already-stopped'; reason: string | null }> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        if (isSessionStopped(session)) {
            return { kind: 'already-stopped' as const, reason: getStoppedReason(session) };
        }
        return waitForStopEvent(session, capTimeout(timeoutMs, HARD_CALL_CAP_MS));
    }

    /**
     * Get the active thread ID from the current stack item or default to 1.
     */
    private getActiveThreadId(): number {
        const activeStackItem = vscode.debug.activeStackItem;
        if (activeStackItem && 'threadId' in activeStackItem) {
            return activeStackItem.threadId;
        }
        return 1; // Default thread for single-core targets
    }

    /**
     * Execute restart command
     */
    public async restart(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.restart');
        } catch (error) {
            throw new Error(`Failed to restart: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location
     */
    public async addBreakpoint(
        uri: vscode.Uri,
        line: number,
        options?: { condition?: string; logMessage?: string }
    ): Promise<void> {
        try {
            const breakpoint = new vscode.SourceBreakpoint(
                new vscode.Location(uri, new vscode.Position(line - 1, 0)),
                true,
                options?.condition,
                undefined,
                options?.logMessage,
            );
            vscode.debug.addBreakpoints([breakpoint]);
        } catch (error) {
            throw new Error(`Failed to add breakpoint: ${error}`);
        }
    }

    /**
     * Run a raw GDB CLI command through the DAP `evaluate` REPL channel
     * (`-exec <cmd>`).
     *
     * Important quirk: for side-effecting commands like `break` / `delete`,
     * the `gdbtarget` adapter *runs the command* (the breakpoint binds, the
     * delete happens) but the `evaluate` *response* is frequently empty or an
     * error ("could not evaluate expression", "without frameId is not
     * supported") because the adapter has no scalar `result` to hand back.
     * So the evaluate response is NOT a reliable success signal — this helper
     * never throws on an evaluate error; it returns the raw text (result or
     * error message) plus an `errored` flag, and the caller decides whether
     * the text contains a *definite* GDB rejection.
     *
     * A frameId is always supplied when one is available, since the adapter
     * rejects REPL evaluates without one.
     */
    private async execGdbCommand(command: string, timeoutMs?: number): Promise<{ raw: string; errored: boolean }> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);
        const debugState = await this.getCurrentDebugState(0);
        const frameOpt = debugState.frameId !== null ? { frameId: debugState.frameId } : {};
        try {
            const result = await customRequestWithTimeout<any>(session, 'evaluate', {
                expression: `-exec ${command}`,
                context: 'repl',
                ...frameOpt,
            }, dapMs);
            return { raw: (result?.result ?? '').toString().trim(), errored: false };
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            // Adapter returned an error response — the command itself may
            // still have run. Surface the text, do not treat as fatal.
            return { raw: (err instanceof Error ? err.message : String(err)).trim(), errored: true };
        }
    }

    /**
     * Bind a breakpoint GDB-native via `-exec break file:line`.
     *
     * `vscode.debug.addBreakpoints()` populates VS Code's breakpoint *model*,
     * but on `gdbtarget` sessions the resulting `setBreakpoints` DAP request
     * is not reliably forwarded to the adapter — the target never stops.
     * Issuing `break` through the GDB REPL is exactly what a raw GDB session
     * does and binds the breakpoint for real. Returns the raw GDB/adapter
     * text; the caller interprets it (a missing "Breakpoint N" echo is NOT a
     * failure — see execGdbCommand).
     *
     * A `condition` is appended as GDB's native `if <expr>` clause, so the CPU
     * is only halted when it holds. That matters far more on a Cortex-M than in
     * a host process: a VS Code-side condition would still stop the core on
     * every hit and evaluate afterwards, wrecking timing in a hot loop.
     */
    public async setBreakpointViaGdb(
        fileFullPath: string,
        line: number,
        timeoutMs?: number,
        condition?: string,
    ): Promise<string> {
        const cond = condition?.trim() ? ` if ${condition.trim()}` : '';
        const { raw } = await this.execGdbCommand(`break ${fileFullPath}:${line}${cond}`, timeoutMs);
        return raw;
    }

    /**
     * Bind a logpoint GDB-native via `-exec dprintf file:line,"fmt",args`.
     *
     * GDB's `dprintf` is the exact analogue of a VS Code logpoint: it prints
     * and resumes rather than halting. The core is still halted momentarily per
     * hit (nothing on a Cortex-M can print without stopping it), so this is not
     * free — see the tool description.
     *
     * `format` must already be a printf format string and `args` the matching
     * expression list; translation from the `{expr}` logpoint syntax happens in
     * the handler, which is where the specifier rules are documented.
     */
    public async setLogpointViaGdb(
        fileFullPath: string,
        line: number,
        format: string,
        args: string[],
        timeoutMs?: number,
    ): Promise<string> {
        const argList = args.length > 0 ? `,${args.join(',')}` : '';
        const { raw } = await this.execGdbCommand(
            `dprintf ${fileFullPath}:${line},"${format}"${argList}`,
            timeoutMs,
        );
        return raw;
    }

    /**
     * Attach a condition to an already-created GDB breakpoint by number.
     * Used for conditional logpoints: `dprintf` takes no inline `if` clause.
     */
    public async setBreakpointConditionViaGdb(
        breakpointNumber: number,
        condition: string,
        timeoutMs?: number,
    ): Promise<string> {
        const { raw } = await this.execGdbCommand(`condition ${breakpointNumber} ${condition}`, timeoutMs);
        return raw;
    }

    /**
     * Remove GDB-native breakpoints at a file:line via `-exec clear file:line`.
     */
    public async clearBreakpointViaGdb(fileFullPath: string, line: number, timeoutMs?: number): Promise<string> {
        const { raw } = await this.execGdbCommand(`clear ${fileFullPath}:${line}`, timeoutMs);
        return raw;
    }

    /**
     * Delete every GDB-native breakpoint via `-exec delete`.
     */
    public async clearAllBreakpointsViaGdb(timeoutMs?: number): Promise<string> {
        const { raw } = await this.execGdbCommand('delete', timeoutMs);
        return raw;
    }

    /**
     * Remove a breakpoint from specified location
     */
    public async removeBreakpoint(uri: vscode.Uri, line: number): Promise<void> {
        try {
            const breakpoints = vscode.debug.breakpoints.filter(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    return bp.location.uri.toString() === uri.toString() && 
                           bp.location.range.start.line === line - 1;
                }
                return false;
            });
            
            if (breakpoints.length > 0) {
                vscode.debug.removeBreakpoints(breakpoints);
            }
        } catch (error) {
            throw new Error(`Failed to remove breakpoint: ${error}`);
        }
    }

    /**
     * Get current debugging state
     */
    public async getCurrentDebugState(numNextLines: number = 3): Promise<DebugState> {
        const state = new DebugState();
        
        try {
            const activeSession = resolveActiveSession();
            if (activeSession) {
                state.sessionActive = true;
                state.updateConfigurationName(activeSession.configuration.name ?? null);
                
                const activeStackItem = vscode.debug.activeStackItem;
                if (activeStackItem && 'frameId' in activeStackItem) {
                    state.updateContext(activeStackItem.frameId, activeStackItem.threadId);

                    // Take the current location from the debug adapter's top
                    // stack frame rather than the active text editor. VS Code
                    // moves the editor cursor asynchronously after a stop, and
                    // only for the focused editor — reading it here lagged the
                    // actual stop and reported the wrong file whenever focus was
                    // elsewhere. On a gdbtarget session the editor may not track
                    // the target at all. The DAP frame is ground truth.
                    const topFrame = await this.extractFrameName(activeSession, activeStackItem.frameId, state);

                    if (topFrame?.path && typeof topFrame.line === 'number') {
                        await this.populateLocationFromFrame(state, topFrame.path, topFrame.line, numNextLines);
                    }
                }
            }
        } catch (error) {
            console.log('Unable to get debug state:', error);
        }
        
        // Populate breakpoints as compact "fileName:line" strings
        const breakpoints = vscode.debug.breakpoints;
        const formattedBreakpoints = breakpoints
            .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
            .map(bp => {
                const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop() || 'unknown';
                const line = bp.location.range.start.line + 1;
                return `${fileName}:${line}${formatBreakpointModifiers(bp)}`;
            });
        state.updateBreakpoints(formattedBreakpoints);

        return state;
    }

    /**
     * Extract frame name and stack trace from the current debug session.
     *
     * Returns the top frame's source location so the caller can report the
     * authoritative current position without scraping the editor. Returns
     * undefined when no stack frame is available.
     */
    private async extractFrameName(
        session: vscode.DebugSession,
        frameId: number,
        state: DebugState
    ): Promise<{ path?: string; line?: number; column?: number } | undefined> {
        try {
            // Get full stack trace (up to 50 frames)
            const stackTraceResponse = await customRequestWithTimeout<any>(session, 'stackTrace', {
                threadId: state.threadId,
                startFrame: 0,
                levels: 50
            }, this.timeouts.dapRequestMs);

            if (stackTraceResponse?.stackFrames && stackTraceResponse.stackFrames.length > 0) {
                // Extract frame name from current frame
                const currentFrame = stackTraceResponse.stackFrames[0];
                state.updateFrameName(currentFrame.name || null);

                // Build stack trace array
                const stackTrace: StackFrame[] = stackTraceResponse.stackFrames.map((frame: any) => ({
                    name: frame.name || 'unknown',
                    source: frame.source?.path || frame.source?.name || undefined,
                    line: frame.line || undefined,
                    column: frame.column || undefined,
                }));

                state.updateStackTrace(stackTrace);

                // DAP line/column are 1-based (VS Code's default). Hand the raw
                // top-frame location back for location reporting.
                return {
                    path: currentFrame.source?.path,
                    line: currentFrame.line,
                    column: currentFrame.column,
                };
            }
        } catch (error) {
            console.log('Unable to extract stack info:', error);
            // Set empty values on error
            state.updateFrameName(null);
            state.updateStackTrace([]);
        }
        return undefined;
    }

    /**
     * Populate the DebugState location (file, current line + content, and the
     * next few non-empty lines) by reading the source document at the debugger's
     * current frame line. Uses the DAP-reported path/line rather than the active
     * editor, so it is accurate regardless of which editor (if any) has focus.
     */
    private async populateLocationFromFrame(
        state: DebugState,
        filePath: string,
        line: number,
        numNextLines: number
    ): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const zeroBasedLine = Math.max(0, Math.min(line - 1, doc.lineCount - 1));
            const fileName = filePath.split(/[/\\]/).pop() || '';
            const currentLineContent = doc.lineAt(zeroBasedLine).text.trim();

            // Collect the next non-empty lines for lookahead context.
            const nextLines: string[] = [];
            let lineOffset = 1;
            while (nextLines.length < numNextLines && zeroBasedLine + lineOffset < doc.lineCount) {
                const lineText = doc.lineAt(zeroBasedLine + lineOffset).text.trim();
                if (lineText.length > 0) {
                    nextLines.push(lineText);
                }
                lineOffset++;
            }

            state.updateLocation(filePath, fileName, line, currentLineContent, nextLines);
        } catch (error) {
            // Firmware stops in assembly, ROM, or a library the workspace has no
            // source for — very common on Cortex-M. Degrade gracefully and leave
            // the location unset rather than failing the whole state read.
            console.log('Unable to read frame source document:', error);
        }
    }

    /**
     * Get variables from the current debug context
     */
    public async getVariables(frameId: number, scope?: 'local' | 'global' | 'all', timeoutMs?: number): Promise<any> {
        try {
            const activeSession = resolveActiveSession();
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);
            const response = await customRequestWithTimeout<any>(activeSession, 'scopes', { frameId }, dapMs);

            if (!response || !response.scopes || response.scopes.length === 0) {
                return { scopes: [] };
            }

            const filteredScopes = response.scopes.filter((scopeItem: any) => {
                if (scope === 'all') {return true;}
                const scopeName = scopeItem.name.toLowerCase();
                if (scope === 'local') {return scopeName.includes('local');}
                if (scope === 'global') {return scopeName.includes('global');}
                return true;
            });

            // Get variables for each scope
            for (const scopeItem of filteredScopes) {
                try {
                    const variablesResponse = await customRequestWithTimeout<any>(activeSession, 'variables', {
                        variablesReference: scopeItem.variablesReference
                    }, dapMs);
                    scopeItem.variables = variablesResponse.variables || [];
                } catch (scopeError) {
                    scopeItem.variables = [];
                    scopeItem.error = scopeError instanceof Error ? scopeError.message : String(scopeError);
                }
            }

            return { scopes: filteredScopes };
        } catch (error) {
            throw new Error(`Failed to get variables: ${error}`);
        }
    }

    /**
     * Evaluate an expression in the current debug context
     */
    public async evaluateExpression(expression: string, frameId: number, timeoutMs?: number): Promise<any> {
        try {
            const activeSession = resolveActiveSession();
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const response = await customRequestWithTimeout<any>(activeSession, 'evaluate', {
                expression: expression,
                frameId: frameId,
                context: 'repl'
            }, capTimeout(timeoutMs, this.timeouts.dapRequestMs));

            return response;
        } catch (error) {
            throw new Error(`Failed to evaluate expression: ${error}`);
        }
    }


    /**
     * Get all active breakpoints
     */
    public getBreakpoints(): readonly vscode.Breakpoint[] {
        return vscode.debug.breakpoints;
    }

    /**
     * Clear all breakpoints
     */
    public clearAllBreakpoints(): void {
        const breakpoints = vscode.debug.breakpoints;
        if (breakpoints.length > 0) {
            vscode.debug.removeBreakpoints(breakpoints);
        }
    }

    /**
     * Cheapest possible "is the debugger attached?" check — synchronous, no
     * DAP traffic. Returns true as long as VS Code reports an active debug
     * session, regardless of whether the target is currently stopped.
     *
     * Use this when you only need to know whether a session exists (e.g.
     * stop_debugging, restart_debugging, status reporting). Use
     * {@link hasActiveSession} when you also need a stopped stack frame
     * (e.g. variables, memory, registers, step/continue).
     */
    public hasDebugSession(): boolean {
        return resolveActiveSession() !== undefined;
    }

    /**
     * Check if there's an active debug session that is ready for debugging operations.
     *
     * "Ready" means: VS Code has a session, the DAP probe is responsive, and
     * a stopped stack frame is available. This is the gate used by tools that
     * need to inspect target state (variables, memory, registers, step, ...).
     *
     * Performs a cheap DAP `threads` probe with a short timeout rather than
     * issuing a full `stackTrace`. That keeps the gate fast when the probe
     * is healthy and guarantees we don't hang indefinitely when it is not.
     */
    public async hasActiveSession(): Promise<boolean> {
        const session = resolveActiveSession();
        if (!session) {
            return false;
        }

        try {
            // Use a short timeout — this is the readiness gate called before
            // every tool invocation, so it must never block.
            const probeTimeout = Math.min(this.timeouts.dapRequestMs, 3000);
            await customRequestWithTimeout(session, 'threads', {}, probeTimeout);
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                logger.warn('hasActiveSession: threads probe timed out — probe or target may be unresponsive');
                return false;
            }
            // Non-timeout errors: session exists but is not ready yet (e.g. still initializing)
            logger.debug('hasActiveSession: threads probe failed', err);
            return false;
        }

        // Session answered DAP — now confirm the target is actually paused.
        // We use the DAP stopped/continued event tracker rather than
        // `activeStackItem`, because the latter is `undefined` whenever the
        // CPU is running *and* during the brief race window right after a
        // stop event before VS Code surfaces the new stack frame.
        return isSessionStopped(session);
    }

    /**
     * Classify the current debug session for status-reporting purposes.
     * Never throws; intended to be safe to call even when the probe is hung.
     */
    /**
     * Low-level diagnostics — lets the agent tell apart "no session" from
     * "stale extension build" or "debug session is in another VS Code window".
     */
    public getDiagnostics(): ExecutorDiagnostics {
        return {
            serverVersion: SERVER_VERSION,
            liveSessionCount: getLiveSessionCount(),
            liveSessionNames: getLiveSessionNames(),
            hasVscodeActiveSession: vscode.debug.activeDebugSession !== undefined,
        };
    }

    public async getSessionStatus(): Promise<SessionStatus> {
        const session = resolveActiveSession();
        if (!session) {
            return {
                state: 'no-session',
                sessionName: null,
                sessionType: null,
                configurationName: null,
                dapResponsive: false,
                dapProbeMs: null,
            };
        }

        const base = {
            sessionName: session.name,
            sessionType: session.type ?? null,
            configurationName: session.configuration?.name ?? null,
        };

        const probeTimeout = Math.min(this.timeouts.dapRequestMs, 3000);
        const start = Date.now();
        try {
            await customRequestWithTimeout(session, 'threads', {}, probeTimeout);
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                return {
                    ...base,
                    state: 'unresponsive',
                    dapResponsive: false,
                    dapProbeMs: null,
                    detail: `DAP threads probe timed out after ${probeTimeout}ms — probe/target may be hung.`,
                };
            }
            // Most likely the adapter is still initializing.
            return {
                ...base,
                state: 'initializing',
                dapResponsive: false,
                dapProbeMs: null,
                detail: `DAP threads probe failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }

        const dapProbeMs = Date.now() - start;
        // Use the DAP event tracker as the authoritative stopped/running
        // signal — `activeStackItem` is unreliable while the target is
        // running and during the brief race after a stop event.
        const stopped = isSessionStopped(session);
        const reason = stopped ? getStoppedReason(session) : null;

        return {
            ...base,
            state: stopped ? 'stopped' : 'running',
            dapResponsive: true,
            dapProbeMs,
            detail: reason ? `Stopped reason: ${reason}` : undefined,
        };
    }

    /**
     * Perform a low-cost connectivity probe against the debug target.
     * Returns a short, human-readable status string.
     */
    public async checkTargetConnection(): Promise<string> {
        const status = await this.getSessionStatus();
        const lines: string[] = [];

        if (status.state === 'no-session') {
            return 'No active debug session.';
        }

        lines.push(`Session: ${status.sessionName} (type=${status.sessionType ?? 'unknown'})`);
        if (status.configurationName) {
            lines.push(`Configuration: ${status.configurationName}`);
        }

        switch (status.state) {
            case 'unresponsive':
                lines.push(`DAP probe: TIMEOUT — probe/target unresponsive`);
                if (status.detail) { lines.push(status.detail); }
                break;
            case 'initializing':
                lines.push(`DAP probe: FAILED — adapter likely still initializing`);
                if (status.detail) { lines.push(status.detail); }
                break;
            case 'running':
                lines.push(`DAP probe: OK (${status.dapProbeMs}ms)`);
                lines.push('Target state: running — DAP reads (memory/registers/variables) will be rejected until the target stops.');
                break;
            case 'stopped':
                lines.push(`DAP probe: OK (${status.dapProbeMs}ms)`);
                lines.push('Target state: stopped — full inspection is available.');
                break;
        }

        return lines.join('\n');
    }

    /**
     * Get the active debug session
     */
    public getActiveSession(): vscode.DebugSession | undefined {
        return resolveActiveSession();
    }

    // ========== Embedded / Cortex-M specific methods ==========

    /**
     * Read a range of bytes from target memory.
     * Tries DAP readMemory first, falls back to GDB evaluate.
     */
    public async readMemory(address: string, length: number, timeoutMs?: number): Promise<Buffer> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }

        // Normalize address to ensure 0x prefix
        const addr = address.startsWith('0x') || address.startsWith('0X') ? address : `0x${address}`;

        const overallMs = capTimeout(timeoutMs, this.timeouts.memoryReadMs);
        const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);

        // Cap the total time spent reading memory — bounds the worst-case when
        // the DAP readMemory fallback loops over many words.
        return withTimeout('readMemory', overallMs, async () => {
            try {
                // Try DAP readMemory (supported by CDT GDB Adapter / Memory Inspector)
                const response = await customRequestWithTimeout<any>(session, 'readMemory', {
                    memoryReference: addr,
                    count: length,
                }, dapMs);
                if (!response.data) {
                    throw new Error(`No data returned for address ${addr} (${response.unreadableBytes ?? length} unreadable bytes)`);
                }
                return Buffer.from(response.data, 'base64');
            } catch (dapError) {
                if (dapError instanceof HardwareTimeoutError) { throw dapError; }
                // Fallback: use GDB evaluate to read 32-bit words
                const wordCount = Math.ceil(length / 4);
                const byteValues: number[] = [];
                const debugState = await this.getCurrentDebugState(0);
                const frameOpt: Record<string, number> | undefined = debugState.frameId !== null ? { frameId: debugState.frameId } : undefined;

                for (let w = 0; w < wordCount; w++) {
                    const wordAddr = BigInt(addr) + BigInt(w * 4);
                    const hexAddr = `0x${wordAddr.toString(16)}`;
                    const val = await this.evaluateMemoryWord(session, hexAddr, frameOpt);
                    // Little-endian: push 4 bytes
                    byteValues.push(val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >>> 24) & 0xFF);
                }

                // Trim to requested length
                return Buffer.from(byteValues.slice(0, length));
            }
        });
    }

    /**
     * Read a single 32-bit word from target memory (little-endian).
     */
    public async readMemoryWord(address: string, timeoutMs?: number): Promise<number> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }

        const addr = address.startsWith('0x') || address.startsWith('0X') ? address : `0x${address}`;
        const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);

        try {
            const response = await customRequestWithTimeout<any>(session, 'readMemory', {
                memoryReference: addr,
                count: 4,
            }, dapMs);
            if (!response.data) {
                throw new Error('No data returned');
            }
            const buf = Buffer.from(response.data, 'base64');
            return buf.readUInt32LE(0);
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            // Fallback: GDB evaluate
            return await this.evaluateMemoryWord(session, addr);
        }
    }

    /**
     * Evaluate a 32-bit memory word via GDB with multiple fallback strategies.
     * Tries: (1) evaluate with 'watch' context, (2) evaluate with 'repl' context using -exec.
     */
    private async evaluateMemoryWord(
        session: vscode.DebugSession,
        hexAddr: string,
        frameOpt?: Record<string, number>
    ): Promise<number> {
        if (!frameOpt) {
            const debugState = await this.getCurrentDebugState(0);
            frameOpt = debugState.frameId !== null ? { frameId: debugState.frameId } : {};
        }

        // Strategy 1: evaluate expression in watch context
        try {
            const result = await customRequestWithTimeout<any>(session, 'evaluate', {
                expression: `*(unsigned int*)${hexAddr}`,
                context: 'watch',
                ...frameOpt,
            }, this.timeouts.dapRequestMs);
            if (result?.result) {
                const val = this.parseGdbIntResult(result.result);
                if (val !== null) { return val; }
            }
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            // Fall through to next strategy
        }

        // Strategy 2: GDB x command via REPL context
        try {
            const result = await customRequestWithTimeout<any>(session, 'evaluate', {
                expression: `-exec x/1xw ${hexAddr}`,
                context: 'repl',
                ...frameOpt,
            }, this.timeouts.dapRequestMs);
            if (result?.result) {
                // GDB x output: "0x20000000:\t0x12345678"
                const match = result.result.match(/:\s*(0x[0-9a-fA-F]+)/);
                if (match) {
                    const val = parseInt(match[1], 16);
                    if (!isNaN(val)) { return val; }
                }
            }
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            // Fall through to next strategy
        }

        // Strategy 3: evaluate with hex dereference in repl context
        try {
            const result = await customRequestWithTimeout<any>(session, 'evaluate', {
                expression: `-exec print/x *(unsigned int*)${hexAddr}`,
                context: 'repl',
                ...frameOpt,
            }, this.timeouts.dapRequestMs);
            if (result?.result) {
                // GDB print output: "$1 = 0x12345678"
                const match = result.result.match(/(0x[0-9a-fA-F]+)/);
                if (match) {
                    const val = parseInt(match[1], 16);
                    if (!isNaN(val)) { return val; }
                }
            }
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            // All strategies failed
        }

        throw new Error(`Failed to read memory at ${hexAddr} — all GDB strategies exhausted`);
    }

    /**
     * Parse a GDB integer result that may be hex (0x...) or decimal.
     * Returns null if unparseable.
     */
    private parseGdbIntResult(raw: string): number | null {
        const trimmed = raw.trim();
        if (!trimmed) { return null; }
        const val = trimmed.startsWith('0x') || trimmed.startsWith('0X')
            ? parseInt(trimmed, 16)
            : parseInt(trimmed, 10);
        return isNaN(val) ? null : val;
    }

    /**
     * Write a single 32-bit word to target memory (little-endian) and verify
     * it stuck. DAP `writeMemory` first; falls back to GDB `set` via the REPL
     * for adapters without it. The read-back is not optional — a silently
     * dropped write is exactly how "reset did nothing" happens in the field.
     * (Caveat: genuinely write-only registers would false-fail the read-back;
     * AIRCR/DEMCR/DWT_CTRL — the registers this exists for — are all readable.)
     */
    public async writeMemoryWord(address: string, value: number, timeoutMs?: number): Promise<void> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }

        const addr = address.startsWith('0x') || address.startsWith('0X') ? address : `0x${address}`;
        const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);

        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(value >>> 0, 0);
        try {
            await customRequestWithTimeout<any>(session, 'writeMemory', {
                memoryReference: addr,
                data: buf.toString('base64'),
            }, dapMs);
        } catch (err) {
            if (err instanceof HardwareTimeoutError) { throw err; }
            await this.execGdbCommand(`set {unsigned int}${addr} = ${value >>> 0}`, dapMs);
        }

        const readBack = await this.readMemoryWord(addr, dapMs);
        if ((readBack >>> 0) !== (value >>> 0)) {
            throw new Error(
                `Write to ${addr} did not stick (wrote 0x${(value >>> 0).toString(16).padStart(8, '0')}, ` +
                `read back 0x${(readBack >>> 0).toString(16).padStart(8, '0')})`
            );
        }
    }

    /**
     * Reset the target via GDB monitor commands and VERIFY the reset actually
     * took effect. `restart_debugging` restarts the whole VS Code session;
     * this resets the target inside the live session (breakpoints survive) —
     * and reports honestly when the target did not appear to reset, because
     * silent non-resets on attach configurations are a recurring field issue.
     *
     * Verification is PC-vs-reset-vector: after a halted reset the PC must
     * equal the reset handler read from the vector table (VTOR-based, falling
     * back to table base 0). 'auto' escalates system → core → hardware until
     * one verifies. With halt=false the target is verified halted first, then
     * resumed — the verification needs a stopped snapshot.
     */
    public async resetTarget(options: { method?: 'auto' | ResetMethod; halt?: boolean; timeoutMs?: number }): Promise<ResetOutcome> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        const leaveHalted = options.halt !== false; // default true
        const dapMs = capTimeout(options.timeoutMs, this.timeouts.dapRequestMs);

        const config = session.configuration ?? {};
        const outcome: ResetOutcome = {
            serverKind: detectGdbServerKind(`${config.target?.server ?? ''} ${config.debugger?.name ?? ''} ${session.name}`),
            methodsTried: [],
            commandsIssued: [],
            replies: [],
            verified: false,
            verificationDetail: 'not attempted',
            haltedByUs: false,
        };

        // A reset must be issued from a halted state — halt a running target first.
        if (!isSessionStopped(session)) {
            await this.pause(dapMs);
            const stop = await waitForStopEvent(session, 5_000);
            if (stop.kind !== 'stopped') {
                outcome.verificationDetail = 'could not halt the target to issue the reset (pause did not stop it within 5 s)';
                return outcome;
            }
            outcome.haltedByUs = true;
        }

        const methods: ResetMethod[] = (!options.method || options.method === 'auto')
            ? ['system', 'core', 'hardware']
            : [options.method];

        for (const method of methods) {
            outcome.methodsTried.push(method);
            // Always issue the halting form — the verification needs a stopped
            // snapshot; a 'run'-mode reset would race the PC read. The target
            // is resumed at the end when the caller asked for halt=false.
            const commands = buildResetCommands(outcome.serverKind, method, true);
            let unsupported = false;
            for (const cmd of commands) {
                outcome.commandsIssued.push(cmd);
                const reply = await this.execGdbCommand(cmd, dapMs);
                outcome.replies.push(reply.raw || '<no echo from adapter>');
                if (replyLooksUnsupported(reply.raw)) { unsupported = true; }
            }
            if (unsupported) {
                outcome.verificationDetail = `adapter did not recognize the ${method} reset command — trying the next method`;
                continue;
            }

            // Most adapters emit a stopped event when the reset-halt lands;
            // some don't. Wait briefly, then settle either way.
            const stop = await waitForStopEvent(session, 3_000);
            if (stop.kind === 'ended') {
                outcome.verificationDetail = 'debug session ended during the reset';
                return outcome;
            }
            await new Promise(resolve => setTimeout(resolve, 500));

            const verification = await this.verifyResetViaVectorTable(dapMs);
            outcome.verificationDetail = verification.detail;
            if (verification.verified) {
                outcome.verified = true;
                break;
            }
        }

        if (outcome.verified && !leaveHalted) {
            await this.continue(dapMs);
        }
        return outcome;
    }

    /**
     * Compare the live PC against the reset handler read from the vector
     * table. The table base comes from VTOR (0xE000ED08, TBLOFF is bits 31:7)
     * with a fallback to base 0 when VTOR reads as 0 or fails. All address
     * math stays unsigned (>>> 0) — vector tables at 0x80000000+ are common
     * (e.g. MRAM-aliased parts) and would go negative under int32 coercion.
     */
    private async verifyResetViaVectorTable(dapMs: number): Promise<{ verified: boolean; detail: string }> {
        const hex = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
        try {
            let vectorBase = 0;
            try {
                const vtor = await this.readMemoryWord('0xE000ED08', dapMs);
                if (vtor !== 0) { vectorBase = (vtor & 0xFFFFFF80) >>> 0; }
            } catch {
                // Fall back to table base 0 — pre-VTOR boot state or unreadable SCS.
            }
            const resetVector = ((await this.readMemoryWord(hex(vectorBase + 4), dapMs)) & 0xFFFFFFFE) >>> 0;
            const pc = (await this.readProgramCounter(dapMs) & 0xFFFFFFFE) >>> 0;
            const verified = pc === resetVector;
            return {
                verified,
                detail: verified
                    ? `PC=${hex(pc)} matches the reset vector (${hex(resetVector)}, vector table at ${hex(vectorBase)})`
                    : `PC=${hex(pc)} does NOT match the reset vector ${hex(resetVector)} (vector table at ${hex(vectorBase)})`,
            };
        } catch (err) {
            return { verified: false, detail: `verification reads failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    /**
     * Read the program counter via `$pc` evaluate, tolerating a symbol
     * annotation in the reply ("0x080001a0 <Reset_Handler+4>").
     */
    private async readProgramCounter(dapMs: number): Promise<number> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        const debugState = await this.getCurrentDebugState(0);
        const frameOpt = debugState.frameId !== null ? { frameId: debugState.frameId } : {};
        const response = await customRequestWithTimeout<any>(session, 'evaluate', {
            expression: '$pc',
            context: 'watch',
            ...frameOpt,
        }, dapMs);
        const match = String(response?.result ?? '').match(/0x[0-9a-fA-F]+/);
        if (!match) { throw new Error(`could not parse PC from '${response?.result ?? '<empty>'}'`); }
        return parseInt(match[0], 16);
    }

    /**
     * Read Cortex-M core registers (R0-R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK).
     */
    public async readCoreRegisters(timeoutMs?: number): Promise<Record<string, string>> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }

        const registerNames = [
            'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7',
            'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc',
            'xpsr', 'msp', 'psp', 'control', 'faultmask', 'basepri', 'primask',
        ];

        const debugState = await this.getCurrentDebugState(0);
        const frameOpt = debugState.frameId !== null ? { frameId: debugState.frameId } : {};

        const overallMs = capTimeout(timeoutMs, this.timeouts.memoryReadMs);
        const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);

        // Cap the overall time spent reading every register. Fire requests in
        // parallel so one stalled register does not block the rest, and swallow
        // per-register timeouts individually so we always return a best-effort
        // snapshot rather than nothing.
        return withTimeout('readCoreRegisters', overallMs, async () => {
            const entries = await Promise.all(registerNames.map(async (reg) => {
                try {
                    const response = await customRequestWithTimeout<any>(session, 'evaluate', {
                        expression: `$${reg}`,
                        context: 'watch',
                        ...frameOpt,
                    }, dapMs);
                    return [reg, response.result] as const;
                } catch (err) {
                    if (err instanceof HardwareTimeoutError) {
                        return [reg, '<timeout>'] as const;
                    }
                    return [reg, '<unavailable>'] as const;
                }
            }));
            return Object.fromEntries(entries);
        });
    }

    /**
     * Read the DWT cycle counter (CYCCNT), enabling trace + the counter when
     * needed. Returns `present: false` on cores without a cycle counter
     * (DWT_CTRL.NOCYCCNT). `enabledNow` tells the caller the counter was
     * started by this call, so earlier deltas are not available. Note the
     * counter stops while the core is halted AND during WFE sleep — it
     * counts active cycles only — and wraps every 2^32 cycles.
     */
    public async readCycleCounter(timeoutMs?: number): Promise<{ cycles: number; enabledNow: boolean; present: boolean }> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        const overallMs = capTimeout(timeoutMs, this.timeouts.memoryReadMs);
        const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);
        return withTimeout('readCycleCounter', overallMs, async () => {
            // DEMCR.TRCENA gates the whole DWT unit — enable it if it is off.
            const demcr = await this.readMemoryWord(DWT_ADDRESSES.DEMCR, dapMs);
            if (!(demcr & DEMCR_TRCENA)) {
                await this.writeMemoryWord(DWT_ADDRESSES.DEMCR, (demcr | DEMCR_TRCENA) >>> 0, dapMs);
            }
            const ctrl = await this.readMemoryWord(DWT_ADDRESSES.DWT_CTRL, dapMs);
            if (ctrl & DWT_CTRL_NOCYCCNT) {
                return { present: false, cycles: 0, enabledNow: false };
            }
            let enabledNow = false;
            if (!(ctrl & DWT_CTRL_CYCCNTENA)) {
                await this.writeMemoryWord(DWT_ADDRESSES.DWT_CTRL, (ctrl | DWT_CTRL_CYCCNTENA) >>> 0, dapMs);
                enabledNow = true;
            }
            const cycles = (await this.readMemoryWord(DWT_ADDRESSES.DWT_CYCCNT, dapMs)) >>> 0;
            return { present: true, cycles, enabledNow };
        });
    }

    /**
     * Read peripheral register(s) using the Peripheral Inspector or memory fallback.
     */
    public async readPeripheralRegister(peripheral: string, register?: string, timeoutMs?: number): Promise<string> {
        // Dynamic import to avoid hard dependency at module level
        const { tryReadPeripheralViaExtension, readPeripheralViaMemory } = await import('./core/peripheralReader.js');

        // Try the Peripheral Inspector extension first
        const piResult = await tryReadPeripheralViaExtension(peripheral, register);
        if (piResult !== null) {
            return piResult;
        }

        // Fallback to memory-based read — cap the overall operation so a
        // peripheral with hundreds of registers cannot run past the global cap.
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }
        const debugState = await this.getCurrentDebugState(0);
        const overallMs = capTimeout(timeoutMs, this.timeouts.memoryReadMs);
        return withTimeout('readPeripheralRegister', overallMs, async () =>
            readPeripheralViaMemory(session, peripheral, register, debugState.frameId)
        );
    }

    /**
     * Read and decode Cortex-M fault status registers.
     */
    public async getFaultInfo(timeoutMs?: number): Promise<string> {
        const { FAULT_REGISTER_ADDRESSES, decodeFaultRegisters } = await import('./core/faultDecoder.js');

        // Bound the whole 6-register sweep to the supplied (or default) cap.
        const overallMs = capTimeout(timeoutMs, this.timeouts.memoryReadMs);
        return withTimeout('getFaultInfo', overallMs, async () => {
            const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);
            const CFSR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.CFSR, dapMs);
            const HFSR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.HFSR, dapMs);
            const DFSR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.DFSR, dapMs);
            const MMFAR = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.MMFAR, dapMs);
            const BFAR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.BFAR, dapMs);
            const AFSR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.AFSR, dapMs);
            return decodeFaultRegisters({ CFSR, HFSR, DFSR, MMFAR, BFAR, AFSR });
        });
    }

    /**
     * List DAP threads. With RTOS-aware GDB servers (pyOCD --rtos, J-Link
     * RTOS plugins), each task is enumerated as a thread.
     */
    public async getThreads(timeoutMs?: number): Promise<DapThread[]> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }

        const dapMs = capTimeout(timeoutMs, this.timeouts.dapRequestMs);
        const response = await customRequestWithTimeout<any>(session, 'threads', {}, dapMs);
        const threads = response?.threads ?? [];

        const results: DapThread[] = await Promise.all(threads.map(async (t: any) => {
            let topFrame: StackFrame | undefined;
            try {
                const st = await customRequestWithTimeout<any>(session, 'stackTrace', {
                    threadId: t.id, startFrame: 0, levels: 1
                }, dapMs);
                const f = st?.stackFrames?.[0];
                if (f) {
                    topFrame = {
                        name: f.name || 'unknown',
                        source: f.source?.path || f.source?.name || undefined,
                        line: f.line || undefined,
                        column: f.column || undefined,
                    };
                }
            } catch {
                // best effort — leave topFrame undefined
            }
            return { id: t.id, name: t.name ?? `thread-${t.id}`, topFrame };
        }));
        return results;
    }

    /**
     * Get the call stack for a thread (defaults to the active thread).
     */
    public async getCallStack(threadId?: number, levels: number = 50, timeoutMs?: number): Promise<StackFrame[]> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }

        const tid = threadId ?? this.getActiveThreadId();
        const response = await customRequestWithTimeout<any>(session, 'stackTrace', {
            threadId: tid, startFrame: 0, levels
        }, capTimeout(timeoutMs, this.timeouts.dapRequestMs));

        const frames = response?.stackFrames ?? [];
        return frames.map((f: any) => ({
            name: f.name || 'unknown',
            source: f.source?.path || f.source?.name || undefined,
            line: f.line || undefined,
            column: f.column || undefined,
            // Attach frameId via index trick: callers use getVariablesForFrame with the DAP frame id below
            ...(f.id !== undefined ? { frameId: f.id } : {}),
        }));
    }

    /**
     * Get variables for an explicit frame id (lets callers walk the stack
     * without changing the editor's active frame).
     */
    public async getVariablesForFrame(frameId: number, scope?: 'local' | 'global' | 'all', timeoutMs?: number): Promise<any> {
        return this.getVariables(frameId, scope, timeoutMs);
    }

    /**
     * Return information about the connected debug target.
     */
    public async getDeviceInfo(): Promise<string> {
        const session = resolveActiveSession();
        if (!session) { throw new Error('No active debug session'); }

        const config = session.configuration;
        const info: Record<string, string> = {
            'Session name': session.name,
            'Debug type': config.type || '<unknown>',
            'Program': config.program || '<unknown>',
            'GDB': config.gdb || '<default>',
            'Server': config.target?.server || '<unknown>',
            'Port': config.target?.port || '<unknown>',
        };

        if (config.cmsis?.cbuildRunFile) {
            info['cbuild-run'] = config.cmsis.cbuildRunFile;
        }

        let result = '=== Debug Session Info ===\n';
        for (const [key, value] of Object.entries(info)) {
            result += `  ${key}: ${value}\n`;
        }
        return result;
    }
}
