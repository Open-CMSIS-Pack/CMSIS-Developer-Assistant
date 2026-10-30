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
 * Programmatic serial port controller — own a connection independent of the
 * Serial Monitor UI extension. Buffers RX data so an MCP client can poll/read
 * it on demand. Use this when the user is NOT running an MS Serial Monitor
 * session for the same port (the OS only allows one reader per tty in the
 * default mode). One owned port per window.
 *
 * The state follows the port, not only `close()`: when the port closes by
 * itself (the adapter was unplugged) or fails after it closed, the controller
 * forgets it, keeps the received bytes readable, and remembers why as
 * `lastRelease`, which the serial tools name (#49). Tests build their own
 * controller over serialport's `SerialPortMock`, a fixed clock and hand-driven
 * timers; the extension uses the `serialController` singleton.
 *
 * A port is held under a lease (src/core/serialLease.ts, #49): the MCP session
 * that opened it and the rule that lets it go — after the idle time, when its
 * session ends, when a debug session ends — besides `close()`, the user's
 * Release command and the window's teardown. Every such release and every
 * unplug is journaled in the window's problem journal (#48, source `serial`),
 * as a warning for an unplug and for the user's release and as info
 * otherwise, without any payload. So is a port that cannot be opened;
 * another program holding it is `PORT_HELD`.
 *
 * Opens and closes take turns, one at a time: an open that arrives while
 * another is in flight waits for it and then finds its port, as it would
 * afterwards. Several MCP sessions share the window's port; without the
 * turns a second `serial_open` would open a second device beside the first,
 * which nothing closes. A rule's background close and the end of an MCP
 * session take their turns too: the next open finds the device let go, and
 * the end of a session finds the port that session was still opening.
 */

import { SerialPort } from 'serialport';
import { logger } from '../utils/logger';
import { problemJournal, type ProblemInput, type ProblemSeverity } from './problemJournal';
import { LeaseTimers, REAL_TIMERS, ReleaseRule, RuleRelease, SerialLease } from './serialLease';
import { ToolError } from './toolResult';

export interface SerialOpenOptions {
    path: string;
    baudRate?: number;
    dataBits?: 5 | 6 | 7 | 8;
    parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
    stopBits?: 1 | 1.5 | 2;
    rtscts?: boolean;
}

/** Who holds the port and under which rule; `serial_open` records it, a direct caller may leave it out. */
export interface HoldTerms {
    /** The MCP session that opens the port. */
    owner?: string;
    /** `idle` when absent. */
    rule?: ReleaseRule;
    /** The idle limit, 0 for none; only the `idle` rule uses it. */
    idleSeconds?: number;
    /** True while `serial_capture` holds the port for its one read. */
    capture?: boolean;
}

export interface SerialPortInfo {
    path: string;
    /** Windows' name of the port, such as "USB Serial Device (COM7)"; serialport has none elsewhere. */
    friendlyName?: string;
    manufacturer?: string;
    serialNumber?: string;
    pnpId?: string;
    locationId?: string;
    productId?: string;
    vendorId?: string;
}

/** Why the owned port closed without `serial_close`: unplugged, closed or failed on its own, or let go by a rule (#49). */
export interface SerialRelease {
    path: string;
    at: Date;
    reason: 'disconnected' | 'closed-unexpectedly' | RuleRelease;
    /** The port's error message, when it gave one. */
    detail?: string;
    /** For an idle release: the idle limit it ran out. */
    idleSeconds?: number;
}

export interface SerialStatus {
    open: boolean;
    path: string | null;
    baudRate: number | null;
    bufferedBytes: number;
    openedAt: string | null;
    /** Kept from the port's own close until the next successful open. */
    lastRelease: SerialRelease | null;
}

/** The held port as the status bar, `serial_status` and `get_session_status` describe it. */
export interface SerialHold {
    path: string;
    baudRate: number;
    openedAt: Date;
    owner: string | undefined;
    rule: ReleaseRule;
    /** The idle limit in seconds; 0 when idleness does not release this port. */
    idleSeconds: number;
    idleForMs: number;
    /** Until the idle release; undefined when idleness does not release this port. */
    idleReleaseInMs: number | undefined;
    capture: boolean;
}

/** What the controller hands the port factory: the `serialport` options, never opened on construction. */
export interface PortOptions {
    path: string;
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
    stopBits: 1 | 1.5 | 2;
    rtscts: boolean;
    autoOpen: false;
}

/** The part of a port the controller uses; serialport's `SerialPort` and `SerialPortMock` both fit. */
export interface OwnedPort {
    readonly isOpen: boolean;
    open(callback: (err: Error | null) => void): void;
    close(callback: (err: Error | null) => void): void;
    write(data: Buffer, callback: (err: Error | null | undefined) => void): boolean;
    drain(callback: (err: Error | null) => void): void;
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
    on(event: 'close', listener: (err?: Error | null) => void): unknown;
}

/** Where ports, timestamps, timers and problem records go and come from; each defaults to the real thing. */
export interface SerialControllerDeps {
    createPort?: (options: PortOptions) => OwnedPort;
    clock?: () => Date;
    /** The idle timer's clock and timer; by default `clock` and Node's timers. */
    timers?: LeaseTimers;
    /** Records a problem of the port; the window's problem journal by default. */
    journal?: (problem: ProblemInput) => void;
}

const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

/**
 * What the OS says when another program holds the port: Windows "Opening
 * COM7: Access denied", POSIX `EBUSY` ("Resource busy", "Device or resource
 * busy"), serialport's `flock` failure "Cannot lock port", and the mock
 * binding's "Port is locked".
 */
const HELD_ELSEWHERE = /Access denied|\bEBUSY\b|resource busy|Cannot lock port|Port is locked/i;
/** The next step when another program holds the port; no Serial Monitor API passes on what it receives. */
export const PORT_HELD_HINT = 'Another program holds it (the Serial Monitor, a terminal): ask the user to close the port there; '
    + 'serial_open_monitor shows the Serial Monitor.';
const OPEN_FAILED_HINT = 'serial_list_ports lists the ports; if another program holds this one, ask the user to close it there.';
const GONE_HINT = 'Reopen it with serial_open once the adapter is back; the bytes received before stay readable.';

/** How each release is journaled: an unplug and the user's release are warnings, a rule doing its job is info. */
const RELEASE_RECORDS: Readonly<Record<SerialRelease['reason'], { severity: ProblemSeverity; hint: string }>> = {
    disconnected: { severity: 'warning', hint: GONE_HINT },
    'closed-unexpectedly': { severity: 'warning', hint: GONE_HINT },
    user: { severity: 'warning', hint: 'The user released it in VS Code; ask before you reopen it with serial_open.' },
    idle: { severity: 'info', hint: 'No serial call used it; reopen it with serial_open, or read once with serial_capture.' },
    'owner-gone': { severity: 'info', hint: 'The MCP session that opened it ended; reopen it with serial_open.' },
    'debug-session-end': { severity: 'info', hint: 'It was opened with releaseOn debug-session-end; reopen it with serial_open.' },
};

/** serialport 13 closes an unplugged port with a `DisconnectedError`, marked `disconnected: true`. */
function isDisconnect(err: Error | null | undefined): boolean {
    return (err as { disconnected?: unknown } | null | undefined)?.disconnected === true;
}

/** True when an open failed because another program holds the port. */
export function isHeldElsewhere(message: string): boolean {
    return HELD_ELSEWHERE.test(message);
}

/** The friendly name serialport's list gives a port on Windows; its `PortInfo` type leaves the field out. */
function friendlyNameOf(port: object): string | undefined {
    const name: unknown = Reflect.get(port, 'friendlyName');
    return typeof name === 'string' && name !== '' ? name : undefined;
}

/** `10:42:07`: local wall-clock time, as the user reads it next to the board. */
export function clockTime(at: Date): string {
    return at.toTimeString().slice(0, 8);
}

/**
 * `COM7 disconnected at 10:42:07`, `COM7 closed unexpectedly at 10:42:07 (reason)`,
 * or `COM7 released at 10:47:07 …` with the rule that let it go.
 */
export function describeRelease(release: SerialRelease): string {
    const at = clockTime(release.at);
    switch (release.reason) {
        case 'disconnected':
            return `${release.path} disconnected at ${at}`;
        case 'closed-unexpectedly':
            return `${release.path} closed unexpectedly at ${at}${release.detail ? ` (${release.detail})` : ''}`;
        case 'idle':
            return `${release.path} released at ${at} after ${release.idleSeconds ?? '?'} s without a serial call`;
        case 'owner-gone':
            return `${release.path} released at ${at}: the MCP session that opened it ended`;
        case 'debug-session-end':
            return `${release.path} released at ${at}: the debug session ended`;
        case 'user':
            return `${release.path} released at ${at} by the user in VS Code`;
    }
}

/** What to do about a port a release took away: reopen it, but ask first when the user let it go. */
export function reopenAdvice(release: SerialRelease): string {
    return release.reason === 'user' ? 'Ask the user before you reopen it with serial_open.' : 'Reopen it with serial_open.';
}

export class SerialController {
    private port: OwnedPort | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private openedAt: Date | null = null;
    private currentPath: string | null = null;
    private currentBaud: number | null = null;
    private lastRelease: SerialRelease | null = null;
    private lease: SerialLease | undefined;
    private capturing = false;
    /** Counts the successful opens: which port a caller opened, when it wants to close only that one. */
    private generation = 0;
    /** End of the queue of opens and closes. It never rejects, so a failed open does not block the next. */
    private portQueue: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<() => void>();
    private readonly createPort: (options: PortOptions) => OwnedPort;
    private readonly clock: () => Date;
    private readonly timers: LeaseTimers;
    private readonly journal: (problem: ProblemInput) => void;

    constructor(deps: SerialControllerDeps = {}) {
        this.createPort = deps.createPort ?? ((options) => new SerialPort(options));
        this.clock = deps.clock ?? (() => new Date());
        this.timers = deps.timers ?? (deps.clock ? { ...REAL_TIMERS, now: () => this.clock().getTime() } : REAL_TIMERS);
        this.journal = deps.journal ?? ((problem) => { problemJournal().append(problem); });
    }

    async listPorts(): Promise<SerialPortInfo[]> {
        const ports = await SerialPort.list();
        return ports.map(p => ({
            path: p.path,
            friendlyName: friendlyNameOf(p),
            manufacturer: p.manufacturer,
            serialNumber: p.serialNumber,
            pnpId: p.pnpId,
            locationId: p.locationId,
            productId: p.productId,
            vendorId: p.vendorId,
        }));
    }

    isOpen(): boolean {
        return this.port !== null && this.port.isOpen;
    }

    status(): SerialStatus {
        return {
            open: this.isOpen(),
            path: this.currentPath,
            baudRate: this.currentBaud,
            bufferedBytes: this.buffer.length,
            openedAt: this.openedAt ? this.openedAt.toISOString() : null,
            lastRelease: this.lastRelease,
        };
    }

    /** The held port with its lease; undefined while no port is open. Reading it touches nothing. */
    hold(): SerialHold | undefined {
        const lease = this.lease;
        if (!this.isOpen() || !lease || this.currentPath === null || this.currentBaud === null || this.openedAt === null) {
            return undefined;
        }
        return {
            path: this.currentPath,
            baudRate: this.currentBaud,
            openedAt: this.openedAt,
            owner: lease.owner,
            rule: lease.rule,
            idleSeconds: lease.idleMs / 1000,
            idleForMs: lease.idleForMs(),
            idleReleaseInMs: lease.idleReleaseInMs(),
            capture: this.capturing,
        };
    }

    /** Told whenever a port is opened, closed or released; the status bar item listens (#49). */
    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    /**
     * Open the owned port under `terms`, once the open or close in flight has
     * ended. A port already open is `PORT_HELD` (worded by `refusal()` when
     * given), and so is a port another program holds; other failures pass as
     * they are. Resolves with the port's generation, for `holds()` and
     * `close()`.
     */
    open(opts: SerialOpenOptions, terms: HoldTerms = {}, refusal?: () => Error): Promise<number> {
        return this.inTurn(() => this.openPort(opts, terms, refusal));
    }

    /** `open()` in its turn. */
    private async openPort(opts: SerialOpenOptions, terms: HoldTerms, refusal: (() => Error) | undefined): Promise<number> {
        if (this.isOpen()) {
            throw refusal?.() ?? new ToolError('PORT_HELD',
                `A serial port is already open on '${this.currentPath}'. Close it first with serial_close.`);
        }
        const baudRate = opts.baudRate ?? 115200;
        const dataBits = opts.dataBits ?? 8;
        const parity = opts.parity ?? 'none';
        const stopBits = opts.stopBits ?? 1;
        const rtscts = opts.rtscts ?? false;

        try {
            await new Promise<void>((resolve, reject) => {
                const p = this.createPort({
                    path: opts.path, baudRate, dataBits, parity, stopBits, rtscts,
                    autoOpen: false,
                });

                p.on('data', (chunk: Buffer) => this.appendToBuffer(chunk));
                p.on('error', (err) => this.onPortError(p, err));
                p.on('close', (err) => this.onPortClosed(p, opts.path, err));

                p.open((err) => {
                    if (err) { reject(err); return; }
                    // The port before, if it is still closing by itself, goes now with its lease, whose idle timer would release this one.
                    this.forgetPort();
                    this.port = p;
                    this.openedAt = this.clock();
                    this.currentPath = opts.path;
                    this.currentBaud = baudRate;
                    this.buffer = Buffer.alloc(0);
                    this.lastRelease = null;
                    this.capturing = terms.capture === true;
                    this.generation += 1;
                    this.lease = new SerialLease(
                        { owner: terms.owner, rule: terms.rule ?? 'idle', idleSeconds: terms.idleSeconds ?? 0 },
                        this.timers,
                        () => { this.releaseByRule('idle'); });
                    resolve();
                });
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const held = isHeldElsewhere(message);
            // The tool reports the failure itself; the record is for whoever reads the journal later.
            this.recordProblem(opts.path, 'warning', message, held ? PORT_HELD_HINT : OPEN_FAILED_HINT, held);
            if (held) {
                throw new ToolError('PORT_HELD', `Cannot open ${opts.path}: another program holds it (${message}).`, PORT_HELD_HINT);
            }
            throw err;
        }
        logger.info(`Serial port '${opts.path}' opened at ${baudRate} baud${terms.owner ? ` for MCP session ${terms.owner.slice(0, 8)}` : ''}`);
        this.changed();
        return this.generation;
    }

    /** True while the port that `open()` numbered `generation` is the one held. */
    holds(generation: number): boolean {
        return this.isOpen() && this.generation === generation;
    }

    /**
     * Close the held port, once the open or close in flight has ended; with
     * `generation`, only when it is still that port. Resolves with true when a
     * port was open.
     */
    close(generation?: number): Promise<boolean> {
        return this.inTurn(() => this.closePort(generation));
    }

    /** `close()` in its turn. */
    private async closePort(generation: number | undefined): Promise<boolean> {
        if (!this.port || (generation !== undefined && generation !== this.generation)) { return false; }
        const wasOpen = this.isOpen();
        const p = this.port;
        // Forgotten before the close, not after: the port's own 'close' event,
        // which comes first, then finds nothing to release. Also when closing
        // fails (the adapter was unplugged): otherwise every later open()
        // refuses with "already open" and the only way out is a window reload.
        this.forgetPort();
        this.changed();
        await new Promise<void>((resolve, reject) => {
            p.close((err) => err ? reject(err) : resolve());
        });
        return wasOpen;
    }

    /** A serial call used the port now: the idle time starts again (#49). */
    touch(): void {
        this.lease?.touch();
    }

    /** Runs `work` as one serial call on the held port: no idle release meanwhile (#49). */
    during<T>(work: () => Promise<T>): Promise<T> {
        return this.lease ? this.lease.during(work) : work();
    }

    /**
     * The MCP session `sessionId` ended: release the port it opened unless its
     * rule is `manual`; the path released, if any. It takes its turn after the
     * open or close in flight, so a port the session was still opening goes too.
     */
    sessionEnded(sessionId: string): Promise<string | undefined> {
        return this.inTurn(async () => this.lease?.endsWithSession(sessionId) ? this.releaseByRule('owner-gone') : undefined);
    }

    /** A debug session in this window ended: release a port opened with `releaseOn: 'debug-session-end'`. */
    debugSessionEnded(): string | undefined {
        return this.lease?.endsWithDebugSession() ? this.releaseByRule('debug-session-end') : undefined;
    }

    /** The user's Release command: release whatever port is held, under any rule; the path released, if any. */
    releaseForUser(): string | undefined {
        return this.releaseByRule('user');
    }

    async write(data: string | Buffer, encoding: 'utf8' | 'hex' = 'utf8'): Promise<number> {
        // Held for the whole call: an unplug in between releases `this.port`, not this write's port.
        const port = this.port;
        if (!port || !port.isOpen) {
            throw new ToolError('PORT_CLOSED', this.lastRelease
                ? `No serial port open: ${describeRelease(this.lastRelease)}. ${reopenAdvice(this.lastRelease)}`
                : 'No serial port open. Call serial_open first.');
        }
        const buf = Buffer.isBuffer(data) ? data
            : (encoding === 'hex' ? Buffer.from(data.replace(/\s+/g, ''), 'hex') : Buffer.from(data, 'utf8'));
        await new Promise<void>((resolve, reject) => {
            port.write(buf, (err) => err ? reject(err) : resolve());
        });
        await new Promise<void>((resolve, reject) => {
            port.drain((err) => err ? reject(err) : resolve());
        });
        return buf.length;
    }

    /**
     * Take buffered bytes. With `waitMs`, an empty buffer is awaited up to
     * that long, and no longer than the port that was open when the read
     * began stays open: bytes cannot arrive on a closed port.
     */
    async read(opts: { maxBytes?: number; waitMs?: number; consume?: boolean } = {}): Promise<Buffer> {
        const maxBytes = opts.maxBytes ?? MAX_BUFFER_BYTES;
        const waitMs = opts.waitMs ?? 0;
        const consume = opts.consume !== false;
        const watched = this.port;

        if (this.buffer.length === 0 && waitMs > 0 && watched !== null) {
            await new Promise<void>((resolve) => {
                const start = Date.now();
                const tick = () => {
                    if (this.buffer.length > 0 || this.port !== watched || Date.now() - start >= waitMs) { resolve(); }
                    else { setTimeout(tick, 25); }
                };
                tick();
            });
        }

        const slice = this.buffer.subarray(0, Math.min(maxBytes, this.buffer.length));
        const out = Buffer.from(slice);
        if (consume) { this.buffer = this.buffer.subarray(out.length); }
        return out;
    }

    clearBuffer(): number {
        const n = this.buffer.length;
        this.buffer = Buffer.alloc(0);
        return n;
    }

    /**
     * Runs `work` once the open or close before it has ended, so one runs at
     * a time and each finds what the one before left. A `work` that fails
     * lets the next one run.
     */
    private inTurn<T>(work: () => Promise<T>): Promise<T> {
        const turn = this.portQueue.then(work);
        this.portQueue = turn.catch(() => undefined);
        return turn;
    }

    private forgetPort(): void {
        this.lease?.end();
        this.lease = undefined;
        this.capturing = false;
        this.port = null;
        this.openedAt = null;
        this.currentPath = null;
        this.currentBaud = null;
    }

    /** Tell the listeners; one that throws is logged and costs the port nothing. */
    private changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (caught) {
                logger.debug('A serial status listener failed', caught);
            }
        }
    }

    /**
     * A rule lets the held port go: remember why, journal it, close the port
     * in the background. The received bytes stay readable. The path released,
     * or undefined when no port was held.
     */
    private releaseByRule(reason: RuleRelease): string | undefined {
        const p = this.port;
        const path = this.currentPath;
        if (p === null || path === null) {
            return undefined;
        }
        const idleSeconds = reason === 'idle' && this.lease ? this.lease.idleMs / 1000 : undefined;
        this.release(path, reason, undefined, idleSeconds);
        // In the background, but in turn: the next open waits until the device is let go.
        void this.inTurn(() => new Promise<void>((resolve) => {
            p.close((err) => {
                if (err) {
                    logger.debug(`Closing serial port '${path}' after its release failed: ${err.message}`);
                }
                resolve();
            });
        }));
        return path;
    }

    /**
     * The port closed without `close()`: unplugged (a `DisconnectedError`),
     * or closed by the driver. A late event of a port already replaced or
     * closed on purpose changes nothing.
     */
    private onPortClosed(p: OwnedPort, path: string, err: Error | null | undefined): void {
        logger.info(`Serial port '${path}' closed${err ? `: ${err.message}` : ''}`);
        if (this.port !== p) {
            return;
        }
        this.release(path, isDisconnect(err) ? 'disconnected' : 'closed-unexpectedly', err?.message);
    }

    /** An error while the port is open is only logged; one that leaves it closed releases it like a close. */
    private onPortError(p: OwnedPort, err: Error): void {
        logger.warn(`Serial port error: ${err.message}`);
        if (this.port !== p || p.isOpen) {
            return;
        }
        this.release(this.currentPath ?? '?', isDisconnect(err) ? 'disconnected' : 'closed-unexpectedly', err.message);
    }

    /** Forget the port and remember why; the received bytes stay readable. One output-channel line and one record. */
    private release(path: string, reason: SerialRelease['reason'], detail: string | undefined, idleSeconds?: number): void {
        this.forgetPort();
        this.lastRelease = {
            path, at: this.clock(), reason,
            ...(detail && reason === 'closed-unexpectedly' ? { detail } : {}),
            ...(idleSeconds !== undefined ? { idleSeconds } : {}),
        };
        const described = describeRelease(this.lastRelease);
        const { severity, hint } = RELEASE_RECORDS[reason];
        // The journal mirrors warnings into the output channel itself (#48); info records it does not.
        if (severity === 'info') {
            logger.info(`Serial port released: ${described}`);
        } else {
            logger.debug(`Serial port released: ${described}`);
        }
        this.recordProblem(path, severity, described, hint, false);
        this.changed();
    }

    /** A problem of the port in the problem journal; a failing journal never fails the port. */
    private recordProblem(path: string, severity: ProblemSeverity, message: string, hint: string, held: boolean): void {
        try {
            this.journal({ source: 'serial', origin: path, severity, message, hint, ...(held ? { code: 'PORT_HELD' as const } : {}) });
        } catch (caught) {
            logger.debug('A serial problem could not be journaled', caught);
        }
    }

    private appendToBuffer(chunk: Buffer): void {
        const combined = Buffer.concat([this.buffer, chunk]);
        if (combined.length > MAX_BUFFER_BYTES) {
            this.buffer = combined.subarray(combined.length - MAX_BUFFER_BYTES);
            logger.debug(`Serial RX buffer hit ${MAX_BUFFER_BYTES} byte cap — dropped oldest data`);
        } else {
            this.buffer = combined;
        }
    }
}

export const serialController = new SerialController();
