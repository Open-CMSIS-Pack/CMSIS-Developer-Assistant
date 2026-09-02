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

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { loadCoreSvd, resolveCoreSvd } from '../core/packDocs/coreSvd';
import { SvdSummary, dimIndices, findPeripheral, parseSvd, registersOf } from '../core/packDocs/svdLite';

const ROOT = path.join(__dirname, '..', '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const CORE_DIR = path.join(ASSETS, 'svd', 'core');

suite('coreSvd', () => {
    const index = JSON.parse(fs.readFileSync(path.join(CORE_DIR, 'index.json'), 'utf-8')) as { cores: Record<string, { file: string; arch: string }> };
    const summaries = new Map<string, { summary: SvdSummary; arch: string }>();
    for (const [core, info] of Object.entries(index.cores)) {
        const ref = resolveCoreSvd(ASSETS, core);
        assert.ok(ref?.exists, `${core}: resolveCoreSvd finds the shipped file`);
        summaries.set(core, { summary: loadCoreSvd(ref!), arch: info.arch });
    }

    const at = (s: SvdSummary, peripheral: string, register: string): number => {
        const p = findPeripheral(s, peripheral);
        assert.ok(p, `${s.device}: no peripheral ${peripheral}`);
        const r = registersOf(s, p).find(x => x.name === register);
        assert.ok(r, `${s.device}: ${peripheral} has no register ${register}`);
        return p.baseAddress + r.offset;
    };

    test('resolves csolution core names, pdsc aliases and the M0+ spelling', () => {
        assert.strictEqual(resolveCoreSvd(ASSETS, 'Cortex-M33')?.file, 'Cortex_M33.svd');
        assert.strictEqual(resolveCoreSvd(ASSETS, 'cortex-m0plus')?.file, 'Cortex_M0plus.svd');
        assert.strictEqual(resolveCoreSvd(ASSETS, 'Cortex-M0+')?.core, 'Cortex-M0+');
        assert.strictEqual(resolveCoreSvd(ASSETS, 'ARMv8MML')?.file, 'Cortex_M33.svd');
        assert.strictEqual(resolveCoreSvd(ASSETS, 'Cortex-A53'), undefined);
        assert.strictEqual(resolveCoreSvd(undefined, 'Cortex-M33'), undefined, 'no assets directory → no shipped SVD');
        assert.match(resolveCoreSvd(ASSETS, 'Cortex-M4')!.source, /^cmsis-pack-docs \(from ARM::CMSIS /);
    });

    test('every shipped core has the SCS registers at their architectural addresses, grouped for the panel', () => {
        for (const [core, { summary }] of summaries) {
            assert.strictEqual(summary.device, `${core} core peripherals (${index.cores[core].file})`);
            assert.strictEqual(at(summary, 'SCB', 'CPUID'), 0xE000ED00, core);
            assert.strictEqual(at(summary, 'SCB', 'AIRCR'), 0xE000ED0C, core);
            assert.strictEqual(at(summary, 'SCB', 'SHPR3'), 0xE000ED20, core);
            assert.strictEqual(at(summary, 'SysTick', 'CTRL'), 0xE000E010, core);
            assert.strictEqual(at(summary, 'NVIC', 'ISER0'), 0xE000E100, `${core}: dim arrays are expanded`);
            assert.strictEqual(at(summary, 'NVIC', 'IPR0'), 0xE000E400, core);
            assert.strictEqual(at(summary, 'DCB', 'DHCSR'), 0xE000EDF0, core);
            assert.strictEqual(at(summary, 'DWT', 'CTRL'), 0xE0001000, core);
            assert.strictEqual(findPeripheral(summary, 'SCB')!.groupName, 'System', core);
            assert.strictEqual(findPeripheral(summary, 'DWT')!.groupName, 'Debug', core);
        }
    });

    test('the fault registers carry descriptions on every core with configurable faults', () => {
        for (const [core, { summary, arch }] of summaries) {
            if (arch.startsWith('ARMv6') || arch.includes('Baseline')) { continue; }
            assert.strictEqual(at(summary, 'SCB', 'CFSR'), 0xE000ED28, core);
            const cfsr = registersOf(summary, findPeripheral(summary, 'SCB')!).find(r => r.name === 'CFSR')!;
            const invstate = cfsr.fields.find(f => f.name === 'INVSTATE');
            assert.ok(invstate && invstate.bitOffset === 17 && invstate.bitWidth === 1, `${core}: CFSR.INVSTATE at bit 17`);
            assert.match(invstate!.description ?? '', /Thumb bit/, `${core}: INVSTATE explains the usual cause`);
            assert.ok(cfsr.fields.every(f => f.description), `${core}: every CFSR bit is described`);
            // STAR-MC1's header models the breakpoint unit itself (BPU); everyone else gets the FPB supplement.
            assert.strictEqual(core === 'Star-MC1' ? at(summary, 'BPU', 'CTRL') : at(summary, 'FPB', 'FP_CTRL'), 0xE0002000, core);
            assert.strictEqual(at(summary, 'ITM', 'STIM0'), 0xE0000000, core);
        }
    });

    test('ARMv8-M cores expose the SAU, the CTI and the Non-secure aliases through derivedFrom', () => {
        for (const [core, { summary, arch }] of summaries) {
            if (!arch.startsWith('ARMv8')) { continue; }
            assert.strictEqual(at(summary, 'SAU', 'CTRL'), 0xE000EDD0, core);
            assert.strictEqual(at(summary, 'CTI', 'CTICONTROL'), 0xE0042000, core);
            const ns = findPeripheral(summary, 'SCB_NS')!;
            assert.strictEqual(ns.derivedFrom, 'SCB', core);
            assert.strictEqual(ns.groupName, 'System', core);
            assert.strictEqual(at(summary, 'SCB_NS', 'AIRCR'), 0xE002ED0C, core);
        }
    });

    test('no two peripherals of a file claim the same address and no fields overlap', () => {
        for (const [core, { summary }] of summaries) {
            const owners = new Map<number, string>();
            for (const p of summary.peripherals) {
                if (p.derivedFrom) { continue; }
                for (const r of p.registers) {
                    const address = p.baseAddress + r.offset;
                    assert.ok(!owners.has(address), `${core}: ${p.name}.${r.name} and ${owners.get(address)} share 0x${address.toString(16)}`);
                    owners.set(address, `${p.name}.${r.name}`);
                    const sorted = [...r.fields].sort((a, b) => a.bitOffset - b.bitOffset);
                    for (let i = 1; i < sorted.length; i++) {
                        assert.ok(sorted[i].bitOffset >= sorted[i - 1].bitOffset + sorted[i - 1].bitWidth, `${core}: ${p.name}.${r.name}: ${sorted[i].name} overlaps ${sorted[i - 1].name}`);
                    }
                }
            }
        }
    });
});

suite('svdLite dim arrays', () => {
    test('dimIndex ranges, lists and defaults', () => {
        assert.deepStrictEqual(dimIndices('1-3', 3), ['1', '2', '3']);
        assert.deepStrictEqual(dimIndices('A,B,C', 2), ['A', 'B']);
        assert.deepStrictEqual(dimIndices(undefined, 2), ['0', '1']);
    });

    test('a dim register expands into dimIncrement-spaced registers sharing the fields', () => {
        const xml = `<device><name>T</name><peripherals><peripheral><name>P</name><baseAddress>0x1000</baseAddress><registers>
            <register><dim>3</dim><dimIncrement>0x10</dimIncrement><dimIndex>1-3</dimIndex><name>MASK%s</name><description>Mask %s</description><addressOffset>0x4</addressOffset>
              <fields><field><name>IRQ</name><bitOffset>0</bitOffset><bitWidth>32</bitWidth></field></fields></register>
            <register><dim>2</dim><dimIncrement>4</dimIncrement><name>ISER</name><addressOffset>0x100</addressOffset></register>
            <register><name>CTRL</name><addressOffset>0x0</addressOffset></register>
        </registers></peripheral></peripherals></device>`;
        const s = parseSvd(xml, '/x/t.svd');
        const regs = s.peripherals[0].registers.map(r => `${r.name}@${r.offset.toString(16)}`);
        assert.deepStrictEqual(regs, ['MASK1@4', 'MASK2@14', 'MASK3@24', 'ISER0@100', 'ISER1@104', 'CTRL@0']);
        assert.strictEqual(s.peripherals[0].registers[1].description, 'Mask 2');
        assert.strictEqual(s.peripherals[0].registers[1].fields[0].name, 'IRQ');
    });
});
