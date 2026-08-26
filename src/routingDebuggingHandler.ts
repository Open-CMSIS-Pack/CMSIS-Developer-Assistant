// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as http from 'http';
import { CmsisAction, IDebuggingHandler } from './debuggingHandler';
import { WindowRegistration, WorkspaceRegistry, ResolutionReason, describeWindow } from './utils/workspaceRegistry';
import { forwardTimeoutMs, pathHintOf } from './core/opTable';
import { logger } from './utils/logger';

/**
 * Router-window handler — one instance per MCP session — that forwards every
 * operation to the ControlServer of the window that owns the target.
 *
 * Why this exists: agents outside VS Code (Claude Code, Codex, Cursor) get one
 * MCP URL. Before this, every window ran its own server on whatever port it
 * could get and the last one to start overwrote that URL, so the agent
 * routinely drove a window that did not hold the board.
 *
 * Per-session instances let two agents drive two different boards at once.
 */
export class RoutingDebuggingHandler implements IDebuggingHandler {
    /** The window this session is driving, once established. */
    private target: WindowRegistration | undefined;
    /** Set by select_debug_window; survives a target going briefly stale. */
    private pinnedPid: number | undefined;

    constructor(
        private readonly registry: WorkspaceRegistry,
        private readonly defaultToolMs: number,
    ) {}

    // ---------------------------------------------------------------- routing

    /**
     * Decide which window an op belongs to.
     *
     * Upstream resolves from a path hint alone, because every one of its tools
     * takes a file path. Most tools here do not — read_memory, cmsis_action,
     * flash, reset and the serial tools have nothing to match on — so the
     * ladder continues past the path:
     *
     *   1. an explicit path hint (always re-resolves, and re-aims the session)
     *   2. a pin set with select_debug_window
     *   3. the target this session already established
     *   4. the sole window holding an active debug session
     *   5. the sole registered window
     *
     * Ties are never broken by guessing. Reading the wrong board's memory looks
     * like a firmware bug and costs far more than an error that says "pick one".
     */
    private resolveTarget(pathHint?: string): { target: WindowRegistration; reason: ResolutionReason } {
        if (pathHint) {
            const found = this.registry.findByPath(pathHint);
            if (found) {
                this.target = found;
                return { target: found, reason: 'path' };
            }
            // A hint that matches nothing is a hard error even if this session
            // has a cached target: the agent named a file, and silently running
            // it somewhere else is exactly the misrouting this class fixes.
            throw new Error(this.noTargetMessage(pathHint));
        }

        if (this.pinnedPid !== undefined) {
            const pinned = this.registry.findByPid(this.pinnedPid);
            if (pinned) {
                this.target = pinned;
                return { target: pinned, reason: 'pinned' };
            }
            throw new Error(
                `The window pinned with select_debug_window (pid=${this.pinnedPid}) is gone. ` +
                `Pin another with select_debug_window, or call list_debug_windows to see what is open.`,
            );
        }

        if (this.target && this.registry.isLive(this.target)) {
            return { target: this.target, reason: 'cached' };
        }
        // Cached target died — drop it so the fallbacks get a fair look.
        this.target = undefined;

        const active = this.registry.findSoleActiveSession();
        if (active) {
            this.target = active;
            return { target: active, reason: 'active-session' };
        }

        const only = this.registry.findSoleWindow();
        if (only) {
            this.target = only;
            return { target: only, reason: 'only-window' };
        }

        throw new Error(this.noTargetMessage(undefined));
    }

    private noTargetMessage(pathHint?: string): string {
        const windows = this.registry.list();
        if (windows.length === 0) {
            return 'No CMSIS Developer Assistant-enabled VS Code window is currently registered. ' +
                'Open your project in VS Code and wait for the extension to activate.';
        }

        const listing = windows.map(w => `  • ${describeWindow(w)}`).join('\n');

        if (pathHint) {
            return `No open VS Code window has "${pathHint}" inside its workspace.\n` +
                `Open the folder containing it, or pass a path that is inside one of these:\n${listing}`;
        }

        const active = windows.filter(w => w.hasActiveSession);
        if (active.length > 1) {
            return `${active.length} VS Code windows have an active debug session, so there is no ` +
                `unambiguous target for this call.\nPick one with select_debug_window:\n${listing}`;
        }
        return `${windows.length} VS Code windows are registered and none has an active debug session, ` +
            `so there is no unambiguous target for this call.\n` +
            `Start a session (cmsis_action load_and_debug), or pick a window with select_debug_window:\n${listing}`;
    }

    // --------------------------------------------------------------- transport

    private async forward(op: string, args: unknown = {}): Promise<string> {
        const { target, reason } = this.resolveTarget(pathHintOf(args));
        logger.info(`Routing ${op} → pid=${target.pid} port=${target.controlPort} (via ${reason})`);
        try {
            return await this.post(target, op, args);
        } catch (error) {
            // A failed round trip usually means the window closed between the
            // registry read and the request. Drop the cache so the next call
            // re-resolves instead of hammering a dead port.
            if (this.target?.pid === target.pid) {
                this.target = undefined;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Could not reach the VS Code window handling this session (pid=${target.pid}): ${message}\n` +
                `It may have been closed. Call list_debug_windows to see what is still open.`,
            );
        }
    }

    private post(target: WindowRegistration, op: string, args: unknown): Promise<string> {
        const payload = JSON.stringify({ op, args });
        const timeout = forwardTimeoutMs(op, args, this.defaultToolMs);

        return new Promise<string>((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port: target.controlPort,
                path: '/op',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'x-cmsis-developer-assistant-token': target.controlToken,
                },
                timeout,
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body || '{}') as { result?: string; error?: string };
                        if (res.statusCode === 200 && parsed.result !== undefined) {
                            resolve(parsed.result);
                        } else {
                            reject(new Error(parsed.error ?? `control server returned ${res.statusCode}`));
                        }
                    } catch {
                        reject(new Error(`malformed control response: ${body.slice(0, 200)}`));
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error(
                    `no response within ${Math.round(timeout / 1000)}s — the target window may be busy or wedged`,
                ));
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    // ------------------------------------------------------- routing-only tools

    /** Everything the agent needs to choose a window, as the registry sees it. */
    public listDebugWindows(): string {
        const windows = this.registry.list();
        if (windows.length === 0) {
            return 'No CMSIS Developer Assistant-enabled VS Code windows are currently registered.';
        }
        const current = this.target;
        const lines = windows.map((w) => {
            const marks: string[] = [];
            if (current?.pid === w.pid) { marks.push('current target'); }
            if (this.pinnedPid === w.pid) { marks.push('pinned'); }
            return `• ${describeWindow(w)}${marks.length ? `  ← ${marks.join(', ')}` : ''}`;
        });
        return `Registered VS Code windows:\n${lines.join('\n')}\n\n` +
            'Pin one for this session with select_debug_window({ pid }) when the automatic choice is wrong.';
    }

    /** Pin this session to one window, by pid or by a path inside its workspace. */
    public selectDebugWindow(args: { pid?: number; workspaceFolder?: string }): string {
        const { pid, workspaceFolder } = args;
        if (pid === undefined && !workspaceFolder) {
            return 'Pass either pid or workspaceFolder. Call list_debug_windows to see the options.';
        }

        const found = pid !== undefined
            ? this.registry.findByPid(pid)
            : this.registry.findByWorkspaceFolder(workspaceFolder!);

        if (!found) {
            const listing = this.registry.list().map(w => `  • ${describeWindow(w)}`).join('\n');
            return `No registered window matches ${pid !== undefined ? `pid=${pid}` : `"${workspaceFolder}"`}.\n` +
                (listing ? `Currently registered:\n${listing}` : 'No windows are registered.');
        }

        this.pinnedPid = found.pid;
        this.target = found;
        return `This session is now pinned to: ${describeWindow(found)}\n` +
            'Every subsequent tool call runs in that window until you pin another.';
    }

    // ------------------------------------------------------- IDebuggingHandler
    //
    // One-line delegations. The op names are the method names, checked against
    // this interface at compile time in core/opTable.ts, so a tool cannot be
    // added without becoming routable.

    handleStartDebugging(args: { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string; timeoutMs?: number }): Promise<string> {
        return this.forward('handleStartDebugging', args);
    }
    handleStopDebugging(): Promise<string> {
        return this.forward('handleStopDebugging');
    }
    handleStepOver(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleStepOver', args);
    }
    handleStepInto(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleStepInto', args);
    }
    handleStepOut(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleStepOut', args);
    }
    handleContinue(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleContinue', args);
    }
    handlePause(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handlePause', args);
    }
    handleWaitForStop(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleWaitForStop', args);
    }
    handleRestart(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleRestart', args);
    }
    handleReset(args: { method?: 'auto' | 'system' | 'core' | 'hardware'; halt?: boolean; timeoutMs?: number }): Promise<string> {
        return this.forward('handleReset', args);
    }
    handleAddBreakpoint(args: { fileFullPath: string; line?: number; condition?: string; lineContent?: string }): Promise<string> {
        return this.forward('handleAddBreakpoint', args);
    }
    handleAddLogpoint(args: { fileFullPath: string; line: number; logMessage: string; condition?: string }): Promise<string> {
        return this.forward('handleAddLogpoint', args);
    }
    handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string> {
        return this.forward('handleRemoveBreakpoint', args);
    }
    handleClearAllBreakpoints(): Promise<string> {
        return this.forward('handleClearAllBreakpoints');
    }
    handleListBreakpoints(): Promise<string> {
        return this.forward('handleListBreakpoints');
    }
    handleListVariableNames(args: { scope?: 'local' | 'global' | 'all'; timeoutMs?: number }): Promise<string> {
        return this.forward('handleListVariableNames', args);
    }
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all'; variableNames?: string[]; timeoutMs?: number }): Promise<string> {
        return this.forward('handleGetVariables', args);
    }
    handleEvaluateExpression(args: { expression: string; timeoutMs?: number }): Promise<string> {
        return this.forward('handleEvaluateExpression', args);
    }
    handleReadMemory(args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }): Promise<string> {
        return this.forward('handleReadMemory', args);
    }
    handleReadCoreRegisters(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleReadCoreRegisters', args);
    }
    handleReadCycleCounter(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleReadCycleCounter', args);
    }
    handleReadPeripheralRegister(args: { peripheral: string; register?: string; timeoutMs?: number }): Promise<string> {
        return this.forward('handleReadPeripheralRegister', args);
    }
    handleGetFaultInfo(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleGetFaultInfo', args);
    }
    handleDiagnoseFault(args?: { levels?: number; timeoutMs?: number }): Promise<string> {
        return this.forward('handleDiagnoseFault', args);
    }
    handleLookupPeripheral(args?: { name?: string; address?: string; filter?: string; svdFile?: string; pname?: string; timeoutMs?: number }): Promise<string> {
        return this.forward('handleLookupPeripheral', args);
    }
    handleLookupRegister(args: { peripheral: string; register: string; svdFile?: string; pname?: string; timeoutMs?: number }): Promise<string> {
        return this.forward('handleLookupRegister', args);
    }
    handleGetDeviceInfo(): Promise<string> {
        return this.forward('handleGetDeviceInfo');
    }
    handleCheckTargetConnection(): Promise<string> {
        return this.forward('handleCheckTargetConnection');
    }
    handleGetSessionStatus(): Promise<string> {
        return this.forward('handleGetSessionStatus');
    }
    handleGetCallStack(args: { threadId?: number; levels?: number; timeoutMs?: number }): Promise<string> {
        return this.forward('handleGetCallStack', args);
    }
    handleGetThreads(args?: { timeoutMs?: number }): Promise<string> {
        return this.forward('handleGetThreads', args);
    }
    handleGetFrameVariables(args: { frameId: number; scope?: 'local' | 'global' | 'all'; variableNames?: string[]; timeoutMs?: number }): Promise<string> {
        return this.forward('handleGetFrameVariables', args);
    }
    handleCmsisCommand(args: { action: CmsisAction; target?: string; timeoutMs?: number }): Promise<string> {
        return this.forward('handleCmsisCommand', args);
    }
    handleFlash(args: { cbuildRunFile?: string; timeoutMs?: number }): Promise<string> {
        return this.forward('handleFlash', args);
    }

    // Serial tools reach the same control server; the op table decides that
    // these dispatch to the serial handler singleton on the far side.
    serialOp(op: string, args: unknown = {}): Promise<string> {
        return this.forward(op, args);
    }
}
