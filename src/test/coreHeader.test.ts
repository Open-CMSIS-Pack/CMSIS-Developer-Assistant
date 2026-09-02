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
import { loadCoreHeader, parseCoreHeader, resolveCoreHeader } from '../core/packDocs/coreHeader';
import { defaultPackRoot } from '../core/packDocs/cbuildRun';
import { findPeripheral, registersOf } from '../core/packDocs/svdLite';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

suite('coreHeader', () => {
    test('structs, offsets, arrays, field macros, base addresses and non-secure aliases from a CMSIS-Core header', () => {
        const text = fs.readFileSync(path.join(FIXTURES, 'core_cmtest.h'), 'utf-8');
        const s = parseCoreHeader(text, '/x/core_cmtest.h', 'Cortex-M33');
        assert.strictEqual(s.device, 'Cortex-M33 core peripherals (core_cmtest.h)');
        assert.deepStrictEqual(s.peripherals.map(p => `${p.name}@${p.baseAddress.toString(16)}`), ['SCB@e000ed00', 'SysTick@e000e010', 'NVIC@e000e100', 'DWT@e0001000', 'DCB@e000edf0', 'SCB_NS@e002ed00']);
        const scb = findPeripheral(s, 'SCB')!;
        assert.strictEqual(scb.groupName, 'System');
        assert.strictEqual(scb.description, 'System Control Block');
        assert.deepStrictEqual(scb.registers.map(r => `${r.name}@${r.offset}`), ['CPUID@0', 'ICSR@4', 'VTOR@8', 'AIRCR@12', 'SHPR@24']);
        assert.strictEqual(scb.registers[0].description, 'CPUID Base Register (R/)');
        assert.strictEqual(scb.registers[4].description, 'System Handlers Priority Registers (4-7, 8-11, 12-15) 12 × 8-bit (R/W)');
        assert.deepStrictEqual(scb.registers[0].fields, [{ name: 'REVISION', bitOffset: 0, bitWidth: 4 }, { name: 'IMPLEMENTER', bitOffset: 24, bitWidth: 8 }]);
        assert.deepStrictEqual(scb.registers[1].fields.map(f => `${f.name}[${f.bitOffset}+${f.bitWidth}]`), ['VECTACTIVE[0+9]', 'PENDSVCLR[27+1]']);
        assert.deepStrictEqual(scb.registers[3].fields.map(f => f.name), ['SYSRESETREQ', 'VECTKEY']);
        assert.deepStrictEqual(scb.registers[2].fields, [], 'no macros for VTOR in the fixture');

        const nvic = findPeripheral(s, 'NVIC')!;
        assert.deepStrictEqual(nvic.registers.map(r => `${r.name}@${r.offset}`), ['ISER@0', 'ICER@128', 'IPR@256']);
        assert.strictEqual(nvic.registers[2].description, 'Interrupt Priority Register (8Bit wide) 496 × 8-bit (R/W)');

        const dwt = findPeripheral(s, 'DWT')!;
        assert.strictEqual(dwt.groupName, 'Debug');
        assert.deepStrictEqual(dwt.registers.map(r => `${r.name}@${r.offset}`), ['CTRL@0', 'COMP0@32', 'FUNCTION0@40', 'COMP1@48', 'FUNCTION1@56']);
        assert.deepStrictEqual(dwt.registers.find(r => r.name === 'FUNCTION0')!.fields, [{ name: 'MATCH', bitOffset: 0, bitWidth: 4 }], 'DWT_FUNCTION_MATCH lands on FUNCTION0');
        assert.deepStrictEqual(findPeripheral(s, 'SysTick')!.registers[0].fields, [{ name: 'ENABLE', bitOffset: 0, bitWidth: 1 }]);
        assert.deepStrictEqual(findPeripheral(s, 'DCB')!.registers[0].fields, [{ name: 'C_DEBUGEN', bitOffset: 0, bitWidth: 1 }]);

        const ns = findPeripheral(s, 'SCB_NS')!;
        assert.strictEqual(ns.derivedFrom, 'SCB');
        assert.strictEqual(ns.description, 'System Control Block (non-secure alias)');
        assert.deepStrictEqual(registersOf(s, ns).map(r => r.name), ['CPUID', 'ICSR', 'VTOR', 'AIRCR', 'SHPR']);
        assert.strictEqual(findPeripheral(s, 'APSR'), undefined, 'unions (register views) are not peripherals');
    });

    test('resolveCoreHeader maps cores to headers in the installed ARM::CMSIS pack (skipped when the pack is absent)', function () {
        const root = defaultPackRoot();
        const ref = resolveCoreHeader(root, 'Cortex-M33');
        assert.ok(ref, 'Cortex-M33 has a header');
        assert.strictEqual(ref!.file, 'core_cm33.h');
        assert.strictEqual(resolveCoreHeader(root, 'Cortex-M0+')!.file, 'core_cm0plus.h');
        assert.strictEqual(resolveCoreHeader(root, 'ARMV81MML')!.file, 'core_cm55.h');
        assert.strictEqual(resolveCoreHeader(root, 'Cortex-A53'), undefined);
        if (!ref!.exists) { this.skip(); return; }
        assert.match(ref!.pack, /^ARM::CMSIS@\d/);
        const s = loadCoreHeader(ref!, 'Cortex-M33');
        const names = s.peripherals.map(p => p.name);
        for (const n of ['SCB', 'NVIC', 'SysTick', 'MPU', 'SAU', 'FPU', 'DWT', 'ITM', 'TPIU', 'DCB', 'DIB', 'SCB_NS']) { assert.ok(names.includes(n), n); }
        const scb = findPeripheral(s, 'SCB')!;
        assert.strictEqual(scb.baseAddress, 0xE000ED00);
        assert.ok(scb.registers.find(r => r.name === 'AIRCR')!.fields.some(f => f.name === 'SYSRESETREQ' && f.bitOffset === 2));
        assert.ok(findPeripheral(s, 'DCB')!.registers.find(r => r.name === 'DHCSR')!.fields.some(f => f.name === 'C_HALT'));
        assert.strictEqual(loadCoreHeader(ref!, 'Cortex-M33'), s, 'cached');
    });
});
