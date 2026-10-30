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
 * Before a launch starts a GDB server on a local port: is that port taken?
 *
 * Two windows may launch on the same GDB port: CMSIS Solution gives its
 * pyOCD, J-Link and FVP set-ups 3333 alike. A server that listens there
 * already — another window's CMSIS Run task, another window's debug
 * session, any other program — answers GDB's `localhost:<port>` before the
 * new one does, and GDB then debugs that target instead: pyOCD halts its
 * board for the new client, and the launch still looks fine to the tools. A
 * second FVP launch on the same port even removes the first window's model.
 *
 * What is known without a connection decides, since a GDB server takes any
 * connection as a client (pyOCD halts the target for it):
 *
 *   1. the GDB ports the other registered windows publish
 *      (`GdbPortClaim`s of their registry entries), which name the window and
 *      what holds the port;
 *   2. else a bind test: this process binds the port on 127.0.0.1, ::1 and
 *      the wildcard, one after the other, and closes it at once. A bind that
 *      fails with EADDRINUSE means some other process listens where GDB's
 *      `localhost` would reach it. pyOCD listens on 127.0.0.1 only, Docker
 *      publishes a container's port on the wildcard, and on macOS a bind
 *      notices only a listener on the same address, hence all three. Any
 *      other failure (no IPv6, a privileged port) proves nothing.
 *
 * Callers first acquire a cross-process GdbPortReservations claim. The
 * preflight alone is not atomic: two windows could both see a free port
 * before either server starts. The claim spans that gap without binding
 * the port that the real GDB server needs.
 *
 * `gdbPortRefusal` words the `PROBE_BUSY` refusal: what was not started, the
 * port, who holds it, and the way out — stop it there, or another port.
 *
 * No `vscode`: the windows and the probe come in.
 */

import * as net from 'net';
import { Refusal } from './toolResult';
import type { GdbPortClaim, GdbServerKind } from './gdbServerPorts';

/** Another registered window and the GDB ports it publishes. */
export interface PortClaimingWindow {
    pid: number;
    /** The window's name in the registry; `(no workspace)` for a window without a folder. */
    name: string;
    claims: readonly GdbPortClaim[];
}

/** Who holds a GDB port: another window, by its claim, or a process that is no window of this extension. */
export type GdbPortHolder =
    | { kind: 'window'; pid: number; name: string; claim: GdbPortClaim }
    | { kind: 'reservation'; pid: number; name: string; label: string }
    | { kind: 'listener' };

/** What one bind test says: another process listens, nothing does, or the bind failed for another reason. */
export type BindOutcome = 'in-use' | 'free' | 'unknown';

/** Where GDB's `localhost` connects, and the wildcard that Docker publishes on; tried in this order. */
export const BIND_PROBE_HOSTS: readonly string[] = ['127.0.0.1', '::1', '0.0.0.0'];
/** A bind answers at once; this only guards against a listen callback that never comes. */
const BIND_PROBE_MS = 1_000;
/** The registry name of a window without a workspace. */
const NO_WORKSPACE = '(no workspace)';

/**
 * Bind `host:port`, and close it again at once. Never connects: no GDB
 * server sees a client.
 */
export function bindProbe(port: number, host: string): Promise<BindOutcome> {
    return new Promise<BindOutcome>((resolve) => {
        const server = net.createServer();
        let settled = false;
        const settle = (outcome: BindOutcome): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(outcome);
            }
        };
        const timer = setTimeout(() => {
            server.close();
            settle('unknown');
        }, BIND_PROBE_MS);
        server.unref();
        server.once('error', (error: NodeJS.ErrnoException) => settle(error.code === 'EADDRINUSE' ? 'in-use' : 'unknown'));
        server.listen({ port, host }, () => server.close(() => settle('free')));
    });
}

/**
 * True when another process listens on `port` where a GDB on this machine
 * would reach it: a bind on one of `hosts` fails with EADDRINUSE. The binds
 * run one after the other, since on Linux our own open probe on 127.0.0.1
 * would make the wildcard bind fail.
 */
export async function portInUse(port: number, hosts: readonly string[] = BIND_PROBE_HOSTS): Promise<boolean> {
    for (const host of hosts) {
        if (await bindProbe(port, host) === 'in-use') {
            return true;
        }
    }
    return false;
}

/**
 * Who holds `port`: the first other window whose published claims name it,
 * else a process that listens there (`inUse`, the bind test), else nobody.
 */
export async function findGdbPortHolder(
    port: number,
    windows: readonly PortClaimingWindow[],
    inUse: (port: number) => Promise<boolean> = portInUse,
): Promise<GdbPortHolder | undefined> {
    for (const window of windows) {
        const claim = window.claims.find((candidate) => candidate.port === port);
        if (claim) {
            return { kind: 'window', pid: window.pid, name: window.name, claim };
        }
    }
    return await inUse(port) ? { kind: 'listener' } : undefined;
}

/** What was about to start a GDB server, as the refusal names it. */
export interface PortStart {
    /** A debug session's launch (`load_and_debug`, `start_debugging`) or a CMSIS Run task (`run`, `load_and_run`). */
    what: 'launch' | 'run';
    /** The beginning of the refusal: `CMSIS 'load_and_debug' on MPS3 not started`. */
    subject: string;
    /** The launch configuration's name; none for a CMSIS Run. */
    configuration?: string;
    /** The GDB server that would have started, when known. */
    server?: GdbServerKind;
}

/** A window as the refusal names it: `window 'item13' (pid 70401)`. */
function windowText(holder: { pid: number; name: string }): string {
    return holder.name && holder.name !== NO_WORKSPACE ? `window '${holder.name}' (pid ${holder.pid})` : `the window with pid ${holder.pid}`;
}

/** `pyOCD GDB server`, or `GDB server` when the kind is not known. */
function serverText(server: GdbServerKind | undefined): string {
    return server ? `${server} GDB server` : 'GDB server';
}

/** What uses the port in that window: `its CMSIS Run task (pyOCD GDB server)`. */
function claimText(claim: GdbPortClaim): string {
    const what = claim.source === 'cmsis-run' ? `its ${claim.label} task` : `its debug session '${claim.label}'`;
    return `${what} (${serverText(claim.server)})`;
}

/** Where this project sets another port, by what would have started. */
function anotherPort(start: PortStart): string {
    if (start.what === 'run') {
        return 'give this project\'s GDB server another port';
    }
    return start.server === 'Arm FVP'
        ? 'give this project another port: GDBServer.port in .vscode/launch.json'
        : `give this project another port: target.port of '${start.configuration ?? 'the launch configuration'}' in .vscode/launch.json`;
}

/**
 * The `PROBE_BUSY` refusal of a start whose GDB port `holder` holds: what was
 * not started, the port, who holds it and what follows from two servers on
 * one port; the hint says how to stop the holder or move this project.
 */
export function gdbPortRefusal(start: PortStart, port: number, holder: GdbPortHolder): Refusal {
    const starts = start.what === 'run'
        ? `its ${serverText(start.server)} (CMSIS Run) would use port ${port}`
        : `the ${serverText(start.server)} of '${start.configuration ?? 'its launch configuration'}' would use port ${port}`;
    const follows = start.what === 'run'
        ? 'Two GDB servers on one port: the new one fails to start, or a GDB meant for one of them reaches the other.'
        : 'GDB would connect to that server instead of the new one, and debug — and halt — that target.';
    if (holder.kind === 'reservation') {
        return new Refusal('PROBE_BUSY',
            `${start.subject}: ${starts}, which ${windowText(holder)} has reserved for '${holder.label}'. ${follows}`,
            `Wait for that start to finish, or stop its session/task there once the user agrees. A pending picker keeps its reservation; `
                + `cancel it and reload that window before retrying, or ${anotherPort(start)}.`);
    }
    if (holder.kind === 'window') {
        const stop = holder.claim.source === 'cmsis-run'
            ? `Stop that task there once the user agrees (cmsis_action stop_run with window: '${holder.pid}')`
            : `Stop that session there once the user agrees (select_debug_window {pid: ${holder.pid}}, then stop_debugging)`;
        return new Refusal('PROBE_BUSY',
            `${start.subject}: ${starts}, which ${windowText(holder)} uses for ${claimText(holder.claim)}. ${follows}`,
            `${stop}, or ${anotherPort(start)}.`);
    }
    return new Refusal('PROBE_BUSY',
        `${start.subject}: ${starts}, and another program already listens on that port of this computer — no window of the CMSIS Developer `
            + `Assistant claims it: a GDB server started elsewhere, or one an earlier session left running. ${follows}`,
        `Free the port (the user can end that program), or ${anotherPort(start)}.`);
}
