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
import { parseQuery, tokenize } from '../core/packDocs/tokenizer';
import { detectHeading } from '../core/packDocs/headings';

suite('tokenizer', () => {
    test('identifiers expand into their parts and keep the whole', () => {
        assert.deepStrictEqual(tokenize('RCC_AHB2ENR1'), ['rcc_ahb2enr1', 'rcc', 'ahb2enr1']);
        assert.deepStrictEqual(tokenize('ck_pll1_q'), ['ck_pll1_q', 'ck', 'pll1']);
    });

    test('hex addresses match with and without 0x and underscores', () => {
        assert.deepStrictEqual(tokenize('0x4002_3800'), ['0x4002_3800', '0x40023800', '40023800']);
        assert.deepStrictEqual(tokenize('0x40023800'), ['0x40023800', '40023800']);
    });

    test('stop words and one-character tokens are dropped, case is folded', () => {
        assert.deepStrictEqual(tokenize('The bit GPIOAEN is set to 1 by r/w'), ['gpioaen']);
    });

    test('parseQuery keeps quoted phrases and the typed words', () => {
        const q = parseQuery('"IO port A clock" GPIOAEN RCC_AHB1ENR');
        assert.deepStrictEqual(q.phrases, ['io port a clock']);
        assert.ok(q.terms.includes('gpioaen') && q.terms.includes('rcc_ahb1enr') && q.terms.includes('ahb1enr') && q.terms.includes('port'));
        assert.ok(q.words.includes('GPIOAEN') && q.words.includes('port'));
    });
});

suite('headings', () => {
    test('prefers the first numbered heading on the page', () => {
        const text = '                    RM0456                      Reset and clock control (RCC)\n\n' +
            '          11.8.29     RCC AHB2 peripheral clock enable register 1 (RCC_AHB2ENR1)\n' +
            '                      Address offset: 0x08C\n';
        assert.strictEqual(detectHeading(text), '11.8.29 RCC AHB2 peripheral clock enable register 1 (RCC_AHB2ENR1)');
    });

    test('falls back to the running header and ignores table-of-contents dotted lines', () => {
        assert.strictEqual(detectHeading('XMC4700 / XMC4800\nXMC4000 Family\n1.2 Overview ............ 33\n'), 'XMC4700 / XMC4800');
        assert.strictEqual(detectHeading(''), '');
    });
});
