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
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as net from 'net';
import {
    BusyTable,
    LagMonitor,
    NoticeGate,
    RouterWatch,
    busyCallsOf,
    busyText,
    lagText,
    portAnswers,
    portSilent,
    secondsText,
} from '../core/windowHealth';

/**
 * What a window knows about its own health (#14): the busy table, the
 * event-loop lag, the notice gate and the seconds in messages.
 */
suite('Window health', () => {

    test('the busy table keeps each run until it ends, fenced or not, oldest first, with a ticket of its own', () => {
        let now = 1_000;
        const busy = new BusyTable(() => now);
        const first = busy.begin('handleCmsisCommand', 'abcd1234-1');
        now = 2_000;
        const second = busy.begin('handleCmsisCommand');
        assert.notStrictEqual(first.ticket, second.ticket);
        assert.deepStrictEqual(busy.list().map((run) => [run.op, run.startedAt, run.fenced]),
            [['handleCmsisCommand', 1_000, false], ['handleCmsisCommand', 2_000, false]]);
        assert.strictEqual(first.callId, 'abcd1234-1');
        now = 5_000;
        busy.fence(first);
        assert.deepStrictEqual([first.fenced, first.fencedAt], [true, 5_000]);
        assert.strictEqual(busy.list().length, 2, 'a fenced run stays until it settles');
        busy.end(first);
        busy.end(first);
        assert.deepStrictEqual(busy.list(), [second]);
    });

    test('the notice gate lets one notice per key through in its window', () => {
        const gate = new NoticeGate(600_000);
        assert.strictEqual(gate.allow('start_debugging', 0), true);
        assert.strictEqual(gate.allow('start_debugging', 599_999), false);
        assert.strictEqual(gate.allow('stop_debugging', 1), true, 'every key has its own window');
        assert.strictEqual(gate.allow('start_debugging', 600_000), true);
        assert.strictEqual(gate.allow('start_debugging', 600_001), false, 'the window counts from the notice that passed');
    });

    test('seconds in messages: one decimal below 10 s, whole seconds above', () => {
        assert.deepStrictEqual([0, 350, 2_000, 9_940, 10_000, 190_000, 194_600, -5].map(secondsText),
            ['0 s', '0.4 s', '2 s', '9.9 s', '10 s', '190 s', '195 s', '0 s']);
    });

    test('the lag monitor reports a blocked event loop, and starts over on reset', async () => {
        const lag = new LagMonitor();
        try {
            await new Promise((wake) => setTimeout(wake, 60));
            const blockedUntil = Date.now() + 250;
            while (Date.now() < blockedUntil) {
                // The event loop is blocked, as by a synchronous call in the extension host.
            }
            await new Promise((wake) => setTimeout(wake, 60));
            const figures = lag.read();
            assert.ok(figures.max >= 150, `max ${figures.max} ms after a 250 ms block`);
            assert.ok(figures.p99 <= figures.max);
            lag.reset();
            assert.deepStrictEqual(lag.read(), { p99: 0, max: 0 });
        } finally {
            lag.dispose();
        }
    });

    test('the registry lists the calls busy for 10 s by tool, and names them with their age', () => {
        const busy = new BusyTable(() => 1_000);
        const build = busy.begin('handleCmsisCommand');
        busy.begin('handleReadMemory');
        busy.fence(build);
        assert.deepStrictEqual(busyCallsOf(busy.list(), 10_999), undefined, 'none has run 10 s yet');
        const calls = busyCallsOf(busy.list(), 241_000);
        assert.deepStrictEqual(calls, [{ tool: 'cmsis_action', since: 1_000, fenced: true }, { tool: 'read_memory', since: 1_000 }]);
        assert.strictEqual(busyText(calls, 241_000), 'busy: cmsis_action 240 s (timed out), read_memory 240 s');
        assert.strictEqual(busyText(undefined, 0), '');
        assert.strictEqual(busyText([], 0), '');
    });

    test('the lag is named above 1 s only', () => {
        assert.strictEqual(lagText({ p99: 40, max: 4_200 }), 'event-loop lag 4.2 s');
        assert.strictEqual(lagText({ p99: 40, max: 1_000 }), '');
        assert.strictEqual(lagText(undefined), '');
        assert.strictEqual(lagText({ max: 'slow' }), '');
    });

    suite('the watch on the router window', () => {
        const stale = { pid: 4711, name: 'CDA-Testdrive', updatedAt: 0 };

        test('a stale router entry and a silent port: one warning per episode, and a port that answers ends the episode', () => {
            const watch = new RouterWatch();
            assert.deepStrictEqual(watch.observe({ now: 75_000, staleRouter: stale, routerListed: false, silent: true }),
                { kind: 'named', pid: 4711, name: 'CDA-Testdrive', silentMs: 75_000 });
            assert.strictEqual(watch.observe({ now: 85_000, staleRouter: stale, routerListed: false, silent: true }), undefined);
            assert.strictEqual(watch.observe({ now: 95_000, staleRouter: stale, routerListed: false, silent: false }), undefined);
            assert.strictEqual(watch.observe({ now: 105_000, staleRouter: stale, routerListed: false, silent: true })?.kind, 'named',
                'a new episode');
        });

        test('a stale router entry whose port answers raises none', () => {
            assert.strictEqual(new RouterWatch().observe({ now: 75_000, staleRouter: stale, routerListed: false, silent: false }), undefined);
        });

        test('without any router entry the port must stay silent for a minute; with a fresh one it never warns', () => {
            const watch = new RouterWatch();
            assert.strictEqual(watch.observe({ now: 0, routerListed: false, silent: true }), undefined);
            assert.strictEqual(watch.observe({ now: 59_999, routerListed: false, silent: true }), undefined);
            assert.deepStrictEqual(watch.observe({ now: 60_000, routerListed: false, silent: true }), { kind: 'port', silentMs: 60_000 });
            const listed = new RouterWatch();
            assert.strictEqual(listed.observe({ now: 0, routerListed: true, silent: true }), undefined);
            assert.strictEqual(listed.observe({ now: 120_000, routerListed: true, silent: true }), undefined);
        });

        test('a port is silent when it accepts and never answers; an answer or a refused connection is not silence', async () => {
            // It never reads either, so it would not notice the probe hang up: its sockets are destroyed at the end.
            const accepted: net.Socket[] = [];
            const held = net.createServer((socket) => { accepted.push(socket); });
            const answering = http.createServer((_incoming, reply) => { reply.writeHead(400).end(); });
            await new Promise<void>((ready) => held.listen(0, '127.0.0.1', ready));
            await new Promise<void>((ready) => answering.listen(0, '127.0.0.1', ready));
            const heldPort = (held.address() as AddressInfo).port;
            const answeringPort = (answering.address() as AddressInfo).port;
            try {
                const began = Date.now();
                assert.strictEqual(await portSilent(heldPort, 100), true);
                assert.ok(Date.now() - began < 1_000);
                assert.strictEqual(await portSilent(answeringPort, 1_000), false);
            } finally {
                answering.closeAllConnections();
                await new Promise<void>((closed) => answering.close(() => closed()));
                accepted.forEach((socket) => socket.destroy());
                await new Promise<void>((closed) => held.close(() => closed()));
            }
            assert.strictEqual(await portSilent(answeringPort, 1_000), false, 'nothing listens there any more');
        });

        test('a port answers when anything accepts a connection on it; a free port does not, and the probe does not wait', async () => {
            // A worker asks before it builds a server: an accepting socket is a router, a free port is a bid.
            const accepting = net.createServer();
            await new Promise<void>((ready) => accepting.listen(0, '127.0.0.1', ready));
            const busyPort = (accepting.address() as AddressInfo).port;
            const freePort = await new Promise<number>((found) => {
                const probe = net.createServer();
                probe.listen(0, '127.0.0.1', () => {
                    const port = (probe.address() as AddressInfo).port;
                    probe.close(() => found(port));
                });
            });
            try {
                assert.strictEqual(await portAnswers(busyPort, 1_000), true);
                const began = Date.now();
                assert.strictEqual(await portAnswers(freePort, 1_000), false);
                assert.ok(Date.now() - began < 1_000);
            } finally {
                await new Promise<void>((closed) => accepting.close(() => closed()));
            }
        });
    });
});
