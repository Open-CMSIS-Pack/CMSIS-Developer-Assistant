// SPDX-License-Identifier: Apache-2.0 OR MIT
// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Bridge to the Microsoft Serial Monitor extension
 * (`ms-vscode.vscode-serial-monitor`).
 *
 * The extension publishes a typed API package
 * (`@microsoft/vscode-serial-monitor-api`) that VS Code returns from
 * `extensions.getExtension(...).exports`. The current public surface
 * (v0.1.7) is centred on **port enumeration** and **port-set change
 * notifications** — RX byte streaming is captured internally and forwarded
 * to the webview, but is NOT (yet) exposed publicly.
 *
 * This bridge probes the exports object at runtime so:
 *
 *   - We use whatever the API offers today (port list, port-changed events).
 *   - If Microsoft adds a data-subscription event in a later release
 *     (`onDidReceiveData`, `onSerialData`, `subscribeData`, …) we light up
 *     automatically — no extra build required.
 *
 * The bridge buffers received bytes the same way the standalone
 * `serialController` does, so the MCP `serial_read_*` tool can consume them
 * uniformly regardless of which backend produced them.
 */

const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

export interface BridgePort {
    portName: string;
    friendlyName?: string;
    vid?: string;
    pid?: string;
}

export interface BridgeStatus {
    extensionInstalled: boolean;
    extensionId: string;
    activated: boolean;
    apiKeysDiscovered: string[];
    dataSubscriptionAvailable: boolean;
    subscribed: boolean;
    bufferedBytes: number;
}

class SerialMonitorBridge {
    private extId = 'ms-vscode.vscode-serial-monitor';
    private api: any = null;
    private subscription: vscode.Disposable | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private dataEventName: string | null = null;

    /** Lazily activates the Microsoft Serial Monitor and grabs its exports. */
    private async getApi(): Promise<any> {
        if (this.api) { return this.api; }
        const ext = vscode.extensions.getExtension(this.extId);
        if (!ext) { return null; }
        if (!ext.isActive) {
            try { await ext.activate(); }
            catch (err) {
                logger.warn(`Serial Monitor activation failed: ${err}`);
                return null;
            }
        }
        this.api = ext.exports ?? null;
        return this.api;
    }

    /**
     * Probe the API object for any plausible data-subscription event. If the
     * MS extension exposes one in this build we wire it up; otherwise the
     * bridge cleanly reports "data subscription not available".
     */
    private findDataEvent(api: any): string | null {
        if (!api || typeof api !== 'object') { return null; }
        const candidates = [
            'onDidReceiveData', 'onDataReceived', 'onData',
            'onSerialData', 'onDidReadData', 'subscribeData',
        ];
        for (const name of candidates) {
            if (typeof api[name] === 'function') { return name; }
        }
        return null;
    }

    async status(): Promise<BridgeStatus> {
        const ext = vscode.extensions.getExtension(this.extId);
        const installed = !!ext;
        const activated = !!ext?.isActive;
        let keys: string[] = [];
        let dataAvailable = false;
        if (activated) {
            const api = await this.getApi();
            if (api && typeof api === 'object') {
                keys = Object.keys(api).slice(0, 30);
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
     * Best-effort port enumeration via the public API. Returns null when the
     * extension isn't installed or the API doesn't expose listing.
     */
    async listPorts(): Promise<BridgePort[] | null> {
        const api = await this.getApi();
        if (!api) { return null; }
        // Typical names in v0.1.x
        const fns = ['getAvailableSerialPorts', 'listPorts', 'getPorts', 'getSerialPorts'];
        for (const name of fns) {
            const fn = api[name];
            if (typeof fn === 'function') {
                try {
                    const ports = await fn.call(api);
                    return Array.isArray(ports) ? ports : [];
                } catch (err) {
                    logger.warn(`Serial Monitor.${name} threw: ${err}`);
                }
            }
        }
        return null;
    }

    async subscribeIfAvailable(): Promise<{ ok: true; eventName: string } | { ok: false; reason: string }> {
        if (this.subscription) {
            return { ok: true, eventName: this.dataEventName ?? '<active>' };
        }
        const api = await this.getApi();
        if (!api) {
            return { ok: false, reason: `Extension '${this.extId}' is not installed or failed to activate.` };
        }
        const eventName = this.findDataEvent(api);
        if (!eventName) {
            return {
                ok: false,
                reason: `The installed Microsoft Serial Monitor build does not expose a public data-subscription event ` +
                    `(probed: onDidReceiveData / onDataReceived / onData / onSerialData / onDidReadData / subscribeData). ` +
                    `Use the standalone serial_open / serial_read_owned path to own a port, or update the Serial Monitor ` +
                    `extension when MS adds the API.`,
            };
        }
        try {
            const event = api[eventName] as (cb: (arg: any) => void) => vscode.Disposable;
            this.subscription = event.call(api, (evt: any) => this.onData(evt));
            this.dataEventName = eventName;
            return { ok: true, eventName };
        } catch (err) {
            return { ok: false, reason: `Subscribing via ${eventName} threw: ${err}` };
        }
    }

    unsubscribe(): boolean {
        if (!this.subscription) { return false; }
        try { this.subscription.dispose(); } catch { /* ignore */ }
        this.subscription = null;
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
            logger.warn(`Serial Monitor bridge buffer hit ${MAX_BUFFER_BYTES} byte cap`);
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

export const serialMonitorBridge = new SerialMonitorBridge();
