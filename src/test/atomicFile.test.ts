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
// The module object itself: the writers read fs's functions from it at each call, so a stand-in put there is what they call.
import fsModule = require('fs');
import { isTempPath, renameRetrying, renameSyncRetrying, tempPathFor, writeFileAtomic, writeFileAtomicSync } from '../utils/atomicFile';

/** Windows has no POSIX permission bits to look at. */
const POSIX = process.platform !== 'win32';

/**
 * The atomic writers: a reader sees the old file or the new one, never half
 * of one, and the `mode` option decides the new file's permissions (#19: the
 * window registry writes 0600). A symbolic link is written through and
 * stays, as with a plain write: agents' files are often links into a
 * dotfiles repository.
 */
suite('Atomic file writes', () => {
    let dir: string;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-atomic-'));
    });

    teardown(() => {
        fs.rmSync(dir, { force: true, recursive: true });
    });

    const inDir = (name: string): string => path.join(dir, name);
    const permissions = (file: string): number => fs.statSync(file).mode & 0o777;
    const leftovers = (): string[] => fs.readdirSync(dir).filter(isTempPath);
    const tempFilesIn = (folder: string): string[] => fs.readdirSync(folder).filter(isTempPath);
    const isLink = (file: string): boolean => fs.lstatSync(file).isSymbolicLink();

    test('a temp name is unique per call and recognised as one', () => {
        const first = tempPathFor(inDir('window-7.json'));
        const second = tempPathFor(inDir('window-7.json'));
        assert.notStrictEqual(first, second);
        assert.ok(isTempPath(path.basename(first)), first);
        assert.ok(!isTempPath('window-7.json'));
    });

    test('both writers replace the content whole', async () => {
        const file = inDir('config.json');
        writeFileAtomicSync(file, '{"a":1}');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}');
        await writeFileAtomic(file, '{"a":2} ✓');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":2} ✓');
        assert.deepStrictEqual(leftovers(), []);
    });

    test('the mode option applies to a new file and to one that replaces a wider file', async function () {
        if (!POSIX) {
            this.skip();
        }
        const synced = inDir('sync.json');
        writeFileAtomicSync(synced, '{}', { mode: 0o600 });
        assert.strictEqual(permissions(synced).toString(8), '600');

        const awaited = inDir('async.json');
        fs.writeFileSync(awaited, '{}', { mode: 0o644 });
        fs.chmodSync(awaited, 0o644);
        await writeFileAtomic(awaited, '{"b":1}', { mode: 0o600 });
        assert.strictEqual(permissions(awaited).toString(8), '600', 'the rename replaced the 0644 file');
        assert.strictEqual(fs.readFileSync(awaited, 'utf8'), '{"b":1}');
    });

    test('without a mode, a replaced file keeps its permission bits', async function () {
        if (!POSIX) {
            this.skip();
        }
        // An agent's configuration file the user narrowed to 0600 must not come back 0644.
        const narrowed = inDir('agent-config.json');
        fs.writeFileSync(narrowed, '{}');
        fs.chmodSync(narrowed, 0o600);
        writeFileAtomicSync(narrowed, '{"servers":1}');
        assert.strictEqual(permissions(narrowed).toString(8), '600');
        await writeFileAtomic(narrowed, '{"servers":2}');
        assert.strictEqual(permissions(narrowed).toString(8), '600');
        assert.strictEqual(fs.readFileSync(narrowed, 'utf8'), '{"servers":2}');

        // A new file gets the default, and an explicit mode still wins over the old bits.
        const fresh = inDir('fresh.json');
        await writeFileAtomic(fresh, '{}');
        assert.strictEqual(permissions(fresh) & 0o600, 0o600, 'readable and writable by its owner');
        writeFileAtomicSync(narrowed, '{}', { mode: 0o640 });
        assert.strictEqual(permissions(narrowed) & 0o640, 0o640);
        assert.deepStrictEqual(leftovers(), []);
    });

    test('a failed write leaves the old content and no temp file behind', async () => {
        const file = inDir('kept.json');
        fs.writeFileSync(file, 'old');
        // A directory where the file should go: the write succeeds, the rename cannot.
        const blocked = inDir('blocked');
        fs.mkdirSync(blocked);
        fs.writeFileSync(path.join(blocked, 'inside'), 'x');
        assert.throws(() => writeFileAtomicSync(blocked, 'new', { mode: 0o600 }));
        await assert.rejects(writeFileAtomic(blocked, 'new', { mode: 0o600 }));
        assert.deepStrictEqual(leftovers(), []);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old');

        // A folder that does not exist: the temp file is never created.
        const nowhere = path.join(dir, 'missing', 'file.json');
        assert.throws(() => writeFileAtomicSync(nowhere, 'x'), /ENOENT/);
        await assert.rejects(writeFileAtomic(nowhere, 'x'), /ENOENT/);
        assert.deepStrictEqual(leftovers(), []);
    });

    test('on Windows a rename onto a file held open for the moment is tried again; elsewhere, and when it lasts, it fails', async () => {
        const busy = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
        const syncFs = fsModule as { renameSync: typeof fs.renameSync };
        const asyncFs = fsModule.promises as { rename: typeof fs.promises.rename };
        const renameSync = fsModule.renameSync;
        const rename = fsModule.promises.rename;
        let refusals = 0;
        // A virus scanner holds the target for two attempts, as one does right after the file was written.
        syncFs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
            if (refusals-- > 0) {
                throw busy('EPERM');
            }
            renameSync(from, to);
        };
        asyncFs.rename = async (from: fs.PathLike, to: fs.PathLike): Promise<void> => {
            if (refusals-- > 0) {
                throw busy('EBUSY');
            }
            return rename(from, to);
        };
        try {
            const file = inDir('registry.json');
            fs.writeFileSync(file, 'old');
            fs.writeFileSync(inDir('a.tmp'), 'sync');
            refusals = 2;
            renameSyncRetrying(inDir('a.tmp'), file, 'win32');
            assert.strictEqual(fs.readFileSync(file, 'utf8'), 'sync');
            fs.writeFileSync(inDir('b.tmp'), 'async');
            refusals = 2;
            await renameRetrying(inDir('b.tmp'), file, 'win32');
            assert.strictEqual(fs.readFileSync(file, 'utf8'), 'async');

            fs.writeFileSync(inDir('c.tmp'), 'never');
            refusals = 1;
            assert.throws(() => renameSyncRetrying(inDir('c.tmp'), file, 'darwin'), /EPERM/, 'elsewhere EPERM means what it says');
            refusals = 100;
            const started = Date.now();
            assert.throws(() => renameSyncRetrying(inDir('c.tmp'), file, 'win32'), /EPERM/, 'a target held for good fails in the end');
            assert.ok(Date.now() - started < 2_000, `${Date.now() - started} ms blocked`);
            assert.strictEqual(fs.readFileSync(file, 'utf8'), 'async');
        } finally {
            syncFs.renameSync = renameSync;
            asyncFs.rename = rename;
        }
    });

    test('a regular file is still replaced by a rename in its own folder', async () => {
        const file = inDir('plain.json');
        fs.writeFileSync(file, 'old');
        // A hard link keeps the old file: a rename leaves it alone, a rewrite in place changes it.
        // The inode number alone proves nothing: ext4 hands a freed number out again, so after two
        // renames the file can have the number it started with.
        const witness = inDir('plain.witness');
        fs.linkSync(file, witness);
        await writeFileAtomic(file, 'new');
        writeFileAtomicSync(file, 'newer');
        assert.ok(fs.lstatSync(file).isFile());
        assert.strictEqual(fs.readFileSync(witness, 'utf8'), 'old', 'a new file renamed into place, not the old one rewritten');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'newer');
        assert.deepStrictEqual(leftovers(), []);
    });

    test('through a symbolic link the linked file is replaced, keeps its permission bits, and the link stays', async function () {
        if (!POSIX) {
            this.skip();
        }
        // mcp.json -> mcp.real.json beside it, which the user narrowed to 0600.
        const real = inDir('mcp.real.json');
        fs.writeFileSync(real, '{}');
        fs.chmodSync(real, 0o600);
        const file = inDir('mcp.json');
        fs.symlinkSync('mcp.real.json', file);
        const before = fs.statSync(real).ino;
        writeFileAtomicSync(file, '{"servers":1}');
        assert.ok(isLink(file), 'the sync writer kept the link');
        assert.strictEqual(fs.readFileSync(real, 'utf8'), '{"servers":1}');
        assert.notStrictEqual(fs.statSync(real).ino, before, 'replaced by a rename, not rewritten in place');
        await writeFileAtomic(file, '{"servers":2}');
        assert.ok(isLink(file), 'the async writer kept the link');
        assert.strictEqual(fs.readlinkSync(file), 'mcp.real.json');
        assert.strictEqual(fs.readFileSync(real, 'utf8'), '{"servers":2}');
        assert.strictEqual(permissions(real).toString(8), '600');

        // A chain of two links ends at the same file, and the mode option applies to that file.
        const chained = inDir('chained.json');
        fs.symlinkSync(file, chained);
        fs.chmodSync(real, 0o644);
        writeFileAtomicSync(chained, '{"servers":3}', { mode: 0o600 });
        assert.ok(isLink(chained) && isLink(file));
        assert.strictEqual(fs.readFileSync(real, 'utf8'), '{"servers":3}');
        assert.strictEqual(permissions(real).toString(8), '600');

        // `..` after a linked folder in a link's text: the file the system opens, not the lexical one.
        fs.mkdirSync(inDir('deep/inner'), { recursive: true });
        fs.writeFileSync(inDir('deep/settings.json'), 'old');
        fs.writeFileSync(inDir('settings.json'), 'not this one');
        fs.symlinkSync(inDir('deep/inner'), inDir('inner'));
        fs.symlinkSync('inner/../settings.json', inDir('tricky.json'));
        await writeFileAtomic(inDir('tricky.json'), 'new');
        assert.ok(isLink(inDir('tricky.json')));
        assert.strictEqual(fs.readFileSync(inDir('deep/settings.json'), 'utf8'), 'new', 'a read through the link sees the write');
        assert.strictEqual(fs.readFileSync(inDir('settings.json'), 'utf8'), 'not this one');
        assert.deepStrictEqual(leftovers(), []);
        assert.deepStrictEqual(tempFilesIn(inDir('deep')), []);
    });

    test('a link into another folder: the temp file goes beside the linked file; a folder this user may not enter fails', async function () {
        // A rename cannot cross file systems, so the temp file must not go beside the link. A link
        // folder this user may not write to shows where it goes; root writes and enters anywhere.
        if (!POSIX || process.getuid?.() === 0) {
            this.skip();
        }
        const dotfiles = inDir('dotfiles/codex');
        fs.mkdirSync(dotfiles, { recursive: true });
        const real = path.join(dotfiles, 'config.toml');
        fs.writeFileSync(real, 'model = "a"\n');
        const home = inDir('home/.codex');
        fs.mkdirSync(home, { recursive: true });
        const file = path.join(home, 'config.toml');
        fs.symlinkSync(real, file);
        fs.chmodSync(home, 0o555);
        try {
            writeFileAtomicSync(file, 'model = "b"\n');
            assert.strictEqual(fs.readFileSync(real, 'utf8'), 'model = "b"\n');
            await writeFileAtomic(file, 'model = "c"\n');
        } finally {
            fs.chmodSync(home, 0o755);
        }
        assert.ok(isLink(file));
        assert.strictEqual(fs.readlinkSync(file), real);
        assert.strictEqual(fs.readFileSync(real, 'utf8'), 'model = "c"\n');
        assert.deepStrictEqual(fs.readdirSync(home), ['config.toml']);
        assert.deepStrictEqual(fs.readdirSync(dotfiles), ['config.toml']);

        // A link into a folder this user may not enter fails as a plain write does, and stays.
        fs.chmodSync(dotfiles, 0o600);
        try {
            assert.throws(() => writeFileAtomicSync(file, 'model = "d"\n'), /EACCES/);
            await assert.rejects(writeFileAtomic(file, 'model = "d"\n'), /EACCES/);
        } finally {
            fs.chmodSync(dotfiles, 0o755);
        }
        assert.ok(isLink(file));
        assert.strictEqual(fs.readFileSync(real, 'utf8'), 'model = "c"\n');
        assert.deepStrictEqual(fs.readdirSync(home), ['config.toml']);
    });

    test('a dangling link gets the file it names; a link into a missing folder or a loop fails, as a plain write does', async function () {
        if (!POSIX) {
            this.skip();
        }
        // home/.cursor/mcp.json -> ../../dotfiles/cursor/mcp.json, which is not there yet.
        fs.mkdirSync(inDir('dotfiles/cursor'), { recursive: true });
        const home = inDir('home/.cursor');
        fs.mkdirSync(home, { recursive: true });
        const file = path.join(home, 'mcp.json');
        fs.symlinkSync('../../dotfiles/cursor/mcp.json', file);
        writeFileAtomicSync(file, '{"mcpServers":{}}');
        assert.ok(isLink(file));
        assert.strictEqual(fs.readFileSync(inDir('dotfiles/cursor/mcp.json'), 'utf8'), '{"mcpServers":{}}');

        // A chain of dangling links ends at the file the last one names.
        fs.symlinkSync('../../dotfiles/cursor/end.json', path.join(home, 'second.json'));
        fs.symlinkSync('second.json', path.join(home, 'first.json'));
        await writeFileAtomic(path.join(home, 'first.json'), 'end');
        assert.ok(isLink(path.join(home, 'first.json')) && isLink(path.join(home, 'second.json')));
        assert.strictEqual(fs.readFileSync(inDir('dotfiles/cursor/end.json'), 'utf8'), 'end');

        // A relative link in a linked folder is read from the folder it really lies in:
        // home/.gemini -> dotfiles/gemini, whose settings.json -> ../shared/settings.json.
        fs.mkdirSync(inDir('dotfiles/gemini'));
        fs.mkdirSync(inDir('dotfiles/shared'));
        fs.symlinkSync(inDir('dotfiles/gemini'), inDir('home/.gemini'));
        fs.symlinkSync('../shared/settings.json', inDir('dotfiles/gemini/settings.json'));
        writeFileAtomicSync(inDir('home/.gemini/settings.json'), '{"a":1}');
        await writeFileAtomic(inDir('home/.gemini/settings.json'), '{"a":2}');
        assert.ok(isLink(inDir('dotfiles/gemini/settings.json')));
        assert.strictEqual(fs.readFileSync(inDir('dotfiles/shared/settings.json'), 'utf8'), '{"a":2}');

        // A link into a folder that does not exist, and a loop, fail as a plain write does, and stay.
        const lost = path.join(home, 'lost.json');
        fs.symlinkSync(inDir('gone/lost.json'), lost);
        assert.throws(() => writeFileAtomicSync(lost, '{}'), /ENOENT/);
        await assert.rejects(writeFileAtomic(lost, '{}'), /ENOENT/);
        assert.ok(isLink(lost));
        const loop = path.join(home, 'loop.json');
        fs.symlinkSync('loop-back.json', loop);
        fs.symlinkSync('loop.json', path.join(home, 'loop-back.json'));
        assert.throws(() => writeFileAtomicSync(loop, '{}'), /ELOOP/);
        await assert.rejects(writeFileAtomic(loop, '{}'), /ELOOP/);
        assert.ok(isLink(loop) && isLink(path.join(home, 'loop-back.json')));
        for (const folder of [home, inDir('dotfiles/cursor'), inDir('dotfiles/shared')]) {
            assert.deepStrictEqual(tempFilesIn(folder), [], folder);
        }
    });

    test('a linked folder in the path stays a link, and its file is written where the folder lies', async function () {
        if (!POSIX) {
            this.skip();
        }
        // home/.codex -> dotfiles/codex: a new file, then a replaced one, both in dotfiles/codex.
        fs.mkdirSync(inDir('dotfiles/codex'), { recursive: true });
        fs.mkdirSync(inDir('home'));
        fs.symlinkSync(inDir('dotfiles/codex'), inDir('home/.codex'));
        const file = inDir('home/.codex/config.toml');
        writeFileAtomicSync(file, 'one');
        await writeFileAtomic(file, 'two');
        assert.ok(isLink(inDir('home/.codex')));
        assert.ok(fs.lstatSync(inDir('dotfiles/codex/config.toml')).isFile());
        assert.strictEqual(fs.readFileSync(inDir('dotfiles/codex/config.toml'), 'utf8'), 'two');
        assert.deepStrictEqual(fs.readdirSync(inDir('dotfiles/codex')), ['config.toml']);
    });
});
