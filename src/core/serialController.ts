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


import { SerialPort } from 'serialport';
import { logger } from '../utils/logger';

/**
 * Programmatic serial port controller — own a connection independent of the
 * Serial Monitor UI extension. Buffers RX data so an MCP client can poll/read
 * it on demand. Use this when the user is NOT running an MS Serial Monitor
 * session for the same port (the OS only allows one reader per tty in the
 * default mode).
 */

export interface SerialOpenOptions {
    path: string;
    baudRate?: number;
    dataBits?: 5 | 6 | 7 | 8;
    parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
    stopBits?: 1 | 1.5 | 2;
    rtscts?: boolean;
}

export interface SerialPortInfo {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    pnpId?: string;
    locationId?: string;
    productId?: string;
    vendorId?: string;
}

export interface SerialStatus {
    open: boolean;
    path: string | null;
    baudRate: number | null;
    bufferedBytes: number;
    openedAt: string | null;
}

const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

class SerialController {
    private port: SerialPort | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private openedAt: Date | null = null;
    private currentPath: string | null = null;
    private currentBaud: number | null = null;

    async listPorts(): Promise<SerialPortInfo[]> {
        const ports = await SerialPort.list();
        return ports.map(p => ({
            path: p.path,
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
        };
    }

    async open(opts: SerialOpenOptions): Promise<void> {
        if (this.isOpen()) {
            throw new Error(
                `A serial port is already open on '${this.currentPath}'. Close it first with serial_close.`
            );
        }
        const baudRate = opts.baudRate ?? 115200;
        const dataBits = opts.dataBits ?? 8;
        const parity = opts.parity ?? 'none';
        const stopBits = opts.stopBits ?? 1;
        const rtscts = opts.rtscts ?? false;

        await new Promise<void>((resolve, reject) => {
            const p = new SerialPort({
                path: opts.path, baudRate, dataBits, parity, stopBits, rtscts,
                autoOpen: false,
            }, (err) => { if (err) { reject(err); } });

            p.on('data', (chunk: Buffer) => this.appendToBuffer(chunk));
            p.on('error', (err) => logger.warn(`Serial port error: ${err.message}`));
            p.on('close', () => logger.info(`Serial port '${opts.path}' closed`));

            p.open((err) => {
                if (err) { reject(err); return; }
                this.port = p;
                this.openedAt = new Date();
                this.currentPath = opts.path;
                this.currentBaud = baudRate;
                this.buffer = Buffer.alloc(0);
                resolve();
            });
        });
    }

    async close(): Promise<void> {
        if (!this.port) { return; }
        const p = this.port;
        await new Promise<void>((resolve, reject) => {
            p.close((err) => err ? reject(err) : resolve());
        });
        this.port = null;
        this.openedAt = null;
        this.currentPath = null;
        this.currentBaud = null;
    }

    async write(data: string | Buffer, encoding: 'utf8' | 'hex' = 'utf8'): Promise<number> {
        if (!this.port || !this.port.isOpen) {
            throw new Error('No serial port open. Call serial_open first.');
        }
        const buf = Buffer.isBuffer(data) ? data
            : (encoding === 'hex' ? Buffer.from(data.replace(/\s+/g, ''), 'hex') : Buffer.from(data, 'utf8'));
        await new Promise<void>((resolve, reject) => {
            this.port!.write(buf, (err) => err ? reject(err) : resolve());
        });
        await new Promise<void>((resolve, reject) => {
            this.port!.drain((err) => err ? reject(err) : resolve());
        });
        return buf.length;
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

    private appendToBuffer(chunk: Buffer): void {
        const combined = Buffer.concat([this.buffer, chunk]);
        if (combined.length > MAX_BUFFER_BYTES) {
            this.buffer = combined.subarray(combined.length - MAX_BUFFER_BYTES);
            logger.warn(`Serial RX buffer hit ${MAX_BUFFER_BYTES} byte cap — dropped oldest data`);
        } else {
            this.buffer = combined;
        }
    }
}

export const serialController = new SerialController();
