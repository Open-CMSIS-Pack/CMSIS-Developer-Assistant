// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import {
    DapScope,
    formatMissingNames,
    renderScopes,
    renderVariableNames,
    selectVariables,
} from '../core/variableView';
import { redactVariableValue } from '../utils/secretRedaction';

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
