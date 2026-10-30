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
 * Write a file through a temp file and a rename, so a reader never sees a
 * half-written file and a crash mid-write leaves the previous content in
 * place. The temp name carries the pid and a random suffix: every VS Code
 * window is its own extension-host process, and several of them write the
 * same agent configurations and registry files at activation.
 *
 * The temp file is always created new (`wx`), so a `mode` given here is the
 * mode of the result: the rename keeps the temp file's inode. The window
 * registry writes 0600 this way; on Windows the mode is ignored and the
 * folder's ACL applies. Without a `mode`, a file that is replaced keeps its
 * permission bits: an agent's configuration file, which may hold tokens and
 * which its owner narrowed to 0600, must not come back readable by others.
 *
 * A symbolic link is written through, as a plain write would be: the rename
 * replaces the file the link names and the link stays, so an agent's file
 * kept in a dotfiles repository and linked into the home directory stays
 * linked. The temp file is made beside that file, since a rename cannot
 * cross file systems. A dangling link gets the file it names created. Where
 * a plain write would fail, so does this one, and the link stays: a link
 * into a missing folder (ENOENT) or into one this user may not enter
 * (EACCES, EPERM), a loop (ELOOP).
 *
 * On Windows a rename onto a file that a virus scanner or another reader
 * holds open fails for a moment (EPERM, EACCES, EBUSY); the rename is tried
 * again a few times before the write fails, as npm's graceful-fs does. A
 * window registry entry that kept its last state, "debugging" after the
 * session had ended, is what a lost write looks like.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** How the atomic writers create the file. */
export interface AtomicWriteOptions {
    /**
     * Permission bits of the written file, less the umask. The default is
     * the bits of the file being replaced, or 0666 less the umask for a new file.
     */
    mode?: number;
}

/** `<file>.<pid>.<random>.tmp` — unique per process and per call. */
export function tempPathFor(filePath: string): string {
    return `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

/** True for a name `tempPathFor` produced (any pid). */
export function isTempPath(name: string): boolean {
    return /\.\d+\.[0-9a-f]{8}\.tmp$/.test(name);
}

/** Only the permission bits of a `stat` mode. */
const PERMISSION_BITS = 0o777;

/** `writeFile` options for the temp file: UTF-8, created exclusively, with the given mode. */
function tempFileOptions(mode: number | undefined): fs.WriteFileOptions {
    return { encoding: 'utf8', flag: 'wx', mode };
}

/** The requested mode, else the permission bits of the file being replaced; none for a new file. */
function modeFor(filePath: string, options: AtomicWriteOptions): number | undefined {
    if (options.mode !== undefined) {
        return options.mode;
    }
    try {
        return fs.statSync(filePath).mode & PERMISSION_BITS;
    } catch {
        return undefined;
    }
}

/** `modeFor` without blocking the event loop. */
async function modeForAsync(filePath: string, options: AtomicWriteOptions): Promise<number | undefined> {
    if (options.mode !== undefined) {
        return options.mode;
    }
    return fs.promises.stat(filePath).then((stats) => stats.mode & PERMISSION_BITS, () => undefined);
}

/** The exclusive create found the temp name taken: that file is not this call's to remove. */
function takenBefore(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

/**
 * What Windows answers a rename onto a file that another process holds open
 * without sharing its deletion — a virus scanner that looks at the file just
 * written, an indexer: gone a moment later. Elsewhere these codes mean what
 * they say and are not retried.
 */
const RENAME_BUSY: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** The waits before each retry of a busy rename, in ms: 310 ms in all, so a blocking write stays short. */
const RENAME_RETRY_SYNC_MS = [10, 20, 40, 80, 160];
/** The waits of the asynchronous writer, which blocks nothing: 1.27 s in all. */
const RENAME_RETRY_MS = [10, 20, 40, 80, 160, 320, 640];

/** Is this error of a rename one to try again after `attempt` retries? */
function retryRename(error: unknown, attempt: number, waits: readonly number[], platform: NodeJS.Platform): boolean {
    return platform === 'win32' && attempt < waits.length && RENAME_BUSY.has((error as NodeJS.ErrnoException | undefined)?.code ?? '');
}

/** `fs.renameSync`, retried for a while on Windows when the target is held open for the moment. */
export function renameSyncRetrying(from: string, to: string, platform: NodeJS.Platform = process.platform): void {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (error) {
            if (!retryRename(error, attempt, RENAME_RETRY_SYNC_MS, platform)) {
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_SYNC_MS[attempt]);
        }
    }
}

/** `renameSyncRetrying` without blocking the event loop. */
export async function renameRetrying(from: string, to: string, platform: NodeJS.Platform = process.platform): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await fs.promises.rename(from, to);
            return;
        } catch (error) {
            if (!retryRename(error, attempt, RENAME_RETRY_MS, platform)) {
                throw error;
            }
            await new Promise((later) => setTimeout(later, RENAME_RETRY_MS[attempt]));
        }
    }
}

/** Links of a dangling chain followed by hand at most: as many as Linux follows in a path (macOS: 32); a longer chain is a loop. */
const MAX_LINK_HOPS = 40;

/** The link leads to a name with nothing there: a dangling link, which the write follows. */
function dangling(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * The path a link's text names, read from the folder that holds the link.
 * The joined path is left unnormalized: `..` in it must step out of the
 * folder the link really lies in, which may be reached through a linked
 * folder (`~/.gemini` → `dotfiles/gemini`, holding `settings.json` →
 * `../shared/settings.json`), and only the system's realpath knows that one.
 */
function linkedName(link: string, text: string): string {
    return path.isAbsolute(text) ? text : `${path.dirname(link)}${path.sep}${text}`;
}

/** `linkedName` with its folder resolved by the system; as joined when that folder is missing too, where the write then fails. */
function linkedPathSync(link: string, text: string): string {
    const named = linkedName(link, text);
    try {
        return path.join(fs.realpathSync.native(path.dirname(named)), path.basename(named));
    } catch {
        return named;
    }
}

/** `linkedPathSync` without blocking the event loop (`fs.promises.realpath` is the system's realpath too). */
async function linkedPath(link: string, text: string): Promise<string> {
    const named = linkedName(link, text);
    return fs.promises.realpath(path.dirname(named)).then((folder) => path.join(folder, path.basename(named)), () => named);
}

/**
 * The file a write to `filePath` replaces: the path itself unless it is a
 * symbolic link; through a link, the real path of the file it leads to, or,
 * for a dangling link, the name its chain ends at. A path that is not a link
 * costs one `readlink` and stays as given: no `/private` in front on macOS,
 * no long form of a short name or UNC path of a mapped drive on Windows.
 * The real path is the system's (`realpath.native`): `fs.realpathSync`
 * walks a link's text lexically, so `a/../b` with `a` a link names a
 * different file than the one a plain write would change. Throws what the
 * system reports for a link it cannot follow (ELOOP, EACCES), as a plain
 * write would.
 */
function writeTargetSync(filePath: string): string {
    let target = filePath;
    for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
        let text: string;
        try {
            text = fs.readlinkSync(target);
        } catch {
            // Not a link (EINVAL), or nothing there yet (ENOENT): the file goes here.
            return target;
        }
        try {
            return fs.realpathSync.native(target);
        } catch (error) {
            if (!dangling(error)) {
                throw error;
            }
        }
        target = linkedPathSync(target, text);
    }
    throw tooManyLinks(filePath);
}

/** `writeTargetSync` without blocking the event loop. */
async function writeTarget(filePath: string): Promise<string> {
    let target = filePath;
    for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
        let text: string;
        try {
            text = await fs.promises.readlink(target);
        } catch {
            return target;
        }
        try {
            return await fs.promises.realpath(target);
        } catch (error) {
            if (!dangling(error)) {
                throw error;
            }
        }
        target = await linkedPath(target, text);
    }
    throw tooManyLinks(filePath);
}

/** A dangling chain longer than `MAX_LINK_HOPS`; the system refuses such a chain too (ELOOP). */
function tooManyLinks(filePath: string): Error {
    return new Error(`Not written: ${filePath} leads through more than ${MAX_LINK_HOPS} symbolic links`);
}

/**
 * Replace the file at `filePath` with `content` (UTF-8) in one step; through
 * a symbolic link, the file the link names. Throws what following the link,
 * the write or the rename threw, and leaves no temp file of its own behind.
 */
export function writeFileAtomicSync(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
    const target = writeTargetSync(filePath);
    const tmp = tempPathFor(target);
    try {
        fs.writeFileSync(tmp, content, tempFileOptions(modeFor(target, options)));
        renameSyncRetrying(tmp, target);
    } catch (error) {
        if (!takenBefore(error)) {
            try { fs.unlinkSync(tmp); } catch { /* never written, or already renamed */ }
        }
        throw error;
    }
}

/** `writeFileAtomicSync` without blocking the event loop. */
export async function writeFileAtomic(filePath: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
    const target = await writeTarget(filePath);
    const tmp = tempPathFor(target);
    try {
        await fs.promises.writeFile(tmp, content, tempFileOptions(await modeForAsync(target, options)));
        await renameRetrying(tmp, target);
    } catch (error) {
        if (!takenBefore(error)) {
            await fs.promises.unlink(tmp).catch(() => undefined);
        }
        throw error;
    }
}
