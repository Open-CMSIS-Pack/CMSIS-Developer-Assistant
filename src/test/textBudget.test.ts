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
import { clipValue, shortenPath, truncateList } from '../core/textBudget';

suite('Text budget helpers', () => {

    test('clipValue leaves short values alone and states what it cut', () => {
        assert.strictEqual(clipValue('0x2000', 200), '0x2000');
        assert.strictEqual(clipValue('a'.repeat(205), 200), `${'a'.repeat(200)}… (+5 chars)`);
        assert.strictEqual(clipValue('abc', 0), 'abc', 'a non-positive limit disables clipping');
    });

    test('truncateList keeps the head and counts the rest', () => {
        assert.deepStrictEqual(truncateList([1, 2, 3], 5), { shown: [1, 2, 3], hidden: 0 });
        assert.deepStrictEqual(truncateList([1, 2, 3, 4], 2), { shown: [1, 2], hidden: 2 });
        assert.deepStrictEqual(truncateList([1, 2], 0), { shown: [1, 2], hidden: 0 });
    });

    test('shortenPath strips the containing workspace root and nothing else', () => {
        const roots = ['/Users/me/proj', '/Users/me/other/'];
        assert.strictEqual(shortenPath('/Users/me/proj/src/main.c', roots), 'src/main.c');
        assert.strictEqual(shortenPath('/Users/me/other/lib/x.c', roots), 'lib/x.c');
        assert.strictEqual(shortenPath('/Users/me/projects/src/main.c', roots), '/Users/me/projects/src/main.c',
            'a root must match on a path boundary');
        assert.strictEqual(shortenPath('/home/cache/arm/packs/CMSIS/core.c', roots), '/home/cache/arm/packs/CMSIS/core.c');
        assert.strictEqual(shortenPath('C:\\proj\\src\\main.c', ['C:\\proj']), 'src\\main.c');
        assert.strictEqual(shortenPath('/Users/me/proj', roots), '/Users/me/proj', 'the root itself is not shortened to nothing');
    });
});
