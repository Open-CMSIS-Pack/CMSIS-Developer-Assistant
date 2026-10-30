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
 * Flash programming via `pyocd load --cbuild-run <file>` as a synchronous,
 * machine-readable operation: bytes programmed + structured error on failure,
 * instead of "check the output channel" (which an agent cannot read).
 *
 * Which pyOCD: the one the CMSIS tasks use (#46, #45) — the CMSIS Debugger
 * extension's bundled `tools/pyocd/pyocd`, else the directory the solution's
 * `.cmsis/tools-environment.yml` names, else PATH. The CMSIS Debugger adds
 * its folder to PATH only for terminals and tasks, not for this process.
 *
 * Which probe: the one CMSIS Solution's CMSIS Load task selects, `--probe`
 * by the target's debug adapter and `--uid` by the probe ID the solution
 * configures (`pyocdProbeType`, `pyocdLoadArgs`); pyOCD picks none itself.
 *
 * Whether it worked: pyOCD's exit status within the deadline, never the
 * words of its log. The output explains the result (`parsePyocdLoadOutput`):
 * a failure by its error lines and the probes pyOCD listed when several
 * matched, a success by the warnings it logged, among them each data chunk
 * of the image it could not add before it went on.
 *
 * This module deliberately imports ONLY node builtins — no vscode — so the
 * parsing and process logic is testable outside the extension host.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Outcome of one `pyocd load` run. */
export interface FlashResult {
    /** True when pyOCD exited 0 before the deadline: its exit status decides, not the words of its log. */
    ok: boolean;
    exitCode: number | null;
    /** True when the process had to be killed at the deadline. */
    timedOut: boolean;
    /** Bytes reported programmed by pyOCD, or null when not parseable (never invented). */
    programmedBytes: number | null;
    /** Reported programming rate, or null when not parseable. */
    kbps: number | null;
    /** The exact command line, for the result message. */
    commandLine: string;
    /** Last ~12 non-empty output lines, for context on failure. */
    outputTail: string[];
    /** pyOCD's error lines (last ~8), as `parsePyocdLoadOutput` picks them: the failure summary; a success lists them with the warnings. */
    errorLines: string[];
    /** pyOCD's warning log lines (last ~5), which a success lists: a warning never fails a run. */
    warningLines: string[];
    /** How many data chunks of the image pyOCD could not add ("Failed to add data chunk"), counted before `warningLines` is cut. */
    droppedChunks: number;
    /** The probes pyOCD listed instead of choosing one; empty when it listed none. */
    probeChoices: ListedProbe[];
}

/** A debug probe as pyOCD lists it when it does not choose one. */
export interface ListedProbe {
    description: string;
    uid: string;
}

/** ANSI colour codes: pyOCD writes them only to a terminal, or with `--color always` (pyocd/utility/color_log.py). */
const ANSI_CODES = /\x1b\[[0-9;]*[A-Za-z]/g;
/**
 * A log line of the pyocd command, `0000412 E No target device available
 * [load_cmd]`: milliseconds since the start, the initial of the level (C, E,
 * W, I, D), the message, the module (`ColorFormatter.FORMAT`,
 * pyocd/utility/color_log.py).
 */
const LOG_LINE = /^\d+ ([CEWID]) /;
/**
 * pyOCD's warning for a chunk of an image it cannot add to the programming
 * (`FileProgrammer`, pyocd/flash/file_programmer.py): its address is in no
 * memory region or in one that is not writable (pyocd/flash/loader.py), or
 * it overlaps other data (pyocd/flash/builder.py). pyOCD goes on and exits 0.
 */
const DROPPED_CHUNK = /^\d+ W Failed to add data chunk: /;
/** What pyOCD prints, not logs, when no probe is chosen (`ConnectHelper.choose_probe`, pyocd/core/helpers.py). */
const NO_PROBE_CHOSEN = /^(?:No connected debug probes?\b|More than one debug probe matches\b)/;
/** The first line of a Python traceback; the first line after it that is not indented names the exception. */
const TRACEBACK = /^Traceback \(most recent call last\):/;
/** `choose_probe` with a unique ID several probes match: this line, then `<description> | <unique ID>` for each. */
const SEVERAL_MATCH = /^More than one debug probe matches unique ID /;
const MATCH_ROW = /^(\S.*?) \| (\S+)$/;
/** `choose_probe` without a unique ID and with several probes: a table of them (`_print_probe_list`), then a prompt. */
const TABLE_HEADER = /^\s*#\s+Probe\/Board\s+Unique ID\s+Target$/;
/** A probe's row: its number, the description, the unique ID and the target column, three spaces apart. */
const TABLE_ROW = /^\s*\d+\s+(\S.*?)\s{3,}(\S+)\s{3,}\S/;
const PROMPT = /^Enter the number of the debug probe/;

/** The probes pyOCD listed instead of choosing one: after "More than one debug probe matches", or in its table before the prompt. */
function listedProbes(lines: readonly string[]): ListedProbe[] {
    const probes: ListedProbe[] = [];
    const several = lines.findIndex((line) => SEVERAL_MATCH.test(line));
    if (several >= 0) {
        for (const line of lines.slice(several + 1)) {
            const row = MATCH_ROW.exec(line);
            if (!row) {
                break;
            }
            probes.push({ description: row[1], uid: row[2] });
        }
        return probes;
    }
    const header = lines.findIndex((line) => TABLE_HEADER.test(line));
    if (header < 0) {
        return probes;
    }
    for (const line of lines.slice(header + 1)) {
        if (PROMPT.test(line)) {
            break;
        }
        // Rows without a number carry a probe's board, or an access error.
        const row = TABLE_ROW.exec(line);
        if (row) {
            probes.push({ description: row[1], uid: row[2] });
        }
    }
    return probes;
}

/**
 * Parse pyOCD flash-loader output (pyocd/flash/loader.py prints
 * "Erased %d bytes (%s), programmed %d bytes (%s), identical %d bytes (%s)
 * at %.02f kB/s" on completion; chip-erase runs say "Erased chip, ...").
 * Pure — unit-tested. Older/newer pyOCD versions may phrase differently, so
 * callers must treat null fields as "unknown", never as zero.
 *
 * Error lines are pyOCD's error and critical log lines, the first and the
 * last line of a traceback, and its words when no probe is chosen. Info and
 * debug lines (`Loading <path>`, whatever the path) and warnings are none.
 * Warning lines are its warning log lines, and `droppedChunks` counts those
 * that say it could not add a data chunk of the image.
 */
export function parsePyocdLoadOutput(stdout: string, stderr: string): {
    programmedBytes: number | null;
    kbps: number | null;
    errorLines: string[];
    warningLines: string[];
    droppedChunks: number;
    tail: string[];
    probeChoices: ListedProbe[];
} {
    const text = `${stdout}\n${stderr}`;
    const bytesMatch = text.match(/programmed (\d+) bytes/i);
    const rateMatch = text.match(/at ([\d.]+) kB\/s/i);
    const lines = text.split(/\r?\n/).map((line) => line.replace(ANSI_CODES, '').trimEnd()).filter((line) => line.trim().length > 0);
    const errorLines: string[] = [];
    const warningLines: string[] = [];
    let droppedChunks = 0;
    let inTraceback = false;
    for (const line of lines) {
        if (inTraceback) {
            // The frames and their source lines are indented; the exception is not.
            if (/^\s/.test(line)) {
                continue;
            }
            inTraceback = false;
            errorLines.push(line);
        } else if (TRACEBACK.test(line)) {
            inTraceback = true;
            errorLines.push(line);
        } else {
            const level = LOG_LINE.exec(line)?.[1];
            if (level === 'E' || level === 'C' || NO_PROBE_CHOSEN.test(line)) {
                errorLines.push(line);
            } else if (level === 'W') {
                warningLines.push(line);
                if (DROPPED_CHUNK.test(line)) {
                    droppedChunks += 1;
                }
            }
        }
    }
    return {
        programmedBytes: bytesMatch ? parseInt(bytesMatch[1], 10) : null,
        kbps: rateMatch ? parseFloat(rateMatch[1]) : null,
        errorLines: errorLines.slice(-8),
        warningLines: warningLines.slice(-5),
        droppedChunks,
        tail: lines.slice(-12),
        probeChoices: listedProbes(lines),
    };
}

/** The probe a `pyocd load` selects: the options of CMSIS Solution's CMSIS Load task. */
export interface ProbeSelection {
    /** `--probe`: the pyOCD probe type of the target's debug adapter, such as `cmsisdap:`. */
    type?: string;
    /** `--uid`: the unique ID of the probe the solution configures; pyOCD matches any probe whose ID contains it. */
    uid?: string;
    /** Where `uid` came from: the cbuild-run file's `debugger:` node, or the setting `cmsis-csolution.probe-id`. */
    uidFrom?: 'cbuild-run' | 'setting';
}

/**
 * The debug adapters of CMSIS Solution 1.72.0 (templates/debug/debug-adapters.yml,
 * names and aliases) whose probe type is known, with pyOCD's name for it:
 * the `--probe` of the CMSIS Load task of CMSIS-DAP-pyOCD.adapter.json and
 * STLink-pyOCD.adapter.json, and the probe the J-Link Server (JLinkExe
 * `-USB`) and Arm Debugger adapters (`connectionType`) connect to.
 */
const ADAPTER_PROBE_TYPES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['cmsisdap:', ['CMSIS-DAP@pyOCD', 'CMSIS-DAP', 'DAP-Link', 'ULINKplus@pyOCD', 'ULINKplus', 'MCU-Link@pyOCD', 'MCU-Link',
        'Nu-Link@pyOCD', 'Nu-Link', 'Nu-Link-Pro', 'PICkit@pyOCD', 'PICkit Basic', 'KitProg3@pyOCD', 'KitProg3',
        'RPiDebugProbe@pyOCD', 'RaspberryPiDebugProbe', 'RPiDebugProbe', 'CMSIS-DAP@Arm-Debugger', 'CMSIS-DAP@armdbg']],
    ['stlink:', ['ST-Link@pyOCD', 'ST-LINK', 'ST-Link@Arm-Debugger', 'ST-Link@armdbg']],
    ['jlink:', ['J-Link Server', 'J-Link', 'JLink Server']],
];

/**
 * The pyOCD probe type (`cmsisdap:`, `stlink:`, `jlink:`) of the debug
 * adapter a cbuild-run file's `debugger:` names, in any case; undefined for
 * an adapter without one (Arm-FVP, Keil uVision, one the user added), with
 * which pyOCD looks at every probe.
 */
export function pyocdProbeType(adapterName: string | undefined): string | undefined {
    const wanted = adapterName?.trim().toLowerCase();
    if (!wanted) {
        return undefined;
    }
    return ADAPTER_PROBE_TYPES.find(([, names]) => names.some((name) => name.toLowerCase() === wanted))?.[0];
}

/**
 * The arguments of `pyocd load`: the CMSIS Load task's (`--probe <type>`,
 * then `--uid <id>`, which pyOCD takes as the same option, the last one
 * given winning) and `--no-wait`.
 */
export function pyocdLoadArgs(cbuildRunFile: string, probe: ProbeSelection = {}): string[] {
    return [
        'load', '--no-wait',
        ...(probe.type ? ['--probe', probe.type] : []),
        ...(probe.uid ? ['--uid', probe.uid] : []),
        '--cbuild-run', cbuildRunFile,
    ];
}

/** Where a pyOCD executable was found, in the words the flash result uses. */
export interface PyocdCandidate {
    bin: string;
    origin: 'debugger-extension' | 'tools-environment' | 'path';
    /** `CMSIS Debugger 1.8.0`, `.cmsis/tools-environment.yml` or `PATH`. */
    from: string;
}

/** What the pyOCD lookup reads; the file test is replaced in tests. */
export interface PyocdLookup {
    /** The install folder of the CMSIS Debugger extension, when it is installed. */
    debuggerExtensionPath?: string;
    debuggerVersion?: string;
    /** The text of the solution's `.cmsis/tools-environment.yml`, when there is one. */
    toolsEnvironmentYml?: string;
    platform: NodeJS.Platform;
    pathEnv?: string;
    isFile?: (candidate: string) => boolean;
}

/**
 * The `directory:` of the pyOCD entry under `tools:` in a
 * tools-environment.yml, read line by line like the other generated YAML:
 *
 *   tools:
 *     - name: pyOCD
 *       version: 0.45.1
 *       directory: /…/arm.vscode-cmsis-debugger-1.8.0-darwin-arm64/tools/pyocd
 */
export function pyocdDirectoryIn(toolsEnvironmentYml: string): string | undefined {
    let toolsIndent = -1;
    let itemIndent = -1;
    let isPyocd = false;
    for (const raw of toolsEnvironmentYml.split(/\r?\n/)) {
        const line = raw.replace(/\s+#.*$/, '');
        if (line.trim().length === 0) {
            continue;
        }
        const indent = line.length - line.trimStart().length;
        if (toolsIndent < 0) {
            if (/^\s*tools:\s*$/.test(line)) {
                toolsIndent = indent;
            }
            continue;
        }
        if (indent <= toolsIndent) {
            break;
        }
        const item = /^(\s*)-\s+(.*)$/.exec(line);
        if (item) {
            itemIndent = item[1].length;
            isPyocd = false;
        }
        const entry = item ? item[2] : line.trim();
        const key = /^([A-Za-z-]+):\s*(.*?)\s*$/.exec(entry);
        // Keys of the item itself, not of a nested map such as `provider:`.
        const ownKey = item !== null || indent === itemIndent + 2;
        if (!key || !ownKey) {
            continue;
        }
        const value = key[2].replace(/^(['"])(.*)\1$/, '$2');
        if (key[1] === 'name') {
            isPyocd = value.toLowerCase() === 'pyocd';
        } else if (key[1] === 'directory' && isPyocd && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

/**
 * The pyOCD executables to try, in order: the CMSIS Debugger's bundled one,
 * the one tools-environment.yml names, the first on PATH (`pyocd.exe` on
 * Windows). Only existing files are listed, each once.
 */
export function resolvePyocd(lookup: PyocdLookup): PyocdCandidate[] {
    const paths = lookup.platform === 'win32' ? path.win32 : path.posix;
    const executable = lookup.platform === 'win32' ? 'pyocd.exe' : 'pyocd';
    const isFile = lookup.isFile ?? fileExists;
    const found: PyocdCandidate[] = [];
    const offer = (bin: string, origin: PyocdCandidate['origin'], from: string): boolean => {
        if (!isFile(bin)) {
            return false;
        }
        if (!found.some((candidate) => candidate.bin === bin)) {
            found.push({ bin, origin, from });
        }
        return true;
    };
    if (lookup.debuggerExtensionPath) {
        const version = lookup.debuggerVersion ? ` ${lookup.debuggerVersion}` : '';
        offer(paths.join(lookup.debuggerExtensionPath, 'tools', 'pyocd', executable), 'debugger-extension', `CMSIS Debugger${version}`);
    }
    const listed = lookup.toolsEnvironmentYml ? pyocdDirectoryIn(lookup.toolsEnvironmentYml) : undefined;
    if (listed) {
        offer(paths.join(listed, executable), 'tools-environment', '.cmsis/tools-environment.yml');
    }
    for (const entry of (lookup.pathEnv ?? '').split(paths.delimiter)) {
        const folder = entry.trim().replace(/^"(.*)"$/, '$1');
        if (folder.length > 0 && offer(paths.join(folder, executable), 'path', 'PATH')) {
            break;
        }
    }
    return found;
}

/** A command line as it reads in a result: the executable quoted when it contains a space. */
function commandText(bin: string, args: string[]): string {
    return [/\s/.test(bin) ? `"${bin}"` : bin, ...args].join(' ');
}

/**
 * Run `<bin> --version`. Returns the reported version string, or null when
 * the executable is missing / not runnable.
 */
export async function probePyocd(bin = 'pyocd', timeoutMs = 5_000): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (version: string | null) => {
            if (!settled) { settled = true; resolve(version); }
        };
        let child;
        try {
            child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            finish(null);
            return;
        }
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, timeoutMs);
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        child.on('error', () => { clearTimeout(timer); finish(null); });
        child.on('close', (code) => {
            clearTimeout(timer);
            finish(code === 0 ? out.trim().split(/\r?\n/)[0] || 'pyocd (version unknown)' : null);
        });
    });
}

/**
 * Program all images listed under `output:` in a cbuild-run file via pyOCD
 * (`bin`, as `resolvePyocd` found it; `pyocd` from PATH by default), on the
 * probe `probe` selects (`pyocdLoadArgs`).
 * spawn without a shell — no quoting or injection surface. `--no-wait`:
 * without a free probe pyOCD would wait for one until killed (#81); it ends
 * at once with "No connected debug probes" instead. stdin is closed, so
 * pyOCD's question which of several probes to take ends at once too. The
 * process is SIGTERMed at the deadline (SIGKILL 2 s later) so a wedged probe
 * cannot hang the tool call.
 */
export async function flashWithPyocd(
    cbuildRunFile: string,
    timeoutMs: number,
    deps: { spawn?: typeof spawn; killGraceMs?: number; bin?: string; probe?: ProbeSelection } = {},
): Promise<FlashResult> {
    const bin = deps.bin ?? 'pyocd';
    const args = pyocdLoadArgs(cbuildRunFile, deps.probe);
    const commandLine = commandText(bin, args);
    const spawnFn = deps.spawn ?? spawn;
    const killGraceMs = deps.killGraceMs ?? 2_000;
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let spawnError: string | undefined;
        const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        // Cap captured output so a chatty run cannot grow unbounded.
        const CAP = 256 * 1024;
        child.stdout.on('data', (d) => { if (stdout.length < CAP) { stdout += d.toString(); } });
        child.stderr.on('data', (d) => { if (stderr.length < CAP) { stderr += d.toString(); } });

        const killTimer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // `child.killed` is true as soon as the SIGTERM was *sent*; only
            // exitCode / signalCode say whether the process actually died.
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
            }, killGraceMs).unref();
        }, timeoutMs);

        const finish = (exitCode: number | null) => {
            clearTimeout(killTimer);
            const parsed = parsePyocdLoadOutput(stdout, stderr);
            resolve({
                ok: !timedOut && exitCode === 0,
                exitCode,
                timedOut,
                programmedBytes: parsed.programmedBytes,
                kbps: parsed.kbps,
                commandLine,
                outputTail: parsed.tail,
                // The spawn failure is this module's line, not one of pyOCD's.
                errorLines: spawnError ? [...parsed.errorLines, spawnError].slice(-8) : parsed.errorLines,
                warningLines: parsed.warningLines,
                droppedChunks: parsed.droppedChunks,
                probeChoices: parsed.probeChoices,
            });
        };
        child.on('error', (err) => {
            // spawn failure (e.g. ENOENT despite probePyocd) — surface as a
            // failed run rather than throwing.
            spawnError = `spawn error: ${err.message}`;
            stderr += `\n${spawnError}`;
            finish(1);
        });
        child.on('close', (code) => finish(code));
    });
}

/** True when the path exists and is a file — used for explicit-path validation. */
export function fileExists(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}
