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
import { SerialPort, SerialPortMock } from 'serialport';
import { runInCallContext } from '../core/callContext';
import type { ProblemInput } from '../core/problemJournal';
import { CAPTURE_HALF_BYTES, CaptureRecord, captureDurationMs, untilPattern } from '../core/serialCapture';
import { PORT_HELD_HINT, SerialController } from '../core/serialController';
import { BridgeExtension, SerialMonitorBridge } from '../core/serialMonitorBridge';
import { programmingNote, renderSerialHold, serialSessionLine } from '../core/serialText';
import { ToolError, ToolReply, ToolText, textOf } from '../core/toolResult';
import { SerialHandler } from '../serialHandler';
import { SerialStatus, releaseSerialPort } from '../serialStatus';
import {
    CONSUMER, FakeMonitorOptions, FakeSerialMonitor, ManualTime, MockSerial, PATH_FIXTURES, ScriptedPort, T0, fakeSerialMonitor, mockSerial,
} from './serialFixtures';

const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';

/** Run `work` as a tool call of MCP session `sessionId`, as the control server runs a forwarded op. */
function asSession<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return runInCallContext({ callId: `${sessionId.slice(0, 8)}-1`, sessionId }, work);
}

/**
 * A handler over mock ports, a hand-moved clock, a Serial Monitor (by default
 * one whose API has a data event) with the tests' extension context, and an
 * idle limit the test sets.
 */
interface World {
    serial: MockSerial;
    monitor: FakeSerialMonitor;
    bridge: SerialMonitorBridge;
    handler: SerialHandler;
    /** What the bridge journaled. */
    bridgeJournal: ProblemInput[];
    /** `serial.idleCloseSeconds` as the handler reads it at each open. */
    setIdle(seconds: number): void;
}

function world(options: FakeMonitorOptions = {}): World {
    const time = new ManualTime();
    const serial = mockSerial(time);
    const monitor = fakeSerialMonitor(options);
    const bridgeJournal: ProblemInput[] = [];
    const deps = { lookup: () => monitor.extension, consumer: CONSUMER, timers: time, journal: (problem: ProblemInput) => bridgeJournal.push(problem) };
    const bridge = new SerialMonitorBridge(deps);
    let idle = 300;
    const handler = new SerialHandler(serial.controller, { bridge, idleCloseSeconds: () => idle });
    return { serial, monitor, bridge, handler, bridgeJournal, setIdle: (seconds) => { idle = seconds; } };
}

/**
 * The serial handler under the release rules (#49): `serial_open` holds the
 * port for the calling MCP session under its `releaseOn`, the idle limit is
 * the setting at each open, `serial_status` names the holder and the rule,
 * and the end of a session releases the port and the Serial Monitor
 * subscription it held. Mock ports only.
 */
suite('SerialHandler release rules (#49)', () => {
    setup(() => SerialPortMock.binding.reset());
    teardown(() => SerialPortMock.binding.reset());

    test('serial_open holds the port for the calling session and says when it is released, per rule', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        const answers: string[] = [];
        for (const releaseOn of [undefined, 'debug-session-end', 'manual', 'sometime'] as const) {
            const opened = await asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7', releaseOn: releaseOn as never }));
            answers.push(opened.split('. ')[1]);
            assert.strictEqual(w.serial.controller.hold()?.owner, SESSION_A);
            await w.handler.handleClose();
        }
        w.setIdle(0);
        answers.push((await w.handler.handleOpen({ path: 'COM7' })).split('. ')[1]);
        assert.strictEqual(w.serial.controller.hold()?.owner, undefined, 'a call outside any session records no holder');
        assert.deepStrictEqual(answers, [
            'It is released after 300 s without a serial call, or when this MCP session ends',
            'It is released when the debug session in this window ends, or when this MCP session ends',
            'It stays open until serial_close, also after this MCP session ends',
            'It is released after 300 s without a serial call, or when this MCP session ends',
            'It is released when this MCP session ends (the idle release is off)',
        ]);
    });

    test('the idle limit is the setting at each open, so a change needs no reload', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        w.setIdle(60);
        await w.handler.handleOpen({ path: 'COM7' });
        w.setIdle(600);
        w.serial.time.advanceSeconds(60);
        assert.strictEqual(w.serial.controller.status().lastRelease?.reason, 'idle', 'the port opened under 60 s keeps 60 s');
        await w.handler.handleOpen({ path: 'COM7' });
        w.serial.time.advanceSeconds(599);
        assert.ok(w.serial.controller.isOpen());
        w.serial.time.advanceSeconds(1);
        assert.strictEqual(w.serial.controller.status().lastRelease?.idleSeconds, 600);
    });

    test('serial_status names the holder and the rule, as the asking session sees it', async () => {
        const w = world();
        SerialPortMock.binding.createPort('/dev/ttyACM0');
        await asSession(SESSION_A, () => w.handler.handleOpen({ path: '/dev/ttyACM0', baudRate: 921600 }));
        const clauseFor = async (sessionId: string | undefined): Promise<string> => {
            const status = sessionId ? await asSession(sessionId, () => w.handler.handleStatus()) : await w.handler.handleStatus();
            return status.split('\n')[0].replace(/^.*\); /, '');
        };
        assert.strictEqual(await clauseFor(SESSION_A), 'held by this session, released after 300 s without a serial call');
        assert.strictEqual(await clauseFor(SESSION_B), 'held by another MCP session (aaaaaaaa), released after 300 s without a serial call');
        await w.handler.handleClose();
        await w.handler.handleOpen({ path: '/dev/ttyACM0', releaseOn: 'manual' });
        assert.strictEqual(await clauseFor(SESSION_B), 'held by an unknown session, released only by serial_close');
    });

    test('the end of a session releases its port and its Serial Monitor subscription, and says so', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        await asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7' }));
        await asSession(SESSION_A, () => w.handler.handleSubscribeMonitor());
        assert.ok(w.monitor.listening());

        assert.strictEqual(await w.handler.sessionEnded(SESSION_B), 'MCP session bbbbbbbb ended: it held no serial port in this window.');
        assert.ok(w.serial.controller.isOpen() && w.monitor.listening(), 'another session\'s end changes nothing');
        assert.strictEqual(await w.handler.sessionEnded(SESSION_A),
            'MCP session aaaaaaaa ended: released COM7 and ended the Serial Monitor subscription.');
        assert.strictEqual(w.serial.controller.status().lastRelease?.reason, 'owner-gone');
        assert.ok(!w.monitor.listening());
        assert.strictEqual(await w.handler.sessionEnded(SESSION_A), 'MCP session aaaaaaaa ended: it held no serial port in this window.');
    });

    test('a manual port outlives its session; its Serial Monitor subscription does not', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        await asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7', releaseOn: 'manual' }));
        await asSession(SESSION_A, () => w.handler.handleSubscribeMonitor());
        assert.strictEqual(await w.handler.sessionEnded(SESSION_A), 'MCP session aaaaaaaa ended: ended the Serial Monitor subscription.');
        assert.ok(w.serial.controller.isOpen());
        w.serial.time.advanceSeconds(86_400);
        assert.ok(w.serial.controller.isOpen(), 'and never goes for idleness');
    });

    suite('the Serial Monitor subscription follows the same rules', () => {
        test('after the idle limit without a serial call it ends and drops its buffer', async () => {
            const w = world();
            await asSession(SESSION_A, () => w.handler.handleSubscribeMonitor());
            w.monitor.emit('hello');
            w.serial.time.advanceSeconds(200);
            assert.match(await w.handler.handleRead({ from: 'monitor', consume: false }), /5 byte\(s\) \(peek\)/);
            w.serial.time.advanceSeconds(299);
            assert.ok(w.monitor.listening(), 'the read restarted the idle time');
            await w.handler.handleStatus();
            w.serial.time.advanceSeconds(299);
            assert.ok(w.monitor.listening(), 'so did the status');
            w.serial.time.advanceSeconds(1);
            assert.ok(!w.monitor.listening());
            assert.strictEqual(await w.handler.handleRead({ from: 'monitor' }), 'Serial RX (monitor): <no data>', 'the buffer went with it');
            assert.deepStrictEqual(w.bridgeJournal.map((problem) => [problem.source, problem.origin, problem.severity, problem.message]),
                [['serial', 'Serial Monitor', 'info', 'Serial Monitor subscription ended after 300 s without a serial call']]);
        });

        test('the end of the session that subscribed ends it; an unsubscribe keeps the buffer as before', async () => {
            const w = world();
            await asSession(SESSION_B, () => w.handler.handleSubscribeMonitor());
            w.monitor.emit('abc');
            assert.strictEqual(await w.handler.handleUnsubscribeMonitor(), 'Unsubscribed from Serial Monitor data.');
            assert.match(await w.handler.handleRead({ from: 'monitor' }), /3 byte\(s\)/);
            assert.strictEqual(w.bridge.sessionEnded(SESSION_B), false, 'nothing left to end');
            await asSession(SESSION_B, () => w.handler.handleSubscribeMonitor());
            w.monitor.emit('xyz');
            assert.strictEqual(w.bridge.sessionEnded(SESSION_B), true);
            assert.strictEqual(await w.handler.handleRead({ from: 'monitor' }), 'Serial RX (monitor): <no data>');
            assert.strictEqual(w.bridgeJournal.at(-1)?.message, 'Serial Monitor subscription ended: the MCP session that subscribed ended');
        });
    });
});

/** A handler whose bridge finds `extension` (no Serial Monitor when undefined) and is handed `consumer`. */
function handlerOver(extension: BridgeExtension | undefined, consumer: typeof CONSUMER | undefined): SerialHandler {
    const deps = { lookup: () => extension, consumer };
    return new SerialHandler(mockSerial().controller, { bridge: new SerialMonitorBridge(deps), idleCloseSeconds: () => 300 });
}

/** The start of every refused `serial_subscribe_monitor`. */
const NOT_SUBSCRIBED = 'Could not subscribe to Serial Monitor data: ';

/**
 * The Serial Monitor's API as `ms-vscode.vscode-serial-monitor` hands it out:
 * its exports hold `getApi(version, context)`, the API is a class instance,
 * and the API of 0.13 has no data event. The bridge asks for version 0 with
 * the extension's context, once; `serial_status` lists the API's methods, a
 * subscription is refused with the reason, and a data event of the API is
 * subscribed when a build has one. `serial_list_ports` does not ask the API.
 */
suite('the Serial Monitor\'s API: getApi(version, context)', () => {
    test('the bridge asks getApi for version 0 with the extension context, once, and subscribes to the data event of the API', async () => {
        const w = world();
        assert.match(await asSession(SESSION_A, () => w.handler.handleSubscribeMonitor()), /^Subscribed to MS Serial Monitor data via 'onDidReceiveData'\./);
        w.monitor.emit('boot ok\n');
        assert.strictEqual(await w.handler.handleRead({ from: 'monitor' }), 'Serial RX (monitor): 8 byte(s)\n--- text ---\nboot ok\n');
        await w.handler.handleStatus();
        assert.deepStrictEqual(w.monitor.requests, [{ version: 0, consumer: CONSUMER }]);
    });

    test('the API of 0.13 has no data event: the subscription is refused with what to do, serial_status lists its methods', async () => {
        const w = world({ dataEvent: false });
        assert.strictEqual(await w.handler.handleSubscribeMonitor(), `${NOT_SUBSCRIBED}The Serial Monitor's API (version 0) has no data event: `
            + 'it lists ports and starts or stops monitoring, but does not pass on what it receives. Ask the user to stop monitoring '
            + 'the port in the Serial Monitor, then read it with serial_capture or serial_open.');
        assert.ok(!w.monitor.listening());
        assert.deepStrictEqual((await w.handler.handleStatus()).split('\n').slice(1), [
            'Serial Monitor bridge: extension installed, activated, data-subscription unavailable in this build, not subscribed',
            '  API keys: listAvailablePorts, startMonitoringPort, stopMonitoringPort, startMonitoringTCPConnection, '
            + 'stopMonitoringTCPConnection, clearOutput, dispose',
        ]);
    });

    test('an inactive Serial Monitor is activated once, for the subscription; serial_status leaves it inactive', async () => {
        const w = world({ active: false, dataEvent: false });
        assert.match(await w.handler.handleStatus(), /Serial Monitor bridge: extension installed, inactive, /);
        assert.deepStrictEqual([w.monitor.activations(), w.monitor.requests.length], [0, 0]);
        await w.handler.handleSubscribeMonitor();
        await w.handler.handleSubscribeMonitor();
        assert.deepStrictEqual([w.monitor.activations(), w.monitor.requests], [1, [{ version: 0, consumer: CONSUMER }]]);
    });

    test('a refusal says why the Serial Monitor gave no API; without a context it is neither activated nor asked', async () => {
        assert.strictEqual(await handlerOver(undefined, CONSUMER).handleSubscribeMonitor(),
            `${NOT_SUBSCRIBED}Extension 'ms-vscode.vscode-serial-monitor' is not installed or failed to activate.`);
        const failed: BridgeExtension = { isActive: true, exports: undefined, activate: async () => undefined };
        assert.strictEqual(await handlerOver(failed, CONSUMER).handleSubscribeMonitor(),
            `${NOT_SUBSCRIBED}Extension 'ms-vscode.vscode-serial-monitor' exports no getApi(version, context): `
            + 'it failed to activate, or this build has no API.');
        const later = fakeSerialMonitor({ apiVersion: 1 });
        assert.strictEqual(await handlerOver(later.extension, CONSUMER).handleSubscribeMonitor(),
            `${NOT_SUBSCRIBED}The Serial Monitor refused API version 0: Invalid Serial Monitor API version.`);
        const inactive = fakeSerialMonitor({ active: false });
        assert.strictEqual(await handlerOver(inactive.extension, undefined).handleSubscribeMonitor(),
            `${NOT_SUBSCRIBED}The Serial Monitor bridge has no extension context yet; try again once the extension has activated.`);
        assert.deepStrictEqual([inactive.activations(), inactive.requests.length], [0, 0]);
    });

    test('serial_list_ports lists what serialport finds, friendly name and serial number included, and leaves the Serial Monitor alone', async () => {
        const w = world({ active: false });
        const windows = {
            path: 'COM7', friendlyName: 'USB Serial Device (COM7)', manufacturer: 'Microsoft', serialNumber: '0240000034544e45',
            pnpId: 'USB\\VID_0D28&PID_0204&MI_01\\0240000034544e45', locationId: undefined, vendorId: '0D28', productId: '0204',
        };
        const mac = {
            path: '/dev/cu.usbmodem1102', manufacturer: 'ARM', serialNumber: '0240000034544e45',
            pnpId: undefined, locationId: '01100000', vendorId: '0d28', productId: '0204',
        };
        const list = SerialPort.list;
        SerialPort.list = async () => [windows, mac];
        try {
            assert.strictEqual(await w.handler.handleListPorts(), [
                'Available serial ports (2, via serialport):',
                '  COM7  — USB Serial Device (COM7) / Microsoft / 0240000034544e45 [VID:PID 0D28:0204]',
                '  /dev/cu.usbmodem1102  — ARM / 0240000034544e45 [VID:PID 0d28:0204]',
            ].join('\n'));
        } finally {
            SerialPort.list = list;
        }
        assert.deepStrictEqual([w.monitor.activations(), w.monitor.requests.length], [0, 0], 'the Serial Monitor was left alone');
    });
});

/** The reply of a capture, which always carries a status. */
function asReply(result: ToolText): ToolReply {
    assert.ok(typeof result !== 'string', `a capture answers with a reply, not: ${textOf(result)}`);
    return result;
}

/**
 * `serial_capture` (#49): one call opens the port, reads until a match or the
 * deadline, and closes it again in every case — a match, the deadline, a read
 * that throws, a port that goes away — and refuses before touching a port
 * when the regex is invalid or the slot is taken. Mock ports that echo what
 * is written stand in for the board.
 */
suite('serial_capture (#49)', () => {
    setup(() => SerialPortMock.binding.reset());
    teardown(() => SerialPortMock.binding.reset());

    /** A handler over mock ports whose device echoes what is written, like a board's shell. */
    function echoing(path: string): { serial: MockSerial; handler: SerialHandler } {
        SerialPortMock.binding.createPort(path, { echo: true });
        const serial = mockSerial();
        return { serial, handler: new SerialHandler(serial.controller, { idleCloseSeconds: () => 300 }) };
    }

    test('it stops at the first match of until and closes the port, for every path spelling', async () => {
        for (const path of PATH_FIXTURES) {
            const { serial, handler } = echoing(path);
            const reply = asReply(await asSession(SESSION_A, () =>
                handler.handleCapture({ path, write: 'version\nREADY\n', until: 'READY', durationMs: 10_000 })));
            assert.strictEqual(reply.status, 'ok', path);
            assert.match(reply.text, new RegExp(`^Captured 14 B from ${path.replace(/[\\.]/g, '\\$&')} in \\d+\\.\\d s after writing 14 B \\(matched /READY/\\)\\. Port closed\\.\\n--- text ---\\nversion\\nREADY\\n$`));
            assert.deepStrictEqual({ ...reply.data, elapsedMs: 0 },
                { path, bytes: 14, elapsedMs: 0, stop: 'match', omittedBytes: 0, written: 14 });
            assert.ok((reply.data?.elapsedMs as number) < 5_000, 'stopped at the match, not at the deadline');
            const status = serial.controller.status();
            assert.deepStrictEqual([status.open, status.lastRelease, status.bufferedBytes], [false, null, 0], `${path} is free again`);
        }
    });

    test('without a match it stops at the deadline: ok without until, timeout with it', async () => {
        const { serial, handler } = echoing('COM7');
        const quiet = asReply(await handler.handleCapture({ path: 'COM7', durationMs: 150 }));
        assert.strictEqual(quiet.status, 'ok');
        assert.match(quiet.text, /^Captured 0 B from COM7 in 0\.\d s \(deadline\)\. Port closed\.\nNothing arrived\. Check baudRate; /);
        const missed = asReply(await handler.handleCapture({ path: 'COM7', durationMs: 150, until: '/ready/i', write: 'boot\n' }));
        assert.strictEqual(missed.status, 'timeout');
        assert.match(missed.text, /^Captured 5 B from COM7 in 0\.\d s after writing 5 B \(deadline; \/ready\/i not seen\)\. Port closed\.\n--- text ---\nboot\n$/);
        assert.ok(!serial.controller.isOpen());
    });

    test('a read that throws still closes the port', async () => {
        SerialPortMock.binding.createPort('/dev/ttyACM0');
        const serial = mockSerial();
        class FailingRead extends SerialController {
            override read(): Promise<Buffer> {
                return Promise.reject(new Error('EIO: read failed'));
            }
        }
        const failing = new FailingRead({
            createPort: (options) => new SerialPortMock(options), clock: () => serial.time.date(), timers: serial.time, journal: () => undefined,
        });
        const handler = new SerialHandler(failing, { idleCloseSeconds: () => 300 });
        await assert.rejects(handler.handleCapture({ path: '/dev/ttyACM0', durationMs: 1_000 }), /EIO: read failed/);
        assert.strictEqual(failing.isOpen(), false);
        assert.strictEqual(failing.hold(), undefined);
    });

    test('an invalid until is INVALID_ARGUMENT before any port is touched', async () => {
        const { serial, handler } = echoing('COM7');
        await assert.rejects(handler.handleCapture({ path: 'COM7', until: '(unclosed', durationMs: 1_000 }), (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'INVALID_ARGUMENT' && /^until is not a valid regular expression: /.test(failure.message));
        assert.deepStrictEqual(serial.ports, [], 'no port was even created: opening it could reset the board through DTR');
    });

    test('a port the window holds already is PORT_HELD, and that port is left alone', async () => {
        const { serial, handler } = echoing('COM7');
        SerialPortMock.binding.createPort('COM8');
        await asSession(SESSION_A, () => handler.handleOpen({ path: 'COM7' }));
        await assert.rejects(asSession(SESSION_B, () => handler.handleCapture({ path: 'COM8', durationMs: 1_000 })), (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'PORT_HELD'
                && failure.message === 'COM7 is open in this window (held by another MCP session (aaaaaaaa)), so serial_capture cannot take the port.'
                && failure.hint === 'serial_read {waitMs} reads the open port; serial_close it to use serial_capture.');
        assert.strictEqual(serial.controller.hold()?.path, 'COM7');
        assert.strictEqual(serial.ports.length, 1);
    });

    test('a port another program holds is PORT_HELD, and nothing stays open', async () => {
        const controller = new SerialController({ createPort: () => new ScriptedPort('Opening COM7: Access denied'), journal: () => undefined });
        const handler = new SerialHandler(controller, { idleCloseSeconds: () => 300 });
        await assert.rejects(handler.handleCapture({ path: 'COM7', durationMs: 1_000 }), (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'PORT_HELD' && failure.hint === PORT_HELD_HINT);
        assert.strictEqual(controller.isOpen(), false);
    });

    test('serial_status shows the capture while it runs; an unplug ends it with the reason', async () => {
        const { serial, handler } = echoing('COM7');
        const capture = asSession(SESSION_A, () => handler.handleCapture({ path: 'COM7', durationMs: 10_000 }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        const status = await asSession(SESSION_A, () => handler.handleStatus());
        assert.match(status.split('\n')[0], /^Owned serial: OPEN on COM7 @ 115200 baud, .*; held by this session, serial_capture running$/);
        serial.ports[0].port?.emitData(Buffer.from('partial'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        serial.ports[0]._disconnected(new Error('EIO: i/o error, read'));
        const reply = asReply(await capture);
        assert.strictEqual(reply.status, 'ok');
        assert.match(reply.text, /^Captured 7 B from COM7 in \d+\.\d s \(COM7 disconnected at 10:42:07\)\. Port closed\.\n--- text ---\npartial$/);
        assert.ok((reply.data?.elapsedMs as number) < 5_000);
        assert.strictEqual(reply.data?.stop, 'closed');
    });

    test('the answer keeps the first and the last 8 kB and counts the bytes between', async () => {
        const { handler } = echoing('COM7');
        const body = `BEGIN${'x'.repeat(40_000)}END`;
        const reply = asReply(await handler.handleCapture({ path: 'COM7', write: body, until: 'END$', durationMs: 20_000 }));
        const [first, marker, head, omitted, tail] = reply.text.split('\n');
        assert.match(first, /^Captured 40008 B from COM7 .* \(matched \/END\$\/\)\. Port closed\. Showing the first and the last 8 kB\.$/);
        assert.strictEqual(marker, '--- text ---');
        assert.ok(head.startsWith('BEGIN') && head.length === CAPTURE_HALF_BYTES);
        assert.strictEqual(omitted, `… ${40_008 - 2 * CAPTURE_HALF_BYTES} bytes omitted …`);
        assert.ok(tail.endsWith('END') && tail.length === CAPTURE_HALF_BYTES);
        assert.ok(Buffer.byteLength(reply.text) < 17_000, `${Buffer.byteLength(reply.text)} bytes`);
        assert.strictEqual(reply.data?.omittedBytes, 40_008 - 2 * CAPTURE_HALF_BYTES);
    });

    suite('the capture record', () => {
        test('the cut never splits a character', () => {
            const record = new CaptureRecord();
            const euro = '€';   // three bytes in UTF-8
            record.append(Buffer.from(euro.repeat(10_000)));
            const excerpt = record.excerpt();
            assert.ok(!excerpt.head.includes('\uFFFD') && !(excerpt.tail ?? '').includes('\uFFFD'));
            assert.strictEqual(Buffer.byteLength(excerpt.head) + excerpt.omitted + Buffer.byteLength(excerpt.tail ?? ''), 30_000);
        });

        test('a match is looked for in the newest bytes and the 8 kB before them, however long the capture', () => {
            const record = new CaptureRecord();
            record.append(Buffer.from('MARK'));
            record.append(Buffer.from('y'.repeat(20_000)));
            assert.ok(record.searchText(20_000).includes('MARK'), 'the 8 kB before the new bytes reach back to it');
            assert.ok(!record.searchText(10).includes('MARK'), 'the window behind a small chunk does not');
            record.append(Buffer.from('z'.repeat(2 * 1024 * 1024)));
            assert.strictEqual(record.bytes, 4 + 20_000 + 2 * 1024 * 1024);
            const excerpt = record.excerpt();
            assert.ok(excerpt.head.startsWith('MARK') && (excerpt.tail ?? '').endsWith('z'));
            assert.strictEqual(record.searchText(10).length, 8 * 1024 + 10);
        });

        test('until: a plain pattern or /source/flags; g and y are dropped; the length is kept in range', () => {
            assert.strictEqual(untilPattern(undefined), undefined);
            assert.strictEqual(untilPattern(''), undefined);
            assert.strictEqual(String(untilPattern('READY')), '/READY/');
            assert.strictEqual(String(untilPattern('/boot (ok|done)/gi')), '/boot (ok|done)/i');
            assert.deepStrictEqual([50, 100, 3_000.4, 60_000, 90_000, Number.NaN, undefined].map(captureDurationMs),
                [100, 100, 3_000, 60_000, 60_000, 100, 100]);
        });
    });
});

/**
 * What agents and people are told about a held port (#49): the line of
 * get_session_status, the note of the programming tools, and the status-bar
 * item with its Release command.
 */
suite('the human handle and what agents are told (#49)', () => {
    setup(() => SerialPortMock.binding.reset());
    teardown(() => SerialPortMock.binding.reset());

    /** A mock controller holding COM7 under `rule` with an idle limit of 300 s, for session A or, with `null`, for no session. */
    async function holding(rule: 'idle' | 'debug-session-end' | 'manual', owner: string | null = SESSION_A): Promise<MockSerial> {
        SerialPortMock.binding.createPort('COM7');
        const serial = mockSerial();
        await serial.controller.open({ path: 'COM7', baudRate: 921600 }, { owner: owner ?? undefined, rule, idleSeconds: 300 });
        return serial;
    }

    test('get_session_status: the held port with its holder and state, or why it was released, or nothing', async () => {
        const idle = await holding('idle');
        assert.strictEqual(serialSessionLine(idle.controller, SESSION_B), 'Serial: COM7 open (another MCP session (aaaaaaaa), idle 0 s of 300 s)');
        idle.time.advanceSeconds(42);
        assert.strictEqual(serialSessionLine(idle.controller, SESSION_A), 'Serial: COM7 open (this session, idle 42 s of 300 s)');
        await idle.controller.sessionEnded(SESSION_A);
        assert.strictEqual(serialSessionLine(idle.controller, SESSION_A),
            'Serial: COM7 released at 10:42:49: the MCP session that opened it ended');
        await idle.controller.close();
        SerialPortMock.binding.reset();
        const lines: Array<string | undefined> = [];
        for (const rule of ['debug-session-end', 'manual'] as const) {
            const serial = await holding(rule, null);
            lines.push(serialSessionLine(serial.controller, SESSION_A));
            await serial.controller.close();
            assert.strictEqual(serialSessionLine(serial.controller, SESSION_A), undefined, 'closed on purpose: nothing to say');
            SerialPortMock.binding.reset();
        }
        assert.deepStrictEqual(lines, [
            'Serial: COM7 open (an unknown session, released when the debug session ends)',
            'Serial: COM7 open (an unknown session, released only by serial_close)',
        ]);
    });

    test('flash and cmsis_action: a note while the port is held, the reason when it went during programming', async () => {
        const serial = await holding('idle');
        assert.strictEqual(programmingNote('COM7', serial.controller),
            'COM7 is open in this window; if the probe\'s VCP re-enumerates during programming, reopen it.');
        serial.ports[0]._disconnected(new Error('EIO'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(programmingNote('COM7', serial.controller),
            'COM7 disconnected at 10:42:07, during programming. Reopen it with serial_open.');
        assert.strictEqual(programmingNote('COM8', serial.controller), undefined, 'another port: nothing to say');
        await serial.controller.open({ path: 'COM7' });
        await serial.controller.close();
        assert.strictEqual(programmingNote('COM7', serial.controller), undefined, 'closed on purpose: nothing to say');
    });

    test('the status-bar item: text and tooltip per rule', async () => {
        const serial = await holding('idle');
        serial.time.advanceSeconds(120);
        const hold = serial.controller.hold();
        assert.ok(hold);
        assert.deepStrictEqual(renderSerialHold(hold, T0 + 120_000), {
            text: '$(plug) Serial: COM7 (agent)',
            tooltip: [
                'CMSIS Developer Assistant: an agent holds COM7.',
                '921600 baud, open since 10:42:07 (2 min)',
                'Owner: MCP session aaaaaaaa',
                'Released: after 300 s without a serial call (in 3 min), or when the agent\'s session ends',
                '',
                'Click to release it for the Serial Monitor or a terminal.',
            ].join('\n'),
        });
        await serial.controller.close();
        SerialPortMock.binding.reset();
        const released: string[] = [];
        for (const rule of ['debug-session-end', 'manual'] as const) {
            const other = await holding(rule, null);
            const view = renderSerialHold(other.controller.hold()!, T0);
            released.push(view.tooltip.split('\n').slice(2, 4).join(' | '));
            await other.controller.close();
            SerialPortMock.binding.reset();
        }
        assert.deepStrictEqual(released, [
            'Owner: an unknown session | Released: when the debug session in this window ends, or when the agent\'s session ends',
            'Owner: an unknown session | Released: only when the agent closes it (releaseOn manual)',
        ]);
    });

    test('the item shows while a port is held and hides when it goes; Release Serial Port releases it for the user', async () => {
        SerialPortMock.binding.createPort('COM7');
        const serial = mockSerial();
        const item = new SerialStatus(serial.controller, () => serial.time.now());
        try {
            assert.strictEqual(item.view(), undefined);
            await serial.controller.open({ path: 'COM7' }, { owner: SESSION_A, rule: 'manual' });
            assert.strictEqual(item.view()?.text, '$(plug) Serial: COM7 (agent)');
            assert.strictEqual(releaseSerialPort(serial.controller), 'COM7');
            assert.strictEqual(item.view(), undefined);
            assert.strictEqual(serial.controller.status().lastRelease?.reason, 'user');
            assert.deepStrictEqual(serial.journaled.map((problem) => [problem.severity, problem.message]),
                [['warning', 'COM7 released at 10:42:07 by the user in VS Code']]);
            assert.strictEqual(releaseSerialPort(serial.controller), undefined, 'nothing held: nothing released');
        } finally {
            item.dispose();
        }
    });
});

/**
 * Calls that arrive while `serial_open` is still opening the port, from
 * another MCP session or as the session ends: each waits for the open and
 * then answers as it would once the port was open. Mock ports, whose open
 * ends on the next tick.
 */
suite('serial calls while serial_open is in flight', () => {
    setup(() => SerialPortMock.binding.reset());
    teardown(() => SerialPortMock.binding.reset());

    test('serial_close closes the port once it is open, and says so', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        const opened = asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7' }));
        const closed = asSession(SESSION_B, () => w.handler.handleClose());
        assert.match(await opened, /^Owned serial port opened: COM7 @ 115200 baud\. /);
        assert.strictEqual(await closed, 'Owned serial port closed.');
        assert.ok(!w.serial.controller.isOpen() && w.serial.ports.every((port) => !port.isOpen), 'no port stays open');
        assert.strictEqual(w.serial.time.armed(), 0, 'nor its idle timer');
    });

    test('the end of the session that is opening the port releases it once it is open', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        const opened = asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7', releaseOn: 'debug-session-end' }));
        const ended = w.handler.sessionEnded(SESSION_A);
        assert.match(await opened, /^Owned serial port opened: COM7 @ 115200 baud\. /);
        assert.strictEqual(await ended, 'MCP session aaaaaaaa ended: released COM7.');
        assert.strictEqual(w.serial.controller.status().lastRelease?.reason, 'owner-gone');
    });

    test('serial_capture is refused as when the port was open already, and opens nothing', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        SerialPortMock.binding.createPort('COM8');
        const opened = asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7' }));
        const capture = asSession(SESSION_B, () => w.handler.handleCapture({ path: 'COM8', durationMs: 1_000 }));
        await opened;
        await assert.rejects(capture, (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'PORT_HELD'
                && failure.message === 'COM7 is open in this window (held by another MCP session (aaaaaaaa)), so serial_capture cannot take the port.'
                && failure.hint === 'serial_read {waitMs} reads the open port; serial_close it to use serial_capture.');
        assert.deepStrictEqual(w.serial.ports.map((port) => port.path), ['COM7']);
        assert.strictEqual(w.serial.controller.hold()?.owner, SESSION_A);
    });
});
