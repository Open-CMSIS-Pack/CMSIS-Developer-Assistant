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
 * The few lines of a `*.cbuild-run.yml` that identify the target's packs
 * (and, in `cbuildRunDebugger` and `cbuildRunProbeId`, the name of its
 * debugger and the probe it selects):
 *
 *   cbuild-run:
 *     solution: TFLiteRT_HelloWorld.csolution.yml
 *     target-type: STM32F756ZGTx
 *     device: STMicroelectronics::STM32F756ZGTx
 *     device-pack: Keil::STM32F7xx_DFP@3.0.0
 *     board: STMicroelectronics::NUCLEO-F756ZG:Rev.B
 *     board-pack: Keil::NUCLEO-F756ZG_BSP@2.0.0
 *
 * Read with a line scanner like the CMSIS Developer Assistant's SVD lookup:
 * the file is generated, two-space indented, and the keys are top level.
 */

import * as os from 'os';
import * as path from 'path';

export interface PackId {
    vendor: string;
    name: string;
    version?: string;
}

export interface QualifiedName {
    vendor?: string;
    name: string;
    /** Board revision, e.g. `Rev.B`. */
    revision?: string;
}

export interface CbuildRunInfo {
    file: string;
    solution?: string;
    targetType?: string;
    device?: QualifiedName;
    devicePack?: PackId;
    board?: QualifiedName;
    boardPack?: PackId;
}

/**
 * What the CMSIS Solution panel has active, when the host can tell: the
 * csolution name (file basename without `.csolution.yml`) and the target-type.
 * Used to pick one cbuild-run context when a workspace holds several
 * solutions — the case that otherwise makes every documentation and
 * build-artefact call fail until the agent passes `target`.
 */
export interface ActiveContextHint {
    solution?: string;
    targetType?: string;
}

/** A host that may know the active context; both cores accept it optionally. */
export interface ActiveContextSource {
    activeContext?(): Promise<ActiveContextHint | undefined>;
}

/** The hint, or undefined when the host has none or it fails — never throws. */
export async function activeContextOf(host: ActiveContextSource): Promise<ActiveContextHint | undefined> {
    if (!host.activeContext) { return undefined; }
    try {
        const hint = await host.activeContext();
        return hint && (hint.solution || hint.targetType) ? hint : undefined;
    } catch {
        return undefined;
    }
}

/** Does this cbuild-run belong to the active solution (and target-type, when the hint names one)? */
export function matchesActiveContext(info: CbuildRunInfo, hint: ActiveContextHint): boolean {
    const eq = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    const base = path.basename(info.file);
    if (hint.solution) {
        // `solution:` in a cbuild-run is a path (`../Blinky.csolution.yml`); the hint is the bare name.
        // The file name (`<solution>+<target>.cbuild-run.yml`) is the fallback only when the field is absent.
        const solutionName = info.solution ? path.basename(info.solution).replace(/\.csolution\.ya?ml$/i, '') : undefined;
        const wanted = path.basename(hint.solution).replace(/\.csolution\.ya?ml$/i, '');
        const bySolution = solutionName ? eq(solutionName, wanted) : base.toLowerCase().startsWith(`${wanted.toLowerCase()}+`);
        if (!bySolution) { return false; }
    }
    if (hint.targetType) {
        return info.targetType ? eq(info.targetType, hint.targetType) : base.toLowerCase().includes(`+${hint.targetType.toLowerCase()}.`);
    }
    return true;
}

export function describeActiveContext(hint: ActiveContextHint): string {
    return `${hint.solution ?? '?'}${hint.targetType ? ` (${hint.targetType})` : ''}`;
}

/** `Keil::STM32F7xx_DFP@3.0.0` → vendor, name, version. */
export function parsePackId(text: string | undefined): PackId | undefined {
    if (!text) { return undefined; }
    const m = text.trim().match(/^([^:@]+)::([^:@]+)(?:@(.+))?$/);
    if (!m) { return undefined; }
    return { vendor: m[1].trim(), name: m[2].trim(), version: m[3]?.trim() || undefined };
}

export function formatPackId(id: PackId): string {
    return `${id.vendor}::${id.name}${id.version ? `@${id.version}` : ''}`;
}

/** `STMicroelectronics::NUCLEO-F756ZG:Rev.B` → vendor, name, revision; `Alif Semiconductor::AE722F80F55D5LS` keeps the space. */
export function parseQualifiedName(text: string | undefined): QualifiedName | undefined {
    if (!text) { return undefined; }
    const t = text.trim();
    if (!t) { return undefined; }
    const sep = t.indexOf('::');
    const vendor = sep >= 0 ? t.slice(0, sep).trim() : undefined;
    const rest = sep >= 0 ? t.slice(sep + 2) : t;
    const rev = rest.indexOf(':');
    if (rev >= 0) {
        return { vendor, name: rest.slice(0, rev).trim(), revision: rest.slice(rev + 1).trim() || undefined };
    }
    return { vendor, name: rest.trim() };
}

function unquote(value: string): string {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}

export function parseCbuildRun(content: string, file: string): CbuildRunInfo {
    const info: CbuildRunInfo = { file };
    for (const raw of content.split('\n')) {
        // Only the two-space, top-level keys directly under `cbuild-run:`.
        const m = raw.match(/^ {2}([a-z-]+):\s*(.*?)\s*$/);
        if (!m) { continue; }
        const value = unquote(m[2]);
        switch (m[1]) {
            case 'solution': info.solution = value; break;
            case 'target-type': info.targetType = value; break;
            case 'device': info.device = parseQualifiedName(value); break;
            case 'device-pack': info.devicePack = parsePackId(value); break;
            case 'board': info.board = parseQualifiedName(value); break;
            case 'board-pack': info.boardPack = parsePackId(value); break;
            default: break;
        }
    }
    return info;
}

/** A key of the `debugger:` node itself (four spaces in), unquoted; undefined when absent or empty. */
function debuggerKey(content: string, key: string): string | undefined {
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((line) => /^ {2}debugger:\s*$/.test(line));
    if (start < 0) { return undefined; }
    for (const line of lines.slice(start + 1)) {
        // The next key at the debugger's level or above ends its node.
        if (/^ {0,2}\S/.test(line)) { break; }
        const m = line.match(/^ {4}([a-z-]+):\s*(.*?)\s*$/);
        if (m && m[1] === key) { return unquote(m[2]) || undefined; }
    }
    return undefined;
}

/**
 * The `name:` of the `debugger:` node of a cbuild-run.yml (`CMSIS-DAP@pyOCD`,
 * `J-Link Server`, …), which csolution writes from the target set: the
 * debugger CMSIS Solution writes the CMSIS tasks and launch configurations
 * for. Undefined when the file names none.
 *
 *   cbuild-run:
 *     debugger:
 *       name: CMSIS-DAP@pyOCD
 *       protocol: swd
 */
export function cbuildRunDebugger(content: string): string | undefined {
    return debuggerKey(content, 'name');
}

/**
 * The `probe-id:` of the `debugger:` node: a key of the target set's
 * debugger that csolution copies into the cbuild-run file, and the first
 * place CMSIS Solution takes the `--uid` of its CMSIS tasks from, before the
 * setting `cmsis-csolution.probe-id`. Undefined when the file has none.
 */
export function cbuildRunProbeId(content: string): string | undefined {
    return debuggerKey(content, 'probe-id');
}

/**
 * The ports of the `gdbserver:` list of the `debugger:` node, one per core,
 * in file order: where pyOCD's `gdbserver --cbuild-run` listens when its
 * command line sets no port. None when the file lists none.
 *
 *   cbuild-run:
 *     debugger:
 *       gdbserver:
 *         - port: 3333
 *         - port: 3334
 *           pname: cm4
 */
export function cbuildRunGdbPorts(content: string): number[] {
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((line) => /^ {2}debugger:\s*$/.test(line));
    if (start < 0) { return []; }
    const ports: number[] = [];
    let inList = false;
    for (const line of lines.slice(start + 1)) {
        if (/^ {0,2}\S/.test(line)) { break; }
        if (/^ {4}\S/.test(line)) {
            inList = /^ {4}gdbserver:\s*$/.test(line);
            continue;
        }
        const m = inList ? line.match(/^ {6,}(?:-\s+)?port:\s*(\d+)\s*$/) : null;
        const port = m ? Number(m[1]) : NaN;
        if (Number.isInteger(port) && port > 0 && port < 65_536) { ports.push(port); }
    }
    return ports;
}

/**
 * `$CMSIS_PACK_ROOT`, else the CMSIS-Toolbox default: `%LOCALAPPDATA%\Arm\Packs`
 * on Windows (`<home>\AppData\Local\Arm\Packs` when LOCALAPPDATA is unset),
 * `~/.cache/arm/packs` elsewhere.
 */
export function defaultPackRoot(
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const fromEnv = env.CMSIS_PACK_ROOT?.trim();
    if (fromEnv) { return fromEnv; }
    if (platform === 'win32') {
        const localAppData = env.LOCALAPPDATA?.trim();
        return localAppData
            ? path.join(localAppData, 'Arm', 'Packs')
            : path.join(home, 'AppData', 'Local', 'Arm', 'Packs');
    }
    return path.join(home, '.cache', 'arm', 'packs');
}

export function expandPackRoot(filePath: string, packRoot: string): string {
    return filePath.replace(/\$\{CMSIS_PACK_ROOT\}/g, packRoot).replace(/\$CMSIS_PACK_ROOT\b/g, packRoot);
}

/**
 * A file a cbuild-run.yml names, as a path: csolution writes a file under
 * the pack root with `${CMSIS_PACK_ROOT}`, any other one relative to the
 * folder of the cbuild-run file (`out/`), or absolute when no relative path
 * exists. Relative is resolved against that folder, never the working
 * directory of the process. `${CMSIS_COMPILER_ROOT}`, which it writes for
 * files under the compiler root (the toolbox's `etc/` by default), is not
 * expanded: no SVD or image lives there.
 */
export function cbuildRunFilePath(entry: string, cbuildRunFile: string, packRoot: string): string {
    return path.resolve(path.dirname(cbuildRunFile), expandPackRoot(entry, packRoot));
}

/** `<packRoot>/<Vendor>/<Name>/<version>` — the version is required. */
export function packDir(packRoot: string, id: PackId): string | undefined {
    if (!id.version) { return undefined; }
    return path.join(packRoot, id.vendor, id.name, id.version);
}
