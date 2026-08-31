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
 * End to end through the handler: a temp workspace laid out the way
 * csolution/cbuild write it — `out/<solution>+<target>.cbuild-run.yml`
 * with the output list and memory regions, the image folder with the
 * cbuild.yml, axf/elf, map and hex — for an AC6 context and a GCC context,
 * plus a build log; the five tools against it with a fake host.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildInfoHandler, parseAddress } from '../buildInfoHandler';
import { parseCbuildRunOutputs, parseCbuildYml, resolveBuildContext } from '../core/buildInfo/artifacts';
import { walkGlob } from '../core/buildInfo/glob';
import { BuildInfoHost, BuildInfoLog, defaultBuildInfoSettings } from '../core/buildInfo/host';
import { BUILDINFO_FIXTURES } from './buildInfoElf.test';
import { SAMPLE_CBUILD_RUN } from './cbuildRun.test';

const NUCLEO_RUN = SAMPLE_CBUILD_RUN.replace('  target-type: STM32F756ZGTx', '  target-type: NUCLEO-F756ZG') + `  output:
    - file: Blinky/NUCLEO-F756ZG/Debug/Blinky.axf
      info: generate by Blinky.Debug+NUCLEO-F756ZG
      type: elf
      load: image+symbols
    - file: Blinky/NUCLEO-F756ZG/Debug/Blinky.hex
      info: generate by Blinky.Debug+NUCLEO-F756ZG
      type: hex
      load: image
  system-resources:
    memory:
      - name: IROM1
        access: rx
        start: 0x08000000
        size: 0x00100000
        default: true
        from-pack: Keil::STM32F7xx_DFP@3.0.0
      - name: IRAM1
        access: rw
        start: 0x20000000
        size: 0x00050000
        default: true
        from-pack: Keil::STM32F7xx_DFP@3.0.0
      - name: IRAM2
        access: rw
        start: 0x20050000
        size: 0x00010000
        from-pack: Keil::STM32F7xx_DFP@3.0.0
`;

const FVP_RUN = `cbuild-run:
  generated-by: csolution version 2.14.1
  solution: ../Blinky.csolution.yml
  target-type: FVP
  compiler: GCC
  device: ARM::SSE-300-MPS3
  device-pack: ARM::V2M_MPS3_SSE_300_BSP@1.5.0
  output:
    - file: Blinky/FVP/Debug/Blinky.elf
      info: generate by Blinky.Debug+FVP
      type: elf
      load: image+symbols
`;

function cbuildYml(context: string, compiler: string, outputs: [string, string][]): string {
    return `build:\n  generated-by: csolution version 2.14.1\n  solution: ../../../../Blinky.csolution.yml\n  project: ../../../../Blinky.cproject.yml\n  context: ${context}\n  compiler: ${compiler}\n  device: STMicroelectronics::STM32F756ZGTx\n` +
        `  processor:\n    fpu: dp\n    core: Cortex-M7\n  output-dirs:\n    intdir: ../../../../tmp\n    outdir: .\n  output:\n` +
        outputs.map(([type, file]) => `    - type: ${type}\n      file: ${file}\n`).join('') +
        `  linker:\n    script: ../../../../RTE/Device/STM32F756ZGTx/ac6_linker_script.sct\n  groups:\n    - group: App\n`;
}

interface World { root: string; workspace: string; host: BuildInfoHost; lines: string[] }

function buildWorld(): World {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildinfo-e2e-'));
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'Blinky.csolution.yml'), 'solution:\n  target-types:\n    - type: NUCLEO-F756ZG\n');
    const out = path.join(workspace, 'out');
    const nucleo = path.join(out, 'Blinky', 'NUCLEO-F756ZG', 'Debug');
    const fvp = path.join(out, 'Blinky', 'FVP', 'Debug');
    fs.mkdirSync(nucleo, { recursive: true });
    fs.mkdirSync(fvp, { recursive: true });
    fs.writeFileSync(path.join(out, 'Blinky+NUCLEO-F756ZG.cbuild-run.yml'), NUCLEO_RUN);
    fs.writeFileSync(path.join(out, 'Blinky+FVP.cbuild-run.yml'), FVP_RUN);
    fs.writeFileSync(path.join(nucleo, 'Blinky.Debug+NUCLEO-F756ZG.cbuild.yml'), cbuildYml('Blinky.Debug+NUCLEO-F756ZG', 'AC6', [['elf', 'Blinky.axf'], ['hex', 'Blinky.hex'], ['map', 'Blinky.axf.map'], ['comp-db', 'compile_commands.json']]));
    fs.copyFileSync(path.join(BUILDINFO_FIXTURES, 'blink-ac6.axf'), path.join(nucleo, 'Blinky.axf'));
    fs.copyFileSync(path.join(BUILDINFO_FIXTURES, 'blink-ac6.axf.map'), path.join(nucleo, 'Blinky.axf.map'));
    fs.writeFileSync(path.join(nucleo, 'Blinky.hex'), ':020000040800F2\n:00000001FF\n');
    fs.writeFileSync(path.join(fvp, 'Blinky.Debug+FVP.cbuild.yml'), cbuildYml('Blinky.Debug+FVP', 'GCC', [['elf', 'Blinky.elf'], ['map', 'Blinky.elf.map']]));
    fs.copyFileSync(path.join(BUILDINFO_FIXTURES, 'blink-gcc.elf'), path.join(fvp, 'Blinky.elf'));
    fs.copyFileSync(path.join(BUILDINFO_FIXTURES, 'blink-gcc.elf.map'), path.join(fvp, 'Blinky.elf.map'));
    fs.copyFileSync(path.join(BUILDINFO_FIXTURES, 'build-failed.log'), path.join(out, 'build.log'));
    // An older, unrelated log elsewhere in the workspace must rank below the one in out/.
    fs.mkdirSync(path.join(workspace, 'logs'), { recursive: true });
    fs.copyFileSync(path.join(BUILDINFO_FIXTURES, 'build-ok.log'), path.join(workspace, 'logs', 'build-old.log'));
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(workspace, 'logs', 'build-old.log'), old, old);

    const lines: string[] = [];
    const log: BuildInfoLog = {
        debug: (m) => lines.push(`D ${m}`), info: (m) => lines.push(`I ${m}`), warn: (m) => lines.push(`W ${m}`),
        error: (m, e) => lines.push(`E ${m} ${e instanceof Error ? e.message : e ?? ''}`),
    };
    const host: BuildInfoHost = {
        workspaceFolders: () => [workspace],
        findFiles: async (glob) => walkGlob(workspace, glob),
        settings: () => defaultBuildInfoSettings,
        log,
    };
    return { root, workspace, host, lines };
}

suite('BuildInfoHandler (end to end)', () => {
    let world: World;
    let handler: BuildInfoHandler;

    suiteSetup(() => {
        world = buildWorld();
        handler = new BuildInfoHandler(world.host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace });
    });

    test('cbuild-run outputs and memory, cbuild.yml outputs', () => {
        const extra = parseCbuildRunOutputs(NUCLEO_RUN, '/ws/out/x.cbuild-run.yml');
        assert.strictEqual(extra.compiler, 'AC6');
        assert.deepStrictEqual(extra.outputs.map(o => [o.type, o.file, o.load]), [['elf', '/ws/out/Blinky/NUCLEO-F756ZG/Debug/Blinky.axf', 'image+symbols'], ['hex', '/ws/out/Blinky/NUCLEO-F756ZG/Debug/Blinky.hex', 'image']]);
        assert.deepStrictEqual(extra.memory.map(m => [m.name, m.access, m.start, m.size, m.default, m.fromPack]), [
            ['IROM1', 'rx', 0x08000000, 0x100000, true, 'Keil::STM32F7xx_DFP@3.0.0'], ['IRAM1', 'rw', 0x20000000, 0x50000, true, 'Keil::STM32F7xx_DFP@3.0.0'], ['IRAM2', 'rw', 0x20050000, 0x10000, undefined, 'Keil::STM32F7xx_DFP@3.0.0'],
        ]);
        const ctx = parseCbuildYml(cbuildYml('Blinky.Debug+NUCLEO-F756ZG', 'AC6', [['elf', 'Blinky.axf'], ['map', 'Blinky.axf.map']]), '/ws/out/Blinky/NUCLEO-F756ZG/Debug/Blinky.Debug+NUCLEO-F756ZG.cbuild.yml');
        assert.deepStrictEqual([ctx.context, ctx.compiler, ctx.processor, ctx.device], ['Blinky.Debug+NUCLEO-F756ZG', 'AC6', 'Cortex-M7', 'STMicroelectronics::STM32F756ZGTx']);
        assert.deepStrictEqual(ctx.outputs.map(o => [o.type, o.file]), [['elf', '/ws/out/Blinky/NUCLEO-F756ZG/Debug/Blinky.axf'], ['map', '/ws/out/Blinky/NUCLEO-F756ZG/Debug/Blinky.axf.map']]);
        assert.strictEqual(ctx.linkerScript, '/ws/RTE/Device/STM32F756ZGTx/ac6_linker_script.sct');
    });

    test('resolveBuildContext prefers the active csolution context', async () => {
        const fvp = await resolveBuildContext({ ...world.host, activeContext: async () => ({ solution: 'Blinky', targetType: 'FVP' }) }, {});
        assert.ok(!('error' in fvp), 'the hinted context resolves without target');
        assert.strictEqual(fvp.compiler, 'GCC');
        assert.match(fvp.notes.join('\n'), /active csolution context Blinky \(FVP\): using Blinky\+FVP\.cbuild-run\.yml/);
        const stale = await resolveBuildContext({ ...world.host, activeContext: async () => ({ solution: 'Blinky', targetType: 'Nope' }) }, {});
        assert.ok('error' in stale && /2 cbuild-run contexts — pass target/.test(stale.error), 'a hint matching nothing keeps the ambiguity error');
    });

    test('resolveBuildContext: ambiguity, target by run name, target-type and image name, missing', async () => {
        const both = await resolveBuildContext(world.host, {});
        assert.ok('error' in both && /2 cbuild-run contexts — pass target/.test(both.error) && /Blinky\+FVP\.cbuild-run\.yml \(FVP: SSE-300-MPS3, GCC; Blinky\.elf\)/.test(both.error));
        const nucleo = await resolveBuildContext(world.host, { target: 'nucleo' });
        assert.ok(!('error' in nucleo));
        assert.strictEqual(nucleo.compiler, 'AC6');
        assert.strictEqual(nucleo.images.length, 1);
        assert.deepStrictEqual([nucleo.images[0].name, nucleo.images[0].compiler, nucleo.images[0].context, path.basename(nucleo.images[0].map!.path), nucleo.images[0].hex?.exists], ['Blinky', 'AC6', 'Blinky.Debug+NUCLEO-F756ZG', 'Blinky.axf.map', true]);
        assert.strictEqual(nucleo.memory.length, 3);
        const byImage = await resolveBuildContext(world.host, { target: 'blinky.elf' });
        assert.ok(!('error' in byImage) && byImage.run.targetType === 'FVP');
        const none = await resolveBuildContext(world.host, { target: 'nope' });
        assert.ok('error' in none && /No cbuild-run context or image matches target 'nope'/.test(none.error));
        const empty = await resolveBuildContext({ ...world.host, findFiles: async () => [] }, {});
        assert.ok('error' in empty && /no build output yet\. Build first: `cbuild Blinky\.csolution\.yml --packs --update-rte`/.test(empty.error));
    });

    test('list_build_artifacts', async () => {
        const ambiguous = await handler.handleListBuildArtifacts({});
        assert.match(ambiguous, /2 cbuild-run contexts — pass target/);
        const text = await handler.handleListBuildArtifacts({ target: 'NUCLEO' });
        assert.match(text, /^Build: target NUCLEO-F756ZG, device STMicroelectronics::STM32F756ZGTx, compiler AC6, board NUCLEO-F756ZG — from out\/Blinky\+NUCLEO-F756ZG\.cbuild-run\.yml$/m);
        assert.match(text, /^Image Blinky — context Blinky\.Debug\+NUCLEO-F756ZG$/m);
        assert.match(text, /^  axf: out\/Blinky\/NUCLEO-F756ZG\/Debug\/Blinky\.axf · 13 kB · 20\d\d-\d\d-\d\d \d\d:\d\d$/m);
        assert.match(text, /^    \[Blinky\.axf\] EXEC ARM, entry 0x080000f1, text 672 \+ data 128 \+ bss 2308 = 3108 B; 19 sections, 200 symbols, DWARF debug info$/m);
        assert.match(text, /^    \[Blinky\.axf\] built with: Component: Arm Compiler for Embedded 6\.24 Tool: armlink/m);
        assert.match(text, /^  map: out\/Blinky\/NUCLEO-F756ZG\/Debug\/Blinky\.axf\.map · 36 kB/m);
        assert.match(text, /^  hex: out\/Blinky\/NUCLEO-F756ZG\/Debug\/Blinky\.hex · 28 B/m);
        assert.match(text, /^  cbuild: out\/Blinky\/NUCLEO-F756ZG\/Debug\/Blinky\.Debug\+NUCLEO-F756ZG\.cbuild\.yml, linker script RTE\/Device\/STM32F756ZGTx\/ac6_linker_script\.sct$/m);
        assert.match(text, /^Newest build log: out\/build\.log · 4 kB · .* — FAILED, 10 error\(s\), 7 warning\(s\)$/m);
        assert.match(text, /^Memory regions \[Blinky\+NUCLEO-F756ZG\.cbuild-run\.yml\] \(3\):$/m);
        assert.match(text, /^  IROM1 +0x08000000 +1\.0 MB rx default$/m);
        assert.match(text, /^  IRAM2 +0x20050000 +64 kB rw$/m);
        assert.match(text, /^Next: get_memory_usage/m);
        const gcc = await handler.handleListBuildArtifacts({ target: 'FVP' });
        assert.match(gcc, /compiler GCC — from out\/Blinky\+FVP\.cbuild-run\.yml/);
        assert.match(gcc, /\[Blinky\.elf\] EXEC ARM 7E-M, entry 0x08000077, text 364 \+ data 128 \+ bss 1288 = 1780 B/);
        assert.match(gcc, /^Memory regions: none in Blinky\+FVP\.cbuild-run\.yml/m);
        assert.ok(world.lines.some(l => /^I \[list_build_artifacts #\d+\] → \{"target":"NUCLEO"\}/.test(l)));
        assert.ok(world.lines.some(l => /^I \[list_build_artifacts #\d+\] ← \d+ ms, \d+ bytes/.test(l)));
    });

    test('get_memory_usage: device regions from cbuild-run (AC6) and map regions (GCC)', async () => {
        const ac6 = await handler.handleGetMemoryUsage({ target: 'NUCLEO', top: 5 });
        assert.match(ac6, /^Image Blinky: out\/Blinky\/NUCLEO-F756ZG\/Debug\/Blinky\.axf, map out\/Blinky\/NUCLEO-F756ZG\/Debug\/Blinky\.axf\.map \(armlink\)$/m);
        assert.match(ac6, /^\[Blinky\.axf\] size: text 672 \+ data 128 \+ bss 2308 = 3108 B \(ROM ≈ 800 B, RAM ≈ 2436 B\)$/m);
        assert.match(ac6, /^\[Blinky\.axf\.map\] totals: code 400, ro-data 288, rw-data 128, zi-data 2308 → RO 672, RW 2436, ROM 800 B$/m);
        assert.match(ac6, /^Regions \(device regions from Blinky\+NUCLEO-F756ZG\.cbuild-run\.yml, usage from Blinky\.axf LOAD segments\):$/m);
        assert.match(ac6, /^  IROM1 +0x08000000 +800 \/ +1048576 B +0\.1%  ER_ROM0 ER_ROM0$/m);
        assert.match(ac6, /^  IRAM1 +0x20000000 +2372 \/ +327680 B +0\.7%  RW_RAM0 RW_RAM0 ARM_LIB_HEAP ARM_LIB_STACK$/m);
        assert.match(ac6, /^  unused: IRAM2$/m);
        assert.doesNotMatch(ac6, /outside the listed regions/);
        // With only IROM1 known, the RAM sections are reported as outside the listed regions.
        const romOnlyRun = NUCLEO_RUN.slice(0, NUCLEO_RUN.indexOf('      - name: IRAM1'));
        const romOnlyDir = path.join(world.root, 'romonly', 'out');
        fs.mkdirSync(path.join(romOnlyDir, 'Blinky', 'NUCLEO-F756ZG', 'Debug'), { recursive: true });
        fs.writeFileSync(path.join(romOnlyDir, 'Blinky+NUCLEO-F756ZG.cbuild-run.yml'), romOnlyRun);
        fs.copyFileSync(path.join(BUILDINFO_FIXTURES, 'blink-ac6.axf'), path.join(romOnlyDir, 'Blinky', 'NUCLEO-F756ZG', 'Debug', 'Blinky.axf'));
        fs.writeFileSync(path.join(romOnlyDir, 'Blinky', 'NUCLEO-F756ZG', 'Debug', 'Blinky.axf.map'), 'Component: Arm Compiler for Embedded 6.24 Tool: armlink [5f371500]\n');
        const romOnlyWs = path.join(world.root, 'romonly');
        const romOnly = await new BuildInfoHandler({ ...world.host, workspaceFolders: () => [romOnlyWs], findFiles: async (g) => walkGlob(romOnlyWs, g) }, { timeoutMs: 5000, workspaceRoot: () => romOnlyWs }).handleGetMemoryUsage({});
        assert.match(romOnly, /^  IROM1 +0x08000000 +800 \/ +1048576 B +0\.1%  ER_ROM0 ER_ROM0$/m);
        assert.match(romOnly, /^  outside the listed regions: 0x20000000 \+324 B  RW_RAM0 RW_RAM0$/m);
        assert.match(romOnly, /^  outside the listed regions: 0x20040000 \+1024 B  ARM_LIB_HEAP$/m);
        assert.match(romOnly, /^  outside the listed regions: 0x20040c00 \+1024 B  ARM_LIB_STACK$/m);
        // A map holding only armlink's Component line (cbuild's default) adds no numbers.
        assert.doesNotMatch(romOnly, /totals: code 0/);
        assert.match(romOnly, /^Note: no "Memory Map of the image" in the map/m);
        assert.match(romOnly, /^\[Blinky\.axf\.map\] names no objects — link with a full map/m);
        assert.match(romOnly, /^ +256 B  obj   0x08000180  crc_table  ER_ROM0 @IROM1$/m);
        assert.match(ac6, /^  \[Blinky\.axf\.map\] execution regions: ER_ROM0 736\/1048576 B, RW_RAM0 324\/327680 B, ARM_LIB_HEAP 1024\/1024 B, ARM_LIB_STACK 1024\/1024 B$/m);
        assert.match(ac6, /^Largest symbols \[Blinky\.axf\] \(top 5, object from Blinky\.axf\.map\):$/m);
        assert.match(ac6, /^ +256 B  obj   0x08000180  crc_table  ER_ROM0 @IROM1  ← libutil_ac6\.l\(crc_ac6\.o\)$/m);
        assert.match(ac6, /^ +256 B  obj   0x20000040  rx_buffer  RW_RAM0 @IRAM1  ← main_ac6\.o$/m);
        assert.match(ac6, /^ +84 B  func  0x08000008  __scatterload_rt2  ER_ROM0 @IROM1  ← c_wu\.l\(__scatter\.o\)$/m);
        assert.match(ac6, /^Largest objects \[Blinky\.axf\.map\] \(top 5 of \d+; code \/ ro-data \/ rw-data \/ zi-data\):$/m);
        assert.match(ac6, /^ +386 B  main_ac6\.o  62 \/ 0 \/ 64 \/ 260$/m);
        assert.match(ac6, /^ +304 B  libutil_ac6\.l\(crc_ac6\.o\)  48 \/ 256 \/ 0 \/ 0$/m);
        assert.match(ac6, /^Libraries \[Blinky\.axf\.map\]:$/m);
        assert.match(ac6, /^\[Blinky\.axf\.map\] discarded 9 unused input sections \(44 B\)\.$/m);
        assert.match(ac6, /^Next: lookup_symbol/m);

        const gcc = await handler.handleGetMemoryUsage({ target: 'FVP', top: 3 });
        assert.match(gcc, /map out\/Blinky\/FVP\/Debug\/Blinky\.elf\.map \(gnu\)/);
        assert.match(gcc, /^Regions \(regions and usage from Blinky\.elf\.map\):$/m);
        assert.match(gcc, /^  FLASH +0x08000000 +492 \/ +1048576 B +0\.0%  \.isr_vector \.text$/m);
        assert.match(gcc, /^  RAM +0x20000000 +1352 \/ +327680 B +0\.4%  \.data \.bss \.heap$/m);
        assert.match(gcc, /^ +256 B  obj   0x080000ac  crc_table  \.text @FLASH  ← libutil\.a\(crc\.o\)$/m);
        assert.match(gcc, /^ +300 B  libutil\.a\(crc\.o\)  44 \/ 256 \/ 0 \/ 0$/m);
        assert.match(gcc, /^\[Blinky\.elf\.map\] discarded 9 unused input sections \(0 B\)\.$/m);
        // A budget clips the text.
        const clipped = await handler.handleGetMemoryUsage({ target: 'NUCLEO', top: 50, maxChars: 800 });
        assert.ok(clipped.length < 900 && /more chars\)$/.test(clipped));
    });

    test('lookup_symbol by name and address', async () => {
        const exact = await handler.handleLookupSymbol({ target: 'NUCLEO', name: 'compute_crc' });
        assert.match(exact, /^Symbol 'compute_crc' — exact match:$/m);
        assert.match(exact, /^  \[Blinky\.axf\] compute_crc: 0x08000108, 48 B, func global, section ER_ROM0 @IROM1 \[Blinky\.axf\.map\] defined in libutil_ac6\.l\(crc_ac6\.o\) \(\.text\.compute_crc\)$/m);
        const ci = await handler.handleLookupSymbol({ target: 'NUCLEO', name: 'Compute_CRC' });
        assert.match(ci, /case-insensitive match:/);
        const sub = await handler.handleLookupSymbol({ target: 'NUCLEO', name: 'crc' });
        assert.match(sub, /substring matches \(2\):/);
        assert.match(sub, /crc_table: 0x08000180, 256 B, object global/);
        const miss = await handler.handleLookupSymbol({ target: 'NUCLEO', name: 'HAL_Init' });
        assert.match(miss, /No symbol matches 'HAL_Init' in Blinky\.axf \(\d+ symbols\)\./);
        const addr = await handler.handleLookupSymbol({ target: 'NUCLEO', address: '0x0800010a' });
        assert.match(addr, /^Address 0x0800010a:$/m);
        assert.match(addr, /^  \[Blinky\.axf\] in compute_crc \+ 2 \(0x08000108, 48 B, func\) \[Blinky\.axf\.map\] defined in libutil_ac6\.l\(crc_ac6\.o\)$/m);
        assert.match(addr, /^  \[Blinky\.axf\] section ER_ROM0$/m);
        assert.match(addr, /^  \[Blinky\.axf\.map\] output section ER_ROM0 0x08000000 \+736 B$/m);
        assert.match(addr, /^  \[Blinky\+NUCLEO-F756ZG\.cbuild-run\.yml\] region IROM1 0x08000000 \+1048576 B rx$/m);
        // Inside the heap: no symbol, but the section and the device region are known.
        const ram = await handler.handleLookupSymbol({ target: 'NUCLEO', address: '0x20040010' });
        assert.match(ram, /^  \[Blinky\.axf\] no symbol covers this address$/m);
        assert.match(ram, /^  \[Blinky\.axf\] section ARM_LIB_HEAP$/m);
        assert.match(ram, /^  \[Blinky\.axf\.map\] output section ARM_LIB_HEAP 0x20040000 \+1024 B$/m);
        assert.match(ram, /region IRAM1 0x20000000 \+327680 B rw$/m);
        // Just past a sized function: reported as "after", with the gap.
        const after = await handler.handleLookupSymbol({ target: 'NUCLEO', address: '0x08000166' });
        assert.match(after, /\[Blinky\.axf\] in _fp_init \+ 0 \(0x08000166, 26 B, func\)/);
        const gap = await handler.handleLookupSymbol({ target: 'FVP', address: '0x0800007e' });
        assert.match(gap, /^  \[Blinky\.elf\] after Reset_Handler \+ 8 \(0x08000076, 8 B, func\) \[Blinky\.elf\.map\] defined in startup\.o$/m);
        const outside = await handler.handleLookupSymbol({ target: 'NUCLEO', address: '0x60000000' });
        assert.match(outside, /no symbol covers this address/);
        assert.match(outside, /not inside any known memory region/);
        const gcc = await handler.handleLookupSymbol({ target: 'FVP', name: 'main' });
        assert.match(gcc, /\[Blinky\.elf\] main: 0x08000050, 36 B, func global, section \.text @FLASH \[Blinky\.elf\.map\] defined in main\.o \(\.text\.startup\.main\)/);
        // Without device regions in the cbuild-run, the region line is attributed to the map.
        const gccAddr = await handler.handleLookupSymbol({ target: 'FVP', address: '0x20000001' });
        assert.match(gccAddr, /^  \[Blinky\.elf\] in config_table \+ 1 \(0x20000000, 64 B, object\) \[Blinky\.elf\.map\] defined in main\.o$/m);
        assert.match(gccAddr, /^  \[Blinky\.elf\.map\] region RAM 0x20000000 \+327680 B xrw$/m);
        assert.match(await handler.handleLookupSymbol({ target: 'NUCLEO' }), /^Pass name .* or address/);
        assert.match(await handler.handleLookupSymbol({ target: 'NUCLEO', address: 'xyz' }), /is not a hex/);
        assert.deepStrictEqual([parseAddress('0x0800_1234'), parseAddress('08001234h'), parseAddress('4096'), parseAddress('08001234'), parseAddress('g')], [0x08001234, 0x08001234, 4096, 0x08001234, undefined]);
    });

    test('get_section_layout', async () => {
        const text = await handler.handleGetSectionLayout({ target: 'NUCLEO', top: 2 });
        assert.match(text, /^Segments \[Blinky\.axf\]:$/m);
        assert.match(text, /^  LOAD 0x08000000 memsz +3108 filesz +800 RWX @IROM1$/m);
        assert.match(text, /^Sections \[Blinky\.axf\] \(allocated, 6\):$/m);
        assert.match(text, /^  ER_ROM0 +0x08000000 +672 B  code   @IROM1$/m);
        assert.match(text, /^  ER_ROM0 +0x080002a0 +64 B  data   @IROM1$/m);
        assert.match(text, /^  ARM_LIB_STACK +0x20040c00 +1024 B  bss    @IRAM1$/m);
        assert.match(text, /^Contributors \[Blinky\.axf\.map\] \(per execution region, top 2 objects each\):$/m);
        assert.match(text, /^  ER_ROM0 0x08000000 736 B @LR_ROM0, fill 8 — 61 input sections, \d+ objects$/m);
        assert.match(text, /^ +304 B  libutil_ac6\.l\(crc_ac6\.o\)$/m);
        assert.match(text, /^      … \d+ more objects$/m);
        assert.match(text, /^  RW_RAM0 0x20000000 324 B @LR_ROM0 — 3 input sections, 1 objects$/m);
        const gcc = await handler.handleGetSectionLayout({ target: 'FVP' });
        assert.match(gcc, /^  LOAD 0x20000000 memsz +324 filesz +64 RW- load from 0x080001ac @RAM$/m);
        assert.match(gcc, /^  \.data +0x20000000 +64 B  data   @RAM$/m);
        assert.match(gcc, /^Contributors \[Blinky\.elf\.map\] \(per output section, top 5 objects each\):$/m);
        assert.match(gcc, /^  \.data 0x20000000 64 B \(load 0x080001ac\) @RAM — 1 input sections, 1 objects$/m);
        assert.match(gcc, /^  \.text 0x08000040 364 B @FLASH, fill 2 — 6 input sections, 3 objects$/m);
    });

    test('get_build_diagnostics: newest log under out/, explicit file, none', async () => {
        const text = await handler.handleGetBuildDiagnostics({ target: 'NUCLEO', limit: 4 });
        assert.match(text, /^Build: target NUCLEO-F756ZG, compiler AC6 — from out\/Blinky\+NUCLEO-F756ZG\.cbuild-run\.yml$/m);
        assert.match(text, /^Build log: out\/build\.log · 4 kB · .* · \d+ lines$/m);
        assert.match(text, /^  contexts: Blinky\.Debug\+NUCLEO-F756ZG, Blinky\.Debug\+FVP$/m);
        assert.match(text, /^Status: FAILED — Build summary: 0 succeeded, 2 failed - Time Elapsed: 00:00:04; 10 error\(s\), 7 warning\(s\), 1 note\(s\)$/m);
        assert.match(text, /^Failed steps: …\/dev\/Blinky\/main\.o, Blinky\.elf$/m);
        assert.match(text, /^Diagnostics \(first 4 of 17, errors first\):$/m);
        assert.match(text, /^  \[build\.log\]:7 error …\/dev\/Blinky\/main\.c:12:10: expected "FILENAME" or <FILENAME>$/m);
        assert.match(text, /^  \[build\.log\]:25 error #20 …\/dev\/Blinky\/legacy\.c:25:9: identifier "undefined_thing" is undefined$/m);
        assert.match(text, /^  … 13 more — pass limit: 17$/m);
        assert.match(text, /^Other logs \(newest first\): logs\/build-old\.log — pass file to read one\.$/m);
        const all = await handler.handleGetBuildDiagnostics({ target: 'NUCLEO' });
        assert.match(all, /\[build\.log\]:10 warning -Wunused-variable …\/dev\/Blinky\/main\.c:30:5: unused variable 'tmp' \(×2\)/);
        assert.match(all, /\[build\.log\]:47 error L6218E linker: Undefined symbol osKernelStart/);
        const explicit = await handler.handleGetBuildDiagnostics({ file: 'logs/build-old.log' });
        assert.match(explicit, /^Build log: logs\/build-old\.log/m);
        assert.match(explicit, /^Status: ok — Build summary: 1 succeeded, 0 failed/m);
        assert.doesNotMatch(explicit, /^Build: target/m);
        assert.match(await handler.handleGetBuildDiagnostics({ file: 'nope.log' }), /^Log file not found/);
        const noLogs = new BuildInfoHandler({ ...world.host, settings: () => ({ ...defaultBuildInfoSettings, logGlobs: ['**/nothing/*.log'] }) }, { timeoutMs: 5000 });
        const none = await noLogs.handleGetBuildDiagnostics({ target: 'NUCLEO' });
        assert.match(none, /^No build log found \(searched \*\*\/nothing\/\*\.log\)\. The CMSIS Solution extension runs cbuild in a terminal and keeps no log file\. Capture one with `cbuild <solution>\.csolution\.yml --packs --update-rte --log out\/build\.log`/m);
    });

    test('no build output yet, timeout fence, failure text', async () => {
        const ws = path.join(world.root, 'fresh');
        fs.mkdirSync(path.join(ws, 'out'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'out', 'Blinky+NUCLEO-F756ZG.cbuild-run.yml'), NUCLEO_RUN);
        const host: BuildInfoHost = { ...world.host, workspaceFolders: () => [ws], findFiles: async (g) => walkGlob(ws, g) };
        const h = new BuildInfoHandler(host, { timeoutMs: 5000, workspaceRoot: () => ws });
        const listed = await h.handleListBuildArtifacts({});
        assert.match(listed, /^Build: target NUCLEO-F756ZG, device STMicroelectronics::STM32F756ZGTx, compiler AC6, board NUCLEO-F756ZG — from out\/Blinky\+NUCLEO-F756ZG\.cbuild-run\.yml\nNo build output yet: out\/Blinky\/NUCLEO-F756ZG\/Debug\/Blinky\.axf missing\. Build the solution/);
        assert.match(await h.handleGetMemoryUsage({}), /^Build: .*\nNo build output yet/);
        const slow = new BuildInfoHandler({ ...host, findFiles: () => new Promise(resolve => setTimeout(() => resolve([]), 500)) }, { timeoutMs: 5000 });
        assert.match(await slow.handleListBuildArtifacts({ timeoutMs: 100 }), /^list_build_artifacts timed out after 100 ms\./);
        const broken = new BuildInfoHandler({ ...host, findFiles: async () => { throw new Error('disk on fire'); } }, { timeoutMs: 5000 });
        assert.strictEqual(await broken.handleListBuildArtifacts({}), 'list_build_artifacts failed: disk on fire');
    });
});
