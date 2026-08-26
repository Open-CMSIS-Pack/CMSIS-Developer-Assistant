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
import {
    applyTargetSelection, formatTargetChoices, listTargetTypes, parseTargetRef, resolveTargetSelection,
    solutionDisplayName, targetMatches,
} from '../core/cmsisTarget';

const TWO_TARGETS = `
solution:
  description: two targets  # comment
  target-types:
    - type: HE
      device: AlifSemiconductor::AE722F80F55D5LS:M55_HE
      target-set:
        - set:
          debugger:
            name: CMSIS-DAP@pyOCD
            protocol: swd
    - type: "HP"
      board: AppKit-E7
      target-set:
        - set: debug
          debugger:
            name: JLink
        - set: release
          images:
            - project-context: app.Release
      variables:
        - Board-Layer: layer.clayer.yml
  build-types:
    - type: Debug
      debug: on
  projects:
    - project: app.cproject.yml
`;

suite('cmsis_action target helpers', () => {

    test('parseTargetRef reads type and type@set', () => {
        assert.deepStrictEqual(parseTargetRef('MPS3'), { type: 'MPS3' });
        assert.deepStrictEqual(parseTargetRef(' HP@debug '), { type: 'HP', set: 'debug' });
        assert.deepStrictEqual(parseTargetRef('HP@'), { type: 'HP', set: '' }, 'type@ names the unnamed set');
        assert.strictEqual(parseTargetRef(''), undefined);
        assert.strictEqual(parseTargetRef('@debug'), undefined);
        assert.strictEqual(parseTargetRef(undefined), undefined);
    });

    test('targetMatches: a type-only request accepts any set, type@set is exact', () => {
        assert.ok(targetMatches('HP@debug', { type: 'HP' }));
        assert.ok(targetMatches('HP', { type: 'HP' }));
        assert.ok(targetMatches('HP@debug', { type: 'HP', set: 'debug' }));
        assert.ok(targetMatches('MPS3', { type: 'MPS3', set: '' }), 'the unnamed set is reported as the bare type');
        assert.ok(!targetMatches('HP@debug', { type: 'HP', set: 'release' }));
        assert.ok(!targetMatches('HE', { type: 'HP' }));
        assert.ok(!targetMatches(undefined, { type: 'HP' }));
        assert.ok(!targetMatches('', { type: 'HP' }));
    });

    test('listTargetTypes scans target-types with their sets and stops at build-types', () => {
        assert.deepStrictEqual(listTargetTypes(TWO_TARGETS), [
            { name: 'HE', sets: [''] },
            { name: 'HP', sets: ['debug', 'release'] },
        ]);
        assert.deepStrictEqual(listTargetTypes('solution:\n  projects: []\n'), []);
    });

    test('listTargetTypes reads the FVP fixture csolution', () => {
        const fixture = path.resolve(__dirname, '..', '..', '..', 'test', 'eval', 'fixtures', 'corstone-blinky', 'Blinky.csolution.yml');
        const types = listTargetTypes(fs.readFileSync(fixture, 'utf8'));
        assert.deepStrictEqual(types, [{ name: 'MPS3', sets: [''] }]);
    });

    test('resolveTargetSelection names what to store and explains what does not exist', () => {
        const types = listTargetTypes(TWO_TARGETS);
        assert.deepStrictEqual(resolveTargetSelection(types, { type: 'HP' }),
            { ok: true, type: 'HP', set: undefined, setIndex: undefined, name: 'HP' });
        assert.deepStrictEqual(resolveTargetSelection(types, { type: 'HP', set: 'release' }),
            { ok: true, type: 'HP', set: 'release', setIndex: 1, name: 'HP@release' });
        assert.deepStrictEqual(resolveTargetSelection(types, { type: 'HE', set: '' }),
            { ok: true, type: 'HE', set: '', setIndex: 0, name: 'HE' });
        const unknownType = resolveTargetSelection(types, { type: 'Nope' });
        assert.ok(!unknownType.ok && /'Nope' is not declared/.test(unknownType.reason));
        const unknownSet = resolveTargetSelection(types, { type: 'HP', set: 'prod' });
        assert.ok(!unknownSet.ok && /no target-set 'prod'.*debug, release/.test(unknownSet.reason));
        assert.strictEqual(formatTargetChoices(types), 'HE, HP@debug, HP@release');
    });

    test('solutionDisplayName mirrors the extension: relative, both extensions off, forward slashes', () => {
        assert.strictEqual(solutionDisplayName('/ws', '/ws/Blinky.csolution.yml'), 'Blinky');
        assert.strictEqual(solutionDisplayName('/ws', '/ws/RockPaperScissors/AppKit-E8_USB/SDS.csolution.yml'),
            'RockPaperScissors/AppKit-E8_USB/SDS');
    });

    test('applyTargetSelection creates, updates and preserves cmsis.json content', () => {
        const created = applyTargetSelection('', 'demo', 'HP', 1);
        assert.deepStrictEqual(JSON.parse(created), { targetSet: { demo: { activeTargetType: 'HP', HP: 1 } } });
        assert.ok(created.endsWith('\n'));

        const existing = [
            '{',
            '    // keep me',
            '    "force-update-rte": true,',
            '    "targetSet": {',
            '        "other/sol": { "activeTargetType": "MPS3" },',
            '        "demo": { "activeTargetType": "HE", "HP": 1 }',
            '    }',
            '}',
        ].join('\n');
        const typeOnly = applyTargetSelection(existing, 'demo', 'HP', undefined);
        assert.ok(typeOnly.includes('// keep me'), 'comments survive');
        assert.ok(/"other\/sol": \{ "activeTargetType": "MPS3" \}/.test(typeOnly), 'other solutions untouched');
        assert.ok(/"demo": \{ "activeTargetType": "HP", "HP": 1 \}/.test(typeOnly), 'a type-only request leaves the set index alone');

        const withSet = applyTargetSelection(existing, 'demo', 'HP', 0);
        assert.ok(/"demo": \{ "activeTargetType": "HP", "HP": 0 \}/.test(withSet));
    });
});
