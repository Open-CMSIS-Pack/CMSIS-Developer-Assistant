// SPDX-License-Identifier: Apache-2.0 OR MIT
// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ControlServer } from '../controlServer';
import { RoutingDebuggingHandler } from '../routingDebuggingHandler';
import { IDebuggingHandler } from '../debuggingHandler';
import { WindowRegistration, WorkspaceRegistry } from '../utils/workspaceRegistry';
import { DEBUG_OPS, SERIAL_OPS, forwardTimeoutMs, isKnownOp, isSerialOp, pathHintOf } from '../core/opTable';

/**
 * A handler that answers every op with a label, so a test can assert *which*
 * window served a call. Only the ops the tests exercise are real; the rest
 * throw if reached, which keeps an accidental fallthrough loud.
 */
function fakeHandler(label: string): IDebuggingHandler {
    const answer = (op: string) => async (args?: unknown) =>
        `${label}:${op}:${JSON.stringify(args ?? {})}`;
    const handler: Record<string, unknown> = {};
    for (const op of DEBUG_OPS) {
        handler[op] = answer(op);
    }
    return handler as unknown as IDebuggingHandler;
}

suite('Op table', () => {

    test('known ops cover both handler surfaces', () => {
        assert.ok(isKnownOp('handleReadMemory'));
        assert.ok(isKnownOp('handleFlash'));
        assert.ok(isKnownOp('handleOpen'));
        assert.ok(!isKnownOp('handleNotARealOp'));
        assert.ok(!isKnownOp('constructor'), 'prototype properties must not be dispatchable');
        assert.ok(!isKnownOp('__proto__'));
    });

    test('serial ops are distinguished from debug ops', () => {
        assert.ok(isSerialOp('handleListPorts'));
        assert.ok(!isSerialOp('handleReadMemory'));
    });

    test('every declared op is unique across the two tables', () => {
        const all = [...DEBUG_OPS, ...SERIAL_OPS];
        assert.strictEqual(new Set(all).size, all.length, 'an op name is declared twice');
    });

    suite('pathHintOf', () => {
        test('prefers fileFullPath', () => {
            assert.strictEqual(pathHintOf({ fileFullPath: '/a/main.c', workingDirectory: '/b' }), '/a/main.c');
        });
        test('falls back to workingDirectory', () => {
            assert.strictEqual(pathHintOf({ workingDirectory: '/b' }), '/b');
        });
        test('path-less ops yield no hint', () => {
            assert.strictEqual(pathHintOf({ address: '0x20000000', length: 16 }), undefined);
            assert.strictEqual(pathHintOf(undefined), undefined);
            assert.strictEqual(pathHintOf({ fileFullPath: '' }), undefined);
        });
    });

    suite('forwardTimeoutMs', () => {
        test('always exceeds the tool bound so the worker error wins', () => {
            assert.ok(forwardTimeoutMs('handleReadMemory', { timeoutMs: 5_000 }, 30_000) > 5_000);
        });
        test('uses the default when the call names no timeout', () => {
            assert.strictEqual(forwardTimeoutMs('handleStepOver', {}, 30_000), 45_000);
        });
        test('build and flash get a floor far above a normal tool call', () => {
            assert.ok(forwardTimeoutMs('handleCmsisCommand', {}, 30_000) >= 600_000,
                'a build must not be cut off mid-way');
            assert.ok(forwardTimeoutMs('handleFlash', {}, 30_000) >= 600_000,
                'cutting off a flash leaves a half-programmed part');
        });
    });
});

suite('Multi-window routing', () => {

    let dir: string;
    let servers: ControlServer[] = [];
    // Distinct fake pids, as real windows have — each VS Code window is its own
    // extension-host process. Liveness is stubbed to match, so the registry
    // doesn't prune them for not being real processes.
    let nextPid = 500_001;
    const livePids = new Set<number>();
    const isAlive = (pid: number) => livePids.has(pid);

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-routing-test-'));
        nextPid = 500_001;
        livePids.clear();
    });

    teardown(async () => {
        for (const server of servers) {
            await server.stop();
        }
        servers = [];
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Stand up a control server and publish it as a live window. */
    async function window(
        name: string,
        over: Partial<WindowRegistration> = {},
    ): Promise<WindowRegistration> {
        const server = new ControlServer(fakeHandler(name), `token-${name}`);
        servers.push(server);
        const port = await server.start();

        const pid = nextPid++;
        livePids.add(pid);
        const entry: WindowRegistration = {
            pid,
            controlPort: port,
            controlToken: `token-${name}`,
            workspaceFolders: [],
            name,
            updatedAt: Date.now(),
            ...over,
        };
        fs.writeFileSync(path.join(dir, `window-${name}.json`), JSON.stringify(entry), 'utf8');
        return entry;
    }

    const router = () =>
        new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir, isAlive), 30_000);

    test('a path hint routes to the window owning that folder', async () => {
        await window('alpha', { workspaceFolders: [path.join(dir, 'alpha')] });
        await window('beta', { workspaceFolders: [path.join(dir, 'beta')] });

        const result = await router().handleAddBreakpoint({
            fileFullPath: path.join(dir, 'beta', 'main.c'), line: 10,
        });
        assert.match(result, /^beta:handleAddBreakpoint/);
    });

    test('a later path-less call sticks to the window the hint established', async () => {
        await window('alpha', { workspaceFolders: [path.join(dir, 'alpha')] });
        await window('beta', { workspaceFolders: [path.join(dir, 'beta')] });

        const r = router();
        await r.handleAddBreakpoint({ fileFullPath: path.join(dir, 'beta', 'main.c'), line: 10 });

        // read_memory carries no path — this is the case upstream cannot route.
        const result = await r.handleReadMemory({ address: '0x20000000', length: 16 });
        assert.match(result, /^beta:handleReadMemory/);
    });

    test('a path-less call routes to the sole window with an active session', async () => {
        await window('idle', { workspaceFolders: [path.join(dir, 'idle')] });
        await window('board', { workspaceFolders: [path.join(dir, 'board')], hasActiveSession: true });

        const result = await router().handleReadCoreRegisters({});
        assert.match(result, /^board:handleReadCoreRegisters/);
    });

    test('a path-less call routes to the only window when there is just one', async () => {
        await window('solo', { workspaceFolders: [path.join(dir, 'solo')] });
        const result = await router().handleGetSessionStatus();
        assert.match(result, /^solo:handleGetSessionStatus/);
    });

    test('two active sessions refuse to route and name both windows', async () => {
        await window('boardA', { workspaceFolders: [path.join(dir, 'a')], hasActiveSession: true });
        await window('boardB', { workspaceFolders: [path.join(dir, 'b')], hasActiveSession: true });

        await assert.rejects(
            () => router().handleReadMemory({ address: '0x0', length: 4 }),
            (err: Error) => {
                assert.match(err.message, /2 VS Code windows have an active debug session/);
                assert.match(err.message, /select_debug_window/);
                assert.match(err.message, new RegExp(path.join(dir, 'a').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
                assert.match(err.message, new RegExp(path.join(dir, 'b').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
                return true;
            },
        );
    });

    test('a hint matching no window is an error, not a silent fallback', async () => {
        const r = router();
        await window('alpha', { workspaceFolders: [path.join(dir, 'alpha')] });
        await r.handleGetSessionStatus(); // establish a cached target

        await assert.rejects(
            () => r.handleAddBreakpoint({ fileFullPath: '/not/in/any/workspace.c', line: 1 }),
            (err: Error) => {
                assert.match(err.message, /No open VS Code window has/);
                return true;
            },
            'running a named file in the wrong window is the bug this class fixes',
        );
    });

    test('no registered windows produces an actionable error', async () => {
        await assert.rejects(
            () => router().handleGetSessionStatus(),
            (err: Error) => {
                assert.match(err.message, /No CMSIS Developer Assistant-enabled VS Code window/);
                return true;
            },
        );
    });

    suite('explicit selection', () => {

        test('select_debug_window pins by pid and overrides the active-session rule', async () => {
            const idle = await window('idle', { workspaceFolders: [path.join(dir, 'idle')] });
            await window('board', { workspaceFolders: [path.join(dir, 'board')], hasActiveSession: true });

            const r = router();
            const message = r.selectDebugWindow({ pid: idle.pid });
            assert.match(message, /pinned to/);

            const result = await r.handleReadMemory({ address: '0x0', length: 4 });
            assert.match(result, /^idle:handleReadMemory/, 'the pin must beat the active-session fallback');
        });

        test('selecting an unknown window reports what is available', async () => {
            await window('alpha', { workspaceFolders: [path.join(dir, 'alpha')] });
            const message = router().selectDebugWindow({ workspaceFolder: '/nowhere' });
            assert.match(message, /No registered window matches/);
            assert.match(message, /alpha|Currently registered/);
        });

        test('selecting with no argument explains what is needed', () => {
            assert.match(router().selectDebugWindow({}), /Pass either pid or workspaceFolder/);
        });

        test('list_debug_windows marks the current target', async () => {
            await window('solo', { workspaceFolders: [path.join(dir, 'solo')] });
            const r = router();
            await r.handleGetSessionStatus();
            assert.match(r.listDebugWindows(), /current target/);
        });

        test('list_debug_windows says so when nothing is registered', () => {
            assert.match(router().listDebugWindows(), /No CMSIS Developer Assistant-enabled VS Code windows/);
        });
    });

    suite('control server', () => {

        test('rejects a request without the window token', async () => {
            const entry = await window('secure', { workspaceFolders: [path.join(dir, 'secure')] });
            const wrong: WindowRegistration = { ...entry, controlToken: 'wrong-token' };
            fs.writeFileSync(path.join(dir, 'window-secure.json'), JSON.stringify(wrong), 'utf8');

            await assert.rejects(
                () => router().handleGetSessionStatus(),
                (err: Error) => {
                    assert.match(err.message, /403|Could not reach/);
                    return true;
                },
                'the control server flashes hardware — an untokened caller must be refused',
            );
        });

        test('an unknown op is refused rather than dispatched', async () => {
            await window('alpha', { workspaceFolders: [path.join(dir, 'alpha')] });
            const r = router();
            await assert.rejects(
                () => r.serialOp('handleNotAnOp' as never, {}),
                (err: Error) => {
                    assert.match(err.message, /Unknown control op/);
                    return true;
                },
            );
        });

        test('args survive the round trip intact', async () => {
            await window('solo', { workspaceFolders: [path.join(dir, 'solo')] });
            const result = await router().handleReadMemory({ address: '0x20000000', length: 64, format: 'hex' });
            assert.match(result, /"address":"0x20000000"/);
            assert.match(result, /"length":64/);
            assert.match(result, /"format":"hex"/);
        });

        test('a dead window surfaces as an actionable error', async () => {
            const entry = await window('gone', { workspaceFolders: [path.join(dir, 'gone')] });
            // Point the registry at a port nothing is listening on.
            fs.writeFileSync(
                path.join(dir, 'window-gone.json'),
                JSON.stringify({ ...entry, controlPort: 1 }),
                'utf8',
            );

            await assert.rejects(
                () => router().handleGetSessionStatus(),
                (err: Error) => {
                    assert.match(err.message, /Could not reach the VS Code window/);
                    assert.match(err.message, /list_debug_windows/);
                    return true;
                },
            );
        });
    });
});
