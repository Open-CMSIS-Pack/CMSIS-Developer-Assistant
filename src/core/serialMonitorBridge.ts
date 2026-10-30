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
 * Bridge to the Microsoft Serial Monitor extension
 * (`ms-vscode.vscode-serial-monitor`), which the CMSIS Debugger's extension
 * pack installs.
 *
 * The extension's exports are not its API: they hold `getApi(version,
 * context)`, which hands one out for version 0 (`Version.v0` of
 * `@microsoft/vscode-serial-monitor-api`, the only version it accepts) and
 * the extension context of the caller, whose `extension.id` it records. The
 * CMSIS Solution extension asks for it the same way. extension.ts hands this
 * extension's context to the bridge at activation (`attach()`).
 *
 * That API lists ports, starts and stops monitoring a serial port or a TCP
 * connection and clears the output; it has no event for the bytes the
 * monitor receives, so no other extension can read the user's session.
 * `serial_subscribe_monitor` is therefore refused, with that reason. The
 * bridge still looks for a data event on the API object (`onDidReceiveData`,
 * `onSerialData`, …) and subscribes when a later build has one.
 * `serial_list_ports` does not ask the API: its list is serialport's own,
 * without the serial numbers.
 *
 * The bridge buffers received bytes the same way the standalone
 * `serialController` does, so `serial_read` (with `from: 'monitor'`) can
 * consume them uniformly regardless of which backend produced them.
 *
 * A subscription follows the release rules of an owned port (#49,
 * src/core/serialLease.ts): it ends after `serial.idleCloseSeconds` without
 * a serial call and when the MCP session that subscribed ends, and then
 * drops its buffer. Each such end is journaled as info (source `serial`).
 * Tests hand in the extension lookup, the context and the timers.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { problemJournal, type ProblemInput } from './problemJournal';
import { LeaseTimers, REAL_TIMERS, RuleRelease, SerialLease } from './serialLease';

const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

/** The version the bridge asks `getApi` for: `Version.v0`, the only one the Serial Monitor (0.13) accepts. */
const SERIAL_MONITOR_API_VERSION = 0;

/** The data events the bridge looks for on the API; version 0 has none of them. */
const DATA_EVENTS = ['onDidReceiveData', 'onDataReceived', 'onData', 'onSerialData', 'onDidReadData', 'subscribeData'];

/** Why a subscription is refused when the API has no data event, and what to do instead. */
const NO_DATA_EVENT = 'The Serial Monitor\'s API (version 0) has no data event: it lists ports and starts or stops '
    + 'monitoring, but does not pass on what it receives. Ask the user to stop monitoring the port in the Serial Monitor, '
    + 'then read it with serial_capture or serial_open.';

export interface BridgeStatus {
    extensionInstalled: boolean;
    extensionId: string;
    activated: boolean;
    apiKeysDiscovered: string[];
    dataSubscriptionAvailable: boolean;
    subscribed: boolean;
    bufferedBytes: number;
}

/** The Serial Monitor extension as the bridge sees it: the part of `vscode.Extension` it uses. */
export interface BridgeExtension {
    readonly isActive: boolean;
    readonly exports: unknown;
    activate(): Thenable<unknown>;
}

/** What `getApi` is handed besides the version: an extension context, of which the Serial Monitor reads `extension.id`. */
export interface MonitorConsumer {
    readonly extension: { readonly id: string };
}

/** Where the bridge finds the extension, its context, its timers and its problem journal; each but the context defaults to the real thing. */
export interface SerialMonitorBridgeDeps {
    lookup?: (id: string) => BridgeExtension | undefined;
    /** The context `getApi` is handed; the window's bridge gets the extension's at activation (`attach()`). */
    consumer?: MonitorConsumer;
    timers?: LeaseTimers;
    journal?: (problem: ProblemInput) => void;
}

/** Who subscribes and how long a subscription may sit idle (#49). */
export interface SubscribeTerms {
    /** The MCP session that subscribes. */
    owner?: string;
    /** The idle limit, 0 for none. */
    idleSeconds?: number;
}

/** The origin of the bridge's problem records. */
const BRIDGE_ORIGIN = 'Serial Monitor';

/**
 * The methods and accessors of the API object, its prototypes included: the
 * Serial Monitor's API is a class instance, whose own keys hold only its state.
 */
function apiMembers(api: object): string[] {
    const names = new Set<string>();
    for (let level: object | null = api; level !== null && level !== Object.prototype; level = Reflect.getPrototypeOf(level)) {
        for (const name of Object.getOwnPropertyNames(level)) {
            const member = Object.getOwnPropertyDescriptor(level, name);
            if (name !== 'constructor' && (typeof member?.value === 'function' || member?.get !== undefined)) {
                names.add(name);
            }
        }
    }
    return [...names];
}

export class SerialMonitorBridge {
    private extId = 'ms-vscode.vscode-serial-monitor';
    private api: object | null = null;
    /** Why the last request for the API gave none. */
    private unavailable = '';
    private consumer: MonitorConsumer | undefined;
    private subscription: vscode.Disposable | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private dataEventName: string | null = null;
    private lease: SerialLease | undefined;
    private readonly lookup: (id: string) => BridgeExtension | undefined;
    private readonly timers: LeaseTimers;
    private readonly journal: (problem: ProblemInput) => void;

    constructor(deps: SerialMonitorBridgeDeps = {}) {
        this.lookup = deps.lookup ?? ((id) => vscode.extensions.getExtension(id));
        this.consumer = deps.consumer;
        this.timers = deps.timers ?? REAL_TIMERS;
        this.journal = deps.journal ?? ((problem) => { problemJournal().append(problem); });
    }

    /** Hand in the extension context that the Serial Monitor's `getApi` requires; extension.ts does at activation. */
    attach(consumer: MonitorConsumer): void {
        this.consumer = consumer;
    }

    /**
     * The Serial Monitor's API: `getApi(0, context)` of its exports, asked once
     * and kept; the extension is activated first when it is not yet. Null when
     * the extension is missing or fails to activate, its exports have no
     * `getApi`, `getApi` refuses, or no context is attached; `unavailable`
     * then says which.
     */
    private async getApi(): Promise<object | null> {
        if (this.api) { return this.api; }
        const ext = this.lookup(this.extId);
        if (!ext) { return this.noApi(`Extension '${this.extId}' is not installed or failed to activate.`); }
        if (!this.consumer) {
            return this.noApi('The Serial Monitor bridge has no extension context yet; try again once the extension has activated.');
        }
        let exports: unknown;
        try {
            exports = ext.isActive ? ext.exports : await ext.activate();
        } catch (err) {
            logger.warn(`Serial Monitor activation failed: ${err}`);
            return this.noApi(`Extension '${this.extId}' is not installed or failed to activate.`);
        }
        const getApi: unknown = typeof exports === 'object' && exports !== null ? Reflect.get(exports, 'getApi') : undefined;
        if (typeof getApi !== 'function') {
            return this.noApi(`Extension '${this.extId}' exports no getApi(version, context): it failed to activate, or this build has no API.`);
        }
        try {
            const api: unknown = getApi.call(exports, SERIAL_MONITOR_API_VERSION, this.consumer);
            if (typeof api !== 'object' || api === null) {
                return this.noApi(`The Serial Monitor's getApi(${SERIAL_MONITOR_API_VERSION}) returned no API.`);
            }
            this.api = api;
            return api;
        } catch (err) {
            logger.info(`The Serial Monitor refused API version ${SERIAL_MONITOR_API_VERSION}`, err);
            return this.noApi(`The Serial Monitor refused API version ${SERIAL_MONITOR_API_VERSION}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** No API: remember why. */
    private noApi(reason: string): null {
        this.unavailable = reason;
        return null;
    }

    /** The first of the data events the bridge knows that the API has; version 0 has none. */
    private findDataEvent(api: object | null): string | null {
        if (!api) { return null; }
        return DATA_EVENTS.find((name) => typeof Reflect.get(api, name) === 'function') ?? null;
    }

    async status(): Promise<BridgeStatus> {
        const ext = this.lookup(this.extId);
        const installed = !!ext;
        const activated = !!ext?.isActive;
        let keys: string[] = [];
        let dataAvailable = false;
        if (activated) {
            const api = await this.getApi();
            if (api) {
                keys = apiMembers(api).slice(0, 30);
            }
            this.dataEventName = this.findDataEvent(api);
            dataAvailable = this.dataEventName !== null;
        }
        return {
            extensionInstalled: installed,
            extensionId: this.extId,
            activated,
            apiKeysDiscovered: keys,
            dataSubscriptionAvailable: dataAvailable,
            subscribed: this.subscription !== null,
            bufferedBytes: this.buffer.length,
        };
    }

    /**
     * Subscribe to the Serial Monitor's data event when its API has one. The
     * subscription is held for `terms.owner` and ends after `terms.idleSeconds`
     * without a serial call (#49); a repeated call keeps the one that exists.
     */
    async subscribeIfAvailable(terms: SubscribeTerms = {}): Promise<{ ok: true; eventName: string } | { ok: false; reason: string }> {
        if (this.subscription) {
            this.touch();
            return { ok: true, eventName: this.dataEventName ?? '<active>' };
        }
        const api = await this.getApi();
        if (!api) {
            return { ok: false, reason: this.unavailable };
        }
        const eventName = this.findDataEvent(api);
        if (!eventName) {
            return { ok: false, reason: NO_DATA_EVENT };
        }
        try {
            const event = Reflect.get(api, eventName) as (cb: (arg: unknown) => void) => vscode.Disposable;
            this.subscription = event.call(api, (evt: unknown) => this.onData(evt));
            this.dataEventName = eventName;
            this.lease = new SerialLease({ owner: terms.owner, rule: 'idle', idleSeconds: terms.idleSeconds ?? 0 }, this.timers,
                () => { this.endByRule('idle'); });
            return { ok: true, eventName };
        } catch (err) {
            return { ok: false, reason: `Subscribing via ${eventName} threw: ${err}` };
        }
    }

    unsubscribe(): boolean {
        this.lease?.end();
        this.lease = undefined;
        if (!this.subscription) { return false; }
        try { this.subscription.dispose(); } catch { /* ignore */ }
        this.subscription = null;
        return true;
    }

    /** A serial call used the subscription now: its idle time starts again (#49). */
    touch(): void {
        this.lease?.touch();
    }

    /** The MCP session `sessionId` ended: end the subscription it made, dropping the buffer. True when it did. */
    sessionEnded(sessionId: string): boolean {
        return this.lease?.endsWithSession(sessionId) === true && this.endByRule('owner-gone');
    }

    /** A rule ends the subscription: unsubscribe and drop the buffer, then log and journal why. */
    private endByRule(reason: Extract<RuleRelease, 'idle' | 'owner-gone'>): boolean {
        const idleSeconds = this.lease ? this.lease.idleMs / 1000 : 0;
        if (!this.unsubscribe()) {
            return false;
        }
        const dropped = this.clearBuffer();
        const message = reason === 'idle'
            ? `Serial Monitor subscription ended after ${idleSeconds} s without a serial call`
            : 'Serial Monitor subscription ended: the MCP session that subscribed ended';
        logger.info(`${message}; ${dropped} buffered byte(s) dropped`);
        try {
            this.journal({ source: 'serial', origin: BRIDGE_ORIGIN, severity: 'info', message, hint: 'Subscribe again with serial_subscribe_monitor.' });
        } catch (caught) {
            logger.debug('The end of the Serial Monitor subscription could not be journaled', caught);
        }
        return true;
    }

    /**
     * Normalise whatever payload shape the API event hands us. Likely shapes
     * (defensive): Buffer, Uint8Array, string, { data: ... }, { buffer: ... }.
     */
    private onData(evt: any): void {
        const chunk = this.coerceToBuffer(evt);
        if (!chunk || chunk.length === 0) { return; }
        const combined = Buffer.concat([this.buffer, chunk]);
        if (combined.length > MAX_BUFFER_BYTES) {
            this.buffer = combined.subarray(combined.length - MAX_BUFFER_BYTES);
            logger.debug(`Serial Monitor bridge buffer hit ${MAX_BUFFER_BYTES} byte cap`);
        } else {
            this.buffer = combined;
        }
    }

    private coerceToBuffer(evt: any): Buffer | null {
        // eslint-disable-next-line eqeqeq -- intentionally match null and undefined.
        if (evt == null) { return null; }
        if (Buffer.isBuffer(evt)) { return evt; }
        if (evt instanceof Uint8Array) { return Buffer.from(evt); }
        if (typeof evt === 'string') { return Buffer.from(evt, 'utf8'); }
        if (typeof evt === 'object') {
            if (Buffer.isBuffer(evt.data)) { return evt.data; }
            if (evt.data instanceof Uint8Array) { return Buffer.from(evt.data); }
            if (typeof evt.data === 'string') { return Buffer.from(evt.data, 'utf8'); }
            if (Buffer.isBuffer(evt.buffer)) { return evt.buffer; }
            if (Array.isArray(evt.buffer)) { return Buffer.from(evt.buffer); }
            if (typeof evt.asString === 'string') { return Buffer.from(evt.asString, 'utf8'); }
        }
        return null;
    }

    async read(opts: { maxBytes?: number; waitMs?: number; consume?: boolean } = {}): Promise<Buffer> {
        const maxBytes = opts.maxBytes ?? MAX_BUFFER_BYTES;
        const waitMs = opts.waitMs ?? 0;
        const consume = opts.consume !== false;
        if (this.buffer.length === 0 && waitMs > 0) {
            await new Promise<void>((resolve) => {
                const start = Date.now();
                const tick = () => {
                    if (this.buffer.length > 0 || Date.now() - start >= waitMs) { resolve(); }
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
}

/** The window's bridge. */
export const serialMonitorBridge = new SerialMonitorBridge();
