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
 * What the debugging handler takes from its surroundings apart from the
 * executor: a clock, VS Code's focused stack frame, the window's CMSIS job
 * tracker, its owned serial port, the workspace folders, the active target's
 * cbuild-run file (for `flash` and `cmsis_action`), where `flash` looks for
 * pyOCD and which probe it selects, where the hints after a failed J-Link
 * task or GDB server start look its program up, what `cmsis_action
 * install_pack` asks, the CMSIS Solution extension behind `cmsis_query`, and
 * who holds a GDB port a launch is about to use.
 *
 * The default reads VS Code at the moment of each call, never at load time,
 * so the transport harness can swap parts of its `vscode` stub between
 * scenarios. Unit tests hand the handler their own host instead: a scaled
 * clock turns a 60 s fence or an 8 s session wait into milliseconds, and a
 * tracker over fake task events lets a test end a task by hand.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { CmsisJobTracker, windowJobTracker } from '../cmsisJobTracker';
import { SOLUTION_EXTENSION_ID } from '../core/bootstrapState';
import { fileExists } from '../core/flashController';
import { findGdbPortHolder, type GdbPortHolder, type PortStart } from '../core/gdbPortGuard';
import { GdbPortReservations, type GdbPortReservation } from '../core/gdbPortReservations';
import { SerialController, serialController } from '../core/serialController';
import { activeCbuildRunFile } from '../utils/solutionQueries';
import { PackInstallHost, VSCODE_PACK_INSTALL_HOST } from './installPack';
import type { SolutionExtensionHandle } from '../core/solutionApi';
import type { CatalogFetch } from '../core/webCatalog';

/** An installed extension, as the pyOCD lookup of `flash` needs it. */
export interface InstalledExtension {
    path: string;
    version?: string;
}

/**
 * Where `flash` looks for pyOCD — an extension's folder, this process's
 * PATH, the platform — and what the hints after a failed J-Link task or
 * GDB server start read to look a program up (`src/handler/taskProgram.ts`).
 * The optional members fall back to this process and the file system.
 */
export interface ToolEnvironment {
    extension(id: string): InstalledExtension | undefined;
    pathEnv: string | undefined;
    platform: NodeJS.Platform;
    /** Another variable of this process's environment (`PATHEXT`, `ProgramFiles`); case-insensitive on Windows. */
    env?(name: string): string | undefined;
    /** The setting `terminal.integrated.env.<windows|osx|linux>` of this platform: what VS Code adds to its terminals' environment. */
    terminalEnv?(): Readonly<Record<string, unknown>> | undefined;
    /** Whether a file is there; read-only. */
    isFile?(file: string): boolean;
    /** The names in a folder; none when it cannot be read. */
    listDir?(folder: string): readonly string[];
}

export interface HandlerHost {
    /** Milliseconds on the handler's clock. */
    now(): number;
    /** Resolves after `ms` on that clock. */
    sleep(ms: number): Promise<void>;
    /** Calls `fire` once after `ms`; the returned function cancels it. */
    startTimer(ms: number, fire: () => void): () => void;
    /** The frame id of the focused stack item when that item is a frame (not a thread). */
    focusedFrameId(): number | undefined;
    /** The window's CMSIS job tracker: task executions, jobs, probe owners. */
    cmsisJobs(): CmsisJobTracker;
    /** The window's owned serial port (#49): the line of `get_session_status`, the note of the programming tools. */
    ownedSerial(): SerialController;
    /** The open workspace folders, in VS Code's order. */
    workspaceFolders(): readonly vscode.WorkspaceFolder[];
    /** `vscode.workspace.findFiles`; without `maxResults`, every match. */
    findFiles(include: string, exclude: string, maxResults?: number): Thenable<vscode.Uri[]>;
    /**
     * The `cbuild-run.yml` of the CMSIS Solution extension's active target
     * (`getCbuildRunFile`); undefined when the extension is not active, lacks
     * the command, answers `""`, a relative path or not within 3 s. Whether
     * the file exists is the caller's check. `flash` takes it first, and
     * `cmsis_action` reads the debugger from it before it runs Update Debug
     * Tasks: one lookup for both.
     */
    activeCbuildRunFile(): Promise<string | undefined>;
    /** What the pyOCD lookup of `flash` reads. */
    toolEnvironment(): ToolEnvironment;
    /**
     * The setting `cmsis-csolution.probe-id`, read as CMSIS Solution reads it
     * (the window's value, at each call): the probe its CMSIS tasks and
     * `flash` select when the cbuild-run file names none. Undefined when unset
     * or blank.
     */
    solutionProbeId(): string | undefined;
    /**
     * The setting `cmsis-csolution.autoDebugLaunch` for `folder`, read as CMSIS
     * Solution reads it: off, it writes no launch.json and no tasks.json. True
     * when unset or unreadable.
     */
    autoDebugLaunch(folder: string): boolean;
    /** `vscode.openFolder`: open `folder` in a new VS Code window, or in this one. */
    openFolder(folder: string, newWindow: boolean): Thenable<unknown>;
    /** The CMSIS Solution extension's pack install, the pack root and the licence question of `install_pack`. */
    packInstall(): PackInstallHost;
    /** The CMSIS Solution extension, for its public API (`cmsis_query`, `create_solution`); undefined when it is not installed. */
    solutionExtension(): SolutionExtensionHandle | undefined;
    /** `fetch` for Arm's web catalog: which pack each of two web examples alike comes from (`cmsis_query`, `webCatalog.ts`). */
    webCatalogFetch: CatalogFetch;
    /**
     * Who holds a local GDB port that a launch or a CMSIS Run is about to use:
     * another window's session or CMSIS Run task, as its registry entry says,
     * or another program that listens there (a bind test, never a
     * connection); undefined when the port is free. The default knows no
     * other window; the window's `DebuggingHandler` is given the registry.
     */
    gdbPortHolder(port: number): Promise<GdbPortHolder | undefined>;
    /** Atomically reserve a port across windows before probing it or starting its server. */
    reserveGdbPort(port: number, start: PortStart, group?: string): GdbPortReservation;
}

let defaultPortReservations: GdbPortReservations | undefined;

/** The key under `terminal.integrated.env` per platform. */
const TERMINAL_ENV_KEY: Partial<Record<NodeJS.Platform, string>> = { win32: 'windows', darwin: 'osx', linux: 'linux' };

/** The real thing: Node timers and the VS Code API, looked up per call. */
export const VSCODE_HOST: HandlerHost = {
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((wake) => {
        setTimeout(wake, ms);
    }),
    startTimer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
    },
    focusedFrameId: () => {
        const item = vscode.debug.activeStackItem;
        return item !== undefined && 'frameId' in item ? item.frameId : undefined;
    },
    cmsisJobs: () => windowJobTracker(),
    ownedSerial: () => serialController,
    workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    findFiles: (include, exclude, maxResults) => vscode.workspace.findFiles(include, exclude, maxResults),
    activeCbuildRunFile: () => activeCbuildRunFile(),
    toolEnvironment: () => ({
        extension: (id) => {
            const found = vscode.extensions.getExtension(id);
            if (!found) {
                return undefined;
            }
            const version: unknown = (found.packageJSON as { version?: unknown } | undefined)?.version;
            return { path: found.extensionPath, version: typeof version === 'string' ? version : undefined };
        },
        pathEnv: process.env.PATH,
        platform: process.platform,
        env: (name) => process.env[name],
        terminalEnv: () => {
            const value: unknown = vscode.workspace.getConfiguration('terminal.integrated.env').get(TERMINAL_ENV_KEY[process.platform] ?? 'linux');
            return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
        },
        isFile: (file) => fileExists(file),
        listDir: (folder) => {
            try {
                return fs.readdirSync(folder);
            } catch {
                return [];
            }
        },
    }),
    solutionProbeId: () => {
        const value: unknown = vscode.workspace.getConfiguration('cmsis-csolution').get('probe-id');
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    },
    autoDebugLaunch: (folder) => {
        try {
            return vscode.workspace.getConfiguration('cmsis-csolution', vscode.Uri.file(folder)).get<boolean>('autoDebugLaunch', true) !== false;
        } catch {
            return true;
        }
    },
    openFolder:(folder, newWindow) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: newWindow }),
    packInstall: () => VSCODE_PACK_INSTALL_HOST,
    solutionExtension: () => {
        const found = vscode.extensions.getExtension(SOLUTION_EXTENSION_ID);
        if (!found) {
            return undefined;
        }
        const version: unknown = (found.packageJSON as { version?: unknown } | undefined)?.version;
        // Read at each use: activation changes both.
        return {
            get isActive(): boolean {
                return found.isActive;
            },
            get exports(): unknown {
                return found.exports;
            },
            version: typeof version === 'string' ? version : undefined,
            activate: () => found.activate(),
        };
    },
    webCatalogFetch: (url, init) => fetch(url, init),
    gdbPortHolder: (port) => findGdbPortHolder(port, []),
    reserveGdbPort: (port, start, group) => {
        defaultPortReservations ??= new GdbPortReservations();
        return defaultPortReservations.acquire(port, start, vscode.workspace.name ?? '(no workspace)', group);
    },
};
