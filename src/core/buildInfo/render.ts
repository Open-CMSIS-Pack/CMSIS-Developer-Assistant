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
 * Plain-text renderers for the build-info tools. Every line names the file
 * it came from (`[Blinky.axf]`, `[Blinky.axf.map]`), results stay under a
 * character budget, and each ends with a `Next:` hint.
 */

import * as path from 'path';
import { clipValue, formatBytes, truncateList } from '../packDocs/textBudget';
import { BuildContext, ImageArtifacts, MemoryRegion } from './artifacts';
import { BuildLogSummary, Diagnostic, shortPath } from './buildLog';
import { ElfInfo, ElfSymbol, PT_LOAD, hex, segmentFlags } from './elf';
import { MapFile, MapOutputSection, ObjectTotal } from './mapFile';
import { RankedSymbol, RegionUsage, UncoveredRange } from './usage';

export const DEFAULT_MAX_CHARS = 12_000;

function rel(p: string | undefined, root?: string): string {
    if (!p) { return '-'; }
    if (root) {
        const r = path.relative(root, p);
        if (r && !r.startsWith('..')) { return r; }
    }
    return p;
}

function tag(file: string): string {
    return `[${path.basename(file)}]`;
}

function when(mtimeMs?: number): string {
    if (!mtimeMs) { return ''; }
    const d = new Date(mtimeMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pct(n: number): string {
    return `${n < 10 ? n.toFixed(1) : n.toFixed(0)}%`;
}

export function describeContext(ctx: BuildContext, root?: string): string {
    const r = ctx.run;
    const parts = [`target ${r.targetType ?? '?'}`];
    if (r.device) { parts.push(`device ${r.device.vendor ? `${r.device.vendor}::` : ''}${r.device.name}`); }
    if (ctx.compiler) { parts.push(`compiler ${ctx.compiler}`); }
    if (r.board) { parts.push(`board ${r.board.name}`); }
    return `Build: ${parts.join(', ')} — from ${rel(r.file, root)}`;
}

function fileLine(label: string, fi: { path: string; exists: boolean; sizeBytes?: number; mtimeMs?: number } | undefined, root?: string): string {
    if (!fi) { return `  ${label}: -`; }
    if (!fi.exists) { return `  ${label}: ${rel(fi.path, root)} — missing`; }
    return `  ${label}: ${rel(fi.path, root)} · ${formatBytes(fi.sizeBytes)} · ${when(fi.mtimeMs)}`;
}

export interface ArtifactsRenderInput {
    ctx: BuildContext;
    /** Header facts per image, when the ELF was readable. */
    elfs: Map<string, ElfInfo | { error: string }>;
    log?: { file: string; sizeBytes: number; mtimeMs: number; ok?: boolean; errors: number; warnings: number };
    logNote?: string;
    root?: string;
}

export function renderArtifacts(input: ArtifactsRenderInput): string {
    const { ctx, root } = input;
    const lines: string[] = [describeContext(ctx, root)];
    for (const n of ctx.notes) { lines.push(`Note: ${n}`); }
    for (const im of ctx.images) {
        lines.push('');
        lines.push(`Image ${im.name}${im.pname ? ` (${im.pname})` : ''}${im.context ? ` — context ${im.context}` : ''}${im.compiler && im.compiler !== ctx.compiler ? `, compiler ${im.compiler}` : ''}`);
        lines.push(fileLine(im.elf.path.endsWith('.axf') ? 'axf' : 'elf', im.elf, root));
        const elf = input.elfs.get(im.elf.path);
        if (elf && !('error' in elf)) {
            const f = elf.footprint;
            lines.push(`    ${tag(elf.file)} ${elf.fileType} ${elf.machine}${elf.cpuName ? ` ${elf.cpuName}` : ''}, entry ${hex(elf.entry)}, text ${f.text} + data ${f.data} + bss ${f.bss} = ${f.text + f.data + f.bss} B` +
                `; ${elf.sections.length} sections, ${elf.symbolCount} symbols${elf.hasDwarf ? ', DWARF debug info' : ', no debug info'}`);
            if (elf.comments.length) { lines.push(`    ${tag(elf.file)} built with: ${elf.comments.slice(0, 2).join(' | ')}`); }
        } else if (elf) {
            lines.push(`    ${tag(im.elf.path)} ${elf.error}`);
        }
        lines.push(fileLine('map', im.map, root));
        if (im.hex) { lines.push(fileLine('hex', im.hex, root)); }
        if (im.bin) { lines.push(fileLine('bin', im.bin, root)); }
        if (im.cbuildYml) { lines.push(`  cbuild: ${rel(im.cbuildYml, root)}${im.linkerScript ? `, linker script ${rel(im.linkerScript, root)}` : ''}`); }
        for (const n of im.notes) { lines.push(`  Note: ${n}`); }
    }
    if (!ctx.images.length) { lines.push('No images listed — build the solution.'); }
    lines.push('');
    if (input.log) {
        const l = input.log;
        lines.push(`Newest build log: ${rel(l.file, root)} · ${formatBytes(l.sizeBytes)} · ${when(l.mtimeMs)} — ${l.ok === false ? 'FAILED' : l.ok ? 'ok' : 'status unknown'}, ${l.errors} error(s), ${l.warnings} warning(s)`);
    } else {
        lines.push(`Build log: none found${input.logNote ? ` (${input.logNote})` : ''}`);
    }
    const regions = ctx.memory;
    if (regions.length) {
        lines.push('');
        lines.push(`Memory regions ${tag(ctx.run.file)} (${regions.length}):`);
        const { shown, hidden } = truncateList(regions, 24);
        for (const r of shown) {
            lines.push(`  ${r.name.padEnd(14)} ${hex(r.start)} ${formatBytes(r.size).padStart(7)} ${r.access ?? ''}${r.alias ? ` alias of ${r.alias}` : ''}${r.default ? ' default' : ''}${r.pname ? ` (${r.pname})` : ''}`);
        }
        if (hidden) { lines.push(`  … ${hidden} more`); }
    } else {
        lines.push(`Memory regions: none in ${path.basename(ctx.run.file)} (older csolution?) — the map's regions are used`);
    }
    lines.push('');
    lines.push('Next: get_memory_usage for per-region usage and the largest symbols, get_section_layout for sections, lookup_symbol { name | address }, get_build_diagnostics for the log.');
    return lines.join('\n');
}

export function renderNoBuild(ctx: BuildContext, root?: string): string {
    const solution = ctx.run.solution ? path.basename(ctx.run.solution) : '<solution>.csolution.yml';
    return `${describeContext(ctx, root)}\nNo build output yet: ${ctx.images.map(i => rel(i.elf.path, root)).join(', ') || 'no image listed'} missing. ` +
        `Build the solution (cbuild ${solution} --packs --update-rte, or the CMSIS Solution view) and call again.`;
}

export interface UsageRenderInput {
    ctx: BuildContext;
    image: ImageArtifacts;
    elf: ElfInfo;
    map?: MapFile;
    regions: RegionUsage[];
    regionSource: 'cbuild-run' | 'map' | 'none';
    /** Occupied ranges no listed region covers. */
    uncovered?: UncoveredRange[];
    symbols: RankedSymbol[];
    objects: ObjectTotal[];
    libraries: ObjectTotal[];
    top: number;
    root?: string;
    maxChars?: number;
}

function totalsLine(map: MapFile): string {
    const t = map.totals;
    const parts: string[] = [];
    if (t.code !== undefined) { parts.push(`code ${t.code}`); }
    if (t.roData !== undefined) { parts.push(`ro-data ${t.roData}`); }
    if (t.rwData !== undefined) { parts.push(`rw-data ${t.rwData}`); }
    if (t.ziData !== undefined) { parts.push(`zi-data ${t.ziData}`); }
    const sums: string[] = [];
    if (t.ro !== undefined) { sums.push(`RO ${t.ro}`); }
    if (t.rw !== undefined) { sums.push(`RW ${t.rw}`); }
    if (t.rom !== undefined) { sums.push(`ROM ${t.rom}`); }
    return `${tag(map.file)} totals: ${parts.join(', ')}${sums.length ? ` → ${sums.join(', ')} B` : ''}`;
}

export function renderUsage(input: UsageRenderInput): string {
    const { ctx, image, elf, map, root } = input;
    const lines: string[] = [describeContext(ctx, root)];
    lines.push(`Image ${image.name}${image.pname ? ` (${image.pname})` : ''}: ${rel(elf.file, root)}${map ? `, map ${rel(map.file, root)} (${map.format})` : ', no map file'}`);
    const f = elf.footprint;
    lines.push(`${tag(elf.file)} size: text ${f.text} + data ${f.data} + bss ${f.bss} = ${f.text + f.data + f.bss} B (ROM ≈ ${f.text + f.data} B, RAM ≈ ${f.data + f.bss} B)`);
    const mapHasNumbers = !!map && (map.sections.length > 0 || map.totals.rom !== undefined);
    if (map && mapHasNumbers) { lines.push(totalsLine(map)); }
    for (const n of map?.notes ?? []) { lines.push(`Note: ${n}`); }

    lines.push('');
    if (input.regions.length) {
        lines.push(`Regions (${input.regionSource === 'cbuild-run' ? `device regions from ${path.basename(ctx.run.file)}, usage from ${path.basename(elf.file)} LOAD segments` : `regions and usage from ${path.basename(map?.file ?? elf.file)}`}):`);
        const used = input.regions.filter(r => r.used > 0);
        const unused = input.regions.filter(r => r.used === 0);
        for (const r of used) {
            lines.push(`  ${r.name.padEnd(14)} ${hex(r.start)} ${String(r.used).padStart(9)} / ${String(r.size).padStart(9)} B  ${pct(r.percent).padStart(5)}${r.sections.length ? `  ${r.sections.slice(0, 8).join(' ')}${r.sections.length > 8 ? ' …' : ''}` : ''}${r.alias ? `  (alias of ${r.alias})` : ''}`);
        }
        if (unused.length) { lines.push(`  unused: ${unused.map(r => r.name).join(', ')}`); }
        for (const u of input.uncovered ?? []) {
            lines.push(`  outside the listed regions: ${hex(u.start)} +${u.bytes} B${u.sections.length ? `  ${u.sections.slice(0, 8).join(' ')}${u.sections.length > 8 ? ' …' : ''}` : ''}`);
        }
    } else {
        lines.push('Regions: none known — no memory in the cbuild-run and no MEMORY/load regions in the map.');
        const segs = elf.segments.filter(s => s.type === PT_LOAD);
        for (const s of segs) { lines.push(`  ${tag(elf.file)} LOAD ${hex(s.vaddr)} memsz ${s.memsz} filesz ${s.filesz}${s.paddr !== s.vaddr ? ` load ${hex(s.paddr)}` : ''} ${segmentFlags(s.flags)}`); }
    }
    if (map && map.format === 'armlink') {
        const ers = map.regions.filter(r => r.kind === 'execution');
        if (ers.length) {
            lines.push(`  ${tag(map.file)} execution regions: ${ers.map(r => `${r.name} ${r.used}/${r.length} B`).join(', ')}`);
        }
    }

    lines.push('');
    lines.push(`Largest symbols ${tag(elf.file)} (top ${input.symbols.length}${map ? `, object from ${path.basename(map.file)}` : ''}):`);
    if (!input.symbols.length) { lines.push('  none with a size — the image has no symbol table (stripped?)'); }
    for (const s of input.symbols) {
        lines.push(`  ${String(s.symbol.size).padStart(8)} B  ${s.symbol.type === 'FUNC' ? 'func' : 'obj '}  ${hex(s.symbol.value)}  ${s.symbol.name}${s.section ? `  ${s.section}` : ''}${s.region ? ` @${s.region}` : ''}${s.object ? `  ← ${s.object}` : ''}`);
    }

    if (map && !input.objects.length) {
        lines.push('');
        lines.push(`${tag(map.file)} names no objects — link with a full map (armlink --map --info sizes, GNU -Map) for per-object sizes.`);
    } else if (map) {
        lines.push('');
        lines.push(`Largest objects ${tag(map.file)} (top ${Math.min(input.top, input.objects.length)} of ${input.objects.length}; code / ro-data / rw-data / zi-data):`);
        for (const o of input.objects.slice(0, input.top)) {
            lines.push(`  ${String(o.rom + o.ram - o.rwData).padStart(8)} B  ${o.object}  ${o.code} / ${o.roData} / ${o.rwData} / ${o.ziData}`);
        }
        if (input.libraries.length) {
            lines.push(`Libraries ${tag(map.file)}:`);
            for (const l of input.libraries.slice(0, Math.min(input.top, 8))) {
                lines.push(`  ${String(l.rom + l.ram - l.rwData).padStart(8)} B  ${l.object}  ${l.code} / ${l.roData} / ${l.rwData} / ${l.ziData}`);
            }
        }
        if (map.discarded.count) { lines.push(`${tag(map.file)} discarded ${map.discarded.count} unused input sections (${formatBytes(map.discarded.bytes)}).`); }
    } else {
        for (const n of image.notes) { lines.push(`Note: ${n}`); }
    }
    lines.push('');
    lines.push('Next: lookup_symbol { name } for one symbol\'s address/object, get_section_layout for per-section contributors, top: N for longer lists.');
    return clipValue(lines.join('\n'), input.maxChars ?? DEFAULT_MAX_CHARS);
}

export interface SymbolHit {
    symbol: ElfSymbol;
    object?: string;
    /** From the map: the input section name. */
    inputSection?: string;
    region?: string;
}

export interface LookupRenderInput {
    ctx: BuildContext;
    image: ImageArtifacts;
    elf: ElfInfo;
    map?: MapFile;
    query: string;
    /** Matches by name, in match-quality order. */
    hits: SymbolHit[];
    matchKind?: 'exact' | 'case-insensitive' | 'substring';
    /** For address lookups. */
    address?: { value: number; hit?: SymbolHit; offset?: number; exact?: boolean; section?: string; region?: MemoryRegion; outputSection?: MapOutputSection };
    /** Where the regions came from: the cbuild-run file or the map. */
    regionFile?: string;
    root?: string;
}

function symbolLine(h: SymbolHit, elfFile: string, mapFile?: string): string {
    const s = h.symbol;
    return `  ${tag(elfFile)} ${s.name}: ${hex(s.value)}, ${s.size} B, ${s.type.toLowerCase()} ${s.binding.toLowerCase()}${s.section ? `, section ${s.section}` : s.shndx === 0 ? ', undefined' : s.shndx === 0xfff1 ? ', absolute' : ''}` +
        `${h.region ? ` @${h.region}` : ''}${h.object ? `${mapFile ? ` ${tag(mapFile)}` : ''} defined in ${h.object}${h.inputSection ? ` (${h.inputSection})` : ''}` : ''}`;
}

export function renderLookup(input: LookupRenderInput): string {
    const { ctx, image, elf, map, root } = input;
    const lines: string[] = [describeContext(ctx, root)];
    lines.push(`Image ${image.name}: ${rel(elf.file, root)}${map ? `, map ${rel(map.file, root)}` : ''}`);
    if (input.address) {
        const a = input.address;
        lines.push(`Address ${hex(a.value)}:`);
        if (a.hit) {
            const s = a.hit.symbol;
            lines.push(`  ${tag(elf.file)} ${a.exact ? 'in' : 'after'} ${s.name} + ${a.offset} (${hex(s.value)}, ${s.size} B, ${s.type.toLowerCase()})${a.hit.object ? ` ${map ? tag(map.file) : ''} defined in ${a.hit.object}` : ''}`);
        } else {
            lines.push(`  ${tag(elf.file)} no symbol covers this address`);
        }
        if (a.section) { lines.push(`  ${tag(elf.file)} section ${a.section}`); }
        if (a.outputSection && map) { lines.push(`  ${tag(map.file)} output section ${a.outputSection.name} ${hex(a.outputSection.address)} +${a.outputSection.size} B`); }
        if (a.region) { lines.push(`  ${tag(input.regionFile ?? ctx.run.file)} region ${a.region.name} ${hex(a.region.start)} +${a.region.size} B${a.region.access ? ` ${a.region.access}` : ''}`); }
        else if (!a.section) { lines.push('  not inside any known memory region of the device'); }
    } else {
        if (!input.hits.length) {
            lines.push(`No symbol matches '${input.query}' in ${path.basename(elf.file)} (${elf.symbols.length} symbols${elf.symbols.length ? '' : ' — stripped image?'}).`);
        } else {
            lines.push(`Symbol '${input.query}' — ${input.matchKind} match${input.hits.length > 1 ? `es (${input.hits.length})` : ''}:`);
            for (const h of input.hits) { lines.push(symbolLine(h, elf.file, map?.file)); }
        }
    }
    lines.push('');
    lines.push('Next: lookup_symbol { address: "0x…" } for a fault PC, get_memory_usage for the largest symbols, read_memory (debugger) at the address.');
    return lines.join('\n');
}

export interface LayoutRenderInput {
    ctx: BuildContext;
    image: ImageArtifacts;
    elf: ElfInfo;
    map?: MapFile;
    regions: readonly MemoryRegion[];
    top: number;
    root?: string;
    maxChars?: number;
}

export function renderLayout(input: LayoutRenderInput): string {
    const { ctx, image, elf, map, root } = input;
    const lines: string[] = [describeContext(ctx, root)];
    lines.push(`Image ${image.name}: ${rel(elf.file, root)}${map ? `, map ${rel(map.file, root)} (${map.format})` : ', no map file'}`);
    lines.push('');
    lines.push(`Segments ${tag(elf.file)}:`);
    for (const s of elf.segments.filter(s => s.type === PT_LOAD)) {
        const region = input.regions.find(r => r.start <= s.vaddr && s.vaddr < r.start + r.size);
        lines.push(`  LOAD ${hex(s.vaddr)} memsz ${String(s.memsz).padStart(8)} filesz ${String(s.filesz).padStart(8)} ${segmentFlags(s.flags)}${s.paddr !== s.vaddr ? ` load from ${hex(s.paddr)}` : ''}${region ? ` @${region.name}` : ''}`);
    }
    lines.push('');
    const alloc = elf.sections.filter(s => (s.flags & 0x2) && s.size > 0).sort((a, b) => a.addr - b.addr);
    lines.push(`Sections ${tag(elf.file)} (allocated, ${alloc.length}):`);
    const { shown, hidden } = truncateList(alloc, 40);
    for (const s of shown) {
        const region = input.regions.find(r => r.start <= s.addr && s.addr < r.start + r.size);
        const kind = s.type === 8 ? 'bss' : (s.flags & 0x4) ? 'code' : (s.flags & 0x1) ? 'data' : 'rodata';
        lines.push(`  ${s.name.padEnd(22)} ${hex(s.addr)} ${String(s.size).padStart(9)} B  ${kind.padEnd(6)}${region ? ` @${region.name}` : ''}`);
    }
    if (hidden) { lines.push(`  … ${hidden} more`); }
    if (map && map.sections.length) {
        lines.push('');
        const sections = map.sections.filter(s => s.allocated && s.size > 0);
        lines.push(`Contributors ${tag(map.file)} (per ${map.format === 'armlink' ? 'execution region' : 'output section'}, top ${input.top} objects each):`);
        for (const s of sections) {
            const byObject = new Map<string, number>();
            for (const i of s.inputs) { if (!i.merged) { byObject.set(i.object, (byObject.get(i.object) ?? 0) + i.size); } }
            const ranked = [...byObject.entries()].sort((a, b) => b[1] - a[1]);
            lines.push(`  ${s.name} ${hex(s.address)} ${s.size} B${s.loadAddress !== undefined && s.loadAddress !== s.address ? ` (load ${hex(s.loadAddress)})` : ''}${s.region ? ` @${s.region}` : ''}${s.fill ? `, fill ${s.fill}` : ''} — ${s.inputs.length} input sections, ${byObject.size} objects`);
            for (const [obj, size] of ranked.slice(0, input.top)) { lines.push(`      ${String(size).padStart(8)} B  ${obj}`); }
            if (ranked.length > input.top) { lines.push(`      … ${ranked.length - input.top} more objects`); }
        }
        if (map.discarded.count) { lines.push(`${tag(map.file)} discarded ${map.discarded.count} unused input sections (${formatBytes(map.discarded.bytes)}).`); }
    } else {
        for (const n of image.notes) { lines.push(`Note: ${n}`); }
        for (const n of map?.notes ?? []) { lines.push(`Note: ${n}`); }
    }
    lines.push('');
    lines.push('Next: get_memory_usage for the region budget, lookup_symbol { name } for one symbol, top: N for more objects per section.');
    return clipValue(lines.join('\n'), input.maxChars ?? DEFAULT_MAX_CHARS);
}

export interface DiagnosticsRenderInput {
    summary: BuildLogSummary;
    limit: number;
    ctxLine?: string;
    candidates?: string[];
    root?: string;
    maxChars?: number;
}

function diagLine(d: Diagnostic, logFile: string): string {
    const where = d.file ? `${shortPath(d.file)}${d.line ? `:${d.line}` : ''}${d.col ? `:${d.col}` : ''}` : d.tool;
    return `  ${tag(logFile)}:${d.logLine} ${d.severity}${d.code ? ` ${d.code}` : ''} ${where}: ${d.message}${d.count > 1 ? ` (×${d.count})` : ''}`;
}

export function renderDiagnostics(input: DiagnosticsRenderInput): string {
    const s = input.summary;
    const lines: string[] = [];
    if (input.ctxLine) { lines.push(input.ctxLine); }
    lines.push(`Build log: ${rel(s.file, input.root)} · ${formatBytes(s.sizeBytes)} · ${when(s.mtimeMs)} · ${s.lines} lines`);
    if (s.contexts.length) { lines.push(`  contexts: ${s.contexts.join(', ')}`); }
    if (s.compilerLine) { lines.push(`  ${s.compilerLine}`); }
    lines.push(`Status: ${s.ok === false ? 'FAILED' : s.ok ? 'ok' : 'unknown'}${s.status ? ` — ${s.status}` : ''}; ${s.errors} error(s), ${s.warnings} warning(s), ${s.notes} note(s)`);
    if (s.failedSteps.length) {
        const { shown, hidden } = truncateList(s.failedSteps, 5);
        lines.push(`Failed steps: ${shown.join(', ')}${hidden ? ` … ${hidden} more` : ''}`);
    }
    const order = (d: Diagnostic) => d.severity === 'error' ? 0 : d.severity === 'warning' ? 1 : 2;
    const sorted = [...s.diagnostics].sort((a, b) => order(a) - order(b) || a.logLine - b.logLine);
    const { shown, hidden } = truncateList(sorted, input.limit);
    if (shown.length) {
        lines.push('');
        lines.push(`Diagnostics (first ${shown.length} of ${sorted.length}, errors first):`);
        for (const d of shown) { lines.push(diagLine(d, s.file)); }
        if (hidden) { lines.push(`  … ${hidden} more — pass limit: ${Math.min(sorted.length, 200)}`); }
    } else {
        lines.push('No diagnostics recognised in the log.');
    }
    if (input.candidates && input.candidates.length > 1) {
        lines.push('');
        lines.push(`Other logs (newest first): ${input.candidates.slice(1, 6).map(c => rel(c, input.root)).join(', ')} — pass file to read one.`);
    }
    lines.push('');
    lines.push('Next: open the file:line of the first error; after a fix, rebuild with `cbuild … --log <file>` and call again.');
    return clipValue(lines.join('\n'), input.maxChars ?? DEFAULT_MAX_CHARS);
}

export function renderNoLog(globs: readonly string[], ctxLine?: string): string {
    return `${ctxLine ? `${ctxLine}\n` : ''}No build log found (searched ${globs.join(', ')}). The CMSIS Solution extension runs cbuild in a terminal and keeps no log file. ` +
        'Capture one with `cbuild <solution>.csolution.yml --packs --update-rte --log out/build.log` (or `… 2>&1 | tee out/build.log`), ' +
        'then call again, or pass file: <path> for a log saved elsewhere.';
}
