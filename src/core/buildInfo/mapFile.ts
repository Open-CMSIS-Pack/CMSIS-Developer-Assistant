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
 * Linker map parser producing one model for GNU ld (GCC, Clang with lld's
 * `-Map` is close enough) and armlink (AC6). IAR maps are detected and
 * reported as unsupported.
 *
 * GNU ld: `Memory Configuration` (regions), `Linker script and memory map`
 * (output sections at column 0, input sections indented one space with the
 * contributing object or `archive(member)`, symbols below them),
 * `Discarded input sections` (count and bytes only).
 *
 * armlink: `Memory Map of the image` (load and execution regions with
 * Base/Size/Max, one row per input section with Type/Attr/Object),
 * `Image component sizes` (per object and library, plus the totals),
 * `Removing Unused input sections` (count and bytes).
 */

import * as path from 'path';

export type MapFormat = 'gnu' | 'armlink' | 'iar' | 'unknown';

export interface MapRegion {
    name: string;
    origin: number;
    length: number;
    /** GNU attributes (`xrw`) or armlink `ABSOLUTE`/`COMPRESSED`. */
    attributes?: string;
    /** `memory` (GNU MEMORY command), armlink `load` or `execution` region. */
    kind: 'memory' | 'load' | 'execution';
    /** Bytes the linker placed there (armlink Size). */
    used?: number;
}

export type SizeClass = 'code' | 'rodata' | 'data' | 'bss' | 'other';

export interface MapInputSection {
    name: string;
    address: number;
    size: number;
    /** Display name: `main.o`, `libutil.a(crc.o)`, `c_wu.l(__main.o)`. */
    object: string;
    /** Archive/library name when the object came from one. */
    library?: string;
    /** armlink Type: Code, Data, Zero, PAD, Veneer. */
    type?: string;
    /** armlink Attr: RO, RW. */
    attr?: string;
    class: SizeClass;
    /**
     * GNU ld lists every contributor to a merged string/constant pool
     * (`.rodata.str1.1`) at the pool's address with its pre-merge size;
     * only the first counts towards the totals.
     */
    merged?: boolean;
}

export interface MapOutputSection {
    name: string;
    address: number;
    size: number;
    /** GNU `load address` when it differs (initialisers in flash). */
    loadAddress?: number;
    /** Containing memory region (GNU) or load region (armlink). */
    region?: string;
    /** False for debug/comment sections at address 0. */
    allocated: boolean;
    class: SizeClass;
    inputs: MapInputSection[];
    /** Fill/padding bytes inside the section. */
    fill: number;
}

export interface MapSymbol {
    name: string;
    address: number;
    object?: string;
    /** Output section that contains it. */
    section?: string;
}

export interface ObjectTotal {
    object: string;
    library?: string;
    code: number;
    roData: number;
    rwData: number;
    ziData: number;
    /** Code + RO data + RW data — what the object costs in ROM. */
    rom: number;
    /** RW + ZI — what it costs in RAM. */
    ram: number;
}

export interface MapTotals {
    code?: number;
    roData?: number;
    rwData?: number;
    ziData?: number;
    /** armlink "Total RO Size", "Total RW Size", "Total ROM Size". */
    ro?: number;
    rw?: number;
    rom?: number;
}

export interface MapFile {
    file: string;
    format: MapFormat;
    /** armlink `Component:` line, or the GNU ld version when present. */
    toolLine?: string;
    entry?: number;
    regions: MapRegion[];
    sections: MapOutputSection[];
    symbols: MapSymbol[];
    discarded: { count: number; bytes: number };
    /** Per object and library member (armlink from "Image component sizes", GNU summed from input sections). */
    objectTotals: ObjectTotal[];
    /** Per library (armlink "Library Name" table; GNU summed). */
    libraryTotals: ObjectTotal[];
    totals: MapTotals;
    notes: string[];
}

export function detectMapFormat(text: string): MapFormat {
    const head = text.slice(0, 4000);
    if (/^Component: .*armlink/m.test(head) || /^Memory Map of the image/m.test(text.slice(0, 200_000)) || /^Image component sizes/m.test(head)) { return 'armlink'; }
    if (/IAR ELF Linker|^\*{3,}.*IAR|^#{10,}/m.test(head) && /IAR/.test(head)) { return 'iar'; }
    if (/^Memory Configuration$/m.test(text) || /^Linker script and memory map$/m.test(text) || /^Archive member included/m.test(head)) { return 'gnu'; }
    return 'unknown';
}

/** Section name → size class (GNU output section names and armlink section names). */
export function classifySectionName(name: string): SizeClass {
    const n = name.toLowerCase();
    if (/(^|\.)(bss|heap|stack|noinit|no_init|uninit)(\b|\.|$)|\$\$zi|_zi\b|\.zi\b|ARM_LIB_(HEAP|STACK)/i.test(name)) { return 'bss'; }
    if (/(^|\.)(data|sdata|tdata|ramfunc|fastcode|ram_code|copy\.table|zero\.table)(\b|\.|$)|\$\$rw/i.test(name)) { return 'data'; }
    if (/(^|\.)(rodata|constdata|ARM\.exidx|ARM\.extab|init_array|fini_array|preinit_array|ctors|dtors|eh_frame|gcc_except_table|tbss)(\b|\.|$)|\$\$ro/i.test(name)) { return 'rodata'; }
    if (/(^|\.)(text|isr_vector|vectors|reset|init|fini|glue_7|glue_7t|iplt|plt|vfp11_veneer|v4_bx|rel\.dyn|igot\.plt|region\$\$table)(\b|\.|$)|^!!|\.ARM\.Collect|^x\$fpl/i.test(name)) { return 'code'; }
    if (n.startsWith('.debug') || n === '.comment' || n === '.arm.attributes' || n.startsWith('.note') || n === '.symtab' || n === '.strtab' || n === '.shstrtab') { return 'other'; }
    return 'other';
}

function parseHex(s: string): number {
    return parseInt(s, 16) >>> 0;
}

/** `/a/b/libutil.a(crc.o)` → { object: 'libutil.a(crc.o)', library: 'libutil.a' }; `CMakeFiles/Group_App.dir/x/main.c.obj` → `main.c.obj`. */
export function objectDisplayName(raw: string): { object: string; library?: string } {
    const t = raw.trim();
    const m = t.match(/^(.*?)\(([^()]+)\)$/);
    if (m) {
        const lib = path.basename(m[1].replace(/\\/g, '/'));
        return { object: `${lib}(${path.basename(m[2].replace(/\\/g, '/'))})`, library: lib };
    }
    if (t === 'linker stubs' || t === 'anon$$obj.o') { return { object: t }; }
    return { object: path.basename(t.replace(/\\/g, '/')) };
}

function addTotal(map: Map<string, ObjectTotal>, key: string, library: string | undefined, cls: SizeClass, size: number): void {
    let t = map.get(key);
    if (!t) { t = { object: key, library, code: 0, roData: 0, rwData: 0, ziData: 0, rom: 0, ram: 0 }; map.set(key, t); }
    switch (cls) {
        case 'code': t.code += size; t.rom += size; break;
        case 'rodata': t.roData += size; t.rom += size; break;
        case 'data': t.rwData += size; t.rom += size; t.ram += size; break;
        case 'bss': t.ziData += size; t.ram += size; break;
        default: break;
    }
}

function finishTotals(objects: Map<string, ObjectTotal>): { objectTotals: ObjectTotal[]; libraryTotals: ObjectTotal[] } {
    const libs = new Map<string, ObjectTotal>();
    for (const o of objects.values()) {
        if (!o.library) { continue; }
        let l = libs.get(o.library);
        if (!l) { l = { object: o.library, code: 0, roData: 0, rwData: 0, ziData: 0, rom: 0, ram: 0 }; libs.set(o.library, l); }
        l.code += o.code; l.roData += o.roData; l.rwData += o.rwData; l.ziData += o.ziData; l.rom += o.rom; l.ram += o.ram;
    }
    const byRom = (a: ObjectTotal, b: ObjectTotal) => (b.rom + b.ram) - (a.rom + a.ram) || a.object.localeCompare(b.object);
    return { objectTotals: [...objects.values()].sort(byRom), libraryTotals: [...libs.values()].sort(byRom) };
}

export function regionFor(regions: readonly MapRegion[], address: number, kinds: MapRegion['kind'][] = ['memory', 'load']): MapRegion | undefined {
    return regions.find(r => kinds.includes(r.kind) && r.origin <= address && address < r.origin + r.length);
}

// ------------------------------------------------------------------ GNU ld

function parseGnu(text: string, file: string): MapFile {
    const lines = text.split(/\r?\n/);
    const map: MapFile = {
        file, format: 'gnu', regions: [], sections: [], symbols: [], discarded: { count: 0, bytes: 0 },
        objectTotals: [], libraryTotals: [], totals: {}, notes: [],
    };
    const objects = new Map<string, ObjectTotal>();
    type Part = 'head' | 'discarded' | 'memory' | 'map' | 'xref';
    let part: Part = 'head';
    let current: MapOutputSection | undefined;
    let currentAddrs = new Set<number>();       // input addresses seen in the current output section (merged pools)
    let pendingInputName: string | undefined;   // long input-section name on its own line
    let pendingOutputName: string | undefined;  // long output-section name on its own line
    let pendingDiscard = false;

    const outRe = /^(\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)(?:\s+load address 0x([0-9a-fA-F]+))?\s*$/;
    const outContRe = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)(?:\s+load address 0x([0-9a-fA-F]+))?\s*$/;
    const inRe = /^ (\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S.*?)\s*$/;
    const inContRe = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S.*?)\s*$/;
    const fillRe = /^\s\*fill\*\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)/;
    const symRe = /^\s+0x([0-9a-fA-F]+)\s+(\S.*?)\s*$/;
    const discardRe = /^ (\S+)\s+0x[0-9a-fA-F]+\s+0x([0-9a-fA-F]+)\s+\S/;
    const discardContRe = /^\s+0x[0-9a-fA-F]+\s+0x([0-9a-fA-F]+)\s+\S/;

    const finishSection = () => {
        if (!current) { return; }
        if (current.class === 'other' && current.allocated) {
            // A user-named section (`ethos_cache_buf`, `.ddr`): initialised data when it has a load address,
            // else whatever most of its inputs are.
            const counts: Record<SizeClass, number> = { code: 0, rodata: 0, data: 0, bss: 0, other: 0 };
            for (const i of current.inputs) { if (!i.merged) { counts[i.class] += i.size; } }
            const best = (Object.keys(counts) as SizeClass[]).filter(c => c !== 'other').sort((a, b) => counts[b] - counts[a])[0];
            if (current.loadAddress !== undefined && current.loadAddress !== current.address) { current.class = 'data'; }
            else if (counts[best] > 0) { current.class = best; }
            if (current.class !== 'other') {
                for (const i of current.inputs) {
                    if (i.class !== 'other') { continue; }
                    i.class = current.class;
                    if (i.size > 0 && !i.merged) { addTotal(objects, i.object, i.library, i.class, i.size); }
                }
            }
        }
        map.sections.push(current);
        current = undefined;
    };
    const startOutput = (name: string, addr: number, size: number, load?: number) => {
        finishSection();
        const allocated = addr !== 0 || (size > 0 && !name.startsWith('.debug') && name !== '.comment' && !name.startsWith('.ARM.attributes'));
        const region = allocated ? regionFor(map.regions, addr, ['memory']) : undefined;
        currentAddrs = new Set<number>();
        current = { name, address: addr, size, loadAddress: load, region: region?.name, allocated, class: classifySectionName(name), inputs: [], fill: 0 };
    };
    const addInput = (name: string, addr: number, size: number, rawObject: string) => {
        if (!current) { return; }
        const { object, library } = objectDisplayName(rawObject);
        // `.rodata.*` placed into `.text` stays read-only data; an input without a telling name takes the output section's class.
        const own = classifySectionName(name);
        const cls = own !== 'other' ? own : current.class;
        const merged = size > 0 && currentAddrs.has(addr);
        if (size > 0) { currentAddrs.add(addr); }
        current.inputs.push({ name, address: addr, size, object, library, class: cls, ...(merged ? { merged } : {}) });
        if (current.allocated && size > 0 && cls !== 'other' && !merged) { addTotal(objects, object, library, cls, size); }
    };

    for (const line of lines) {
        if (line === 'Discarded input sections') { part = 'discarded'; continue; }
        if (line === 'Memory Configuration') { part = 'memory'; continue; }
        if (line === 'Linker script and memory map') { part = 'map'; continue; }
        if (line === 'Cross Reference Table') { finishSection(); part = 'xref'; continue; }
        if (part === 'head' && /^GNU ld|^LLD /.test(line)) { map.toolLine = line.trim(); }

        if (part === 'discarded') {
            if (pendingDiscard) {
                pendingDiscard = false;
                const m = line.match(discardContRe);
                if (m) { map.discarded.count++; map.discarded.bytes += parseHex(m[1]); continue; }
            }
            const m = line.match(discardRe);
            if (m) { map.discarded.count++; map.discarded.bytes += parseHex(m[2]); continue; }
            if (/^ \S+\s*$/.test(line)) { pendingDiscard = true; }
            continue;
        }
        if (part === 'memory') {
            const m = line.match(/^(\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s*(\S*)\s*$/);
            if (m && m[1] !== 'Name' && m[1] !== '*default*') {
                map.regions.push({ name: m[1], origin: parseHex(m[2]), length: parseHex(m[3]), attributes: m[4] || undefined, kind: 'memory' });
            }
            continue;
        }
        if (part !== 'map') { continue; }

        if (line.startsWith('LOAD ') || line.startsWith('OUTPUT(') || line.startsWith('START GROUP') || line.startsWith('END GROUP')) { continue; }
        if (line.trim() === '') { continue; }

        // Output section with the name alone on the line (too long for one line).
        if (pendingOutputName) {
            const m = line.match(outContRe);
            const name = pendingOutputName;
            pendingOutputName = undefined;
            if (m) { startOutput(name, parseHex(m[1]), parseHex(m[2]), m[3] ? parseHex(m[3]) : undefined); continue; }
        }
        if (pendingInputName) {
            const m = line.match(inContRe);
            const name = pendingInputName;
            pendingInputName = undefined;
            if (m) { addInput(name, parseHex(m[1]), parseHex(m[2]), m[3]); continue; }
        }
        if (!line.startsWith(' ')) {
            const m = line.match(outRe);
            if (m) { startOutput(m[1], parseHex(m[2]), parseHex(m[3]), m[4] ? parseHex(m[4]) : undefined); continue; }
            if (/^\S+$/.test(line) && !line.startsWith('/DISCARD/')) { pendingOutputName = line.trim(); continue; }
            if (line.startsWith('/DISCARD/')) { finishSection(); }
            continue;
        }
        if (line.startsWith(' *(') || line.startsWith(' *fill*')) {
            const f = line.match(fillRe);
            if (f && current) { current.fill += parseHex(f[2]); }
            continue;
        }
        if (line.match(/^ \S/) && !line.match(/^ 0x/)) {
            const m = line.match(inRe);
            if (m) { addInput(m[1], parseHex(m[2]), parseHex(m[3]), m[4]); continue; }
            if (/^ \S+\s*$/.test(line)) { pendingInputName = line.trim(); }
            continue;
        }
        // Deeper-indented: symbol or assignment under the last input section.
        const s = line.match(symRe);
        if (s && current) {
            const name = s[2];
            if (name.includes(' = ') || name.startsWith('PROVIDE') || name.startsWith('ASSERT') || name.startsWith('. =') || /\(size before relaxing\)/.test(name)) { continue; }
            const last = current.inputs[current.inputs.length - 1];
            map.symbols.push({ name, address: parseHex(s[1]), object: last?.object, section: current.name });
        }
    }
    finishSection();
    Object.assign(map, finishTotals(objects));
    // Per class from the input sections (so `.rodata.*` inside `.text` counts as RO data); what the inputs do not
    // account for (fill, `. = . + N` reservations) goes to the output section's own class.
    const sum = (cls: SizeClass) => map.sections.filter(s => s.allocated).reduce((a, s) => {
        const counted = s.inputs.filter(i => !i.merged);
        const inputs = counted.reduce((x, i) => x + i.size, 0);
        return a + counted.filter(i => i.class === cls).reduce((x, i) => x + i.size, 0) + (s.class === cls ? Math.max(0, s.size - inputs) : 0);
    }, 0);
    map.totals = { code: sum('code'), roData: sum('rodata'), rwData: sum('data'), ziData: sum('bss') };
    map.totals.ro = map.totals.code! + map.totals.roData!;
    map.totals.rw = map.totals.rwData! + map.totals.ziData!;
    map.totals.rom = map.totals.ro + map.totals.rwData!;
    if (!map.regions.length) { map.notes.push('no Memory Configuration in the map (linker script without MEMORY); regions come from cbuild-run'); }
    return map;
}

// ------------------------------------------------------------------ armlink

function parseArmlink(text: string, file: string): MapFile {
    const lines = text.split(/\r?\n/);
    const map: MapFile = {
        file, format: 'armlink', regions: [], sections: [], symbols: [], discarded: { count: 0, bytes: 0 },
        objectTotals: [], libraryTotals: [], totals: {}, notes: [],
    };
    const objects = new Map<string, ObjectTotal>();
    type Part = 'head' | 'unused' | 'symbols' | 'memmap' | 'sizes';
    let part: Part = 'head';
    let load: MapRegion | undefined;
    let exec: MapOutputSection | undefined;
    let sizesTable: 'object' | 'member' | 'library' | 'totals' | undefined;
    const sizeObjects: ObjectTotal[] = [];
    const sizeMembers: ObjectTotal[] = [];
    const sizeLibraries: ObjectTotal[] = [];
    let symbolTable: 'local' | 'global' | undefined;

    const rowRe = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(Code|Data|Zero|PAD|Veneer)(?:\s+(RO|RW))?(?:\s+(\d+))?(?:\s+(\*))?(?:\s+(\S+))?(?:\s+(\S.*?))?\s*$/;
    const regionRe = /^\s+(Load|Execution) Region (\S+) \(Base: 0x([0-9a-fA-F]+), Size: 0x([0-9a-fA-F]+), Max: 0x([0-9a-fA-F]+)(?:, (.*))?\)/;
    const sizesRowRe = /^\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/;
    const symRe = /^\s{4}(\S.*?)\s+(0x[0-9a-fA-F]+)\s+(Number|Section|Thumb Code|ARM Code|Data|Data Ptr)?\s*(\d+)?\s+([^\s(]+)(?:\((\S+)\))?/;

    const finishExec = () => { if (exec) { map.sections.push(exec); exec = undefined; } };

    for (const line of lines) {
        if (/^Component: /.test(line)) { map.toolLine = line.trim(); continue; }
        if (/^Removing Unused input sections/.test(line)) { part = 'unused'; continue; }
        if (/^Image Symbol Table/.test(line)) { part = 'symbols'; continue; }
        if (/^Memory Map of the image/.test(line)) { part = 'memmap'; continue; }
        if (/^Image component sizes/.test(line)) { finishExec(); part = 'sizes'; continue; }

        if (part === 'unused') {
            const m = line.match(/^(\d+) unused section\(s\) \(total (\d+) bytes\) removed/);
            if (m) { map.discarded = { count: Number(m[1]), bytes: Number(m[2]) }; }
            continue;
        }
        if (part === 'symbols') {
            if (/^\s+Local Symbols/.test(line)) { symbolTable = 'local'; continue; }
            if (/^\s+Global Symbols/.test(line)) { symbolTable = 'global'; continue; }
            if (!symbolTable) { continue; }
            const m = line.match(symRe);
            if (m && m[3] && m[3] !== 'Number' && m[3] !== 'Section') {
                const { object } = objectDisplayName(m[5]);
                const address = parseHex(m[2].slice(2));
                map.symbols.push({ name: m[1], address: m[3] === 'Thumb Code' ? address & ~1 : address, object, section: m[6] });
            }
            continue;
        }
        if (part === 'memmap') {
            const e = line.match(/^\s+Image Entry point : 0x([0-9a-fA-F]+)/);
            if (e) { map.entry = parseHex(e[1]); continue; }
            const r = line.match(regionRe);
            if (r) {
                const base = parseHex(r[3]), size = parseHex(r[4]), max = parseHex(r[5]);
                if (r[1] === 'Load') {
                    finishExec();
                    load = { name: r[2], origin: base, length: max, used: size, attributes: r[6], kind: 'load' };
                    map.regions.push(load);
                } else {
                    finishExec();
                    map.regions.push({ name: r[2], origin: base, length: max, used: size, attributes: r[6], kind: 'execution' });
                    exec = { name: r[2], address: base, size, region: load?.name, allocated: true, class: 'other', inputs: [], fill: 0 };
                }
                continue;
            }
            const m = line.match(rowRe);
            if (m && exec) {
                const size = parseHex(m[2]);
                if (m[3] === 'PAD') { exec.fill += size; continue; }
                const sectionName = m[7] ?? '';
                const { object, library } = objectDisplayName(m[8] ?? '');
                const cls: SizeClass = m[3] === 'Zero' ? 'bss' : m[4] === 'RW' ? 'data' : m[3] === 'Code' || m[3] === 'Veneer' ? 'code' : 'rodata';
                exec.inputs.push({ name: sectionName, address: parseHex(m[1]), size, object, library, type: m[3], attr: m[4], class: cls });
                if (size > 0) { addTotal(objects, object, library, cls, size); }
            }
            continue;
        }
        if (part === 'sizes') {
            if (/Object Name\s*$/.test(line)) { sizesTable = 'object'; continue; }
            if (/Library Member Name\s*$/.test(line)) { sizesTable = 'member'; continue; }
            if (/Library Name\s*$/.test(line)) { sizesTable = 'library'; continue; }
            if (/^\s+Code \(inc\. data\)\s+RO Data\s+RW Data\s+ZI Data\s+Debug\s*$/.test(line)) { sizesTable = 'totals'; continue; }
            const t = line.match(/^\s+Total (RO|RW|ROM)\s+Size .*?\s(\d+) \(/);
            if (t) {
                if (t[1] === 'RO') { map.totals.ro = Number(t[2]); } else if (t[1] === 'RW') { map.totals.rw = Number(t[2]); } else { map.totals.rom = Number(t[2]); }
                continue;
            }
            const m = line.match(sizesRowRe);
            if (!m || !sizesTable) { continue; }
            const name = m[7];
            const row: ObjectTotal = {
                object: name, code: Number(m[1]) + Number(m[2]), roData: Number(m[3]), rwData: Number(m[4]), ziData: Number(m[5]),
                rom: Number(m[1]) + Number(m[2]) + Number(m[3]) + Number(m[4]), ram: Number(m[4]) + Number(m[5]),
            };
            if (/Totals$|^\(incl\./.test(name)) {
                if (name === 'Grand Totals') {
                    map.totals.code = row.code; map.totals.roData = row.roData; map.totals.rwData = row.rwData; map.totals.ziData = row.ziData;
                }
                continue;
            }
            if (sizesTable === 'object') { sizeObjects.push(row); }
            else if (sizesTable === 'member') { sizeMembers.push(row); }
            else if (sizesTable === 'library') { sizeLibraries.push(row); }
        }
    }
    finishExec();
    for (const s of map.sections) {
        const counts = { code: 0, rodata: 0, data: 0, bss: 0 };
        for (const i of s.inputs) { if (i.class !== 'other') { counts[i.class] += i.size; } }
        const best = (Object.keys(counts) as (keyof typeof counts)[]).sort((a, b) => counts[b] - counts[a])[0];
        s.class = counts[best] > 0 ? best : classifySectionName(s.name);
    }
    const summed = finishTotals(objects);
    if (sizeObjects.length || sizeMembers.length) {
        // The linker's own numbers are authoritative; attach the library from the memory map rows.
        const libOf = new Map<string, string | undefined>();
        for (const o of summed.objectTotals) { libOf.set(o.object.replace(/^.*\(|\)$/g, ''), o.library); }
        map.objectTotals = [...sizeObjects, ...sizeMembers.map(m => {
            const lib = libOf.get(m.object);
            return { ...m, object: lib ? `${lib}(${m.object})` : m.object, library: lib };
        })].sort((a, b) => (b.rom + b.ram) - (a.rom + a.ram) || a.object.localeCompare(b.object));
        map.libraryTotals = sizeLibraries.length ? sizeLibraries.sort((a, b) => (b.rom + b.ram) - (a.rom + a.ram)) : summed.libraryTotals;
    } else {
        map.objectTotals = summed.objectTotals;
        map.libraryTotals = summed.libraryTotals;
        map.notes.push('no "Image component sizes" in the map (link without --info sizes); per-object sizes are summed from the memory map');
    }
    if (map.totals.ro === undefined && map.sections.length) {
        const sum = (cls: SizeClass) => map.sections.reduce((a, s) => a + s.inputs.filter(i => i.class === cls).reduce((x, i) => x + i.size, 0), 0);
        map.totals.code = sum('code'); map.totals.roData = sum('rodata'); map.totals.rwData = sum('data'); map.totals.ziData = sum('bss');
        map.totals.ro = map.totals.code + map.totals.roData; map.totals.rw = map.totals.rwData + map.totals.ziData; map.totals.rom = map.totals.ro + map.totals.rwData;
    }
    if (!map.sections.length) { map.notes.push('no "Memory Map of the image" in the map (link without --map)'); }
    return map;
}

// ------------------------------------------------------------------ entry

export function parseMapFile(text: string, file: string): MapFile {
    const format = detectMapFormat(text);
    switch (format) {
        case 'gnu': return parseGnu(text, file);
        case 'armlink': return parseArmlink(text, file);
        case 'iar': return {
            file, format, regions: [], sections: [], symbols: [], discarded: { count: 0, bytes: 0 }, objectTotals: [], libraryTotals: [], totals: {},
            notes: ['IAR ILINK map files are not supported yet; the ELF is still read'],
        };
        default: return {
            file, format, regions: [], sections: [], symbols: [], discarded: { count: 0, bytes: 0 }, objectTotals: [], libraryTotals: [], totals: {},
            notes: [`${path.basename(file)} is not a GNU ld or armlink map (${text.trim().split('\n')[0]?.slice(0, 60) || 'empty'})`],
        };
    }
}

/** The input section (and so the object) that contains `address`. */
export function inputSectionAt(map: MapFile, address: number): { section: MapOutputSection; input: MapInputSection } | undefined {
    for (const s of map.sections) {
        if (!s.allocated) { continue; }
        for (const i of s.inputs) {
            if (i.size > 0 && i.address <= address && address < i.address + i.size) { return { section: s, input: i }; }
        }
    }
    return undefined;
}

export function outputSectionAt(map: MapFile, address: number): MapOutputSection | undefined {
    return map.sections.find(s => s.allocated && s.size > 0 && s.address <= address && address < s.address + s.size);
}
