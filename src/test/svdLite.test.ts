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
import * as path from 'path';
import { findSvd, loadPdsc } from '../core/packDocs/pdscBooks';
import { coreFromSvdCpu, findPeripheral, groupOf, loadSvd, parseSvd, peripheralsByGroup, registersOf, svdNumber } from '../core/packDocs/svdLite';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

suite('svdLite', () => {
    test('parses peripherals, registers, clusters, fields in every bit-range form, and interrupts', () => {
        const svd = loadSvd(path.join(FIXTURES, 'test.svd'));
        assert.strictEqual(svd.device, 'TESTMCU');
        assert.deepStrictEqual(svd.peripherals.map(p => p.name), ['RCC', 'USART1', 'USART2', 'LPUART1', 'TIM2', 'GPIOA']);
        const rcc = findPeripheral(svd, 'rcc')!;
        assert.strictEqual(rcc.baseAddress, 0x40023800);
        assert.strictEqual(rcc.groupName, 'RCC');
        const apb2 = rcc.registers.find(r => r.name === 'APB2ENR')!;
        assert.strictEqual(apb2.offset, 0x44);
        assert.deepStrictEqual(apb2.fields.map(f => [f.name, f.bitOffset, f.bitWidth]), [['TIM1EN', 0, 1], ['USART1EN', 4, 1]]);
        assert.deepStrictEqual(rcc.registers.find(r => r.name === 'APB2RSTR')!.fields[0], { name: 'USART1RST', bitOffset: 4, bitWidth: 1 });
        const usart1 = findPeripheral(svd, 'USART1')!;
        assert.strictEqual(usart1.description, 'Universal synchronous asynchronous receiver transmitter');
        assert.deepStrictEqual(usart1.interrupts, [{ name: 'USART1', value: 37, description: 'USART1 global interrupt' }]);
        assert.deepStrictEqual(usart1.registers.map(r => `${r.name}@${r.offset}`), ['CR1@0', 'CR2@4', 'ISR@28']);
        assert.strictEqual(usart1.registers[0].fields[0].description, 'USART enable');
        const tim2 = findPeripheral(svd, 'TIM2')!;
        assert.deepStrictEqual(tim2.registers.map(r => `${r.name}@${r.offset}`), ['CR1@0', 'CCMR.OUT@24'], 'cluster registers are flattened with their offset');
    });

    test('derivedFrom peripherals inherit registers and group; groups list every instance', () => {
        const svd = loadSvd(path.join(FIXTURES, 'test.svd'));
        const usart2 = findPeripheral(svd, 'USART2')!;
        assert.strictEqual(usart2.derivedFrom, 'USART1');
        assert.strictEqual(usart2.baseAddress, 0x40004400);
        assert.deepStrictEqual(usart2.registers, []);
        assert.deepStrictEqual(registersOf(svd, usart2).map(r => r.name), ['CR1', 'CR2', 'ISR']);
        assert.strictEqual(groupOf(svd, usart2), 'USART');
        assert.deepStrictEqual(usart2.interrupts, [{ name: 'USART2', value: 38 }]);
        const groups = peripheralsByGroup(svd);
        assert.deepStrictEqual(groups.get('USART')!.map(p => p.name), ['USART1', 'USART2']);
        assert.deepStrictEqual([...groups.keys()], ['RCC', 'USART', 'LPUART', 'TIM', 'GPIO']);
        assert.strictEqual(loadSvd(path.join(FIXTURES, 'test.svd')), svd, 'cached by path and mtime');
    });

    test('the <cpu> block and its core name', () => {
        const s = parseSvd('<device><name>X</name><cpu><name>CM0PLUS</name><revision>r0p1</revision></cpu><peripherals/></device>', '/x.svd');
        assert.deepStrictEqual(s.cpu, { name: 'CM0PLUS', revision: 'r0p1' });
        assert.strictEqual(parseSvd('<device><name>X</name><peripherals/></device>', '/x.svd').cpu, undefined);
        assert.strictEqual(coreFromSvdCpu('CM0PLUS'), 'Cortex-M0+');
        assert.strictEqual(coreFromSvdCpu('CM0+'), 'Cortex-M0+');
        assert.strictEqual(coreFromSvdCpu('CM4'), 'Cortex-M4');
        assert.strictEqual(coreFromSvdCpu('CM33'), 'Cortex-M33');
        assert.strictEqual(coreFromSvdCpu('CM35P'), 'Cortex-M35P');
        assert.strictEqual(coreFromSvdCpu('Cortex-M7'), 'Cortex-M7');
        assert.strictEqual(coreFromSvdCpu('SC300'), 'SC300');
        assert.strictEqual(coreFromSvdCpu('STAR-MC1'), 'Star-MC1');
        assert.strictEqual(coreFromSvdCpu('ARMV8MML'), 'ARMV8MML');
        assert.strictEqual(coreFromSvdCpu('CA9'), undefined);
        assert.strictEqual(coreFromSvdCpu(undefined), undefined);
    });

    test('svdNumber accepts hex, decimal, binary and #-binary', () => {
        assert.strictEqual(svdNumber('0x40013800'), 0x40013800);
        assert.strictEqual(svdNumber('0X1C'), 28);
        assert.strictEqual(svdNumber('37'), 37);
        assert.strictEqual(svdNumber('#0101'), 5);
        assert.strictEqual(svdNumber('0b11'), 3);
        assert.strictEqual(svdNumber('12UL'), 12);
        assert.strictEqual(svdNumber('x'), undefined);
        assert.strictEqual(svdNumber(undefined), undefined);
    });

    test('findSvd walks the device chain of the pdsc, most specific level first', () => {
        const xmc = loadPdsc(path.join(FIXTURES, 'Infineon.XMC4000_DFP.pdsc'), { vendor: 'Infineon', name: 'XMC4000_DFP', version: '2.14.0' });
        const ref = findSvd(xmc, 'XMC4700-F144x2048')!;
        assert.strictEqual(ref.rel, 'SVD/XMC4700.svd');
        assert.strictEqual(ref.path, path.join(FIXTURES, 'SVD', 'XMC4700.svd'));
        assert.strictEqual(ref.exists, false);
        const stm = loadPdsc(path.join(FIXTURES, 'Keil.STM32F7xx_DFP.pdsc'), { vendor: 'Keil', name: 'STM32F7xx_DFP', version: '3.0.0' });
        assert.strictEqual(findSvd(stm, 'STM32F756ZGTx')!.rel, 'CMSIS/SVD/STM32F756.svd', 'inherited from the subFamily');
        assert.strictEqual(findSvd(stm, 'nonexistent'), undefined, 'an unknown device falls back to family level only, and this SVD sits at subFamily level');
        assert.strictEqual(findSvd(stm, 'STM32F756ZGTx', 'cm7'), undefined, 'a Pname no <debug> carries');
    });
});
