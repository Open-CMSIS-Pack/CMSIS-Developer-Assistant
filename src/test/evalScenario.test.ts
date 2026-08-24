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
    aggregateEvents, diffTotals, judge, restoreMcpServer, upsertMcpServer, validateScenario, ScenarioSpec,
} from '../core/evalScenario';

/**
 * The evaluation runner spends AI credits and needs a target, so only its
 * pure logic runs here: scenario validation, the event-stream aggregation
 * (against a synthetic sample — refine it from a recorded run), the verdict,
 * and the mcp-config edit it makes and undoes.
 */
suite('Evaluation scenario logic', () => {

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const sample = fs.readFileSync(path.join(repoRoot, 'src', 'test', 'fixtures', 'copilot-events.sample.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l));

    const spec: ScenarioSpec = {
        id: 'divide-by-zero', prompt: 'p', fixture: 'corstone-blinky', targets: ['fvp'],
        expectedRootCause: 'DIVBYZERO|divide by zero', forbidden: { toolArgs: 'add_logpoint|printf' },
        budgets: { maxToolCalls: 25, maxTurns: 15, maxWallMs: 900000 },
    };

    test('every shipped scenario validates', () => {
        const dir = path.join(repoRoot, 'test', 'eval', 'scenarios');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        assert.ok(files.length >= 5, `${files.length} scenarios`);
        for (const f of files) {
            const v = validateScenario(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
            assert.ok(v.ok, `${f}: ${v.ok ? '' : v.errors.join('; ')}`);
            if (v.ok) {
                assert.strictEqual(`${v.spec.id}.json`, f, 'file name matches id');
                assert.ok(fs.existsSync(path.join(repoRoot, 'test', 'eval', 'fixtures', v.spec.fixture, v.spec.overlay ?? '')), `${f}: overlay exists`);
            }
        }
    });

    test('validation names every problem', () => {
        const v = validateScenario({ id: 'Bad Id', targets: ['sim'], budgets: { maxToolCalls: 0 }, expectedRootCause: '(' });
        assert.ok(!v.ok);
        if (!v.ok) {
            for (const needle of ['id:', 'prompt:', 'fixture:', 'expectedRootCause: not a valid regex', 'targets:', 'budgets.maxToolCalls', 'budgets.maxTurns', 'budgets.maxWallMs']) {
                assert.ok(v.errors.some(e => e.startsWith(needle)), needle);
            }
        }
    });

    test('aggregates tool calls, result sizes, turns, final answer and usage from the stream', () => {
        const agg = aggregateEvents(sample);
        assert.deepStrictEqual(agg.toolCalls.map(c => c.name), ['skill', 'cmsis-developer-assistant-get_session_status', 'cmsis-developer-assistant-diagnose_fault']);
        assert.strictEqual(agg.toolCalls[2].argBytes, Buffer.byteLength('{"levels":3}'));
        assert.strictEqual(agg.toolCalls[1].resultBytes, Buffer.byteLength('State: stopped\nSession: Arm-FVP@GDB (launch)\n'));
        assert.strictEqual(agg.turns, 2);
        assert.match(agg.finalAnswer, /^Root cause: DIVBYZERO/);
        assert.deepStrictEqual(agg.tokenUsage, { inputTokens: 18250, outputTokens: 940 });
        assert.deepStrictEqual(agg.unknownEventTypes, ['something.new']);
        assert.strictEqual(agg.eventCount, sample.length);
    });

    test('the verdict passes on the sample and fails for each budget or pattern', () => {
        const agg = aggregateEvents(sample);
        assert.deepStrictEqual(judge(spec, agg, 60_000), { passed: true, reasons: [], infraError: false });
        assert.match(judge({ ...spec, expectedRootCause: 'stack overflow' }, agg, 60_000).reasons[0], /does not match/);
        assert.match(judge({ ...spec, budgets: { ...spec.budgets, maxToolCalls: 2 } }, agg, 60_000).reasons[0], /3 tool calls > budget 2/);
        assert.match(judge({ ...spec, budgets: { ...spec.budgets, maxTurns: 1 } }, agg, 60_000).reasons[0], /2 turns > budget 1/);
        assert.match(judge(spec, agg, 1_000_000).reasons[0], /ms > budget/);
        assert.match(judge({ ...spec, forbidden: { toolArgs: 'diagnose_fault' } }, agg, 60_000).reasons[0], /forbidden tool use/);
        const infra = judge(spec, agg, 60_000, 'FVP did not come up');
        assert.deepStrictEqual(infra, { passed: false, reasons: ['infra: FVP did not come up'], infraError: true });
    });

    test('stats snapshots diff per tool and drop tools that were not called', () => {
        const before = { calls: 10, bytesOut: 1000, bytesIn: 100, ms: 500, perTool: { get_threads: { calls: 10, ms: 500, bytesOut: 1000, timeouts: 0, errors: 0 } } };
        const after = { calls: 13, bytesOut: 4000, bytesIn: 130, ms: 900, perTool: {
            get_threads: { calls: 10, ms: 500, bytesOut: 1000, timeouts: 0, errors: 0 },
            diagnose_fault: { calls: 3, ms: 400, bytesOut: 3000, timeouts: 0, errors: 1 },
        } };
        assert.deepStrictEqual(diffTotals(before, after), { calls: 3, bytesOut: 3000, bytesIn: 30, ms: 400, perTool: { diagnose_fault: { calls: 3, ms: 400, bytesOut: 3000, timeouts: 0, errors: 1 } } });
        assert.strictEqual(diffTotals(before, undefined), undefined);
        assert.strictEqual(diffTotals(undefined, after)?.calls, 13);
    });

    test('the mcp-config edit round-trips, with and without a previous entry', () => {
        const entry = { type: 'http' as const, url: 'http://localhost:3001/mcp', tools: ['*'] };
        const fresh = upsertMcpServer({ other: 1 }, 'cmsis-developer-assistant', entry);
        assert.deepStrictEqual(fresh.config, { other: 1, mcpServers: { 'cmsis-developer-assistant': entry } });
        assert.strictEqual(fresh.previous, undefined);
        assert.deepStrictEqual(restoreMcpServer(fresh.config, 'cmsis-developer-assistant', fresh.previous), { other: 1, mcpServers: {} });

        const old = { type: 'http', url: 'http://localhost:9999/mcp', tools: ['*'] };
        const replaced = upsertMcpServer({ mcpServers: { 'cmsis-developer-assistant': old, x: {} } }, 'cmsis-developer-assistant', entry);
        assert.deepStrictEqual(replaced.previous, old);
        assert.deepStrictEqual(restoreMcpServer(replaced.config, 'cmsis-developer-assistant', replaced.previous), { mcpServers: { 'cmsis-developer-assistant': old, x: {} } });
    });
});
