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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { currentCallContext } from '../core/callContext';
import { TEXT_ONLY_CLIENTS, waitSettingOf } from '../core/clientHosting';
import {
    MeasuredMcpServer, PROGRESS_EVERY_MS, WaitClock, clientLimitNote, cutWaitMs, linesMissingFromStructured, toCallToolResult,
} from '../core/measuredMcpServer';
import { ToolMetrics } from '../core/toolMetrics';
import { JsonObject, ToolError, ToolText } from '../core/toolResult';

/** A problem record as it rides along with a failure (#48). */
const PROBLEM: JsonObject = {
    seq: 212, time: '2026-09-24T10:42:07.000Z', source: 'gdb-server', origin: 'CMSIS Debugger: pyOCD', severity: 'error',
    code: 'DAP_POWER_UP_FAILED', message: 'Failed to power up DAP', hint: 'Check the power.',
};

/**
 * The MCP boundary (#11): every outcome a handler can have, as the client
 * receives it through a real MCP session, and the metrics outcome read from
 * the status rather than from the wording.
 */
suite('MeasuredMcpServer results', () => {
    let metrics: ToolMetrics;
    let client: Client;
    let server: MeasuredMcpServer;
    let reached: string[];

    /** One tool per outcome under test; each answers what `outcomes` holds for its name. */
    const outcomes: Record<string, () => Promise<ToolText>> = {
        plain: async () => 'all good',
        cap_text: async () => '\'x\' did not complete within 5 ms (handler-level cap).',
        ok_with_data: async () => ({ text: 'listed', status: 'ok', data: { count: 2 } }),
        ok_without_data: async () => ({ text: 'listed', status: 'ok' }),
        waiting: async () => ({ text: 'Target did not stop within the timeout.', status: 'timeout' }),
        building: async () => ({ text: 'still building', status: 'running', data: { status: 'hijacked', task: 'cbuild' } }),
        refused: async () => {
            throw new ToolError('AMBIGUOUS_WINDOW', 'Two windows qualify.', 'Pick one with select_debug_window.', { candidates: [{ pid: 1 }, { pid: 2 }] });
        },
        stuck: async () => {
            throw new ToolError('TIMEOUT', '\'read_memory\' did not complete within 100 ms (handler-level cap).');
        },
        plain_error: async () => {
            throw new Error('No active debug session.');
        },
        with_problems: async () => {
            throw new ToolError('TASK_FAILED', 'Load failed.', 'Read the terminal.', { problems: [PROBLEM] });
        },
        waited_with_problems: async () => ({ text: 'Target did not stop.', status: 'timeout', data: { problems: [PROBLEM] } }),
        whose_call: async () => JSON.stringify(currentCallContext() ?? null),
    };

    setup(async () => {
        metrics = new ToolMetrics();
        reached = [];
        server = new MeasuredMcpServer({ name: 'measured-test', version: '1.0.0' }, {}, metrics);
        for (const [name, outcome] of Object.entries(outcomes)) {
            server.registerTool(name, { description: name }, async () => {
                reached.push(name);
                return toCallToolResult(await outcome());
            });
        }
        server.registerTool('typed_args', { description: 'needs a number', inputSchema: { n: z.number() } }, async () => {
            reached.push('typed_args');
            return toCallToolResult('fine');
        });
        const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
        await server.connect(serverEnd);
        client = new Client({ name: 'measured-test', version: '1.0.0' });
        await client.connect(clientEnd);
    });

    teardown(async () => {
        await client.close();
        await server.close();
    });

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
        await client.callTool({ name, arguments: args }) as CallToolResult;
    const textOfResult = (result: CallToolResult): string =>
        result.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
    const lastOutcome = (): string => metrics.samples().slice(-1)[0].outcome;

    test('a string is its text alone: no isError, no structuredContent', async () => {
        const result = await call('plain');
        assert.strictEqual(textOfResult(result), 'all good');
        assert.strictEqual(result.isError, undefined);
        assert.strictEqual(result.structuredContent, undefined);
        assert.strictEqual(lastOutcome(), 'ok');
    });

    test('a ToolError is isError, [CODE] message and hint, and structuredContent with its data', async () => {
        const result = await call('refused');
        assert.strictEqual(result.isError, true);
        assert.strictEqual(textOfResult(result), '[AMBIGUOUS_WINDOW] Two windows qualify.\nPick one with select_debug_window.');
        assert.deepStrictEqual(result.structuredContent, {
            status: 'error', error_code: 'AMBIGUOUS_WINDOW', message: 'Two windows qualify.', hint: 'Pick one with select_debug_window.',
            candidates: [{ pid: 1 }, { pid: 2 }],
        });
        assert.strictEqual(lastOutcome(), 'error');
    });

    test('a plain Error thrown by a handler gets a classified code instead of the SDK\'s bare message', async () => {
        const result = await call('plain_error');
        assert.strictEqual(result.isError, true);
        assert.strictEqual(textOfResult(result), '[NO_SESSION] No active debug session.');
        assert.deepStrictEqual(result.structuredContent, { status: 'error', error_code: 'NO_SESSION', message: 'No active debug session.' });
    });

    test('a reply that is running or out of time carries its status and message, and is not an error', async () => {
        const waiting = await call('waiting');
        assert.strictEqual(waiting.isError, undefined);
        assert.strictEqual(textOfResult(waiting), 'Target did not stop within the timeout.');
        assert.deepStrictEqual(waiting.structuredContent, { status: 'timeout', message: 'Target did not stop within the timeout.' });
        assert.strictEqual(lastOutcome(), 'timeout');

        // A data key never overwrites the status or the message.
        const building = await call('building');
        assert.deepStrictEqual(building.structuredContent, { status: 'running', message: 'still building', task: 'cbuild' });
        assert.strictEqual(lastOutcome(), 'ok');
    });

    test('an ok reply carries structuredContent, with its text as message, only when it has data', async () => {
        assert.deepStrictEqual((await call('ok_with_data')).structuredContent, { status: 'ok', message: 'listed', count: 2 });
        const bare = await call('ok_without_data');
        assert.strictEqual(bare.structuredContent, undefined);
        assert.strictEqual(textOfResult(bare), 'listed');
    });

    test('every structuredContent carries the text: a client may show the model that object alone', async () => {
        for (const name of Object.keys(outcomes)) {
            const result = await call(name);
            assert.deepStrictEqual(linesMissingFromStructured(result), [], name);
        }
        const hidden: CallToolResult = { content: [{ type: 'text', text: 'listed\n#3 error dap' }], structuredContent: { status: 'ok', message: 'listed' } };
        assert.deepStrictEqual(linesMissingFromStructured(hidden), ['#3 error dap'], 'a line only the text has is found');
    });

    test('the metrics outcome comes from the status first, the wording only without one', async () => {
        await call('stuck');
        assert.strictEqual(lastOutcome(), 'timeout', 'a TIMEOUT error counts as a timeout');
        await call('cap_text');
        assert.strictEqual(lastOutcome(), 'timeout', 'a text without status falls back to the markers');
        const stuck = metrics.totals().perTool.stuck;
        assert.deepStrictEqual([stuck.timeouts, stuck.errors], [1, 0]);
    });

    test('schema errors stay the SDK\'s and never reach the handler', async () => {
        const result = await call('typed_args', { n: 'not a number' });
        assert.strictEqual(result.isError, true);
        assert.match(textOfResult(result), /Input validation error/);
        assert.deepStrictEqual(reached, []);
    });

    test('no tool declares an outputSchema', async () => {
        const listed = await client.listTools();
        assert.ok(listed.tools.length > 0);
        assert.deepStrictEqual(listed.tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => tool.name), []);
    });

    test('every call gets an id, the session\'s first 8 characters and a count, and its handler runs in that call context (#48)', async () => {
        // The in-memory transport has no session id.
        assert.deepStrictEqual(JSON.parse(textOfResult(await call('whose_call'))), { callId: 'local-1' });
        await call('plain');
        assert.deepStrictEqual(JSON.parse(textOfResult(await call('whose_call'))), { callId: 'local-3' });
        assert.strictEqual(currentCallContext(), undefined, 'the context ends with the call');
    });

    test('the problems that ride along with a failure or a timeout are listed under the text (#48)', async () => {
        const failed = await call('with_problems');
        assert.strictEqual(textOfResult(failed), '[TASK_FAILED] Load failed.\nRead the terminal.\n'
            + 'Recent problems:\n  #212 error gdb-server [DAP_POWER_UP_FAILED] Failed to power up DAP → Check the power.');
        assert.deepStrictEqual((failed.structuredContent as JsonObject).problems, [PROBLEM]);
        assert.strictEqual((failed.structuredContent as JsonObject).message, 'Load failed.', 'the message stays the message');
        const waited = await call('waited_with_problems');
        assert.ok(textOfResult(waited).startsWith('Target did not stop.\nRecent problems:\n  #212 error gdb-server'));
        assert.deepStrictEqual(waited.structuredContent, { status: 'timeout', message: 'Target did not stop.', problems: [PROBLEM] });
    });
});

/**
 * The result shape per client: a client that shows the model the text and
 * the `structuredContent` after it (the Copilot SDK agent, tester feedback on
 * 2.7.0-preview3) gets the text alone; every other client the whole result.
 */
suite('MeasuredMcpServer results for a text-only client', () => {
    const TEXT_ONLY = 'text-only-client';
    const outcomes: Record<string, () => Promise<ToolText>> = {
        ok_with_data: async () => ({ text: 'listed', status: 'ok', data: { count: 2 } }),
        building: async () => ({ text: 'still building', status: 'running', data: { task: 'cbuild' } }),
        waiting: async () => ({ text: 'Target did not stop.', status: 'timeout', data: { problems: [PROBLEM] } }),
        refused: async () => {
            throw new ToolError('AMBIGUOUS_WINDOW', 'Two windows qualify.', 'Pick one with select_debug_window.', { candidates: [{ pid: 1 }, { pid: 2 }] });
        },
        plain_error: async () => {
            throw new Error('No active debug session.');
        },
    };
    /** What another client receives as `structuredContent`, as `toCallToolResult` builds it. */
    const structured: Record<string, JsonObject> = {
        ok_with_data: { status: 'ok', message: 'listed', count: 2 },
        building: { status: 'running', message: 'still building', task: 'cbuild' },
        waiting: { status: 'timeout', message: 'Target did not stop.', problems: [PROBLEM] },
        refused: {
            status: 'error', error_code: 'AMBIGUOUS_WINDOW', message: 'Two windows qualify.', hint: 'Pick one with select_debug_window.',
            candidates: [{ pid: 1 }, { pid: 2 }],
        },
        plain_error: { status: 'error', error_code: 'NO_SESSION', message: 'No active debug session.' },
    };
    const open: Array<{ client: Client; server: MeasuredMcpServer }> = [];

    /** A session of a client named `clientName`, on a server that answers `TEXT_ONLY` with text alone. */
    const sessionOf = async (clientName: string): Promise<{ call: (name: string) => Promise<CallToolResult>; metrics: ToolMetrics }> => {
        const metrics = new ToolMetrics();
        const server = new MeasuredMcpServer({ name: 'text-only-test', version: '1.0.0' }, {}, metrics, [TEXT_ONLY]);
        for (const [name, outcome] of Object.entries(outcomes)) {
            server.registerTool(name, { description: name }, async () => toCallToolResult(await outcome()));
        }
        const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
        await server.connect(serverEnd);
        const client = new Client({ name: clientName, version: '1.0.0' });
        await client.connect(clientEnd);
        open.push({ client, server });
        return { call: async (name) => await client.callTool({ name, arguments: {} }) as CallToolResult, metrics };
    };

    teardown(async () => {
        for (const { client, server } of open.splice(0)) {
            await client.close();
            await server.close();
        }
    });

    test('a listed client gets ok, running, timeout and error results without structuredContent; text and isError stay', async () => {
        const listed = await sessionOf(TEXT_ONLY);
        const other = await sessionOf('another-client');
        for (const name of Object.keys(outcomes)) {
            const full = await other.call(name);
            const textOnly = await listed.call(name);
            assert.deepStrictEqual(full.structuredContent, structured[name], `${name}: another client's result is unchanged`);
            assert.strictEqual(textOnly.structuredContent, undefined, name);
            const rest: CallToolResult = { ...full };
            delete rest.structuredContent;
            assert.deepStrictEqual(textOnly, rest, `${name}: the same text and isError`);
        }
        const failed = await listed.call('refused');
        assert.strictEqual(failed.isError, true);
        assert.deepStrictEqual(failed.content, [{ type: 'text', text: '[AMBIGUOUS_WINDOW] Two windows qualify.\nPick one with select_debug_window.' }]);
    });

    test('the outcome is classified from the whole result, and the bytes are those the client receives', async () => {
        const listed = await sessionOf(TEXT_ONLY);
        const other = await sessionOf('another-client');
        for (const name of Object.keys(outcomes)) {
            await listed.call(name);
            await other.call(name);
        }
        const outcomesOf = (metrics: ToolMetrics): string[] => metrics.samples().map((sample) => `${sample.tool}=${sample.outcome}`);
        assert.deepStrictEqual(outcomesOf(listed.metrics), ['ok_with_data=ok', 'building=ok', 'waiting=timeout', 'refused=error', 'plain_error=error']);
        assert.deepStrictEqual(outcomesOf(listed.metrics), outcomesOf(other.metrics));
        const bytes = (metrics: ToolMetrics): number[] => metrics.samples().map((sample) => sample.resultBytes);
        bytes(listed.metrics).forEach((size, i) => assert.ok(size < bytes(other.metrics)[i], `${Object.keys(outcomes)[i]}: ${size} B`));
    });

    test('the name matches exactly, in the case the client sends it', async () => {
        for (const name of ['Text-Only-Client', ' text-only-client', 'text-only-client-2']) {
            assert.deepStrictEqual((await (await sessionOf(name)).call('ok_with_data')).structuredContent, structured.ok_with_data, name);
        }
    });
});

/**
 * An input a session adds to some of its tools (#16: the router's `window`):
 * it joins the named tools after their own inputs and reaches their callback.
 */
suite('MeasuredMcpServer added arguments', () => {
    let client: Client;
    let server: MeasuredMcpServer;
    let received: unknown[];

    setup(async () => {
        received = [];
        server = new MeasuredMcpServer({ name: 'added-test', version: '1.0.0' }, {}, new ToolMetrics());
        server.addArgument('window', z.string().optional().describe('Which window'), new Set(['aimed', 'bare']));
        const keep = async (args: unknown): Promise<CallToolResult> => {
            received.push(args);
            return toCallToolResult('fine');
        };
        server.registerTool('aimed', { description: 'takes the argument', inputSchema: { n: z.number() } }, keep);
        server.registerTool('plain', { description: 'does not', inputSchema: { n: z.number() } }, keep);
        const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
        await server.connect(serverEnd);
        client = new Client({ name: 'added-test', version: '1.0.0' });
        await client.connect(clientEnd);
    });

    teardown(async () => {
        await client.close();
        await server.close();
    });

    test('the named tools list it after their own inputs; the others do not', async () => {
        const listed = await client.listTools();
        const properties = (name: string): string[] => Object.keys(listed.tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {});
        assert.deepStrictEqual(properties('aimed'), ['n', 'window']);
        assert.deepStrictEqual(properties('plain'), ['n']);
    });

    test('its value reaches the callback with the other arguments', async () => {
        await client.callTool({ name: 'aimed', arguments: { n: 1, window: '4711' } });
        await client.callTool({ name: 'aimed', arguments: { n: 2 } });
        assert.deepStrictEqual(received, [{ n: 1, window: '4711' }, { n: 2 }]);
    });

    test('a named tool without an input shape cannot take it', () => {
        assert.throws(() => server.registerTool('bare', { description: 'no inputs' }, async () => toCallToolResult('fine')),
            /Tool bare declares no input shape, so it cannot take window/);
    });
});

/**
 * Long waits against the client's own request timeout (tester feedback on
 * 2.7.0-preview3: the Copilot SDK agent gave up on a 600 s cmsis_action
 * status after 180 s and lost the reply). The SDK client below times out and
 * cancels for real; the clock that measures the call is the test's.
 */
suite('MeasuredMcpServer and the client\'s request timeout', () => {
    /** A clock the test moves; `every` keeps its ticks for the test to fire. */
    class TestClock implements WaitClock {
        at = 1_000_000;
        readonly ticks = new Set<() => void>();
        now(): number {
            return this.at;
        }
        every(_ms: number, tick: () => void): () => void {
            this.ticks.add(tick);
            return () => this.ticks.delete(tick);
        }
        /** Move by `ms` and fire every tick once, as the interval would. */
        advance(ms: number): void {
            this.at += ms;
            [...this.ticks].forEach((tick) => tick());
        }
    }

    let clock: TestClock;
    let logged: string[];
    let client: Client;
    let server: MeasuredMcpServer;
    /** The arguments each callback received, in call order. */
    let received: Array<Record<string, unknown>>;
    /** Calls in flight: each resolves with the outcome the test hands it. */
    let pending: Array<(outcome: ToolText | ToolError) => void>;

    /** A tool that waits until the test answers it. */
    const waiting = async (args: Record<string, unknown>): Promise<CallToolResult> => {
        received.push(args);
        const outcome = await new Promise<ToolText | ToolError>((answer) => pending.push(answer));
        return toCallToolResult(outcome);
    };

    setup(async () => {
        clock = new TestClock();
        logged = [];
        received = [];
        pending = [];
        server = new MeasuredMcpServer({ name: 'limit-test', version: '1.0.0' }, {}, new ToolMetrics(), TEXT_ONLY_CLIENTS,
            { clock, log: (line) => logged.push(line) });
        const timeoutShape = { timeoutMs: z.number().optional() };
        server.declareWait('cmsis_action', { defaultMs: (args) => (args.action === 'build' ? 60_000 : 30_000) });
        server.declareWait('flash', { endsWork: true });
        server.registerTool('long_wait', { description: 'waits', inputSchema: timeoutShape }, waiting);
        server.registerTool('cmsis_action', { description: 'waits', inputSchema: { action: z.string(), ...timeoutShape } }, waiting);
        server.registerTool('flash', { description: 'waits', inputSchema: timeoutShape }, waiting);
        server.registerTool('no_timeout', { description: 'waits', inputSchema: { n: z.number().optional() } }, waiting);
        const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
        await server.connect(serverEnd);
        client = new Client({ name: 'limit-test', version: '1.0.0' });
        await client.connect(clientEnd);
    });

    teardown(async () => {
        pending.splice(0).forEach((answer) => answer('released'));
        await client.close();
        await server.close();
    });

    /** Resolves once `ready()` holds, polled on the event loop; fails after 2 s. */
    const until = async (ready: () => boolean, what: string): Promise<void> => {
        const end = Date.now() + 2_000;
        while (!ready()) {
            assert.ok(Date.now() < end, `still waiting for ${what}`);
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    };
    const textOf = (result: CallToolResult): string => result.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
    const call = (name: string, args: Record<string, unknown>, options?: Parameters<Client['callTool']>[2]): Promise<CallToolResult> =>
        client.callTool({ name, arguments: args }, undefined, options) as Promise<CallToolResult>;

    /** A call the client gives up on after `elapsedMs` on the test's clock: the SDK client's own timeout cancels it. */
    const giveUpAfter = async (elapsedMs: number): Promise<void> => {
        const calls = received.length;
        const gaveUp = call('long_wait', { timeoutMs: 600_000 }, { timeout: 60 }).then(() => undefined, (failure: unknown) => failure);
        await until(() => received.length > calls, 'the callback');
        clock.at += elapsedMs;
        const failure = await gaveUp;
        assert.match(String(failure), /MCP error -32001: Request timed out/);
        await new Promise((resolve) => setTimeout(resolve, 10));
        pending.shift()?.('the late answer nobody reads');
    };

    /** A call answered with `outcome`: the arguments its callback received and its result. */
    const answered = async (name: string, args: Record<string, unknown>, outcome: ToolText | ToolError): Promise<[Record<string, unknown>, CallToolResult]> => {
        const calls = received.length;
        const result = call(name, args);
        await until(() => received.length > calls && pending.length > 0, 'the callback');
        pending.shift()?.(outcome);
        return [received[calls], await result];
    };

    const RUNNING: ToolText = { text: 'still building', status: 'running', data: { job: 3 } };

    test('the cut: 10 s under the limit in whole seconds, never under half of it or 1 s', () => {
        assert.deepStrictEqual([180_000, 179_970, 60_000, 12_000, 400].map(cutWaitMs), [170_000, 170_000, 50_000, 6_000, 1_000]);
        assert.strictEqual(clientLimitNote('cmsis_action', 179_970, 170_000),
            'Note: your MCP client stops waiting after about 180 s, so this wait was cut to 170 s; '
            + 'the work goes on — call cmsis_action {action:\'status\'} again.');
        assert.strictEqual(clientLimitNote('read_memory', 60_000, 50_000, waitSettingOf('kimi-code')),
            'Note: your MCP client stops waiting after about 60 s, so this wait was cut to 50 s; the work goes on — repeat the call for its result. '
            + 'To wait longer, give this server\'s entry in Kimi Code\'s mcp.json a toolTimeoutMs, as Configure Agent writes it: '
            + 'run CMSIS Developer Assistant: Configure Agent, then start a new Kimi session.');
        assert.strictEqual(waitSettingOf('claude-code'), undefined);
        assert.strictEqual(waitSettingOf(undefined), undefined);
    });

    test('a call the client gives up on with a timeout teaches the limit; a longer wait is then cut and its reply says so', async () => {
        assert.strictEqual(server.clientLimit(), undefined);
        await giveUpAfter(180_000);
        assert.strictEqual(server.clientLimit(), 180_000);
        assert.deepStrictEqual(logged, ['MCP session local: the client gave up on long_wait after 180 s; long waits are cut to 170 s']);

        const [args, result] = await answered('long_wait', { timeoutMs: 600_000 }, RUNNING);
        assert.deepStrictEqual(args, { timeoutMs: 170_000 });
        const note = 'Note: your MCP client stops waiting after about 180 s, so this wait was cut to 170 s; '
            + 'the work goes on — repeat the call for its result.';
        assert.strictEqual(textOf(result), `still building\n${note}`);
        assert.deepStrictEqual(result.structuredContent, { status: 'running', message: `still building\n${note}`, job: 3 });
        assert.deepStrictEqual(linesMissingFromStructured(result), []);
    });

    test('a wait within the limit, a tool without timeoutMs and one whose work ends with its wait are untouched', async () => {
        await giveUpAfter(180_000);
        const [within, withinResult] = await answered('long_wait', { timeoutMs: 170_000 }, RUNNING);
        assert.deepStrictEqual(within, { timeoutMs: 170_000 });
        assert.strictEqual(textOf(withinResult), 'still building');
        const [unset] = await answered('long_wait', {}, RUNNING);
        assert.deepStrictEqual(unset, {}, 'no timeoutMs and no declared default: the wait is unknown, so it stays');
        const [other] = await answered('no_timeout', { n: 1 }, RUNNING);
        assert.deepStrictEqual(other, { n: 1 });
        const [flashed, flashResult] = await answered('flash', { timeoutMs: 600_000 }, { text: 'Flash timed out', status: 'timeout' });
        assert.deepStrictEqual(flashed, { timeoutMs: 600_000 });
        assert.strictEqual(textOf(flashResult), 'Flash timed out');
    });

    test('a declared default counts as the wait; a call that ends within the cut wait gets no note', async () => {
        await giveUpAfter(40_000);
        assert.strictEqual(cutWaitMs(40_000), 30_000);
        const [build, buildResult] = await answered('cmsis_action', { action: 'build' }, RUNNING);
        assert.deepStrictEqual(build, { action: 'build', timeoutMs: 30_000 });
        assert.match(textOf(buildResult), /\nNote: your MCP client stops waiting after about 40 s, so this wait was cut to 30 s; the work goes on — call cmsis_action \{action:'status'\} again\.$/);
        const [detach] = await answered('cmsis_action', { action: 'detach' }, 'detached');
        assert.deepStrictEqual(detach, { action: 'detach' }, 'a 30 s default is within the cut');
        const [done, doneResult] = await answered('cmsis_action', { action: 'build', timeoutMs: 600_000 }, { text: 'Build ✅', status: 'ok', data: { exit: 0 } });
        assert.deepStrictEqual(done, { action: 'build', timeoutMs: 30_000 });
        assert.deepStrictEqual([textOf(doneResult), doneResult.structuredContent?.message], ['Build ✅', 'Build ✅']);
    });

    test('a cut wait that ends in a TIMEOUT error carries the note above its problems, in the text and the message', async () => {
        await giveUpAfter(180_000);
        const stuck = new ToolError('TIMEOUT', '\'long_wait\' did not complete within 170000 ms.', 'Call it again.', { problems: [PROBLEM] });
        const [, result] = await answered('long_wait', { timeoutMs: 600_000 }, stuck);
        const lines = textOf(result).split('\n');
        assert.deepStrictEqual(lines.slice(0, 4), [
            '[TIMEOUT] \'long_wait\' did not complete within 170000 ms.', 'Call it again.',
            'Note: your MCP client stops waiting after about 180 s, so this wait was cut to 170 s; the work goes on — repeat the call for its result.',
            'Recent problems:',
        ]);
        assert.strictEqual(result.isError, true);
        assert.match(String(result.structuredContent?.message), /^'long_wait' did not complete within 170000 ms\.\nNote: /);
        assert.deepStrictEqual(linesMissingFromStructured(result), []);
    });

    test('the shortest limit is kept, and logged when it changes', async () => {
        await giveUpAfter(180_000);
        await giveUpAfter(200_000);
        assert.strictEqual(server.clientLimit(), 180_000);
        await giveUpAfter(60_000);
        assert.strictEqual(server.clientLimit(), 60_000);
        assert.deepStrictEqual(logged, [
            'MCP session local: the client gave up on long_wait after 180 s; long waits are cut to 170 s',
            'MCP session local: the client gave up on long_wait after 60 s; long waits are cut to 50 s',
        ]);
    });

    test('a cancellation that does not name a timeout, such as a user\'s stop, teaches nothing', async () => {
        const stop = new AbortController();
        const stopped = call('long_wait', { timeoutMs: 600_000 }, { signal: stop.signal }).then(() => undefined, (failure: unknown) => failure);
        await until(() => pending.length > 0, 'the callback');
        clock.at += 180_000;
        stop.abort('The user stopped the agent.');
        assert.match(String(await stopped), /The user stopped the agent\./);
        await new Promise((resolve) => setTimeout(resolve, 10));
        pending.shift()?.('late');
        assert.strictEqual(server.clientLimit(), undefined);
        assert.deepStrictEqual(logged, []);
        const [args] = await answered('long_wait', { timeoutMs: 600_000 }, RUNNING);
        assert.deepStrictEqual(args, { timeoutMs: 600_000 });
    });

    test('a request with a progress token hears every 15 s once the call has run that long, until it settles', async () => {
        const heard: Array<{ progress: number; message?: string }> = [];
        const result = call('long_wait', {}, { onprogress: ({ progress, message }) => heard.push({ progress, message }) });
        await until(() => pending.length > 0, 'the callback');
        assert.strictEqual(clock.ticks.size, 1);
        clock.advance(5_000);
        clock.advance(PROGRESS_EVERY_MS);
        clock.advance(PROGRESS_EVERY_MS);
        await until(() => heard.length === 2, 'two progress notifications');
        assert.deepStrictEqual(heard, [
            { progress: 20, message: 'long_wait still waiting: 20 s' },
            { progress: 35, message: 'long_wait still waiting: 35 s' },
        ]);
        pending.shift()?.('done');
        assert.strictEqual(textOf(await result), 'done');
        assert.strictEqual(clock.ticks.size, 0, 'the ticks stop when the call settles');
        clock.advance(PROGRESS_EVERY_MS);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.strictEqual(heard.length, 2);
    });

    test('a request without a progress token hears nothing, and a cancelled call stops its ticks', async () => {
        const quiet = call('long_wait', {});
        await until(() => pending.length > 0, 'the callback');
        assert.strictEqual(clock.ticks.size, 0, 'no token, no ticks');
        pending.shift()?.('done');
        await quiet;

        const heard: number[] = [];
        const stop = new AbortController();
        const stopped = call('long_wait', {}, { signal: stop.signal, onprogress: ({ progress }) => heard.push(progress) }).catch(() => undefined);
        await until(() => pending.length > 0, 'the callback');
        assert.strictEqual(clock.ticks.size, 1);
        stop.abort('stopped');
        await stopped;
        await until(() => clock.ticks.size === 0, 'the ticks to stop on the cancellation');
        pending.shift()?.('late');
        assert.deepStrictEqual(heard, []);
    });
});
