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
 * get_peripheral_docs end to end: the synthetic SVD (fixtures/packdocs/test.svd)
 * against the small reference manual of chapters.test.ts, served through a
 * fake extractor so no poppler is needed.
 */

import * as assert from 'assert';
import { PackDocsHandler } from '../packDocsHandler';
import { MANUAL_PAGES } from './chapters.test';
import { FakeExtractor, World, buildWorld } from './packDocsHandler.test';

suite('get_peripheral_docs', () => {
    let world: World;
    let handler: PackDocsHandler;

    suiteSetup(() => {
        world = buildWorld();
        handler = new PackDocsHandler(world.host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(MANUAL_PAGES) });
    });

    test('USART1: chapters by type alias, register pages by token, RCC bits, vector, errata state', async () => {
        const text = await handler.handleGetPeripheralDocs({ peripheral: 'USART1', doc: 'test-rm' });
        assert.match(text, /^# USART1 — Universal synchronous asynchronous receiver transmitter\nTarget: device STMicroelectronics::STM32F756ZGTx[^\n]*; SVD CMSIS\/SVD\/test\.svd\n- base 0x40011000 · group USART · 3 registers · 1 interrupt\n/);
        assert.match(text, /## Chapters\n- stm32f7xx-dfp\/test-rm §23 Universal synchronous asynchronous receiver transmitter \(USART\/UART\) p\.7–9 \(type: USART, 2 sections\)\n/);
        assert.doesNotMatch(text, /§24 Low-power/, 'LPUART is another type');
        assert.match(text, /## Clock and reset[^\n]*\n- enable: RCC_APB2ENR\.USART1EN bit 4 — stm32f7xx-dfp\/test-rm p\.4 §6\.3\.10 RCC APB2 peripheral clock enable register \(RCC_APB2ENR\)\n- reset: RCC_APB2RSTR\.USART1RST bit 4 — stm32f7xx-dfp\/test-rm p\.5 §6\.3\.12[^\n]*\n- low-power: RCC_APB2LPENR\.USART1LPEN bit 4 — page not found\n/);
        assert.match(text, /## Interrupts \(SVD\)\n- USART1 = 37 \(USART1 global interrupt\) — stm32f7xx-dfp\/test-rm p\.6 §13\.2 Interrupt and exception vectors\n/);
        assert.match(text, /## Registers \(SVD → manual page\)\n- CR1 @0x00 Control register 1 — stm32f7xx-dfp\/test-rm p\.8 §23\.7\.1 Control register 1 \(USART_CR1\)\n- CR2 @0x04 — page not found \(usart_cr2, [^)]*\)\n- ISR @0x1C Interrupt and status register — stm32f7xx-dfp\/test-rm p\.9 §23\.7\.5 Interrupt and status register \(USART_ISR\)\n/);
        assert.match(text, /## Errata\n- no errata document in the target's set/);
        assert.match(text, /\nNext: read_doc_pages \{ doc: 'stm32f7xx-dfp\/test-rm', pages: '8' \}/);
        assert.ok(world.lines.some(l => /USART1 \(CMSIS\/SVD\/test\.svd\): 1 chapters, 2\/3 register pages, 3 clock bits, 1 irqs, 0 errata hits in 1 docs/.test(l)), 'trace');
    });

    test('a core peripheral matches a section title when no chapter names it', async () => {
        const text = await handler.handleGetPeripheralDocs({ peripheral: 'SysTick', doc: 'test-rm', aspects: ['chapters'] });
        assert.match(text, /^# SysTick — 24-bit system timer/);
        assert.match(text, /## Chapters\n- stm32f7xx-dfp\/test-rm §30\.4 System timer, SysTick p\.15 \(section of §30 Cortex-M7 peripherals\)\n- stm32f7xx-dfp\/test-rm §30\.4\.1 SysTick Control and Status Register p\.16 \(section of §30[^\n]*\)\n/);
        assert.match(text, /Next: read_doc_pages \{ doc: 'stm32f7xx-dfp\/test-rm', pages: '15' \}/);
        assert.doesNotMatch(text, /§30\.5|Memory protection/);
        assert.match(text, /## Arm documents for this peripheral\n(- [^\n]*\n)*- arm\/ddi0403-latest · arch/);
    });

    test('TIM2: instance-level chapter, TIMx register token, cluster register, derived USART2 inherits registers', async () => {
        const tim = await handler.handleGetPeripheralDocs({ peripheral: 'tim2', doc: 'test-rm' });
        assert.match(tim, /^# TIM2 — General purpose timer\n/);
        assert.match(tim, /- stm32f7xx-dfp\/test-rm §25 General-purpose timers \(TIM2\/TIM3\/TIM4\/TIM5\) p\.12–13 \(instance: TIM2, 1 sections\)/);
        assert.match(tim, /- CR1 @0x00 — stm32f7xx-dfp\/test-rm p\.13 §25\.4\.1 TIMx control register 1 \(TIMx_CR1\)\n- CCMR\.OUT @0x18 — page not found \(tim_ccmr_out, tim_out, [^)]*\)/);
        assert.match(tim, /- enable: RCC_APB1ENR\.TIM2EN bit 0 — page not found/);
        assert.match(tim, /- TIM2 = 28 — stm32f7xx-dfp\/test-rm p\.6/);

        const usart2 = await handler.handleGetPeripheralDocs({ peripheral: 'USART2', doc: 'test-rm', aspects: ['chapters', 'registers'] });
        assert.match(usart2, /- base 0x40004400 · group USART · 3 registers · 1 interrupt · derived from USART1\n/);
        assert.match(usart2, /§23 Universal synchronous[^\n]*\(type: USART/);
        assert.match(usart2, /- CR1 @0x00 Control register 1 — stm32f7xx-dfp\/test-rm p\.8/);
        assert.doesNotMatch(usart2, /## Clock|## Interrupts|## Errata/, 'aspects filter');
    });

    test('a type name lists the instances; unknown names list the groups; no SVD is reported', async () => {
        const uart = await handler.handleGetPeripheralDocs({ peripheral: 'UART', doc: 'test-rm' });
        assert.match(uart, /^No peripheral named 'UART' in CMSIS\/SVD\/test\.svd\.\nDid you mean \(type USART\): USART1, USART2, LPUART1\? Pass one instance name\.\nPeripherals by group \(6\): Arm core peripherals: [^;]*SCB[^;]*; GPIO: GPIOA; LPUART: LPUART1; RCC: RCC; TIM: TIM2; USART: USART1, USART2/);
        const nope = await handler.handleGetPeripheralDocs({ peripheral: 'XYZ', doc: 'test-rm' });
        assert.match(nope, /^No peripheral named 'XYZ'[^\n]*\nPeripherals by group/);
        // Another device of the subFamily inherits the fixture's subFamily-level SVD, which is not on disk:
        // vendor peripherals are unknown, but the core peripherals still come from the shipped core SVD.
        const noSvd = await handler.handleGetPeripheralDocs({ peripheral: 'USART1', device: 'STM32F756VGTx' });
        assert.match(noSvd, /^No peripheral named 'USART1' in Cortex_M7\.svd \(core SVD\)\.\n/);
        assert.match(noSvd, /System: [^\n]*SCB[^\n]*SysTick/, 'the core SVD is the device SVD, its groups are listed');
        const systick = await handler.handleGetPeripheralDocs({ peripheral: 'SysTick', device: 'STM32F756VGTx', doc: 'test-rm', aspects: ['chapters', 'registers'] });
        assert.match(systick, /^# SysTick — 24-bit system timer[^\n]*\n[^\n]*; SVD Cortex_M7\.svd \(core SVD\)\n- base 0xE000E010 · group System · 4 registers/);
        assert.match(systick, /- Note: device SVD CMSIS\/SVD\/STM32F756\.svd is not on disk — the core SVD Cortex_M7\.svd is the device SVD/);
        assert.match(systick, /## Arm documents for this peripheral\n(- [^\n]*\n)*- arm\/ddi0403-latest · arch · ARMv7-M Architecture Reference Manual — not fetched — fetch_doc \{ doc: 'arm\/ddi0403-latest' \}, then call again\n/);
        assert.match(systick, /- arm\/dui0646-latest · gug · Cortex-M7 Generic User Guide — not fetched/);
        assert.match(systick, /- arm\/ddi0489-latest · trm · Cortex-M7 Processor Technical Reference Manual — not fetched/);
        assert.match(systick, /- CTRL @0x00 [^\n]*— page not found/);
        assert.match(await handler.handleGetPeripheralDocs({ peripheral: '' }), /peripheral is required/);
    });
});
