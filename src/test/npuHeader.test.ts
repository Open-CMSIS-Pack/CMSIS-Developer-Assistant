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
import { defaultPackRoot } from '../core/packDocs/cbuildRun';
import { loadNpuHeader, npuBaseFromSvd, parseNpuHeader, resolveNpuHeader } from '../core/packDocs/npuHeader';
import { SvdSummary } from '../core/packDocs/svdLite';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

suite('npuHeader', () => {
    test('NPU_REG offsets, array lengths and C bitfields (LSB first, reserved skipped, comments as descriptions)', () => {
        const text = fs.readFileSync(path.join(FIXTURES, 'ethosu_test_interface.h'), 'utf-8');
        const s = parseNpuHeader(text, '/x/ethosu_test_interface.h', 'Ethos-U55');
        assert.strictEqual(s.device, 'Ethos-U55 (ethosu_test_interface.h)');
        assert.strictEqual(s.peripherals.length, 1);
        const p = s.peripherals[0];
        assert.strictEqual(p.name, 'Ethos-U55');
        assert.strictEqual(p.groupName, 'NPU');
        assert.strictEqual(p.baseAddress, 0);
        assert.match(p.description!, /base address not in the driver header/);
        assert.deepStrictEqual(p.registers.map(r => `${r.name}@${r.offset}`), ['ID@0', 'STATUS@4', 'CMD@8', 'QBASE@16', 'BASEP_BASE@128', 'PMCR@384']);
        const id = p.registers[0];
        assert.deepStrictEqual(id.fields.map(f => `${f.name}[${f.bitOffset}+${f.bitWidth}]`), [
            'version_status[0+4]', 'version_minor[4+4]', 'version_major[8+4]', 'product_major[12+4]', 'arch_patch_rev[16+4]', 'arch_minor_rev[20+8]', 'arch_major_rev[28+4]',
        ]);
        assert.strictEqual(id.fields[5].description, 'This is the minor architecture version number, b in the architecture version a.b', 'a declaration split over two lines');
        const status = p.registers[1];
        assert.deepStrictEqual(status.fields.map(f => `${f.name}[${f.bitOffset}+${f.bitWidth}]`), [
            'state[0+1]', 'irq_raised[1+1]', 'bus_status[2+1]', 'reset_status[3+1]', 'cmd_parse_error[4+1]', 'cmd_end_reached[5+1]', 'pmu_irq_raised[6+1]',
            'wd_fault[7+1]', 'ecc_fault[8+1]', 'faulting_interface[11+1]', 'faulting_channel[12+4]', 'irq_history_mask[16+16]',
        ], 'reserved0 : 2 keeps its bits');
        assert.strictEqual(status.fields[1].description, 'Raw IRQ status, 0 = IRQ not raised, 1 = IRQ raised. IRQ is cleared using command', 'first comment line only');
        assert.deepStrictEqual(p.registers[2].fields.map(f => f.name), ['transition_to_running_state', 'clear_irq', 'clock_q_enable', 'power_q_enable', 'stop_request']);
        assert.strictEqual(p.registers[2].fields[2].description, undefined);
        assert.deepStrictEqual(p.registers[3].fields, [], 'QBASE has no struct in the fixture');
        assert.strictEqual(p.registers[4].description, '8 × 32-bit');
        assert.deepStrictEqual(p.registers[5].fields.map(f => `${f.name}[${f.bitOffset}+${f.bitWidth}]`), ['cnt_en[0+1]', 'event_cnt_rst[1+1]', 'cycle_cnt_rst[2+1]', 'mask_en[3+1]', 'num_event_cnt[11+5]']);
        assert.strictEqual(parseNpuHeader(text, '/x/h', 'Ethos-U85', 0x48102000).peripherals[0].baseAddress, 0x48102000);
    });

    test('npuBaseFromSvd finds an NPU peripheral by name', () => {
        const svd: SvdSummary = { file: 'x', peripherals: [
            { name: 'USART1', baseAddress: 0x40013800, registers: [], interrupts: [] },
            { name: 'ETHOS_U55', baseAddress: 0x48102000, registers: [], interrupts: [] },
            { name: 'NPU', baseAddress: 0x400E1000, registers: [], interrupts: [] },
        ] };
        assert.strictEqual(npuBaseFromSvd(svd, 'Ethos-U55'), 0x48102000);
        assert.strictEqual(npuBaseFromSvd(svd, 'Ethos-U85'), undefined, 'two NPU-like peripherals: no guessing');
        assert.strictEqual(npuBaseFromSvd({ file: 'x', peripherals: [{ name: 'NPU_HP', baseAddress: 0x400E1000, registers: [], interrupts: [] }] }, 'Ethos-U85'), 0x400E1000, 'a single generic NPU peripheral is trusted');
        assert.strictEqual(npuBaseFromSvd({ file: 'x', peripherals: [] }, 'Ethos-U55'), undefined);
        assert.strictEqual(npuBaseFromSvd(undefined, 'Ethos-U55'), undefined);
    });

    test('resolveNpuHeader picks the driver header per NPU from the installed pack (parsing skipped when absent)', function () {
        const root = defaultPackRoot();
        assert.match(resolveNpuHeader(root, 'Ethos-U65')!.file, /^ethosu(65|55)_interface\.h$/, 'U65 header, or the U55 map it shares');
        assert.strictEqual(resolveNpuHeader(root, 'ethos u85')!.file, 'ethosu85_interface.h');
        assert.strictEqual(resolveNpuHeader(root, 'Cortex-M55'), undefined);
        const ref = resolveNpuHeader(root, 'Ethos-U55')!;
        if (!ref.exists) { this.skip(); return; }
        const s = loadNpuHeader(ref, 0);
        const p = s.peripherals[0];
        assert.ok(p.registers.length > 150, `${p.registers.length} registers`);
        const id = p.registers.find(r => r.name === 'ID')!;
        assert.ok(id.fields.some(f => f.name === 'arch_major_rev' && f.bitOffset === 28));
        assert.ok(p.registers.find(r => r.name === 'STATUS')!.fields.some(f => f.name === 'irq_raised' && f.bitOffset === 1));
        assert.strictEqual(p.registers.find(r => r.name === 'BASEP_BASE')!.description, '8 × 32-bit');
        assert.strictEqual(loadNpuHeader(ref, 0), s, 'cached');
        const u85 = resolveNpuHeader(root, 'Ethos-U85')!;
        if (u85.exists) { assert.ok(loadNpuHeader(u85, 0).peripherals[0].registers.length > 150); }
    });
});
