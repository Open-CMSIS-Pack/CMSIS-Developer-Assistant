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
 * Memory usage per region: the ELF's PT_LOAD segments (run-time ranges plus
 * the load ranges of initialised data) intersected with the device's
 * regions from cbuild-run — or, without those, the map's regions. Also the
 * largest symbols and the heaviest objects.
 */

import { MemoryRegion } from './artifacts';
import { ElfInfo, ElfSymbol, PT_LOAD, SHF_ALLOC, loadRanges } from './elf';
import { MapFile, MapRegion, inputSectionAt } from './mapFile';

export interface RegionUsage {
    name: string;
    start: number;
    size: number;
    used: number;
    percent: number;
    access?: string;
    /** Sections (ELF, allocated) that fall in the region. */
    sections: string[];
    /** `elf` (segments) or `map` (armlink region Size). */
    source: 'elf' | 'map';
    alias?: string;
}

interface Range { start: number; end: number }

function mergeRanges(ranges: Range[]): Range[] {
    const sorted = ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
    const out: Range[] = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r.start <= last.end) { last.end = Math.max(last.end, r.end); } else { out.push({ ...r }); }
    }
    return out;
}

function overlap(ranges: readonly Range[], start: number, end: number): number {
    let n = 0;
    for (const r of ranges) {
        const s = Math.max(r.start, start), e = Math.min(r.end, end);
        if (e > s) { n += e - s; }
    }
    return n;
}

/** Regions to measure against: device regions from cbuild-run, else the map's memory/load regions. */
export function usageRegions(memory: readonly MemoryRegion[], map?: MapFile): { regions: MemoryRegion[]; source: 'cbuild-run' | 'map' | 'none' } {
    if (memory.length) { return { regions: [...memory], source: 'cbuild-run' }; }
    if (map) {
        const fromMap = map.regions.filter(r => r.kind === 'memory' || r.kind === 'load');
        if (fromMap.length) {
            return { regions: fromMap.map((r: MapRegion) => ({ name: r.name, start: r.origin, size: r.length, access: r.attributes })), source: 'map' };
        }
    }
    return { regions: [], source: 'none' };
}

/**
 * Address ranges the image occupies. Run-time ranges come from the allocated
 * sections (armlink's single PT_LOAD carries memsz = ROM + ZI at the flash
 * address, so segment memsz cannot be used); the bytes stored in the image
 * come from the segments' file ranges (GNU: the .data initialisers at their
 * load address; armlink: the whole load region including RW initialisers).
 */
export function occupiedRanges(elf: ElfInfo): Range[] {
    const allocated = elf.sections.filter(s => (s.flags & SHF_ALLOC) && s.size > 0);
    const ranges: Range[] = allocated.map(s => ({ start: s.addr, end: s.addr + s.size }));
    for (const seg of elf.segments) {
        if (seg.type !== PT_LOAD || seg.filesz === 0) { continue; }
        ranges.push({ start: seg.paddr, end: seg.paddr + seg.filesz });
    }
    if (!allocated.length) {
        // Section headers stripped: fall back to the segments' run-time ranges.
        ranges.push(...loadRanges(elf.segments).filter(r => r.kind === 'run').map(r => ({ start: r.start, end: r.end })));
    }
    return mergeRanges(ranges);
}

export function computeRegionUsage(elf: ElfInfo, regions: readonly MemoryRegion[]): RegionUsage[] {
    const ranges = occupiedRanges(elf);
    const allocated = elf.sections.filter(s => (s.flags & SHF_ALLOC) && s.size > 0);
    return regions.map(r => {
        const end = r.start + r.size;
        const used = overlap(ranges, r.start, end);
        const sections = allocated.filter(s => s.addr >= r.start && s.addr < end).map(s => s.name);
        return { name: r.name, start: r.start, size: r.size, used, percent: r.size ? (used / r.size) * 100 : 0, access: r.access, sections, source: 'elf', alias: r.alias };
    });
}

export interface UncoveredRange {
    start: number;
    end: number;
    bytes: number;
    /** Allocated sections starting inside the range. */
    sections: string[];
}

/** Occupied address ranges that no listed region covers (DDR, external memory the pack does not describe). */
export function uncoveredRanges(elf: ElfInfo, regions: readonly MemoryRegion[]): UncoveredRange[] {
    const out: UncoveredRange[] = [];
    const allocated = elf.sections.filter(s => (s.flags & SHF_ALLOC) && s.size > 0);
    for (const r of occupiedRanges(elf)) {
        // Subtract every region from the range; what is left is uncovered.
        let pieces: Range[] = [{ ...r }];
        for (const m of regions) {
            const next: Range[] = [];
            for (const p of pieces) {
                const s = Math.max(p.start, m.start), e = Math.min(p.end, m.start + m.size);
                if (e <= s) { next.push(p); continue; }
                if (p.start < s) { next.push({ start: p.start, end: s }); }
                if (e < p.end) { next.push({ start: e, end: p.end }); }
            }
            pieces = next;
        }
        for (const p of pieces) {
            out.push({ start: p.start, end: p.end, bytes: p.end - p.start, sections: allocated.filter(s => s.addr >= p.start && s.addr < p.end).map(s => s.name) });
        }
    }
    return out;
}

/** Per-region usage from an armlink map (execution regions carry Size and Max), for a cross-check line. */
export function mapRegionUsage(map: MapFile): RegionUsage[] {
    return map.regions.filter(r => r.kind === 'load' && r.used !== undefined).map(r => ({
        name: r.name, start: r.origin, size: r.length, used: r.used!, percent: r.length ? (r.used! / r.length) * 100 : 0,
        sections: map.sections.filter(s => s.region === r.name).map(s => s.name), source: 'map' as const,
    }));
}

export interface RankedSymbol {
    symbol: ElfSymbol;
    /** Defining object from the map (input section containing the address). */
    object?: string;
    /** Output section from the map or ELF. */
    section?: string;
    region?: string;
}

export function topSymbols(elf: ElfInfo, count: number, options: { map?: MapFile; regions?: readonly MemoryRegion[]; kind?: 'FUNC' | 'OBJECT' } = {}): RankedSymbol[] {
    const sized = elf.symbols.filter(s => s.size > 0 && (s.type === 'FUNC' || s.type === 'OBJECT') && (!options.kind || s.type === options.kind) && s.shndx !== 0);
    // Aliases (same address and size, e.g. weak + strong) count once.
    const seen = new Set<string>();
    const distinct = sized.filter(s => { const k = `${s.value}:${s.size}`; if (seen.has(k)) { return false; } seen.add(k); return true; });
    distinct.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
    return distinct.slice(0, count).map(symbol => ({
        symbol,
        object: options.map ? inputSectionAt(options.map, symbol.value)?.input.object : undefined,
        section: symbol.section,
        region: options.regions?.find(r => r.start <= symbol.value && symbol.value < r.start + r.size)?.name,
    }));
}

export function findRegion(regions: readonly MemoryRegion[], address: number): MemoryRegion | undefined {
    return regions.find(r => r.start <= address && address < r.start + r.size);
}
