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
 * Texts about the debug session itself: why an inspection is refused in the
 * current state (with the code that refusal carries), what
 * `get_session_status` reports, the call-stack and thread listings, and
 * what an Arm FVP session says instead where pausing cannot work. What the
 * adapter said when a start failed rides along with the failure as
 * problem records (#48), not as text of its own.
 *
 * `test/realboard/run.ts` reads `State: …` from the status and `frameId=N`
 * from the call stack; both stay in this form.
 */

import type { StackFrame } from '../debugState';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import { ageText, wedgeHint } from '../core/probeWedge';
import { shortenPath, truncateList } from '../core/textBudget';
import { ErrorCode, Refusal } from '../core/toolResult';

export type SessionStatus = Awaited<ReturnType<IDebuggingExecutor['getSessionStatus']>>;
export type SessionState = SessionStatus['state'];
type Diagnostics = ReturnType<IDebuggingExecutor['getDiagnostics']>;
type ThreadEntry = Awaited<ReturnType<IDebuggingExecutor['getThreads']>>[number];

/** Frames listed when the caller did not ask for a depth. */
const DEFAULT_SHOWN_FRAMES = 20;
/** Threads listed before the rest is counted. */
const SHOWN_THREADS = 32;

/** What to do next when an inspection meets a session in this state. */
const REFUSAL_HINTS: Record<SessionState, string> = {
    'no-session': 'No active debug session: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise.',
    initializing: 'The debug adapter is still starting, or the session is shutting down, and takes no requests. Wait briefly and retry.',
    running: 'The target is running: call pause_execution first, or set a breakpoint and wait_for_stop.',
    unresponsive: 'The probe/GDB server is unresponsive. Call check_target_connection to confirm.',
    stopped: 'Session reports stopped — please retry the operation.',
};

/** The code of the refusal in each state; `stopped` means the state changed while the gate looked. */
const REFUSAL_CODES: Record<SessionState, ErrorCode> = {
    'no-session': 'NO_SESSION',
    initializing: 'NO_SESSION',
    running: 'TARGET_RUNNING',
    unresponsive: 'PROBE_WEDGED',
    stopped: 'INTERNAL',
};

/**
 * The closing hint of `get_session_status`, by state; `request` is the
 * session's, for the way to reconnect (#3). A stopped session whose last
 * DHCSR read got no answer `coreSilentForMs` ago says so instead of
 * promising full inspection; its state stays `stopped`, so pausing and
 * stopping are not blocked. An initializing session asked to end
 * `endRequestedForMs` ago is shutting down, not starting.
 */
function statusHint(
    state: SessionState, liveSessions: number, request: string | undefined, coreSilentForMs?: number, endRequestedForMs?: number, fvp = false,
): string {
    switch (state) {
        case 'no-session':
            return liveSessions === 0
                ? 'Hint: no debug session is running in the VS Code window this call was routed to. '
                    + 'Start one with cmsis_action load_and_debug (CMSIS targets) or start_debugging. '
                    + 'If a session IS running and you expected to reach it, it is in a different window: '
                    + 'call list_debug_windows to see which windows are registered and which one holds the session, '
                    + 'then select_debug_window to pin it for this session. '
                    + 'If you just reinstalled the extension, reload the window so the new build is active.'
                : 'Hint: call start_debugging or cmsis_action load_and_debug to attach.';
        case 'initializing':
            return endRequestedForMs === undefined
                ? 'Hint: the adapter is still starting or shutting down — wait a moment and retry.'
                : 'Hint: the session is shutting down — call get_session_status again in a moment; if it is still listed, '
                    + 'stop_debugging once more makes VS Code end the adapter.';
        case 'running':
            return fvp
                ? `Hint: target is running. ${FVP_RUNNING_HINT}`
                : 'Hint: target is running. Add a breakpoint then continue_execution, or call pause_execution to inspect now.';
        case 'stopped':
            return coreSilentForMs === undefined
                ? 'Hint: full inspection (variables, memory, registers) is available.'
                : `Hint: the session is stopped, but the last read of the core's debug status (DHCSR, ${ageText(coreSilentForMs)} ago) `
                    + 'got no answer: memory and register reads fail with PROBE_WEDGED. check_target_connection reads it again. '
                    + wedgeHint(request);
        case 'unresponsive':
            return `Hint: probe/GDB server is hung. ${wedgeHint(request)}`;
    }
}

/**
 * Why `operation` needs a stopped target and the session is not in that
 * state: the state's code, and the next action for that state as the hint.
 * A `Refusal`, so a tool that wraps its failures passes it on as it is. An
 * unresponsive probe is `PROBE_WEDGED`, and its hint adds the way to
 * reconnect for a session started with `request` (#3). A running Arm FVP
 * (`fvp`) is told what stops it instead of a pause.
 */
export function stoppedTargetRefusal(operation: string, state: SessionState, request?: string, fvp = false): Refusal {
    const reconnect = state === 'unresponsive' ? ` ${wedgeHint(request)}` : '';
    const hint = state === 'running' && fvp ? FVP_RUNNING_HINT : REFUSAL_HINTS[state];
    return new Refusal(REFUSAL_CODES[state], `Cannot ${operation}: session state is '${state}'.`,
        `${hint}${reconnect} Use get_session_status for a definitive, never-failing classification.`);
}

/** Said instead of the state after a stop for which VS Code selected no frame within `FRAME_FOCUS_WAIT_MS`. */
export const NO_FRAME_SELECTED = 'VS Code has not selected a frame yet, so the state is not shown: get_call_stack shows where.';

// ── An Arm FVP: its GDB server ignores GDB's interrupt while the model runs; only a breakpoint stops it ──

/** `pause_execution` on an FVP that did not stop. */
export const FVP_PAUSE_IGNORED = 'Pause requested, but the Arm FVP did not stop: its GDB server ignores GDB\'s interrupt while the model runs, '
    + 'so only a breakpoint stops it. To see where it runs: stop_debugging, cmsis_action load_and_debug, add_breakpoint where it should stop '
    + '(for a fault, HardFault_Handler), then continue_execution.';

/** A breakpoint change on an FVP whose model did not stop for it. */
export function fvpChangeRefusal(operation: string): Refusal {
    return new Refusal('TARGET_RUNNING', `Cannot ${operation} while the Arm FVP runs: the change needs a halted target, `
        + 'and its GDB server ignores the pause request.',
    'stop_debugging, cmsis_action load_and_debug (it stops at main), make the change, then continue_execution.');
}

/** `stop_debugging` on an FVP whose session is still listed. */
export const FVP_STOP_UNCONFIRMED = 'Stop requested, but the session is still listed: the debug adapter halts the target before it '
    + 'disconnects, and the Arm FVP ignores that interrupt. Call stop_debugging once more: VS Code then ends the adapter.';

/** After a session on an FVP came up: what stops it later. */
export const FVP_BREAK_FIRST = 'On the Arm FVP pause_execution will not stop the running model: set breakpoints '
    + '(for a fault, HardFault_Handler) before continue_execution.';

/** What stops a running FVP, for the `running` refusal and the status hint. */
export const FVP_RUNNING_HINT = 'On the Arm FVP pause_execution will not stop it, only a breakpoint does: wait_for_stop for one that is set, '
    + 'or stop_debugging, cmsis_action load_and_debug and add_breakpoint before continue_execution.';

/** `wait_for_stop` on an FVP whose wait ran out: what to do instead of pausing. */
export const FVP_WAIT_RAN_OUT = 'Target did not stop within the timeout — it is still running. On the Arm FVP pause_execution will not stop it, '
    + 'only a breakpoint does: call wait_for_stop again with a larger timeoutMs, or stop_debugging and cmsis_action load_and_debug to set one.';

/** After a step on an FVP that did not stop: the recovery pause is skipped. */
export const FVP_NO_RECOVERY_PAUSE = '🩹 No recovery pause: the Arm FVP ignores it while the model runs, so only a breakpoint stops it — '
    + 'stop_debugging, cmsis_action load_and_debug, add_breakpoint where it should stop, then continue_execution.';

/** A continue on an FVP that keeps running: what to do instead of pausing. */
export const FVP_KEEPS_RUNNING = 'Call wait_for_stop to wait for a breakpoint. On the Arm FVP pause_execution will not stop it, nor will a fault: '
    + 'to set a breakpoint, stop_debugging and cmsis_action load_and_debug first.';

/**
 * The `get_session_status` text; `extraLines` (the CMSIS task line) go before the closing hint, `request` is the
 * session's `configuration.request`.
 */
export function renderSessionStatus(
    status: SessionStatus, diagnostics: Diagnostics, extraLines: readonly string[] = [], request?: string, fvp = false,
): string {
    const lines = [`State: ${status.state}`];
    if (status.sessionName) {
        lines.push(`Session: ${status.sessionName}`);
    }
    if (status.sessionType) {
        lines.push(`Type: ${status.sessionType}`);
    }
    if (status.configurationName) {
        lines.push(`Configuration: ${status.configurationName}`);
    }
    const probe = typeof status.dapProbeMs === 'number' ? ` (probe ${status.dapProbeMs}ms)` : '';
    lines.push(`DAP responsive: ${status.dapResponsive}${probe}`);
    if (status.detail) {
        lines.push(`Detail: ${status.detail}`);
    }
    const names = diagnostics.liveSessionNames.length > 0 ? ` [${diagnostics.liveSessionNames.join(', ')}]` : '';
    const focused = diagnostics.hasVscodeActiveSession ? 'set' : 'undefined';
    lines.push(`Diagnostics: serverVersion=${diagnostics.serverVersion}, `
        + `liveSessionsInThisWindow=${diagnostics.liveSessionCount}${names}, vscodeActiveDebugSession=${focused}`);
    lines.push(...extraLines);
    lines.push(statusHint(status.state, diagnostics.liveSessionCount, request, status.coreSilentForMs, status.endRequestedForMs, fvp));
    return lines.join('\n');
}

/** `source:line` with the source relative to a workspace folder, or `<no source>`. */
function whereIs(frame: StackFrame, roots: readonly string[]): string {
    const source = frame.source ? shortenPath(frame.source, roots) : '<no source>';
    return `${source}:${frame.line ?? '?'}`;
}

/**
 * The `get_call_stack` text. With an explicit depth every frame is listed;
 * otherwise the first twenty and a count of the rest.
 */
export function renderCallStack(frames: StackFrame[], depthGiven: boolean, roots: readonly string[]): string {
    if (frames.length === 0) {
        return 'No stack frames available.';
    }
    const { shown, hidden } = depthGiven ? { shown: frames, hidden: 0 } : truncateList(frames, DEFAULT_SHOWN_FRAMES);
    const lines = [`Call stack (${frames.length} frame${frames.length === 1 ? '' : 's'}):`];
    shown.forEach((frame, level) => {
        const handle = frame.frameId !== undefined ? ` [frameId=${frame.frameId}]` : '';
        lines.push(`  #${String(level).padStart(2)}  ${frame.name}  @ ${whereIs(frame, roots)}${handle}`);
    });
    if (hidden > 0) {
        lines.push(`  … ${hidden} more frames — pass levels to see all`);
    }
    lines.push('', 'Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.');
    return lines.join('\n');
}

/** The `get_threads` text: each thread with its top frame when the adapter gave one. */
export function renderThreads(threads: ThreadEntry[], roots: readonly string[]): string {
    if (threads.length === 0) {
        return 'No threads reported by the debug adapter.';
    }
    const { shown, hidden } = truncateList(threads, SHOWN_THREADS);
    const lines = [`Threads / RTOS tasks (${threads.length}):`];
    for (const thread of shown) {
        const top = thread.topFrame ? `  → ${thread.topFrame.name} @ ${whereIs(thread.topFrame, roots)}` : '';
        lines.push(`  [${thread.id}] ${thread.name}${top}`);
    }
    if (hidden > 0) {
        lines.push(`  … ${hidden} more threads`);
    }
    lines.push('', 'Tip: pass a threadId to get_call_stack to inspect a specific task.');
    return lines.join('\n');
}
