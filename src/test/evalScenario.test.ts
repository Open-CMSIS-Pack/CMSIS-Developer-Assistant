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
    DEFAULT_SHELL_DENY_LIST, aggregateEvents, aggregateKimiStream, bypassRate, diffTotals, findBypasses, judge, kimiMcpEntry, restoreMcpServer,
    shellCommandOf, sumKimiUsage, upsertMcpServer, validateScenario, ScenarioSpec,
} from '../core/evalScenario';
import { KIMI_TOOL_TIMEOUT_MS } from '../utils/agentConfigurationManager';

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

    /** A run that calls these tools, then answers with the expected root cause. */
    const runOf = (calls: Array<{ toolName: string; arguments: unknown }>) => aggregateEvents([
        ...calls.map((call, index) => ({ type: 'tool.execution_start', data: { toolCallId: `s${index}`, ...call } })),
        { type: 'assistant.message', data: { content: 'Root cause: DIVBYZERO — delay_ms / blink_divider.' } },
    ]);

    test('a shell pyocd load fails the run', () => {
        const agg = runOf([{ toolName: 'bash', arguments: { command: 'pyocd load --cbuild-run out/Blinky+MPS3.cbuild-run.yml', description: 'flash' } }]);
        const verdict = judge(spec, agg, 60_000);
        assert.strictEqual(verdict.passed, false);
        assert.deepStrictEqual(verdict.reasons, ['shell bypass (default deny list): bash: pyocd load --cbuild-run out/Blinky+MPS3.cbuild-run.yml']);
        assert.deepStrictEqual(findBypasses(spec, agg), [{ tool: 'bash', command: 'pyocd load --cbuild-run out/Blinky+MPS3.cbuild-run.yml', rule: 'default' }]);
    });

    test('an MCP flash call whose arguments contain cbuild-run.yml passes', () => {
        const agg = runOf([
            { toolName: 'cmsis-developer-assistant-flash', arguments: { cbuildRunFile: 'out/Blinky+MPS3.cbuild-run.yml' } },
            { toolName: 'bash', arguments: { command: 'cat out/Blinky+MPS3.cbuild-run.yml' } },
        ]);
        assert.deepStrictEqual(judge(spec, agg, 60_000), { passed: true, reasons: [], infraError: false });
        assert.deepStrictEqual(findBypasses(spec, agg), [], 'a cbuild-run file name in a shell command is not the cbuild command');
    });

    test('the default deny list: the board (the FVP too), the build and the packs through their CLIs, pip install and curl to the control server', () => {
        const denied = new RegExp(DEFAULT_SHELL_DENY_LIST, 'i');
        for (const command of [
            'pyocd list', 'python3 -m pip install pyocd', 'pip3 install --user pyocd', 'arm-none-eabi-gdb -batch -ex "x/4x 0x20000000" out/app.elf',
            'gdb-multiarch app.elf', 'JLinkExe -device STM32F756ZG', 'JLinkGDBServerCLExe -if SWD', 'openocd -f board.cfg',
            'cbuild Blinky.csolution.yml --packs', 'cpackget add ARM::CMSIS', 'curl -s -H "x-token: t" http://127.0.0.1:52345/op',
            'curl localhost:3001/mcp', 'bash .vscode/fvp.sh -f fvp_config.txt -a out/app.elf', 'docker rm -f cmsis-fvp-3333',
            'docker run --rm --init --name cmsis-fvp-manual cmsis-fvp:11.32.23', 'FVP_Corstone_SSE-300_Ethos-U55 -a out/app.elf',
        ]) {
            assert.ok(denied.test(command), command);
        }
        for (const command of [
            'ls out', 'cat out/app.cbuild-run.yml', 'ls out/*.cbuild-idx.yml', 'git status', 'arm-none-eabi-size out/app.elf',
            'curl https://example.com/data.json | grep localhost', 'docker ps', 'docker images', 'cat fvp_config.txt',
        ]) {
            assert.ok(!denied.test(command), command);
        }
    });

    test('shell commands are read from every shell tool, and only from those', () => {
        const call = (name: string, args: unknown) => ({ name, argBytes: 0, args });
        assert.strictEqual(shellCommandOf(call('bash', { command: 'ls' })), 'ls');
        assert.strictEqual(shellCommandOf(call('powershell', { command: 'Get-ChildItem' })), 'Get-ChildItem');
        assert.strictEqual(shellCommandOf(call('write_bash', { sessionId: '1', input: 'pyocd list\n' })), 'pyocd list\n');
        assert.strictEqual(shellCommandOf(call('bash', '{"command":"ls -la"}')), 'ls -la', 'hook-style JSON text');
        assert.strictEqual(shellCommandOf(call('Bash', { command: 'pyocd list' })), 'pyocd list', 'Kimi Code');
        assert.strictEqual(shellCommandOf(call('cmsis-developer-assistant-flash', { cbuildRunFile: 'x' })), undefined);
        assert.strictEqual(shellCommandOf(call('skill', { skill: 'cmsis-debug-live' })), undefined);
    });

    test('forbidden.shell adds to the default list, defaultShellDenyList false opts out, toolArgs leaves shell commands alone', () => {
        const agg = runOf([
            { toolName: 'bash', arguments: { command: 'arm-none-eabi-nm out/app.elf | grep blink' } },
            { toolName: 'bash', arguments: { command: 'openocd -f board.cfg' } },
            { toolName: 'bash', arguments: { command: 'printf "%s\\n" done' } },
        ]);
        assert.deepStrictEqual(findBypasses({ ...spec, forbidden: { shell: 'arm-none-eabi-nm' } }, agg).map(b => [b.rule, b.command]), [
            ['scenario', 'arm-none-eabi-nm out/app.elf | grep blink'],
            ['default', 'openocd -f board.cfg'],
        ]);
        assert.deepStrictEqual(findBypasses({ ...spec, forbidden: { defaultShellDenyList: false } }, agg), []);
        const reasons = judge({ ...spec, forbidden: { toolArgs: 'printf', defaultShellDenyList: false } }, agg, 60_000).reasons;
        assert.deepStrictEqual(reasons, [], 'a shell printf is no printf in the firmware');
        const edit = runOf([{ toolName: 'str_replace_editor', arguments: { path: 'Blinky/Blinky.c', new_str: 'printf("x");' } }]);
        assert.match(judge(spec, edit, 60_000).reasons[0], /forbidden tool use: str_replace_editor/);
    });

    test('a long command is cut in the report', () => {
        const agg = runOf([{ toolName: 'bash', arguments: { command: `pyocd load ${'x'.repeat(500)}` } }]);
        const [bypass] = findBypasses(spec, agg);
        assert.strictEqual(bypass.command.length, 200);
        assert.ok(bypass.command.endsWith('…'));
    });

    test('the bypass rate counts judged runs only', () => {
        assert.deepStrictEqual(bypassRate([{ bypasses: 2, infraError: false }, { bypasses: 0, infraError: false }, { bypasses: 0, infraError: true }]),
            { judged: 2, withBypass: 1, rate: 0.5 });
        assert.deepStrictEqual(bypassRate([{ bypasses: 0, infraError: true }]), { judged: 0, withBypass: 0, rate: null });
    });

    test('validation checks the forbidden patterns', () => {
        const base = { id: 'x', prompt: 'p', fixture: 'f', expectedRootCause: 'y', targets: ['fvp'], budgets: { maxToolCalls: 1, maxTurns: 1, maxWallMs: 1 } };
        const v = validateScenario({ ...base, forbidden: { shell: '(', defaultShellDenyList: 'no', toolArgs: 'ok' } });
        assert.ok(!v.ok);
        if (!v.ok) {
            assert.deepStrictEqual(v.errors, ['forbidden.shell: not a valid regex', 'forbidden.defaultShellDenyList: boolean']);
        }
        assert.ok(validateScenario({ ...base, forbidden: { shell: 'nm', defaultShellDenyList: false } }).ok);
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

    // --- Kimi Code ---------------------------------------------------------------------------------

    const kimiSample = fs.readFileSync(path.join(repoRoot, 'src', 'test', 'fixtures', 'kimi-stream.sample.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l));

    test('a Kimi stream-json run: tool calls with their results, a turn per assistant message, the final answer and the session id', () => {
        const agg = aggregateKimiStream(kimiSample);
        assert.deepStrictEqual(agg.toolCalls.map(c => c.name),
            ['Skill', 'mcp__cmsis-developer-assistant__get_session_status', 'mcp__cmsis-developer-assistant__diagnose_fault']);
        assert.deepStrictEqual(agg.toolCalls[2].args, { levels: 3 });
        assert.strictEqual(agg.toolCalls[2].argBytes, Buffer.byteLength('{"levels":3}'));
        assert.strictEqual(agg.toolCalls[1].resultBytes, Buffer.byteLength('State: stopped\nSession: Arm-FVP@GDB (launch)\n'));
        assert.strictEqual(agg.turns, 3);
        assert.match(agg.finalAnswer, /^Root cause: DIVBYZERO/);
        assert.strictEqual(agg.sessionId, 'session_0001');
        assert.deepStrictEqual(agg.unknownEventTypes, ['system:?']);
        assert.deepStrictEqual(judge(spec, agg, 60_000), { passed: true, reasons: [], infraError: false });
        assert.deepStrictEqual(judge({ ...spec, expectedTools: ['diagnose_fault'] }, agg, 60_000).passed, true);
    });

    test('a Kimi Bash call to pyocd is a bypass, its arguments read from the JSON text', () => {
        const agg = aggregateKimiStream([
            { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'Bash', arguments: '{"command":"pyocd list","timeout":60}' } }] },
            { role: 'assistant', content: 'Root cause: DIVBYZERO.' },
        ]);
        assert.deepStrictEqual(findBypasses(spec, agg), [{ tool: 'Bash', command: 'pyocd list', rule: 'default' }]);
    });

    test('Kimi token usage is the sum of the turn records of the session log', () => {
        const usage = (inputOther: number, output: number, usageScope?: string) =>
            ({ type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther, output, inputCacheRead: 100 }, ...(usageScope ? { usageScope } : {}) });
        assert.deepStrictEqual(sumKimiUsage([usage(10, 2, 'turn'), { type: 'turn.prompt' }, usage(5, 1), usage(1000, 1000, 'session')]),
            { inputOther: 15, output: 3, inputCacheRead: 200 });
        assert.strictEqual(sumKimiUsage([{ type: 'turn.prompt' }]), undefined);
    });

    test('the Kimi run gets the entry Configure Agent writes', () => {
        assert.deepStrictEqual(kimiMcpEntry('http://localhost:3001/mcp'), { url: 'http://localhost:3001/mcp', toolTimeoutMs: KIMI_TOOL_TIMEOUT_MS });
    });
});
