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
 * scenario validation, aggregation of a Copilot CLI JSON event stream or a
 * Kimi Code stream-json run into tool calls / turns / final answer, the shell
 * commands that bypass the MCP tools (#50), the verdict, and the MCP-config
 * edits the runner makes. No I/O, no vscode, so it is unit-tested; the runner
 * itself needs an authenticated agent CLI and a target and is not.
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
    forbidden?: {
        /** Regex over the name and JSON arguments of every tool call that is not a shell command (MCP tools, skills). */
        toolArgs?: string;
        answer?: string;
        /** Regex over the command of every shell-tool call, on top of the default deny list. */
        shell?: string;
        /** false: the default shell deny list does not apply to this scenario. */
        defaultShellDenyList?: boolean;
    };
    budgets: { maxToolCalls: number; maxTurns: number; maxWallMs: number };
    /** For the report reader, never shown to the agent. */
    rootCause?: string;
}

function isRegex(source: unknown): boolean {
    if (typeof source !== 'string') { return false; }
    try { new RegExp(source, 'i'); return true; } catch { return false; }
}

export function validateScenario(raw: unknown): { ok: true; spec: ScenarioSpec } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const o = (raw ?? {}) as Record<string, unknown>;
    const str = (k: string) => typeof o[k] === 'string' && (o[k] as string).length > 0;
    if (!str('id') || !/^[a-z0-9-]+$/.test(o.id as string)) { errors.push('id: lowercase letters, digits and dashes'); }
    if (!str('prompt')) { errors.push('prompt: required'); }
    if (!str('fixture')) { errors.push('fixture: required'); }
    if (!str('expectedRootCause')) { errors.push('expectedRootCause: required regex'); }
    else if (!isRegex(o.expectedRootCause)) { errors.push('expectedRootCause: not a valid regex'); }
    const targets = o.targets;
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every(t => t === 'fvp' || t === 'board')) { errors.push("targets: non-empty array of 'fvp' | 'board'"); }
    const b = o.budgets as Record<string, unknown> | undefined;
    for (const k of ['maxToolCalls', 'maxTurns', 'maxWallMs']) {
        if (!b || typeof b[k] !== 'number' || (b[k] as number) <= 0) { errors.push(`budgets.${k}: positive number`); }
    }
    if (o.expectedTools !== undefined && (!Array.isArray(o.expectedTools) || !o.expectedTools.every(t => typeof t === 'string'))) { errors.push('expectedTools: array of strings'); }
    if (o.forbidden !== undefined) {
        const f = o.forbidden as Record<string, unknown> | null;
        if (!f || typeof f !== 'object' || Array.isArray(f)) {
            errors.push('forbidden: object');
        } else {
            for (const k of ['toolArgs', 'answer', 'shell']) {
                if (f[k] !== undefined && !isRegex(f[k])) { errors.push(`forbidden.${k}: not a valid regex`); }
            }
            if (f.defaultShellDenyList !== undefined && typeof f.defaultShellDenyList !== 'boolean') { errors.push('forbidden.defaultShellDenyList: boolean'); }
        }
    }
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

/**
 * The shell commands every scenario fails on unless it opts out
 * (`forbidden.defaultShellDenyList: false`): the board, the build and the
 * packs through their own CLIs, installing pyOCD, and curl against the
 * control server (#50, #45). Proposal 50's list with two corrections: `cbuild`
 * followed by `-` is a file name (`app.cbuild-run.yml`), not the command, and
 * curl may take options before the URL. The simulated board counts as the
 * board: an FVP model run as a command (not a file such as `fvp_config.txt`),
 * the fixture's model shim `fvp.sh`, and a docker
 * command that starts or ends a container (a Kimi Code run started the model
 * by hand and removed the extension's container). Matched case-insensitively.
 */
export const DEFAULT_SHELL_DENY_LIST =
    String.raw`\b(pyocd|arm-none-eabi-gdb|gdb-multiarch|JLink(Exe|GDBServer\w*)|openocd|cbuild(?!-)|cpackget|pip3? install)\b`
    + String.raw`|\bcurl\b[^|;&\n]*\b(localhost|127\.0\.0\.1)`
    + String.raw`|\bFVP_[\w-]+(?=\s|$)|\bfvp\.sh\b|\bdocker\s+(run|rm|kill|stop|start|exec)\b`;

/**
 * The agent tools that run shell commands, and the argument that holds the
 * command. Copilot CLI: `bash` (macOS, Linux) and `powershell` (Windows) with
 * `command` follow the hook input its documentation shows (toolName "bash",
 * toolArgs {"command": …}); `shell`, and the `write_*` tools that type into a
 * running shell, are assumptions to check against a recorded run. Kimi Code:
 * `Bash` with `command` (MoonshotAI/kimi-code `agent/tools/os/bash` at
 * 743f140, and its recorded sessions).
 */
const SHELL_TOOLS: ReadonlyMap<string, string> = new Map([
    ['bash', 'command'],
    ['Bash', 'command'],
    ['powershell', 'command'],
    ['shell', 'command'],
    ['write_bash', 'input'],
    ['write_powershell', 'input'],
]);

/** Longest command text a report keeps per bypass. */
const COMMAND_CHARS = 200;

/** The command of a shell-tool call; undefined for every other tool (MCP tools, skills, file edits). */
export function shellCommandOf(call: ToolCallRecord): string | undefined {
    const field = SHELL_TOOLS.get(call.name);
    if (field === undefined) { return undefined; }
    let args = call.args;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return args as string; }
    }
    const value = args && typeof args === 'object' ? (args as Record<string, unknown>)[field] : undefined;
    return typeof value === 'string' ? value : JSON.stringify(args ?? '');
}

/** A shell command that did what an MCP tool is there for. */
export interface ShellBypass {
    tool: string;
    /** The command, cut at 200 characters. */
    command: string;
    /** What caught it: the default deny list, or the scenario's `forbidden.shell`. */
    rule: 'default' | 'scenario';
}

/** Every shell-tool call of the run that the deny list or `forbidden.shell` matches, in call order. */
export function findBypasses(spec: ScenarioSpec, agg: EvalAggregate): ShellBypass[] {
    const rules: Array<{ rule: ShellBypass['rule']; re: RegExp }> = [];
    if (spec.forbidden?.defaultShellDenyList !== false) { rules.push({ rule: 'default', re: new RegExp(DEFAULT_SHELL_DENY_LIST, 'i') }); }
    if (spec.forbidden?.shell) { rules.push({ rule: 'scenario', re: new RegExp(spec.forbidden.shell, 'i') }); }
    const bypasses: ShellBypass[] = [];
    for (const call of agg.toolCalls) {
        const command = shellCommandOf(call);
        const hit = command === undefined ? undefined : rules.find(({ re }) => re.test(command));
        if (command !== undefined && hit) {
            bypasses.push({ tool: call.name, command: command.length > COMMAND_CHARS ? `${command.slice(0, COMMAND_CHARS - 1)}…` : command, rule: hit.rule });
        }
    }
    return bypasses;
}

/** The share of judged runs — infrastructure failures left out — with at least one bypass; `rate` is null without a judged run. */
export function bypassRate(runs: ReadonlyArray<{ bypasses: number; infraError: boolean }>): { judged: number; withBypass: number; rate: number | null } {
    const judged = runs.filter(run => !run.infraError);
    const withBypass = judged.filter(run => run.bypasses > 0).length;
    return { judged: judged.length, withBypass, rate: judged.length > 0 ? withBypass / judged.length : null };
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
        // Shell commands are judged below: an MCP flash call whose arguments name app.cbuild-run.yml is no bypass.
        const re = new RegExp(spec.forbidden.toolArgs, 'i');
        const hit = agg.toolCalls.find(c => shellCommandOf(c) === undefined && (re.test(c.name) || re.test(JSON.stringify(c.args ?? ''))));
        if (hit) { reasons.push(`forbidden tool use: ${hit.name}`); }
    }
    for (const bypass of findBypasses(spec, agg)) {
        reasons.push(`shell bypass (${bypass.rule === 'default' ? 'default deny list' : 'forbidden.shell'}): ${bypass.tool}: ${bypass.command}`);
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

// ---------------------------------------------------------------------------
// Kimi Code
// ---------------------------------------------------------------------------

/**
 * The entry a Kimi Code run gets in its work copy's `.kimi-code/mcp.json`:
 * the one *Configure Agent* writes (`ENTRY_SHAPES` in
 * src/utils/agentConfigurationManager.ts), so that a run measures what users
 * get. Without `toolTimeoutMs` Kimi ends every tool call after 60 s.
 */
export function kimiMcpEntry(url: string): { url: string; toolTimeoutMs: number } {
    return { url, toolTimeoutMs: 630_000 };
}

/** A Kimi run's aggregate, and the session id its resume hint names, where the session log is. */
export interface KimiAggregate extends EvalAggregate {
    sessionId?: string;
}

/**
 * Aggregate a Kimi Code `kimi -p … --output-format stream-json` run. Each
 * line is a chat message (MoonshotAI/kimi-code
 * `apps/kimi-code/src/cli/prompt-render.ts` at 743f140): an assistant
 * message per model step, `{role: 'assistant', content?, tool_calls?: [{id,
 * function: {name, arguments}}]}` with the arguments as JSON text; a tool
 * message per result, `{role: 'tool', tool_call_id, content}`; and meta lines
 * (`turn.step.retrying`, `system.version`, `session.resume_hint` with the
 * session id). Thinking is not in the stream, nor is token usage, which the
 * session log has (`sumKimiUsage`). Every assistant message counts as a turn.
 */
export function aggregateKimiStream(lines: unknown[]): KimiAggregate {
    const toolCalls: ToolCallRecord[] = [];
    const byId = new Map<string, ToolCallRecord>();
    let turns = 0;
    let finalAnswer = '';
    let sessionId: string | undefined;
    const unknown = new Set<string>();

    for (const raw of lines) {
        if (!raw || typeof raw !== 'object') { continue; }
        const line = raw as Record<string, unknown>;
        if (line.role === 'assistant') {
            turns += 1;
            if (typeof line.content === 'string' && line.content.trim()) { finalAnswer = line.content; }
            for (const call of Array.isArray(line.tool_calls) ? line.tool_calls : []) {
                const fn = (call as { function?: { name?: unknown; arguments?: unknown } }).function ?? {};
                const text = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
                let args: unknown = text;
                try { args = JSON.parse(text); } catch { /* kept as text */ }
                const rec: ToolCallRecord = { name: String(fn.name ?? 'unknown'), argBytes: Buffer.byteLength(text), args };
                toolCalls.push(rec);
                const id = (call as { id?: unknown }).id;
                if (typeof id === 'string') { byId.set(id, rec); }
            }
        } else if (line.role === 'tool') {
            const rec = typeof line.tool_call_id === 'string' ? byId.get(line.tool_call_id) : undefined;
            if (rec) { rec.resultBytes = Buffer.byteLength(textOf(line.content)); }
        } else if (line.role === 'meta' && line.type === 'session.resume_hint') {
            sessionId = typeof line.session_id === 'string' ? line.session_id : undefined;
        } else if (line.role === 'meta' && (line.type === 'system.version' || line.type === 'turn.step.retrying')) {
            // lifecycle
        } else {
            unknown.add(`${String(line.role ?? '?')}:${String(line.type ?? '?')}`);
        }
    }
    return { toolCalls, turns, finalAnswer, eventCount: lines.length, unknownEventTypes: [...unknown].sort(), sessionId };
}

/**
 * The token usage of a Kimi session: the sum of the `usage.record` events of
 * its log (`agents/<agent>/wire.jsonl`), one per turn, each with `usage`
 * counts such as `inputOther`, `output`, `inputCacheRead`. Records of another
 * scope than `turn` are left out, so that nothing is counted twice; undefined
 * when there is none.
 */
export function sumKimiUsage(events: unknown[]): Record<string, number> | undefined {
    const total: Record<string, number> = {};
    let any = false;
    for (const raw of events) {
        const event = raw as { type?: unknown; usageScope?: unknown; usage?: unknown } | null;
        if (!event || event.type !== 'usage.record' || (event.usageScope !== undefined && event.usageScope !== 'turn')) { continue; }
        if (!event.usage || typeof event.usage !== 'object') { continue; }
        for (const [key, value] of Object.entries(event.usage as Record<string, unknown>)) {
            if (typeof value === 'number') {
                total[key] = (total[key] ?? 0) + value;
                any = true;
            }
        }
    }
    return any ? total : undefined;
}
