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
 * Linker map parser over the real fixtures (`blink-gcc.elf.map` from GNU
 * ld 2.42 with `-Map`, `blink-ac6.axf.map` from armlink 6.24 with
 * `--map --symbols --info sizes,totals,unused`) plus hand-written excerpts
 * for the corner cases: long names on their own line, CMake object paths,
 * a map without MEMORY, IAR detection.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { hex } from '../core/buildInfo/elf';
import { classifySectionName, detectMapFormat, inputSectionAt, objectDisplayName, outputSectionAt, parseMapFile } from '../core/buildInfo/mapFile';
import { mapRegionUsage, usageRegions } from '../core/buildInfo/usage';
import { BUILDINFO_FIXTURES } from './buildInfoElf.test';

const read = (name: string) => fs.readFileSync(path.join(BUILDINFO_FIXTURES, name), 'utf-8');

const GNU_EXCERPT = `Archive member included to satisfy reference by file (symbol)

/opt/gcc/lib/libc_nano.a(libc_a-memset.o)
                              CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj (memset)

Discarded input sections

 .text          0x00000000        0x0 CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj
 .text.unused_function
                0x00000000       0x24 CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj

Linker script and memory map

LOAD CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj

.text           0x10000000     0x1000
 *(.text*)
 .text.main     0x10000000       0x40 CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj
                0x10000000                main
 .text._ZN10executorch7runtime16BackendInterface10set_optionERNS0_20BackendOptionContextERKNS0_4SpanINS0_13BackendOptionEEE
                0x10000040        0x4 /home/dev/proj/lib/libexecutorch.a(EthosUBackend.cpp.obj)
                0x10000040                executorch::runtime::BackendInterface::set_option(executorch::runtime::BackendOptionContext&, executorch::runtime::Span<executorch::runtime::BackendOption> const&)
 .text.memset   0x10000044      0x10c /opt/gcc/lib/libc_nano.a(libc_a-memset.o)
                0x10000044                memset
 *fill*         0x10000150        0x4

.ARM.exidx      0x10001000       0x10
 .ARM.exidx     0x10001000       0x10 CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj

.data           0x30000000       0x20 load address 0x10001010
                0x30000000                        __data_start__ = .
 .data.table    0x30000000       0x20 CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj
                0x30000000                table

.bss            0x30000020      0x100
 .bss.buffer    0x30000020      0x100 CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj
OUTPUT(app.elf elf32-littlearm)

Cross Reference Table

Symbol                                            File
main                                              CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj
`;

suite('buildInfo/mapFile', () => {
    test('detects formats', () => {
        assert.strictEqual(detectMapFormat(read('blink-gcc.elf.map')), 'gnu');
        assert.strictEqual(detectMapFormat(read('blink-ac6.axf.map')), 'armlink');
        assert.strictEqual(detectMapFormat('###############################################################################\n#\n# IAR ELF Linker V9.40.1.364/W64 for ARM\n'), 'iar');
        assert.strictEqual(detectMapFormat('hello\n'), 'unknown');
        const iar = parseMapFile('#####\n# IAR ELF Linker V9.40.1.364/W64 for ARM  10/Aug/2025\n#####\n', 'x.map');
        assert.strictEqual(iar.format, 'iar');
        assert.match(iar.notes[0], /IAR ILINK map files are not supported yet/);
    });

    test('object display names and section classes', () => {
        assert.deepStrictEqual(objectDisplayName('/opt/gcc/lib/libc_nano.a(libc_a-memset.o)'), { object: 'libc_nano.a(libc_a-memset.o)', library: 'libc_nano.a' });
        assert.deepStrictEqual(objectDisplayName('c_wu.l(__main.o)'), { object: 'c_wu.l(__main.o)', library: 'c_wu.l' });
        assert.deepStrictEqual(objectDisplayName('CMakeFiles/Group_App.dir/home/dev/proj/src/main.c.obj'), { object: 'main.c.obj' });
        assert.deepStrictEqual(objectDisplayName('startup_stm32f756xx.o'), { object: 'startup_stm32f756xx.o' });
        assert.strictEqual(classifySectionName('.text.main'), 'code');
        assert.strictEqual(classifySectionName('.isr_vector'), 'code');
        assert.strictEqual(classifySectionName('.rodata.crc_table'), 'rodata');
        assert.strictEqual(classifySectionName('.ARM.exidx'), 'rodata');
        assert.strictEqual(classifySectionName('.data.os'), 'data');
        assert.strictEqual(classifySectionName('.bss.rx_buffer'), 'bss');
        assert.strictEqual(classifySectionName('.heap'), 'bss');
        assert.strictEqual(classifySectionName('.noinit'), 'bss');
        assert.strictEqual(classifySectionName('.debug_info'), 'other');
    });

    test('GNU ld: regions, output and input sections, symbols, totals (blink-gcc.elf.map)', () => {
        const m = parseMapFile(read('blink-gcc.elf.map'), '/ws/out/blink-gcc.elf.map');
        assert.strictEqual(m.format, 'gnu');
        assert.deepStrictEqual(m.regions.map(r => [r.name, hex(r.origin), r.length, r.attributes, r.kind]), [['FLASH', '0x08000000', 0x100000, 'xr', 'memory'], ['RAM', '0x20000000', 0x50000, 'xrw', 'memory']]);
        const text = m.sections.find(s => s.name === '.text')!;
        assert.deepStrictEqual([hex(text.address), text.size, text.region, text.class, text.inputs.length, text.fill, text.allocated], ['0x08000040', 364, 'FLASH', 'code', 6, 2, true]);
        assert.deepStrictEqual(text.inputs.map(i => `${i.name}:${i.size}:${i.object}`), [
            '.text.SysTick_Handler:16:main.o', '.text.startup.main:36:main.o', '.text.Default_Handler:2:startup.o', '.text.Reset_Handler:8:startup.o',
            '.text.compute_crc:44:libutil.a(crc.o)', '.rodata.crc_table:256:libutil.a(crc.o)',
        ]);
        assert.strictEqual(text.inputs[5].class, 'rodata');
        const data = m.sections.find(s => s.name === '.data')!;
        assert.deepStrictEqual([hex(data.address), data.size, hex(data.loadAddress!), data.region, data.class], ['0x20000000', 64, '0x080001ac', 'RAM', 'data']);
        const bss = m.sections.find(s => s.name === '.bss')!;
        assert.deepStrictEqual(bss.inputs.map(i => [i.name, i.size]), [['.bss.rx_buffer', 256], ['.bss.tick_count', 4]]);
        const heap = m.sections.find(s => s.name === '.heap')!;
        assert.deepStrictEqual([heap.size, heap.inputs.length, heap.fill, heap.class], [1028, 0, 1028, 'bss']);
        assert.ok(!m.sections.find(s => s.name === '.debug_info')!.allocated);
        assert.ok(m.sections.find(s => s.name === '.comment'));
        // Per-object totals summed from the input sections; the archive member carries its library.
        assert.deepStrictEqual(m.objectTotals.map(o => [o.object, o.library, o.code, o.roData, o.rwData, o.ziData]), [
            ['main.o', undefined, 52, 0, 64, 260], ['libutil.a(crc.o)', 'libutil.a', 44, 256, 0, 0], ['startup.o', undefined, 74, 0, 0, 0],
        ]);
        assert.deepStrictEqual(m.libraryTotals.map(o => [o.object, o.code, o.roData]), [['libutil.a', 44, 256]]);
        // crc_table's 256 bytes live in .text but are RO data; fill and the heap reservation follow their output section.
        assert.deepStrictEqual(m.totals, { code: 172, roData: 256, rwData: 64, ziData: 1288, ro: 428, rw: 1352, rom: 492 });
        assert.deepStrictEqual(m.discarded, { count: 9, bytes: 0 });
        assert.deepStrictEqual(m.symbols.map(s => `${s.name}@${hex(s.address)}<${s.object}>${s.section}`).slice(0, 4), [
            'vector_table@0x08000000<startup.o>.isr_vector', 'SysTick_Handler@0x08000040<main.o>.text', 'main@0x08000050<main.o>.text', 'Default_Handler@0x08000074<startup.o>.text',
        ]);
        assert.ok(m.symbols.some(s => s.name === 'compute_crc' && s.object === 'libutil.a(crc.o)'));
        assert.ok(!m.symbols.some(s => s.name.includes('__etext') || s.name.includes('ALIGN')));
        const at = inputSectionAt(m, 0x08000081)!;
        assert.deepStrictEqual([at.section.name, at.input.name, at.input.object], ['.text', '.text.compute_crc', 'libutil.a(crc.o)']);
        assert.strictEqual(outputSectionAt(m, 0x20000041)!.name, '.bss');
        assert.strictEqual(inputSectionAt(m, 0x60000000), undefined);
        assert.deepStrictEqual(m.notes, []);
        const { regions, source } = usageRegions([], m);
        assert.strictEqual(source, 'map');
        assert.deepStrictEqual(regions.map(r => [r.name, r.size]), [['FLASH', 0x100000], ['RAM', 0x50000]]);
    });

    test('GNU ld excerpt: long names on their own line, CMake and archive object names, discarded sizes, cross-reference table ignored', () => {
        const m = parseMapFile(GNU_EXCERPT, 'app.elf.map');
        assert.strictEqual(m.format, 'gnu');
        assert.deepStrictEqual(m.discarded, { count: 2, bytes: 0x24 });
        const text = m.sections.find(s => s.name === '.text')!;
        assert.deepStrictEqual(text.inputs.map(i => `${i.name}:${i.size}:${i.object}`), [
            '.text.main:64:main.c.obj',
            '.text._ZN10executorch7runtime16BackendInterface10set_optionERNS0_20BackendOptionContextERKNS0_4SpanINS0_13BackendOptionEEE:4:libexecutorch.a(EthosUBackend.cpp.obj)',
            '.text.memset:268:libc_nano.a(libc_a-memset.o)',
        ]);
        assert.strictEqual(text.fill, 4);
        assert.strictEqual(text.region, undefined);
        assert.match(m.notes[0], /no Memory Configuration/);
        assert.ok(m.symbols.some(s => s.name.startsWith('executorch::runtime::BackendInterface::set_option(') && s.object === 'libexecutorch.a(EthosUBackend.cpp.obj)'));
        assert.deepStrictEqual(m.sections.find(s => s.name === '.data')!.loadAddress, 0x10001010);
        assert.deepStrictEqual(m.libraryTotals.map(l => [l.object, l.code]), [['libc_nano.a', 268], ['libexecutorch.a', 4]]);
        assert.deepStrictEqual(m.objectTotals[0], { object: 'main.c.obj', library: undefined, code: 64, roData: 16, rwData: 32, ziData: 256, rom: 112, ram: 288 });
        assert.strictEqual(m.sections.length, 4);
        assert.strictEqual(usageRegions([], m).source, 'none');
    });

    test('armlink: regions, execution regions, component sizes, totals, symbols (blink-ac6.axf.map)', () => {
        const m = parseMapFile(read('blink-ac6.axf.map'), '/ws/out/blink-ac6.axf.map');
        assert.strictEqual(m.format, 'armlink');
        assert.match(m.toolLine!, /^Component: Arm Compiler for Embedded 6\.24 Tool: armlink/);
        assert.strictEqual(hex(m.entry!), '0x080000f1');
        assert.deepStrictEqual(m.regions.map(r => [r.name, r.kind, hex(r.origin), r.length, r.used]), [
            ['LR_ROM0', 'load', '0x08000000', 0x100000, 800], ['ER_ROM0', 'execution', '0x08000000', 0x100000, 736],
            ['RW_RAM0', 'execution', '0x20000000', 0x50000, 324], ['ARM_LIB_HEAP', 'execution', '0x20040000', 1024, 1024], ['ARM_LIB_STACK', 'execution', '0x20040c00', 1024, 1024],
        ]);
        assert.deepStrictEqual(m.sections.map(s => [s.name, s.size, s.inputs.length, s.fill, s.class, s.region]), [
            ['ER_ROM0', 736, 61, 8, 'code', 'LR_ROM0'], ['RW_RAM0', 324, 3, 0, 'bss', 'LR_ROM0'], ['ARM_LIB_HEAP', 1024, 1, 0, 'bss', 'LR_ROM0'], ['ARM_LIB_STACK', 1024, 1, 0, 'bss', 'LR_ROM0'],
        ]);
        const rom = m.sections[0];
        const crc = rom.inputs.find(i => i.name === '.text.compute_crc')!;
        assert.deepStrictEqual([hex(crc.address), crc.size, crc.type, crc.attr, crc.object, crc.library, crc.class], ['0x08000108', 48, 'Code', 'RO', 'libutil_ac6.l(crc_ac6.o)', 'libutil_ac6.l', 'code']);
        const vectors = rom.inputs.find(i => i.name === '.vectors')!;
        assert.deepStrictEqual([vectors.type, vectors.attr, vectors.class, vectors.object], ['Data', 'RW', 'data', 'startup_ac6.o']);
        assert.strictEqual(rom.inputs.find(i => i.name === '!!!main')!.object, 'c_wu.l(__main.o)');
        assert.deepStrictEqual(m.sections[1].inputs.map(i => [i.name, i.size, i.type, i.class]), [['.data.config_table', 64, 'Data', 'data'], ['.bss.rx_buffer', 256, 'Zero', 'bss'], ['.bss.tick_count', 4, 'Zero', 'bss']]);
        // "Image component sizes" is authoritative: Code (inc. data) → code, then RO/RW/ZI; members carry their library from the memory map.
        const main = m.objectTotals.find(o => o.object === 'main_ac6.o')!;
        assert.deepStrictEqual([main.code, main.roData, main.rwData, main.ziData, main.rom, main.ram], [62, 0, 64, 260, 126, 324]);
        const crcObj = m.objectTotals.find(o => o.object === 'libutil_ac6.l(crc_ac6.o)')!;
        assert.deepStrictEqual([crcObj.library, crcObj.code, crcObj.roData], ['libutil_ac6.l', 48, 256]);
        assert.deepStrictEqual(m.libraryTotals.map(l => [l.object, l.code, l.roData]), [['libutil_ac6.l', 48, 256], ['c_wu.l', 248, 0], ['fz_wv.l', 26, 0]]);
        assert.deepStrictEqual(m.totals, { code: 400, roData: 288, rwData: 128, ziData: 2308, ro: 672, rw: 2436, rom: 800 });
        assert.deepStrictEqual(m.discarded, { count: 9, bytes: 44 });
        const sym = m.symbols.find(s => s.name === 'compute_crc')!;
        assert.deepStrictEqual([hex(sym.address), sym.object, sym.section], ['0x08000108', 'crc_ac6.o', '.text.compute_crc']);
        assert.ok(!m.symbols.some(s => s.name.startsWith('../clib')));
        const at = inputSectionAt(m, 0x08000180)!;
        assert.deepStrictEqual([at.section.name, at.input.name, at.input.object], ['ER_ROM0', '.rodata.crc_table', 'libutil_ac6.l(crc_ac6.o)']);
        assert.deepStrictEqual(m.notes, []);
        assert.deepStrictEqual(mapRegionUsage(m).map(u => [u.name, u.used, u.size]), [['LR_ROM0', 800, 0x100000]]);
        assert.deepStrictEqual(usageRegions([], m).regions.map(r => r.name), ['LR_ROM0']);
    });

    test('armlink map with only the Component line (cbuild default) is armlink with nothing in it', () => {
        const m = parseMapFile('Component: Arm Compiler for Embedded 6.24 Tool: armlink [5f371500]\n', 'Blinky.axf.map');
        assert.strictEqual(m.format, 'armlink');
        assert.deepStrictEqual([m.sections.length, m.regions.length, m.objectTotals.length, m.symbols.length, m.totals], [0, 0, 0, 0, {}]);
        assert.match(m.notes.join('\n'), /no "Image component sizes"/);
        assert.match(m.notes.join('\n'), /no "Memory Map of the image"/);
    });

    test('armlink without --info sizes sums the memory map and says so', () => {
        const full = read('blink-ac6.axf.map');
        const trimmed = full.slice(0, full.indexOf('Image component sizes'));
        const m = parseMapFile(trimmed, 'x.map');
        assert.match(m.notes[0], /no "Image component sizes"/);
        const main = m.objectTotals.find(o => o.object === 'main_ac6.o')!;
        assert.deepStrictEqual([main.code, main.rwData, main.ziData], [62, 64, 260]);
        assert.strictEqual(m.objectTotals.find(o => o.object === 'c_wu.l(__scatter.o)')!.library, 'c_wu.l');
        // Summed from the rows: RO data = crc_table 256 + Region$$Table 32, RW = config_table 64 + .vectors 64, ZI = 260 + heap + stack;
        // code differs from the linker's own 400 by the padding and "inc. data" bytes the row table cannot see.
        assert.deepStrictEqual([m.totals.roData, m.totals.rwData, m.totals.ziData], [288, 128, 2308]);
        assert.ok(m.totals.code! >= 370 && m.totals.code! <= 400, `code ${m.totals.code}`);
        assert.strictEqual(m.totals.ro, m.totals.code! + 288);
        assert.strictEqual(m.totals.rom, m.totals.ro! + 128);
        assert.strictEqual(m.totals.rw, 128 + 2308);
    });
});
