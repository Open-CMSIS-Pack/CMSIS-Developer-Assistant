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
 * What people see of multi-window routing (#16), as pure functions of a
 * window's state, so that every state is tested without VS Code: the text
 * and tooltip of the status-bar item each window shows, and the entries of
 * Select Target Window. The item, its timers, the op hook and the quick pick
 * are wired in src/windowStatus.ts.
 *
 * The item names the window's role, marks the default target and spins while
 * an agent call runs in the window. The tooltip adds the MCP endpoint, the
 * default target, the calls running and the last one, and in the router
 * window every open agent session with the window it drives and why. While
 * a call runs on past its fence — the agent was told it timed out, and for
 * the calls that can open one a picker or dialog may wait for the user —
 * the item asks for the warning background (#14).
 */

import * as path from 'path';
import { isSerialOp } from './opTable';
import type { ResolutionReason, WindowRegistration, WindowRole } from '../utils/workspaceRegistry';

/** Where one agent session's path-less calls go, and the rung of the router's ladder that chose that window. */
export interface SessionTarget {
    pid: number;
    name: string;
    reason: ResolutionReason;
}

/** One open MCP session of the router window. */
export interface SessionView {
    /** The MCP session id. */
    id: string;
    /** The client's name from its initialize request, such as "claude-code". */
    client?: string;
    /** None before the session's first call, and after its window went away. */
    target?: SessionTarget;
}

/** The default target as people see it: the name it was chosen under, and the pid of its window while that is open. */
export interface DefaultTargetView {
    name: string;
    pid?: number;
}

/** An agent call running in this window, by tool name, since when. */
export interface RunningCall {
    tool: string;
    since: number;
    /** True once its fence answered the agent `WORKER_TIMEOUT` while it runs on (#14). */
    fenced?: boolean;
    /** True when the call can wait for a picker or dialog (`mayWaitForUser`). */
    waitsForUser?: boolean;
}

/** Everything one rendering of the status-bar item reads. */
export interface WindowStatusState {
    role: WindowRole;
    /** This window's pid in the registry. */
    pid: number;
    /** The agents' MCP URL. */
    endpoint: string;
    /** None when no default target is chosen. */
    defaultTarget?: DefaultTargetView;
    /** The agent calls running in this window now, oldest first. */
    running: readonly RunningCall[];
    /** The agent call that ended last in this window, and when. */
    lastCall?: { tool: string; at: number };
    /** The router's open MCP sessions; none in a worker. */
    sessions?: readonly SessionView[];
    /** The clock the times above are read against. */
    now: number;
}

/** What the status-bar item shows. */
export interface WindowStatusView {
    text: string;
    tooltip: string;
    /** True while a call runs on past its fence: the item takes the warning background. */
    warning: boolean;
}

/** One entry of Select Target Window; the one without a window clears the default. */
export interface TargetChoice {
    label: string;
    description?: string;
    detail?: string;
    window?: WindowRegistration;
}

/** The entry of Select Target Window that clears the default target. */
export const AUTOMATIC_CHOICE = 'Automatic (no default)';

const CHECKED = '$(check) ';
const CLICK_LINE = 'Click to choose the target window.';
/**
 * Sessions the router's tooltip lists, newest last. A client that never ends
 * its sessions leaves them open until the router stops.
 */
const MAX_LISTED_SESSIONS = 10;

/** The first lines of the tooltip: the product, then what the window does. */
const ROLE_LINES: Readonly<Record<WindowRole, string>> = {
    router: 'CMSIS Developer Assistant\nRouter window: serves MCP, forwards agent calls.',
    worker: 'CMSIS Developer Assistant\nWorker window: runs the calls the router forwards.',
};

/** Why a session drives its window, as the router's tooltip says it. */
const REASON_TEXT: Readonly<Record<ResolutionReason, string>> = {
    'window-arg': 'named by a call',
    path: 'from a file path',
    pinned: 'pinned',
    cached: 'kept from an earlier call',
    default: 'default target',
    'active-session': 'the only debug session',
    'only-window': 'the only window',
    'router-window': 'the router\'s own window, for a call any window can run',
};

/** Tools whose names do not follow from their op name. */
const IRREGULAR_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
    ['handleContinue', 'continue_execution'],
    ['handlePause', 'pause_execution'],
    ['handleRestart', 'restart_debugging'],
    ['handleGetVariables', 'get_variables_values'],
    ['handleCmsisCommand', 'cmsis_action'],
    ['handleOpenInUi', 'serial_open_monitor'],
]);

/**
 * The tool an op serves: `handleReadMemory` is `read_memory`, a serial op
 * gets the `serial_` prefix, and the few irregular names come from a table.
 */
export function toolNameOf(op: string): string {
    const irregular = IRREGULAR_TOOL_NAMES.get(op);
    if (irregular !== undefined) {
        return irregular;
    }
    const words = op.replace(/^handle/, '').replace(/[A-Z]/g, (letter: string, at: number) => `${at > 0 ? '_' : ''}${letter.toLowerCase()}`);
    return isSerialOp(op) ? `serial_${words}` : words;
}

/** A duration for people: seconds under a minute, then whole minutes, then whole hours. */
export function durationText(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds} s`;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/** The default target in words, seen from the window with `ownPid`. */
export function defaultTargetText(chosen: DefaultTargetView | undefined, ownPid: number): string {
    if (chosen === undefined) {
        return 'none, agents choose automatically';
    }
    if (chosen.pid === undefined) {
        return `${chosen.name} (not open)`;
    }
    return chosen.pid === ownPid ? 'this window' : `${chosen.name} (pid ${chosen.pid})`;
}

/** What a call past its fence adds to its entry in the tooltip; a picker or dialog only for a call that can open one. */
const FENCED_NOTE = ' (the agent was told it timed out)';
const FENCED_USER_NOTE = ' (the agent was told it timed out; a picker or dialog here may be waiting for you)';

/** The lines on the agent calls of this window: those running, then the last that ended. */
function callLines(state: WindowStatusState): string[] {
    const lines: string[] = [];
    if (state.running.length > 0) {
        const note = (call: RunningCall): string => (call.fenced ? (call.waitsForUser ? FENCED_USER_NOTE : FENCED_NOTE) : '');
        const calls = state.running.map((call) => `${call.tool} for ${durationText(state.now - call.since)}${note(call)}`);
        lines.push(`Running here: ${calls.join(', ')}`);
    }
    const last = state.lastCall;
    lines.push(last === undefined ? 'Last agent call here: none yet' : `Last agent call here: ${last.tool} ${durationText(state.now - last.at)} ago`);
    return lines;
}

/** One session as the router's tooltip lists it: client and short id, then the window it drives and why. */
function sessionLine(session: SessionView, ownPid: number): string {
    const shortId = session.id.slice(0, 8);
    const who = session.client ? `${session.client} (${shortId})` : shortId;
    const target = session.target;
    if (target === undefined) {
        return `  • ${who} → no window yet`;
    }
    const where = target.pid === ownPid ? 'this window' : `${target.name} (pid ${target.pid})`;
    return `  • ${who} → ${where}, ${REASON_TEXT[target.reason]}`;
}

/**
 * The item's text and tooltip. The text is `$(cda-robot) R` or
 * `$(cda-robot) W`, then ` · default` when this window is the default
 * target and a spinner while an agent call runs here. `warning` is set while
 * a running call is past its fence.
 */
export function renderWindowStatus(state: WindowStatusState): WindowStatusView {
    const isDefault = state.defaultTarget?.pid === state.pid;
    const text = `$(cda-robot) ${state.role === 'router' ? 'R' : 'W'}${isDefault ? ' · default' : ''}${state.running.length > 0 ? ' $(sync~spin)' : ''}`;
    const lines = [
        ROLE_LINES[state.role],
        `MCP endpoint: ${state.endpoint}`,
        `Default target windows: ${defaultTargetText(state.defaultTarget, state.pid)}`,
        ...callLines(state),
    ];
    if (state.sessions !== undefined) {
        const earlier = Math.max(0, state.sessions.length - MAX_LISTED_SESSIONS);
        lines.push(state.sessions.length === 0 ? 'Agent sessions: none open' : 'Agent sessions:');
        if (earlier > 0) {
            lines.push(`  … and ${earlier} earlier`);
        }
        lines.push(...state.sessions.slice(earlier).map((session) => sessionLine(session, state.pid)));
    }
    lines.push('', CLICK_LINE);
    return { text, tooltip: lines.join('\n'), warning: state.running.some((call) => call.fenced === true) };
}

/** The second line of a window's entry: this window, role, debug session, solution and pid. */
function windowDetail(entry: WindowRegistration, ownPid: number): string {
    const parts: string[] = [];
    if (entry.pid === ownPid) {
        parts.push('this window');
    }
    if (entry.role !== undefined) {
        parts.push(entry.role);
    }
    if (entry.hasActiveSession) {
        parts.push(entry.activeConfigurationName ? `debugging: ${entry.activeConfigurationName}` : 'debugging');
    }
    if (entry.cmsisProject) {
        parts.push(`cmsis=${path.basename(entry.cmsisProject)}`);
    }
    parts.push(`pid ${entry.pid}`);
    return parts.join(' · ');
}

/**
 * The entries of Select Target Window: every registered window, by name
 * with its folders and details, then Automatic. The current choice carries
 * `$(check)`; Automatic does when no default target is set.
 */
export function targetChoices(windows: readonly WindowRegistration[], chosen: DefaultTargetView | undefined, ownPid: number): TargetChoice[] {
    const choices: TargetChoice[] = windows.map((entry) => {
        const folders = Array.isArray(entry.workspaceFolders) ? entry.workspaceFolders : [];
        return {
            label: `${chosen?.pid === entry.pid ? CHECKED : ''}${entry.name}`,
            description: folders.length > 0 ? folders.join(', ') : '(no folder open)',
            detail: windowDetail(entry, ownPid),
            window: entry,
        };
    });
    choices.push({
        label: `${chosen === undefined ? CHECKED : ''}${AUTOMATIC_CHOICE}`,
        description: 'a file path, a pin or the one debugging window decides',
    });
    return choices;
}
