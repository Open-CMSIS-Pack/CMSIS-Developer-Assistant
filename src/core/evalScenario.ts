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
 * The pure half of the agent evaluation runner (scripts/eval-scenario.ts):
 * scenario validation, aggregation of a Copilot CLI JSON event stream into
 * tool calls / turns / final answer, the verdict, and the MCP-config edit the
 * runner makes and undoes. No I/O, no vscode, so it is unit-tested; the
 * runner itself needs an authenticated agent CLI and a target and is not.
 */

export interface ScenarioSpec {
    id: string;
    prompt: string;
    fixture: string;
    /** Directory copied over the fixture, relative to the fixture root. */
    overlay?: string;
    targets: Array<'fvp' | 'board'>;
    /** Regex the final answer must match. */
    expectedRootCause: string;
    /** Tools expected to appear at least once (advisory, reported not enforced). */
    expectedTools?: string[];
    forbidden?: { toolArgs?: string; answer?: string };
    budgets: { maxToolCalls: number; maxTurns: number; maxWallMs: number };
    /** For the report reader, never shown to the agent. */
    rootCause?: string;
}

export function validateScenario(raw: unknown): { ok: true; spec: ScenarioSpec } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const o = (raw ?? {}) as Record<string, unknown>;
    const str = (k: string) => typeof o[k] === 'string' && (o[k] as string).length > 0;
    if (!str('id') || !/^[a-z0-9-]+$/.test(o.id as string)) { errors.push('id: lowercase letters, digits and dashes'); }
    if (!str('prompt')) { errors.push('prompt: required'); }
    if (!str('fixture')) { errors.push('fixture: required'); }
    if (!str('expectedRootCause')) { errors.push('expectedRootCause: required regex'); }
    else { try { new RegExp(o.expectedRootCause as string, 'i'); } catch { errors.push('expectedRootCause: not a valid regex'); } }
    const targets = o.targets;
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every(t => t === 'fvp' || t === 'board')) { errors.push("targets: non-empty array of 'fvp' | 'board'"); }
    const b = o.budgets as Record<string, unknown> | undefined;
    for (const k of ['maxToolCalls', 'maxTurns', 'maxWallMs']) {
        if (!b || typeof b[k] !== 'number' || (b[k] as number) <= 0) { errors.push(`budgets.${k}: positive number`); }
    }
    if (o.expectedTools !== undefined && (!Array.isArray(o.expectedTools) || !o.expectedTools.every(t => typeof t === 'string'))) { errors.push('expectedTools: array of strings'); }
    return errors.length ? { ok: false, errors } : { ok: true, spec: o as unknown as ScenarioSpec };
}

export interface ToolCallRecord {
    name: string;
    argBytes: number;
    /** Bytes of the tool result when the stream carried it. */
    resultBytes?: number;
    args?: unknown;
}

export interface EvalAggregate {
    toolCalls: ToolCallRecord[];
    /** Assistant messages, i.e. reasoning turns. */
    turns: number;
    finalAnswer: string;
    eventCount: number;
    /** Event types the aggregator did not recognise, for refining it from a recorded run. */
    unknownEventTypes: string[];
    tokenUsage?: Record<string, number>;
}

const textOf = (v: unknown): string => {
    if (typeof v === 'string') { return v; }
    if (Array.isArray(v)) { return v.map(textOf).join(''); }
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        for (const k of ['text', 'content', 'message', 'output', 'result']) {
            if (k in o) { return textOf(o[k]); }
        }
        return JSON.stringify(v);
    }
    return v === undefined || v === null ? '' : String(v);
};

/**
 * Aggregate a Copilot CLI `--output-format json` stream. Only
 * `tool.execution_start` is documented by use in scripts/test-skill-trigger.ts;
 * the other shapes are read defensively and anything unrecognised is listed
 * so the aggregator can be refined from a recorded run.
 */
export function aggregateEvents(events: unknown[]): EvalAggregate {
    const toolCalls: ToolCallRecord[] = [];
    const byId = new Map<string, ToolCallRecord>();
    let turns = 0;
    let finalAnswer = '';
    let tokenUsage: Record<string, number> | undefined;
    const unknown = new Set<string>();

    for (const raw of events) {
        if (!raw || typeof raw !== 'object') { continue; }
        const ev = raw as { type?: string; data?: Record<string, unknown> };
        const type = ev.type ?? '';
        const data = ev.data ?? {};
        if (type === 'tool.execution_start') {
            const args = data.arguments;
            const rec: ToolCallRecord = {
                name: String(data.toolName ?? data.name ?? 'unknown'),
                argBytes: args === undefined ? 0 : Buffer.byteLength(JSON.stringify(args)),
                args,
            };
            toolCalls.push(rec);
            const id = data.toolCallId ?? data.id ?? data.callId;
            if (typeof id === 'string') { byId.set(id, rec); }
        } else if (/^tool\.(execution_complete|execution_end|result|execution_error)$/.test(type)) {
            const id = data.toolCallId ?? data.id ?? data.callId;
            const rec = (typeof id === 'string' && byId.get(id)) || toolCalls[toolCalls.length - 1];
            if (rec) { rec.resultBytes = Buffer.byteLength(textOf(data.result ?? data.output ?? data.content ?? data.error ?? '')); }
        } else if (/^(assistant\.(message|turn_end|turn\.end)|message|assistant\.message_end)$/.test(type)) {
            turns += 1;
            const text = textOf(data.content ?? data.text ?? data.message ?? '');
            if (text.trim()) { finalAnswer = text; }
        } else if (/usage/.test(type)) {
            tokenUsage = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
        } else if (/^(session\.|turn\.start|user\.|assistant\.reasoning|assistant\.message_delta)/.test(type)) {
            // lifecycle noise
        } else if (type) {
            unknown.add(type);
        }
    }
    return { toolCalls, turns, finalAnswer, eventCount: events.length, unknownEventTypes: [...unknown].sort(), tokenUsage };
}

export interface TelemetryTotals {
    calls: number;
    bytesOut: number;
    bytesIn: number;
    ms: number;
    perTool: Record<string, { calls: number; ms: number; bytesOut: number; timeouts: number; errors: number }>;
}

/** Per-tool difference between two stats snapshots. */
export function diffTotals(before: TelemetryTotals | undefined, after: TelemetryTotals | undefined): TelemetryTotals | undefined {
    if (!after) { return undefined; }
    const b = before ?? { calls: 0, bytesOut: 0, bytesIn: 0, ms: 0, perTool: {} };
    const perTool: TelemetryTotals['perTool'] = {};
    for (const [tool, a] of Object.entries(after.perTool)) {
        const p = b.perTool[tool] ?? { calls: 0, ms: 0, bytesOut: 0, timeouts: 0, errors: 0 };
        const d = { calls: a.calls - p.calls, ms: a.ms - p.ms, bytesOut: a.bytesOut - p.bytesOut, timeouts: a.timeouts - p.timeouts, errors: a.errors - p.errors };
        if (d.calls > 0) { perTool[tool] = d; }
    }
    return { calls: after.calls - b.calls, bytesOut: after.bytesOut - b.bytesOut, bytesIn: after.bytesIn - b.bytesIn, ms: after.ms - b.ms, perTool };
}

export interface Verdict {
    passed: boolean;
    reasons: string[];
    /** True when the failure is the setup, not the agent. */
    infraError: boolean;
}

export function judge(spec: ScenarioSpec, agg: EvalAggregate, wallMs: number, infra?: string): Verdict {
    if (infra) { return { passed: false, reasons: [`infra: ${infra}`], infraError: true }; }
    const reasons: string[] = [];
    if (!new RegExp(spec.expectedRootCause, 'i').test(agg.finalAnswer)) {
        reasons.push(`final answer does not match /${spec.expectedRootCause}/i`);
    }
    if (agg.toolCalls.length > spec.budgets.maxToolCalls) {
        reasons.push(`${agg.toolCalls.length} tool calls > budget ${spec.budgets.maxToolCalls}`);
    }
    if (agg.turns > spec.budgets.maxTurns) {
        reasons.push(`${agg.turns} turns > budget ${spec.budgets.maxTurns}`);
    }
    if (wallMs > spec.budgets.maxWallMs) {
        reasons.push(`${wallMs} ms > budget ${spec.budgets.maxWallMs} ms`);
    }
    if (spec.forbidden?.toolArgs) {
        const re = new RegExp(spec.forbidden.toolArgs, 'i');
        const hit = agg.toolCalls.find(c => re.test(c.name) || re.test(JSON.stringify(c.args ?? '')));
        if (hit) { reasons.push(`forbidden tool use: ${hit.name}`); }
    }
    if (spec.forbidden?.answer && new RegExp(spec.forbidden.answer, 'i').test(agg.finalAnswer)) {
        reasons.push('final answer matches the forbidden pattern');
    }
    return { passed: reasons.length === 0, reasons, infraError: false };
}

export interface McpServerEntry { type: 'http'; url: string; tools: string[] }

/**
 * Add or replace the server entry in a Copilot CLI mcp-config.json object.
 * Returns the new config and what was there before, so the runner can put it back.
 */
export function upsertMcpServer(config: unknown, name: string, entry: McpServerEntry): { config: Record<string, unknown>; previous: unknown } {
    const base = (config && typeof config === 'object' ? { ...(config as Record<string, unknown>) } : {}) as Record<string, unknown>;
    const servers = { ...((base.mcpServers as Record<string, unknown>) ?? {}) };
    const previous = servers[name];
    servers[name] = entry;
    return { config: { ...base, mcpServers: servers }, previous };
}

/** Undo upsertMcpServer: restore the previous entry or remove ours. */
export function restoreMcpServer(config: unknown, name: string, previous: unknown): Record<string, unknown> {
    const base = (config && typeof config === 'object' ? { ...(config as Record<string, unknown>) } : {}) as Record<string, unknown>;
    const servers = { ...((base.mcpServers as Record<string, unknown>) ?? {}) };
    if (previous === undefined) { delete servers[name]; } else { servers[name] = previous; }
    return { ...base, mcpServers: servers };
}
