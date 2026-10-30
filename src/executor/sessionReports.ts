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
 * Facts about the session, as data and as text: the `threads` readiness
 * probe behind the status tools, the `check_target_connection` report, the
 * `get_device_info` block, and the workspace folder in which a launch
 * configuration named by the agent is looked up.
 *
 * The `threads` probe asks only the debug adapter. Whether the core answers
 * is a DHCSR read (src/core/probeWedge.ts): `check_target_connection` makes
 * one on a stopped CMSIS Debugger session, and the status reports the last
 * one that got no answer, kept by the session tracker, without reading.
 */

import * as vscode from 'vscode';
import { CMSIS_DEBUGGER_TYPE } from '../core/gdbDialect';
import { ageText, coreVerdict, DebugPortProbe, dhcsrSummary, silentCoreText, wedgeHint } from '../core/probeWedge';
import { coreSilentSince, endRequestOf, getStoppedReason, isSessionStopped, resolveActiveSession } from '../utils/sessionStateTracker';
import { customRequestWithTimeout, HardwareTimeoutError } from '../utils/timeout';
import { messageOf } from './common';
import { SessionStatus } from './contract';

/** The probe's detail when the CMSIS Debugger's adapter answers without a thread list. */
const NOT_TAKING_REQUESTS = 'The adapter answered the threads probe without a thread list: it takes no requests until GDB '
    + 'has connected to the target and run the launch configuration\'s commands, nor while the session shuts down.';

/**
 * Whether the successful `threads` reply `reply` of `session` comes from an
 * adapter that takes requests. cdt-gdb-adapter, the CMSIS Debugger's adapter
 * (`gdbtarget`), answers every request with an empty success, without a
 * body, until GDB has connected to the target and run the launch
 * configuration's commands, and again once the session shuts down; while it
 * takes requests, its `threads` reply carries the thread list. The replies of
 * other adapters count as they are.
 */
export function takesRequests(session: vscode.DebugSession, reply: unknown): boolean {
    if (session.type !== CMSIS_DEBUGGER_TYPE) {
        return true;
    }
    return Array.isArray((reply as { threads?: unknown } | null | undefined)?.threads);
}

/** The detail of a session asked to end `ageMs` ago with `command`, whose adapter gave the probe no thread list. */
function endingDetail(command: string, ageMs: number): string {
    return `The session was asked to end (${command} sent ${ageText(ageMs)} ago); its adapter takes no requests while it shuts down.`;
}

/**
 * Probes the session with one `threads` request. A timeout means the probe
 * or target is hung; any other failure usually means the adapter is still
 * starting, and so does a CMSIS Debugger reply without a thread list
 * (`takesRequests`). A session asked to end (`endRequestOf`) that gives no
 * thread list, timeout included, is shutting down: `initializing`, with
 * `endRequestedForMs`. Never rejects.
 */
export async function probeSession(probeMs: number): Promise<SessionStatus> {
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
    const identity = {
        sessionName: session.name,
        sessionType: session.type ?? null,
        configurationName: session.configuration?.name ?? null,
    };
    const sentAt = Date.now();
    let reply: unknown;
    try {
        reply = await customRequestWithTimeout(session, 'threads', {}, probeMs);
    } catch (err) {
        const hung = err instanceof HardwareTimeoutError;
        const ending = endRequestOf(session);
        if (ending) {
            const endRequestedForMs = Math.max(0, Date.now() - ending.at);
            const probe = hung ? `The threads probe got no answer within ${probeMs}ms.` : `The threads probe failed: ${messageOf(err)}`;
            return {
                state: 'initializing',
                ...identity,
                dapResponsive: false,
                dapProbeMs: null,
                detail: `${endingDetail(ending.command, endRequestedForMs)} ${probe}`,
                endRequestedForMs,
            };
        }
        return {
            state: hung ? 'unresponsive' : 'initializing',
            ...identity,
            dapResponsive: false,
            dapProbeMs: null,
            detail: hung
                ? `DAP threads probe timed out after ${probeMs}ms — probe/target may be hung.`
                : `DAP threads probe failed: ${messageOf(err)}`,
        };
    }
    const roundTripMs = Date.now() - sentAt;
    if (!takesRequests(session, reply)) {
        const ending = endRequestOf(session);
        const endRequestedForMs = ending ? Math.max(0, Date.now() - ending.at) : undefined;
        return {
            state: 'initializing',
            ...identity,
            dapResponsive: true,
            dapProbeMs: roundTripMs,
            detail: ending && endRequestedForMs !== undefined ? endingDetail(ending.command, endRequestedForMs) : NOT_TAKING_REQUESTS,
            ...(endRequestedForMs === undefined ? {} : { endRequestedForMs }),
        };
    }
    const halted = isSessionStopped(session);
    const reason = halted ? getStoppedReason(session) : null;
    const silentSince = halted ? coreSilentSince(session) : undefined;
    return {
        state: halted ? 'stopped' : 'running',
        ...identity,
        dapResponsive: true,
        dapProbeMs: roundTripMs,
        detail: reason === null ? undefined : `Stopped reason: ${reason}`,
        ...(silentSince === undefined ? {} : { coreSilentForMs: Math.max(0, Date.now() - silentSince) }),
    };
}

/** The `Target state` lines of a stopped session: what the DHCSR read `port` found, when there was one that tells something. */
function stoppedLines(port: DebugPortProbe | undefined, request: string | undefined): string[] {
    if (port?.readable) {
        return [`Target state: stopped — the debug port answers: ${dhcsrSummary(port.dhcsr)}.`];
    }
    if (port && coreVerdict(port) === 'silent') {
        return [`Target state: stopped, but ${silentCoreText(port)}`, wedgeHint(request)];
    }
    return ['Target state: stopped — full inspection is available.'];
}

/**
 * The `check_target_connection` text for a probe result. The stop reason is
 * left out. `port` is the DHCSR read of a stopped CMSIS Debugger session,
 * `request` that session's `configuration.request`.
 */
export function connectionReport(status: SessionStatus, port?: DebugPortProbe, request?: string): string {
    if (status.state === 'no-session') {
        return 'No active debug session.';
    }
    const report = [`Session: ${status.sessionName} (type=${status.sessionType ?? 'unknown'})`];
    if (status.configurationName) {
        report.push(`Configuration: ${status.configurationName}`);
    }
    switch (status.state) {
        case 'unresponsive':
        case 'initializing':
            report.push(status.state === 'unresponsive'
                ? 'DAP probe: TIMEOUT — probe/target unresponsive'
                : status.dapResponsive
                    ? `DAP probe: NOT READY (${status.dapProbeMs}ms)`
                    : status.endRequestedForMs !== undefined
                        ? 'DAP probe: FAILED — the session is shutting down'
                        : 'DAP probe: FAILED — adapter likely still initializing');
            if (status.detail) {
                report.push(status.detail);
            }
            break;
        case 'running':
            report.push(`DAP probe: OK (${status.dapProbeMs}ms)`,
                'Target state: running — DAP reads (memory/registers/variables) will be rejected until the target stops.');
            break;
        case 'stopped':
            report.push(`DAP probe: OK (${status.dapProbeMs}ms)`, ...stoppedLines(port, request));
            break;
    }
    return report.join('\n');
}

/** The `get_device_info` block, read from the launch configuration only. */
export function deviceReport(session: vscode.DebugSession): string {
    const launch = session.configuration;
    const rows: Array<[label: string, value: unknown]> = [
        ['Session name', session.name],
        ['Debug type', launch.type || '<unknown>'],
        ['Program', launch.program || '<unknown>'],
        ['GDB', launch.gdb || '<default>'],
        ['Server', launch.target?.server || '<unknown>'],
        ['Port', launch.target?.port || '<unknown>'],
    ];
    if (launch.cmsis?.cbuildRunFile) {
        rows.push(['cbuild-run', launch.cmsis.cbuildRunFile]);
    }
    return rows.reduce((block, [label, value]) => `${block}  ${label}: ${value}\n`, '=== Debug Session Info ===\n');
}

/**
 * The open workspace folder a launch configuration named for `directory` is
 * resolved in: the folder VS Code maps the directory to; else the first
 * folder that equals, contains or lies inside the directory (compared with
 * trailing separators removed, `/` as the only separator and case-sensitive,
 * KB12); else the only folder when exactly one is open.
 */
export function launchFolderFor(directory: string): vscode.WorkspaceFolder | undefined {
    const open = vscode.workspace.workspaceFolders ?? [];
    if (open.length === 0) {
        return undefined;
    }
    const mapped = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(directory));
    if (mapped) {
        return mapped;
    }
    const wanted = trimSeparators(directory);
    const related = open.find((folder) => {
        const root = trimSeparators(folder.uri.fsPath);
        return wanted === root || wanted.startsWith(`${root}/`) || root.startsWith(`${wanted}/`);
    });
    if (related) {
        return related;
    }
    return open.length === 1 ? open[0] : undefined;
}

/** Why `launchFolderFor` found nothing, listing the folders that are open. */
export function noLaunchFolderText(directory: string): string {
    const open = vscode.workspace.workspaceFolders ?? [];
    const listed = open.length > 0 ? open.map((folder) => folder.uri.fsPath).join(', ') : '(none)';
    return `No VS Code workspace folder matches workingDirectory '${directory}'. Open workspace folders: ${listed}. ` +
        'launch.json is resolved relative to an open workspace folder — open the project folder ' +
        '(the one containing .vscode/launch.json) in this VS Code window.';
}

function trimSeparators(fsPath: string): string {
    return fsPath.replace(/[\\/]+$/, '');
}
