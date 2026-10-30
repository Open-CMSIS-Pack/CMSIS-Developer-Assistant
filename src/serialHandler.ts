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

import * as vscode from 'vscode';
import { currentCallContext } from './core/callContext';
import { CaptureRecord, CaptureStop, captureDurationMs, renderCapture, untilPattern } from './core/serialCapture';
import { describeRelease, reopenAdvice, SerialController, serialController, SerialOpenOptions, SerialStatus } from './core/serialController';
import { DEFAULT_IDLE_CLOSE_SECONDS, idleSecondsOf, ReleaseRule, releaseRuleOf } from './core/serialLease';
import { SerialMonitorBridge, serialMonitorBridge } from './core/serialMonitorBridge';
import { holdClause, holderWords, ruleSentence } from './core/serialText';
import { ToolError, ToolText } from './core/toolResult';
import { logger } from './utils/logger';

/** What `serial_open` takes: the port's options and, since #49, its release rule. */
export interface SerialOpenRequest extends SerialOpenOptions {
    releaseOn?: ReleaseRule;
}

/** What `serial_capture` takes (#49). */
export interface CaptureRequest {
    path: string;
    baudRate?: number;
    /** 100 to 60 000 ms. */
    durationMs: number;
    /** A regex; the capture stops at its first match. */
    until?: string;
    /** UTF-8 text sent once the port is open. */
    write?: string;
}

/** The hint of a capture refused because this window holds a port already. */
const SLOT_HELD_HINT = 'serial_read {waitMs} reads the open port; serial_close it to use serial_capture.';

/** What the handler reads besides its controller; each defaults to the window's own. */
export interface SerialHandlerOptions {
    /** `serial.idleCloseSeconds` at the moment of an open; the VS Code setting by default. */
    idleCloseSeconds?: () => number;
    /** The Serial Monitor bridge. */
    bridge?: SerialMonitorBridge;
}

/** `serial.idleCloseSeconds` as it is now: window scope, read at each open, so a change needs no reload (#49). */
function idleCloseSetting(): number {
    const configured: unknown = vscode.workspace.getConfiguration('cmsis-developer-assistant')
        .get<unknown>('serial.idleCloseSeconds', DEFAULT_IDLE_CLOSE_SECONDS);
    return idleSecondsOf(configured);
}

/** The MCP session of the call being served (#48's call context); none outside a tool call. */
function callingSession(): string | undefined {
    return currentCallContext()?.sessionId;
}

/** The port options of a `serial_open` request, without its rule. */
function portOptions(args: SerialOpenRequest): SerialOpenOptions {
    const { path, baudRate, dataBits, parity, stopBits, rtscts } = args;
    return { path, baudRate, dataBits, parity, stopBits, rtscts };
}

/** Why the owned port is closed, when it closed by itself or a rule released it; undefined when it is open or was closed on purpose. */
function releaseNote(status: SerialStatus): string | undefined {
    return !status.open && status.lastRelease ? describeRelease(status.lastRelease) : undefined;
}

/** `closed`, or `closed (COM7 disconnected at 10:42:07), 12 byte(s) still buffered` after the port went by itself. */
function closedText(status: SerialStatus): string {
    const released = releaseNote(status);
    if (!released) {
        return 'closed';
    }
    return `closed (${released})${status.bufferedBytes > 0 ? `, ${status.bufferedBytes} byte(s) still buffered` : ''}`;
}

/** The refusal of a capture while the window holds a port: which one, and who holds it as `caller` sees it. */
function slotTaken(owned: SerialController, caller: string | undefined): ToolError {
    const hold = owned.hold();
    const who = hold ? ` (held by ${holderWords(hold.owner, caller)})` : '';
    return new ToolError('PORT_HELD',
        `${owned.status().path} is open in this window${who}, so serial_capture cannot take the port.`, SLOT_HELD_HINT);
}

/**
 * Serial-tool handlers. Two backends:
 *
 *   1) `serialController` — owns its own port via the `serialport` package.
 *      Use when the user is NOT running an MS Serial Monitor session for the
 *      same device path (one OS-level reader per tty).
 *
 *   2) `serialMonitorBridge` — asks the MS Serial Monitor extension for its
 *      API (`getApi` version 0). That API has no data event, so
 *      `serial_subscribe_monitor` is refused, saying so; a build whose API
 *      has one is subscribed with no further changes.
 *
 * The agent picks: `serial_open` (own port) vs `serial_subscribe_monitor`
 * (tap user's UI session). The owned port is the `serialController`
 * singleton unless a test hands in its own controller.
 *
 * Release rules (#49): `serial_open` and `serial_subscribe_monitor` record the
 * MCP session of the call as the holder, and the idle limit from the setting
 * `serial.idleCloseSeconds` at that moment. `serial_read`, `serial_write`,
 * `serial_status` and `serial_clear_buffer` are serial calls: they restart
 * the idle time, and a call that waits holds the port meanwhile. When an MCP
 * session ends, `sessionEnded` releases what it held here. `serial_capture`
 * holds the port only for its one read and closes it again.
 */
export class SerialHandler {
    private readonly bridge: SerialMonitorBridge;
    private readonly idleCloseSeconds: () => number;

    constructor(private readonly owned: SerialController = serialController, options: SerialHandlerOptions = {}) {
        this.bridge = options.bridge ?? serialMonitorBridge;
        this.idleCloseSeconds = options.idleCloseSeconds ?? idleCloseSetting;
    }

    // ── Backend-agnostic helpers ────────────────────────────────────

    /**
     * `serial_list_ports`: the ports serialport finds, with the friendly name
     * Windows gives a port, the manufacturer, the serial number and VID:PID.
     * The Serial Monitor's API lists the same ports without the serial
     * numbers, so it is not asked.
     */
    async handleListPorts(): Promise<string> {
        const fromOwn = await this.owned.listPorts();
        if (fromOwn.length === 0) { return 'No serial ports detected.'; }
        const lines = [`Available serial ports (${fromOwn.length}, via serialport):`];
        for (const p of fromOwn) {
            const id = [p.friendlyName, p.manufacturer, p.serialNumber].filter(Boolean).join(' / ');
            const usb = p.vendorId && p.productId ? ` [VID:PID ${p.vendorId}:${p.productId}]` : '';
            lines.push(`  ${p.path}${id ? `  — ${id}` : ''}${usb}`);
        }
        return lines.join('\n');
    }

    // ── Owned-port backend (serialport) ─────────────────────────────

    /** `serial_open`: the port is held for the calling MCP session under `releaseOn` (default `idle`). */
    async handleOpen(args: SerialOpenRequest): Promise<string> {
        const rule = releaseRuleOf(args.releaseOn);
        const idleSeconds = this.idleCloseSeconds();
        await this.owned.open(portOptions(args), { owner: callingSession(), rule, idleSeconds });
        const s = this.owned.status();
        return `Owned serial port opened: ${s.path} @ ${s.baudRate} baud. ${ruleSentence(rule, idleSeconds)} ` +
            `Note: if MS Serial Monitor is also holding this port the OS will reject one of you. ` +
            `Use serial_read / serial_write / serial_close for this owned connection.`;
    }

    /**
     * `serial_capture`: open `path` in this window's port slot for the calling
     * session, send `write`, read until `until` matches or `durationMs` ends,
     * then close the port, also when the read fails. A regex that does not
     * compile is refused before the port is touched, and a slot that is taken
     * is `PORT_HELD`. The target is not reset.
     */
    async handleCapture(args: CaptureRequest): Promise<ToolText> {
        const until = untilPattern(args.until);
        const durationMs = captureDurationMs(args.durationMs);
        const caller = callingSession();
        // The slot is looked at in the open's turn, so a capture that waited for another open finds its port.
        const generation = await this.owned.open({ path: args.path, baudRate: args.baudRate },
            { owner: caller, rule: 'idle', idleSeconds: 0, capture: true }, () => slotTaken(this.owned, caller));
        const opened = Date.now();
        const record = new CaptureRecord();
        // Set inside the read loop's closure, so it is typed as the union rather than narrowed to its first value.
        let stop = 'deadline' as CaptureStop;
        let written = 0;
        try {
            await this.owned.during(async () => {
                if (args.write !== undefined && args.write.length > 0) {
                    written = await this.owned.write(args.write, 'utf8');
                }
                for (let left = durationMs; left > 0; left = opened + durationMs - Date.now()) {
                    const chunk = await this.owned.read({ waitMs: left });
                    if (chunk.length > 0) {
                        record.append(chunk);
                        if (until?.test(record.searchText(chunk.length))) {
                            stop = 'match';
                            return;
                        }
                    } else if (!this.owned.holds(generation)) {
                        stop = 'closed';
                        return;
                    }
                }
            });
        } finally {
            if (this.owned.holds(generation)) {
                await this.owned.close(generation).catch((problem: unknown) => logger.debug('Closing the port of a capture failed', problem));
                this.owned.clearBuffer();
            }
        }
        const release = this.owned.status().lastRelease;
        return renderCapture({
            path: args.path, record, elapsedMs: Date.now() - opened, stop, until, written,
            ...(stop === 'closed' && release ? { closedBecause: describeRelease(release) } : {}),
        });
    }

    async handleClose(): Promise<string> {
        // Whether a port was open is answered in the close's turn, after an open in flight, whose port is closed too.
        if (await this.owned.close()) {
            return 'Owned serial port closed.';
        }
        const released = releaseNote(this.owned.status());
        return released ? `No owned serial port was open (${released}).` : 'No owned serial port was open.';
    }

    async handleStatus(): Promise<string> {
        this.owned.touch();
        this.bridge.touch();
        const s = this.owned.status();
        const hold = this.owned.hold();
        const bridge = await this.bridge.status();
        const lines: string[] = [];
        const held = hold ? `; ${holdClause(hold, callingSession())}` : '';
        lines.push(`Owned serial: ${s.open ? `OPEN on ${s.path} @ ${s.baudRate} baud, ${s.bufferedBytes} byte(s) buffered (since ${s.openedAt})${held}` : closedText(s)}`);
        lines.push(`Serial Monitor bridge: extension ${bridge.extensionInstalled ? 'installed' : 'NOT INSTALLED'}` +
            `, ${bridge.activated ? 'activated' : 'inactive'}` +
            `, data-subscription ${bridge.dataSubscriptionAvailable ? 'AVAILABLE' : 'unavailable in this build'}` +
            `, ${bridge.subscribed ? `SUBSCRIBED, ${bridge.bufferedBytes} byte(s) buffered` : 'not subscribed'}`);
        if (bridge.activated && bridge.apiKeysDiscovered.length > 0) {
            lines.push(`  API keys: ${bridge.apiKeysDiscovered.join(', ')}`);
        }
        return lines.join('\n');
    }

    async handleWrite(args: { data: string; encoding?: 'utf8' | 'hex'; appendNewline?: boolean }): Promise<string> {
        let payload = args.data;
        const encoding = args.encoding ?? 'utf8';
        if (args.appendNewline && encoding === 'utf8') { payload = payload + '\n'; }
        const n = await this.owned.during(() => this.owned.write(payload, encoding));
        return `Wrote ${n} byte(s) to owned serial port.`;
    }

    async handleRead(args: { maxBytes?: number; waitMs?: number; consume?: boolean; format?: 'utf8' | 'hex' | 'both'; from?: 'owned' | 'monitor' }): Promise<string> {
        const format = args.format ?? 'utf8';
        const from = args.from ?? 'owned';
        const options = { maxBytes: args.maxBytes, waitMs: args.waitMs, consume: args.consume };
        let data: Buffer;
        if (from === 'monitor') {
            this.bridge.touch();
            data = await this.bridge.read(options);
            this.bridge.touch();
        } else {
            data = await this.owned.during(() => this.owned.read(options));
        }

        // The owned port closed by itself or was released: the bytes received before still come, with the reason.
        const status = this.owned.status();
        const released = from === 'owned' ? releaseNote(status) : undefined;
        const closedNote = released && status.lastRelease
            ? `The owned port is closed: ${released}. ${reopenAdvice(status.lastRelease)}` : undefined;
        if (data.length === 0) {
            return closedNote ? `Serial RX (${from}): <no data>\n${closedNote}` : `Serial RX (${from}): <no data>`;
        }
        const lines: string[] = [`Serial RX (${from}): ${data.length} byte(s)${args.consume === false ? ' (peek)' : ''}`];
        if (closedNote) {
            lines.push(closedNote);
        }
        if (format === 'utf8' || format === 'both') {
            lines.push('--- text ---');
            lines.push(data.toString('utf8'));
        }
        if (format === 'hex' || format === 'both') {
            lines.push('--- hex ---');
            for (let i = 0; i < data.length; i += 16) {
                const slice = data.subarray(i, Math.min(i + 16, data.length));
                const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
                lines.push(`  ${i.toString(16).padStart(4, '0')}: ${hex}`);
            }
        }
        return lines.join('\n');
    }

    async handleClearBuffer(args?: { from?: 'owned' | 'monitor' }): Promise<string> {
        const from = args?.from ?? 'owned';
        let n: number;
        if (from === 'monitor') {
            this.bridge.touch();
            n = this.bridge.clearBuffer();
        } else {
            this.owned.touch();
            n = this.owned.clearBuffer();
        }
        return `Cleared ${n} byte(s) from ${from} RX buffer.`;
    }

    // ── MS Serial Monitor bridge ────────────────────────────────────

    async handleSubscribeMonitor(): Promise<string> {
        const r = await this.bridge.subscribeIfAvailable({ owner: callingSession(), idleSeconds: this.idleCloseSeconds() });
        if (r.ok) {
            return `Subscribed to MS Serial Monitor data via '${r.eventName}'. ` +
                `Use serial_read with from='monitor' to consume buffered RX bytes. ` +
                `serial_unsubscribe_monitor stops the subscription without closing the user's session.`;
        }
        return `Could not subscribe to Serial Monitor data: ${r.reason}`;
    }

    async handleUnsubscribeMonitor(): Promise<string> {
        const was = this.bridge.unsubscribe();
        return was ? 'Unsubscribed from Serial Monitor data.' : 'Was not subscribed.';
    }

    async handleOpenInUi(): Promise<string> {
        const candidates = [
            'workbench.view.extension.vscode-serial-monitor-tools',
            'vscode-serial-monitor.monitor0.focus',
        ];
        const tried: string[] = [];
        for (const cmd of candidates) {
            try {
                await vscode.commands.executeCommand(cmd);
                return `Focused the Serial Monitor panel via '${cmd}'.`;
            } catch (err) {
                tried.push(`${cmd} (${err instanceof Error ? err.message : String(err)})`);
            }
        }
        return `Could not focus the Serial Monitor panel. Tried: ${tried.join('; ')}.`;
    }

    // ── Session end (#49) ───────────────────────────────────────────

    /**
     * The MCP session `sessionId` ended: release the port it opened in this
     * window, unless its rule is `manual`, and end the Serial Monitor
     * subscription it made. Not a tool: the control server runs it for the
     * internal op `sessionEnded`, and a server without a router calls it
     * directly. Never throws.
     */
    async sessionEnded(sessionId: string): Promise<string> {
        const port = await this.owned.sessionEnded(sessionId);
        const subscription = this.bridge.sessionEnded(sessionId);
        const done = [...(port ? [`released ${port}`] : []), ...(subscription ? ['ended the Serial Monitor subscription'] : [])];
        return `MCP session ${sessionId.slice(0, 8)} ended: ${done.length > 0 ? done.join(' and ') : 'it held no serial port in this window'}.`;
    }
}

export const serialHandler = new SerialHandler();
