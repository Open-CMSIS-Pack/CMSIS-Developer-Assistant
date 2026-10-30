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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DefaultTarget,
    RegistryDirContext,
    WindowRegistration,
    WorkspaceRegistry,
    describeWindow,
    ensureRegistryDir,
    resolveRegistryDir,
} from '../utils/workspaceRegistry';

/** How far `backdate` moves a file's times: past the registry's one-minute limit. */
const BACKDATE_MS = 120_000;
/** Windows has no POSIX permission bits or owners to look at. */
const POSIX = process.platform !== 'win32';
/** Another user, for a registry that must refuse a directory it does not own. */
const STRANGER_UID = (process.getuid?.() ?? 0) + 4242;

suite('Workspace registry', () => {
    let dir: string;
    let port: number;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-registry-'));
        port = 40_000;
    });

    teardown(() => {
        fs.rmSync(dir, { force: true, recursive: true });
    });

    const inDir = (name: string): string => path.join(dir, name);
    const exists = (name: string): boolean => fs.existsSync(inDir(name));

    /** A registry for `pid` over the test directory, with the real liveness check. */
    const open = (pid: number = process.pid): WorkspaceRegistry => new WorkspaceRegistry(pid, dir);

    /** Register through the public API with a distinct port per call. */
    function publish(registry: WorkspaceRegistry, overrides: Partial<WindowRegistration> = {}): void {
        registry.register({
            controlPort: port++,
            controlToken: 'test-token',
            workspaceFolders: [],
            name: 'test-window',
            ...overrides,
        });
    }

    /** Write `window-<label>.json` by hand, as a peer of another version might. */
    function plant(label: string, overrides: Partial<WindowRegistration> = {}): WindowRegistration {
        const stamp = Date.now();
        const entry: WindowRegistration = {
            pid: process.pid,
            controlPort: port++,
            controlToken: `token-${label}`,
            workspaceFolders: [],
            name: label,
            updatedAt: stamp,
            ...overrides,
        };
        fs.writeFileSync(inDir(`window-${label}.json`), JSON.stringify(entry));
        return entry;
    }

    function backdate(name: string): void {
        const then = new Date(Date.now() - BACKDATE_MS);
        fs.utimesSync(inDir(name), then, then);
    }

    suite('registration and pruning', () => {

        test('a registered window is listed with its pid and folders', () => {
            const registry = open();
            publish(registry, { workspaceFolders: ['/proj/blinky'] });
            const windows = registry.list();
            assert.strictEqual(windows.length, 1);
            assert.strictEqual(windows[0].pid, process.pid);
            assert.deepStrictEqual(windows[0].workspaceFolders, ['/proj/blinky']);
        });

        test('unregister withdraws the window', () => {
            const registry = open();
            publish(registry);
            registry.unregister();
            assert.deepStrictEqual(registry.list(), []);
        });

        test('the entry of a process that is gone is pruned by the next reader', () => {
            publish(open(999_999));
            const reader = open();
            publish(reader);
            assert.deepStrictEqual(reader.list().map((w) => w.pid), [process.pid]);
            assert.ok(!exists('window-999999.json'), 'the dead window\'s file is removed');
        });

        test('a fresh unparsable file is skipped but left alone: a peer may still be writing it', () => {
            fs.writeFileSync(inDir('window-123.json'), '{"pid": 1');
            const registry = open();
            publish(registry);
            assert.strictEqual(registry.list().length, 1);
            assert.ok(exists('window-123.json'));
        });

        test('an unparsable file older than a minute is removed', () => {
            fs.writeFileSync(inDir('window-123.json'), 'not json at all');
            backdate('window-123.json');
            const registry = open();
            publish(registry);
            assert.strictEqual(registry.list().length, 1);
            assert.ok(!exists('window-123.json'));
        });

        test('writes leave no temp file, and a heartbeat restores a deleted entry', () => {
            const registry = open();
            publish(registry);
            assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
            const firstStamp = registry.list()[0].updatedAt;

            fs.unlinkSync(inDir(`window-${process.pid}.json`));
            registry.heartbeat();
            const healed = registry.list();
            assert.strictEqual(healed.length, 1);
            assert.ok(healed[0].updatedAt >= firstStamp);

            const neverRegistered = open(process.pid + 1);
            neverRegistered.heartbeat();
            assert.ok(!exists(`window-${process.pid + 1}.json`), 'nothing to refresh, nothing written');
        });

        test('a stale router entry whose process lives is skipped, not deleted, and findStaleRouter returns it; a stale worker entry is pruned as before (#14)', () => {
            const ROUTER = 700_101;
            const WORKER = 700_102;
            const alive = new Set([process.pid, ROUTER, WORKER]);
            const registry = new WorkspaceRegistry(process.pid, dir, (pid) => alive.has(pid));
            publish(registry);
            const lastBeat = Date.now() - BACKDATE_MS;
            plant('router', { pid: ROUTER, role: 'router', name: 'CDA-Testdrive', updatedAt: lastBeat });
            plant('worker', { pid: WORKER, role: 'worker', updatedAt: lastBeat });
            assert.deepStrictEqual(registry.list().map((w) => w.pid), [process.pid]);
            assert.ok(exists('window-router.json'), 'kept: it names the window that holds the port');
            assert.ok(!exists('window-worker.json'), 'pruned as before');
            assert.deepStrictEqual([registry.findStaleRouter()?.pid, registry.findStaleRouter()?.name], [ROUTER, 'CDA-Testdrive']);
            assert.strictEqual(registry.findByPid(ROUTER), undefined, 'never a routing target');
            // Once its process is gone, the dead-pid rule removes it.
            alive.delete(ROUTER);
            assert.strictEqual(registry.findStaleRouter(), undefined);
            assert.ok(!exists('window-router.json'));
        });

        test('a fresh router entry is no stale router, and one silent for more than an hour is pruned (#14)', () => {
            const ROUTER = 700_103;
            const registry = new WorkspaceRegistry(process.pid, dir, (pid) => pid === ROUTER || pid === process.pid);
            plant('fresh', { pid: ROUTER, role: 'router' });
            assert.strictEqual(registry.findStaleRouter(), undefined);
            assert.deepStrictEqual(registry.list().map((w) => w.role), ['router']);
            plant('fresh', { pid: ROUTER, role: 'router', updatedAt: Date.now() - 61 * 60_000 });
            assert.strictEqual(registry.findStaleRouter(), undefined, 'after an hour the pid more likely belongs to another process');
            assert.ok(!exists('window-fresh.json'));
        });

        test('a heartbeat writes the busy calls and the lag it is given, and drops what it is given as undefined (#14)', () => {
            const registry = open();
            publish(registry, { version: '2.5.1' });
            registry.heartbeat({ busy: [{ tool: 'cmsis_action', since: 5, fenced: true }], lagMs: { p99: 12, max: 4_200 } });
            const beat = registry.list()[0];
            assert.deepStrictEqual([beat.version, beat.busy, beat.lagMs], ['2.5.1', [{ tool: 'cmsis_action', since: 5, fenced: true }], { p99: 12, max: 4_200 }]);
            registry.heartbeat({ busy: undefined, lagMs: { p99: 1, max: 3 } });
            const next = JSON.parse(fs.readFileSync(inDir(`window-${process.pid}.json`), 'utf8')) as WindowRegistration;
            assert.ok(!('busy' in next), 'no busy calls, no field');
            assert.deepStrictEqual(next.lagMs, { p99: 1, max: 3 });
        });

        test('a crashed writer\'s temp file is never listed and goes once it is old', () => {
            const stale = 'window-77.json.77.deadbeef.tmp';
            const fresh = 'window-78.json.78.cafebabe.tmp';
            fs.writeFileSync(inDir(stale), '{}');
            fs.writeFileSync(inDir(fresh), '{}');
            backdate(stale);
            const registry = open();
            publish(registry);
            assert.strictEqual(registry.list().length, 1);
            assert.ok(!exists(stale), 'abandoned temp file removed');
            assert.ok(exists(fresh), 'recent temp file kept');
        });
    });

    suite('the directory and file permissions (#19)', () => {
        const permissions = (target: string): string => (fs.statSync(target).mode & 0o777).toString(8);

        /** A registry over `registryDir` that reports refusals into `warnings`. */
        function guarded(registryDir: string, warnings: string[], uid?: number): WorkspaceRegistry {
            return new WorkspaceRegistry(process.pid, registryDir, undefined, { uid, onRefused: (message) => warnings.push(message) });
        }

        test('a new directory is 0700 and the window file 0600, with the note first', function () {
            if (!POSIX) {
                this.skip();
            }
            const registryDir = inDir('fresh');
            publish(new WorkspaceRegistry(process.pid, registryDir));
            assert.strictEqual(permissions(registryDir), '700');
            const file = path.join(registryDir, `window-${process.pid}.json`);
            assert.strictEqual(permissions(file), '600');
            const text = fs.readFileSync(file, 'utf8');
            assert.ok(text.startsWith('{"_note":"Internal to the CMSIS Developer Assistant. Agents: use the MCP tools '
                + 'list_debug_windows and select_debug_window."'), text);
        });

        test('an existing 0755 directory of this user is narrowed to 0700, and a 0644 file of 2.5.0 to 0600 by the heartbeat', function () {
            if (!POSIX) {
                this.skip();
            }
            const registryDir = inDir('old');
            fs.mkdirSync(registryDir);
            fs.chmodSync(registryDir, 0o755);
            const registry = new WorkspaceRegistry(process.pid, registryDir);
            publish(registry);
            assert.strictEqual(permissions(registryDir), '700');
            const file = path.join(registryDir, `window-${process.pid}.json`);
            fs.chmodSync(file, 0o644);
            registry.heartbeat();
            assert.strictEqual(permissions(file), '600');
        });

        test('entries with fields this version does not know are listed as usual', () => {
            const registry = open();
            plant('newer', { workspaceFolders: [inDir('newer')], ...{ _note: 'x', controlEnvelope: 3, owner: { user: 'me' } } });
            const listed = registry.findByPath(inDir('newer/main.c'));
            assert.strictEqual(listed?.name, 'newer');
            assert.strictEqual(describeWindow(listed), `pid=${process.pid} | ${inDir('newer')}`);
        });

        test('a directory of another user is refused: nothing is written or read, and the window sees only itself', function () {
            if (!POSIX) {
                this.skip();
            }
            const planted = plant('foreign', { pid: 1, workspaceFolders: ['/elsewhere'] });
            const warnings: string[] = [];
            const registry = guarded(dir, warnings, STRANGER_UID);
            publish(registry, { workspaceFolders: [inDir('mine')] });
            registry.heartbeat();
            assert.ok(!exists(`window-${process.pid}.json`), 'nothing written into the refused directory');
            assert.deepStrictEqual(warnings, [
                `Multi-window routing is off in this window: ${dir} belongs to another user. `
                    + 'Remove it, or ask its owner to; the window registers again at its next refresh.',
            ], 'one warning, not one per heartbeat');
            assert.deepStrictEqual(registry.list().map((w) => w.name), ['test-window'], 'the planted entry is not read');
            assert.strictEqual(registry.findByPath(inDir('mine/main.c'))?.pid, process.pid, 'its own calls still route to itself');
            registry.unregister();
            assert.ok(exists(`window-${planted.name}.json`), 'nothing in the refused directory is removed');
            assert.deepStrictEqual(registry.list(), []);
        });

        test('a symbolic link in place of the directory is refused, and a fit directory later is used again', function () {
            if (!POSIX) {
                this.skip();
            }
            const target = inDir('elsewhere');
            fs.mkdirSync(target);
            const link = inDir('linked');
            fs.symlinkSync(target, link);
            const warnings: string[] = [];
            const registry = guarded(link, warnings);
            publish(registry);
            assert.deepStrictEqual(fs.readdirSync(target), [], 'nothing written through the link');
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /linked is a symbolic link\./);

            fs.unlinkSync(link);
            registry.heartbeat();
            assert.ok(fs.existsSync(path.join(link, `window-${process.pid}.json`)), 'the heartbeat registers once the link is gone');
            assert.strictEqual(permissions(link), '700');
        });

        test('ensureRegistryDir says why a path is unfit: a file, a link, another owner', function () {
            if (!POSIX) {
                this.skip();
            }
            const me = { platform: process.platform, uid: process.getuid?.() };
            fs.writeFileSync(inDir('plain-file'), '');
            assert.strictEqual(ensureRegistryDir(inDir('plain-file'), me), 'is not a directory');
            fs.symlinkSync(inDir('nowhere'), inDir('dangling'));
            assert.strictEqual(ensureRegistryDir(inDir('dangling'), me), 'is a symbolic link');
            assert.strictEqual(ensureRegistryDir(dir, { ...me, uid: STRANGER_UID }), 'belongs to another user');
            assert.strictEqual(ensureRegistryDir(inDir('new/nested'), me), undefined);
            assert.strictEqual(ensureRegistryDir(dir, { platform: 'win32', uid: undefined }), undefined, 'no owner check on Windows');
        });

        suite('resolveRegistryDir', () => {
            const context = (overrides: Partial<RegistryDirContext>): RegistryDirContext => ({
                platform: 'linux',
                tmpdir: '/tmp',
                uid: 1000,
                stat: () => ({ mode: 0o41777 }),
                ...overrides,
            });
            const shared = (tmpdir: string): string => path.join(tmpdir, 'cmsis-developer-assistant-registry');

            test('a temp directory every user may write to gets the per-user name', () => {
                assert.strictEqual(resolveRegistryDir(context({})), `${shared('/tmp')}-1000`);
                assert.strictEqual(resolveRegistryDir(context({ platform: 'darwin', uid: 501 })), `${shared('/tmp')}-501`);
            });

            test('a private temp directory keeps the name of 2.5.0, so older windows stay visible', () => {
                const tmpdir = '/var/folders/xy/T';
                assert.strictEqual(resolveRegistryDir(context({ platform: 'darwin', tmpdir, stat: () => ({ mode: 0o40700 }) })), shared(tmpdir));
                assert.strictEqual(resolveRegistryDir(context({ tmpdir: '/home/me/tmp', stat: () => ({ mode: 0o40755 }) })), shared('/home/me/tmp'));
            });

            test('Windows, an unknown uid and an unreadable temp directory keep the name of 2.5.0', () => {
                assert.strictEqual(resolveRegistryDir(context({ platform: 'win32', uid: undefined })), shared('/tmp'));
                assert.strictEqual(resolveRegistryDir(context({ uid: undefined })), shared('/tmp'));
                assert.strictEqual(resolveRegistryDir(context({ stat: () => { throw new Error('EACCES'); } })), shared('/tmp'));
            });
        });
    });

    suite('findByPath', () => {

        test('a path inside a window\'s folder finds that window', () => {
            const registry = open();
            publish(registry, { workspaceFolders: [inDir('blinky')] });
            assert.strictEqual(registry.findByPath(inDir('blinky/src/main.c'))?.pid, process.pid);
        });

        test('the deepest containing folder wins', () => {
            const registry = open();
            publish(registry, { workspaceFolders: [inDir('work')] });
            plant('nested', { workspaceFolders: [inDir('work/blinky')] });
            assert.strictEqual(registry.findByPath(inDir('work/blinky/main.c'))?.name, 'nested');
        });

        test('a sibling that merely shares the prefix is not inside the folder', () => {
            const registry = open();
            publish(registry, { workspaceFolders: [inDir('blinky')] });
            assert.strictEqual(registry.findByPath(inDir('blinky-old/main.c')), undefined);
        });

        test('a path outside every folder finds nothing', () => {
            const registry = open();
            publish(registry, { workspaceFolders: [inDir('blinky')] });
            assert.strictEqual(registry.findByPath('/somewhere/else/main.c'), undefined);
        });

        test('the only window, when it has no folder open, takes any path', () => {
            const registry = open();
            publish(registry);
            assert.strictEqual(registry.findByPath('/anything.c')?.pid, process.pid);
        });
    });

    suite('routing helpers', () => {

        test('the one window with a debug session is found', () => {
            const registry = open();
            plant('idle', { hasActiveSession: false });
            plant('busy', { hasActiveSession: true });
            assert.strictEqual(registry.findSoleActiveSession()?.name, 'busy');
        });

        test('two debug sessions: no guess', () => {
            const registry = open();
            plant('first', { hasActiveSession: true });
            plant('second', { hasActiveSession: true });
            assert.strictEqual(registry.findSoleActiveSession(), undefined);
        });

        test('no debug session: nothing found', () => {
            const registry = open();
            plant('quiet', { hasActiveSession: false });
            assert.strictEqual(registry.findSoleActiveSession(), undefined);
        });

        test('findSoleWindow answers only while exactly one window is registered', () => {
            const registry = open();
            plant('only');
            assert.strictEqual(registry.findSoleWindow()?.name, 'only');
            plant('another');
            assert.strictEqual(registry.findSoleWindow(), undefined);
        });

        test('isLive follows the control port of the same pid', () => {
            const registry = open();
            const original = plant('w', { controlPort: 42_008 });
            assert.strictEqual(registry.isLive(original), true);
            plant('w', { controlPort: 49_999 });
            assert.strictEqual(registry.isLive(original), false);
        });
    });

    suite('the default target (#16)', () => {
        const ALPHA = 700_001;
        const BETA = 700_002;
        const DEFAULT_FILE = 'default-target.json';

        /** A registry that takes only the fake pids planted here for live. */
        const view = (): WorkspaceRegistry => new WorkspaceRegistry(process.pid, dir, (pid) => pid === ALPHA || pid === BETA || pid === process.pid);

        test('it is saved 0600 beside the window files, read back with the fields this version knows, and cleared', async () => {
            const registry = view();
            await registry.writeDefaultTarget({ pid: ALPHA, workspaceFolder: '/proj/alpha', name: 'alpha', setAt: 5 });
            if (POSIX) {
                assert.strictEqual((fs.statSync(inDir(DEFAULT_FILE)).mode & 0o777).toString(8), '600');
            }
            assert.deepStrictEqual(registry.readDefaultTarget(), { pid: ALPHA, workspaceFolder: '/proj/alpha', name: 'alpha', setAt: 5 });
            fs.writeFileSync(inDir(DEFAULT_FILE), JSON.stringify({ pid: BETA, setAt: 6, chosenBy: 'a later version', workspaceFolder: '' }));
            assert.deepStrictEqual(registry.readDefaultTarget(), { pid: BETA, setAt: 6 });
            await registry.clearDefaultTarget();
            assert.ok(!exists(DEFAULT_FILE));
            assert.strictEqual(registry.readDefaultTarget(), undefined);
            await registry.clearDefaultTarget();
        });

        test('a file that holds no default target reads as none', () => {
            const registry = view();
            for (const text of ['{"pid": 7', '[]', '{"pid": "7", "setAt": 1}', '{"pid": 7}', '{"pid": -7, "setAt": 1}', '{"pid": 7.5, "setAt": 1}']) {
                fs.writeFileSync(inDir(DEFAULT_FILE), text);
                assert.strictEqual(registry.readDefaultTarget(), undefined, text);
            }
        });

        test('the file is no window: list() passes it by and leaves it alone', async () => {
            const registry = view();
            publish(registry);
            await registry.writeDefaultTarget({ pid: process.pid, setAt: 1 });
            assert.deepStrictEqual(registry.list().map((w) => w.pid), [process.pid]);
            assert.ok(exists(DEFAULT_FILE));
        });

        test('its window is found by pid, or after a reload by its folder, never by a reused pid or a shared folder', () => {
            const registry = view();
            plant('alpha', { pid: ALPHA, workspaceFolders: [inDir('alpha'), inDir('shared')] });
            plant('beta', { pid: BETA, workspaceFolders: [inDir('beta/'), inDir('shared')] });
            const found = (target: DefaultTarget): string | undefined => registry.findDefaultTarget(target)?.name;
            assert.strictEqual(found({ pid: ALPHA, workspaceFolder: inDir('alpha'), setAt: 1 }), 'alpha');
            assert.strictEqual(found({ pid: 4, workspaceFolder: inDir('beta'), setAt: 1 }), 'beta', 'the reloaded window has a new pid');
            assert.strictEqual(found({ pid: ALPHA, workspaceFolder: inDir('beta'), setAt: 1 }), 'beta', 'a pid that now names another window');
            assert.strictEqual(found({ pid: 4, workspaceFolder: inDir('shared'), setAt: 1 }), undefined, 'two windows have the folder open');
            assert.strictEqual(found({ pid: BETA, setAt: 1 }), 'beta', 'a window without a folder is found by its pid');
            assert.strictEqual(found({ pid: 4, setAt: 1 }), undefined);
            assert.strictEqual(found({ pid: 4, workspaceFolder: inDir('closed'), setAt: 1 }), undefined);
        });

        test('a directory this user must not trust is neither read nor written for it', async function () {
            if (!POSIX) {
                this.skip();
            }
            fs.writeFileSync(inDir(DEFAULT_FILE), JSON.stringify({ pid: ALPHA, setAt: 1 }));
            const registry = new WorkspaceRegistry(process.pid, dir, undefined, { uid: STRANGER_UID });
            assert.strictEqual(registry.readDefaultTarget(), undefined, 'a planted default steers nothing');
            await assert.rejects(registry.writeDefaultTarget({ pid: BETA, setAt: 2 }), /belongs to another user/);
            await registry.clearDefaultTarget();
            assert.ok(exists(DEFAULT_FILE), 'nothing in the refused directory is removed');
        });
    });

    suite('describeWindow', () => {

        const base: WindowRegistration = {
            pid: 4242,
            controlPort: 1,
            controlToken: 'never-shown',
            workspaceFolders: ['/proj/blinky'],
            name: 'blinky',
            updatedAt: 0,
        };

        test('names the pid and the folders', () => {
            const line = describeWindow(base);
            assert.match(line, /pid=4242/);
            assert.match(line, /\/proj\/blinky/);
        });

        test('says so when no folder is open', () => {
            assert.match(describeWindow({ ...base, workspaceFolders: [] }), /no folder open/);
        });

        test('shows the active debug configuration', () => {
            const line = describeWindow({ ...base, hasActiveSession: true, activeConfigurationName: 'AppKit-E8 Debug' });
            assert.match(line, /debugging: AppKit-E8 Debug/);
        });

        test('shows the CMSIS solution', () => {
            const line = describeWindow({ ...base, cmsisProject: '/proj/blinky/blinky.csolution.yml' });
            assert.match(line, /cmsis=\/proj\/blinky\/blinky\.csolution\.yml/);
        });

        test('marks the router window; a worker and a window of 2.5.0 carry no mark', () => {
            assert.strictEqual(describeWindow({ ...base, role: 'router', hasActiveSession: true }), 'pid=4242 | /proj/blinky | router | debugging');
            assert.strictEqual(describeWindow({ ...base, role: 'worker' }), 'pid=4242 | /proj/blinky');
            assert.strictEqual(describeWindow(base), 'pid=4242 | /proj/blinky');
        });

        test('names the calls busy there and an event-loop lag above 1 s (#14)', () => {
            const now = 1_700_000_000_000;
            assert.strictEqual(describeWindow({
                ...base, role: 'router', busy: [{ tool: 'cmsis_action', since: now - 240_000 }], lagMs: { p99: 40, max: 4_200 },
            }, now), 'pid=4242 | /proj/blinky | router | busy: cmsis_action 240 s | event-loop lag 4.2 s');
            assert.strictEqual(describeWindow({
                ...base, busy: [{ tool: 'start_debugging', since: now - 200_000, fenced: true }, { tool: 'read_memory', since: now - 12_000 }],
                lagMs: { p99: 3, max: 900 },
            }, now), 'pid=4242 | /proj/blinky | busy: start_debugging 200 s (timed out), read_memory 12 s');
            // Whatever a file of another version holds there is read safely.
            const odd = { ...base, busy: [{ tool: 7 }, null, 'x'], lagMs: 'slow' } as unknown as WindowRegistration;
            assert.strictEqual(describeWindow(odd, now), 'pid=4242 | /proj/blinky');
        });

        test('names the GDB ports its sessions and CMSIS Run tasks use; an entry without them, or with what it does not know, names none', () => {
            assert.strictEqual(describeWindow({
                ...base, hasActiveSession: true, activeConfigurationName: 'STLink@pyOCD (attach)',
                gdbPorts: [{ port: 3333, source: 'cmsis-run', label: 'CMSIS Run', server: 'pyOCD' }, { port: 3334, source: 'session', label: 'Core1' }],
            }), 'pid=4242 | /proj/blinky | debugging: STLink@pyOCD (attach) | GDB port 3333 (CMSIS Run), 3334 (Core1)');
            const odd = { ...base, gdbPorts: [{ port: 'x' }, 3333] } as unknown as WindowRegistration;
            assert.strictEqual(describeWindow(odd), 'pid=4242 | /proj/blinky');
        });
    });
});
