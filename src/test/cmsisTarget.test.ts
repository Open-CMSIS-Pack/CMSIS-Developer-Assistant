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

/**
 * How CMSIS Solution 1.72.0 looks a cmsis.json key up (`CmsisSettingsJsonFile.get`):
 * the dotted key split at every '.', one level down per part.
 */
function extensionGet(json: unknown, dottedKey: string): unknown {
    let node = json;
    for (const key of dottedKey.split('.')) {
        if (node === null || typeof node !== 'object') {
            return undefined;
        }
        node = (node as Record<string, unknown>)[key];
    }
    return node;
}

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

    test('listTargetTypes reads the keys of an entry in any order', () => {
        const anyOrder = `
solution:
  target-types:
    - device: STM32U585AIIx
      type: B-U585I
      target-set:
        - debugger:
            name: ST-Link@pyOCD
          set: debug
        - images:
            - project-context: app.Release
          info: release build
          set: release
    - board: NUCLEO-F401RE
      target-set:
        - set:
      type: NUCLEO
  build-types:
    - type: Debug
`;
        const types = listTargetTypes(anyOrder);
        assert.deepStrictEqual(types, [
            { name: 'B-U585I', sets: ['debug', 'release'] },
            { name: 'NUCLEO', sets: [''] },
        ]);
        assert.deepStrictEqual(resolveTargetSelection(types, { type: 'B-U585I', set: 'release' }),
            { ok: true, type: 'B-U585I', set: 'release', setIndex: 1, name: 'B-U585I@release' });
    });

    test('listTargetTypes takes type: from the entries of solution: target-types: only', () => {
        const nested = `
solution:
  description: |
    target-types:
      - type: InText
  target-types:
    - type: HP
      target-set:
        - set: debug
          images:
            - type: elf
              image: ./build/app.elf
          debugger:
            name: J-Link Server
            reset:
              - type: system
        - set: release
`;
        const types = listTargetTypes(nested);
        assert.deepStrictEqual(types, [{ name: 'HP', sets: ['debug', 'release'] }]);
        assert.deepStrictEqual(resolveTargetSelection(types, { type: 'HP', set: 'release' }),
            { ok: true, type: 'HP', set: 'release', setIndex: 1, name: 'HP@release' });
        // An entry without set: (the schema requires one) keeps its place: the extension's index counts every entry.
        assert.deepStrictEqual(listTargetTypes('solution:\n  target-types:\n    - type: A\n      target-set:\n        - images: []\n        - set: s\n'),
            [{ name: 'A', sets: ['', 's'] }]);
    });

    test('listTargetTypes reads lists in their key\'s column, CRLF line ends and a byte-order mark', () => {
        // The layout of NXP's SDK examples.
        const compact = [
            '---',
            'solution:',
            '  target-types:',
            '  - type: armgcc',
            '    compiler: GCC',
            '  - type: iar',
            '    target-set:',
            '    - set: flash',
            '      debugger:',
            '        name: J-Link Server',
            '  build-types:',
            '  - type: release',
            '',
        ].join('\r\n');
        assert.deepStrictEqual(listTargetTypes(compact), [
            { name: 'armgcc', sets: [] },
            { name: 'iar', sets: ['flash'] },
        ]);
        assert.deepStrictEqual(listTargetTypes('\uFEFFsolution:\n  target-types:\n    - type: MPS3\n'), [{ name: 'MPS3', sets: [] }]);
    });

    test('listTargetTypes reads quoted keys and names and drops comments', () => {
        const quoted = `
solution:   # a comment after a key
  target-types:   # and one after this key
    # a comment line between entries
    - "type": 'HE'   # a quoted key and name
      target-set:
        -   # the keys of this entry follow on the next lines
          set:   # the unnamed set
        - set: "debug # 2"   # a quoted name may hold ' #'
        - set: 'it''s'
        - set: v#3
        - set: ~
`;
        assert.deepStrictEqual(listTargetTypes(quoted), [{ name: 'HE', sets: ['', 'debug # 2', 'it\'s', 'v#3', ''] }]);
    });

    test('listTargetTypes reads flow collections, including reordered keys and unnamed sets', () => {
        const types = listTargetTypes(`solution: {target-types: [
  {device: Cortex-M55, target-set: [{images: [], set: debug}, {set: null}], type: "MPS3"},
  {type: Other, target-set: []}
  ]}`);
        assert.deepStrictEqual(types, [
            { name: 'MPS3', sets: ['debug', ''] },
            { name: 'Other', sets: [] },
        ]);
        assert.deepStrictEqual(resolveTargetSelection(types, { type: 'MPS3', set: '' }),
            { ok: true, type: 'MPS3', set: '', setIndex: 1, name: 'MPS3' });
    });

    test('listTargetTypes resolves anchors, aliases and merge keys at every selection level', () => {
        const aliased = `
name: &name MPS3
debug: &debug {set: debug}
sets: &sets [*debug, {set: release}]
base: &base {type: *name, target-set: *sets}
targets: &targets
  - *base
  - {<<: *base, type: Other}
definition: &definition {target-types: *targets}
solution: *definition
`;
        assert.deepStrictEqual(listTargetTypes(aliased), [
            { name: 'MPS3', sets: ['debug', 'release'] },
            { name: 'Other', sets: ['debug', 'release'] },
        ]);
    });

    test('listTargetTypes decodes YAML escapes rather than approximating them with JSON', () => {
        assert.deepStrictEqual(listTargetTypes(String.raw`
solution:
  target-types:
    - type: "MPS\x33"
      target-set:
        - set: "debug\_build"
        - set: "\u0061\U00000062"
`), [{ name: 'MPS3', sets: ['debug\u00a0build', 'ab'] }]);
    });

    test('listTargetTypes rejects malformed YAML, duplicate keys, unknown tags and documents', () => {
        for (const yaml of [
            'solution: {target-types: [',
            'solution: {target-types: [], target-types: [{type: A}]}',
            'solution: {target-types: [*missing]}',
            'solution: {target-types: !custom [{type: A}]}',
            'solution: {}\n---\nsolution: {}\n',
            '',
        ]) {
            assert.throws(() => listTargetTypes(yaml), /Cannot read csolution targets: invalid or unsupported YAML/, yaml);
        }
    });

    test('listTargetTypes reports invalid shapes instead of returning an empty or partial list', () => {
        const bad: [string, string][] = [
            ['{}', 'solution must be a mapping'],
            ['solution: []', 'solution must be a mapping'],
            ['solution: {target-types: {type: A}}', 'solution.target-types must be a sequence'],
            ['solution: {target-types: [A]}', 'solution.target-types[0] must be a mapping'],
            ['solution: {target-types: [{device: Cortex-M55}]}', 'solution.target-types[0].type must be a non-empty string'],
            ['solution: {target-types: [{type: ""}]}', 'solution.target-types[0].type must be a non-empty string'],
            ['solution: {target-types: [{type: 123}]}', 'solution.target-types[0].type must be a non-empty string'],
            ['solution: {target-types: [{type: A}, {type: false}]}', 'solution.target-types[1].type must be a non-empty string'],
            ['solution: {target-types: [{type: A, target-set: {set: debug}}]}', 'solution.target-types[0].target-set must be a sequence'],
            ['solution: {target-types: [{type: A, target-set: [debug]}]}', 'solution.target-types[0].target-set[0] must be a mapping'],
            ['solution: {target-types: [{type: A, target-set: [{set: 1}]}]}', 'solution.target-types[0].target-set[0].set must be a string or null'],
        ];
        for (const [yaml, reason] of bad) {
            assert.throws(() => listTargetTypes(yaml), (error: unknown) => error instanceof Error && error.message.includes(reason), yaml);
        }
        assert.deepStrictEqual(listTargetTypes('solution: {target-types: []}'), [], 'a genuinely empty declaration stays empty');
    });

    test('listTargetTypes cannot take target fields from prototype or complex keys', () => {
        assert.throws(() => listTargetTypes('solution: {target-types: [{__proto__: {type: Injected}}]}'), /type must be a non-empty string/);
        assert.throws(() => listTargetTypes('solution: {target-types: [{? [type] : Injected}]}'), /non-string mapping key/);
        assert.deepStrictEqual(listTargetTypes('solution: {target-types: [{type: __proto__}]}'), [{ name: '__proto__', sets: [] }]);
    });

    test('listTargetTypes rejects non-string keys at every visited selection mapping', () => {
        const bad: [string, string][] = [
            ['{? [solution]: {target-types: [{type: MPS3}]}}', 'document'],
            ['solution: {? [target-types]: [{type: MPS3}]}', 'solution'],
            ['solution: {target-types: [{? [type]: MPS3}]}', 'solution.target-types[0]'],
            ['solution: {target-types: [{type: MPS3, target-set: [{? [set]: debug}]}]}', 'solution.target-types[0].target-set[0]'],
            ['solution: {true: ignored, target-types: []}', 'solution'],
        ];
        for (const [yaml, at] of bad) {
            assert.throws(() => listTargetTypes(yaml), {
                message: `Cannot read csolution targets: ${at} contains a non-string mapping key; only string keys are supported.`,
            });
        }
    });

    test('listTargetTypes bounds bytes, depth, alias references and merge work', () => {
        assert.throws(() => listTargetTypes(`#${'x'.repeat(1024 * 1024)}`), /byte limit/);
        assert.throws(() => listTargetTypes(`#${'é'.repeat(512 * 1024)}`), /byte limit/, 'the limit is UTF-8 bytes, not characters');
        assert.throws(() => listTargetTypes(`solution: {target-types: []}\nextra: ${'['.repeat(65)}0${']'.repeat(65)}`), /maxDepth/i);
        assert.throws(() => listTargetTypes(`base: &base {type: A}\nsolution: {target-types: [${Array(101).fill('*base').join(',')}]}\n`), /alias/i);
        const keys = Array.from({ length: 101 }, (_, index) => `key${index}: x`).join(',');
        const merges = Array.from({ length: 100 }, (_, index) => `merge${index}: {<<: *base}`).join('\n');
        assert.throws(() => listTargetTypes(`base: &base {${keys}}\n${merges}\nsolution: {target-types: []}\n`), /merge/i);
    });

    test('listTargetTypes bounds extracted names even when aliases share the same large sequence', () => {
        const sets = Array.from({ length: 101 }, (_, index) => `{set: s${index}}`).join(',');
        const targets = Array.from({ length: 100 }, (_, index) => `{type: T${index}, target-set: *sets}`).join(',');
        assert.throws(() => listTargetTypes(`sets: &sets [${sets}]\nsolution: {target-types: [${targets}]}\n`), /more than 10000/);
        assert.throws(() => listTargetTypes(`solution: {target-types: [{type: ${'x'.repeat(1025)}}]}`), /character name limit/);
    });

    test('listTargetTypes handles cyclic aliases without expanding or traversing unrelated data', () => {
        assert.deepStrictEqual(listTargetTypes('extra: &cycle [*cycle]\nsolution: {target-types: [{type: MPS3}]}'), [{ name: 'MPS3', sets: [] }]);
        assert.throws(() => listTargetTypes('solution: {target-types: &cycle [*cycle]}'), /target-types\[0\] must be a mapping/);
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
        assert.strictEqual(solutionDisplayName('/ws', '/ws/v1.2/my.demo.csolution.yaml'), 'v1.2/my.demo');
    });

    test('solutionDisplayName of a solution in the second folder of a multi-root workspace goes up from the first', () => {
        assert.strictEqual(solutionDisplayName('/ws/app', '/ws/fw/demo.csolution.yml'), '../fw/demo');
    });

    test('applyTargetSelection writes the key where the extension looks it up: the display name split at every dot', () => {
        for (const name of ['demo', 'RockPaperScissors/AppKit-E8_USB/SDS', '../fw/demo', 'v1.2/my.demo', '../../a.b/c']) {
            const json: unknown = JSON.parse(applyTargetSelection('', name, 'HP', 1));
            assert.strictEqual(extensionGet(json, `targetSet.${name}.activeTargetType`), 'HP', name);
            // getSelectedSet: the type's entry in the map at targetSet.<name>.
            assert.strictEqual((extensionGet(json, `targetSet.${name}`) as Record<string, unknown> | undefined)?.HP, 1, name);
        }
        assert.deepStrictEqual(JSON.parse(applyTargetSelection('', '../fw/demo', 'HP', 1)),
            { targetSet: { '': { '': { '/fw/demo': { activeTargetType: 'HP', HP: 1 } } } } });
    });

    test('applyTargetSelection updates the selection CMSIS Solution wrote for a solution in the second folder', () => {
        const written = JSON.stringify({
            targetSet: { '': { '': { '/fw/demo': { activeTargetType: 'HE' } } }, other: { activeTargetType: 'MPS3' } },
            activeSolution: '../../fw/demo.csolution.yml',
            activeTarget: 'HE',
        }, null, 4);
        assert.deepStrictEqual(JSON.parse(applyTargetSelection(written, '../fw/demo', 'HP', 0)), {
            targetSet: { '': { '': { '/fw/demo': { activeTargetType: 'HP', HP: 0 } } }, other: { activeTargetType: 'MPS3' } },
            activeSolution: '../../fw/demo.csolution.yml',
            activeTarget: 'HE',
        });
    });

    test('applyTargetSelection writes a name without dots as before, byte for byte', () => {
        assert.strictEqual(applyTargetSelection('', 'demo', 'HP', 1),
            '{\n    "targetSet": {\n        "demo": {\n            "activeTargetType": "HP",\n            "HP": 1\n        }\n    }\n}\n');
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
