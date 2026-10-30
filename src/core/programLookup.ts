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
 * Which program a CMSIS task runs, and whether the PATH it runs with has it.
 *
 * CMSIS Solution writes the CMSIS Load, Erase and Run tasks from its debug
 * adapter templates (1.72.0 `templates/debug/*.adapter.json`): the pyOCD
 * adapters run `pyocd`; the J-Link adapter runs a shell line that writes a
 * command file and calls J-Link Commander (`JLink.exe` on Windows,
 * `JLinkExe` elsewhere), and its CMSIS Run and launch configurations name
 * `JLinkGDBServerCL.exe`, `JLinkGDBServerCL` (macOS) or
 * `JLinkGDBServerCLExe` (Linux); the FVP adapter runs the model.
 * `taskProgram` reads the kind, and for J-Link the program, from a task's
 * command words (`taskCommandWords` in `./gdbServerPorts.ts`).
 *
 * A task that fails within `FAILED_AT_ONCE_MS` most likely never ran its
 * program: the shell did not find it. The CMSIS tasks run in VS Code's
 * terminal, so their PATH is the directories of
 * `.cmsis/tools-environment.yml` in front, then the PATH of the setting
 * `terminal.integrated.env.<windows|osx|linux>` (its `${env:PATH}` is VS
 * Code's own), or VS Code's own PATH when the setting has none. The debug
 * adapter starts a launch configuration's GDB server with VS Code's own
 * PATH alone, so a program can be on one and missing from the other.
 * `taskPathFolders` and `processPathFolders` list those directories with
 * where each came from; `findProgram` looks a program up in them as a shell
 * would (on Windows with the extensions of `PATHEXT`, names compared
 * without regard to case); and `installedIn` names a SEGGER installation
 * folder that holds a J-Link program when no PATH does. The hints that
 * report a missing program end with the same fix and point at the
 * troubleshooting procedure for the steps (`RESTART_VS_CODE`,
 * `PROBE_SOFTWARE_STEPS`).
 *
 * Pure: no vscode; the environment and the file tests come in.
 */

import * as path from 'path';

/** What a task's command line runs, as far as the hint after its failure is concerned. */
export type TaskProgramKind = 'jlink' | 'pyocd' | 'fvp' | 'other' | 'unknown';

/** The kind of a task's program and, for J-Link, the program as the command line names it. */
export interface TaskProgram {
    kind: TaskProgramKind;
    /** `JLink.exe`, `JLinkExe`, `JLinkGDBServerCL.exe` or a full path; J-Link only. */
    program?: string;
}

/**
 * A failed task that ended this soon most likely never ran its program
 * (cmd.exe: "'JLink.exe' is not recognized as an internal or external
 * command"); a program that ran and failed takes longer to connect.
 */
export const FAILED_AT_ONCE_MS = 2_000;

/** J-Link Commander and the J-Link GDB servers, with or without `Exe` and `.exe`. */
const JLINK_PROGRAM = /^JLink(?:Exe|GDBServer(?:CL)?(?:Exe)?)?(?:\.exe)?$/i;
/** pyOCD, its Windows executable, or a wrapper script named after it (`pyocd_wrapper.py`). */
const PYOCD_PROGRAM = /^pyocd(?:$|[._-])/i;
/** The executable of an Arm FVP model, as `./gdbServerPorts.ts` reads it. */
const FVP_MODEL = /^(?:FVP|VHT)_/;
/** A word of a command line: double-quoted, single-quoted or bare. */
const COMMAND_LINE_WORD = /"([^"]*)"|'([^']*)'|(\S+)/g;

/** The last part of a path, without quotes around it. */
function baseName(word: string): string {
    const bare = word.replace(/^(['"])(.*)\1$/, '$2');
    return bare.split(/[\\/]/).pop() ?? bare;
}

/**
 * The kind of program a task's command words run: J-Link when any word is a
 * J-Link program (the J-Link Load is a shell line, `echo … && JLink.exe …`),
 * pyOCD when any word is pyOCD, an FVP model as the first word, `other` for
 * any other command and `unknown` without one. A word that holds spaces, as
 * a whole shell line passed as one command does, is split once more.
 */
export function taskProgram(words: readonly string[] | undefined): TaskProgram {
    if (!words || words.length === 0) {
        return { kind: 'unknown' };
    }
    const split = words.filter((word) => /\s/.test(word))
        .flatMap((word) => [...word.matchAll(COMMAND_LINE_WORD)].map((match) => match[1] ?? match[2] ?? match[3]));
    const candidates = [...words, ...split];
    const jlink = candidates.find((word) => JLINK_PROGRAM.test(baseName(word)));
    if (jlink !== undefined) {
        return { kind: 'jlink', program: jlink.replace(/^(['"])(.*)\1$/, '$2') };
    }
    if (candidates.some((word) => PYOCD_PROGRAM.test(baseName(word)))) {
        return { kind: 'pyocd' };
    }
    return FVP_MODEL.test(baseName(words[0])) ? { kind: 'fvp' } : { kind: 'other' };
}

/** Where a directory on a PATH came from, as the hints name it. */
export const TOOLS_ENVIRONMENT_PLACE = '.cmsis/tools-environment.yml';
/** VS Code's own PATH: the extension host's, which the debug adapter inherits. */
export const VSCODE_PATH_PLACE = 'VS Code\'s PATH';

/** The setting with the variables VS Code adds to its terminals on `platform`. */
export function terminalEnvSetting(platform: NodeJS.Platform): string {
    return `terminal.integrated.env.${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux'}`;
}

/** One directory of a PATH and where it came from. */
export interface PathFolder {
    folder: string;
    place: string;
}

/** What the lookup reads of VS Code's surroundings; tests hand in their own. */
export interface LookupFacts {
    platform: NodeJS.Platform;
    /** A variable of VS Code's own environment (`PATH`, `PATHEXT`, `ProgramFiles`); case-insensitive on Windows. */
    env(name: string): string | undefined;
    /** Whether a file is there; read-only. */
    isFile(file: string): boolean;
    /** The names in a folder; none when it cannot be read. */
    listDir(folder: string): readonly string[];
}

function pathModule(platform: NodeJS.Platform): typeof path.posix {
    return platform === 'win32' ? path.win32 : path.posix;
}

/** Whether two names are the same on `platform`: without regard to case on Windows. */
function sameName(a: string, b: string, platform: NodeJS.Platform): boolean {
    return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The entries of a PATH value, quotes removed, as directories of `place`. */
function foldersOf(value: string | undefined, place: string, platform: NodeJS.Platform): PathFolder[] {
    return (value ?? '').split(pathModule(platform).delimiter)
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter((folder) => folder.length > 0)
        .map((folder) => ({ folder: platform === 'win32' ? folder.replace(/\//g, '\\') : folder, place }));
}

/** VS Code's own PATH: what the debug adapter, and so the GDB server it starts, runs with. */
export function processPathFolders(facts: LookupFacts): PathFolder[] {
    return foldersOf(facts.env('PATH'), VSCODE_PATH_PLACE, facts.platform);
}

/** The PATH variable of the terminal setting: `Path` counts as `PATH` on Windows. Undefined when it sets none. */
function terminalPathValue(terminalEnv: Readonly<Record<string, unknown>> | undefined, platform: NodeJS.Platform): string | undefined {
    const entry = Object.entries(terminalEnv ?? {}).find(([name]) => sameName(name, 'PATH', platform));
    return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

/**
 * The PATH of the CMSIS tasks, in the order the shell searches it: the
 * directories of `.cmsis/tools-environment.yml` (`toolsPath`, undefined
 * without the file), then the PATH of the terminal setting, whose
 * `${env:PATH}` is VS Code's own, or VS Code's own PATH when the setting
 * sets none. A setting PATH without `${env:PATH}` replaces VS Code's.
 */
export function taskPathFolders(
    toolsPath: readonly string[] | undefined,
    terminalEnv: Readonly<Record<string, unknown>> | undefined,
    facts: LookupFacts,
): PathFolder[] {
    const { platform } = facts;
    const folders: PathFolder[] = (toolsPath ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        .map((entry) => ({ folder: platform === 'win32' ? entry.replace(/\//g, '\\') : entry, place: TOOLS_ENVIRONMENT_PLACE }));
    const terminalPath = terminalPathValue(terminalEnv, platform);
    if (terminalPath === undefined) {
        return [...folders, ...processPathFolders(facts)];
    }
    const setting = terminalEnvSetting(platform);
    for (const segment of terminalPath.split(pathModule(platform).delimiter)) {
        const whole = /^\s*\$\{env:([^}]+)\}\s*$/.exec(segment);
        if (whole && sameName(whole[1], 'PATH', platform)) {
            folders.push(...processPathFolders(facts));
            continue;
        }
        const expanded = segment.replace(/\$\{env:([^}]+)\}/g, (_, name: string) => facts.env(name) ?? '');
        folders.push(...foldersOf(expanded, setting, platform));
    }
    return folders;
}

/** The places a list of folders came from, each once, in order. */
export function placesOf(folders: readonly PathFolder[]): string[] {
    return [...new Set(folders.map((entry) => entry.place))];
}

/** A program found on a PATH: the file, its folder, and where that folder came from. */
export interface FoundProgram {
    file: string;
    folder: string;
    place: string;
}

/** The Windows extensions the shell tries for a name without one, when PATHEXT is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * The file names `program` is looked for under in each folder: itself
 * outside Windows; on Windows itself when its extension is one of PATHEXT,
 * else itself with each of them, as cmd.exe looks. (Node's spawn, which
 * starts the GDB server, tries only `.com` and `.exe`; the servers the
 * templates name are `.exe` files or carry no extension at all.)
 */
function fileNames(program: string, facts: LookupFacts): string[] {
    if (facts.platform !== 'win32') {
        return [program];
    }
    const extension = path.win32.extname(program);
    const extensions = (facts.env('PATHEXT') || DEFAULT_PATHEXT).split(';').map((entry) => entry.trim()).filter((entry) => entry.startsWith('.'));
    if (extension !== '' && extensions.some((entry) => sameName(entry, extension, 'win32'))) {
        return [program];
    }
    return extensions.map((entry) => `${program}${entry.toLowerCase()}`);
}

/**
 * The first file `program` resolves to in `folders`, in order; undefined
 * when none holds it. A folder listed twice is tried once. A program named
 * with a folder is not looked up.
 */
export function findProgram(program: string, folders: readonly PathFolder[], facts: LookupFacts): FoundProgram | undefined {
    if (/[\\/]/.test(program)) {
        return undefined;
    }
    const paths = pathModule(facts.platform);
    const names = fileNames(program, facts);
    const tried: string[] = [];
    for (const entry of folders) {
        if (tried.some((folder) => sameName(folder, entry.folder, facts.platform))) {
            continue;
        }
        tried.push(entry.folder);
        for (const name of names) {
            const file = paths.join(entry.folder, name);
            if (facts.isFile(file)) {
                return { file, folder: entry.folder, place: entry.place };
            }
        }
    }
    return undefined;
}

/** Where the SEGGER installer puts the J-Link Software by default, per platform. */
function seggerRoots(facts: LookupFacts): string[] {
    if (facts.platform === 'darwin') {
        return ['/Applications/SEGGER'];
    }
    if (facts.platform !== 'win32') {
        return ['/opt/SEGGER'];
    }
    const roots: string[] = [];
    for (const root of [facts.env('ProgramFiles'), facts.env('ProgramW6432'), facts.env('ProgramFiles(x86)'), 'C:\\Program Files']) {
        if (root && !roots.some((known) => sameName(known, root, 'win32'))) {
            roots.push(root);
        }
    }
    return roots.map((root) => path.win32.join(root, 'SEGGER'));
}

/**
 * A SEGGER installation folder that holds `program`, when no PATH does:
 * `SEGGER\JLink` under Program Files on Windows (`/Applications/SEGGER/JLink`
 * on macOS, `/opt/SEGGER/JLink` on Linux), else the newest versioned
 * `JLink_V…` folder beside it that holds it. Only a folder whose file is
 * there is named; undefined otherwise.
 */
export function installedIn(program: string, facts: LookupFacts): string | undefined {
    const paths = pathModule(facts.platform);
    for (const root of seggerRoots(facts)) {
        const versioned = facts.listDir(root).filter((name) => /^JLink/i.test(name) && !sameName(name, 'JLink', facts.platform)).sort().reverse();
        for (const name of ['JLink', ...versioned]) {
            const folder = paths.join(root, name);
            if (findProgram(program, [{ folder, place: 'SEGGER' }], facts)) {
                return folder;
            }
        }
    }
    return undefined;
}

/** What was found out about the program of a task that failed at once. */
export interface ProgramLookup {
    /** Where the PATH of the CMSIS tasks has it; undefined when it does not. */
    found?: FoundProgram;
    /** The places searched, in order: `.cmsis/tools-environment.yml`, the terminal setting, VS Code's PATH. */
    searched: string[];
    /** A SEGGER folder that holds it although no PATH does. */
    installedIn?: string;
}

/** What the hint after a failed Load or Erase says about the task's program. */
export interface ProgramFacts extends TaskProgram {
    /** Set when the task failed at once and its program was looked up. */
    lookup?: ProgramLookup;
}

/** The end of the fix for a program missing from a PATH: VS Code reads the PATH only when it starts. */
export const RESTART_VS_CODE = 'then restart VS Code completely (all windows)';

/** Where a hint about a missing probe program points for the steps: the two PATHs, the default folders, the restart. */
export const PROBE_SOFTWARE_STEPS = 'knowledge_get { id: "proc-debugger-troubleshooting" } has the steps.';
