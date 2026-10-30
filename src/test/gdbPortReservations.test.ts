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

/** Atomic reservation, lifecycle and synchronized independent-controller regressions. */

import * as assert from 'assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { GdbPortReservations } from '../core/gdbPortReservations';
import { ToolError } from '../core/toolResult';

const START = { what: 'launch' as const, subject: 'Test launch not started', configuration: 'Test GDB' };
const CLAIM = { port: 3333, source: 'session' as const, label: 'Test GDB' };

/** One controller message, bounded even if a child fails before its IPC reply. */
function message(child: ChildProcess, command?: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            clearTimeout(timer);
            child.off('message', received);
            child.off('error', failed);
            child.off('exit', exited);
        };
        const received = (value: unknown): void => { cleanup(); resolve(value as Record<string, unknown>); };
        const failed = (error: Error): void => { cleanup(); reject(error); };
        const exited = (code: number | null): void => { cleanup(); reject(new Error(`Controller exited before reply (${code})`)); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Controller did not answer within 5 seconds')); }, 5_000);
        child.once('message', received);
        child.once('error', failed);
        child.once('exit', exited);
        if (command !== undefined) {
            child.send(command);
        }
    });
}

/** A dummy server chooses a currently unused port; no target/probe connection is made. */
async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

suite('GDB port reservations', () => {
    let directory: string;
    const managers: GdbPortReservations[] = [];
    const manager = (pid = process.pid, alive?: (pid: number) => boolean): GdbPortReservations => {
        const result = new GdbPortReservations(directory, pid, alive);
        managers.push(result);
        return result;
    };
    const busy = (work: () => unknown): void => {
        assert.throws(work, (error: unknown) => error instanceof ToolError && error.code === 'PROBE_BUSY');
    };
    setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-port-reservation-')); });
    teardown(() => {
        for (const item of managers.splice(0)) {
            item.dispose();
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('only one window owns a port, and a failed start can release it without touching other ports', () => {
        const a = manager();
        const b = manager();
        const lease = a.acquire(3333, START, 'first');
        const other = a.acquire(3334, START, 'first');
        busy(() => b.acquire(3333, START, 'second'));
        lease.release();
        const replacement = b.acquire(3333, START, 'second');
        lease.release();
        busy(() => a.acquire(3333, START, 'first'));
        busy(() => b.acquire(3334, START, 'second'));
        replacement.release();
        other.release();
        assert.deepStrictEqual(fs.readdirSync(directory), []);
    });

    test('pending launches do not expire with an empty status; adopted ports release when their session/task ends', () => {
        const a = manager();
        const b = manager();
        a.acquire(3333, START, 'first');
        a.observe([]);
        busy(() => b.acquire(3333, START, 'second'));
        a.observe([CLAIM]);
        busy(() => b.acquire(3333, START, 'second'));
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        a.acquire(3333, START, 'first');
        a.observe([{ ...CLAIM, source: 'cmsis-run' }]);
        a.observe([]);
        b.acquire(3333, START, 'second').release();
    });

    test('shutdown releases only this manager; an observed dead process is reclaimed without stale release deleting its successor', () => {
        const a = manager(123456, () => true);
        const stale = a.acquire(3333, START, 'dead');
        const b = manager(process.pid, (pid) => pid !== 123456);
        const replacement = b.acquire(3333, START, 'live');
        stale.release();
        busy(() => b.acquire(3333, START, 'live'));
        replacement.release();
        a.acquire(3334, START, 'first');
        b.acquire(3333, START, 'second');
        a.dispose();
        busy(() => manager().acquire(3333, START, 'third'));
        b.dispose();
        assert.deepStrictEqual(fs.readdirSync(directory), []);
    });

    test('alternative launch configurations form one lifecycle batch; unselected ports are freed when the chosen session ends', () => {
        const a = manager();
        const b = manager();
        a.acquire(3333, START, 'first', 'one-launch');
        a.acquire(4444, { ...START, configuration: 'Alternative' }, 'first', 'one-launch');
        a.observe([CLAIM]);
        busy(() => b.acquire(4444, START, 'second'));
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        b.acquire(4444, START, 'second').release();
        assert.deepStrictEqual(fs.readdirSync(directory), []);
    });

    test('an older asynchronous observation cannot adopt or release a newer pending launch', () => {
        const a = manager();
        const b = manager();
        const beforeStart = a.observationVersion();
        a.acquire(3333, START, 'first');
        a.observe([CLAIM], beforeStart);
        a.observe([]);
        busy(() => b.acquire(3333, START, 'second'));
        const afterStart = a.observationVersion();
        a.observe([CLAIM], afterStart);
        a.observe([]);
        b.acquire(3333, START, 'second').release();
    });

    test('a verified start adopts its batch without a positive port sample; older empty samples cannot release it', () => {
        const a = manager();
        const b = manager();
        const lease = a.acquire(3333, START, 'first', 'one-launch');
        a.acquire(4444, START, 'first', 'one-launch');
        const beforeConfirmation = a.observationVersion();
        lease.adopt();
        a.observe([], beforeConfirmation);
        busy(() => b.acquire(3333, START, 'second'));
        busy(() => b.acquire(4444, START, 'second'));
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        b.acquire(4444, START, 'second').release();
    });

    /**
     * Tester feedback on preview 4: a load_and_debug with a short timeoutMs answered `running`, its
     * session ended before any port sample saw it live, and the reservation stayed until the window closed.
     */
    test('a session that begins on a reserved port adopts its batch; its end releases it without any positive port sample', () => {
        const a = manager();
        const b = manager();
        a.acquire(3333, START, 'first', 'one-launch');
        a.acquire(4444, START, 'first', 'one-launch');
        a.acquire(5555, START, 'first', 'another-launch');
        const beforeBegin = a.observationVersion();
        a.adoptPort(3333);
        a.adoptPort(6666);
        a.observe([], beforeBegin);
        busy(() => b.acquire(3333, START, 'second'));
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        b.acquire(4444, START, 'second').release();
        busy(() => b.acquire(5555, START, 'second'));
    });

    test('invalid ports and malformed ownership fail closed; staging records are not left behind', () => {
        const a = manager();
        for (const port of [0, -1, 65536, 1.5, NaN]) {
            assert.throws(() => a.acquire(port, START, 'a'), /Invalid GDB port/);
        }
        const claimed = path.join(directory, 'port-3333');
        fs.mkdirSync(claimed);
        fs.writeFileSync(path.join(claimed, 'owner-dead.json'), '{}');
        assert.throws(() => a.acquire(3333, START, 'a'), /invalid owner record/);
        assert.deepStrictEqual(fs.readdirSync(directory), ['port-3333']);
    });

    test('an unsafe reservation directory is not followed', function () {
        if (process.platform === 'win32') {
            this.skip();
        }
        const linked = path.join(directory, 'link');
        fs.symlinkSync(directory, linked, 'dir');
        const a = new GdbPortReservations(linked);
        assert.throws(() => a.acquire(3333, START, 'a'), /symbolic link/);
        assert.deepStrictEqual(fs.readdirSync(directory), ['link']);
        const throughParent = new GdbPortReservations(path.join(linked, 'reservations'), process.pid, undefined, linked);
        assert.throws(() => throughParent.acquire(3333, START, 'a'), /symbolic link/);
        assert.deepStrictEqual(fs.readdirSync(directory), ['link'], 'a refused registry root cannot be bypassed by creating a child');
    });

    test('two synchronized independent processes cannot both preflight and start a server', async function () {
        this.timeout(15_000);
        const port = await freePort();
        const program = `
            require(${JSON.stringify(path.resolve(__dirname, '../../../test/transport/vscode-stub.js'))});
            const { GdbPortReservations } = require(${JSON.stringify(require.resolve('../core/gdbPortReservations'))});
            const { findGdbPortHolder } = require(${JSON.stringify(require.resolve('../core/gdbPortGuard'))});
            const net = require('node:net');
            const manager = new GdbPortReservations(${JSON.stringify(directory)});
            let lease, server;
            let preflights = 0;
            process.on('message', async command => {
                try {
                    if (command === 'acquire') {
                        lease = manager.acquire(${port}, ${JSON.stringify(START)}, 'controller-' + process.pid);
                        preflights++;
                        if (await findGdbPortHolder(${port}, [])) throw new Error('Port is already listening');
                        process.send({ state: 'reserved', preflights });
                    } else if (command === 'listen') {
                        if (!lease) throw new Error('No reservation');
                        server = net.createServer();
                        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(${port}, '127.0.0.1', resolve); });
                        process.send({ state: 'listening' });
                    } else if (command === 'release') {
                        if (server) await new Promise(resolve => server.close(resolve));
                        manager.dispose();
                        process.send({ state: 'released' });
                    }
                } catch (error) {
                    process.send({ state: 'refused', code: error.code, message: error.message, preflights });
                }
            });
            process.send({ state: 'ready' });
        `;
        const children = [0, 1].map(() => spawn(process.execPath, ['-e', program], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        }));
        try {
            await Promise.all(children.map((child) => message(child)));
            const replies = await Promise.all(children.map((child) => message(child, 'acquire')));
            assert.strictEqual(replies.filter((reply) => reply.state === 'reserved').length, 1, JSON.stringify(replies));
            const winner = replies.findIndex((reply) => reply.state === 'reserved');
            const loser = 1 - winner;
            assert.strictEqual(replies[loser].code, 'PROBE_BUSY');
            assert.strictEqual(replies[loser].preflights, 0, 'the losing process is refused before probing or connecting');
            assert.strictEqual((await message(children[winner], 'listen')).state, 'listening');
            assert.strictEqual((await message(children[loser], 'acquire')).code, 'PROBE_BUSY');
            assert.strictEqual((await message(children[winner], 'release')).state, 'released');
            assert.strictEqual((await message(children[loser], 'acquire')).state, 'reserved');
            await message(children[loser], 'release');
        } finally {
            await Promise.all(children.map((child) => new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) {
                    resolve();
                } else {
                    child.once('exit', () => resolve());
                    child.kill();
                }
            })));
        }
    });
});
