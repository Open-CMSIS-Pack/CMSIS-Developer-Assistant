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
import { parseSvdXml, SvdDevice } from '../core/svdParser';
import {
    lookupAddress, matchName, parseAddress, renderAddressHit, renderPeripheral, renderPeripheralList, renderRegister,
} from '../core/svdLookup';

/**
 * The session-less half of lookup_peripheral / lookup_register: address
 * resolution, name suggestions and the capped renderings. Runs against the
 * hand-written fixture SVD.
 */
suite('SVD lookup', () => {

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const device: SvdDevice = parseSvdXml(fs.readFileSync(path.join(repoRoot, 'src', 'test', 'fixtures', 'test-device.svd'), 'utf8'));
    const names = device.peripherals.map(p => p.name);

    test('resolves an address to the peripheral and the register covering it', () => {
        const hit = lookupAddress(device, 0x40005400);
        assert.strictEqual(hit?.peripheral.name, 'I2C1');
        assert.strictEqual(hit?.register?.name, 'CR1');
        assert.strictEqual(hit?.offsetInRegister, 0);
        const apb1 = lookupAddress(device, 0x40023842);
        assert.strictEqual(apb1?.register?.name, 'APB1ENR');
        assert.strictEqual(apb1?.offsetInRegister, 2);
    });

    test('a derived peripheral inherits its parent address block and registers', () => {
        const hit = lookupAddress(device, 0x40020414);
        assert.strictEqual(hit?.peripheral.name, 'GPIOB');
        assert.strictEqual(hit?.register?.name, 'ODR');
    });

    test('a peripheral without address blocks spans its registers', () => {
        assert.strictEqual(lookupAddress(device, 0x4000003c)?.register?.name, 'CCR3');
        assert.strictEqual(lookupAddress(device, 0x40000024)?.register?.name, 'CNT');
        const gap = lookupAddress(device, 0x40000000);
        assert.strictEqual(gap?.peripheral.name, 'TIM2', 'the extent starts at the base address');
        assert.strictEqual(gap?.register, undefined, 'no register is defined below CNT');
        assert.strictEqual(lookupAddress(device, 0x40000044), null, 'past the last register is outside the extent');
    });

    test('an address inside a block but between registers names only the peripheral', () => {
        const hit = lookupAddress(device, 0x40023810);
        assert.strictEqual(hit?.peripheral.name, 'RCC');
        assert.strictEqual(hit?.register, undefined);
    });

    test('an address outside every peripheral is null, and the rendering says where to go', () => {
        assert.strictEqual(lookupAddress(device, 0x20000000), null);
        assert.match(renderAddressHit(0x20000000, null, device.name), /not inside any peripheral.*SRAM region \(0x20000000–0x3fffffff\).*read_memory/s);
    });

    test('parseAddress accepts 0x, h-suffix and decimal', () => {
        assert.strictEqual(parseAddress('0x40005400'), 0x40005400);
        assert.strictEqual(parseAddress('0x4000_5400'), 0x40005400);
        assert.strictEqual(parseAddress('40005400h'), 0x40005400);
        assert.strictEqual(parseAddress('1024'), 1024);
        assert.strictEqual(parseAddress('RCC'), null);
    });

    test('matchName: exact is case-insensitive, otherwise prefix, substring, then a few edits', () => {
        assert.deepStrictEqual(matchName(names, 'gpioa'), { exact: 'GPIOA', suggestions: [] });
        assert.deepStrictEqual(matchName(names, 'GPI').suggestions, ['GPIOA', 'GPIOB']);
        assert.deepStrictEqual(matchName(names, 'I2C').suggestions, ['I2C1']);
        assert.deepStrictEqual(matchName(names, 'RCX').suggestions, ['RCC']);
        assert.deepStrictEqual(matchName(names, 'GPIOAX').suggestions, ['GPIOA', 'GPIOB'], 'a long query may be two edits away; nearer first');
        assert.deepStrictEqual(matchName(['GPIOA', 'GPIOB'], 'GPIOCC').suggestions, ['GPIOA', 'GPIOB']);
        assert.deepStrictEqual(matchName(names, 'zzzzzz').suggestions, []);
        assert.deepStrictEqual(matchName(names, '   ').suggestions, []);
    });

    test('the peripheral list is capped with a filter hint', () => {
        const out = renderPeripheralList(device, { max: 2 });
        assert.match(out, /TESTDEVICE: 5 peripherals/);
        assert.match(out, /RCC\s+@ 0x40023800\s+2 regs\s+Reset and clock control/);
        assert.match(out, /… 3 more — narrow with filter/);
        assert.match(renderPeripheralList(device, { filter: 'GPIO' }), /2 peripherals starting with 'GPIO'/);
    });

    test('a register map shows offsets, absolute addresses and access, capped', () => {
        const rcc = device.peripherals[0];
        const out = renderPeripheral(rcc);
        assert.match(out, /=== RCC @ 0x40023800 ===/);
        assert.match(out, /address blocks: 0x40023800\+0x400 \(registers\)/);
        assert.match(out, /APB1ENR\s+\+0x040 = 0x40023840\s+rw\s+APB1 peripheral clock enable register/);
        assert.match(out, /CR\s+\+0x000 = 0x40023800\s+read-write/);
        const capped = renderPeripheral(device.peripherals[3], { maxRegisters: 2 });
        assert.match(capped, /… 3 more — narrow with filter/);
        assert.match(renderPeripheral(device.peripherals[3], { filter: 'CCR' }), /4 registers starting with 'CCR'/);
    });

    test('a register rendering lists fields in bit order with enumerated values', () => {
        const rcc = device.peripherals[0];
        const out = renderRegister(rcc, rcc.registers[1]);
        assert.match(out, /=== RCC\.APB1ENR @ 0x40023840 \(offset 0x040, 32 bits, read-write\) ===/);
        assert.match(out, /reset value: 0x00000000/);
        assert.match(out, /\[0\]\s+TIM2EN\s+TIM2 clock enable\s+\{0=Disabled, 1=Enabled\}/);
        assert.match(out, /\[21\]\s+I2C1EN/);
        assert.match(out, /read_peripheral_register \{ peripheral: 'RCC', register: 'APB1ENR' \}/);
        const cr = renderRegister(rcc, rcc.registers[0]);
        assert.match(cr, /\[1\]\s+HSIRDY\s+read-only\s+Internal high-speed clock ready/);
    });

    test('an address hit renders the register and the next call', () => {
        const out = renderAddressHit(0x40023840, lookupAddress(device, 0x40023840), device.name);
        assert.match(out, /^0x40023840 = RCC\.APB1ENR — offset 0x040 in RCC @ 0x40023800: APB1 peripheral clock enable register/);
        assert.match(out, /lookup_register \{ peripheral: 'RCC', register: 'APB1ENR' \}/);
    });
});
