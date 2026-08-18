// SPDX-License-Identifier: Apache-2.0 OR MIT
// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as vscode from 'vscode';
import { serialController, SerialOpenOptions } from './core/serialController';
import { serialMonitorBridge } from './core/serialMonitorBridge';

/**
 * Serial-tool handlers. Two backends:
 *
 *   1) `serialController` — owns its own port via the `serialport` package.
 *      Use when the user is NOT running an MS Serial Monitor session for the
 *      same device path (one OS-level reader per tty).
 *
 *   2) `serialMonitorBridge` — taps the MS Serial Monitor extension's public
 *      API via runtime probing. Today the public API only exposes port
 *      enumeration and port-set events; if MS adds a data-subscription event
 *      the bridge picks it up automatically with no further changes.
 *
 * The agent picks: `serial_open` (own port) vs `serial_subscribe_monitor`
 * (tap user's UI session).
 */
export class SerialHandler {

    // ── Backend-agnostic helpers ────────────────────────────────────

    async handleListPorts(): Promise<string> {
        // Prefer the MS Serial Monitor API for listing — it tends to give
        // friendlier names — falling back to our serialport when not available.
        const fromBridge = await serialMonitorBridge.listPorts();
        if (fromBridge && fromBridge.length > 0) {
            const lines = [`Available serial ports (${fromBridge.length}, via Serial Monitor API):`];
            for (const p of fromBridge) {
                const id = [p.friendlyName, p.vid && p.pid ? `${p.vid}:${p.pid}` : null]
                    .filter(Boolean).join(' / ');
                lines.push(`  ${p.portName}${id ? `  — ${id}` : ''}`);
            }
            return lines.join('\n');
        }

        const fromOwn = await serialController.listPorts();
        if (fromOwn.length === 0) { return 'No serial ports detected.'; }
        const lines = [`Available serial ports (${fromOwn.length}, via serialport):`];
        for (const p of fromOwn) {
            const id = [p.manufacturer, p.serialNumber].filter(Boolean).join(' / ');
            const usb = p.vendorId && p.productId ? ` [VID:PID ${p.vendorId}:${p.productId}]` : '';
            lines.push(`  ${p.path}${id ? `  — ${id}` : ''}${usb}`);
        }
        return lines.join('\n');
    }

    // ── Owned-port backend (serialport) ─────────────────────────────

    async handleOpen(args: SerialOpenOptions): Promise<string> {
        await serialController.open(args);
        const s = serialController.status();
        return `Owned serial port opened: ${s.path} @ ${s.baudRate} baud. ` +
            `Note: if MS Serial Monitor is also holding this port the OS will reject one of you. ` +
            `Use serial_read / serial_write / serial_close for this owned connection.`;
    }

    async handleClose(): Promise<string> {
        const wasOpen = serialController.isOpen();
        await serialController.close();
        return wasOpen ? 'Owned serial port closed.' : 'No owned serial port was open.';
    }

    async handleStatus(): Promise<string> {
        const s = serialController.status();
        const bridge = await serialMonitorBridge.status();
        const lines: string[] = [];
        lines.push(`Owned serial: ${s.open ? `OPEN on ${s.path} @ ${s.baudRate} baud, ${s.bufferedBytes} byte(s) buffered (since ${s.openedAt})` : 'closed'}`);
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
        const n = await serialController.write(payload, encoding);
        return `Wrote ${n} byte(s) to owned serial port.`;
    }

    async handleRead(args: { maxBytes?: number; waitMs?: number; consume?: boolean; format?: 'utf8' | 'hex' | 'both'; from?: 'owned' | 'monitor' }): Promise<string> {
        const format = args.format ?? 'utf8';
        const from = args.from ?? 'owned';
        const data = from === 'monitor'
            ? await serialMonitorBridge.read({ maxBytes: args.maxBytes, waitMs: args.waitMs, consume: args.consume })
            : await serialController.read({ maxBytes: args.maxBytes, waitMs: args.waitMs, consume: args.consume });

        if (data.length === 0) {
            return `Serial RX (${from}): <no data>`;
        }
        const lines: string[] = [`Serial RX (${from}): ${data.length} byte(s)${args.consume === false ? ' (peek)' : ''}`];
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
        const n = from === 'monitor' ? serialMonitorBridge.clearBuffer() : serialController.clearBuffer();
        return `Cleared ${n} byte(s) from ${from} RX buffer.`;
    }

    // ── MS Serial Monitor bridge ────────────────────────────────────

    async handleSubscribeMonitor(): Promise<string> {
        const r = await serialMonitorBridge.subscribeIfAvailable();
        if (r.ok) {
            return `Subscribed to MS Serial Monitor data via '${r.eventName}'. ` +
                `Use serial_read with from='monitor' to consume buffered RX bytes. ` +
                `serial_unsubscribe_monitor stops the subscription without closing the user's session.`;
        }
        return `Could not subscribe to Serial Monitor data: ${r.reason}`;
    }

    async handleUnsubscribeMonitor(): Promise<string> {
        const was = serialMonitorBridge.unsubscribe();
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
}

export const serialHandler = new SerialHandler();
