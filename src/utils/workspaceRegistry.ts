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
 * The machine-wide list of CMSIS Developer Assistant windows. Each window
 * keeps one small JSON file in a shared temp directory that says how to reach
 * its control server, which folders it has open and whether it is debugging;
 * the router window reads them all to decide where a tool call runs.
 *
 * The file format is shared by every installed version of the extension, so
 * windows of different versions can find each other: keep it stable, and
 * ignore fields you do not know. Readers tidy up as they go, dropping entries
 * of processes that are gone and entries that stopped being refreshed. The
 * one exception is the router's entry (#14): while its process lives it is
 * only skipped, so that the other windows can tell that the window holding
 * the MCP port has stopped running (`findStaleRouter`).
 *
 * Since 2.5.1 an entry also says what the window is doing: its role, the
 * extension version, the event-loop delay of the last heartbeat interval and
 * the agent calls running there for more than 10 s (#14). Since 2.7.0 it
 * lists the local GDB ports the window's live debug sessions and CMSIS Run
 * tasks use (`gdbPorts`), so that a launch elsewhere on the same port is
 * refused (`src/core/gdbPortGuard.ts`).
 *
 * The files carry each window's control token, so only this user may read
 * them (#19): the directory is 0700 and the files 0600. Where the temp
 * directory is shared by all users (Linux /tmp) the directory name carries
 * the uid (`resolveRegistryDir`); a directory that is a symbolic link or
 * belongs to someone else is not used at all (`ensureRegistryDir`), and the
 * window then works on its own.
 *
 * Beside the window files the directory holds `default-target.json`: the
 * window the user chose with Select Target Window (#16) for agent calls
 * that nothing else aims. Readers of older versions skip it by its name.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gdbPortClaimsOf, type GdbPortClaim } from '../core/gdbServerPorts';
import { busyText, lagText } from '../core/windowHealth';
import { isTempPath, writeFileAtomic, writeFileAtomicSync } from './atomicFile';
import { logger } from './logger';

/** What a window does: serve MCP and forward every call (router), or run what is forwarded to it (worker). */
export type WindowRole = 'router' | 'worker';

/** An agent call that had run in a window for more than 10 s at its last heartbeat (#14). */
export interface BusyCall {
    /** The tool, as agents know it. */
    tool: string;
    /** When the call started there, milliseconds since the epoch. */
    since: number;
    /** True once its fence answered the agent `WORKER_TIMEOUT`; it runs on. */
    fenced?: boolean;
}

/** The event-loop delay of a window over its last heartbeat interval, milliseconds (#14). */
export interface EventLoopLag {
    p99: number;
    max: number;
}

/** One window's registry file, as written by its owner. */
export interface WindowRegistration {
    /** Extension-host process of the window; the identity of the entry. */
    pid: number;
    /** Loopback port of the window's control server. */
    controlPort: number;
    /** Sent back in the control request's token header. */
    controlToken: string;
    /** Absolute file-system paths; empty when no folder is open. */
    workspaceFolders: string[];
    name: string;
    /** Last write, milliseconds since the epoch. */
    updatedAt: number;
    hasActiveSession?: boolean;
    activeConfigurationName?: string;
    cmsisProject?: string;
    /** Written since 2.5.1; the entries of older windows have none. */
    role?: WindowRole;
    /** The extension version; since 2.5.1. */
    version?: string;
    /** The event-loop delay of the last heartbeat interval; since 2.5.1, from the first heartbeat on. */
    lagMs?: EventLoopLag;
    /** The agent calls running here for more than 10 s at the last heartbeat; none when there are none. */
    busy?: BusyCall[];
    /**
     * The local GDB ports this window's live debug sessions and CMSIS Run
     * tasks use; since 2.7.0, none when there are none. Read it through
     * `gdbPortClaimsOf()`, which drops what it does not know.
     */
    gdbPorts?: GdbPortClaim[];
    /** First in the file, for whoever opens it: it says the file is internal. Readers ignore it. */
    _note?: string;
}

/** What a heartbeat brings up to date besides the time (#14); a field given as undefined is dropped. */
export type HeartbeatPatch = Partial<Pick<WindowRegistration, 'busy' | 'lagMs'>>;

/**
 * Why the router picked a window, strongest first: the call's `window`
 * argument, its file path, the session's pin, the window it reached before,
 * the default target, the one debugging window, the one window. It shows up
 * in the routing log line and in the router's status bar.
 */
export type ResolutionReason = 'window-arg' | 'path' | 'pinned' | 'cached' | 'default' | 'active-session' | 'only-window' | 'router-window';

/**
 * The window the user chose with Select Target Window (#16), for the agent
 * calls that nothing else aims. Found again by pid, or by its folder after a
 * reload gave the window a new pid.
 */
export interface DefaultTarget {
    /** Extension-host process of the chosen window. */
    pid: number;
    /** Its first workspace folder; none for a window without a folder. */
    workspaceFolder?: string;
    /** Its name when it was chosen, for texts that mention it while it is closed. */
    name?: string;
    /** When it was chosen, milliseconds since the epoch; a new value makes the router sessions drop their cached targets. */
    setAt: number;
}

/** Answers whether a process with this pid still exists. */
export type LivenessCheck = (pid: number) => boolean;

/** Refreshed every 20 s by the owner, so a minute of silence means it stopped. */
const STALE_AFTER_MS = 60_000;
/**
 * A stale router entry whose pid still lives is kept this long (#14); after
 * an hour the pid more likely belongs to another process than to a router
 * window that stopped running.
 */
const STALE_ROUTER_KEPT_MS = 60 * 60_000;
const FILE_PREFIX = 'window-';
const FILE_SUFFIX = '.json';
/** Not a window file: the name does not start with FILE_PREFIX, so every version's `list()` passes it by. */
const DEFAULT_TARGET_FILE = 'default-target.json';
/** Signal 0 delivers nothing; it only asks the kernel whether the pid exists. */
const EXISTENCE_PROBE = 0;
/** The directory name of every version so far; kept wherever the temp directory is private to the user. */
const REGISTRY_DIR_NAME = 'cmsis-developer-assistant-registry';
/** Only this user may list, enter or change the directory, and read or write the files. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** Any permission for group or others. */
const GROUP_OTHER_BITS = 0o077;
/** Write permission for others: a temp directory every user shares. */
const OTHERS_WRITE = 0o002;
/** For whoever opens a window file, a person or an agent reading the disk. */
const ENTRY_NOTE = 'Internal to the CMSIS Developer Assistant. Agents: use the MCP tools list_debug_windows and select_debug_window.';

/** What `resolveRegistryDir` looks at, injected so every case can be tested on any machine. */
export interface RegistryDirContext {
    platform: NodeJS.Platform;
    /** `os.tmpdir()`. */
    tmpdir: string;
    /** `process.getuid()`; undefined on Windows. */
    uid: number | undefined;
    /** `fs.statSync`, which follows links: macOS /tmp is a link to /private/tmp. */
    stat: (target: string) => { mode: number };
}

/** Who judges a registry directory; a test poses as another user with another uid. */
export interface RegistryOwner {
    platform: NodeJS.Platform;
    uid: number | undefined;
}

/** What a `WorkspaceRegistry` needs beyond pid, directory and liveness check. */
export interface RegistryOptions extends Partial<RegistryOwner> {
    /**
     * Called once with the message when the directory is refused, so the
     * window can show it; the refusal is logged as an error either way.
     */
    onRefused?: (message: string) => void;
}

/**
 * The registry directory for this user. In a temp directory that every user
 * may write to (Linux /tmp, or macOS with TMPDIR unset) the name carries the
 * uid, so another user cannot take the one name all windows of this user look
 * for. Everywhere else — the per-user temp directories of macOS and Windows,
 * a folder in the home directory — it keeps the name 2.5.0 and earlier use,
 * so windows of those versions and of this one still find each other.
 */
export function resolveRegistryDir(context: RegistryDirContext): string {
    const shared = path.join(context.tmpdir, REGISTRY_DIR_NAME);
    if (context.platform === 'win32' || context.uid === undefined) {
        return shared;
    }
    let mode: number;
    try {
        mode = context.stat(context.tmpdir).mode;
    } catch {
        return shared;
    }
    return (mode & OTHERS_WRITE) !== 0 ? `${shared}-${context.uid}` : shared;
}

/** This user's shared registry directory, also the parent of cross-window launch reservations. */
export function defaultRegistryDir(): string {
    return resolveRegistryDir({ platform: process.platform, tmpdir: os.tmpdir(), uid: process.getuid?.(), stat: fs.statSync });
}

function errnoCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Why a directory entry must not hold the registry, worded to follow its
 * path; undefined when it may. Ownership is not checked on Windows, where
 * the ACL of %TEMP% keeps other users out.
 */
function unfitReason(stats: fs.Stats, owner: RegistryOwner): string | undefined {
    if (stats.isSymbolicLink()) {
        return 'is a symbolic link';
    }
    if (!stats.isDirectory()) {
        return 'is not a directory';
    }
    if (owner.platform !== 'win32' && owner.uid !== undefined && stats.uid !== owner.uid) {
        return 'belongs to another user';
    }
    return undefined;
}

/** `lstat` of the path, or undefined when nothing is there. */
function lstatIfPresent(target: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(target);
    } catch (error) {
        if (errnoCode(error) === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

/**
 * Make `dir` ready for this user's registry, or say why it cannot be. A
 * missing directory is created 0700. An existing one must be a directory,
 * not a symbolic link, and on POSIX belong to this user; one that others may
 * still enter (2.5.0 left it 0755) is narrowed to 0700.
 * @returns undefined when the directory is fit, else the reason it is not.
 */
export function ensureRegistryDir(dir: string, owner: RegistryOwner): string | undefined {
    if (lstatIfPresent(dir) === undefined) {
        fs.mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
    }
    // Looked at again after the mkdir: whatever stands there now is what gets judged.
    const stats = fs.lstatSync(dir);
    const reason = unfitReason(stats, owner);
    if (reason === undefined && owner.platform !== 'win32' && (stats.mode & GROUP_OTHER_BITS) !== 0) {
        try {
            fs.chmodSync(dir, DIRECTORY_MODE);
        } catch (error) {
            logger.warn(`Could not narrow ${dir} to mode 0700; the window files in it stay 0600`, error);
        }
    }
    return reason;
}

/**
 * True while `pid` names a running process. A process of another user
 * answers the probe with EPERM, which still proves it exists.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, EXISTENCE_PROBE);
        return true;
    } catch (probeError) {
        return errnoCode(probeError) === 'EPERM';
    }
}

/** Remove a file; one that a peer already removed, or that cannot go, is left be. */
function discard(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch {
        // Gone already, or not ours to remove: either way nothing to do.
    }
}

/** Milliseconds since the file was last modified, or undefined when that cannot be read. */
function ageOf(file: string): number | undefined {
    try {
        return Date.now() - fs.statSync(file).mtimeMs;
    } catch {
        return undefined;
    }
}

/** Remove a file only once it is old enough that no writer can still be busy with it. */
function discardIfAbandoned(file: string): void {
    const age = ageOf(file);
    if (age !== undefined && age > STALE_AFTER_MS) {
        discard(file);
    }
}

/** A folder list that is safe to iterate, whatever the file held. */
export function foldersOf(entry: WindowRegistration): string[] {
    return Array.isArray(entry.workspaceFolders) ? entry.workspaceFolders : [];
}

/** A registry file that passed the pruning rules, and whether it is stale (only a router's can be). */
interface Admitted {
    entry: WindowRegistration;
    stale: boolean;
}

/**
 * The form in which paths are compared: absolute, lower-case on Windows,
 * without trailing separators (so the root becomes the empty string).
 */
function comparable(p: string): string {
    const absolute = path.resolve(p);
    const folded = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    return folded.replace(/[\\/]+$/, '');
}

/** Whether `target` is `folder` itself or lies below it; both in comparable form. */
function liesWithin(target: string, folder: string): boolean {
    if (target === folder) {
        return true;
    }
    return target.startsWith(`${folder}${path.sep}`) || target.startsWith(`${folder}/`);
}

/** True when the window has `folder` itself open; any window when no folder is asked for. */
function holdsFolder(entry: WindowRegistration, folder: string | undefined): boolean {
    if (folder === undefined) {
        return true;
    }
    const wanted = comparable(folder);
    return foldersOf(entry).some((open) => comparable(open) === wanted);
}

/**
 * The default target a parsed file holds: its known fields, checked one by
 * one; undefined when the pid or the time is missing or of the wrong type.
 */
function defaultTargetOf(parsed: unknown): DefaultTarget | undefined {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return undefined;
    }
    const { pid, workspaceFolder, name, setAt } = parsed as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof setAt !== 'number' || !Number.isFinite(setAt)) {
        return undefined;
    }
    const target: DefaultTarget = { pid, setAt };
    if (typeof workspaceFolder === 'string' && workspaceFolder.length > 0) {
        target.workspaceFolder = workspaceFolder;
    }
    if (typeof name === 'string') {
        target.name = name;
    }
    return target;
}

export class WorkspaceRegistry {
    /** Private shared directory for launch reservations; separate from the versioned window records. */
    gdbReservationDirectory(): string {
        return path.join(this.registryDir, 'gdb-port-reservations');
    }

    private readonly ownFile: string;
    private readonly defaultFile: string;
    private readonly owner: RegistryOwner;
    private readonly onRefused: ((message: string) => void) | undefined;
    /** What this window last asked to publish; the heartbeat rewrites it. */
    private published: WindowRegistration | undefined;
    /** The refusal last reported, so a heartbeat does not repeat it every 20 s. */
    private reportedRefusal: string | undefined;

    constructor(
        private readonly pid: number = process.pid,
        private readonly registryDir: string = defaultRegistryDir(),
        private readonly isAlive: LivenessCheck = isProcessAlive,
        options: RegistryOptions = {},
    ) {
        this.ownFile = path.join(registryDir, `${FILE_PREFIX}${pid}${FILE_SUFFIX}`);
        this.defaultFile = path.join(registryDir, DEFAULT_TARGET_FILE);
        this.owner = { platform: options.platform ?? process.platform, uid: options.uid ?? process.getuid?.() };
        this.onRefused = options.onRefused;
    }

    /** The pid this window registers under: the identity of its entry. */
    ownPid(): number {
        return this.pid;
    }

    /** Publish (or republish) this window. Logs instead of throwing. */
    register(reg: Omit<WindowRegistration, 'pid' | 'updatedAt' | '_note'>): void {
        this.published = { _note: ENTRY_NOTE, ...reg, pid: this.pid, updatedAt: Date.now() };
        this.writeOwnFile(this.published, 'Could not write this window into the CMSIS Developer Assistant window registry');
    }

    /**
     * Rewrite the last registration with a new timestamp and what `patch`
     * brings up to date: the busy calls and the event-loop lag (#14). It
     * never reads the file first, so an entry a peer removed by mistake
     * comes back.
     */
    heartbeat(patch: HeartbeatPatch = {}): void {
        const current = this.published;
        if (!current) {
            return;
        }
        Object.assign(current, patch);
        current.updatedAt = Date.now();
        this.writeOwnFile(current, 'Failed to refresh CMSIS Developer Assistant registry entry');
    }

    /** Withdraw this window. Never throws. */
    unregister(): void {
        this.published = undefined;
        if (this.readRefusal() === undefined) {
            discard(this.ownFile);
        }
    }

    /**
     * Every live registration, in directory order, pruning dead, stale and
     * broken files on the way. A stale router entry whose process lives is
     * skipped but kept, for `findStaleRouter` (#14). A directory this user
     * must not trust is not read at all: the window then sees only itself, so
     * its own tool calls still run while the other windows stay out of reach.
     */
    list(): WindowRegistration[] {
        return this.scan(Date.now()).filter((found) => !found.stale).map((found) => found.entry);
    }

    /**
     * The entry of a router window that stopped refreshing it while its
     * process lives (#14): its extension host is blocked, so it holds the MCP
     * port and serves nothing. The newest such entry; none in a directory
     * this user must not trust.
     */
    findStaleRouter(now: number = Date.now()): WindowRegistration | undefined {
        const stale = this.scan(now).filter((found) => found.stale).map((found) => found.entry);
        return stale.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    }

    /** The window whose folder most deeply contains `targetPath`. */
    findByPath(targetPath: string): WindowRegistration | undefined {
        const windows = this.list();
        const target = comparable(targetPath);
        let owner: WindowRegistration | undefined;
        let ownerDepth = -1;
        for (const candidate of windows) {
            for (const folder of foldersOf(candidate)) {
                const key = comparable(folder);
                // Strictly longer only: on a tie the window listed first keeps it.
                if (key.length > ownerDepth && liesWithin(target, key)) {
                    owner = candidate;
                    ownerDepth = key.length;
                }
            }
        }
        if (owner) {
            return owner;
        }
        // A lone window without folders may take any path; nobody else can claim it.
        const lone = windows.length === 1 ? windows[0] : undefined;
        return lone && foldersOf(lone).length === 0 ? lone : undefined;
    }

    /** The one window with a debug session; none when there are zero or several. */
    findSoleActiveSession(): WindowRegistration | undefined {
        const debugging = this.list().filter((candidate) => candidate.hasActiveSession);
        return debugging.length === 1 ? debugging[0] : undefined;
    }

    /** The one registered window; none when there are zero or several. */
    findSoleWindow(): WindowRegistration | undefined {
        const windows = this.list();
        return windows.length === 1 ? windows[0] : undefined;
    }

    findByPid(pid: number): WindowRegistration | undefined {
        return this.list().find((candidate) => candidate.pid === pid);
    }

    /** The folder itself or any path inside it, with the same folderless fallback. */
    findByWorkspaceFolder(folder: string): WindowRegistration | undefined {
        return this.findByPath(folder);
    }

    /** Still registered under the same pid and the same control port. */
    isLive(entry: WindowRegistration): boolean {
        const current = this.findByPid(entry.pid);
        return current !== undefined && current.controlPort === entry.controlPort;
    }

    /**
     * The default target the user chose, or undefined: none chosen, a file
     * that does not hold one, or a directory this user must not trust (#19),
     * since whoever writes the file steers path-less agent calls. Fields this
     * version does not know are ignored.
     */
    readDefaultTarget(): DefaultTarget | undefined {
        if (this.readRefusal() !== undefined) {
            return undefined;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(this.defaultFile, 'utf8'));
        } catch {
            // None chosen, or a write in flight: either way no default for this call.
            return undefined;
        }
        return defaultTargetOf(parsed);
    }

    /**
     * Save the default target, 0600, in the registry directory once it is fit
     * for it. Rejects with the reason when the directory is refused or the
     * write fails.
     */
    async writeDefaultTarget(target: DefaultTarget): Promise<void> {
        const refusal = ensureRegistryDir(this.registryDir, this.owner);
        if (refusal !== undefined) {
            throw new Error(`${this.registryDir} ${refusal}`);
        }
        await writeFileAtomic(this.defaultFile, JSON.stringify(target), { mode: FILE_MODE });
    }

    /** Forget the default target; none saved is fine. A refused directory is left alone. */
    async clearDefaultTarget(): Promise<void> {
        if (this.readRefusal() !== undefined) {
            return;
        }
        try {
            await fs.promises.unlink(this.defaultFile);
        } catch (error) {
            if (errnoCode(error) !== 'ENOENT') {
                throw error;
            }
        }
    }

    /**
     * The open window the default target names: the window with its pid while
     * that window still has the chosen folder open (a pid the system reused
     * for another window does not count), else — after a reload gave the
     * window a new pid — the one window with that folder open.
     */
    findDefaultTarget(target: DefaultTarget, windows: readonly WindowRegistration[] = this.list()): WindowRegistration | undefined {
        const byPid = windows.find((candidate) => candidate.pid === target.pid);
        if (byPid !== undefined && holdsFolder(byPid, target.workspaceFolder)) {
            return byPid;
        }
        if (target.workspaceFolder === undefined) {
            return undefined;
        }
        const holders = windows.filter((candidate) => holdsFolder(candidate, target.workspaceFolder));
        return holders.length === 1 ? holders[0] : undefined;
    }

    /** Write this window's file, 0600, into a directory fit for it; logs instead of throwing. */
    private writeOwnFile(entry: WindowRegistration, failure: string): void {
        try {
            const refusal = ensureRegistryDir(this.registryDir, this.owner);
            if (refusal !== undefined) {
                this.refuse(refusal);
                return;
            }
            this.reportedRefusal = undefined;
            writeFileAtomicSync(this.ownFile, JSON.stringify(entry), { mode: FILE_MODE });
        } catch (error) {
            logger.error(failure, error);
        }
    }

    /** Log a refused directory as an error and hand it to `onRefused`, once per distinct refusal. */
    private refuse(reason: string): void {
        const message = `Multi-window routing is off in this window: ${this.registryDir} ${reason}. `
            + 'Remove it, or ask its owner to; the window registers again at its next refresh.';
        if (message === this.reportedRefusal) {
            return;
        }
        this.reportedRefusal = message;
        logger.error(message);
        try {
            this.onRefused?.(message);
        } catch (error) {
            logger.warn('Could not show the registry warning', error);
        }
    }

    /** Why the directory must not be read, or undefined when it may (a missing one included). */
    private readRefusal(): string | undefined {
        try {
            const stats = lstatIfPresent(this.registryDir);
            return stats === undefined ? undefined : unfitReason(stats, this.owner);
        } catch {
            // Not even lstat works here; the readdir that follows fails the same way and finds nothing.
            return undefined;
        }
    }

    /** Every registration that passes the pruning rules, a kept stale router entry marked as such. */
    private scan(now: number): Admitted[] {
        if (this.readRefusal() !== undefined) {
            return this.published ? [{ entry: this.published, stale: false }] : [];
        }
        let names: string[];
        try {
            names = fs.readdirSync(this.registryDir);
        } catch {
            return [];
        }
        const found: Admitted[] = [];
        for (const name of names) {
            const admitted = this.admit(name, now);
            if (admitted) {
                found.push(admitted);
            }
        }
        return found;
    }

    /** One directory entry through the pruning rules: the registration and whether it is stale, or undefined. */
    private admit(name: string, now: number): Admitted | undefined {
        const file = path.join(this.registryDir, name);
        // Checked before the name filter: `window-7.json.7.0badc0de.tmp` ends in `.tmp`.
        if (isTempPath(name)) {
            discardIfAbandoned(file);
            return undefined;
        }
        if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) {
            return undefined;
        }
        let entry: WindowRegistration;
        let owner: number;
        try {
            entry = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowRegistration;
            owner = entry.pid;
        } catch {
            // A fresh unreadable file may be a peer's write in flight.
            discardIfAbandoned(file);
            return undefined;
        }
        if (!this.isAlive(owner)) {
            discard(file);
            return undefined;
        }
        // The reader's own entry is never pruned for age, only other windows' ones.
        const age = now - entry.updatedAt;
        if (owner === this.pid || !(age > STALE_AFTER_MS)) {
            return { entry, stale: false };
        }
        // A router that stopped refreshing still holds the MCP port: its entry names it (#14).
        if (entry.role === 'router' && age <= STALE_ROUTER_KEPT_MS) {
            return { entry, stale: true };
        }
        discard(file);
        return undefined;
    }
}

/**
 * One line naming a window for agents: pid, folders, `router` for the window
 * that serves MCP, the debug session, the CMSIS solution, the calls busy
 * there, a noticeable event-loop lag (#14) and the GDB ports its sessions
 * and CMSIS Run tasks use, joined by ` | `. The control port and token never
 * appear. `now` dates the busy calls.
 */
export function describeWindow(entry: WindowRegistration, now: number = Date.now()): string {
    const folders = foldersOf(entry);
    const parts: string[] = [
        `pid=${entry.pid}`,
        folders.length > 0 ? folders.join(', ') : '(no folder open)',
    ];
    if (entry.role === 'router') {
        parts.push('router');
    }
    if (entry.hasActiveSession) {
        parts.push(entry.activeConfigurationName ? `debugging: ${entry.activeConfigurationName}` : 'debugging');
    }
    if (entry.cmsisProject) {
        parts.push(`cmsis=${entry.cmsisProject}`);
    }
    const busy = busyText(entry.busy, now);
    if (busy.length > 0) {
        parts.push(busy);
    }
    const lag = lagText(entry.lagMs);
    if (lag.length > 0) {
        parts.push(lag);
    }
    const ports = gdbPortClaimsOf(entry.gdbPorts);
    if (ports.length > 0) {
        parts.push(`GDB port ${ports.map((claim) => `${claim.port} (${claim.label})`).join(', ')}`);
    }
    return parts.join(' | ');
}
