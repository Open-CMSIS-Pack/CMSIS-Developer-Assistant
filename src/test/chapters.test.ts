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
import { buildChapterIndex, chapterAcronyms, chapterOfPage } from '../core/packDocs/chapters';
import { detectHeading } from '../core/packDocs/headings';
import { PageRecord } from '../core/packDocs/pageStore';
import { acronymsFor, stripInstance, typeOf } from '../core/packDocs/peripheralAliases';

/** A small reference manual, the way pdftotext + detectHeading would deliver it. */
export const MANUAL_PAGES: string[] = [
    'Contents\n6 Reset and clock control (RCC) . . . . . . . 3\n23 Universal synchronous asynchronous receiver transmitter (USART/UART) . . . . 7\n',
    '1 Introduction\nThis manual describes the test MCU.',
    '6 Reset and clock control (RCC)\n6.1 Introduction\nThe RCC manages clocks.',
    '6.3.10 RCC APB2 peripheral clock enable register (RCC_APB2ENR)\nAddress offset: 0x44\nBit 4 USART1EN: USART1 clock enable',
    '6.3.12 RCC APB2 peripheral reset register (RCC_APB2RSTR)\nBit 4 USART1RST: USART1 reset',
    '13.2 Interrupt and exception vectors\nTable 46. Vector table\n37 USART1 USART1 global interrupt 0x000000D4\n28 TIM2 TIM2 global interrupt',
    '23 Universal synchronous asynchronous receiver transmitter (USART/UART)\n23.1 Introduction\nThe USART offers a flexible means',
    '23.7.1 Control register 1 (USART_CR1)\nAddress offset: 0x00\nBit 0 UE: USART enable',
    '23.7.5 Interrupt and status register (USART_ISR)\nBit 5 RXNE: Read data register not empty',
    '24 Low-power universal asynchronous receiver transmitter (LPUART)\n24.1 Introduction',
    '24.7.1 LPUART control register 1 (LPUART_CR1)\nBit 0 UE: LPUART enable',
    '25 General-purpose timers (TIM2/TIM3/TIM4/TIM5)\n25.1 Introduction',
    '25.4.1 TIMx control register 1 (TIMx_CR1)\nBit 0 CEN: Counter enable',
    '30 Cortex-M7 peripherals\nThe core peripherals.',
    '30.4 System timer, SysTick\nThe SysTick counts down.',
    '30.4.1 SysTick Control and Status Register\nSYST_CSR ENABLE bit 0',
    '30.5 Memory protection unit\nMPU regions.',
];

export function manualRecords(): PageRecord[] {
    return MANUAL_PAGES.map((text, i) => ({ p: i + 1, heading: detectHeading(text), text }));
}

suite('chapters', () => {
    test('chapter starts, ends and sections from headings; table-of-contents lines are ignored', () => {
        const pages = manualRecords();
        assert.match(pages[0].heading, /^6 Reset and clock control \(RCC\) \. /, 'the TOC line reaches the chapter index as a heading');
        const chapters = buildChapterIndex(pages);
        assert.deepStrictEqual(chapters.map(c => `${c.number}:${c.start}-${c.end}`), ['1:2-2', '6:3-5', '13:6-6', '23:7-9', '24:10-11', '25:12-13', '30:14-17']);
        const rcc = chapters.find(c => c.number === 6)!;
        assert.strictEqual(rcc.title, 'Reset and clock control (RCC)');
        assert.deepStrictEqual(rcc.acronyms, ['RCC']);
        // "6.1 Introduction" shares page 3 with the chapter heading, which is the page's one heading.
        assert.deepStrictEqual(rcc.sections.map(s => `${s.number}@${s.page}`), ['6.3.10@4', '6.3.12@5']);
        assert.strictEqual(rcc.sections[0].title, 'RCC APB2 peripheral clock enable register (RCC_APB2ENR)');
        const irq = chapters.find(c => c.number === 13)!;
        assert.strictEqual(irq.title, 'Interrupt and exception vectors', 'a chapter without its own heading page takes its first section');
        assert.deepStrictEqual(chapters.find(c => c.number === 23)!.acronyms, ['USART', 'UART']);
        assert.deepStrictEqual(chapters.find(c => c.number === 25)!.acronyms, ['TIM2', 'TIM3', 'TIM4', 'TIM5']);
        assert.strictEqual(chapterOfPage(chapters, 8)!.number, 23);
        assert.strictEqual(chapterOfPage(chapters, 1), undefined);
    });

    test('a chapter heading repeated in the contents resolves to the page before its first section', () => {
        const pages: PageRecord[] = [
            { p: 1, heading: '11 Reset and clock control (RCC)', text: 'contents without dot leaders' },
            { p: 2, heading: '12 General-purpose I/Os (GPIO)', text: 'contents' },
            { p: 40, heading: '11 Reset and clock control (RCC)', text: 'chapter start' },
            { p: 41, heading: '11.1 Introduction', text: '' },
            { p: 60, heading: '12 General-purpose I/Os (GPIO)', text: '' },
            { p: 61, heading: '12.1 Introduction', text: '' },
            { p: 70, heading: '', text: 'tail' },
        ];
        const chapters = buildChapterIndex(pages);
        assert.deepStrictEqual(chapters.map(c => `${c.number}:${c.start}-${c.end}`), ['11:40-59', '12:60-70']);
    });

    test('acronyms and aliases', () => {
        assert.deepStrictEqual(chapterAcronyms('Analog-to-digital converter (ADC12)'), ['ADC12']);
        assert.deepStrictEqual(chapterAcronyms('Inter-integrated circuit (I2C) interface'), ['I2C']);
        assert.deepStrictEqual(chapterAcronyms('Advanced-control timers (TIM1 and TIM8)'), ['TIM1', 'TIM8']);
        assert.deepStrictEqual(chapterAcronyms('USB on-the-go full-speed (OTG_FS)'), ['OTG_FS']);
        assert.deepStrictEqual(chapterAcronyms('Overview (no acronym here really)'), []);
        assert.strictEqual(stripInstance('USART1'), 'USART');
        assert.strictEqual(stripInstance('GPIOA'), 'GPIO');
        assert.strictEqual(stripInstance('TIM17'), 'TIM');
        assert.strictEqual(stripInstance('OTG_HS'), 'OTG_HS');
        assert.strictEqual(typeOf('UART')!.key, 'USART');
        assert.strictEqual(typeOf('usart3')!.key, 'USART');
        assert.strictEqual(typeOf('LPUART1')!.key, 'LPUART');
        assert.strictEqual(typeOf('GPIOA')!.key, 'GPIO');
        assert.strictEqual(typeOf('FDCAN1')!.key, 'CAN');
        assert.strictEqual(typeOf('CRU')!.key, 'RCC');
        assert.strictEqual(typeOf('XYZ'), undefined);
        assert.ok(acronymsFor('USART1').includes('UART') && acronymsFor('USART1').includes('USART1'));
    });
});
