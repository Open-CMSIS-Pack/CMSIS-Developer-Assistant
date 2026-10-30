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
 * What this window knows about its debug sessions from the DAP traffic the
 * adapter tracker sees: the live sessions, the one to act on and the one the
 * window's registry entry names, whether each target is stopped, waits for
 * the next stop, for the frame VS Code selects after it and for a session's
 * end, the
 * output a GDB command prints (#56), when the adapter has answered VS Code's
 * `setBreakpoints`, the GDB `dprintf` logpoints set in a session, when
 * the last DHCSR read of a session got no answer (#3), and whether a session
 * was asked to end (a `disconnect` or `terminate` request), which an adapter
 * that waits for a halt first can take long to do. Everything a session
 * holds goes when it ends.
 *
 * What goes wrong on the channel goes into the window's problem journal
 * (#48): failed responses, adapter errors, and the output of the categories
 * `stderr`, `console`, `important` and `server` (the GDB server's, on
 * cdt-gdb-adapter), line by line, a line split over several output events
 * as one, never the target's `stdout`. A failed
 * response is an error when VS Code sent the request (a breakpoint the user
 * set while the target runs) and a warning when a tool sent it through
 * `customRequestWithTimeout`, since that tool reports its own outcome; an
 * `evaluate` of the Watch view, a hover or Live Watch is `info`.
 * `stderr` is a warning, the other output `info`, unless `classifyProblem`
 * knows the line or pyOCD's own level marks a GDB-server line as a warning
 * or an error.
 */

import * as vscode from 'vscode';
import type { CoreVerdict } from '../core/probeWedge';
import { classifyProblem, serverLineSeverity } from '../core/problemCodes';
import { failedResponseMessage } from '../core/problemFeed';
import { problemJournal, type ProblemJournal, type ProblemSeverity, type ProblemSource } from '../core/problemJournal';
import { logger } from './logger';
import { notifyJournaledWarning } from './notify';

/**
 * Per-session record of the most recent execution-state events seen on the
 * Debug Adapter Protocol channel. We track this because neither
 * `vscode.debug.activeDebugSession` nor `vscode.debug.activeStackItem` is a
 * reliable "is the target stopped?" signal on embedded targets:
 *
 *   - `activeStackItem` is `undefined` whenever the CPU is running.
 *   - It is also `undefined` for a brief window after a stop event, before
 *     VS Code surfaces the new stack frame.
 *   - It can remain set briefly after a `continued` event.
 *
 * The DAP `stopped` / `continued` events are the ground truth, so we record
 * them here and expose a synchronous query.
 */
interface SessionExecState {
    /** Last execution-state transition observed on this session. */
    lastEvent: 'stopped' | 'continued' | null;
    /** Reason from the DAP `stopped` event (e.g. "breakpoint", "step", "exception"). */
    stoppedReason: string | null;
    /** Thread from the DAP `stopped` event, when the adapter reported one. */
    stoppedThreadId: number | null;
    /** Wall-clock time of the last transition. */
    lastEventAt: number;
}

const sessionStates = new WeakMap<vscode.DebugSession, SessionExecState>();

/**
 * Live debug sessions seen by the adapter tracker, most-recently-started last.
 * `vscode.debug.activeDebugSession` only reflects the session the VS Code UI
 * currently has focused — it is `undefined` whenever focus is elsewhere, which
 * is common with `gdbtarget` multi-core launches. This list lets us answer
 * "is there a debug session at all?" independently of UI focus.
 *
 * Note: a debug session in a *different* VS Code window runs in a different
 * extension host and is genuinely invisible here — that case cannot be fixed.
 */
const liveSessions: vscode.DebugSession[] = [];

/** Sessions the tracker has seen end, so a wait that starts afterwards knows at once. */
const endedSessions = new WeakSet<vscode.DebugSession>();

/** Who is told when a session's adapter starts (`onSessionBegins`). */
const beginListeners = new Set<(session: vscode.DebugSession) => void>();

/**
 * Be told when a debug session's adapter starts, before its launch or
 * attach is sent. VS Code's `onDidStartDebugSession` comes only once the
 * launch succeeded, and never for a session whose launch fails; this comes
 * for both.
 */
export function onSessionBegins(listener: (session: vscode.DebugSession) => void): vscode.Disposable {
    beginListeners.add(listener);
    return { dispose: () => { beginListeners.delete(listener); } };
}

// ── Starts an agent asked for ───────────────────────────────────────────────

/**
 * How long after a tool call asked for a debug start its session may still
 * come up: a load that runs before the launch and GDB's own 15 s connect
 * timeout included.
 */
export const AGENT_START_WINDOW_MS = 180_000;

/** Until when a session that starts in this window counts as one an agent started. */
let agentStartsUntil = 0;
/** The sessions that did, and their child sessions (the cores of a multi-core launch). */
const agentStartedSessions = new WeakSet<vscode.DebugSession>();

/**
 * A tool call is about to start a debug session in this window, directly
 * (`start_debugging`, `restart_debugging`) or through the CMSIS Solution
 * extension (`cmsis_action load_and_debug` or `attach`): sessions that start
 * within `windowMs` count as the agent's.
 */
export function expectAgentStart(windowMs: number = AGENT_START_WINDOW_MS, now: number = Date.now()): void {
    agentStartsUntil = Math.max(agentStartsUntil, now + windowMs);
}

/** Forget every expected agent start; for tests, which share one extension host. */
export function forgetAgentStarts(): void {
    agentStartsUntil = 0;
}

/** True for a session an agent's tool call started, or a child session of one. */
export function isAgentStarted(session: vscode.DebugSession): boolean {
    return agentStartedSessions.has(session);
}

function noteSessionOrigin(session: vscode.DebugSession): void {
    const parent = session.parentSession;
    if (Date.now() <= agentStartsUntil || (parent !== undefined && agentStartedSessions.has(parent))) {
        agentStartedSessions.add(session);
    }
}

/**
 * Mark a failed `launch` or `attach` response so VS Code shows no dialog:
 * it shows the error of a failed start as a modal dialog ("could not
 * connect: Operation timed out." with "Open 'launch.json'") unless the error
 * says `showUser: false`, and the CMSIS Debugger's adapter marks every start
 * error for the user. For a start an agent asked for, nobody may be at the
 * screen to close the dialog, and the agent has the error in its tool result
 * and in the problem journal already. The tracker is handed the response
 * before VS Code reads it, so the mark set here is the one VS Code sees.
 * Returns the error text.
 */
export function quietStartFailure(message: { message?: unknown; body?: { error?: unknown } }): string {
    const body = message.body ?? (message.body = {});
    const reported = body.error;
    const error = typeof reported === 'object' && reported !== null ? reported as { format?: unknown; showUser?: boolean } : undefined;
    const text = typeof error?.format === 'string' && error.format !== '' ? error.format : String(message.message ?? 'the debug start failed');
    if (error) {
        error.showUser = false;
    } else {
        body.error = { id: 0, format: text, showUser: false };
    }
    return text;
}

function getOrInit(session: vscode.DebugSession): SessionExecState {
    let state = sessionStates.get(session);
    if (!state) {
        state = { lastEvent: null, stoppedReason: null, stoppedThreadId: null, lastEventAt: 0 };
        sessionStates.set(session, state);
    }
    return state;
}

function addLiveSession(session: vscode.DebugSession): void {
    if (!liveSessions.includes(session)) {
        liveSessions.push(session);
    }
}

function removeLiveSession(session: vscode.DebugSession): void {
    const idx = liveSessions.indexOf(session);
    if (idx !== -1) {
        liveSessions.splice(idx, 1);
    }
}

/**
 * The most-recently-started live debug session, or `undefined` if none.
 * Use as a fallback when `vscode.debug.activeDebugSession` is `undefined`
 * but a session is in fact running in this window.
 */
export function getMostRecentLiveSession(): vscode.DebugSession | undefined {
    return liveSessions.length > 0 ? liveSessions[liveSessions.length - 1] : undefined;
}

/** Number of live debug sessions this extension host has seen via the adapter tracker. */
export function getLiveSessionCount(): number {
    return liveSessions.length;
}

/** Names of the live debug sessions, for diagnostics. */
export function getLiveSessionNames(): string[] {
    return liveSessions.map(s => s.name);
}

/**
 * The live debug sessions, oldest first, without `ending`, the session whose
 * end is being announced: what the window's GDB ports are read from.
 */
export function liveSessionsExcept(ending?: vscode.DebugSession): vscode.DebugSession[] {
    return liveSessions.filter((session) => session !== ending && !endedSessions.has(session));
}

/**
 * Resolve "the debug session the agent should operate on": VS Code's focused
 * session if there is one, otherwise the most-recently-started tracked
 * session. This is the single source of truth the executor should use
 * instead of reading `vscode.debug.activeDebugSession` directly.
 */
export function resolveActiveSession(): vscode.DebugSession | undefined {
    return vscode.debug.activeDebugSession ?? getMostRecentLiveSession();
}

/**
 * The session this window's registry entry names: `active`, VS Code's
 * focused session, while it is live, else the most recently started live
 * session; undefined when none is live. The focused session alone is no
 * answer, since `onDidTerminateDebugSession` runs while it still names the
 * session that ends: VS Code moves the focus only afterwards. `ending` is the
 * session whose end is being announced, which never counts, whichever end
 * listener runs first. The tracker sees every debug type, so a focused
 * session it never saw has its adapter in another extension host, and counts
 * as VS Code has it.
 */
export function registrySession(active: vscode.DebugSession | undefined, ending?: vscode.DebugSession): vscode.DebugSession | undefined {
    if (active !== undefined && active !== ending && !endedSessions.has(active)) {
        return active;
    }
    for (let index = liveSessions.length - 1; index >= 0; index--) {
        if (liveSessions[index] !== ending) {
            return liveSessions[index];
        }
    }
    return undefined;
}

/**
 * Authoritative answer to "is this session currently stopped at a frame the
 * agent can inspect?". Combines DAP event history with VS Code's
 * `activeStackItem` to ride out the brief races on either side of a stop.
 */
export function isSessionStopped(session: vscode.DebugSession): boolean {
    const state = sessionStates.get(session);

    // Authoritative if we have seen DAP events for this session.
    if (state?.lastEvent === 'stopped') {
        return true;
    }
    if (state?.lastEvent === 'continued') {
        return false;
    }

    // No DAP events yet (e.g. attach without an initial stop) — fall back to
    // VS Code's view. This is the same heuristic the rest of the executor
    // used historically.
    const item = vscode.debug.activeStackItem;
    return item !== undefined && 'frameId' in item && item.session === session;
}

/**
 * Reason the target is currently stopped, or null if running / unknown.
 * Useful for surfacing "stopped at breakpoint" vs "stopped at exception".
 */
export function getStoppedReason(session: vscode.DebugSession): string | null {
    const state = sessionStates.get(session);
    return state?.lastEvent === 'stopped' ? state.stoppedReason : null;
}

// ── Awaitable stop events ─────────────────────────────────────────

/** Outcome of waiting for the next DAP `stopped` event on a session. */
export type StopWaitResult =
    | { kind: 'stopped'; reason: string | null; threadId: number | null }
    | { kind: 'timeout' }
    | { kind: 'ended' };

interface StopWaiter {
    session: vscode.DebugSession;
    settle: (result: StopWaitResult) => void;
    timer: NodeJS.Timeout;
}

// Module-level waiter set because the tracker is a singleton. A Set (not a
// single slot) so concurrent waiters on the same session all settle.
const stopWaiters = new Set<StopWaiter>();

function settleStopWaiters(session: vscode.DebugSession, result: StopWaitResult): void {
    for (const waiter of [...stopWaiters]) {
        if (waiter.session === session) {
            waiter.settle(result);
        }
    }
}

/**
 * Resolve on the NEXT DAP `stopped` event for this session (ground truth —
 * the same signal isSessionStopped records), on session termination, or on
 * timeout. Never rejects; the caller distinguishes outcomes via `kind`. A
 * session the tracker has already seen end resolves `ended` at once.
 */
export function waitForStopEvent(session: vscode.DebugSession, timeoutMs: number): Promise<StopWaitResult> {
    if (endedSessions.has(session)) {
        return Promise.resolve({ kind: 'ended' });
    }
    const ms = Math.min(Math.max(timeoutMs, 100), 60_000);
    return new Promise((resolve) => {
        const waiter = {} as StopWaiter;
        const settle = (result: StopWaitResult) => {
            stopWaiters.delete(waiter);
            clearTimeout(waiter.timer);
            resolve(result);
        };
        waiter.session = session;
        waiter.settle = settle;
        waiter.timer = setTimeout(() => settle({ kind: 'timeout' }), ms);
        stopWaiters.add(waiter);
    });
}

// ── VS Code's focus after a stop ──────────────────────────────────

/**
 * How long a read right after a stop waits for VS Code to select a frame.
 * VS Code focuses one only after it has fetched the threads and the stack of
 * the stop, which over a probe with an RTOS (pyOCD and CMSIS-RTX on a
 * B-L475E-IOT01A) comes after a read that starts with the `stopped` event.
 */
export const FRAME_FOCUS_WAIT_MS = 2_000;

type StackItem = vscode.DebugThread | vscode.DebugStackFrame | undefined;

/** Where VS Code's focused stack item is read and its changes heard; tests pass their own. */
export interface FocusSource {
    current(): StackItem;
    onDidChange(listener: (item: StackItem) => void): vscode.Disposable;
}

const VSCODE_FOCUS: FocusSource = {
    current: () => vscode.debug.activeStackItem,
    onDidChange: (listener) => vscode.debug.onDidChangeActiveStackItem(listener),
};

/** The wait, after a stop, for the frame VS Code selects for it. */
export interface FrameFocusWatch {
    /**
     * Resolves true once VS Code has selected a stack frame of the session
     * for the stop, false when `limitMs` passes first or the session ends.
     * Never rejects.
     */
    selected(limitMs: number): Promise<boolean>;
}

interface FocusWaiter {
    session: vscode.DebugSession;
    settle: (selected: boolean) => void;
}

const focusWaiters = new Set<FocusWaiter>();

/** True for a stack frame (an item with a `frameId`) of `session`. */
function isFrameOf(item: StackItem, session: vscode.DebugSession): boolean {
    return item !== undefined && 'frameId' in item && (item.session === session || item.session?.id === session.id);
}

/**
 * Resolves true once VS Code has selected a stack frame of `session` that is
 * not `stale` — at once when it has — false when `limitMs` passes first or
 * the session ends. Event-driven: nothing is polled.
 */
function frameSelectedFor(session: vscode.DebugSession, focus: FocusSource, stale: StackItem, limitMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const began = Date.now();
        const finish = (selected: boolean): void => {
            logger.debug(selected
                ? `[session-tracker] focus selected after ${Date.now() - began} ms on ${session.name}`
                : `[session-tracker] no frame selected within ${limitMs} ms on ${session.name}`);
            resolve(selected);
        };
        const now = focus.current();
        if (now !== stale && isFrameOf(now, session)) {
            finish(true);
            return;
        }
        if (limitMs <= 0 || endedSessions.has(session)) {
            finish(false);
            return;
        }
        let subscription: vscode.Disposable | undefined;
        const waiter: FocusWaiter = { session, settle: () => undefined };
        const timer = setTimeout(() => waiter.settle(false), limitMs);
        waiter.settle = (selected) => {
            clearTimeout(timer);
            subscription?.dispose();
            focusWaiters.delete(waiter);
            finish(selected);
        };
        focusWaiters.add(waiter);
        subscription = focus.onDidChange((item) => {
            if (focusWaiters.has(waiter) && isFrameOf(item, session)) {
                waiter.settle(true);
            }
        });
    });
}

/**
 * Armed before a request that may stop the target, it remembers the item VS
 * Code has focused then. Until VS Code hears the `continued` or `stopped` of
 * a request sent as a custom request it may still hold the frame from
 * before, and that frame does not count. After the stop, `selected` takes a
 * frame of `session` that is not that item (VS Code makes a new frame object
 * for every focus it reports), or any frame of `session` that the change
 * event delivers once the wait has begun. Event-driven: nothing is polled.
 */
export function armFocusWatch(session: vscode.DebugSession, focus: FocusSource = VSCODE_FOCUS): FrameFocusWatch {
    const stale = focus.current();
    return { selected: (limitMs) => frameSelectedFor(session, focus, stale, limitMs) };
}

/** What VS Code shows of a session that came up: the frame it selected for its stop, a target that runs, or no frame in time. */
export type StartFocus = 'selected' | 'running' | 'none';

/** The wait, after a session came up, for the frame VS Code selects when the session stopped. */
export interface StartFocusWatch {
    /**
     * `running` at once when the session active now is not stopped;
     * `selected` once VS Code has selected a stack frame of it other than the
     * item it had focused when the watch was armed; `none` when `limitMs`
     * passes first, the session ends, or there is no session. Never rejects.
     */
    settled(limitMs: number): Promise<StartFocus>;
}

/**
 * Armed before a session starts (`start_debugging`, the session phases of
 * `cmsis_action`): it remembers the item VS Code has focused then, which
 * belongs to an earlier session or stop and does not count. The session is
 * the one active when `settled` is called; whether it stopped is the
 * tracker's view (`isSessionStopped`).
 */
export function armStartFocusWatch(
    focus: FocusSource = VSCODE_FOCUS,
    sessionOf: () => vscode.DebugSession | undefined = resolveActiveSession,
    stopped: (session: vscode.DebugSession) => boolean = isSessionStopped,
): StartFocusWatch {
    const stale = focus.current();
    return {
        settled: async (limitMs) => {
            const session = sessionOf();
            if (session === undefined) {
                return 'none';
            }
            if (!stopped(session)) {
                return 'running';
            }
            return (await frameSelectedFor(session, focus, stale, limitMs)) ? 'selected' : 'none';
        },
    };
}

// ── Problems on the adapter channel (#48) ─────────────────────────

/** How long a request the tools announced may take to reach the tracker. */
const OWN_REQUEST_WINDOW_MS = 5_000;
/** Announced requests kept per session, and requests awaiting their response. */
const OWN_REQUESTS_KEPT = 64;
const REQUESTS_TRACKED = 256;

/** Requests the tools are about to send, by command, not yet seen going to the adapter. */
const ownRequestsDue = new WeakMap<vscode.DebugSession, Array<{ command: string; at: number }>>();
/** Requests seen going to the adapter, by seq: true when the tools sent it. Dropped with the response. */
const requestsSent = new WeakMap<vscode.DebugSession, Map<number, boolean>>();

/**
 * Announces a request a tool is about to send to `session`, so that its
 * failure counts as the tool's: `customRequestWithTimeout` calls it. The
 * tracker matches it to the next request of that command it sees.
 */
export function noteOwnRequest(session: vscode.DebugSession, command: string): void {
    const now = Date.now();
    const due = (ownRequestsDue.get(session) ?? []).filter((entry) => now - entry.at <= OWN_REQUEST_WINDOW_MS);
    due.push({ command, at: now });
    ownRequestsDue.set(session, due.slice(-OWN_REQUESTS_KEPT));
}

/** A request on its way to the adapter: remember its seq, and whether a tool announced it. */
function noteRequestSent(session: vscode.DebugSession, message: any): void {
    if (typeof message?.seq !== 'number') {
        return;
    }
    const now = Date.now();
    const due = ownRequestsDue.get(session);
    const index = due ? due.findIndex((entry) => entry.command === message.command && now - entry.at <= OWN_REQUEST_WINDOW_MS) : -1;
    if (index >= 0) {
        due?.splice(index, 1);
    }
    let sent = requestsSent.get(session);
    if (!sent) {
        sent = new Map();
        requestsSent.set(session, sent);
    }
    sent.set(message.seq, index >= 0);
    if (sent.size > REQUESTS_TRACKED) {
        sent.delete(sent.keys().next().value as number);
    }
}

/** Who sent the request a response answers: `tools`, `vscode`, or undefined when the tracker never saw it. */
function senderOf(session: vscode.DebugSession, response: any): 'tools' | 'vscode' | undefined {
    const sent = requestsSent.get(session);
    const seq = response?.request_seq;
    if (!sent || typeof seq !== 'number' || !sent.has(seq)) {
        return undefined;
    }
    const own = sent.get(seq);
    sent.delete(seq);
    return own ? 'tools' : 'vscode';
}

/**
 * Requests the views send on their own for what they show — the Watch and
 * Variables views, a hover, the CMSIS Debugger's Live Watch — and repeat
 * at every stop and refresh: one that fails is the view's, not a problem
 * of the session.
 */
const VIEW_REQUESTS: ReadonlySet<string> = new Set(['evaluate']);

/**
 * A failed response: a warning for a request a tool sent (the tool reports
 * it), an error for one VS Code sent; when the tracker did not see the
 * request, a warning while a tool call runs in this window, else an error.
 * A view's own request that fails is `info`.
 */
function journalFailedResponse(journal: ProblemJournal, session: vscode.DebugSession, message: any, sender: 'tools' | 'vscode' | undefined): void {
    const reason = message.message ?? message.body?.error?.format;
    if (reason === 'cancelled') {
        return;
    }
    const text = failedResponseMessage(String(message.command), reason ?? '<no message>');
    const ours = sender === 'tools' || (sender === undefined && journal.callsInFlight() > 0);
    const viewOnly = !ours && VIEW_REQUESTS.has(String(message.command));
    const known = classifyProblem(text, 'dap');
    journal.append({
        source: 'dap',
        origin: session.name,
        severity: ours ? 'warning' : viewOnly ? 'info' : 'error',
        message: text,
        debugSessionId: session.id,
        ...(known ? { code: known.code, hint: known.hint } : {}),
    });
}

/**
 * What adapter output weighs, by category, and whose it is. cdt-gdb-adapter
 * (behind `gdbtarget`) forwards the GDB server's stdout and stderr as
 * `server`, its whole log included, so that is `info` like the adapter's
 * `console`, unless pyOCD's own level says warning or error; GDB's own
 * `stderr` is a warning. The target's `stdout`, GDB's `log` stream and
 * anything else are not journaled.
 */
const OUTPUT_KINDS: Readonly<Partial<Record<string, { severity: ProblemSeverity; source: ProblemSource }>>> = {
    stderr: { severity: 'warning', source: 'dap' },
    console: { severity: 'info', source: 'dap' },
    important: { severity: 'info', source: 'dap' },
    server: { severity: 'info', source: 'gdb-server' },
};

/** A terminal colour or style sequence: pyOCD dims its tracebacks with them. */
const ANSI_SEQUENCE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The longest part of a line kept for the output event that ends it; a longer one is journaled as it is. */
const PARTIAL_LINE_MAX_CHARS = 4_096;
/** How long the start of a line waits for the output event that ends it before it is journaled as it is. */
const PARTIAL_LINE_WAIT_MS = 500;

/** The start of a line an output event left without its newline, and how to journal it if no end comes. */
interface PartialLine {
    text: string;
    timer: NodeJS.Timeout;
    flush: () => void;
}

/**
 * Per session and category, the start of a line an output event ended
 * without a newline: a GDB server that writes a few characters at a time (an
 * FVP's model output) would otherwise leave one record per fragment.
 */
const partialLines = new WeakMap<vscode.DebugSession, Map<string, PartialLine>>();

/** The kept start of a line of `category`, now taken; empty when there is none. */
function takePartialLine(session: vscode.DebugSession, category: string): string {
    const partial = partialLines.get(session)?.get(category);
    if (!partial) {
        return '';
    }
    clearTimeout(partial.timer);
    partialLines.get(session)?.delete(category);
    return partial.text;
}

/** Journals every kept start of a line of `session` as it is: the session ends. */
function flushPartialLines(session: vscode.DebugSession): void {
    const kept = partialLines.get(session);
    partialLines.delete(session);
    for (const partial of kept?.values() ?? []) {
        clearTimeout(partial.timer);
        partial.flush();
    }
}

/**
 * Adapter output of a journaled category, one record per line without its
 * colour codes, each weighed and coded by `classifyProblem` when it knows
 * the line; a GDB-server line it does not know keeps the level pyOCD gave it.
 * A line is journaled once its newline came, in this event or a later one;
 * the start of a line waits for its end at most `PARTIAL_LINE_WAIT_MS` and
 * `PARTIAL_LINE_MAX_CHARS`, and the session's end journals it as it is.
 */
function journalOutput(journal: ProblemJournal, session: vscode.DebugSession, category: unknown, output: string): void {
    const name = typeof category === 'string' ? category : 'console';
    const kind = OUTPUT_KINDS[name];
    if (!kind) {
        return;
    }
    const lines = (takePartialLine(session, name) + output).split(/\r?\n/);
    const rest = lines.pop() ?? '';
    for (const line of lines) {
        journalLine(journal, session, kind, line);
    }
    if (rest.length === 0) {
        return;
    }
    if (rest.length >= PARTIAL_LINE_MAX_CHARS) {
        journalLine(journal, session, kind, rest);
        return;
    }
    const flush = (): void => journalLine(journal, session, kind, rest);
    const timer = setTimeout(() => {
        if (partialLines.get(session)?.get(name)?.timer === timer) {
            partialLines.get(session)?.delete(name);
            flush();
        }
    }, PARTIAL_LINE_WAIT_MS);
    timer.unref?.();
    let kept = partialLines.get(session);
    if (!kept) {
        kept = new Map();
        partialLines.set(session, kept);
    }
    kept.set(name, { text: rest, timer, flush });
}

/** One line of adapter output as a problem record, unless it is empty once its colour codes are gone. */
function journalLine(journal: ProblemJournal, session: vscode.DebugSession, kind: { severity: ProblemSeverity; source: ProblemSource }, line: string): void {
    const text = line.replace(ANSI_SEQUENCE, '').trim();
    if (text.length === 0) {
        return;
    }
    const known = classifyProblem(text, kind.source);
    const leveled = kind.source === 'gdb-server' ? serverLineSeverity(text) : undefined;
    journal.append({
        source: known?.source ?? kind.source,
        origin: session.name,
        severity: known?.severity ?? leveled ?? kind.severity,
        message: text,
        debugSessionId: session.id,
        ...(known ? { code: known.code, hint: known.hint } : {}),
    });
}

// ── Output capture (GDB commands on cdt-gdb-adapter) ──────────────

/**
 * The text a session's adapter prints while a GDB command runs. cdt-gdb-adapter
 * answers a CLI command's evaluate request with an empty reply and sends the
 * command's text as `output` events; a capture collects them.
 */
export interface OutputCapture {
    /**
     * Ends the capture once no output has arrived for `quietMs`, and at the
     * latest `capMs` after this call or when the session ends, and resolves
     * the text collected.
     */
    settle(quietMs: number, capMs: number): Promise<string>;
    /** Ends the capture now and returns the text collected. */
    stop(): string;
}

interface Capture {
    session: vscode.DebugSession;
    categories: ReadonlySet<string>;
    chunks: string[];
    lastAt: number;
    open: boolean;
    /** Wakes a pending `settle` when output arrives or the session ends. */
    nudge?: () => void;
}

const captures = new Set<Capture>();

/**
 * Starts collecting the `output` events of `session` in `categories`. Start
 * it before the request whose output it is meant for is sent.
 */
export function captureOutput(session: vscode.DebugSession, categories: readonly string[] = ['stdout']): OutputCapture {
    const capture: Capture = { session, categories: new Set(categories), chunks: [], lastAt: Date.now(), open: true };
    captures.add(capture);
    const stop = (): string => {
        capture.open = false;
        capture.nudge = undefined;
        captures.delete(capture);
        return capture.chunks.join('');
    };
    const settle = (quietMs: number, capMs: number): Promise<string> => new Promise((resolve) => {
        const began = Date.now();
        let timer: NodeJS.Timeout | undefined;
        const check = (): void => {
            clearTimeout(timer);
            const now = Date.now();
            const quietUntil = Math.max(capture.lastAt, began) + quietMs;
            const capUntil = began + capMs;
            if (!capture.open || now >= quietUntil || now >= capUntil) {
                resolve(stop());
                return;
            }
            timer = setTimeout(check, Math.min(quietUntil, capUntil) - now);
        };
        capture.nudge = check;
        check();
    });
    return { settle, stop };
}

function collectOutput(session: vscode.DebugSession, category: unknown, text: string): void {
    for (const capture of captures) {
        if (capture.session === session && capture.open && capture.categories.has(String(category ?? 'console'))) {
            capture.chunks.push(text);
            capture.lastAt = Date.now();
            capture.nudge?.();
        }
    }
}

function closeCaptures(session: vscode.DebugSession): void {
    for (const capture of [...captures]) {
        if (capture.session === session) {
            capture.open = false;
            if (capture.nudge) {
                capture.nudge();
            } else {
                captures.delete(capture);
            }
        }
    }
}

// ── Breakpoint changes reaching the adapter ───────────────────────

/** The source of each `setBreakpoints` request VS Code sent, by request seq, until the adapter answers. */
const pendingBreakpointRequests = new WeakMap<vscode.DebugSession, Map<number, string>>();

interface BreakpointSyncWaiter {
    session: vscode.DebugSession;
    remaining: Set<string>;
    settle: (applied: boolean) => void;
}

const breakpointSyncWaiters = new Set<BreakpointSyncWaiter>();

/** A source path as a comparison key: forward slashes, a lower-case drive, case-folded on Windows. */
function pathKey(fsPath: string): string {
    const forward = fsPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (drive) => drive.toLowerCase());
    return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/**
 * Resolves true once the adapter of `session` has answered a
 * `setBreakpoints` request for each of `sourcePaths`, sent after this call;
 * false when `timeoutMs` passes first or the session ends. Call it before the
 * change to VS Code's breakpoint model that makes VS Code send the requests.
 */
export function awaitBreakpointsApplied(session: vscode.DebugSession, sourcePaths: readonly string[], timeoutMs: number): Promise<boolean> {
    if (sourcePaths.length === 0) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const waiter = {} as BreakpointSyncWaiter;
        const timer = setTimeout(() => waiter.settle(false), Math.max(timeoutMs, 0));
        waiter.session = session;
        waiter.remaining = new Set(sourcePaths.map(pathKey));
        waiter.settle = (applied) => {
            clearTimeout(timer);
            breakpointSyncWaiters.delete(waiter);
            resolve(applied);
        };
        breakpointSyncWaiters.add(waiter);
    });
}

function noteBreakpointRequest(session: vscode.DebugSession, message: any): void {
    const sourcePath = message?.arguments?.source?.path;
    if (typeof message?.seq !== 'number' || typeof sourcePath !== 'string') {
        return;
    }
    let pending = pendingBreakpointRequests.get(session);
    if (!pending) {
        pending = new Map();
        pendingBreakpointRequests.set(session, pending);
    }
    pending.set(message.seq, sourcePath);
}

function noteBreakpointResponse(session: vscode.DebugSession, message: any): void {
    const pending = pendingBreakpointRequests.get(session);
    const sourcePath = pending?.get(message?.request_seq);
    if (sourcePath === undefined) {
        return;
    }
    pending?.delete(message.request_seq);
    const key = pathKey(sourcePath);
    for (const waiter of [...breakpointSyncWaiters]) {
        if (waiter.session === session && waiter.remaining.delete(key) && waiter.remaining.size === 0) {
            waiter.settle(true);
        }
    }
}

// ── GDB dprintf logpoints (CMSIS Debugger) ────────────────────────

/** A logpoint the tools set as a GDB `dprintf` in a session. */
export interface GdbLogpoint {
    /** GDB's breakpoint number. */
    number: number;
    /** The source path the agent gave. */
    file: string;
    line: number;
    message: string;
    condition?: string;
}

const gdbLogpointsBySession = new WeakMap<vscode.DebugSession, Map<number, GdbLogpoint>>();

export function rememberGdbLogpoint(session: vscode.DebugSession, logpoint: GdbLogpoint): void {
    let known = gdbLogpointsBySession.get(session);
    if (!known) {
        known = new Map();
        gdbLogpointsBySession.set(session, known);
    }
    known.set(logpoint.number, { ...logpoint });
}

export function forgetGdbLogpoints(session: vscode.DebugSession, numbers: readonly number[]): void {
    const known = gdbLogpointsBySession.get(session);
    for (const number of numbers) {
        known?.delete(number);
    }
}

/** The session's logpoints, by GDB number; none once the session has ended. */
export function gdbLogpointsOf(session: vscode.DebugSession): GdbLogpoint[] {
    return [...(gdbLogpointsBySession.get(session)?.values() ?? [])]
        .sort((a, b) => a.number - b.number)
        .map((logpoint) => ({ ...logpoint }));
}

// ── Breakpoints VS Code adopts from an adapter ────────────────────

/**
 * A breakpoint an adapter announced as new — a GDB `break` command, such as
 * one in the launch configuration's `initCommands`, or one typed in the
 * Debug Console — at a source line.
 */
export interface AdoptedBreakpoint {
    /** The source path the adapter named. */
    path: string;
    line: number;
    /** The session whose adapter announced it. */
    sessionName: string;
}

/**
 * The breakpoints VS Code took into its own breakpoint model from a
 * `breakpoint` event with reason `new` and a source line, by path and line.
 * VS Code adds them without telling extensions — `vscode.debug.breakpoints`
 * lists them only after the window reloads them from the workspace's
 * storage — saves them, and sends them to later sessions. Kept for the
 * window, past the session's end; the adapter's `removed` event for the
 * same breakpoint takes one out, as VS Code does.
 */
const adoptedBreakpoints = new Map<string, AdoptedBreakpoint & { announced: Array<{ session: vscode.DebugSession; id: number }> }>();

/** An adapter's `breakpoint` event: a new one at a source line is adopted, a removed one forgotten. */
function noteBreakpointEvent(session: vscode.DebugSession, body: any): void {
    const breakpoint = body?.breakpoint;
    const id: unknown = breakpoint?.id;
    if (body?.reason === 'new') {
        const sourcePath: unknown = breakpoint?.source?.path;
        const line: unknown = breakpoint?.line;
        if (typeof sourcePath !== 'string' || sourcePath.length === 0 || typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
            return;
        }
        const key = `${pathKey(sourcePath)}:${line}`;
        const known = adoptedBreakpoints.get(key) ?? { path: sourcePath, line, sessionName: session.name, announced: [] };
        if (typeof id === 'number') {
            known.announced.push({ session, id });
        }
        adoptedBreakpoints.set(key, known);
    } else if (body?.reason === 'removed' && typeof id === 'number') {
        for (const [key, known] of adoptedBreakpoints) {
            if (known.announced.some((entry) => entry.session === session && entry.id === id)) {
                adoptedBreakpoints.delete(key);
            }
        }
    }
}

/** The breakpoints VS Code adopted from an adapter in this window, in the order they were announced. */
export function adoptedBreakpointsOf(): AdoptedBreakpoint[] {
    return [...adoptedBreakpoints.values()].map(({ path: sourcePath, line, sessionName }) => ({ path: sourcePath, line, sessionName }));
}

/** Forget every adopted breakpoint: for harnesses that start each scenario with an empty breakpoint model. */
export function forgetAdoptedBreakpoints(): void {
    adoptedBreakpoints.clear();
}

// ── The core's debug status (#3) ──────────────────────────────────

/**
 * When the last DHCSR read of a session got no answer. A stop event after it
 * means GDB talked to the target again, so the stop forgets it, as does a
 * DHCSR read that answers and the session's end.
 */
const silentCores = new WeakMap<vscode.DebugSession, number>();

/** Keeps what one DHCSR read of `session` found: `silent` with its time, `answers` forgets it, `unknown` changes nothing. */
export function noteCoreVerdict(session: vscode.DebugSession, verdict: CoreVerdict, now: number = Date.now()): void {
    if (verdict === 'silent') {
        silentCores.set(session, now);
    } else if (verdict === 'answers') {
        silentCores.delete(session);
    }
}

/** When the last DHCSR read of `session` got no answer, unless the target stopped or DHCSR answered since. */
export function coreSilentSince(session: vscode.DebugSession): number | undefined {
    return silentCores.get(session);
}

// ── A session asked to end ─────────────────────────────────────────

/** The DAP requests that end a session. */
const END_REQUESTS: ReadonlySet<string> = new Set(['disconnect', 'terminate']);

/**
 * The last request to end a session that went to its adapter, and when. Kept
 * until the session ends or starts again, and forgotten when the adapter
 * refuses it.
 */
const endRequests = new WeakMap<vscode.DebugSession, { command: string; at: number }>();

/** When a `disconnect` or `terminate` request went to `session`'s adapter, and which; undefined when none did. */
export function endRequestOf(session: vscode.DebugSession): { command: string; at: number } | undefined {
    return endRequests.get(session);
}

// ── Session end ────────────────────────────────────────────────────

interface EndWaiter {
    session: vscode.DebugSession;
    settle: (ended: boolean) => void;
}

const endWaiters = new Set<EndWaiter>();

/**
 * Resolves true when `session` ends (at once when this window no longer
 * tracks it as live), false when `timeoutMs` passes first.
 */
export function waitForSessionEnd(session: vscode.DebugSession, timeoutMs: number): Promise<boolean> {
    if (endedSessions.has(session) || !liveSessions.includes(session)) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const waiter = {} as EndWaiter;
        const timer = setTimeout(() => waiter.settle(false), Math.max(timeoutMs, 0));
        waiter.session = session;
        waiter.settle = (ended) => {
            clearTimeout(timer);
            endWaiters.delete(waiter);
            resolve(ended);
        };
        endWaiters.add(waiter);
    });
}

/** Everything the tracker holds for a session goes when it ends, and whoever waits on it is told. */
function sessionEnded(session: vscode.DebugSession): void {
    flushPartialLines(session);
    endedSessions.add(session);
    sessionStates.delete(session);
    removeLiveSession(session);
    settleStopWaiters(session, { kind: 'ended' });
    closeCaptures(session);
    gdbLogpointsBySession.delete(session);
    silentCores.delete(session);
    endRequests.delete(session);
    pendingBreakpointRequests.delete(session);
    ownRequestsDue.delete(session);
    requestsSent.delete(session);
    for (const waiter of [...breakpointSyncWaiters]) {
        if (waiter.session === session) {
            waiter.settle(false);
        }
    }
    for (const waiter of [...endWaiters]) {
        if (waiter.session === session) {
            waiter.settle(true);
        }
    }
    for (const waiter of [...focusWaiters]) {
        if (waiter.session === session) {
            waiter.settle(false);
        }
    }
}

// ── The tracker ────────────────────────────────────────────────────

/** Take VS Code's dialog off a failed start an agent asked for, and tell the user in a notification instead. Never throws. */
function noticeQuietStartFailure(session: vscode.DebugSession, message: { message?: unknown; body?: { error?: unknown } }): void {
    try {
        const text = quietStartFailure(message);
        logger.info(`The ${session.configuration?.request ?? 'debug'} start of '${session.name}' an agent asked for failed: ${text}; VS Code shows no dialog for it`);
        // The failed response is journaled already (journalFailedResponse); the toast is for the user only.
        void notifyJournaledWarning(`CMSIS Developer Assistant: the debug start an agent asked for ('${session.name}') failed: ${text} The agent got the error.`);
    } catch (caught) {
        logger.warn('A failed debug start could not be kept from opening a dialog', caught);
    }
}

/**
 * The adapter tracker of one session: what `registerSessionStateTracker`'s
 * factory hands VS Code for every session, exported so tests can feed it
 * messages. Adds the session to the live list; problems go to `journal`,
 * the window's by default.
 */
export function createSessionTracker(session: vscode.DebugSession, journal: ProblemJournal = problemJournal()): vscode.DebugAdapterTracker {
    // VS Code's restart of an adapter without a restart request relaunches it in the same session.
    endedSessions.delete(session);
    silentCores.delete(session);
    endRequests.delete(session);
    addLiveSession(session);
    noteSessionOrigin(session);
    for (const listener of [...beginListeners]) {
        try {
            listener(session);
        } catch (caught) {
            logger.warn(`A listener for the start of '${session.name}' failed`, caught);
        }
    }
    return {
        onWillReceiveMessage(message: any): void {
            if (message?.type !== 'request') {
                return;
            }
            noteRequestSent(session, message);
            if (message.command === 'setBreakpoints') {
                noteBreakpointRequest(session, message);
            } else if (END_REQUESTS.has(message.command)) {
                endRequests.set(session, { command: message.command, at: Date.now() });
            }
        },
        onDidSendMessage(message: any): void {
            if (message?.type === 'response') {
                const sender = senderOf(session, message);
                if (message.command === 'setBreakpoints') {
                    noteBreakpointResponse(session, message);
                }
                if (END_REQUESTS.has(message.command) && message.success === false) {
                    endRequests.delete(session);
                }
                if (message.success === false) {
                    journalFailedResponse(journal, session, message, sender);
                    if ((message.command === 'launch' || message.command === 'attach') && agentStartedSessions.has(session)) {
                        noticeQuietStartFailure(session, message);
                    }
                }
                return;
            }
            if (message?.type !== 'event') { return; }
            if (message.event === 'output') {
                const category = message.body?.category;
                const output = String(message.body?.output ?? '');
                collectOutput(session, category, output);
                journalOutput(journal, session, category, output);
                return;
            }
            if (message.event === 'breakpoint') {
                // GDB deleted a breakpoint (a `delete` typed in the Debug Console, say).
                const removedId = message.body?.breakpoint?.id;
                if (message.body?.reason === 'removed' && typeof removedId === 'number') {
                    forgetGdbLogpoints(session, [removedId]);
                }
                noteBreakpointEvent(session, message.body);
                return;
            }
            const state = getOrInit(session);
            if (message.event === 'stopped') {
                state.lastEvent = 'stopped';
                state.stoppedReason = message.body?.reason ?? null;
                state.stoppedThreadId = message.body?.threadId ?? null;
                state.lastEventAt = Date.now();
                // The target ran and stopped again: GDB has talked to it since a DHCSR read that got no answer.
                silentCores.delete(session);
                logger.debug(`[session-tracker] stopped (${state.stoppedReason}) on ${session.name}`);
                settleStopWaiters(session, { kind: 'stopped', reason: state.stoppedReason, threadId: state.stoppedThreadId });
            } else if (message.event === 'continued') {
                state.lastEvent = 'continued';
                state.stoppedReason = null;
                state.stoppedThreadId = null;
                state.lastEventAt = Date.now();
                logger.debug(`[session-tracker] continued on ${session.name}`);
            } else if (message.event === 'terminated' || message.event === 'exited') {
                sessionEnded(session);
            }
        },
        onWillStopSession(): void {
            sessionEnded(session);
        },
        onError(error: Error): void {
            logger.debug(`[session-tracker] adapter error on ${session.name}`, error);
            journal.append({
                source: 'dap', origin: session.name, severity: 'error',
                message: `adapter error: ${error?.message ?? String(error)}`, debugSessionId: session.id,
            });
        },
    };
}

/**
 * Register a global DebugAdapterTracker that records `stopped` and
 * `continued` events for every debug session VS Code starts. Call once
 * during extension activation.
 */
export function registerSessionStateTracker(context: vscode.ExtensionContext): void {
    const factory: vscode.DebugAdapterTrackerFactory = {
        createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
            return createSessionTracker(session);
        },
    };

    // Register for every debug type. VS Code lets us pass '*' to match all.
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('*', factory),
    );

    // Belt-and-braces: also drop sessions on the VS Code termination event,
    // in case the adapter tracker's onWillStopSession did not fire.
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession((session) => {
            sessionEnded(session);
        }),
    );

    logger.info('Session state tracker registered (DAP stopped/continued events + live-session list)');
}
