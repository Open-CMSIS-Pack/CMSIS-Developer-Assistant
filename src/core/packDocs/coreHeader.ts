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
 * The Arm core peripherals — SCB, NVIC, SysTick, MPU, SAU, FPU, DWT, ITM,
 * TPIU, DCB/CoreDebug, DIB, PMU … — which vendor SVDs mostly leave out.
 * CMSIS-Core defines them deterministically in `core_cm<n>.h`:
 *
 *   typedef struct { __IOM uint32_t ICSR;  /*!< Offset: 0x004 (R/W)  Interrupt Control … *\/ … } SCB_Type;
 *   #define SCB_ICSR_PENDSVCLR_Pos  27U
 *   #define SCB_ICSR_PENDSVCLR_Msk  (1UL << SCB_ICSR_PENDSVCLR_Pos)
 *   #define SCB_BASE  (SCS_BASE + 0x0D00UL)
 *   #define SCB       ((SCB_Type *) SCB_BASE)
 *
 * Parsed into the same summary shape as an SVD, so the debug panel's bit
 * view and `get_peripheral_docs` work on them unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PackDocsLog, silentLog } from './host';
import { SvdField, SvdPeripheral, SvdRegister, SvdSummary } from './svdLite';
import { pickInstalledVersion } from './targetDocs';

/** Core name (pdsc `Dcore`) → CMSIS-Core header. */
const HEADER_BY_CORE: Record<string, string> = {
    'cortex-m0': 'core_cm0.h', 'cortex-m0+': 'core_cm0plus.h', 'cortex-m0plus': 'core_cm0plus.h', 'cortex-m1': 'core_cm1.h',
    'cortex-m3': 'core_cm3.h', 'cortex-m4': 'core_cm4.h', 'cortex-m7': 'core_cm7.h',
    'cortex-m23': 'core_cm23.h', 'cortex-m33': 'core_cm33.h', 'cortex-m35p': 'core_cm35p.h',
    'cortex-m52': 'core_cm52.h', 'cortex-m55': 'core_cm55.h', 'cortex-m85': 'core_cm85.h',
    'sc000': 'core_sc000.h', 'sc300': 'core_sc300.h', 'star-mc1': 'core_starmc1.h', 'star-mc3': 'core_starmc3.h',
    'armv8mbl': 'core_cm23.h', 'armv8mml': 'core_cm33.h', 'armv81mml': 'core_cm55.h',
};

const GROUP_OF: Record<string, string> = {
    SCB: 'System', SCnSCB: 'System', ICB: 'System', SysTick: 'System', NVIC: 'System', EWIC: 'System',
    DCB: 'Debug', CoreDebug: 'Debug', DIB: 'Debug', DWT: 'Debug', FPB: 'Debug',
    ITM: 'Trace', TPIU: 'Trace', ETM: 'Trace', MTB: 'Trace',
    MPU: 'Memory protection', SAU: 'Memory protection',
    FPU: 'FPU', PMU: 'PMU',
};

const FULL_NAME: Record<string, string> = {
    SCB: 'System Control Block', SCnSCB: 'System Control not in SCB', ICB: 'Implementation Control Block',
    SysTick: 'System Tick Timer', NVIC: 'Nested Vectored Interrupt Controller', EWIC: 'External Wakeup Interrupt Controller',
    DCB: 'Debug Control Block', CoreDebug: 'Core Debug (legacy view of the DCB)', DIB: 'Debug Identification Block',
    DWT: 'Data Watchpoint and Trace', FPB: 'Flash Patch and Breakpoint', ITM: 'Instrumentation Trace Macrocell',
    TPIU: 'Trace Port Interface Unit', ETM: 'Embedded Trace Macrocell', MTB: 'Micro Trace Buffer',
    MPU: 'Memory Protection Unit', SAU: 'Security Attribution Unit', FPU: 'Floating-Point Unit', PMU: 'Performance Monitoring Unit',
};

export interface CoreHeaderRef {
    /** `core_cm33.h` */
    file: string;
    path: string;
    /** `ARM::CMSIS@6.3.0` */
    pack: string;
    exists: boolean;
}

/** The CMSIS-Core header for a core, from the highest installed ARM::CMSIS pack. */
export function resolveCoreHeader(packRoot: string, core: string): CoreHeaderRef | undefined {
    const file = HEADER_BY_CORE[core.trim().toLowerCase()];
    if (!file) { return undefined; }
    const version = pickInstalledVersion(packRoot, { vendor: 'ARM', name: 'CMSIS' });
    if (!version) { return { file, path: '', pack: 'ARM::CMSIS (not installed)', exists: false }; }
    const p = path.join(packRoot, 'ARM', 'CMSIS', version, 'CMSIS', 'Core', 'Include', file);
    return { file, path: p, pack: `ARM::CMSIS@${version}`, exists: fs.existsSync(p) };
}

interface StructMember {
    name: string;
    offset: number;
    width: number;
    count: number;
    access?: string;
    description?: string;
}

const TYPE_WIDTH: Record<string, number> = { uint8_t: 1, uint16_t: 2, uint32_t: 4, uint64_t: 8, int32_t: 4 };

function parseStructs(text: string): Map<string, StructMember[]> {
    const out = new Map<string, StructMember[]>();
    const re = /typedef\s+struct\s*\{([\s\S]*?)\}\s*(\w+)_Type\s*;/g;
    for (const m of text.matchAll(re)) {
        const members: StructMember[] = [];
        let offset = 0;
        for (const line of m[1].split('\n')) {
            const mm = line.match(/^\s*(__IOM|__IM|__OM|__IO|__I|__O)?\s*(uint8_t|uint16_t|uint32_t|uint64_t|int32_t)\s+(\w+)(?:\[(\d+)U?\])?\s*;(?:\s*\/\*!<\s*Offset:\s*(0x[0-9A-Fa-f]+)\s*\(([^)]*)\)\s*([^*]*?)\s*\*\/)?/);
            if (!mm) { continue; }
            const width = TYPE_WIDTH[mm[2]];
            const count = mm[4] ? parseInt(mm[4], 10) : 1;
            if (mm[5]) { offset = parseInt(mm[5], 16); }
            if (!/^RESERVED/i.test(mm[3])) {
                members.push({
                    name: mm[3], offset, width, count,
                    ...(mm[6] ? { access: mm[6].trim() } : {}),
                    ...(mm[7] ? { description: mm[7].trim() } : {}),
                });
            }
            offset += width * count;
        }
        out.set(m[2], members);
    }
    return out;
}

function popcount(n: number): number {
    let c = 0;
    for (let v = n >>> 0; v; v >>>= 1) { c += v & 1; }
    return c;
}

/** `_Pos` / `_Msk` macro pairs → base name → { pos, width }. */
function parseFieldMacros(text: string): Map<string, { pos: number; width: number }> {
    const pos = new Map<string, number>();
    const width = new Map<string, number>();
    for (const m of text.matchAll(/#define\s+(\w+)_Pos\s+(\d+)U?\b/g)) { pos.set(m[1], parseInt(m[2], 10)); }
    for (const m of text.matchAll(/#define\s+(\w+)_Msk\s+\(\s*(0x[0-9A-Fa-f]+|\d+)UL\b/g)) {
        const v = m[2].startsWith('0x') ? parseInt(m[2].slice(2), 16) : parseInt(m[2], 10);
        width.set(m[1], Math.max(1, popcount(v)));
    }
    const out = new Map<string, { pos: number; width: number }>();
    for (const [name, p] of pos) { out.set(name, { pos: p, width: width.get(name) ?? 1 }); }
    return out;
}

/** `#define X_BASE (SCS_BASE + 0x0D00UL)` → evaluated addresses. */
function parseBases(text: string): Map<string, number> {
    const raw = new Map<string, string>();
    for (const m of text.matchAll(/#define\s+(\w+_BASE(?:_NS)?)\s+\(([^)]*)\)/g)) { raw.set(m[1], m[2]); }
    const out = new Map<string, number>();
    const evaluate = (name: string, depth = 0): number | undefined => {
        if (out.has(name)) { return out.get(name); }
        const expr = raw.get(name);
        if (expr === undefined || depth > 8) { return undefined; }
        let sum = 0;
        for (const term of expr.split('+')) {
            const t = term.trim().replace(/UL?$/i, '');
            if (/^0x[0-9A-Fa-f]+$/.test(t)) { sum += parseInt(t.slice(2), 16); }
            else if (/^\d+$/.test(t)) { sum += parseInt(t, 10); }
            else {
                const v = evaluate(t, depth + 1);
                if (v === undefined) { return undefined; }
                sum += v;
            }
        }
        out.set(name, sum >>> 0);
        return sum >>> 0;
    };
    for (const name of raw.keys()) { evaluate(name); }
    return out;
}

/** Parse a CMSIS-Core header into an SVD-shaped summary of the core peripherals. */
export function parseCoreHeader(text: string, file: string, core?: string): SvdSummary {
    const structs = parseStructs(text);
    const macros = parseFieldMacros(text);
    const bases = parseBases(text);
    const instances: { name: string; struct: string; base: string }[] = [];
    for (const m of text.matchAll(/#define\s+(\w+)\s+\(\(\s*(\w+)_Type\s*\*\s*\)\s*(\w+)\s*\)/g)) {
        if (structs.has(m[2])) { instances.push({ name: m[1], struct: m[2], base: m[3] }); }
    }
    const byLength = [...instances].sort((a, b) => b.name.length - a.name.length);

    // Fields per (instance, register): SCB_ICSR_PENDSVCLR → SCB / ICSR / PENDSVCLR.
    const fields = new Map<string, SvdField[]>();
    for (const [name, f] of macros) {
        const inst = byLength.find(i => name.startsWith(`${i.name}_`));
        if (!inst) { continue; }
        const rest = name.slice(inst.name.length + 1);
        const members = structs.get(inst.struct) ?? [];
        let reg = members.filter(r => rest.startsWith(`${r.name}_`)).sort((a, b) => b.name.length - a.name.length)[0];
        if (!reg) {
            // DWT_FUNCTION_MATCH → the first of FUNCTION0..3.
            reg = members.filter(r => r.name.replace(/\d+$/, '') !== r.name && rest.startsWith(`${r.name.replace(/\d+$/, '')}_`)).sort((a, b) => a.name.localeCompare(b.name))[0];
        }
        if (!reg) { continue; }
        const regBase = rest.startsWith(`${reg.name}_`) ? reg.name : reg.name.replace(/\d+$/, '');
        const fieldName = rest.slice(regBase.length + 1);
        if (!fieldName) { continue; }
        const key = `${inst.name} ${reg.name}`;
        const list = fields.get(key) ?? [];
        if (!list.some(x => x.name === fieldName)) { list.push({ name: fieldName, bitOffset: f.pos, bitWidth: f.width }); }
        fields.set(key, list);
    }

    const peripherals: SvdPeripheral[] = [];
    for (const inst of instances) {
        const base = bases.get(inst.base);
        if (base === undefined) { continue; }
        const plain = inst.name.replace(/_NS$/, '');
        const ns = inst.name.endsWith('_NS');
        const registers: SvdRegister[] = (structs.get(inst.struct) ?? []).map(r => ({
            name: r.name,
            offset: r.offset,
            description: [
                r.description,
                r.count > 1 ? `${r.count} × ${r.width * 8}-bit` : r.width !== 4 ? `${r.width * 8}-bit` : undefined,
                r.access ? `(${r.access})` : undefined,
            ].filter(Boolean).join(' '),
            fields: (fields.get(`${inst.name} ${r.name}`) ?? []).sort((a, b) => a.bitOffset - b.bitOffset),
        }));
        peripherals.push({
            name: inst.name,
            groupName: GROUP_OF[plain] ?? 'Core',
            description: `${FULL_NAME[plain] ?? plain}${ns ? ' (non-secure alias)' : ''}`,
            baseAddress: base,
            ...(ns ? { derivedFrom: plain } : {}),
            registers: ns ? [] : registers,
            interrupts: [],
        });
    }
    return { file, device: core ? `${core} core peripherals (${path.basename(file)})` : path.basename(file), peripherals };
}

const cache = new Map<string, { mtimeMs: number; size: number; summary: SvdSummary }>();

export function loadCoreHeader(ref: CoreHeaderRef, core: string, log: PackDocsLog = silentLog): SvdSummary {
    const st = fs.statSync(ref.path);
    const hit = cache.get(ref.path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { return hit.summary; }
    const t0 = Date.now();
    const summary = parseCoreHeader(fs.readFileSync(ref.path, 'utf-8'), ref.path, core);
    cache.set(ref.path, { mtimeMs: st.mtimeMs, size: st.size, summary });
    log.debug(`parsed ${ref.path}: ${summary.peripherals.length} core peripherals, ${summary.peripherals.reduce((n, p) => n + p.registers.length, 0)} registers in ${Date.now() - t0} ms`);
    return summary;
}
