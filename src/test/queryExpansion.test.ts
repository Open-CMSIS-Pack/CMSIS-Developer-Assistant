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
import { EXPANSION_WEIGHT, expandQuery } from '../core/packDocs/queryExpansion';
import { loadSvd } from '../core/packDocs/svdLite';

const svd = loadSvd(path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs', 'test.svd'));

suite('SVD query expansion', () => {
    test('a peripheral instance expands to its description words and type synonyms', () => {
        const { expansions, notes } = expandQuery('USART1', svd);
        for (const t of ['universal', 'synchronous', 'receiver', 'transmitter', 'usart']) {
            assert.strictEqual(expansions[t], EXPANSION_WEIGHT, `expected ${t}`);
        }
        assert.ok(!('usart1' in expansions), 'typed words are not expansions');
        assert.match(notes.join('\n'), /^USART1 \(peripheral\): /);
    });

    test('prose next to an identifier switches expansion off — the words already describe it', () => {
        assert.deepStrictEqual(expandQuery('USART1 baud rate', svd).expansions, {});
        assert.deepStrictEqual(expandQuery('RCC source control register', svd).expansions, {});
        assert.ok(Object.keys(expandQuery('RCC_APB2ENR GPIOAEN', svd).expansions).length > 0, 'several identifiers still expand');
    });

    test('register names are left alone — the heading field already finds them', () => {
        assert.deepStrictEqual(expandQuery('RCC_APB2ENR', svd).expansions, {});
        assert.deepStrictEqual(expandQuery('APB2ENR', svd).expansions, {});
    });

    test('a bare field name finds its register', () => {
        const { expansions, notes } = expandQuery('GPIOAEN', svd);
        assert.ok('rcc_ahb1enr' in expansions && 'port' in expansions, JSON.stringify(expansions));
        assert.match(notes[0], /GPIOAEN \(field of RCC_AHB1ENR\)/);
    });

    test('prose, quoted phrases and unknown identifiers expand to nothing', () => {
        assert.deepStrictEqual(expandQuery('clock enable for the port', svd).expansions, {});
        assert.deepStrictEqual(expandQuery('"USART1 baud"', svd).expansions, {});
        assert.deepStrictEqual(expandQuery('FOO_BAR', svd).expansions, {});
        assert.deepStrictEqual(expandQuery('USART1', undefined).expansions, {});
    });
});
