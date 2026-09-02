#!npx tsx
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

/**
 * Run one evaluation scenario end to end and report what it cost:
 *
 *   npm run eval:scenario -- <scenario-id> [--target fvp|board] [--endpoint URL]
 *                              [--runs N] [--keep] [--no-mcp-config] [--list]
 *
 * A scenario (test/eval/scenarios/<id>.json) names a fixture csolution and an
 * overlay with one planted bug. The runner materialises fixture + overlay in
 * test/eval/.work/<id>/, installs the cmsis-debug-live skill there, registers
 * the MCP server with the Copilot CLI, snapshots the server's tool-call
 * statistics, runs the agent on the scenario prompt, snapshots again, judges
 * the final answer against the expected root cause and the budgets, and
 * writes test/eval/reports/eval.<id>.<timestamp>.json.
 *
 * Deliberately outside `npm test` and CI: it needs an authenticated Copilot
 * CLI (spends AI credits), a VS Code window with the CMSIS Developer
 * Assistant open on the work directory, and an FVP (Docker on macOS) or a
 * board. Infrastructure failures are reported as `infra_error`, not as an
 * agent failure.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { copilotBatchArgs, getCopilotInvocation, parseEvents, run } from './lib/copilotCli.js';
import {
    aggregateEvents, diffTotals, judge, restoreMcpServer, upsertMcpServer, validateScenario,
    ScenarioSpec, TelemetryTotals,
} from '../src/core/evalScenario.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evalRoot = path.join(repoRoot, 'test', 'eval');
const SERVER_NAME = 'cmsis-developer-assistant';
const STATS_URI = 'cmsis-developer-assistant://stats';

interface Options {
    id?: string;
    target: 'fvp' | 'board';
    endpoint: string;
    runs: number;
    keep: boolean;
    mcpConfig: boolean;
    list: boolean;
    waitForWindowMs: number;
}

function parseArgs(argv: string[]): Options {
    const o: Options = { target: 'fvp', endpoint: 'http://localhost:3001/mcp', runs: 1, keep: false, mcpConfig: true, list: false, waitForWindowMs: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i] ?? usage(`${a} needs a value`);
        if (a === '--target') { const t = next(); if (t !== 'fvp' && t !== 'board') { usage('--target fvp|board'); } o.target = t; }
        else if (a === '--endpoint') { o.endpoint = next(); }
        else if (a === '--runs') { o.runs = Math.max(1, Number.parseInt(next(), 10) || 1); }
        else if (a === '--wait-for-window') { o.waitForWindowMs = (Number.parseInt(next(), 10) || 0) * 1000; }
        else if (a === '--keep') { o.keep = true; }
        else if (a === '--no-mcp-config') { o.mcpConfig = false; }
        else if (a === '--list') { o.list = true; }
        else if (a === '--help' || a === '-h') { usage(); }
        else if (a.startsWith('--')) { usage(`unknown option ${a}`); }
        else if (!o.id) { o.id = a; }
        else { usage(`unexpected argument ${a}`); }
    }
    return o;
}

function usage(error?: string): never {
    if (error) { console.error(`error: ${error}\n`); }
    console.error('usage: npm run eval:scenario -- <scenario-id> [--target fvp|board] [--endpoint URL] [--runs N] [--wait-for-window SECONDS] [--keep] [--no-mcp-config]');
    console.error('       npm run eval:scenario -- --list');
    process.exit(error ? 2 : 0);
}

function loadScenario(id: string): ScenarioSpec {
    const file = path.join(evalRoot, 'scenarios', `${id}.json`);
    if (!fs.existsSync(file)) { usage(`no scenario ${id} (see --list)`); }
    const v = validateScenario(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!v.ok) { usage(`${file}: ${v.errors.join('; ')}`); }
    return v.spec;
}

function listScenarios(): void {
    for (const f of fs.readdirSync(path.join(evalRoot, 'scenarios')).filter(f => f.endsWith('.json')).sort()) {
        const v = validateScenario(JSON.parse(fs.readFileSync(path.join(evalRoot, 'scenarios', f), 'utf8')));
        console.log(v.ok ? `${v.spec.id.padEnd(24)} [${v.spec.targets.join(',')}]  ${v.spec.prompt}` : `${f}: INVALID — ${v.errors.join('; ')}`);
    }
}

/** fixture + overlay → work dir; the skill next to it. */
function materialise(spec: ScenarioSpec): string {
    const work = path.join(evalRoot, '.work', spec.id);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const fixture = path.join(evalRoot, 'fixtures', spec.fixture);
    fs.cpSync(fixture, work, { recursive: true, filter: src => !src.includes(`${path.sep}overlays`) && !src.endsWith('README.md') });
    if (spec.overlay) {
        fs.cpSync(path.join(fixture, spec.overlay), work, { recursive: true });
    }
    const skillDir = path.join(work, '.agents', 'skills', 'cmsis-debug-live');
    fs.mkdirSync(path.dirname(skillDir), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'skills', 'cmsis-debug-live'), skillDir, { recursive: true });
    return work;
}

async function withClient<T>(endpoint: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    const client = new Client({ name: 'eval-scenario', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try { return await fn(client); } finally { await client.close().catch(() => undefined); }
}

async function readStats(endpoint: string): Promise<{ session?: TelemetryTotals; server?: TelemetryTotals } | undefined> {
    return withClient(endpoint, async client => {
        const r = await client.readResource({ uri: STATS_URI });
        const text = (r.contents[0] as { text?: unknown } | undefined)?.text;
        return typeof text === 'string' ? JSON.parse(text) : undefined;
    }).catch(() => undefined);
}

/** The window that owns the work dir must be up before the agent starts; wait for it, or explain. */
async function ensureWindow(endpoint: string, work: string, waitMs: number): Promise<string | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const text = await withClient(endpoint, async client => {
            const r = await client.callTool({ name: 'list_debug_windows', arguments: {} });
            return (r.content as Array<{ text?: string }>).map(c => c.text ?? '').join('\n');
        }).catch(err => `<${err instanceof Error ? err.message : String(err)}>`);
        if (text.includes(work)) { return undefined; }
        if (Date.now() >= deadline) {
            return `no CMSIS Developer Assistant window has ${work} open (list_debug_windows: ${text.slice(0, 200).replace(/\n/g, ' | ')}). ` +
                `Open that folder in VS Code with the extension active, let the CMSIS Solution extension generate launch.json, ` +
                `apply the two Arm-FVP launch fixes (see test/eval/README.md), then re-run — or pass --wait-for-window 120.`;
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

function copilotHome(): string {
    return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
}

async function main(): Promise<number> {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.list) { listScenarios(); return 0; }
    if (!opts.id) { usage('scenario id required'); }
    const spec = loadScenario(opts.id);
    if (!spec.targets.includes(opts.target)) {
        console.error(`scenario ${spec.id} is not meant for --target ${opts.target} (targets: ${spec.targets.join(', ')})`);
        return 2;
    }

    const work = materialise(spec);
    console.log(`# scenario ${spec.id} → ${work}`);
    console.log(`# prompt: ${spec.prompt}`);

    const reportsDir = path.join(evalRoot, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    // MCP registration for the Copilot CLI, undone at the end.
    const configPath = path.join(copilotHome(), 'mcp-config.json');
    let restore: (() => void) | undefined;
    if (opts.mcpConfig) {
        const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
        const { config, previous } = upsertMcpServer(existing, SERVER_NAME, { type: 'http', url: opts.endpoint, tools: ['*'] });
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        restore = () => fs.writeFileSync(configPath, JSON.stringify(restoreMcpServer(JSON.parse(fs.readFileSync(configPath, 'utf8')), SERVER_NAME, previous), null, 2) + '\n');
        console.log(`# registered ${SERVER_NAME} → ${opts.endpoint} in ${configPath}`);
    }

    const results: unknown[] = [];
    let anyFail = false;
    try {
        const infra = await ensureWindow(opts.endpoint, work, opts.waitForWindowMs);
        for (let runIndex = 1; runIndex <= opts.runs; runIndex++) {
            const before = await readStats(opts.endpoint);
            const started = Date.now();
            let events: unknown[] = [];
            let runError: string | undefined;
            if (!infra) {
                const copilot = getCopilotInvocation();
                try {
                    const output = run(copilot.command, [...copilot.args, ...copilotBatchArgs(work, spec.prompt)], { cwd: work });
                    events = parseEvents(output);
                    fs.writeFileSync(path.join(reportsDir, `events.${spec.id}.${stamp}.${runIndex}.jsonl`), output);
                } catch (err) {
                    runError = err instanceof Error ? err.message : String(err);
                }
            }
            const wallMs = Date.now() - started;
            const after = await readStats(opts.endpoint);
            const agg = aggregateEvents(events);
            const verdict = judge(spec, agg, wallMs, infra ?? (runError ? `copilot run failed: ${runError.split('\n')[0]}` : undefined));
            const statsDiff = diffTotals(before?.server, after?.server);
            anyFail ||= !verdict.passed;
            results.push({
                run: runIndex, passed: verdict.passed, infraError: verdict.infraError, reasons: verdict.reasons,
                toolCalls: agg.toolCalls.map(c => ({ name: c.name, argBytes: c.argBytes, resultBytes: c.resultBytes })),
                toolCallCount: agg.toolCalls.length, turns: agg.turns, durationMs: wallMs,
                tokenUsage: agg.tokenUsage, unknownEventTypes: agg.unknownEventTypes,
                telemetry: statsDiff ?? 'unavailable',
                expectedToolsSeen: (spec.expectedTools ?? []).filter(t => agg.toolCalls.some(c => c.name.endsWith(t))),
                finalAnswer: agg.finalAnswer,
            });
            console.log(`# run ${runIndex}/${opts.runs}: ${verdict.passed ? 'PASS' : verdict.infraError ? 'INFRA_ERROR' : 'FAIL'} — ` +
                `${agg.toolCalls.length} tool calls, ${agg.turns} turns, ${(wallMs / 1000).toFixed(0)} s` +
                (statsDiff ? `, ${statsDiff.bytesOut} bytes from the server` : '') +
                (verdict.reasons.length ? ` — ${verdict.reasons.join('; ')}` : ''));
            if (verdict.infraError) { break; }
        }
    } finally {
        restore?.();
        if (!opts.keep) { fs.rmSync(work, { recursive: true, force: true }); }
    }

    const report = {
        scenario: spec.id, target: opts.target, endpoint: opts.endpoint, prompt: spec.prompt,
        expectedRootCause: spec.expectedRootCause, rootCause: spec.rootCause, budgets: spec.budgets,
        runs: results, passed: results.length > 0 && !anyFail, workDir: opts.keep ? work : undefined,
    };
    const reportPath = path.join(reportsDir, `eval.${spec.id}.${stamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`# report: ${reportPath}`);
    return report.passed ? 0 : 1;
}

main().then(code => process.exit(code), err => { console.error('FATAL:', err); process.exit(2); });
