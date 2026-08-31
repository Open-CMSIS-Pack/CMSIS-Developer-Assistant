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
import { buildIndex, scorePages } from '../core/packDocs/bm25Index';
import { detectHeading } from '../core/packDocs/headings';
import { DocRef } from '../core/packDocs/pdscBooks';
import { LoadedDoc, PageRecord } from '../core/packDocs/pageStore';
import { isTocLike, makeSnippet, matchRegex, searchLoaded } from '../core/packDocs/search';
import { parsePageRange, renderPages, renderSearch } from '../core/packDocs/render';

function doc(id: string, category?: 'manual' | 'overview'): DocRef {
    return { id, title: id, category, scope: 'device', pack: 'V::P@1.0.0', packId: { vendor: 'V', name: 'P', version: '1.0.0' }, source: 'pack', path: `/x/${id}.pdf`, cached: true, indexed: true };
}

function pagesOf(texts: string[]): PageRecord[] {
    return texts.map((text, i) => ({ p: i + 1, heading: detectHeading(text), text }));
}

function loaded(ref: DocRef, texts: string[]): LoadedDoc {
    const pages = pagesOf(texts);
    ref.pages = pages.length;
    return {
        doc: ref,
        meta: { version: 1, docId: ref.id, file: ref.path!, size: 1, mtimeMs: 1, sha256: '', pageCount: pages.length, extractor: 'test', extractMs: 0, createdAt: '' },
        index: buildIndex(ref.id, pages),
        pages: () => pages,
    };
}

const RM_PAGES = [
    'RM-TEST Contents\n6.3.10 RCC AHB1 peripheral clock enable register (RCC_AHB1ENR) . . . . . . . 2\n6.3.11 RCC AHB2 peripheral clock enable register (RCC_AHB2ENR) . . . . . . . 3\n8.4.1 GPIO port mode register (GPIOx_MODER) . . . . . . . . 4\nGPIOAEN . . . . . . . . . . . 2\nGPIOBEN . . . . . . . . . . . 2\n',
    'RM-TEST Reset and clock control\n1 Introduction\nThe RCC manages the clocks of the device. Many peripherals are clocked from AHB1 and APB1.',
    'RM-TEST Reset and clock control\n6.3.10 RCC AHB1 peripheral clock enable register (RCC_AHB1ENR)\nAddress offset: 0x30\nReset value: 0x0010 0000\nBit 0 GPIOAEN: IO port A clock enable\n0: IO port A clock disabled\n1: IO port A clock enabled\nBit 1 GPIOBEN: IO port B clock enable',
    'RM-TEST Reset and clock control\n6.3.11 RCC AHB2 peripheral clock enable register (RCC_AHB2ENR)\nAddress offset: 0x34\nBit 7 OTGFSEN: USB OTG FS clock enable\nThe base address of RCC is 0x4002_3800.',
    'RM-TEST General-purpose I/Os (GPIO)\n8.4.1 GPIO port mode register (GPIOx_MODER)\nBits 2y:2y+1 MODER[1:0]: Port x configuration bits\nBefore using a port, enable its clock: GPIOAEN in RCC_AHB1ENR.',
    ...Array.from({ length: 30 }, (_, i) => `RM-TEST Filler chapter\n9.${i + 1} Some other peripheral ${i}\nNothing about clocks here, only timers and DMA streams number ${i}.`),
];

suite('bm25 + search', () => {
    test('the heading is an indexed field: a page whose body never spells the term is still found', () => {
        // The register page's body speaks of bits; only its heading names the register.
        const pages = pagesOf([
            'RM-TEST Contents\n1 Overview . . . . . . . 2\n',
            'RM-TEST Power control\n5.4.1 PWR control register 1 (PWR_CR1)\nBits 31:9 Reserved\nBit 8 DBP: Disable backup domain write protection\nBit 4 PVDE: Programmable voltage detector enable',
            'RM-TEST Power control\n5.4.2 PWR control status register 1 (PWR_CSR1)\nBit 13 ACTVOS: Voltage level ready\nBit 4 PVDO: Programmable voltage detector output',
            ...Array.from({ length: 20 }, (_, i) => `RM-TEST Filler\n9.${i + 1} Timer ${i}\nCounter register bits and prescaler values ${i}.`),
        ]);
        const ix = buildIndex('rm', pages);
        assert.strictEqual(ix.version, 2);
        assert.ok(ix.headingPostings?.['pwr_cr1'], 'heading tokens are indexed');
        // A description query (no register name at all) prefers the pages whose
        // heading says it over the filler pages that repeat "register" in the body.
        const described = scorePages([ix], ['control', 'register'], { limit: 3 });
        assert.deepStrictEqual(described.slice(0, 2).map(h => h.page).sort(), [2, 3]);
        // The mechanism itself: a term that occurs only in the heading field is a candidate.
        const explicit = buildIndex('x', [
            { heading: 'PWR control register 1 (PWR_CR1)', text: 'Bits 31:9 Reserved. Bit 8 DBP: disable backup domain write protection.' },
            { heading: 'Timers', text: 'Counter and prescaler.' },
        ]);
        assert.ok(!explicit.postings['pwr_cr1'] && explicit.headingPostings?.['pwr_cr1']);
        const hits = scorePages([explicit], ['pwr_cr1'], { limit: 3 });
        assert.strictEqual(hits[0]?.page, 1, 'a heading-only match is a candidate');
        assert.deepStrictEqual(hits[0].matched, ['pwr_cr1']);
        assert.strictEqual(scorePages([explicit], ['pwr_cr1'], { limit: 3, headingWeight: 0 }).length, 0, 'headingWeight 0 is the old body-only ranking');
        const rm = loaded(doc('p/rm', 'manual'), pages.map(p => p.text));
        assert.strictEqual(searchLoaded([rm], 'PWR_CR1', 3).hits[0].page, 2);
        assert.match(searchLoaded([rm], 'PWR_CR1', 3).hits[0].heading, /PWR_CR1/);
    });

    test('expansion terms find pages the typed words miss, at lower weight, without gating the all-terms boost', () => {
        const rm = loaded(doc('p/rm', 'manual'), [
            'RM-TEST Contents\n1 Overview . . . . . . . 2\n',
            'RM-TEST USART\n30.1 Universal synchronous asynchronous receiver transmitter introduction\nThe interface supports full-duplex exchange.',
            'RM-TEST Timers\n20.1 Timer overview\nCounter and prescaler.',
        ]);
        const plain = searchLoaded([rm], 'USART1', 5);
        assert.strictEqual(plain.hits.length, 0, 'the manual never writes USART1');
        const expanded = searchLoaded([rm], 'USART1', 5, undefined, { expansions: { universal: 0.5, receiver: 0.5, transmitter: 0.5 } });
        assert.strictEqual(expanded.hits[0]?.page, 2);
        // With two typed terms present on a page, the all-terms boost still applies even though no expansion matched.
        const two = searchLoaded([rm], 'counter prescaler', 5, undefined, { expansions: { nonexistent: 0.5 } });
        const single = searchLoaded([rm], 'counter', 5);
        assert.ok(two.hits[0].score > single.hits[0].score * 1.4, 'all typed terms matched → boosted');
    });

    test('scorePages ranks the page that mentions all terms first', () => {
        const ix = buildIndex('rm', pagesOf(RM_PAGES));
        const hits = scorePages([ix], ['gpioaen', 'rcc_ahb1enr'], { limit: 5 });
        // Pages 1 (contents), 3 and 5 carry both terms and get the all-terms boost; BM25's
        // length normalisation orders them, the heading boost and TOC penalty in searchLoaded settle it.
        assert.deepStrictEqual(hits.slice(0, 3).map(h => h.page).sort(), [1, 3, 5]);
        assert.deepStrictEqual(hits[0].matched.sort(), ['gpioaen', 'rcc_ahb1enr']);
        assert.ok(hits.slice(3).every(h => h.matched.length === 1), 'single-term pages rank below');
        const rm = loaded(doc('p/rm', 'manual'), RM_PAGES);
        assert.strictEqual(searchLoaded([rm], 'GPIOAEN RCC_AHB1ENR', 3).hits[0].page, 3, 'heading boost puts the register page first');
    });

    test('hex addresses are found however they are spelled', () => {
        const ix = buildIndex('rm', pagesOf(RM_PAGES));
        assert.strictEqual(scorePages([ix], ['0x40023800'], { limit: 1 })[0].page, 4);
        assert.strictEqual(scorePages([ix], ['40023800'], { limit: 1 })[0].page, 4);
    });

    test('searchLoaded boosts headings and phrases, marks snippets, and spans documents', () => {
        const rm = loaded(doc('p/rm', 'manual'), RM_PAGES);
        const ds = loaded(doc('p/ds'), ['DS-TEST Datasheet\nElectrical characteristics: GPIOAEN is not mentioned here but IO port A is.', 'DS-TEST Pinout\nPA0 PA1 PA2 IO port A pins']);
        const out = searchLoaded([rm, ds], 'GPIOA clock enable "IO port A clock"', 5);
        assert.ok(out.hits.length >= 2);
        assert.strictEqual(out.hits[0].doc.id, 'p/rm');
        assert.strictEqual(out.hits[0].page, 3);
        assert.match(out.hits[0].heading, /^6\.3\.10 RCC AHB1/);
        assert.match(out.hits[0].snippet, /«IO port A clock»/);
        assert.match(out.hits[0].snippet, /«enable»/);
        assert.deepStrictEqual(out.phrases, ['io port a clock']);
        const text = renderSearch('GPIOA clock enable', out.hits, { resolution: 'Target: test', indexedNow: [], skipped: [], searched: [rm.doc, ds.doc], web: [], ms: out.ms });
        assert.match(text, /#1 p\/rm p\.3 §6\.3\.10 RCC AHB1/);
        assert.match(text, /Next: read_doc_pages \{ doc: 'p\/rm', pages: '3' \}/);
        assert.match(text, /Searched 2 documents \(37 pages\)/);
    });

    test('a query with no hits says so and suggests the manual spelling', () => {
        const rm = loaded(doc('p/rm', 'manual'), RM_PAGES);
        const out = searchLoaded([rm], 'quantum flux capacitor', 5);
        assert.strictEqual(out.hits.length, 0);
        const text = renderSearch('quantum flux capacitor', out.hits, { resolution: 'Target: test', indexedNow: [], skipped: [], searched: [rm.doc], web: [], ms: out.ms });
        assert.match(text, /No page contains the query terms/);
    });

    test('contents and index pages are demoted below the pages they point at', () => {
        assert.strictEqual(isTocLike(RM_PAGES[0]), true);
        assert.strictEqual(isTocLike(RM_PAGES[2]), false);
        const rm = loaded(doc('p/rm', 'manual'), RM_PAGES);
        const out = searchLoaded([rm], 'GPIOAEN', 5);
        assert.notStrictEqual(out.hits[0].page, 1, 'not the contents page listing GPIOAEN');
        const toc = out.hits.find(h => h.page === 1);
        assert.ok(toc && toc.score < out.hits[0].score / 2, 'contents page scored below half of the best hit');
    });

    test('makeSnippet centres on the densest cluster and collapses whitespace', () => {
        const text = 'a'.repeat(1000) + '\n\n   RCC_AHB1ENR    GPIOAEN   clock   enable ' + 'b'.repeat(1000);
        const s = makeSnippet(text, matchRegex(['GPIOAEN', 'clock'], []), 120);
        assert.ok(s.startsWith('…') && s.endsWith('…'));
        assert.match(s, /«GPIOAEN» «clock»/);
        assert.ok(s.length <= 140);
    });

    test('parsePageRange and renderPages respect the budget', () => {
        assert.deepStrictEqual(parsePageRange('519', 600), { pages: [519] });
        assert.deepStrictEqual(parsePageRange('519-521, 523', 600), { pages: [519, 520, 521, 523] });
        assert.deepStrictEqual(parsePageRange('599-605', 600), { pages: [599, 600] });
        assert.match((parsePageRange('700', 600) as { error: string }).error, /beyond the last page \(600\)/);
        assert.match((parsePageRange('x', 600) as { error: string }).error, /not a page number/);
        const rm = loaded(doc('p/rm', 'manual'), RM_PAGES);
        const text = renderPages(rm.doc, rm.pages().slice(2, 4), 120);
        assert.match(text, /^— p\/rm p\.3 §6\.3\.10 RCC AHB1 peripheral clock enable register \(RCC_AHB1ENR\) \(of 35\) —/);
        assert.match(text, /more chars\)/);
        assert.match(text, /p\.4 .* omitted: maxChars reached/);
    });
});
