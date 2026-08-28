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
 * ELF32 reader: a synthetic image assembled here byte by byte, plus the two
 * real fixtures under fixtures/buildinfo — `blink-gcc.elf` (Arm GNU
 * Toolchain 13.3.1, `-mcpu=cortex-m7 -Os -g`, three objects and a static
 * archive, custom linker script) and `blink-ac6.axf` (Arm Compiler for
 * Embedded 6.24, same sources, scatter file). Both were linked from the
 * sources listed in docs/buildinfo-integration.md; the expected numbers
 * below were cross-checked with `arm-none-eabi-readelf` and `size`.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PT_LOAD, SHF_ALLOC, SHF_EXECINSTR, SHF_WRITE, SHT_NOBITS, SHT_PROGBITS, SHT_STRTAB, SHT_SYMTAB, hex, isMappingSymbol, readElf, sectionAt, symbolAt } from '../core/buildInfo/elf';
import { computeRegionUsage, occupiedRanges, topSymbols, uncoveredRanges } from '../core/buildInfo/usage';

export const BUILDINFO_FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'buildinfo');

interface SynthSection { name: string; type: number; flags: number; addr: number; data: Buffer; size?: number; link?: number; info?: number; entsize?: number }
interface SynthSymbol { name: string; value: number; size: number; type: number; bind: number; shndx: number }
interface SynthSegment { vaddr: number; paddr: number; filesz: number; memsz: number; flags: number }

/** A little-endian ELF32 EXEC for EM_ARM with the given sections, symbols and PT_LOAD segments. */
export function buildElf32(opts: { sections: SynthSection[]; symbols: SynthSymbol[]; segments: SynthSegment[]; entry?: number; elfClass?: number; endian?: number }): Buffer {
    const strtab: Buffer[] = [Buffer.from([0])];
    let strLen = 1;
    const addStr = (s: string) => { const off = strLen; const b = Buffer.from(`${s}\0`); strtab.push(b); strLen += b.length; return off; };
    const symOffsets = opts.symbols.map(s => addStr(s.name));
    const symtab = Buffer.alloc(16 * (opts.symbols.length + 1));
    opts.symbols.forEach((s, i) => {
        const o = 16 * (i + 1);
        symtab.writeUInt32LE(symOffsets[i], o); symtab.writeUInt32LE(s.value, o + 4); symtab.writeUInt32LE(s.size, o + 8);
        symtab[o + 12] = (s.bind << 4) | s.type; symtab[o + 13] = 0; symtab.writeUInt16LE(s.shndx, o + 14);
    });
    const all: SynthSection[] = [
        { name: '', type: 0, flags: 0, addr: 0, data: Buffer.alloc(0) },
        ...opts.sections,
    ];
    const symtabIndex = all.length;
    all.push({ name: '.symtab', type: SHT_SYMTAB, flags: 0, addr: 0, data: symtab, link: symtabIndex + 1, info: 1, entsize: 16 });
    all.push({ name: '.strtab', type: SHT_STRTAB, flags: 0, addr: 0, data: Buffer.concat(strtab) });
    const shstr: Buffer[] = [Buffer.from([0])];
    let shLen = 1;
    const nameOff = all.map(s => { if (!s.name) { return 0; } const off = shLen; const b = Buffer.from(`${s.name}\0`); shstr.push(b); shLen += b.length; return off; });
    const shstrtabIndex = all.length;
    nameOff.push(shLen); shstr.push(Buffer.from('.shstrtab\0')); shLen += 10;
    all.push({ name: '.shstrtab', type: SHT_STRTAB, flags: 0, addr: 0, data: Buffer.concat(shstr) });

    const ehSize = 52, phSize = 32, shSize = 40;
    let offset = ehSize + phSize * opts.segments.length;
    const offsets = all.map(s => { const o = offset; if (s.type !== SHT_NOBITS) { offset += s.data.length; } return o; });
    const shoff = (offset + 3) & ~3;
    const total = shoff + shSize * all.length;
    const buf = Buffer.alloc(total);
    buf.write('\x7fELF', 0, 'latin1');
    buf[4] = opts.elfClass ?? 1; buf[5] = opts.endian ?? 1; buf[6] = 1;
    buf.writeUInt16LE(2, 16); buf.writeUInt16LE(40, 18); buf.writeUInt32LE(1, 20); buf.writeUInt32LE(opts.entry ?? 0, 24);
    buf.writeUInt32LE(opts.segments.length ? ehSize : 0, 28); buf.writeUInt32LE(shoff, 32); buf.writeUInt32LE(0x05000000, 36);
    buf.writeUInt16LE(ehSize, 40); buf.writeUInt16LE(phSize, 42); buf.writeUInt16LE(opts.segments.length, 44);
    buf.writeUInt16LE(shSize, 46); buf.writeUInt16LE(all.length, 48); buf.writeUInt16LE(shstrtabIndex, 50);
    opts.segments.forEach((s, i) => {
        const o = ehSize + i * phSize;
        buf.writeUInt32LE(PT_LOAD, o); buf.writeUInt32LE(0, o + 4); buf.writeUInt32LE(s.vaddr, o + 8); buf.writeUInt32LE(s.paddr, o + 12);
        buf.writeUInt32LE(s.filesz, o + 16); buf.writeUInt32LE(s.memsz, o + 20); buf.writeUInt32LE(s.flags, o + 24); buf.writeUInt32LE(4, o + 28);
    });
    all.forEach((s, i) => {
        if (s.type !== SHT_NOBITS) { s.data.copy(buf, offsets[i]); }
        const o = shoff + i * shSize;
        buf.writeUInt32LE(nameOff[i], o); buf.writeUInt32LE(s.type, o + 4); buf.writeUInt32LE(s.flags, o + 8); buf.writeUInt32LE(s.addr, o + 12);
        buf.writeUInt32LE(offsets[i], o + 16); buf.writeUInt32LE(s.size ?? s.data.length, o + 20); buf.writeUInt32LE(s.link ?? 0, o + 24);
        buf.writeUInt32LE(s.info ?? 0, o + 28); buf.writeUInt32LE(4, o + 32); buf.writeUInt32LE(s.entsize ?? 0, o + 36);
    });
    return buf;
}

const STT_OBJECT = 1, STT_FUNC = 2, STT_FILE = 4, STB_LOCAL = 0, STB_GLOBAL = 1, STB_WEAK = 2;

/** The synthetic image used by several suites: .text/.rodata in flash, .data/.bss in RAM, one debug section. */
export function synthElf(): Buffer {
    return buildElf32({
        entry: 0x08000001,
        sections: [
            { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, data: Buffer.alloc(0x100, 0xbf) },
            { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 0x08000100, data: Buffer.alloc(0x40, 1) },
            { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000000, data: Buffer.alloc(0x10, 2) },
            { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000010, data: Buffer.alloc(0), size: 0x200 },
            { name: '.debug_info', type: SHT_PROGBITS, flags: 0, addr: 0, data: Buffer.alloc(8) },
            { name: '.comment', type: SHT_PROGBITS, flags: 0x30, addr: 0, data: Buffer.from('\0clang version 18.1.3\0GCC: (GNU) 13.3.1\0clang version 18.1.3\0') },
        ],
        symbols: [
            { name: 'main.c', value: 0, size: 0, type: STT_FILE, bind: STB_LOCAL, shndx: 0xfff1 },
            { name: '$t', value: 0x08000000, size: 0, type: 0, bind: STB_LOCAL, shndx: 1 },
            { name: 'main', value: 0x08000001, size: 0x40, type: STT_FUNC, bind: STB_GLOBAL, shndx: 1 },
            { name: 'HAL_Init', value: 0x08000041, size: 0x80, type: STT_FUNC, bind: STB_GLOBAL, shndx: 1 },
            { name: 'SysTick_Handler', value: 0x080000c1, size: 0x10, type: STT_FUNC, bind: STB_WEAK, shndx: 1 },
            { name: 'lut', value: 0x08000100, size: 0x40, type: STT_OBJECT, bind: STB_GLOBAL, shndx: 2 },
            { name: 'counter', value: 0x20000000, size: 4, type: STT_OBJECT, bind: STB_GLOBAL, shndx: 3 },
            { name: 'rx_buf', value: 0x20000010, size: 0x200, type: STT_OBJECT, bind: STB_LOCAL, shndx: 4 },
            { name: '__stack_top', value: 0x20010000, size: 0, type: 0, bind: STB_GLOBAL, shndx: 0xfff1 },
            { name: 'printf', value: 0, size: 0, type: STT_FUNC, bind: STB_GLOBAL, shndx: 0 },
        ],
        segments: [
            { vaddr: 0x08000000, paddr: 0x08000000, filesz: 0x140, memsz: 0x140, flags: 5 },
            { vaddr: 0x20000000, paddr: 0x08000140, filesz: 0x10, memsz: 0x210, flags: 6 },
        ],
    });
}

suite('buildInfo/elf', () => {
    let dir: string;
    suiteSetup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildinfo-elf-')); });

    test('reads a synthetic ELF32: header, sections, segments, symbols, comment', () => {
        const file = path.join(dir, 'synth.elf');
        fs.writeFileSync(file, synthElf());
        const e = readElf(file);
        assert.strictEqual(e.fileType, 'EXEC');
        assert.strictEqual(e.machine, 'ARM');
        assert.strictEqual(e.entry, 0x08000001);
        assert.deepStrictEqual(e.sections.map(s => s.name), ['', '.text', '.rodata', '.data', '.bss', '.debug_info', '.comment', '.symtab', '.strtab', '.shstrtab']);
        assert.strictEqual(e.sections[4].type, SHT_NOBITS);
        assert.strictEqual(e.sections[4].size, 0x200);
        assert.strictEqual(e.segments.length, 2);
        assert.strictEqual(e.segments[1].paddr, 0x08000140);
        assert.deepStrictEqual(e.footprint, { text: 0x140, data: 0x10, bss: 0x200 });
        assert.ok(e.hasDwarf);
        assert.deepStrictEqual(e.comments, ['clang version 18.1.3', 'GCC: (GNU) 13.3.1']);
        // FILE symbols and mapping symbols are dropped; the Thumb bit is cleared on functions; undefined and absolute symbols stay.
        assert.deepStrictEqual(e.symbols.map(s => s.name), ['main', 'HAL_Init', 'SysTick_Handler', 'lut', 'counter', 'rx_buf', '__stack_top', 'printf']);
        const main = e.symbols.find(s => s.name === 'main')!;
        assert.strictEqual(main.value, 0x08000000);
        assert.strictEqual(main.size, 0x40);
        assert.strictEqual(main.type, 'FUNC');
        assert.strictEqual(main.binding, 'GLOBAL');
        assert.strictEqual(main.section, '.text');
        assert.strictEqual(e.symbols.find(s => s.name === 'SysTick_Handler')!.binding, 'WEAK');
        assert.strictEqual(e.symbols.find(s => s.name === 'printf')!.shndx, 0);
        assert.strictEqual(e.symbols.find(s => s.name === 'rx_buf')!.section, '.bss');
        assert.strictEqual(e.symbolCount, 11);
        const light = readElf(file, { skipSymbols: true });
        assert.strictEqual(light.symbols.length, 0);
        assert.strictEqual(light.symbolCount, 11);   // known from the section header even when not read
    });

    test('symbolAt / sectionAt / topSymbols / region usage on the synthetic image', () => {
        const file = path.join(dir, 'synth2.elf');
        fs.writeFileSync(file, synthElf());
        const e = readElf(file);
        assert.deepStrictEqual(symbolAt(e.symbols, 0x08000042)!.symbol.name, 'HAL_Init');
        assert.strictEqual(symbolAt(e.symbols, 0x08000042)!.offset, 2);
        assert.ok(symbolAt(e.symbols, 0x08000042)!.exact);
        const after = symbolAt(e.symbols, 0x080000d8)!;   // past SysTick_Handler's 16 bytes
        assert.strictEqual(after.symbol.name, 'SysTick_Handler');
        assert.ok(!after.exact);
        assert.strictEqual(symbolAt(e.symbols, 0x30000000), undefined);
        assert.strictEqual(sectionAt(e.sections, 0x20000020)!.name, '.bss');
        assert.strictEqual(sectionAt(e.sections, 0x08000140), undefined);
        assert.deepStrictEqual(topSymbols(e, 3).map(r => `${r.symbol.name}:${r.symbol.size}`), ['rx_buf:512', 'HAL_Init:128', 'lut:64']);   // ties by name
        assert.deepStrictEqual(topSymbols(e, 2, { kind: 'OBJECT' }).map(r => r.symbol.name), ['rx_buf', 'lut']);
        assert.deepStrictEqual(occupiedRanges(e), [{ start: 0x08000000, end: 0x08000150 }, { start: 0x20000000, end: 0x20000210 }]);
        const usage = computeRegionUsage(e, [
            { name: 'FLASH', start: 0x08000000, size: 0x10000 }, { name: 'RAM', start: 0x20000000, size: 0x1000 }, { name: 'EXT', start: 0x60000000, size: 0x1000 },
        ]);
        assert.deepStrictEqual(usage.map(u => [u.name, u.used]), [['FLASH', 0x150], ['RAM', 0x210], ['EXT', 0]]);
        assert.deepStrictEqual(usage[1].sections, ['.data', '.bss']);
        assert.strictEqual(usage[1].percent.toFixed(1), '12.9');
        // Bytes outside every listed region: with only a small FLASH window, the rest of the image is uncovered.
        assert.deepStrictEqual(uncoveredRanges(e, [{ name: 'FLASH', start: 0x08000000, size: 0x10000 }, { name: 'RAM', start: 0x20000000, size: 0x1000 }]), []);
        assert.deepStrictEqual(uncoveredRanges(e, [{ name: 'FLASH', start: 0x08000000, size: 0x100 }]), [
            { start: 0x08000100, end: 0x08000150, bytes: 0x50, sections: ['.rodata'] },
            { start: 0x20000000, end: 0x20000210, bytes: 0x210, sections: ['.data', '.bss'] },
        ]);
    });

    test('rejects non-ELF, ELF64 and big-endian files', () => {
        const notElf = path.join(dir, 'x.hex');
        fs.writeFileSync(notElf, ':020000040800F2\n');
        assert.throws(() => readElf(notElf), /is not an ELF file/);
        const elf64 = path.join(dir, 'x64.elf');
        fs.writeFileSync(elf64, buildElf32({ sections: [], symbols: [], segments: [], elfClass: 2 }));
        assert.throws(() => readElf(elf64), /ELF64/);
        const be = path.join(dir, 'be.elf');
        fs.writeFileSync(be, buildElf32({ sections: [], symbols: [], segments: [], endian: 2 }));
        assert.throws(() => readElf(be), /big-endian/);
    });

    test('mapping symbols', () => {
        for (const s of ['$t', '$d', '$a', '$t.3', '$d.realdata', '$x']) { assert.ok(isMappingSymbol(s), s); }
        for (const s of ['$Sub$$main', 'main', '$$Super', '__stack$']) { assert.ok(!isMappingSymbol(s), s); }
    });

    test('real GCC image: blink-gcc.elf', () => {
        const e = readElf(path.join(BUILDINFO_FIXTURES, 'blink-gcc.elf'));
        assert.strictEqual(e.fileType, 'EXEC');
        assert.strictEqual(e.machine, 'ARM');
        assert.strictEqual(e.cpuName, '7E-M');   // what GCC 13 writes as Tag_CPU_name for -mcpu=cortex-m7
        assert.strictEqual(hex(e.entry), '0x08000077');
        assert.strictEqual(e.sections.length, 19);
        assert.strictEqual(e.segments.filter(s => s.type === PT_LOAD).length, 3);
        assert.deepStrictEqual(e.footprint, { text: 364, data: 128, bss: 1288 });   // arm-none-eabi-size
        assert.ok(e.hasDwarf);
        assert.match(e.comments[0], /^GCC: \(Arm GNU Toolchain 13\.3\.Rel1/);
        assert.strictEqual(e.symbolCount, 49);
        assert.ok(!e.symbols.some(s => s.name.startsWith('$')));
        const by = (n: string) => e.symbols.find(s => s.name === n)!;
        assert.deepStrictEqual([by('main').value, by('main').size, by('main').type, by('main').section], [0x08000050, 36, 'FUNC', '.text']);
        assert.deepStrictEqual([by('compute_crc').value, by('compute_crc').size], [0x08000080, 44]);
        assert.deepStrictEqual([by('crc_table').value, by('crc_table').size, by('crc_table').type], [0x080000ac, 256, 'OBJECT']);
        assert.deepStrictEqual([by('config_table').section, by('rx_buffer').binding, by('rx_buffer').size, by('tick_count').value], ['.data', 'LOCAL', 256, 0x20000140]);
        assert.strictEqual(symbolAt(e.symbols, 0x08000052)!.symbol.name, 'main');
        assert.deepStrictEqual(symbolAt(e.symbols, 0x080000ad), { symbol: by('crc_table'), offset: 1, exact: true });
        const usage = computeRegionUsage(e, [{ name: 'FLASH', start: 0x08000000, size: 0x100000 }, { name: 'RAM', start: 0x20000000, size: 0x50000 }]);
        // ROM = text 364 + vectors 64 + data initialisers 64; RAM = data 64 + bss 260 + heap 1028.
        assert.deepStrictEqual(usage.map(u => [u.name, u.used]), [['FLASH', 492], ['RAM', 1352]]);
        assert.deepStrictEqual(topSymbols(e, 3).map(r => r.symbol.name), ['crc_table', 'rx_buffer', 'config_table']);
    });

    test('real armlink image: blink-ac6.axf', () => {
        const e = readElf(path.join(BUILDINFO_FIXTURES, 'blink-ac6.axf'));
        assert.strictEqual(e.fileType, 'EXEC');
        assert.strictEqual(hex(e.entry), '0x080000f1');
        assert.strictEqual(e.cpuName, undefined);   // armlink writes no .ARM.attributes
        assert.strictEqual(e.segments.filter(s => s.type === PT_LOAD).length, 1);
        assert.deepStrictEqual(e.footprint, { text: 672, data: 128, bss: 2308 });   // = armlink Total RO / RW data / ZI
        assert.deepStrictEqual(e.notes, ['.note']);
        assert.match(e.comments[0], /^Component: Arm Compiler for Embedded 6\.24 Tool: armlink/);
        assert.ok(e.hasDwarf);
        const by = (n: string) => e.symbols.find(s => s.name === n)!;
        assert.deepStrictEqual([by('main').value, by('main').size, by('main').section], [0x08000138, 46, 'ER_ROM0']);
        assert.deepStrictEqual([by('compute_crc').value, by('compute_crc').size], [0x08000108, 48]);
        assert.deepStrictEqual([by('crc_table').value, by('crc_table').size, by('config_table').section, by('rx_buffer').size], [0x08000180, 256, 'RW_RAM0', 256]);
        // armlink's one PT_LOAD has memsz = ROM + ZI at the flash address; usage must come from the sections.
        const usage = computeRegionUsage(e, [{ name: 'IROM1', start: 0x08000000, size: 0x100000 }, { name: 'IRAM1', start: 0x20000000, size: 0x50000 }]);
        assert.deepStrictEqual(usage.map(u => [u.name, u.used]), [['IROM1', 800], ['IRAM1', 324 + 1024 + 1024]]);
        assert.deepStrictEqual(usage[1].sections, ['RW_RAM0', 'RW_RAM0', 'ARM_LIB_HEAP', 'ARM_LIB_STACK']);
    });
});
