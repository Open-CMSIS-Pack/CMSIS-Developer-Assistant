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
import * as net from 'net';
import { bindProbe, findGdbPortHolder, gdbPortRefusal, portInUse, type PortClaimingWindow } from '../core/gdbPortGuard';
import { Refusal } from '../core/toolResult';

/** A stand-in GDB server on `host`, which counts the clients it sees: pyOCD halts the target for each one. */
async function listener(host: string): Promise<{ port: number; clients: () => number; close: () => Promise<void> }> {
    let clients = 0;
    const server = net.createServer((socket) => {
        clients++;
        socket.destroy();
    });
    await new Promise<void>((ready) => server.listen(0, host, ready));
    return {
        port: (server.address() as net.AddressInfo).port,
        clients: () => clients,
        close: () => new Promise<void>((done) => server.close(() => done())),
    };
}

/** A port nothing listens on: one the system handed out and took back. */
async function freePort(): Promise<number> {
    const probe = await listener('127.0.0.1');
    await probe.close();
    return probe.port;
}

/**
 * Two windows on one GDB port (live test): before a launch, the port's holder
 * is named from the other windows' registry entries, else found by a bind
 * test that never connects, so no GDB server sees a client.
 */
suite('GDB port guard', () => {
    test('the bind test finds a server on 127.0.0.1 and on the wildcard, and never connects to it', async () => {
        for (const host of ['127.0.0.1', '0.0.0.0']) {
            const server = await listener(host);
            try {
                assert.strictEqual(await portInUse(server.port), true, host);
                await new Promise<void>((settle) => setTimeout(settle, 50));
                assert.strictEqual(server.clients(), 0, `a connection to the server on ${host} is a GDB client`);
            } finally {
                await server.close();
            }
        }
        const free = await freePort();
        assert.strictEqual(await portInUse(free), false);
        assert.strictEqual(await bindProbe(free, '127.0.0.1'), 'free');
        assert.strictEqual(await bindProbe(free, '203.0.113.9'), 'unknown', 'an address this machine does not have proves nothing');
        assert.strictEqual(await portInUse(free), false, 'the probes closed what they bound');
    });

    test('a window that claims the port is named without a bind test; otherwise the bind test decides', async () => {
        const windows: PortClaimingWindow[] = [
            { pid: 11, name: 'board', claims: [{ port: 2331, source: 'cmsis-run', label: 'CMSIS Run', server: 'J-Link' }] },
            { pid: 12, name: 'item13', claims: [{ port: 3333, source: 'cmsis-run', label: 'CMSIS Run', server: 'pyOCD' }] },
        ];
        const tested: number[] = [];
        const inUse = (answer: boolean) => async (port: number): Promise<boolean> => {
            tested.push(port);
            return answer;
        };
        assert.deepStrictEqual(await findGdbPortHolder(3333, windows, inUse(true)),
            { kind: 'window', pid: 12, name: 'item13', claim: { port: 3333, source: 'cmsis-run', label: 'CMSIS Run', server: 'pyOCD' } });
        assert.deepStrictEqual(tested, []);
        assert.deepStrictEqual(await findGdbPortHolder(3334, windows, inUse(true)), { kind: 'listener' });
        assert.strictEqual(await findGdbPortHolder(3334, windows, inUse(false)), undefined);
        assert.deepStrictEqual(tested, [3334, 3334]);
    });

    test('the refusal names the port, its holder and the way out', () => {
        const launch = { what: 'launch' as const, subject: 'CMSIS \'load_and_debug\' on MPS3 not started', configuration: 'Arm-FVP@GDB (launch)', server: 'Arm FVP' as const };
        const byRun = gdbPortRefusal(launch, 3333, { kind: 'window', pid: 70401, name: 'item13', claim: { port: 3333, source: 'cmsis-run', label: 'CMSIS Run', server: 'pyOCD' } });
        assert.ok(byRun instanceof Refusal, 'complete as it stands: wrapError passes it on');
        assert.strictEqual(byRun.code, 'PROBE_BUSY');
        assert.strictEqual(byRun.message, 'CMSIS \'load_and_debug\' on MPS3 not started: the Arm FVP GDB server of \'Arm-FVP@GDB (launch)\' would use port 3333, '
            + 'which window \'item13\' (pid 70401) uses for its CMSIS Run task (pyOCD GDB server). GDB would connect to that server instead of the new one, '
            + 'and debug — and halt — that target.');
        assert.strictEqual(byRun.hint, 'Stop that task there once the user agrees (cmsis_action stop_run with window: \'70401\'), or give this project another port: '
            + 'GDBServer.port in .vscode/launch.json.');

        const run = { what: 'run' as const, subject: 'CMSIS \'run\' on B-L475E-IOT01A not started', server: 'pyOCD' as const };
        const bySession = gdbPortRefusal(run, 3333, { kind: 'window', pid: 4047, name: '(no workspace)', claim: { port: 3333, source: 'session', label: 'Arm-FVP@GDB (launch)' } });
        assert.strictEqual(bySession.message, 'CMSIS \'run\' on B-L475E-IOT01A not started: its pyOCD GDB server (CMSIS Run) would use port 3333, which the window '
            + 'with pid 4047 uses for its debug session \'Arm-FVP@GDB (launch)\' (GDB server). Two GDB servers on one port: the new one fails to start, '
            + 'or a GDB meant for one of them reaches the other.');
        assert.strictEqual(bySession.hint, 'Stop that session there once the user agrees (select_debug_window {pid: 4047}, then stop_debugging), or give this project\'s GDB server '
            + 'another port.');

        const byProgram = gdbPortRefusal({ what: 'launch', subject: 'Debug session not started', configuration: 'STLink@pyOCD (launch)', server: 'pyOCD' }, 3333, { kind: 'listener' });
        assert.strictEqual(byProgram.message, 'Debug session not started: the pyOCD GDB server of \'STLink@pyOCD (launch)\' would use port 3333, and another '
            + 'program already listens on that port of this computer — no window of the CMSIS Developer Assistant claims it: a GDB server started elsewhere, '
            + 'or one an earlier session left running. GDB would connect to that server instead of the new one, and debug — and halt — that target.');
        assert.strictEqual(byProgram.hint, 'Free the port (the user can end that program), or give this project another port: target.port of '
            + '\'STLink@pyOCD (launch)\' in .vscode/launch.json.');
    });
});
