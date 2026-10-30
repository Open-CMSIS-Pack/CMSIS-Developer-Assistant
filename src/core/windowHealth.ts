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
 * What a window knows about its own health (#14), for the control server's
 * fence and `health` op, the registry entry and the notices:
 *
 * - `BusyTable`: the ops running in this window, with when each started and
 *   whether it outlived its fence. An op stays in it until its promise
 *   settles, however long after its fence that is.
 * - `LagMonitor`: how late the event loop ran timers since the last reset,
 *   from `perf_hooks.monitorEventLoopDelay`. A blocked extension host shows
 *   here, afterwards, as a delay of seconds.
 * - `NoticeGate`: at most one notice per key in a time window, so a picker
 *   nobody answers does not raise a toast per call.
 * - The registry's view: the calls busy for more than 10 s and the lag, as
 *   an entry stores them and as `list_debug_windows` shows them.
 * - `RouterWatch` and `portSilent`: whether the window that holds the MCP
 *   port has stopped running, judged by a worker whose promotion failed.
 * - `probeLoopback`: one request on a connection of its own, waiting only
 *   for the first sign of an answer; the router's health check and
 *   `portSilent` both use it.
 * - `portAnswers`: whether anything accepts a connection on the router port,
 *   so a worker's promotion poll does not build a server for a taken port.
 *
 * Pure: Node only, no vscode.
 */

import * as http from 'http';
import * as net from 'net';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import type { BusyCall } from '../utils/workspaceRegistry';
import { toolNameOf } from './windowStatus';

/** One op running in this window. */
export interface BusyRun {
    /** Tells two runs of the same op apart. */
    readonly ticket: number;
    /** The op name, as the control server dispatched it. */
    readonly op: string;
    /** The tool call it serves, when the router named one. */
    readonly callId?: string;
    /** Milliseconds since the epoch. */
    readonly startedAt: number;
    /** True once the fence answered for it; it keeps running. */
    fenced: boolean;
    /** When the fence answered, milliseconds since the epoch. */
    fencedAt?: number;
}

/** The ops running in this window, oldest first. */
export class BusyTable {
    private readonly runs: BusyRun[] = [];
    private lastTicket = 0;

    constructor(private readonly clock: () => number = () => Date.now()) {}

    /** Enter an op that starts now. */
    begin(op: string, callId?: string): BusyRun {
        const run: BusyRun = { ticket: ++this.lastTicket, op, startedAt: this.clock(), fenced: false, ...(callId ? { callId } : {}) };
        this.runs.push(run);
        return run;
    }

    /** Mark the run as answered by its fence. */
    fence(run: BusyRun): void {
        run.fenced = true;
        run.fencedAt = this.clock();
    }

    /** Remove the run once its promise settled; a second call changes nothing. */
    end(run: BusyRun): void {
        const at = this.runs.indexOf(run);
        if (at >= 0) {
            this.runs.splice(at, 1);
        }
    }

    /** The runs, oldest first. */
    list(): readonly BusyRun[] {
        return [...this.runs];
    }
}

/** Event-loop delay in milliseconds: the 99th percentile and the maximum since the last reset. */
export interface LagFigures {
    p99: number;
    max: number;
}

/** How often the delay is sampled. */
const LAG_RESOLUTION_MS = 20;
const NANOSECONDS_PER_MS = 1e6;

/** The event-loop delay of this process, sampled every 20 ms; `reset()` starts a new interval. */
export class LagMonitor {
    private readonly histogram: IntervalHistogram;

    constructor() {
        this.histogram = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
        // The sampling timer is unref'd by Node: it never keeps a process alive.
        this.histogram.enable();
    }

    /** The figures since the last reset, whole milliseconds; zeros before the first sample. */
    read(): LagFigures {
        if (this.histogram.count === 0) {
            return { p99: 0, max: 0 };
        }
        return {
            p99: Math.round(this.histogram.percentile(99) / NANOSECONDS_PER_MS),
            max: Math.round(this.histogram.max / NANOSECONDS_PER_MS),
        };
    }

    reset(): void {
        this.histogram.reset();
    }

    dispose(): void {
        this.histogram.disable();
    }
}

/** Lets one notice per key through in each `windowMs`; the keys are op or tool names. */
export class NoticeGate {
    private readonly shownAt = new Map<string, number>();

    constructor(private readonly windowMs: number) {}

    /** True when no notice for `key` passed within the window before `now`; that notice counts from now. */
    allow(key: string, now: number): boolean {
        const last = this.shownAt.get(key);
        if (last !== undefined && now - last < this.windowMs) {
            return false;
        }
        this.shownAt.set(key, now);
        return true;
    }
}

/** A duration in seconds for a message: one decimal below 10 s, whole seconds above. */
export function secondsText(ms: number): string {
    const tenths = Math.round(Math.max(0, ms) / 100);
    return tenths < 100 ? `${tenths / 10} s` : `${Math.round(tenths / 10)} s`;
}

// ── The registry's view ─────────────────────────────────────────────────────

/** A call is listed in the registry once it has run this long. */
export const BUSY_LISTED_AFTER_MS = 10_000;
/** `list_debug_windows` names the event-loop lag above this. */
const LAG_SHOWN_ABOVE_MS = 1_000;

/** The runs a registry entry lists: those older than `BUSY_LISTED_AFTER_MS`, by tool; undefined when none is. */
export function busyCallsOf(runs: readonly BusyRun[], now: number): BusyCall[] | undefined {
    const calls = runs
        .filter((run) => now - run.startedAt >= BUSY_LISTED_AFTER_MS)
        .map((run): BusyCall => (run.fenced ? { tool: toolNameOf(run.op), since: run.startedAt, fenced: true } : { tool: toolNameOf(run.op), since: run.startedAt }));
    return calls.length > 0 ? calls : undefined;
}

/** True for a busy call as a registry file of any version may hold it. */
function isBusyCall(value: unknown): value is BusyCall {
    const { tool, since } = (value ?? {}) as Record<string, unknown>;
    return typeof tool === 'string' && tool.length > 0 && typeof since === 'number' && Number.isFinite(since);
}

/**
 * `busy: cmsis_action 240 s, start_debugging 200 s (timed out)` for the calls
 * an entry lists, aged at `now`; empty when it lists none.
 */
export function busyText(busy: unknown, now: number): string {
    if (!Array.isArray(busy)) {
        return '';
    }
    const calls = busy.filter(isBusyCall)
        .map((call) => `${call.tool} ${Math.round(Math.max(0, now - call.since) / 1000)} s${call.fenced === true ? ' (timed out)' : ''}`);
    return calls.length > 0 ? `busy: ${calls.join(', ')}` : '';
}

/** `event-loop lag 4.2 s` when an entry's largest delay passed 1 s; empty otherwise. */
export function lagText(lag: unknown): string {
    const max: unknown = typeof lag === 'object' && lag !== null ? (lag as { max?: unknown }).max : undefined;
    return typeof max === 'number' && max > LAG_SHOWN_ABOVE_MS ? `event-loop lag ${(max / 1000).toFixed(1)} s` : '';
}

// ── A router that stopped running ───────────────────────────────────────────

/** How long the port may stay silent, with no router entry at all, before a worker warns (#14). */
export const ROUTER_SILENCE_MS = 60_000;

/** What a failed promotion poll found out about the window that holds the port. */
export interface RouterFinding {
    now: number;
    /** A router entry not refreshed for 60 s whose process lives (`findStaleRouter`). */
    staleRouter?: { pid: number; name?: string; updatedAt: number };
    /** True when a fresh entry says it is the router. */
    routerListed: boolean;
    /** True when `GET /mcp` on the port got no answer in time. */
    silent: boolean;
}

/**
 * The warning to show: the router named by its stale entry, or, when no
 * window says it is the router (one of 2.5.0 writes no role), the port.
 */
export type RouterWarning =
    | { kind: 'named'; pid: number; name?: string; silentMs: number }
    | { kind: 'port'; silentMs: number };

/**
 * Decides, poll by poll, when the window that holds the MCP port has
 * stopped running, and warns once per episode. An episode ends when the
 * port answers again, or this window takes it (`end`).
 */
export class RouterWatch {
    private silentSince: number | undefined;
    private warned = false;

    /** One poll's finding; the warning to show, when this episode has not had one. */
    observe(finding: RouterFinding): RouterWarning | undefined {
        if (!finding.silent) {
            this.end();
            return undefined;
        }
        this.silentSince ??= finding.now;
        if (this.warned) {
            return undefined;
        }
        const stale = finding.staleRouter;
        if (stale !== undefined) {
            this.warned = true;
            return { kind: 'named', pid: stale.pid, ...(stale.name ? { name: stale.name } : {}), silentMs: finding.now - stale.updatedAt };
        }
        const silentMs = finding.now - this.silentSince;
        if (!finding.routerListed && silentMs >= ROUTER_SILENCE_MS) {
            this.warned = true;
            return { kind: 'port', silentMs };
        }
        return undefined;
    }

    /** The port answered, or this window took it: the next silence is a new episode. */
    end(): void {
        this.silentSince = undefined;
        this.warned = false;
    }
}

/** What `probeLoopback` found: an answer of any status, none in time, or a connection that failed. */
export type ProbeOutcome = { kind: 'answered' } | { kind: 'silent' } | { kind: 'failed'; reason: string };

/**
 * Send one request to a port on 127.0.0.1, on a connection of its own (a
 * pooled one the peer just closed would read as a failure), and wait at
 * most `timeoutMs` for the first sign of an answer. Any status counts; the
 * body is read and dropped. A request still unanswered then is destroyed.
 */
export function probeLoopback(request: http.RequestOptions, body: Buffer | undefined, timeoutMs: number): Promise<ProbeOutcome> {
    return new Promise<ProbeOutcome>((found) => {
        let open = true;
        const conclude = (outcome: ProbeOutcome): void => {
            if (open) {
                open = false;
                clearTimeout(deadline);
                found(outcome);
            }
        };
        const probe = http.request({ ...request, host: '127.0.0.1', agent: false }, (answer) => {
            answer.on('error', () => undefined);
            answer.resume();
            conclude({ kind: 'answered' });
        });
        const deadline = setTimeout(() => {
            conclude({ kind: 'silent' });
            probe.destroy();
        }, timeoutMs);
        probe.on('error', (fault: Error) => conclude({ kind: 'failed', reason: fault.message }));
        probe.end(body);
    });
}

/**
 * True when `GET /mcp` on the router port gets no answer within `timeoutMs`:
 * the port is bound, but the server behind it does not run. Any answer, a
 * refused connection and any other failure are not silence.
 */
export async function portSilent(port: number, timeoutMs: number): Promise<boolean> {
    const outcome = await probeLoopback({ port, path: '/mcp', method: 'GET', headers: { Accept: 'application/json, text/event-stream' } },
        undefined, timeoutMs);
    return outcome.kind === 'silent';
}

/**
 * True when something accepts a TCP connection on the loopback `port` within
 * `timeoutMs`. A refused connection, a timeout and any other failure answer
 * false, so a caller that finds the port free goes on to bind it.
 */
export function portAnswers(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const finish = (answers: boolean): void => {
            socket.destroy();
            resolve(answers);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}
