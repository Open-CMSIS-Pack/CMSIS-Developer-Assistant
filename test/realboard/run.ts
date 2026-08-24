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

// Real-board test driver for the cmsis-developer-assistant MCP server.
//
// Connects to the running MCP server (over its Streamable HTTP endpoint),
// then exercises every tool against the live debug target. Built-in safety:
//
//   (a) Each test declares an `estimatedMs` runtime estimate. The driver
//       computes a hard timeout = min(2 * estimatedMs, GLOBAL_CAP_MS).
//   (b) If a test's estimate exceeds GLOBAL_CAP_MS, the test is skipped
//       up front with a clear reason.
//   (c) On any timeout the driver PAUSES, runs a diagnostic sweep
//       (get_session_status / check_target_connection / get_fault_info),
//       reports it, and then decides whether to continue or abort.
//
// Run:    npx tsx test/realboard/run.ts [path/to/realboard.config.json]
// or:     node --loader tsx test/realboard/run.ts ...

import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface BoardConfig {
    endpoint: string;
    configurationName?: string;
    workingDirectory: string;
    breakpoint: { fileFullPath: string; lineContent: string };
    memoryProbe: { address: string; length: number };
    peripheralProbe: { peripheral: string; register?: string };
    evaluateProbe: { expression: string };
    serial?: { path: string; baudRate?: number; skipIfMissing?: boolean };
    preferCmsisLoadAndDebug?: boolean;
    globalCapMs?: number;
    abortOnFirstFailure?: boolean;
}

interface TestCase {
    name: string;
    tool: string;
    args?: Record<string, unknown> | (() => Record<string, unknown>);
    /** Pre-flight runtime estimate. Drives the hard timeout. */
    estimatedMs: number;
    /** Override hard timeout. Still capped to GLOBAL_CAP_MS. */
    hardTimeoutMs?: number;
    /** True/string-reason to skip dynamically. */
    skipIf?: (ctx: Ctx) => boolean | string;
    /** Inspect the response text; return true to pass, string for fail reason. */
    validate?: (text: string, ctx: Ctx) => true | string;
    /** Side-effect after a successful call (e.g. capture a frameId). */
    after?: (text: string, ctx: Ctx) => void;
    /** Mark a long-running call so a soft "still running" hint is logged. */
    softHintAfterMs?: number;
}

interface Ctx {
    cfg: BoardConfig;
    capturedFrameId: number | null;
    sessionStarted: boolean;
    serialOpen: boolean;
}

const DEFAULT_CAP_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────
// Test catalog. Phases preserve tool dependencies. Estimates are rough.
// ─────────────────────────────────────────────────────────────────────

function buildTests(cfg: BoardConfig): TestCase[] {
    const useCmsis = cfg.preferCmsisLoadAndDebug !== false;

    return [
        // ── Phase 1: no-session probes ─────────────────────────────────
        { name: 'get_debug_instructions',  tool: 'get_debug_instructions', estimatedMs: 500,
          validate: t => /## Topics/.test(t) || 'overview without the topic list' },
        { name: 'get_debug_instructions (faults)', tool: 'get_debug_instructions', args: { topic: 'faults' }, estimatedMs: 500,
          validate: t => /CFSR/.test(t) || 'faults topic without CFSR' },
        { name: 'lookup_peripheral (no session)', tool: 'lookup_peripheral', estimatedMs: 2000 },
        { name: 'lookup_register (no session)', tool: 'lookup_register', estimatedMs: 2000,
          args: { peripheral: cfg.peripheralProbe.peripheral, register: cfg.peripheralProbe.register ?? '' } },
        { name: 'get_session_status (idle)', tool: 'get_session_status',   estimatedMs: 500 },
        { name: 'check_target_connection (idle)', tool: 'check_target_connection', estimatedMs: 1000 },

        // ── Phase 2: bring up the target ───────────────────────────────
        useCmsis
            ? {
                name: 'cmsis_action load_and_debug',
                tool: 'cmsis_action',
                args: { action: 'load_and_debug' },
                estimatedMs: 30_000, // flash + connect — generous but ≤ 60 s cap
                softHintAfterMs: 15_000,
                after: (_t, ctx) => { ctx.sessionStarted = true; },
            }
            : {
                name: 'start_debugging',
                tool: 'start_debugging',
                args: () => ({
                    workingDirectory: cfg.workingDirectory,
                    configurationName: cfg.configurationName,
                }),
                estimatedMs: 30_000,
                softHintAfterMs: 15_000,
                after: (_t, ctx) => { ctx.sessionStarted = true; },
            },

        // ── Phase 3: state & inspection (target stopped) ───────────────
        { name: 'get_session_status (live)', tool: 'get_session_status', estimatedMs: 1000,
            validate: (t) => /State:\s*(stopped|running|initializing)/.test(t) ? true : `unexpected status:\n${t}` },
        { name: 'check_target_connection (live)', tool: 'check_target_connection', estimatedMs: 5000 },
        { name: 'get_device_info', tool: 'get_device_info', estimatedMs: 2000 },
        { name: 'get_threads', tool: 'get_threads', estimatedMs: 5000 },
        { name: 'get_call_stack', tool: 'get_call_stack', estimatedMs: 5000,
            after: (text, ctx) => {
                const m = text.match(/frameId=(\d+)/);
                if (m) { ctx.capturedFrameId = parseInt(m[1], 10); }
            } },
        { name: 'get_variables_values', tool: 'get_variables_values', args: { scope: 'all' }, estimatedMs: 8000 },
        { name: 'get_frame_variables', tool: 'get_frame_variables',
            args: (ctx => () => ({ frameId: ctx.capturedFrameId ?? 0 }))(undefined as unknown as Ctx),
            estimatedMs: 8000,
            skipIf: (ctx) => ctx.capturedFrameId === null ? 'no frameId captured from get_call_stack' : false },
        { name: 'evaluate_expression', tool: 'evaluate_expression',
            args: () => ({ expression: cfg.evaluateProbe.expression }),
            estimatedMs: 5000 },
        { name: 'read_core_registers', tool: 'read_core_registers', estimatedMs: 15_000,
            softHintAfterMs: 8000 },
        { name: 'read_memory', tool: 'read_memory',
            args: () => ({ address: cfg.memoryProbe.address, length: cfg.memoryProbe.length, format: 'both' }),
            estimatedMs: 10_000 },
        { name: 'read_peripheral_register', tool: 'read_peripheral_register',
            args: () => ({ peripheral: cfg.peripheralProbe.peripheral, ...(cfg.peripheralProbe.register ? { register: cfg.peripheralProbe.register } : {}) }),
            estimatedMs: 15_000, softHintAfterMs: 8000 },
        { name: 'get_fault_info', tool: 'get_fault_info', estimatedMs: 10_000 },
        { name: 'diagnose_fault', tool: 'diagnose_fault', estimatedMs: 20_000,
          validate: t => /=== (Fault diagnosis|No fault flags set) ===/.test(t) || 'no diagnosis header' },

        // ── Phase 4: breakpoints & motion ─────────────────────────────
        { name: 'list_breakpoints (initial)', tool: 'list_breakpoints', estimatedMs: 500 },
        { name: 'add_breakpoint', tool: 'add_breakpoint',
            args: () => ({ fileFullPath: cfg.breakpoint.fileFullPath, lineContent: cfg.breakpoint.lineContent }),
            estimatedMs: 2000 },
        { name: 'list_breakpoints (after add)', tool: 'list_breakpoints', estimatedMs: 500 },
        { name: 'step_over', tool: 'step_over', estimatedMs: 5000 },
        { name: 'step_into', tool: 'step_into', estimatedMs: 5000 },
        { name: 'step_out',  tool: 'step_out',  estimatedMs: 5000 },
        { name: 'continue_execution (until breakpoint)', tool: 'continue_execution',
            estimatedMs: 30_000, softHintAfterMs: 15_000 },
        { name: 'remove_breakpoint', tool: 'remove_breakpoint',
            args: () => {
                // remove the breakpoint that add_breakpoint placed — the line content's
                // line number isn't available without an extra fetch; this is a best-
                // effort cleanup using the same file at line 1 if needed.
                return { fileFullPath: cfg.breakpoint.fileFullPath, line: 1 };
            },
            estimatedMs: 1000 },
        { name: 'clear_all_breakpoints', tool: 'clear_all_breakpoints', estimatedMs: 1000 },
        { name: 'restart_debugging', tool: 'restart_debugging', estimatedMs: 30_000, softHintAfterMs: 15_000 },

        // ── Phase 5: serial (UI passthrough only) ─────────────────────
        { name: 'serial_open_monitor', tool: 'serial_open_monitor', estimatedMs: 1000 },

        // ── Phase 6: teardown ─────────────────────────────────────────
        { name: 'stop_debugging', tool: 'stop_debugging', estimatedMs: 10_000,
            skipIf: (ctx) => !ctx.sessionStarted ? 'no session started' : false },
    ];
}

// ─────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────

function loadConfig(): BoardConfig {
    const arg = process.argv[2];
    const candidates = [
        arg,
        path.join(__dirname, 'realboard.config.json'),
        path.join(process.cwd(), 'realboard.config.json'),
    ].filter(Boolean) as string[];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            console.log(`# config: ${c}`);
            return JSON.parse(fs.readFileSync(c, 'utf8'));
        }
    }
    throw new Error(`No config found. Tried: ${candidates.join(', ')}. ` +
        `Copy realboard.config.example.json → realboard.config.json and edit.`);
}

function textOf(result: any): string {
    const c = result?.content;
    if (Array.isArray(c)) {
        return c.map((p: any) => typeof p?.text === 'string' ? p.text : JSON.stringify(p)).join('\n');
    }
    return JSON.stringify(result);
}

function withTimeout<T>(label: string, ms: number, p: Promise<T>, softHintMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const hint = softHintMs && softHintMs < ms
            ? setTimeout(() => { if (!settled) { console.log(`  · still waiting (>${softHintMs}ms) — ${label}`); } }, softHintMs)
            : null;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; if (hint) { clearTimeout(hint); } reject(new Error(`hard timeout ${ms}ms`)); }
        }, ms);
        p.then(v => {
            if (!settled) { settled = true; clearTimeout(timer); if (hint) { clearTimeout(hint); } resolve(v); }
        }, err => {
            if (!settled) { settled = true; clearTimeout(timer); if (hint) { clearTimeout(hint); } reject(err); }
        });
    });
}

async function diagnose(client: Client): Promise<string> {
    const probes = ['get_session_status', 'check_target_connection', 'get_fault_info'];
    const out: string[] = [];
    for (const tool of probes) {
        try {
            const r = await withTimeout(`diag:${tool}`, 10_000,
                client.callTool({ name: tool, arguments: {} }));
            out.push(`-- ${tool} --\n${textOf(r)}`);
        } catch (e) {
            out.push(`-- ${tool} --\n<diagnostic failed: ${(e as Error).message}>`);
        }
    }
    return out.join('\n\n');
}

interface Result {
    name: string; tool: string;
    status: 'PASS' | 'FAIL' | 'SKIP';
    durationMs?: number;
    detail?: string;
    diagnostics?: string;
}

async function main() {
    const cfg = loadConfig();
    const cap = cfg.globalCapMs ?? DEFAULT_CAP_MS;
    if (cap > 60_000) {
        console.warn(`# warning: globalCapMs=${cap} exceeds the 60 s policy; clamping to 60 000`);
    }
    const globalCap = Math.min(cap, 60_000);

    console.log(`# endpoint: ${cfg.endpoint}`);
    console.log(`# global cap: ${globalCap} ms`);

    const transport = new StreamableHTTPClientTransport(new URL(cfg.endpoint));
    const client = new Client({ name: 'realboard-driver', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const ctx: Ctx = { cfg, capturedFrameId: null, sessionStarted: false, serialOpen: false };
    const tests = buildTests(cfg);
    const results: Result[] = [];

    for (const tc of tests) {
        // Pre-flight: estimate vs cap
        if (tc.estimatedMs > globalCap) {
            const reason = `estimate ${tc.estimatedMs} ms exceeds cap ${globalCap} ms`;
            console.log(`SKIP  ${tc.name}  — ${reason}`);
            results.push({ name: tc.name, tool: tc.tool, status: 'SKIP', detail: reason });
            continue;
        }

        const skip = tc.skipIf?.(ctx);
        if (skip) {
            const reason = typeof skip === 'string' ? skip : 'skipped';
            console.log(`SKIP  ${tc.name}  — ${reason}`);
            results.push({ name: tc.name, tool: tc.tool, status: 'SKIP', detail: reason });
            continue;
        }

        const hardMs = Math.min(tc.hardTimeoutMs ?? Math.max(2 * tc.estimatedMs, 1000), globalCap);
        const args = typeof tc.args === 'function' ? tc.args() : (tc.args ?? {});
        const t0 = Date.now();

        try {
            const result = await withTimeout(tc.name, hardMs,
                client.callTool({ name: tc.tool, arguments: args }),
                tc.softHintAfterMs);
            const dur = Date.now() - t0;
            const text = textOf(result);
            const v = tc.validate?.(text, ctx);
            if (v !== undefined && v !== true) {
                console.log(`FAIL  ${tc.name}  (${dur} ms)  — validation: ${v}`);
                results.push({ name: tc.name, tool: tc.tool, status: 'FAIL', durationMs: dur, detail: String(v) });
                if (cfg.abortOnFirstFailure) { break; }
                continue;
            }
            tc.after?.(text, ctx);
            console.log(`PASS  ${tc.name}  (${dur} ms)`);
            results.push({ name: tc.name, tool: tc.tool, status: 'PASS', durationMs: dur });
        } catch (e) {
            const dur = Date.now() - t0;
            const msg = (e as Error).message;
            console.log(`FAIL  ${tc.name}  (${dur} ms)  — ${msg}`);
            // Strategy (b) + (c): pause and diagnose
            console.log('  · pausing to diagnose…');
            const diag = await diagnose(client).catch(err => `<diagnostic crashed: ${err.message}>`);
            console.log(diag.replace(/^/gm, '    '));
            results.push({ name: tc.name, tool: tc.tool, status: 'FAIL', durationMs: dur, detail: msg, diagnostics: diag });
            if (cfg.abortOnFirstFailure) { break; }
        }
    }

    // Summary
    const pass = results.filter(r => r.status === 'PASS').length;
    const fail = results.filter(r => r.status === 'FAIL').length;
    const skip = results.filter(r => r.status === 'SKIP').length;
    console.log('');
    console.log('=================================================');
    console.log(` ${pass} pass · ${fail} fail · ${skip} skip · ${results.length} total`);
    console.log('=================================================');

    // Tool-call statistics from the server — bytes and time per tool for this
    // run — when the server is new enough to expose them.
    const toolStats = await client.readResource({ uri: 'cmsis-developer-assistant://stats' })
        .then(r => {
            const text = (r.contents[0] as { text?: unknown } | undefined)?.text;
            return typeof text === 'string' ? JSON.parse(text) as { session?: { calls: number; bytesOut: number } } : undefined;
        })
        .catch(() => undefined);
    if (toolStats?.session) {
        console.log(`# tool stats: ${toolStats.session.calls} calls · ${toolStats.session.bytesOut} bytes returned`);
    }

    // JSON report next to the driver
    const reportPath = path.join(__dirname, `realboard.report.${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ endpoint: cfg.endpoint, toolStats, results }, null, 2));
    console.log(`# report: ${reportPath}`);

    await client.close().catch(() => { /* ignore */ });
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(2);
});
