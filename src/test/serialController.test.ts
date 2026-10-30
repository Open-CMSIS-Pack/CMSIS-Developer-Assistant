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

import * as assert from 'assert';
import { SerialPortMock } from 'serialport';
import type { ProblemInput } from '../core/problemJournal';
import { PORT_HELD_HINT, PortOptions, SerialController, describeRelease, serialController } from '../core/serialController';
import { ReleaseRule, SerialLease, idleSecondsOf, releaseRuleOf } from '../core/serialLease';
import { ToolError } from '../core/toolResult';
import { SerialHandler } from '../serialHandler';
import { ManualTime, MockSerial, PATH_FIXTURES, ScriptedPort, T0, mockSerial } from './serialFixtures';

/** Inject a fake port into the singleton (it has no port factory to swap). */
function injectPort(close: (cb: (err?: Error | null) => void) => void): void {
    const c = serialController as unknown as { port: unknown; openedAt: Date | null; currentPath: string | null; currentBaud: number | null };
    c.port = { isOpen: true, close };
    c.openedAt = new Date();
    c.currentPath = '/dev/tty.fake';
    c.currentBaud = 115200;
}

suite('serialController close', () => {
    test('a port whose close fails (adapter unplugged) is forgotten, so the next open works', async () => {
        injectPort(cb => cb(new Error('EIO: device gone')));
        assert.ok(serialController.isOpen());
        await assert.rejects(() => serialController.close(), /EIO/);
        assert.strictEqual(serialController.isOpen(), false);
        const status = serialController.status();
        assert.strictEqual(status.open, false);
        assert.strictEqual(status.path, null);
        assert.strictEqual(status.baudRate, null);
        assert.strictEqual(status.openedAt, null);
    });

    test('a port that closes cleanly ends in the same state', async () => {
        injectPort(cb => cb(null));
        await serialController.close();
        assert.strictEqual(serialController.isOpen(), false);
        assert.strictEqual(serialController.status().path, null);
        await serialController.close(); // idempotent
    });
});

/**
 * The owned port's state follows the port (#49, WP-F): an unplugged adapter
 * or a port that closed by itself is forgotten, its bytes stay readable, and
 * the serial tools say why the port is closed. Driven through serialport's
 * own `SerialPortMock`, whose `_disconnected` is what a failed read calls.
 */
suite('serialController follows the port (#49)', () => {
    /** 10:42:07 local time, so the rendered clock is the same everywhere. */
    const AT = new Date(2026, 8, 23, 10, 42, 7);
    let created: SerialPortMock[];

    setup(() => {
        SerialPortMock.binding.reset();
        created = [];
    });

    teardown(() => {
        SerialPortMock.binding.reset();
    });

    function mockController(): SerialController {
        return new SerialController({
            createPort: (options: PortOptions) => {
                const port = new SerialPortMock(options);
                created.push(port);
                return port;
            },
            clock: () => AT,
        });
    }

    /** Unplug the adapter behind `port` the way serialport sees it, and wait for its 'close'. */
    async function unplug(port: SerialPortMock): Promise<void> {
        const closed = new Promise<void>((resolve) => port.once('close', () => resolve()));
        port._disconnected(new Error('EIO: i/o error, read'));
        await closed;
    }

    test('an unplugged port is forgotten, its bytes stay readable, and the reason is kept', async () => {
        const controller = mockController();
        SerialPortMock.binding.createPort('/dev/ttyACM0');
        await controller.open({ path: '/dev/ttyACM0', baudRate: 921600 });
        created[0].port?.emitData(Buffer.from('boot ok\n'));
        assert.strictEqual((await controller.read({ waitMs: 2000, consume: false })).toString(), 'boot ok\n');

        await unplug(created[0]);
        const status = controller.status();
        assert.deepStrictEqual(
            [status.open, status.path, status.baudRate, status.openedAt, status.bufferedBytes],
            [false, null, null, null, 8]);
        assert.deepStrictEqual(status.lastRelease, { path: '/dev/ttyACM0', at: AT, reason: 'disconnected' });
        assert.strictEqual(describeRelease(status.lastRelease), '/dev/ttyACM0 disconnected at 10:42:07');
        await assert.rejects(controller.write('ping'), (failure: Error) =>
            failure.message === 'No serial port open: /dev/ttyACM0 disconnected at 10:42:07. Reopen it with serial_open.');
        assert.strictEqual((await controller.read()).toString(), 'boot ok\n', 'the bytes received before stay readable');

        await controller.open({ path: '/dev/ttyACM0' });
        assert.ok(controller.isOpen(), 'the same path opens again');
        assert.strictEqual(controller.status().lastRelease, null, 'a new open clears the reason');
        await controller.close();
    });

    test('a late close of a port that was replaced leaves the new one alone, and serial_close records no release', async () => {
        const controller = mockController();
        SerialPortMock.binding.createPort('COM7');
        SerialPortMock.binding.createPort('COM8');
        await controller.open({ path: 'COM7' });
        await controller.close();
        assert.strictEqual(controller.status().lastRelease, null, 'closing on purpose is not a release');
        await controller.open({ path: 'COM8' });

        created[0].emit('close', Object.assign(new Error('Port is not open'), { disconnected: true }));
        created[0].emit('error', new Error('late'));
        const status = controller.status();
        assert.deepStrictEqual([status.open, status.path, status.lastRelease], [true, 'COM8', null]);
        await controller.close();
    });

    test('an error while the port is open is only logged; one after it closed releases it with the message', async () => {
        const port = new ScriptedPort();
        const controller = new SerialController({ createPort: () => port, clock: () => AT });
        await controller.open({ path: 'COM9' });
        port.emit('error', new Error('framing error'));
        assert.ok(controller.isOpen());

        port.isOpen = false;
        port.emit('error', new Error('EIO: write failed'));
        const released = controller.status().lastRelease;
        assert.ok(released);
        assert.strictEqual(describeRelease(released), 'COM9 closed unexpectedly at 10:42:07 (EIO: write failed)');
        assert.strictEqual(controller.status().path, null);
    });

    test('the serial tools name the reason instead of "no port open"', async () => {
        const controller = mockController();
        const handler = new SerialHandler(controller);
        SerialPortMock.binding.createPort('COM7');
        assert.strictEqual(await handler.handleRead({}), 'Serial RX (owned): <no data>', 'never opened: as before');
        await controller.open({ path: 'COM7' });
        created[0].port?.emitData(Buffer.from('hello'));
        await controller.read({ waitMs: 2000, consume: false });
        await unplug(created[0]);

        const status = await handler.handleStatus();
        assert.ok(status.startsWith('Owned serial: closed (COM7 disconnected at 10:42:07), 5 byte(s) still buffered\n'), status);
        assert.strictEqual(await handler.handleRead({}),
            'Serial RX (owned): 5 byte(s)\nThe owned port is closed: COM7 disconnected at 10:42:07. Reopen it with serial_open.\n--- text ---\nhello');
        assert.strictEqual(await handler.handleRead({}),
            'Serial RX (owned): <no data>\nThe owned port is closed: COM7 disconnected at 10:42:07. Reopen it with serial_open.');
        await assert.rejects(handler.handleWrite({ data: 'x' }), /No serial port open: COM7 disconnected at 10:42:07\. Reopen it with serial_open\./);
        assert.strictEqual(await handler.handleClose(), 'No owned serial port was open (COM7 disconnected at 10:42:07).');
    });

    test('a port that cannot be opened and one that goes away are journaled as serial warnings, without payload (#48)', async () => {
        const journaled: ProblemInput[] = [];
        const controller = new SerialController({
            createPort: (options: PortOptions) => {
                const port = new SerialPortMock(options);
                created.push(port);
                return port;
            },
            clock: () => AT,
            journal: (problem) => journaled.push(problem),
        });
        await assert.rejects(controller.open({ path: '/dev/nope' }));
        SerialPortMock.binding.createPort('COM7');
        await controller.open({ path: 'COM7' });
        created[1].port?.emitData(Buffer.from('secret payload'));
        await controller.read({ waitMs: 2000, consume: false });
        await unplug(created[1]);
        await controller.open({ path: 'COM7' });
        await controller.close();

        assert.deepStrictEqual(journaled.map((problem) => [problem.source, problem.origin, problem.severity]),
            [['serial', '/dev/nope', 'warning'], ['serial', 'COM7', 'warning']]);
        assert.match(journaled[0].message, /nope/);
        assert.strictEqual(journaled[1].message, 'COM7 disconnected at 10:42:07');
        assert.ok(journaled.every((problem) => !problem.message.includes('secret') && typeof problem.hint === 'string'));
    });
});

/** Open `path` on a mock controller, held by `owner` under `rule` with a 300 s idle limit. */
async function holdPort(serial: MockSerial, path: string, owner: string | undefined, rule: ReleaseRule, idleSeconds = 300): Promise<void> {
    SerialPortMock.binding.createPort(path);
    await serial.controller.open({ path }, { owner, rule, idleSeconds });
}

/** `open`, the reason of the release, or `closed` after a close on purpose. */
function outcomeOf(controller: SerialController): string {
    const status = controller.status();
    return status.open ? 'open' : status.lastRelease?.reason ?? 'closed';
}

/**
 * The release rules (#49): a held port goes after the idle time, when the
 * MCP session that opened it ends, when a debug session ends, or when the
 * user releases it, as its rule says; the bytes stay readable and the tools
 * say why. Mock ports and a hand-moved clock only.
 */
suite('serial release rules (#49)', () => {
    setup(() => SerialPortMock.binding.reset());
    teardown(() => SerialPortMock.binding.reset());

    test('a rule or an idle limit a caller names is taken; anything else is the default', () => {
        assert.deepStrictEqual(['idle', 'debug-session-end', 'manual', 'never', undefined, 7].map(releaseRuleOf),
            ['idle', 'debug-session-end', 'manual', 'idle', 'idle', 'idle']);
        assert.deepStrictEqual([300, 0, 12.7, -1, Number.NaN, '60', undefined].map(idleSecondsOf), [300, 0, 12, 300, 300, 300, 300]);
    });

    test('the lease: released after the idle limit without a call; a touch and a call in progress restart it', async () => {
        const time = new ManualTime();
        let released = 0;
        const lease = new SerialLease({ owner: 'A', rule: 'idle', idleSeconds: 300 }, time, () => { released += 1; });
        time.advanceSeconds(200);
        lease.touch();
        time.advanceSeconds(299);
        assert.strictEqual(released, 0, 'touched at 200 s: not idle for 300 s yet');
        assert.strictEqual(lease.idleReleaseInMs(), 1_000);
        let finish: () => void = () => undefined;
        const call = lease.during(() => new Promise<void>((resolve) => { finish = resolve; }));
        time.advanceSeconds(1_000);
        assert.strictEqual(released, 0, 'a call in progress holds the port');
        assert.strictEqual(lease.idleForMs(), 0);
        finish();
        await call;
        time.advanceSeconds(299);
        assert.strictEqual(released, 0);
        time.advanceSeconds(1);
        assert.strictEqual(released, 1, 'released 300 s after the call ended');
        time.advanceSeconds(3_600);
        assert.strictEqual(released, 1, 'once');
        assert.strictEqual(time.armed(), 0);
    });

    test('an idle limit of 0 and the rules other than idle arm no timer', () => {
        const time = new ManualTime();
        const terms: Array<[ReleaseRule, number]> = [['idle', 0], ['debug-session-end', 300], ['manual', 300]];
        for (const [rule, idleSeconds] of terms) {
            const lease = new SerialLease({ rule, idleSeconds }, time, () => assert.fail(`${rule} released for idleness`));
            assert.strictEqual(lease.idleReleaseInMs(), undefined, rule);
        }
        assert.strictEqual(time.armed(), 0);
        time.advanceSeconds(86_400);
    });

    test('an idle port is released, its bytes stay readable, and read, write and close say why', async () => {
        const serial = mockSerial();
        const handler = new SerialHandler(serial.controller, { idleCloseSeconds: () => 300 });
        SerialPortMock.binding.createPort('COM7');
        await handler.handleOpen({ path: 'COM7' });
        serial.ports[0].port?.emitData(Buffer.from('boot ok\n'));
        await serial.controller.read({ waitMs: 2_000, consume: false });

        serial.time.advanceSeconds(299);
        assert.ok(serial.controller.isOpen());
        serial.time.advanceSeconds(1);
        const status = serial.controller.status();
        assert.deepStrictEqual([status.open, status.path, status.baudRate, status.openedAt, status.bufferedBytes], [false, null, null, null, 8]);
        assert.deepStrictEqual(status.lastRelease, { path: 'COM7', at: new Date(T0 + 300_000), reason: 'idle', idleSeconds: 300 });
        const why = 'COM7 released at 10:47:07 after 300 s without a serial call';
        assert.strictEqual(await handler.handleRead({}),
            `Serial RX (owned): 8 byte(s)\nThe owned port is closed: ${why}. Reopen it with serial_open.\n--- text ---\nboot ok\n`);
        await assert.rejects(handler.handleWrite({ data: 'x' }), (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'PORT_CLOSED'
                && failure.message === `No serial port open: ${why}. Reopen it with serial_open.`);
        assert.strictEqual(await handler.handleClose(), `No owned serial port was open (${why}).`);
        assert.ok((await handler.handleStatus()).startsWith(`Owned serial: closed (${why})\n`));
    });

    test('serial_read, serial_write, serial_status and serial_clear_buffer restart the idle time; bytes from the board do not', async () => {
        const serial = mockSerial();
        const handler = new SerialHandler(serial.controller, { idleCloseSeconds: () => 300 });
        SerialPortMock.binding.createPort('/dev/ttyACM0');
        await handler.handleOpen({ path: '/dev/ttyACM0' });
        const calls: Array<() => Promise<unknown>> = [
            () => handler.handleRead({}),
            () => handler.handleWrite({ data: 'help', appendNewline: true }),
            () => handler.handleStatus(),
            () => handler.handleClearBuffer({}),
        ];
        for (const call of calls) {
            serial.time.advanceSeconds(200);
            await call();
            assert.ok(serial.controller.isOpen(), 'each call came within 300 s of the one before');
        }
        serial.time.advanceSeconds(200);
        serial.ports[0].port?.emitData(Buffer.from('tick\n'));
        await serial.controller.read({ waitMs: 2_000, consume: false });
        serial.time.advanceSeconds(99);
        assert.ok(serial.controller.isOpen(), 'open 299 s after the last call');
        serial.time.advanceSeconds(1);
        assert.strictEqual(outcomeOf(serial.controller), 'idle', 'the bytes from the board did not count as use');
    });

    test('the releaseOn matrix: what each rule does on each event', async () => {
        type Event = 'idle' | 'owner gone' | 'another session gone' | 'debug session end' | 'user' | 'serial_close';
        const expected: Record<ReleaseRule, Record<Event, string>> = {
            idle: {
                idle: 'idle', 'owner gone': 'owner-gone', 'another session gone': 'open', 'debug session end': 'open',
                user: 'user', serial_close: 'closed',
            },
            'debug-session-end': {
                idle: 'open', 'owner gone': 'owner-gone', 'another session gone': 'open', 'debug session end': 'debug-session-end',
                user: 'user', serial_close: 'closed',
            },
            manual: {
                idle: 'open', 'owner gone': 'open', 'another session gone': 'open', 'debug session end': 'open',
                user: 'user', serial_close: 'closed',
            },
        };
        const happen: Record<Event, (serial: MockSerial) => Promise<unknown>> = {
            idle: async (serial) => serial.time.advanceSeconds(3_600),
            'owner gone': async (serial) => serial.controller.sessionEnded('session-A'),
            'another session gone': async (serial) => serial.controller.sessionEnded('session-B'),
            'debug session end': async (serial) => serial.controller.debugSessionEnded(),
            user: async (serial) => serial.controller.releaseForUser(),
            serial_close: (serial) => serial.controller.close(),
        };
        const seen: string[] = [];
        for (const rule of Object.keys(expected) as ReleaseRule[]) {
            for (const event of Object.keys(happen) as Event[]) {
                SerialPortMock.binding.reset();
                const serial = mockSerial();
                await holdPort(serial, 'COM7', 'session-A', rule);
                await happen[event](serial);
                seen.push(`${rule}/${event}: ${outcomeOf(serial.controller)}`);
                assert.strictEqual(outcomeOf(serial.controller), expected[rule][event], `${rule} on ${event}`);
            }
        }
        assert.strictEqual(seen.length, 18);
    });

    test('the end of a session releases only the port that session opened, never a manual one nor one without an owner', async () => {
        const windowA = mockSerial();
        const windowB = mockSerial();
        const windowC = mockSerial();
        const windowD = mockSerial();
        await holdPort(windowA, 'COM7', 'session-A', 'idle');
        await holdPort(windowB, '/dev/ttyACM0', 'session-B', 'idle');
        await holdPort(windowC, '/dev/cu.usbmodem1102', 'session-A', 'manual');
        await holdPort(windowD, '/dev/tty.usbmodem1102', undefined, 'idle');
        const released = await Promise.all([windowA, windowB, windowC, windowD].map((serial) => serial.controller.sessionEnded('session-A')));
        assert.deepStrictEqual(released, ['COM7', undefined, undefined, undefined]);
        assert.deepStrictEqual([windowA, windowB, windowC, windowD].map((serial) => outcomeOf(serial.controller)),
            ['owner-gone', 'open', 'open', 'open']);
        assert.strictEqual(describeRelease(windowA.controller.status().lastRelease!), 'COM7 released at 10:42:07: the MCP session that opened it ended');
    });

    test('each release is one journal record without payload: a warning for an unplug and the user, info for a rule', async () => {
        const events: Array<[string, (serial: MockSerial) => unknown]> = [
            ['idle', (serial) => serial.time.advanceSeconds(300)],
            ['owner-gone', (serial) => serial.controller.sessionEnded('session-A')],
            ['user', (serial) => serial.controller.releaseForUser()],
        ];
        const records: Array<[string, string, string | undefined]> = [];
        for (const [label, release] of events) {
            SerialPortMock.binding.reset();
            const serial = mockSerial();
            await holdPort(serial, 'COM7', 'session-A', 'idle');
            serial.ports[0].port?.emitData(Buffer.from('secret payload'));
            await serial.controller.read({ waitMs: 2_000, consume: false });
            await release(serial);
            assert.strictEqual(serial.journaled.length, 1, label);
            const [record] = serial.journaled;
            assert.ok(!record.message.includes('secret') && typeof record.hint === 'string', label);
            records.push([record.severity, record.message, record.code]);
        }
        assert.deepStrictEqual(records, [
            ['info', 'COM7 released at 10:47:07 after 300 s without a serial call', undefined],
            ['info', 'COM7 released at 10:42:07: the MCP session that opened it ended', undefined],
            ['warning', 'COM7 released at 10:42:07 by the user in VS Code', undefined],
        ]);
        const debugEnd = mockSerial();
        await holdPort(debugEnd, 'COM8', 'session-A', 'debug-session-end');
        debugEnd.controller.debugSessionEnded();
        assert.deepStrictEqual(debugEnd.journaled.map((record) => [record.severity, record.message]),
            [['info', 'COM8 released at 10:42:07: the debug session ended']]);
    });

    test('after the user released a port, the tools say to ask before reopening it', async () => {
        const serial = mockSerial();
        const handler = new SerialHandler(serial.controller, { idleCloseSeconds: () => 300 });
        await holdPort(serial, 'COM7', 'session-A', 'manual');
        assert.strictEqual(serial.controller.releaseForUser(), 'COM7');
        assert.strictEqual(serial.controller.releaseForUser(), undefined, 'nothing left to release');
        assert.strictEqual(await handler.handleRead({}),
            'Serial RX (owned): <no data>\nThe owned port is closed: COM7 released at 10:42:07 by the user in VS Code. '
            + 'Ask the user before you reopen it with serial_open.');
    });

    test('a read that waits returns at once without a port, and as soon as the port it waits on goes away', async () => {
        const serial = mockSerial();
        let started = Date.now();
        await serial.controller.read({ waitMs: 10_000 });
        assert.ok(Date.now() - started < 1_000, 'no port: nothing can arrive');
        await holdPort(serial, 'COM7', 'session-A', 'idle');
        started = Date.now();
        const waiting = serial.controller.read({ waitMs: 10_000 });
        setTimeout(() => serial.controller.releaseForUser(), 50);
        await waiting;
        assert.ok(Date.now() - started < 2_000, `the read ended ${Date.now() - started} ms after it began`);
    });

    test('a write without a port is PORT_CLOSED', async () => {
        await assert.rejects(mockSerial().controller.write('x'), (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'PORT_CLOSED' && failure.message === 'No serial port open. Call serial_open first.');
    });

    suite('PORT_HELD', () => {
        /** What the OS answers an open when another program holds the port, per platform. */
        const REFUSALS: Array<(path: string) => string> = [
            (path) => `Opening ${path}: Access denied`,
            (path) => `Error: Resource busy, cannot open ${path}`,
            (path) => `Error: Device or resource busy, cannot open ${path}`,
            () => 'Error Resource temporarily unavailable Cannot lock port',
        ];

        test('another program holding the port is PORT_HELD for every path spelling, journaled with the code', async () => {
            for (const path of PATH_FIXTURES) {
                for (const refusal of REFUSALS) {
                    const journaled: ProblemInput[] = [];
                    const controller = new SerialController({ createPort: () => new ScriptedPort(refusal(path)), journal: (problem) => journaled.push(problem) });
                    await assert.rejects(controller.open({ path }), (failure: unknown) =>
                        failure instanceof ToolError && failure.code === 'PORT_HELD'
                            && failure.message === `Cannot open ${path}: another program holds it (${refusal(path)}).`
                            && failure.hint === PORT_HELD_HINT, `${path}: ${refusal(path)}`);
                    assert.deepStrictEqual(journaled.map((problem) => [problem.origin, problem.severity, problem.code]),
                        [[path, 'warning', 'PORT_HELD']]);
                    assert.strictEqual(controller.isOpen(), false);
                }
            }
        });

        test('a failure that is not about another holder passes unchanged', async () => {
            const missing = 'Error: No such file or directory, cannot open /dev/ttyACM9';
            const controller = new SerialController({ createPort: () => new ScriptedPort(missing), journal: () => undefined });
            await assert.rejects(controller.open({ path: '/dev/ttyACM9' }), (failure: unknown) =>
                !(failure instanceof ToolError) && failure instanceof Error && failure.message === missing);
        });

        test('a second opener of the same device, as the mock binding locks it, is PORT_HELD', async () => {
            SerialPortMock.binding.createPort('COM7');
            const other = new SerialPortMock({ path: 'COM7', baudRate: 115200, autoOpen: false });
            await new Promise<void>((resolve, reject) => other.open((err) => err ? reject(err) : resolve()));
            const serial = mockSerial();
            await assert.rejects(serial.controller.open({ path: 'COM7' }), (failure: unknown) =>
                failure instanceof ToolError && failure.code === 'PORT_HELD' && /Port is locked/.test(failure.message));
            await new Promise<void>((resolve) => other.close(() => resolve()));
        });

        test('a port already open in this window is PORT_HELD', async () => {
            const serial = mockSerial();
            await holdPort(serial, 'COM7', 'session-A', 'idle');
            SerialPortMock.binding.createPort('COM8');
            await assert.rejects(serial.controller.open({ path: 'COM8' }), (failure: unknown) =>
                failure instanceof ToolError && failure.code === 'PORT_HELD'
                    && failure.message === 'A serial port is already open on \'COM7\'. Close it first with serial_close.');
            assert.deepStrictEqual(serial.journaled, [], 'the agent\'s own port is no problem of the window');
        });
    });
});

/** One device as the OS keeps it: an open fails while a port still has it, and a close ends only when the test says. */
class LockedDevice {
    readonly ports: DevicePort[] = [];

    /** The controller's port factory: every port is one of this device. */
    readonly createPort = (): DevicePort => {
        const port = new DevicePort(this);
        this.ports.push(port);
        return port;
    };

    /** True from a port's open until its close has ended. */
    taken(): boolean {
        return this.ports.some((port) => port.hasDevice);
    }
}

/** A port of a `LockedDevice`, refused as serialport's `flock` refuses a second open on POSIX. */
class DevicePort extends ScriptedPort {
    hasDevice = false;
    private closing: (() => void) | undefined;

    constructor(private readonly device: LockedDevice) {
        super();
    }

    override open(callback: (err: Error | null) => void): void {
        if (this.device.taken()) {
            callback(new Error('Error Resource temporarily unavailable Cannot lock port'));
            return;
        }
        this.hasDevice = true;
        this.isOpen = true;
        callback(null);
    }

    override close(callback: (err: Error | null) => void): void {
        this.isOpen = false;
        this.closing = () => {
            this.hasDevice = false;
            callback(null);
        };
    }

    /** The driver ends the close: the device is free again. */
    endClose(): void {
        const closing = this.closing;
        this.closing = undefined;
        closing?.();
    }
}

/** Lets every callback and promise that is due run, the mock binding's next tick included. */
function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/** What became of each open: `opened`, or the message it failed with. */
function outcomes(settled: Array<PromiseSettledResult<number>>): string[] {
    return settled.map((outcome) => outcome.status === 'fulfilled' ? 'opened' : (outcome.reason as Error).message);
}

/**
 * Opens and closes take turns: several MCP sessions share the window's port,
 * and one that opens while another's open is in flight gets what it would
 * get once that open had ended, never a second device beside it. Mock ports,
 * whose open ends on the next tick, and a device the OS locks.
 */
suite('serial opens and closes take turns', () => {
    setup(() => SerialPortMock.binding.reset());
    teardown(() => SerialPortMock.binding.reset());

    test('two opens at once: the second waits for the first and is PORT_HELD, and only the first device is opened', async () => {
        const serial = mockSerial();
        SerialPortMock.binding.createPort('/dev/ttyACM0');
        SerialPortMock.binding.createPort('/dev/ttyACM1');
        const settled = await Promise.allSettled([
            serial.controller.open({ path: '/dev/ttyACM0' }, { owner: 'session-A', rule: 'idle', idleSeconds: 300 }),
            serial.controller.open({ path: '/dev/ttyACM1' }, { owner: 'session-B', rule: 'idle', idleSeconds: 300 }),
        ]);
        assert.deepStrictEqual(outcomes(settled), ['opened', 'A serial port is already open on \'/dev/ttyACM0\'. Close it first with serial_close.']);
        assert.ok(settled[1].status === 'rejected' && settled[1].reason instanceof ToolError && settled[1].reason.code === 'PORT_HELD');
        assert.deepStrictEqual(serial.ports.map((port) => port.path), ['/dev/ttyACM0'], 'the second device was never opened');
        assert.strictEqual(serial.controller.hold()?.owner, 'session-A');
        assert.strictEqual(serial.time.armed(), 1, 'one lease, one idle timer');
        assert.deepStrictEqual(serial.journaled, []);
        await serial.controller.close();
        assert.ok(serial.ports.every((port) => !port.isOpen), 'serial_close leaves no port open');
    });

    test('the same port opened twice at once is PORT_HELD for this window, not "another program holds it"', async () => {
        const serial = mockSerial();
        SerialPortMock.binding.createPort('COM7');
        const settled = await Promise.allSettled([serial.controller.open({ path: 'COM7' }), serial.controller.open({ path: 'COM7' })]);
        assert.deepStrictEqual(outcomes(settled), ['opened', 'A serial port is already open on \'COM7\'. Close it first with serial_close.']);
        assert.ok(settled[1].status === 'rejected' && settled[1].reason instanceof ToolError && settled[1].reason.hint === undefined);
        assert.strictEqual(serial.ports.length, 1);
        assert.deepStrictEqual(serial.journaled, [], 'the window\'s own port is no problem of the window');
    });

    test('an open that fails lets the next one have its turn', async () => {
        const serial = mockSerial();
        SerialPortMock.binding.createPort('COM7');
        SerialPortMock.binding.createPort('COM8');
        const settled = await Promise.allSettled([
            serial.controller.open({ path: '/dev/nope' }),
            serial.controller.open({ path: 'COM7' }),
            serial.controller.open({ path: 'COM8' }),
        ]);
        assert.deepStrictEqual(outcomes(settled), [
            'Port does not exist - please call MockBinding.createPort(\'/dev/nope\') first',
            'opened',
            'A serial port is already open on \'COM7\'. Close it first with serial_close.',
        ]);
        assert.strictEqual(serial.controller.hold()?.path, 'COM7');
        assert.deepStrictEqual(serial.journaled.map((problem) => problem.origin), ['/dev/nope'], 'only the failed open is journaled');
    });

    test('an open after serial_close or a rule\'s release waits until the device is let go', async () => {
        const device = new LockedDevice();
        const time = new ManualTime();
        const journaled: ProblemInput[] = [];
        const controller = new SerialController({
            createPort: device.createPort, clock: () => time.date(), timers: time, journal: (problem) => journaled.push(problem),
        });
        await controller.open({ path: 'COM7' });
        const closing = controller.close();
        const reopening = controller.open({ path: 'COM7' });
        await settle();
        assert.strictEqual(device.ports.length, 1, 'the open waits for the close');
        device.ports[0].endClose();
        assert.strictEqual(await closing, true);
        await reopening;

        assert.strictEqual(controller.releaseForUser(), 'COM7');
        const third = controller.open({ path: 'COM7' });
        await settle();
        assert.strictEqual(device.ports.length, 2, 'and for the close a release runs in the background');
        device.ports[1].endClose();
        await third;
        assert.deepStrictEqual(device.ports.map((port) => port.isOpen), [false, false, true]);
        assert.deepStrictEqual(journaled.map((problem) => problem.code), [undefined], 'the release only: no PORT_HELD');
    });

    test('a port that opens while the one before is still closing by itself holds the only lease', async () => {
        const time = new ManualTime();
        const ports: ScriptedPort[] = [];
        const controller = new SerialController({
            createPort: () => {
                const port = new ScriptedPort();
                ports.push(port);
                return port;
            },
            clock: () => time.date(), timers: time, journal: () => undefined,
        });
        await controller.open({ path: 'COM7' }, { owner: 'session-A', rule: 'idle', idleSeconds: 300 });
        ports[0].isOpen = false;    // closing by itself, as a stream is between its close and its 'close' event
        time.advanceSeconds(200);
        await controller.open({ path: 'COM8' }, { owner: 'session-A', rule: 'idle', idleSeconds: 300 });
        ports[0].emit('close', null);
        assert.strictEqual(time.armed(), 1, 'the first port\'s lease went with it');
        time.advanceSeconds(299);
        assert.strictEqual(controller.hold()?.path, 'COM8', 'the first port\'s idle limit does not release the second');
        time.advanceSeconds(1);
        assert.strictEqual(controller.status().lastRelease?.reason, 'idle', 'its own does');
    });
});
