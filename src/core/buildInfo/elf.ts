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
 * Little-endian ELF32 reader for Arm images — `.elf` from GCC/Clang and
 * `.axf` from armlink are the same format. Reads the header, section and
 * program header tables, the symbol table, `.comment`/`.note*` text and the
 * `Tag_CPU_name` build attribute. Structures are read with positioned
 * `readSync` calls so a 90 MB debug image is never loaded whole; only the
 * symbol and string tables come in as one buffer each. No ELF64.
 */

import * as fs from 'fs';
import * as path from 'path';

export const SHT_PROGBITS = 1;
export const SHT_SYMTAB = 2;
export const SHT_STRTAB = 3;
export const SHT_NOBITS = 8;
export const SHT_ARM_ATTRIBUTES = 0x70000003;
export const SHF_WRITE = 0x1;
export const SHF_ALLOC = 0x2;
export const SHF_EXECINSTR = 0x4;
export const PT_LOAD = 1;
export const PF_X = 0x1;
export const PF_W = 0x2;
export const PF_R = 0x4;
const EM_ARM = 40;

export interface ElfSection {
    index: number;
    name: string;
    type: number;
    flags: number;
    addr: number;
    offset: number;
    size: number;
    link: number;
    info: number;
    entsize: number;
}

export interface ElfSegment {
    type: number;
    offset: number;
    vaddr: number;
    paddr: number;
    filesz: number;
    memsz: number;
    flags: number;
    align: number;
}

export type ElfSymbolType = 'NOTYPE' | 'OBJECT' | 'FUNC' | 'SECTION' | 'FILE' | 'COMMON' | 'TLS' | 'OTHER';
export type ElfSymbolBinding = 'LOCAL' | 'GLOBAL' | 'WEAK' | 'OTHER';

export interface ElfSymbol {
    name: string;
    /** Thumb bit cleared for functions. */
    value: number;
    size: number;
    type: ElfSymbolType;
    binding: ElfSymbolBinding;
    shndx: number;
    /** Name of the containing section (undefined for ABS/UNDEF/COMMON). */
    section?: string;
}

/** What `size` prints: text = code + read-only data, data = initialised, bss = zero-initialised. */
export interface ElfFootprint {
    text: number;
    data: number;
    bss: number;
}

export interface ElfInfo {
    file: string;
    sizeBytes: number;
    /** `EXEC`, `REL`, `DYN` or the numeric type. */
    fileType: string;
    machine: string;
    entry: number;
    sections: ElfSection[];
    segments: ElfSegment[];
    symbols: ElfSymbol[];
    /** Distinct strings from `.comment` (compiler identification). */
    comments: string[];
    /** `.note*` section names present. */
    notes: string[];
    /** `Tag_CPU_name` from `.ARM.attributes`, e.g. `Cortex-M7`. */
    cpuName?: string;
    hasDwarf: boolean;
    footprint: ElfFootprint;
    /** Section-header symbol table size, for the trace. */
    symbolCount: number;
}

export class ElfError extends Error { }

const SECTION_HEADER_SIZE = 40;
const PROGRAM_HEADER_SIZE = 32;
const SYMBOL_SIZE = 16;
/** The symbol table of a debug image is a few MB; anything above this is truncated. */
const MAX_TABLE_BYTES = 64 * 1024 * 1024;

function readAt(fd: number, offset: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
        const n = fs.readSync(fd, buf, done, length - done, offset + done);
        if (n <= 0) { break; }
        done += n;
    }
    return done === length ? buf : buf.subarray(0, done);
}

function cString(buf: Buffer, offset: number): string {
    if (offset < 0 || offset >= buf.length) { return ''; }
    let end = buf.indexOf(0, offset);
    if (end < 0) { end = buf.length; }
    return buf.toString('utf-8', offset, end);
}

function symbolType(info: number): ElfSymbolType {
    switch (info & 0xf) {
        case 0: return 'NOTYPE';
        case 1: return 'OBJECT';
        case 2: return 'FUNC';
        case 3: return 'SECTION';
        case 4: return 'FILE';
        case 5: return 'COMMON';
        case 6: return 'TLS';
        default: return 'OTHER';
    }
}

function symbolBinding(info: number): ElfSymbolBinding {
    switch (info >> 4) {
        case 0: return 'LOCAL';
        case 1: return 'GLOBAL';
        case 2: return 'WEAK';
        default: return 'OTHER';
    }
}

/** `$a`, `$t`, `$d`, `$t.3`, `$d.realdata` — the Arm mapping symbols. */
export function isMappingSymbol(name: string): boolean {
    return /^\$[atdxv](?:\..*)?$/.test(name);
}

function fileTypeName(t: number): string {
    switch (t) {
        case 1: return 'REL';
        case 2: return 'EXEC';
        case 3: return 'DYN';
        case 4: return 'CORE';
        default: return `type ${t}`;
    }
}

/** Distinct printable strings of a NUL-separated buffer. */
function nulStrings(buf: Buffer): string[] {
    const out: string[] = [];
    for (const s of buf.toString('utf-8').split('\0')) {
        const t = s.trim();
        if (t && !out.includes(t)) { out.push(t); }
    }
    return out;
}

/** `Tag_CPU_name` (tag 5) from the `aeabi` subsection of `.ARM.attributes`. */
export function parseCpuName(buf: Buffer): string | undefined {
    try {
        if (buf.length < 5 || buf[0] !== 0x41) { return undefined; }
        let pos = 1;
        while (pos + 4 <= buf.length) {
            const subLen = buf.readUInt32LE(pos);
            const vendor = cString(buf, pos + 4);
            const subEnd = pos + subLen;
            if (vendor === 'aeabi') {
                let p = pos + 4 + vendor.length + 1;
                // Sub-subsections: tag byte, u32 size, then attributes.
                while (p + 5 <= subEnd) {
                    const tag = buf[p];
                    const size = buf.readUInt32LE(p + 1);
                    let q = p + 5;
                    const end = Math.min(p + size, subEnd);
                    if (tag !== 1) { p = end; continue; } // Tag_File only
                    while (q < end) {
                        // uleb128 attribute tag
                        let t = 0, shift = 0, b: number;
                        do { b = buf[q++]; t |= (b & 0x7f) << shift; shift += 7; } while ((b & 0x80) && q < end);
                        if (t === 4 || t === 5 || t === 67) {
                            const s = cString(buf, q);
                            q += s.length + 1;
                            if (t === 5) { return s; }
                        } else if (t === 32) {
                            // Tag_compatibility: uleb + NTBS
                            do { b = buf[q++]; } while ((b & 0x80) && q < end);
                            q += cString(buf, q).length + 1;
                        } else if (t === 65) {
                            // Tag_also_compatible_with: a NTBS-encoded tag/value pair
                            q += cString(buf, q).length + 1;
                        } else {
                            do { b = buf[q++]; } while ((b & 0x80) && q < end);
                        }
                    }
                    p = end;
                }
                return undefined;
            }
            if (subLen === 0) { break; }
            pos = subEnd;
        }
    } catch {
        // malformed attributes are not worth failing the whole read
    }
    return undefined;
}

export interface ReadElfOptions {
    /** Skip the symbol table (fast path for list_build_artifacts). */
    skipSymbols?: boolean;
}

export function readElf(file: string, options: ReadElfOptions = {}): ElfInfo {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
        const eh = readAt(fd, 0, 52);
        if (eh.length < 52 || eh.readUInt32BE(0) !== 0x7f454c46) {
            throw new ElfError(`${path.basename(file)} is not an ELF file`);
        }
        if (eh[4] !== 1) { throw new ElfError(`${path.basename(file)} is ELF64; only ELF32 (Arm Cortex-M/R/A32) is supported`); }
        if (eh[5] !== 1) { throw new ElfError(`${path.basename(file)} is big-endian; only little-endian ELF32 is supported`); }
        const machine = eh.readUInt16LE(18);
        const entry = eh.readUInt32LE(24);
        const phoff = eh.readUInt32LE(28);
        const shoff = eh.readUInt32LE(32);
        const phentsize = eh.readUInt16LE(42);
        const phnum = eh.readUInt16LE(44);
        const shentsize = eh.readUInt16LE(46);
        const shnum = eh.readUInt16LE(48);
        const shstrndx = eh.readUInt16LE(50);

        // Section headers, one buffer.
        const sections: ElfSection[] = [];
        if (shoff && shnum) {
            const entSize = shentsize || SECTION_HEADER_SIZE;
            const table = readAt(fd, shoff, entSize * shnum);
            for (let i = 0; i < shnum; i++) {
                const o = i * entSize;
                if (o + SECTION_HEADER_SIZE > table.length) { break; }
                sections.push({
                    index: i,
                    name: '',
                    type: table.readUInt32LE(o + 4),
                    flags: table.readUInt32LE(o + 8),
                    addr: table.readUInt32LE(o + 12),
                    offset: table.readUInt32LE(o + 16),
                    size: table.readUInt32LE(o + 20),
                    link: table.readUInt32LE(o + 24),
                    info: table.readUInt32LE(o + 28),
                    entsize: table.readUInt32LE(o + 36),
                });
            }
            const nameOffsets = Array.from({ length: sections.length }, (_, i) => table.readUInt32LE(i * entSize));
            const shstr = sections[shstrndx];
            if (shstr && shstr.size < MAX_TABLE_BYTES) {
                const names = readAt(fd, shstr.offset, shstr.size);
                sections.forEach((s, i) => { s.name = cString(names, nameOffsets[i]); });
            }
        }

        // Program headers.
        const segments: ElfSegment[] = [];
        if (phoff && phnum) {
            const entSize = phentsize || PROGRAM_HEADER_SIZE;
            const table = readAt(fd, phoff, entSize * phnum);
            for (let i = 0; i < phnum; i++) {
                const o = i * entSize;
                if (o + PROGRAM_HEADER_SIZE > table.length) { break; }
                segments.push({
                    type: table.readUInt32LE(o),
                    offset: table.readUInt32LE(o + 4),
                    vaddr: table.readUInt32LE(o + 8),
                    paddr: table.readUInt32LE(o + 12),
                    filesz: table.readUInt32LE(o + 16),
                    memsz: table.readUInt32LE(o + 20),
                    flags: table.readUInt32LE(o + 24),
                    align: table.readUInt32LE(o + 28),
                });
            }
        }

        // Symbols.
        const symbols: ElfSymbol[] = [];
        let symbolCount = 0;
        const symtab = sections.find(s => s.type === SHT_SYMTAB);
        if (symtab) { symbolCount = Math.floor(symtab.size / (symtab.entsize || SYMBOL_SIZE)); }
        if (symtab && !options.skipSymbols && symtab.size > 0 && symtab.size < MAX_TABLE_BYTES) {
            const strtab = sections[symtab.link];
            const strings = strtab && strtab.size < MAX_TABLE_BYTES ? readAt(fd, strtab.offset, strtab.size) : Buffer.alloc(0);
            const table = readAt(fd, symtab.offset, symtab.size);
            const entSize = symtab.entsize || SYMBOL_SIZE;
            symbolCount = Math.floor(table.length / entSize);
            for (let i = 1; i < symbolCount; i++) {
                const o = i * entSize;
                const name = cString(strings, table.readUInt32LE(o));
                const info = table[o + 12];
                const type = symbolType(info);
                if (type === 'FILE' || type === 'SECTION') { continue; }
                if (!name || isMappingSymbol(name)) { continue; }
                const shndx = table.readUInt16LE(o + 14);
                let value = table.readUInt32LE(o + 4);
                if (type === 'FUNC') { value &= ~1; }
                symbols.push({
                    name, value, size: table.readUInt32LE(o + 8), type, binding: symbolBinding(info), shndx,
                    section: shndx > 0 && shndx < sections.length ? sections[shndx].name : undefined,
                });
            }
        }

        // Toolchain identification.
        const comments: string[] = [];
        const comment = sections.find(s => s.name === '.comment' && s.type === SHT_PROGBITS);
        if (comment && comment.size > 0 && comment.size < 1024 * 1024) {
            comments.push(...nulStrings(readAt(fd, comment.offset, comment.size)));
        }
        const notes = sections.filter(s => s.name.startsWith('.note')).map(s => s.name);
        let cpuName: string | undefined;
        const attrs = sections.find(s => s.type === SHT_ARM_ATTRIBUTES || s.name === '.ARM.attributes');
        if (attrs && attrs.size > 0 && attrs.size < 1024 * 1024) {
            cpuName = parseCpuName(readAt(fd, attrs.offset, attrs.size));
        }

        return {
            file,
            sizeBytes: stat.size,
            fileType: fileTypeName(eh.readUInt16LE(16)),
            machine: machine === EM_ARM ? 'ARM' : `machine ${machine}`,
            entry,
            sections,
            segments,
            symbols,
            comments,
            notes,
            cpuName,
            hasDwarf: sections.some(s => s.name.startsWith('.debug_')),
            footprint: footprintFromSections(sections),
            symbolCount,
        };
    } finally {
        fs.closeSync(fd);
    }
}

/** The `size` classification over SHF_ALLOC sections. */
export function footprintFromSections(sections: readonly ElfSection[]): ElfFootprint {
    const f: ElfFootprint = { text: 0, data: 0, bss: 0 };
    for (const s of sections) {
        if (!(s.flags & SHF_ALLOC) || s.size === 0) { continue; }
        if (s.type === SHT_NOBITS) { f.bss += s.size; }
        else if (s.flags & SHF_WRITE) { f.data += s.size; }
        else { f.text += s.size; }
    }
    return f;
}

/** Address ranges the image occupies: run-time ranges of every PT_LOAD plus the load ranges that differ (initialisers in flash). */
export function loadRanges(segments: readonly ElfSegment[]): { start: number; end: number; kind: 'run' | 'load'; flags: number }[] {
    const out: { start: number; end: number; kind: 'run' | 'load'; flags: number }[] = [];
    for (const s of segments) {
        if (s.type !== PT_LOAD) { continue; }
        if (s.memsz > 0) { out.push({ start: s.vaddr, end: s.vaddr + s.memsz, kind: 'run', flags: s.flags }); }
        if (s.paddr !== s.vaddr && s.filesz > 0) { out.push({ start: s.paddr, end: s.paddr + s.filesz, kind: 'load', flags: s.flags }); }
    }
    return out;
}

export function segmentFlags(flags: number): string {
    return `${flags & PF_R ? 'R' : '-'}${flags & PF_W ? 'W' : '-'}${flags & PF_X ? 'X' : '-'}`;
}

export function sectionFlags(flags: number): string {
    return `${flags & SHF_ALLOC ? 'A' : ''}${flags & SHF_WRITE ? 'W' : ''}${flags & SHF_EXECINSTR ? 'X' : ''}` || '-';
}

/**
 * The symbol that contains `address`, preferring sized FUNC/OBJECT symbols;
 * else the nearest preceding one within `maxGap` bytes (a fault PC in a
 * function without size information), marked `exact: false`.
 */
export function symbolAt(symbols: readonly ElfSymbol[], address: number, maxGap = 0x1000): { symbol: ElfSymbol; offset: number; exact: boolean } | undefined {
    let best: ElfSymbol | undefined;
    let nearest: ElfSymbol | undefined;
    for (const s of symbols) {
        if (s.shndx === 0) { continue; }
        if (s.value <= address && address < s.value + s.size) {
            if (!best || s.size < best.size || (s.size === best.size && s.binding === 'GLOBAL')) { best = s; }
        } else if (s.value <= address && address - s.value <= maxGap && (s.type === 'FUNC' || s.type === 'OBJECT') && (!nearest || s.value > nearest.value)) {
            nearest = s;
        }
    }
    if (best) { return { symbol: best, offset: address - best.value, exact: true }; }
    if (nearest) { return { symbol: nearest, offset: address - nearest.value, exact: false }; }
    return undefined;
}

export function sectionAt(sections: readonly ElfSection[], address: number): ElfSection | undefined {
    return sections.find(s => (s.flags & SHF_ALLOC) && s.size > 0 && s.addr <= address && address < s.addr + s.size);
}

export function hex(n: number, width = 8): string {
    return `0x${n.toString(16).padStart(width, '0')}`;
}
