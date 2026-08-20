// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WindowRegistration, WorkspaceRegistry, describeWindow } from '../utils/workspaceRegistry';

/**
 * The registry is what makes routing possible, so its pruning and matching
 * rules are the difference between "drives the right board" and "silently
 * drives the wrong one".
 */
suite('Workspace registry', () => {

    let dir: string;
    let counter = 0;

    const registryFor = (pid: number) => new WorkspaceRegistry(pid, dir);

    const register = (
        registry: WorkspaceRegistry,
        overrides: Partial<Omit<WindowRegistration, 'pid' | 'updatedAt'>> = {},
    ) => registry.register({
        controlPort: 40000 + (counter++),
        controlToken: 'token',
        workspaceFolders: [],
        name: 'window',
        ...overrides,
    });

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-registry-test-'));
    });

    teardown(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a registered window is listed back', () => {
        const registry = registryFor(process.pid);
        register(registry, { workspaceFolders: ['/proj/blinky'], name: 'blinky' });

        const all = registry.list();
        assert.strictEqual(all.length, 1);
        assert.strictEqual(all[0].pid, process.pid);
        assert.deepStrictEqual(all[0].workspaceFolders, ['/proj/blinky']);
    });

    test('unregister removes the entry', () => {
        const registry = registryFor(process.pid);
        register(registry);
        registry.unregister();
        assert.deepStrictEqual(registry.list(), []);
    });

    test('an entry whose process is gone is pruned on read', () => {
        // pid 1 is alive; use an implausible pid that is almost certainly not.
        const dead = registryFor(999_999);
        register(dead);
        const reader = registryFor(process.pid);
        register(reader);

        const pids = reader.list().map(w => w.pid);
        assert.deepStrictEqual(pids, [process.pid], 'the dead window should be pruned');
    });

    test('a corrupt entry file is pruned rather than throwing', () => {
        fs.writeFileSync(path.join(dir, 'window-123.json'), 'not json at all', 'utf8');
        const registry = registryFor(process.pid);
        register(registry);
        assert.strictEqual(registry.list().length, 1);
    });

    suite('findByPath', () => {

        test('matches a file inside a workspace folder', () => {
            const registry = registryFor(process.pid);
            register(registry, { workspaceFolders: [path.join(dir, 'blinky')] });

            const found = registry.findByPath(path.join(dir, 'blinky', 'src', 'main.c'));
            assert.strictEqual(found?.pid, process.pid);
        });

        test('prefers the deepest matching folder', () => {
            const outer = registryFor(process.pid);
            register(outer, { workspaceFolders: [path.join(dir, 'work')] });

            // A second live entry for the nested folder. Reuse this pid so the
            // liveness check passes, writing the file directly.
            const nested: WindowRegistration = {
                pid: process.pid, controlPort: 41000, controlToken: 't',
                workspaceFolders: [path.join(dir, 'work', 'blinky')],
                name: 'nested', updatedAt: Date.now(),
            };
            fs.writeFileSync(path.join(dir, 'window-nested.json'), JSON.stringify(nested), 'utf8');

            const found = outer.findByPath(path.join(dir, 'work', 'blinky', 'main.c'));
            assert.strictEqual(found?.name, 'nested');
        });

        test('a sibling directory sharing a name prefix is not a match', () => {
            const registry = registryFor(process.pid);
            register(registry, { workspaceFolders: [path.join(dir, 'blinky')] });

            const found = registry.findByPath(path.join(dir, 'blinky-old', 'main.c'));
            assert.strictEqual(found, undefined, 'prefix match must respect path separators');
        });

        test('returns undefined when no folder contains the path', () => {
            const registry = registryFor(process.pid);
            register(registry, { workspaceFolders: [path.join(dir, 'blinky')] });
            assert.strictEqual(registry.findByPath('/somewhere/else/main.c'), undefined);
        });

        test('a sole folderless window is the fallback', () => {
            const registry = registryFor(process.pid);
            register(registry, { workspaceFolders: [] });
            assert.strictEqual(registry.findByPath('/anything.c')?.pid, process.pid);
        });
    });

    suite('CMSIS resolution helpers', () => {

        const writeEntry = (name: string, over: Partial<WindowRegistration>) => {
            const entry: WindowRegistration = {
                pid: process.pid, controlPort: 42000, controlToken: 't',
                workspaceFolders: [], name, updatedAt: Date.now(), ...over,
            };
            fs.writeFileSync(path.join(dir, `window-${name}.json`), JSON.stringify(entry), 'utf8');
            return entry;
        };

        test('the sole window with an active session is found', () => {
            writeEntry('idle', { controlPort: 42001, hasActiveSession: false });
            writeEntry('busy', { controlPort: 42002, hasActiveSession: true });

            const found = registryFor(process.pid).findSoleActiveSession();
            assert.strictEqual(found?.name, 'busy');
        });

        test('two active sessions resolve to nothing rather than a guess', () => {
            writeEntry('a', { controlPort: 42003, hasActiveSession: true });
            writeEntry('b', { controlPort: 42004, hasActiveSession: true });

            assert.strictEqual(registryFor(process.pid).findSoleActiveSession(), undefined,
                'guessing here would read the wrong board');
        });

        test('no active session resolves to nothing', () => {
            writeEntry('a', { controlPort: 42005, hasActiveSession: false });
            assert.strictEqual(registryFor(process.pid).findSoleActiveSession(), undefined);
        });

        test('findSoleWindow only answers when exactly one is registered', () => {
            const registry = registryFor(process.pid);
            writeEntry('only', { controlPort: 42006 });
            assert.strictEqual(registry.findSoleWindow()?.name, 'only');

            writeEntry('second', { controlPort: 42007 });
            assert.strictEqual(registry.findSoleWindow(), undefined);
        });

        test('isLive follows the control port, so a restarted window is not stale', () => {
            const registry = registryFor(process.pid);
            const entry = writeEntry('w', { controlPort: 42008 });
            assert.strictEqual(registry.isLive(entry), true);

            writeEntry('w', { controlPort: 49999 }); // same window, new port
            assert.strictEqual(registry.isLive(entry), false,
                'a stale port must not be treated as live');
        });
    });

    suite('describeWindow', () => {

        const base: WindowRegistration = {
            pid: 4242, controlPort: 1, controlToken: 't',
            workspaceFolders: ['/proj/blinky'], name: 'blinky', updatedAt: 0,
        };

        test('reports pid and folders', () => {
            const text = describeWindow(base);
            assert.match(text, /pid=4242/);
            assert.match(text, /\/proj\/blinky/);
        });

        test('a folderless window says so instead of rendering empty', () => {
            assert.match(describeWindow({ ...base, workspaceFolders: [] }), /no folder open/);
        });

        test('an active session and its configuration are surfaced', () => {
            const text = describeWindow({
                ...base, hasActiveSession: true, activeConfigurationName: 'AppKit-E8 Debug',
            });
            assert.match(text, /debugging: AppKit-E8 Debug/);
        });

        test('the CMSIS project is surfaced when known', () => {
            const text = describeWindow({ ...base, cmsisProject: '/proj/blinky/blinky.csolution.yml' });
            assert.match(text, /cmsis=\/proj\/blinky\/blinky\.csolution\.yml/);
        });
    });
});
