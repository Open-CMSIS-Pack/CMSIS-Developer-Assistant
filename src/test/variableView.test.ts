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
import {
    anyFieldRedacted,
    DapScope,
    DapVariable,
    expandFields,
    formatMissingNames,
    isDapVariable,
    noteSkippedScopes,
    renderFields,
    renderScopes,
    renderVariableNames,
    selectVariables,
} from '../core/variableView';
import { isSensitiveName, redactVariableValue } from '../utils/secretRedaction';

const scopes = (): DapScope[] => ([
    {
        name: 'Local',
        variables: [
            { name: 'adc_raw', value: '2048', type: 'uint16_t', evaluateName: 'adc_raw' },
            { name: 'state', value: 'FSM_IDLE', type: 'fsm_t', evaluateName: 'state' },
            { name: 'config [Dictionary]', value: '{...}', evaluateName: 'config' },
        ],
    },
    {
        name: 'Global',
        variables: [
            { name: 'g_ticks', value: '104233', type: 'volatile uint32_t' },
        ],
    },
]);

suite('Variable selection', () => {

    test('no filter returns every scope untouched', () => {
        const all = scopes();
        const { scopes: out, missing } = selectVariables(all, []);
        assert.strictEqual(out, all);
        assert.deepStrictEqual(missing, []);
    });

    test('filters to the requested names across scopes', () => {
        const { scopes: out, missing } = selectVariables(scopes(), ['adc_raw', 'g_ticks']);
        assert.deepStrictEqual(out.map(s => s.name), ['Local', 'Global']);
        assert.deepStrictEqual(out[0].variables?.map(v => v.name), ['adc_raw']);
        assert.deepStrictEqual(out[1].variables?.map(v => v.name), ['g_ticks']);
        assert.deepStrictEqual(missing, []);
    });

    test('scopes with no match are dropped', () => {
        const { scopes: out } = selectVariables(scopes(), ['adc_raw']);
        assert.deepStrictEqual(out.map(s => s.name), ['Local']);
    });

    test('matches the evaluateName when the display name is type-decorated', () => {
        const { scopes: out, missing } = selectVariables(scopes(), ['config']);
        assert.deepStrictEqual(out[0].variables?.map(v => v.name), ['config [Dictionary]']);
        assert.deepStrictEqual(missing, []);
    });

    test('matches a decorated display name even without an evaluateName', () => {
        const decorated: DapScope[] = [{ name: 'Local', variables: [{ name: 'buf [16]', value: '0x2000' }] }];
        const { missing } = selectVariables(decorated, ['buf']);
        assert.deepStrictEqual(missing, []);
    });

    test('unmatched names are reported, not silently dropped', () => {
        const { scopes: out, missing } = selectVariables(scopes(), ['adc_raw', 'nope', 'alsoNope']);
        assert.deepStrictEqual(out[0].variables?.map(v => v.name), ['adc_raw']);
        assert.deepStrictEqual(missing, ['nope', 'alsoNope']);
    });

    test('a scope carrying an error is kept even with no matches', () => {
        const failing: DapScope[] = [{ name: 'Registers', error: 'probe timed out' }];
        const { scopes: out } = selectVariables(failing, ['anything']);
        assert.deepStrictEqual(out.map(s => s.name), ['Registers']);
    });

    test('blank and whitespace-only names are ignored', () => {
        const { scopes: out } = selectVariables(scopes(), ['   ', '']);
        assert.strictEqual(out.length, 2, 'an all-blank filter behaves as no filter');
    });

    test('names are trimmed before matching', () => {
        const { missing } = selectVariables(scopes(), ['  adc_raw  ']);
        assert.deepStrictEqual(missing, []);
    });

    test('matching is case-sensitive, as C identifiers are', () => {
        const { missing } = selectVariables(scopes(), ['ADC_RAW']);
        assert.deepStrictEqual(missing, ['ADC_RAW']);
    });
});

suite('Variable rendering', () => {

    test('values render with name, value and type', () => {
        const out = renderScopes(scopes(), { header: 'Variables' });
        assert.match(out, /^Variables:\n=+\n/);
        assert.match(out, /adc_raw: 2048 \(uint16_t\)/);
        assert.match(out, /g_ticks: 104233 \(volatile uint32_t\)/);
    });

    test('a variable with no type omits the parenthetical', () => {
        const out = renderScopes([{ name: 'Local', variables: [{ name: 'x', value: '1' }] }]);
        assert.match(out, /x: 1\n/);
        assert.doesNotMatch(out, /x: 1 \(/);
    });

    test('a scope error is surfaced instead of its variables', () => {
        const out = renderScopes([{ name: 'Registers', error: 'probe timed out' }]);
        assert.match(out, /Error retrieving variables: probe timed out/);
    });

    test('name listing shows types but never values', () => {
        const out = renderVariableNames(scopes());
        assert.match(out, /adc_raw: uint16_t/);
        assert.doesNotMatch(out, /2048/, 'values must not leak into the names-only view');
        assert.doesNotMatch(out, /FSM_IDLE/);
    });

    test('name listing collapses to one line when nothing is in scope', () => {
        const out = renderVariableNames([{ name: 'Local', variables: [] }]);
        assert.strictEqual(out, 'No variables are visible at the current execution point.');
    });

    test('the missing-names note is empty when everything matched', () => {
        assert.strictEqual(formatMissingNames([]), '');
    });

    test('the missing-names note names them and points at list_variable_names', () => {
        const note = formatMissingNames(['foo', 'bar']);
        assert.match(note, /foo, bar/);
        assert.match(note, /list_variable_names/);
    });

    test('scopes left unread are named on a line of their own, with the tool that reads registers', () => {
        const listing = renderScopes([{ name: 'Local', variables: [{ name: 'x', value: '1' }] }]);
        assert.strictEqual(noteSkippedScopes(listing, []), listing, 'nothing left out, nothing added');
        assert.strictEqual(noteSkippedScopes(listing, ['Registers']),
            `${listing}Registers: not read here (expensive over the probe) — read_core_registers reads the core registers.\n`);
        assert.strictEqual(noteSkippedScopes('None of them are in scope.', ['Registers', 'Statics']),
            'None of them are in scope.\nRegisters, Statics: not read here (expensive over the probe) — read_core_registers reads the core registers.');
    });
});

suite('Variable rendering with redaction', () => {

    const withSecret = (): DapScope[] => ([{
        name: 'Local',
        variables: [
            { name: 'adc_raw', value: '2048', type: 'uint16_t' },
            { name: 'apiKey', value: '"sk-abcdefghijklmnopqrst"', type: 'char *' },
        ],
    }]);

    test('no redactor means values pass through verbatim', () => {
        const out = renderScopes(withSecret(), { header: 'Variables' });
        assert.match(out, /sk-abcdefghijklmnopqrst/);
        assert.doesNotMatch(out, /NOTE: values matching/);
    });

    test('a redactor withholds the value and appends the notice once', () => {
        const out = renderScopes(withSecret(), {
            header: 'Variables',
            redact: (name, value) => redactVariableValue(name, value),
        });
        assert.doesNotMatch(out, /sk-abcdefghijklmnopqrst/);
        assert.match(out, /apiKey: <redacted: possible secret>/);
        assert.match(out, /adc_raw: 2048/, 'unrelated variables stay readable');
        assert.strictEqual(out.match(/NOTE: values matching/g)?.length, 1);
    });

    test('the notice is omitted when nothing was actually withheld', () => {
        const clean: DapScope[] = [{ name: 'Local', variables: [{ name: 'ticks', value: '99' }] }];
        const out = renderScopes(clean, {
            header: 'Variables',
            redact: (name, value) => redactVariableValue(name, value),
        });
        assert.doesNotMatch(out, /NOTE: values matching/);
    });
});

suite('Variable rendering with listing caps', () => {

    const bigScope = (count: number): DapScope[] => ([{
        name: 'Local',
        variables: Array.from({ length: count }, (_, i) => ({ name: `v${i}`, value: String(i), type: 'int' })),
    }]);

    test('an un-narrowed listing is cut at the cap with a footer that says how to widen', () => {
        const out = renderScopes(bigScope(45), { header: 'Variables', limits: { maxVariables: 40, maxValueChars: 200 } });
        assert.match(out, /v39: 39 \(int\)/);
        assert.doesNotMatch(out, /v40: 40/);
        assert.match(out, /… 5 more, truncated — narrow with variableNames/);
    });

    test('a listing within the cap has no footer', () => {
        const out = renderScopes(bigScope(3), { header: 'Variables', limits: { maxVariables: 40, maxValueChars: 200 } });
        assert.doesNotMatch(out, /truncated/);
    });

    test('long values are clipped and the clipped length stated', () => {
        const long = '{' + Array.from({ length: 300 }, (_, i) => i).join(', ') + '}';
        const out = renderScopes([{ name: 'Local', variables: [{ name: 'buf', value: long, type: 'int [300]' }] }],
            { header: 'Variables', limits: { maxVariables: 40, maxValueChars: 200 } });
        assert.match(out, /buf: \{0, 1, 2.{0,200}… \(\+\d+ chars\) \(int \[300\]\)/);
    });

    test('no limits means nothing is cut', () => {
        const out = renderScopes(bigScope(45), { header: 'Variables' });
        assert.match(out, /v44: 44/);
        assert.doesNotMatch(out, /truncated/);
    });

    test('redaction runs before clipping, so a secret is never partially shown', () => {
        const secret = '"sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(8) + '"';
        const out = renderScopes([{ name: 'Local', variables: [{ name: 'apiKey', value: secret }] }], {
            header: 'Variables',
            redact: (name, value) => redactVariableValue(name, value),
            limits: { maxVariables: 40, maxValueChars: 20 },
        });
        assert.match(out, /apiKey: <redacted: possible secret>\n/, 'the placeholder is intact, not clipped');
        assert.doesNotMatch(out, /sk-abc/);
    });

    test('the names listing is capped too, with its own hint', () => {
        const out = renderVariableNames(bigScope(120), { maxVariables: 100 });
        assert.match(out, /v99: int/);
        assert.doesNotMatch(out, /v100: int/);
        assert.match(out, /… 20 more — pass scope: 'local'/);
    });
});

suite('Fields of an evaluated structure', () => {
    /** An adapter with three references: a struct, its nested struct and a 40-element array. */
    const tree: Record<number, DapVariable[]> = {
        10: [
            { name: 'id', value: "3 '\\003'", type: 'uint8_t', variablesReference: 0 },
            { name: 'cal', value: '{...}', type: 'cal_t', variablesReference: 11 },
            { name: 'samples', value: '{...}', type: 'uint16_t [40]', variablesReference: 12 },
            { name: 'token', value: '"tk-7f3a9c21"', type: 'char [12]', variablesReference: 13 },
            { name: 'note', value: `"${'n'.repeat(300)}"`, type: 'char [301]', variablesReference: 0 },
        ],
        11: [{ name: 'offset', value: '-12', type: 'int16_t' }, { name: 'gain', value: '1.25', type: 'float' }],
        12: Array.from({ length: 40 }, (_, i) => ({ name: `[${i}]`, value: String(i * 10), type: 'uint16_t' })),
        13: [{ name: '[0]', value: "116 't'", type: 'char' }],
    };
    const asked: number[] = [];
    const source = {
        children: async (reference: number): Promise<DapVariable[]> => {
            asked.push(reference);
            if (!(reference in tree)) {
                throw new Error(`Invalid variable reference ${reference}`);
            }
            return tree[reference];
        },
        redact: (name: string, value: string) => redactVariableValue(name, value),
        withholdChildren: isSensitiveName,
    };

    setup(() => {
        asked.length = 0;
    });

    test('one level by default: each child with its type, long values cut, a credential-named field withheld', async () => {
        const fields = await expandFields(source, 10, 1);
        assert.deepStrictEqual(asked, [10], 'one request for one level');
        const text = renderFields(fields);
        assert.ok(text.startsWith("Fields:\n  id: 3 '\\003' (uint8_t)\n  cal: {...} (cal_t)\n  samples: {...} (uint16_t [40])\n"
            + '  token: <redacted: possible secret> (char [12])\n'), text);
        assert.match(text, /\n {2}note: "n{199}… \(\+102 chars\) \(char \[301\]\)$/);
        assert.strictEqual(anyFieldRedacted(fields), true);
    });

    test('deeper levels are indented; a level is cut at 32 and counts the rest; a withheld field is never opened', async () => {
        const fields = await expandFields(source, 10, 2);
        assert.deepStrictEqual(asked, [10, 11, 12], 'the token is not expanded');
        const text = renderFields(fields);
        assert.ok(text.includes('  cal: {...} (cal_t)\n    offset: -12 (int16_t)\n    gain: 1.25 (float)\n  samples:'), text);
        assert.ok(text.includes('    [31]: 310 (uint16_t)\n    … 8 more — evaluate a field or element by name to read it\n  token:'), text);
        assert.ok(!text.includes('[32]:'), text);
    });

    test('the request budget stops the expansion; a level that cannot be read says why', async () => {
        const fields = await expandFields(source, 10, 3, { maxChildren: 32, maxValueChars: 200, maxRequests: 2 });
        assert.deepStrictEqual(asked, [10, 11], 'the second request is the last');
        assert.strictEqual(fields.shown[2].children, undefined);
        const broken = await expandFields(source, 99, 1);
        assert.strictEqual(renderFields(broken), 'Fields:\n  (could not be read: Invalid variable reference 99)');
    });

    test('without redaction every value shows and every child can open', async () => {
        const open = await expandFields({ children: source.children }, 10, 2);
        assert.strictEqual(anyFieldRedacted(open), false);
        assert.ok(renderFields(open).includes('  token: "tk-7f3a9c21" (char [12])\n    [0]: 116 \'t\' (char)'));
    });

    test('a variables entry needs a name and a value', () => {
        assert.strictEqual(isDapVariable({ name: 'a', value: '1' }), true);
        assert.strictEqual(isDapVariable({ name: 'a' }), false);
        assert.strictEqual(isDapVariable(null), false);
    });
});
