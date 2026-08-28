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
 * The shipped core-peripheral SVDs (`assets/svd/core/<Core>.svd`, generated
 * by `scripts/core-svd/gen_core_svd.py` from the CMSIS-Core headers plus the
 * Arm ARM / TRM descriptions). Preferred over `coreHeader.ts`, which parses
 * `core_cm<n>.h` at runtime and therefore has offsets and bit positions but
 * no descriptions; the header stays the fallback for a core without a file.
 *
 * `index.json` maps the csolution / cbuild-run `core:` name to the file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PackDocsLog, silentLog } from './host';
import { SvdSummary, loadSvd } from './svdLite';

/** pdsc `Dcore` spellings → the `core:` names the index uses. */
const CORE_ALIASES: Record<string, string> = {
    'cortex-m0plus': 'cortex-m0+',
    'armv8mbl': 'cortex-m23', 'armv8mml': 'cortex-m33', 'armv81mml': 'cortex-m55',
};

/** The debug panel groups core peripherals by function, like coreHeader.ts does. */
const GROUP_OF: Record<string, string> = {
    SCB: 'System', SCnSCB: 'System', ICB: 'System', SysTick: 'System', NVIC: 'System', EWIC: 'System', EWIC_ISA: 'System',
    DCB: 'Debug', DIB: 'Debug', DWT: 'Debug', FPB: 'Debug', BPU: 'Debug', CTI: 'Debug',
    ITM: 'Trace', TPIU: 'Trace',
    MPU: 'Memory protection', SAU: 'Memory protection',
    FPU: 'FPU', PMU: 'PMU',
    MEMSYSCTL: 'Memory system', ERRBNK: 'Memory system', PWRMODCTL: 'Memory system', PRCCFGINF: 'Memory system',
    STL: 'Memory system', DCAR: 'Memory system', EMSS: 'Memory system',
};

interface CoreSvdIndex {
    generator: string;
    cmsis: string;
    generated: string;
    cores: Record<string, { file: string; arch: string; header: string; peripherals: string[]; registers: number; fields: number }>;
}

export interface CoreSvdRef {
    /** `Cortex_M33.svd` */
    file: string;
    path: string;
    /** The index's core name, e.g. `Cortex-M33`. */
    core: string;
    /** `ARMv8-M Mainline` */
    arch: string;
    /** Where the description came from, for the panel: `cmsis-pack-docs (from ARM::CMSIS 6.3.0)`. */
    source: string;
    exists: boolean;
}

const indexCache = new Map<string, { mtimeMs: number; index: CoreSvdIndex }>();

function readIndex(dir: string): CoreSvdIndex | undefined {
    const file = path.join(dir, 'index.json');
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return undefined; }
    const hit = indexCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) { return hit.index; }
    const index = JSON.parse(fs.readFileSync(file, 'utf-8')) as CoreSvdIndex;
    indexCache.set(file, { mtimeMs: st.mtimeMs, index });
    return index;
}

/** The directory holding the shipped core SVDs, given the extension's assets directory. */
export function coreSvdDir(assetsDir: string): string {
    return path.join(assetsDir, 'svd', 'core');
}

/** The shipped SVD for a core, or undefined when there is none (unknown core, or no assets directory). */
export function resolveCoreSvd(assetsDir: string | undefined, core: string): CoreSvdRef | undefined {
    if (!assetsDir) { return undefined; }
    const dir = coreSvdDir(assetsDir);
    const index = readIndex(dir);
    if (!index) { return undefined; }
    const wanted = core.trim().toLowerCase();
    const key = CORE_ALIASES[wanted] ?? wanted;
    const entry = Object.entries(index.cores).find(([name]) => name.toLowerCase() === key);
    if (!entry) { return undefined; }
    const [name, info] = entry;
    const p = path.join(dir, info.file);
    return { file: info.file, path: p, core: name, arch: info.arch, source: `cmsis-pack-docs (from ARM::CMSIS ${index.cmsis})`, exists: fs.existsSync(p) };
}

const cache = new Map<string, { mtimeMs: number; summary: SvdSummary }>();

/** Load a shipped core SVD as a summary, with the panel's functional group on every peripheral. */
export function loadCoreSvd(ref: CoreSvdRef, log: PackDocsLog = silentLog): SvdSummary {
    const st = fs.statSync(ref.path);
    const hit = cache.get(ref.path);
    if (hit && hit.mtimeMs === st.mtimeMs) { return hit.summary; }
    const raw = loadSvd(ref.path, log);
    const summary: SvdSummary = {
        file: raw.file,
        device: `${ref.core} core peripherals (${ref.file})`,
        peripherals: raw.peripherals.map(p => ({ ...p, groupName: GROUP_OF[p.name.replace(/_NS$/, '')] ?? p.groupName ?? 'Core' })),
    };
    cache.set(ref.path, { mtimeMs: st.mtimeMs, summary });
    log.debug(`loaded ${ref.file}: ${summary.peripherals.length} core peripherals`);
    return summary;
}
