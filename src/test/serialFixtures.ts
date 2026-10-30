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
 * What the serial suites share (#49): a clock and timers moved by hand, a
 * port that fails or answers as a test says, a Serial Monitor that hands out
 * its API through `getApi(version, context)` as 0.13 does, with or without a
 * data event, and the device paths of every platform. Only mock ports:
 * serialport's `SerialPortMock` over its `MockBinding`, never a device.
 */

import { EventEmitter } from 'events';
import { SerialPortMock } from 'serialport';
import type { ProblemInput } from '../core/problemJournal';
import { OwnedPort, PortOptions, SerialController } from '../core/serialController';
import type { LeaseTimers } from '../core/serialLease';
import type { BridgeExtension } from '../core/serialMonitorBridge';

/** Device paths as each platform spells them. */
export const PATH_FIXTURES = ['COM7', '\\\\.\\COM12', '/dev/cu.usbmodem1102', '/dev/tty.usbmodem1102', '/dev/ttyACM0'];

/** 10:42:07 local time, so rendered clock times are the same everywhere. */
export const T0 = new Date(2026, 8, 23, 10, 42, 7).getTime();

/** A clock that stands still until `advance`, which fires the timers that fall due, in order. */
export class ManualTime implements LeaseTimers {
    private at = T0;
    private pending: Array<{ due: number; fire: () => void; live: boolean }> = [];

    now(): number {
        return this.at;
    }

    date(): Date {
        return new Date(this.at);
    }

    after(ms: number, fire: () => void): () => void {
        const timer = { due: this.at + ms, fire, live: true };
        this.pending.push(timer);
        return () => { timer.live = false; };
    }

    /** Timers armed and not yet fired or cancelled. */
    armed(): number {
        return this.pending.filter((timer) => timer.live).length;
    }

    /** Move the clock by `ms` seconds' worth of milliseconds, firing each timer at its own time. */
    advance(ms: number): void {
        const until = this.at + ms;
        for (;;) {
            const next = this.pending.filter((timer) => timer.live && timer.due <= until).sort((a, b) => a.due - b.due)[0];
            if (next === undefined) {
                break;
            }
            next.live = false;
            this.at = next.due;
            next.fire();
        }
        this.at = until;
        this.pending = this.pending.filter((timer) => timer.live);
    }

    /** `advance` in seconds. */
    advanceSeconds(seconds: number): void {
        this.advance(seconds * 1000);
    }
}

/** A port that does what the test says; for the states the mock binding cannot reach. */
export class ScriptedPort extends EventEmitter implements OwnedPort {
    isOpen = false;
    written: Buffer[] = [];

    /** @param failOpen the message the open fails with, if it should fail. */
    constructor(private readonly failOpen?: string) {
        super();
    }

    open(callback: (err: Error | null) => void): void {
        if (this.failOpen !== undefined) {
            callback(new Error(this.failOpen));
            return;
        }
        this.isOpen = true;
        callback(null);
    }

    close(callback: (err: Error | null) => void): void {
        this.isOpen = false;
        callback(null);
    }

    write(data: Buffer, callback: (err: Error | null | undefined) => void): boolean {
        this.written.push(Buffer.from(data));
        callback(null);
        return true;
    }

    drain(callback: (err: Error | null) => void): void {
        callback(null);
    }
}

/** A controller over mock ports, a hand-moved clock and a journal the test reads. */
export interface MockSerial {
    controller: SerialController;
    time: ManualTime;
    /** Every mock port the controller created, in order. */
    ports: SerialPortMock[];
    journaled: ProblemInput[];
}

/** A controller over `SerialPortMock`; the paths must exist in `SerialPortMock.binding` (`createPort`). */
export function mockSerial(time: ManualTime = new ManualTime()): MockSerial {
    const ports: SerialPortMock[] = [];
    const journaled: ProblemInput[] = [];
    const controller = new SerialController({
        createPort: (options: PortOptions) => {
            const port = new SerialPortMock(options);
            ports.push(port);
            return port;
        },
        clock: () => time.date(),
        timers: time,
        journal: (problem) => journaled.push(problem),
    });
    return { controller, time, ports, journaled };
}

/** The extension context the tests hand the bridge, as the Serial Monitor's `getApi` reads it. */
export const CONSUMER = { extension: { id: 'arm.cmsis-developer-assistant' } };

/** One call of the Serial Monitor's `getApi`. */
export interface ApiRequest {
    version: unknown;
    consumer: unknown;
}

/**
 * The API of `ms-vscode.vscode-serial-monitor` 0.13 (`SerialMonitorImpl` in
 * its dist/extension.js): a class instance whose methods live on the
 * prototype, which refuses to be made without an extension context and has
 * no data event.
 */
class SerialMonitorApiV0 {
    readonly hashedConsumerExtensionIdentifier: string;

    constructor(context: unknown) {
        const extension: unknown = typeof context === 'object' && context !== null ? Reflect.get(context, 'extension') : undefined;
        const id: unknown = typeof extension === 'object' && extension !== null ? Reflect.get(extension, 'id') : undefined;
        if (typeof id !== 'string') {
            throw new Error('An extension context must be passed to the Serial Monitor API.');
        }
        this.hashedConsumerExtensionIdentifier = `sha256(${id})`;
    }

    async listAvailablePorts(): Promise<Array<{ portName: string; friendlyName?: string; vid?: string; pid?: string }>> {
        return [{ portName: 'COM7', friendlyName: 'USB Serial Device (COM7)', vid: '0D28', pid: '0204' }];
    }

    async startMonitoringPort(): Promise<{ stopMonitoring(): Promise<void> }> {
        return { stopMonitoring: async () => undefined };
    }

    async stopMonitoringPort(): Promise<boolean> {
        return false;
    }

    async startMonitoringTCPConnection(): Promise<{ stopMonitoring(): Promise<void> }> {
        return { stopMonitoring: async () => undefined };
    }

    async stopMonitoringTCPConnection(): Promise<boolean> {
        return false;
    }

    async clearOutput(): Promise<void> {
        return undefined;
    }

    dispose(): void {
        return undefined;
    }
}

/** What the fake Serial Monitor is like. */
export interface FakeMonitorOptions {
    /** Its API has the data event the bridge looks for, as a later build might; true by default. */
    dataEvent?: boolean;
    /** It is active already; true by default. */
    active?: boolean;
    /** The one API version its `getApi` accepts; 0, as 0.13, by default. */
    apiVersion?: number;
}

/** A Serial Monitor as the bridge meets it: exports that hold `getApi(version, context)`, and the API that hands out. */
export interface FakeSerialMonitor {
    extension: BridgeExtension;
    /** Every `getApi` call, in order. */
    requests: ApiRequest[];
    /** How often the extension was activated. */
    activations(): number;
    /** Deliver bytes as the Serial Monitor would. */
    emit(data: string): void;
    /** True while the bridge listens. */
    listening(): boolean;
}

/** A fake `ms-vscode.vscode-serial-monitor` as `options` describe it; by default active, with a data event. */
export function fakeSerialMonitor(options: FakeMonitorOptions = {}): FakeSerialMonitor {
    const { dataEvent = true, apiVersion = 0 } = options;
    let active = options.active ?? true;
    let activations = 0;
    let listener: ((event: unknown) => void) | undefined;
    const requests: ApiRequest[] = [];
    /** The API of a later build: version 0 and a data event. */
    class SerialMonitorApiWithData extends SerialMonitorApiV0 {
        onDidReceiveData(callback: (event: unknown) => void): { dispose(): void } {
            listener = callback;
            return { dispose: () => { listener = undefined; } };
        }
    }
    const exports = {
        getApi: (version: unknown, consumer: unknown): SerialMonitorApiV0 => {
            requests.push({ version, consumer });
            if (version !== apiVersion) {
                throw new Error('Invalid Serial Monitor API version.');
            }
            return dataEvent ? new SerialMonitorApiWithData(consumer) : new SerialMonitorApiV0(consumer);
        },
    };
    return {
        extension: {
            get isActive(): boolean { return active; },
            get exports(): unknown { return active ? exports : undefined; },
            activate: async () => { activations += 1; active = true; return exports; },
        },
        requests,
        activations: () => activations,
        emit: (data) => listener?.({ data: Buffer.from(data, 'utf8') }),
        listening: () => listener !== undefined,
    };
}
