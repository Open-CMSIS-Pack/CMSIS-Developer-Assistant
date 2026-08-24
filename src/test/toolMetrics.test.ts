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
import { ToolMetrics, ToolSample, classifyOutcome, formatBytes } from '../core/toolMetrics';

/**
 * The numbers behind get_session_status and the stats resource. Pure module,
 * so every rule is pinned here: how an outcome is read off a text result, that
 * the ring forgets but the totals do not, and the exact summary wording an
 * agent will see.
 */
suite('Tool metrics', () => {

    const sample = (tool: string, over: Partial<ToolSample> = {}): ToolSample => ({
        tool, argBytes: 10, resultBytes: 100, ms: 5, outcome: 'ok', at: 1, ...over,
    });

    test('recognises the handler-level cap and the motion-tool trailer as timeouts', () => {
        assert.strictEqual(classifyOutcome("'get_call_stack' did not complete within 30000 ms (handler-level cap). …"), 'timeout');
        assert.strictEqual(classifyOutcome("{...}\n\n⚠️ 'step_over' did not complete within 180s. Recovery: …"), 'timeout');
        assert.strictEqual(classifyOutcome('HardwareTimeoutError: readMemory exceeded 10000 ms'), 'timeout');
    });

    test('recognises fenced errors and the MCP isError flag; everything else is ok', () => {
        assert.strictEqual(classifyOutcome("Error in 'read_memory': No active debug session"), 'error');
        assert.strictEqual(classifyOutcome('all good', true), 'error');
        assert.strictEqual(classifyOutcome('Call stack (3 frames):\n  #0 main'), 'ok');
        // A build that failed is a successful report of a failure, not a tool error.
        assert.strictEqual(classifyOutcome("❌ CMSIS 'build' FAILED — task exited with code 2"), 'ok');
    });

    test('keeps only the last N samples but totals every call', () => {
        const m = new ToolMetrics(3);
        for (let i = 0; i < 5; i++) { m.record(sample('get_threads', { at: i })); }
        assert.deepStrictEqual(m.samples().map((s) => s.at), [2, 3, 4]);
        assert.strictEqual(m.totals().calls, 5);
        assert.strictEqual(m.totals().bytesOut, 500);
        assert.strictEqual(m.totals().bytesIn, 50);
    });

    test('aggregates per tool including timeouts and errors', () => {
        const m = new ToolMetrics();
        m.record(sample('read_memory', { resultBytes: 4000 }));
        m.record(sample('read_memory', { resultBytes: 4000, outcome: 'timeout' }));
        m.record(sample('get_threads', { outcome: 'error', resultBytes: 20 }));
        const t = m.totals();
        assert.deepStrictEqual(t.perTool.read_memory, { calls: 2, ms: 10, bytesOut: 8000, timeouts: 1, errors: 0 });
        assert.deepStrictEqual(t.perTool.get_threads, { calls: 1, ms: 5, bytesOut: 20, timeouts: 0, errors: 1 });
        assert.strictEqual(t.timeouts, 1);
        assert.strictEqual(t.errors, 1);
    });

    test('totals() is a snapshot', () => {
        const m = new ToolMetrics();
        m.record(sample('a'));
        const t = m.totals();
        t.perTool.a.calls = 99;
        assert.strictEqual(m.totals().perTool.a.calls, 1);
    });

    test('formatTotals names the largest tools and says so when empty', () => {
        const m = new ToolMetrics();
        assert.strictEqual(m.formatTotals(), 'Tool stats (this session): no tool calls recorded yet.');
        m.record(sample('get_frame_variables', { resultBytes: 18_000, ms: 1000 }));
        m.record(sample('get_call_stack', { resultBytes: 9_000, ms: 1000 }));
        m.record(sample('get_call_stack', { resultBytes: 300, ms: 1000, outcome: 'timeout' }));
        m.record(sample('step_over', { resultBytes: 100, ms: 100 }));
        m.record(sample('read_memory', { resultBytes: 8_000, ms: 100 }));
        const out = m.formatTotals();
        assert.strictEqual(out.split('\n')[0],
            'Tool stats (this session): 5 calls · 34.6 kB returned · 3.2 s in tools · 1 timeout · 0 errors');
        assert.strictEqual(out.split('\n')[1],
            '  largest: get_frame_variables 17.6 kB over 1 call · get_call_stack 9.1 kB over 2 calls · read_memory 7.8 kB over 1 call');
    });

    test('formatBytes picks the unit', () => {
        assert.strictEqual(formatBytes(12), '12 B');
        assert.strictEqual(formatBytes(1536), '1.5 kB');
        assert.strictEqual(formatBytes(3 * 1024 * 1024), '3.00 MB');
    });

    test('onSample fires once per record, after the totals are updated', () => {
        const seen: number[] = [];
        const m = new ToolMetrics(10, () => seen.push(m.totals().calls));
        m.record(sample('a'));
        m.record(sample('b'));
        assert.deepStrictEqual(seen, [1, 2]);
    });
});
