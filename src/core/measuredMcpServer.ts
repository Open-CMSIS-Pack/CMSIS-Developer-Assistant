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
 * The MCP boundary of every tool: the measurement of each call, its call id
 * and call context (#48), the one place where a handler's outcome becomes an
 * MCP result (`toCallToolResult`), the shape of that result for the session's
 * client, the inputs a session adds to some of its tools (`addArgument`), and
 * long waits fitted to the client: progress while a call is pending, and waits
 * cut to the time the client is known to give up after.
 */

import { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { runInCallContext } from './callContext';
import { TEXT_ONLY_CLIENTS, waitSettingOf, wantsTextOnly } from './clientHosting';
import { renderProblemsBlock } from './problemFeed';
import { ToolMetrics, classifyOutcome } from './toolMetrics';
import { JsonObject, ToolError, ToolText, errorText, toToolError } from './toolResult';

type ServerInfo = ConstructorParameters<typeof McpServer>[0];
type ServerOptions = ConstructorParameters<typeof McpServer>[1];
/**
 * The base signature is generic over the zod shapes; the wrapper only needs to
 * know whether an input schema exists, so it accepts the config wide and
 * hands it through untouched.
 */
type RegisterToolConfig = {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: unknown;
    _meta?: Record<string, unknown>;
};
type AnyToolCallback = (...callArgs: unknown[]) => CallToolResult | Promise<CallToolResult>;

/** An input a session adds to the inputs some of its tools declare themselves. */
interface AddedArgument {
    name: string;
    /** A zod schema, as in a tool's own input shape. */
    schema: unknown;
    tools: ReadonlySet<string>;
}

/** What the wrapper reads of the request extra the SDK hands a tool callback. */
interface CallExtra {
    sessionId?: string;
    /** Aborted when the client cancels the request (`notifications/cancelled`) or the connection closes. */
    signal?: AbortSignal;
    _meta?: { progressToken?: string | number };
    sendNotification?: (notification: ServerNotification) => Promise<void>;
}

/** The clock and timer behind progress and the client's limit; tests pass their own. */
export interface WaitClock {
    now(): number;
    /** Calls `tick` every `ms` until the returned function is called. */
    every(ms: number, tick: () => void): () => void;
}

const SYSTEM_CLOCK: WaitClock = {
    now: () => Date.now(),
    every: (ms, tick) => {
        const timer = setInterval(tick, ms);
        timer.unref();
        return () => clearInterval(timer);
    },
};

/** What the handling of long waits takes from outside: a clock, and where the learned limit is logged. */
export interface LongWaitOptions {
    clock?: WaitClock;
    /** Receives the line written when the session learns its client's limit. */
    log?: (line: string) => void;
}

/**
 * How a tool's wait relates to its work, for a session whose client gives up
 * sooner (`MeasuredMcpServer.declareWait`).
 */
export interface WaitDeclaration {
    /** The wait of a call without `timeoutMs`; without it, only a call that names a longer `timeoutMs` is cut. */
    defaultMs?: (args: Record<string, unknown>) => number;
    /** The work ends with the wait, as `flash` kills pyOCD at its budget: a cut would end it early, so there is none. */
    endsWork?: boolean;
}

/** A pending call with a progress token hears from the server this often, once it has run that long. */
export const PROGRESS_EVERY_MS = 15_000;
/** Kept back from the client's limit when a wait is cut to it. */
const CLIENT_LIMIT_MARGIN_S = 10;
/** An abort reason that says the client's own timer ran out: the SDK's "Request timed out", code -32001. */
const CLIENT_TIMEOUT_REASON = /timed out|-32001/i;
/** The text that follows a cut wait's note, per tool: how to pick up the result of the work that goes on. */
const PICK_UP: Readonly<Record<string, string>> = {
    cmsis_action: 'call cmsis_action {action:\'status\'} again',
};
const PICK_UP_OTHERS = 'repeat the call for its result';

/**
 * The wait a session cuts long waits to once its client gave up after
 * `limitMs`: 10 s less, in whole seconds, but never under half the limit or 1 s.
 */
export function cutWaitMs(limitMs: number): number {
    const limitS = Math.round(limitMs / 1000);
    return Math.max(limitS - CLIENT_LIMIT_MARGIN_S, Math.ceil(limitS / 2), 1) * 1000;
}

/** The line a call whose wait was cut gets when the wait ran out; `setting`, the client's own wait setting, closes it. */
export function clientLimitNote(tool: string, limitMs: number, cutMs: number, setting?: string): string {
    return `Note: your MCP client stops waiting after about ${Math.round(limitMs / 1000)} s, so this wait was cut to ${cutMs / 1000} s; `
        + `the work goes on — ${PICK_UP[tool] ?? PICK_UP_OTHERS}.${setting === undefined ? '' : ` ${setting}`}`;
}

/** Whether a zod input shape declares the input `name`. */
function declaresInput(shape: unknown, name: string): boolean {
    return typeof shape === 'object' && shape !== null && !('_zod' in shape) && !('_def' in shape) && name in shape;
}

/** "Recent problems:" and its records, which close a text when they ride along (`renderProblemsBlock`). */
const PROBLEMS_BLOCK = /\nRecent problems:\n[\s\S]*$/;

/**
 * The result with `line` as the last line of its text, ahead of a "Recent
 * problems:" block, and of `structuredContent.message`, which carries the text.
 */
function withLine(result: CallToolResult, line: string): CallToolResult {
    const content = [...(result.content ?? [])];
    const at = content.findIndex((item) => item.type === 'text');
    const first = at < 0 ? undefined : content[at];
    if (first?.type === 'text') {
        const block = PROBLEMS_BLOCK.exec(first.text);
        const head = block ? first.text.slice(0, block.index) : first.text;
        content[at] = { ...first, text: `${head}\n${line}${block ? block[0] : ''}` };
    } else {
        content.push({ type: 'text', text: line });
    }
    const structured = result.structuredContent;
    if (structured === undefined) {
        return { ...result, content };
    }
    const message = typeof structured.message === 'string' ? `${structured.message}\n${line}` : line;
    return { ...result, content, structuredContent: { ...structured, message } };
}

/** `base`, then the keys of `data` that do not collide with it: a detail never overwrites the status. */
function withDetail(base: JsonObject, data: JsonObject | undefined): JsonObject {
    const merged: JsonObject = { ...base };
    for (const [key, value] of Object.entries(data ?? {})) {
        if (!(key in merged)) {
            merged[key] = value;
        }
    }
    return merged;
}

/**
 * The MCP result of a handler's outcome, the only place where one is built:
 *
 * - a string: that text alone; the absence of `isError` says it succeeded;
 * - a `ToolReply` with status `ok`: its text, plus `structuredContent`
 *   `{status: 'ok', message, ...data}` only when it has data;
 * - a `ToolReply` that is `running` or `timeout`: its text, and
 *   `structuredContent` `{status, message, ...data}`; neither is a failure;
 * - a `ToolError`: `[CODE] message` and the hint on the next line, `isError`,
 *   and `structuredContent` `{status: 'error', error_code, message, hint, ...data}`.
 *
 * Every `structuredContent` carries the text as `message` (and a failure's
 * hint as `hint`): some MCP clients hand the model
 * `structuredContent` instead of `content`, so the object has to say
 * everything the text says. The problem records that ride along with a
 * failure or a timeout (#48, `data.problems`) are also listed under the
 * text, as "Recent problems:".
 *
 * No tool declares an `outputSchema`, so `tools/list` does not grow; the SDK
 * passes `structuredContent` through without one, and a session may leave it
 * out: `MeasuredMcpServer` does for the clients in `TEXT_ONLY_CLIENTS`.
 */
export function toCallToolResult(outcome: ToolText | ToolError): CallToolResult {
    if (outcome instanceof ToolError) {
        const described: JsonObject = { status: 'error', error_code: outcome.code, message: outcome.message };
        if (outcome.hint) {
            described.hint = outcome.hint;
        }
        return {
            content: [{ type: 'text', text: errorText(outcome) + renderProblemsBlock(outcome.data?.problems) }],
            isError: true,
            structuredContent: withDetail(described, outcome.data),
        };
    }
    if (typeof outcome === 'string') {
        return { content: [{ type: 'text', text: outcome }] };
    }
    const content: CallToolResult['content'] = [{ type: 'text', text: outcome.text + renderProblemsBlock(outcome.data?.problems) }];
    if (outcome.status === 'ok') {
        return outcome.data === undefined
            ? { content }
            : { content, structuredContent: withDetail({ status: 'ok', message: outcome.text }, outcome.data) };
    }
    return { content, structuredContent: withDetail({ status: outcome.status, message: outcome.text }, outcome.data) };
}

/**
 * The lines of a result's text that its `structuredContent` does not carry,
 * none when it has no `structuredContent`. A line counts as carried when it
 * is part of `message` or `hint`; the `[CODE]` prefix of a failure's first
 * line is `error_code`, and the "Recent problems:" block is `problems`. The
 * surface harness and the unit tests hold every result to an empty answer.
 */
export function linesMissingFromStructured(result: CallToolResult): string[] {
    const structured = result.structuredContent;
    if (structured === undefined || structured === null) {
        return [];
    }
    const text = (result.content ?? []).map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    const said = [structured.message, structured.hint].filter((part): part is string => typeof part === 'string').join('\n');
    const shown = text.replace(/\nRecent problems:\n[\s\S]*$/, '');
    return shown.split('\n')
        .map((line, index) => (index === 0 && result.isError === true ? line.replace(/^\[[A-Z_]+\] /, '') : line))
        .filter((line) => line.trim() !== '' && !said.includes(line));
}

/**
 * An McpServer that measures every registered tool and answers every failure
 * with a typed result.
 *
 * The wrapper sits at the MCP boundary, so what it sees is exactly what the
 * client sees: the arguments after schema parsing, the result after every
 * handler, redaction and routing step, and the wall time including any
 * forward to another window. Registration is untouched — callers keep using
 * `registerTool(name, config, cb)` with literal names, which the skill test
 * greps for — except that a session can add one input to a set of tools
 * (`addArgument`), as a router session adds `window` (#16).
 *
 * A callback that throws is answered here, through `toCallToolResult`, rather
 * than by the SDK, whose error result would carry the message alone. Schema
 * errors are raised by the SDK before the callback runs and stay its own.
 *
 * A session whose client sent a name in the text-only list (by default
 * `TEXT_ONLY_CLIENTS`) gets every result without `structuredContent`: such a
 * client shows the model the text and the object after it, and the object
 * repeats the text. The outcome is classified before, from the whole result.
 *
 * Every call gets an id, `<first 8 characters of the session id>-<n>` (#48),
 * and the callback runs in a call context with that id and the session id
 * (`src/core/callContext.ts`): the router copies both into the control
 * envelope, and the problem journal stamps its records with the id.
 *
 * Long waits meet the client's own request timeout here, which the server
 * cannot ask for. A call whose request carries a progress token gets a
 * progress notification every 15 s while it is pending. A call the client
 * cancels with a timeout as the reason (the SDK client's "Request timed out")
 * teaches the session how long its client waits; from then on, a wait longer
 * than that less 10 s is cut to it before the callback runs (`cutWaitMs`), and
 * when the cut wait runs out, the reply says so in one line
 * (`clientLimitNote`): the work goes on, and its result is not lost with a
 * reply the client no longer reads. A cancellation for another reason teaches
 * nothing.
 *
 * Nothing here depends on vscode; logging and sinks hang off the metrics'
 * onSample callback and the `log` of `LongWaitOptions`.
 */
export class MeasuredMcpServer extends McpServer {
    private readonly addedArguments: AddedArgument[] = [];
    private readonly waits = new Map<string, WaitDeclaration>();
    /** Calls of this server so far; each server serves one MCP session. */
    private calls = 0;
    /** The shortest call this session's client gave up on with a timeout, in ms; undefined until one. */
    private clientLimitMs: number | undefined;
    private readonly clock: WaitClock;
    private readonly log: ((line: string) => void) | undefined;

    /**
     * @param textOnlyClients the client names whose sessions get results
     *   without `structuredContent`; tests pass their own.
     * @param longWaits the clock of progress and of the client's limit, and
     *   where the learned limit is logged.
     */
    constructor(
        serverInfo: ServerInfo,
        options: ServerOptions,
        private readonly metrics: ToolMetrics,
        private readonly textOnlyClients: readonly string[] = TEXT_ONLY_CLIENTS,
        longWaits: LongWaitOptions = {},
    ) {
        super(serverInfo, options);
        this.clock = longWaits.clock ?? SYSTEM_CLOCK;
        this.log = longWaits.log;
    }

    /**
     * Say how the wait of `tool` relates to its work, for the cut to the
     * client's limit: the wait of a call without `timeoutMs`, or that the work
     * ends with the wait. Only a tool that declares `timeoutMs` is ever cut.
     */
    public declareWait(tool: string, declaration: WaitDeclaration): void {
        this.waits.set(tool, declaration);
    }

    /** The time this session's client gave up after, in ms; undefined until it did. */
    public clientLimit(): number | undefined {
        return this.clientLimitMs;
    }

    /**
     * Give each tool named in `tools` that is registered from now on one more
     * input, `name` with the zod `schema`, after the inputs it declares. The
     * value reaches the tool's callback with its other arguments. Only a tool
     * that declares an input shape can take one; registering another throws.
     */
    public addArgument(name: string, schema: unknown, tools: ReadonlySet<string>): void {
        this.addedArguments.push({ name, schema, tools });
    }

    /** The id of the next call: the session's first 8 characters (`local` without a session) and a count. */
    private nextCallId(sessionId: string | undefined): string {
        this.calls += 1;
        return `${sessionId ? sessionId.slice(0, 8) : 'local'}-${this.calls}`;
    }

    public override registerTool(name: string, declared: RegisterToolConfig, cb: unknown): RegisteredTool {
        const config = this.withAddedArguments(name, declared);
        // Tools without an input schema receive only the request extra; tools
        // with one receive (args, extra).
        const hasArgs = config.inputSchema !== undefined;
        const takesTimeout = declaresInput(config.inputSchema, 'timeoutMs');
        const original = cb as AnyToolCallback;
        const metrics = this.metrics;

        const measured: AnyToolCallback = async (...callArgs: unknown[]) => {
            const started = Date.now();
            const args = hasArgs ? callArgs[0] : undefined;
            const extra = (hasArgs ? callArgs[1] : callArgs[0]) as CallExtra | undefined;
            const argBytes = args === undefined ? 0 : Buffer.byteLength(JSON.stringify(args));
            const context = { callId: this.nextCallId(extra?.sessionId), ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}) };
            const cut = takesTimeout ? this.cutWait(name, args) : undefined;
            const passed = cut === undefined ? callArgs : [{ ...(args as Record<string, unknown>), timeoutMs: cut.waitMs }, ...callArgs.slice(1)];
            const unwatch = this.watchCall(name, extra);
            let result: CallToolResult;
            try {
                result = await runInCallContext(context, () => original(...passed));
            } catch (err) {
                result = toCallToolResult(toToolError(err));
            } finally {
                unwatch();
            }
            const text = (result.content ?? [])
                .map((item) => (item.type === 'text' ? item.text : ''))
                .join('');
            const outcome = classifyOutcome(text, result.isError === true, result.structuredContent);
            // The note only where the cut wait ran out: a call that ended within it has nothing going on.
            if (cut !== undefined && (outcome === 'timeout' || result.structuredContent?.status === 'running')) {
                result = withLine(result, cut.note);
            }
            const delivered = this.shapedForClient(result);
            metrics.record({
                tool: name,
                argBytes,
                resultBytes: Buffer.byteLength(JSON.stringify(delivered)),
                ms: Date.now() - started,
                outcome,
                at: Date.now(),
                sessionId: extra?.sessionId,
            });
            return delivered;
        };

        // The base signature is generic over the zod shapes; the wrapper is
        // shape-agnostic, so hand it over untyped rather than re-deriving them.
        const register = super.registerTool as unknown as (
            this: McpServer, n: string, c: RegisterToolConfig, f: AnyToolCallback,
        ) => RegisteredTool;
        return register.call(this, name, config, measured);
    }

    /**
     * The cut of this call's wait, once the client's limit is known: the wait
     * it gets instead and the note its reply carries if that runs out.
     * Undefined while no limit is known, for a wait within it, for one whose
     * length is unknown (no `timeoutMs`, no declared default), and for a tool
     * whose work ends with its wait.
     */
    private cutWait(tool: string, args: unknown): { waitMs: number; note: string } | undefined {
        const declared = this.waits.get(tool);
        if (this.clientLimitMs === undefined || declared?.endsWork === true) {
            return undefined;
        }
        const given = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
        const named = typeof given.timeoutMs === 'number' && given.timeoutMs > 0 ? given.timeoutMs : undefined;
        const waitMs = named ?? declared?.defaultMs?.(given);
        const cutMs = cutWaitMs(this.clientLimitMs);
        if (waitMs === undefined || waitMs <= cutMs) {
            return undefined;
        }
        return { waitMs: cutMs, note: clientLimitNote(tool, this.clientLimitMs, cutMs, waitSettingOf(this.server.getClientVersion()?.name)) };
    }

    /**
     * Watch one pending call until the returned function is called: a progress
     * notification every `PROGRESS_EVERY_MS` when the request carries a
     * progress token, and the client's limit when it cancels the call because
     * its own timer ran out. Both end when the call settles or is cancelled.
     */
    private watchCall(tool: string, extra: CallExtra | undefined): () => void {
        const signal = extra?.signal;
        if (signal === undefined || signal.aborted) {
            return () => undefined;
        }
        const begun = this.clock.now();
        const token = extra?._meta?.progressToken;
        const send = extra?.sendNotification;
        let stopProgress: () => void = () => undefined;
        if (token !== undefined && send !== undefined) {
            stopProgress = this.clock.every(PROGRESS_EVERY_MS, () => {
                const elapsedMs = this.clock.now() - begun;
                if (elapsedMs < PROGRESS_EVERY_MS) {
                    return;
                }
                const seconds = Math.round(elapsedMs / 1000);
                send({ method: 'notifications/progress', params: { progressToken: token, progress: seconds, message: `${tool} still waiting: ${seconds} s` } })
                    .catch(() => undefined);
            });
        }
        const onAbort = (): void => {
            stopProgress();
            if (CLIENT_TIMEOUT_REASON.test(String(signal.reason))) {
                this.learnClientLimit(tool, this.clock.now() - begun, extra?.sessionId);
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        return () => {
            stopProgress();
            signal.removeEventListener('abort', onAbort);
        };
    }

    /** The client gave up on a call of `tool` after `elapsedMs`: keep the shortest such time, and log it when the seconds change. */
    private learnClientLimit(tool: string, elapsedMs: number, sessionId: string | undefined): void {
        const before = this.clientLimitMs;
        if (before !== undefined && before <= elapsedMs) {
            return;
        }
        this.clientLimitMs = elapsedMs;
        if (before !== undefined && Math.round(before / 1000) === Math.round(elapsedMs / 1000)) {
            return;
        }
        this.log?.(`MCP session ${sessionId ?? 'local'}: the client gave up on ${tool} after ${Math.round(elapsedMs / 1000)} s; `
            + `long waits are cut to ${cutWaitMs(elapsedMs) / 1000} s`);
    }

    /**
     * The result as this session's client takes it: without
     * `structuredContent` when the name the client sent with `initialize` is
     * in the text-only list, else unchanged. Text and `isError` always stay.
     */
    private shapedForClient(result: CallToolResult): CallToolResult {
        if (result.structuredContent === undefined || !wantsTextOnly(this.server.getClientVersion()?.name, this.textOnlyClients)) {
            return result;
        }
        const textOnly: CallToolResult = { ...result };
        delete textOnly.structuredContent;
        return textOnly;
    }

    /** The tool's config with the added arguments that name it appended to its input shape. */
    private withAddedArguments(tool: string, config: RegisterToolConfig): RegisterToolConfig {
        const added = this.addedArguments.filter((argument) => argument.tools.has(tool));
        if (added.length === 0) {
            return config;
        }
        const shape = config.inputSchema;
        // A zod schema object (it carries `_zod` or `_def`) is not a shape whose keys are the inputs.
        if (typeof shape !== 'object' || shape === null || '_zod' in shape || '_def' in shape) {
            throw new Error(`Tool ${tool} declares no input shape, so it cannot take ${added.map((argument) => argument.name).join(', ')}`);
        }
        const inputSchema: Record<string, unknown> = { ...(shape as Record<string, unknown>) };
        for (const argument of added) {
            inputSchema[argument.name] = argument.schema;
        }
        return { ...config, inputSchema };
    }
}
