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
 * The receiving end of multi-window routing. Every window runs one: a
 * loopback HTTP endpoint that runs a single named op against this window's
 * own handlers (debugging, serial, documentation and build artefacts) and
 * answers with the handler's result. The router window forwards each tool
 * call here, so the call runs in the window that owns the workspace and the
 * probe.
 *
 * Windows of different extension versions talk to each other through this
 * endpoint; its request and response shapes are a contract (POST /op, the
 * token header, `{op, args}` in, `{result}` or `{error}` out). A router that
 * sends the envelope header (see `CONTROL_ENVELOPE_HEADER`) gets the outcome
 * typed: the `ToolText` as it is, a failure as `{message, code, hint, data}`.
 * Any other router gets the 2.3.10 shapes, strings only.
 *
 * Each op runs through the window's problem journal (#48): in the call
 * context the envelope names (`callId`, `sessionId`), registered while it
 * runs, and with the problems it produced in `data.problems` when it fails
 * or its wait runs out. A typed reply also carries the journal's counters,
 * `journalSeq` and `journalErrors`, from which the router tells the agent
 * about new errors.
 *
 * The ops include flashing and erasing the target, so a request passes
 * three checks before its body is read (#19): `POST /op` (else 404); a
 * loopback `Host` and no `Origin` at all, since the router never sends one
 * and a browser always does (else 403); and the per-window token the window
 * publishes in the registry, compared in constant time (else 403). The 403
 * and 404 bodies point whoever probes the port at the MCP tools instead.
 *
 * Every op runs inside a fence (#14): when it has not settled `fenceMarginMs`
 * before the budget the router named (`budgetMs` in the envelope; a 2.5.0
 * router names none, and the window's own timeout decides), the window
 * answers `WORKER_TIMEOUT` and journals it, with a hint that speaks of a
 * picker or dialog only for the ops that can open one (`mayWaitForUser`),
 * of the debug adapter or GDB for the other debugging ops, and of the op's
 * own work for the rest. The op keeps running, since a DAP request or a
 * picker cannot be withdrawn; it stays in the busy table until it settles,
 * and its late result is logged and dropped. Receiving a request may take
 * 10 s, its headers 5 s: requests come over loopback and hold at most
 * 1 MiB.
 *
 * The internal ops (`INTERNAL_OPS`) are no tools and are answered here, at
 * once and before the op table, and pass neither the op hook nor the
 * journal: `health` (#14) with the window's pid, version, role, uptime,
 * event-loop lag and busy ops; `sessionEnded` (#49), which releases the
 * serial port an ended MCP session held in this window.
 *
 * `onOp` hears when each op starts, outlives its fence and settles; the
 * window's status-bar item shows from it that an agent call runs here (#16),
 * and the coordinator tells the user about a fenced one that may wait for
 * them.
 */

import { timingSafeEqual } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { IDebuggingHandler } from './debuggingHandler';
import type { PackDocsHandlers } from './packDocsDispatch';
import { serialHandler } from './serialHandler';
import type { CallContext } from './core/callContext';
import {
    CHANNEL_TIMINGS,
    CONTROL_ENVELOPE_HEADER,
    CONTROL_ENVELOPE_VERSION,
    CONTROL_REQUEST_MAX_BYTES,
    InternalOpName,
    OpName,
    forwardTimeoutMs,
    isDebugOp,
    isInternalOp,
    isKnownOp,
    isKnowledgeOp,
    isPackDocsDocOp,
    isPackDocsOp,
    isSerialOp,
    mayWaitForUser,
    workerFenceMs,
} from './core/opTable';
import { JournaledOutcome, runJournaled } from './core/problemFeed';
import { problemJournal, type JournalCounters, type ProblemJournal } from './core/problemJournal';
import { JsonObject, ToolError, ToolReply, ToolText, errorDetail, isToolReply, textOf, toToolError } from './core/toolResult';
import { BusyRun, BusyTable, secondsText, type LagFigures } from './core/windowHealth';
import { toolNameOf } from './core/windowStatus';
import { closeHttpServer } from './utils/closeHttpServer';
import { logger } from './utils/logger';
import { isLoopbackHostHeader } from './utils/loopback';
import type { WindowRole } from './utils/workspaceRegistry';

/** Loopback only: nothing off this machine may reach the endpoint. */
const LOOPBACK_ONLY = '127.0.0.1';
const OP_ENDPOINT = '/op';
/** Node lower-cases incoming header names; the sender may use any case. */
const TOKEN_HEADER = 'x-cmsis-developer-assistant-token';
const JSON_REPLY: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };
/** The body of every 403 and 404: this port is not for agents, and here is what is. */
const NOT_FOR_AGENTS = {
    error: 'internal endpoint of the CMSIS Developer Assistant; agents use the MCP tools list_debug_windows and select_debug_window',
};

/** Receiving one whole request, and its headers, may take this long (#14); Node's defaults are 300 s and 60 s. */
const REQUEST_RECEIVE_MS = 10_000;
const HEADERS_RECEIVE_MS = 5_000;
/** A window's tool timeout when nothing says otherwise: the default of `timeoutInSeconds`. */
const DEFAULT_TOOL_MS = 180_000;
/** The origin of this extension's own journal records. */
const OWN_ORIGIN = 'cmsis-developer-assistant';
/** The next step after a fence answered, for an op that can wait for a person (`mayWaitForUser`). */
const FENCE_HINT_USER = 'A picker or dialog may be open in that window: ask the user, or call get_session_status.';
/** The same for every other debugging op, which waits for the debug adapter, GDB or the probe. */
const FENCE_HINT_ADAPTER = 'The debug adapter or GDB has not answered: call get_session_status, then check_target_connection.';
/** The same for the serial, documentation, build-artefact and knowledge ops, which wait for their own work. */
const FENCE_HINT_OTHER = 'list_debug_windows shows when it has finished; get_recent_problems shows what that window reported.';

/** The next step after the fence of `op` answered (#14): a picker or dialog only where the op can open one. */
function fenceHintOf(op: string): string {
    if (mayWaitForUser(op)) {
        return FENCE_HINT_USER;
    }
    return isDebugOp(op) ? FENCE_HINT_ADAPTER : FENCE_HINT_OTHER;
}

/** What one request asks for, once its body is parsed. */
interface OpRequest {
    op: string;
    args: unknown;
    /** The tool call the router forwarded, when it named one. */
    call?: CallContext;
    /** How long the router waits for the answer (#14); none from a router of 2.5.0. */
    budgetMs?: number;
}

/** How far an op has got: started, answered by its fence while it keeps running (#14), or settled either way. */
export type OpPhase = 'start' | 'fenced' | 'end';

/** One run of an op as the listener sees it: a ticket that tells two runs apart, and how long it has run. */
export interface OpRun {
    ticket: number;
    ranMs: number;
}

/** Told when an op starts running in this window, outlives its fence, and settles (#16: the status bar; #14: the notice). */
export type OpListener = (op: OpName, phase: OpPhase, run: OpRun) => void;

/** What the `health` reply and the fence's message say about this window. */
export interface WindowFacts {
    pid: number;
    /** The window's name as VS Code shows it. */
    name?: string;
    role?: WindowRole;
    /** The extension version. */
    version?: string;
    /** The event-loop delay since the coordinator's last heartbeat. */
    lagMs?: LagFigures;
}

/** How a window's control server fences its ops and describes the window (#14); every field has a default. */
export interface ControlServerOptions {
    /** The budget of an op whose router named none (2.5.0): what this window's own router would allow it. */
    defaultBudgetMs?: (op: string, args: unknown) => number;
    /** The fence answers this long before the budget runs out; 5 s. */
    fenceMarginMs?: number;
    /** The shortest fence; 1 s. */
    minFenceMs?: number;
    /** This window, as `health` and the fence's message describe it; the pid alone by default. */
    facts?: () => WindowFacts;
}

/** Longest call id and session id taken from an envelope; anything longer is not one of ours. */
const CALL_ID_MAX_CHARS = 128;
const SESSION_ID_MAX_CHARS = 256;

/** The call context an envelope names: `callId`, and `sessionId` when present. */
function callNamed(callId: unknown, sessionId: unknown): CallContext | undefined {
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > CALL_ID_MAX_CHARS) {
        return undefined;
    }
    return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= SESSION_ID_MAX_CHARS
        ? { callId, sessionId }
        : { callId };
}

/** The journal counters a typed reply carries; nothing for a 2.3.10 router. */
function countersBody(counters: JournalCounters, typed: boolean): object {
    return typed ? { journalSeq: counters.seq, journalErrors: counters.errors } : {};
}

/** A handler result as the text it carries, or undefined when it is none. */
function carriedText(value: unknown): string | undefined {
    return typeof value === 'string' || isToolReply(value) ? textOf(value) : undefined;
}

/** UTF-8 size of the text of a handler result for the trace line; anything else counts as 0. */
function resultBytes(value: unknown): number {
    const text = carriedText(value);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
}

/** True when the request carries the envelope header with a version this window speaks. */
function wantsTypedReply(incoming: http.IncomingMessage): boolean {
    const asked = Number.parseInt(String(incoming.headers[CONTROL_ENVELOPE_HEADER] ?? ''), 10);
    return Number.isInteger(asked) && asked >= CONTROL_ENVELOPE_VERSION;
}

/** The success body: the outcome as it is for a typed router, its text for a 2.3.10 one. */
function resultBody(result: unknown, typed: boolean): object {
    return { result: typed ? result : carriedText(result) ?? result };
}

/** The failure body: code, message, hint and data for a typed router, one string for a 2.3.10 one. */
function errorBody(failure: ToolError, typed: boolean): object {
    if (!typed) {
        return { error: errorDetail(failure) };
    }
    const error: JsonObject = { message: failure.message, code: failure.code };
    if (failure.hint !== undefined) {
        error.hint = failure.hint;
    }
    if (failure.data !== undefined) {
        error.data = failure.data;
    }
    return { error };
}

/** A budget a router named, when it is a usable number of milliseconds. */
function budgetNamed(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The body as an op request. An empty body counts as `{}`; JSON `null`
 * fails on the property read, which ends as a 500 like any other failure.
 */
function parseOpRequest(body: string): OpRequest {
    const parsed = body.length === 0 ? {} : JSON.parse(body);
    const named: unknown = parsed.op;
    if (typeof named === 'string') {
        const call = callNamed(parsed.callId, parsed.sessionId);
        const budgetMs = budgetNamed(parsed.budgetMs);
        return { op: named, args: parsed.args ?? {}, ...(call ? { call } : {}), ...(budgetMs !== undefined ? { budgetMs } : {}) };
    }
    throw new Error('Control request has no op');
}

/** A handler entry point as the dispatch calls it. */
type EntryPoint = (args: unknown) => Promise<ToolText> | ToolText;

/** Call an entry point; a synchronous throw becomes a rejection. */
function invoke(entryPoint: EntryPoint, owner: object, args: unknown): Promise<ToolText> {
    try {
        return Promise.resolve(entryPoint.call(owner, args));
    } catch (failure) {
        return Promise.reject(failure);
    }
}

/** A status with no body and no content type. */
function replyBare(reply: http.ServerResponse, status: number): void {
    reply.writeHead(status).end();
}

/**
 * True when the request carries exactly the window's token. A header sent
 * twice arrives joined or as an array and never matches; bytes are compared
 * only at equal length, since `timingSafeEqual` throws otherwise.
 */
function carriesToken(presented: string | string[] | undefined, token: string): boolean {
    if (typeof presented !== 'string') {
        return false;
    }
    const given = Buffer.from(presented, 'utf8');
    const expected = Buffer.from(token, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The router's requests name 127.0.0.1 and never carry an `Origin`; a browser's always do. */
function comesFromRouter(incoming: http.IncomingMessage): boolean {
    return isLoopbackHostHeader(incoming.headers.host) && incoming.headers.origin === undefined;
}

function replyJson(reply: http.ServerResponse, status: number, payload: object, typed = false): void {
    const headers = typed ? { ...JSON_REPLY, [CONTROL_ENVELOPE_HEADER]: String(CONTROL_ENVELOPE_VERSION) } : JSON_REPLY;
    reply.writeHead(status, headers).end(JSON.stringify(payload), 'utf8');
}

export class ControlServer {
    private listener: http.Server | undefined;
    private boundPort = 0;
    private opListener: OpListener | undefined;
    /** The ops running in this window, fenced ones included until they settle (#14). */
    private readonly busy = new BusyTable();
    /** Fence timers not yet fired; `stop()` clears them. */
    private readonly fenceTimers = new Set<ReturnType<typeof setTimeout>>();
    private readonly defaultBudgetMs: (op: string, args: unknown) => number;
    private readonly fenceTimings: { fenceMarginMs: number; minFenceMs: number };
    private readonly facts: () => WindowFacts;
    /** How this server answers each internal op. */
    private readonly internalOps: Readonly<Record<InternalOpName, (args: unknown) => ToolText | Promise<ToolText>>> = {
        health: () => this.health(),
        sessionEnded: (args) => this.sessionEnded(args),
    };

    /**
     * @param journal the window's problem journal; a test gives each fake window its own.
     * @param options the fence's timings and what the window says about itself (#14).
     */
    constructor(
        private readonly handler: IDebuggingHandler,
        private readonly token: string,
        private readonly packDocs?: PackDocsHandlers,
        private readonly journal: ProblemJournal = problemJournal(),
        options: ControlServerOptions = {},
    ) {
        this.defaultBudgetMs = options.defaultBudgetMs ?? ((op, args) => forwardTimeoutMs(op, args, DEFAULT_TOOL_MS));
        this.fenceTimings = {
            fenceMarginMs: options.fenceMarginMs ?? CHANNEL_TIMINGS.fenceMarginMs,
            minFenceMs: options.minFenceMs ?? CHANNEL_TIMINGS.minFenceMs,
        };
        this.facts = options.facts ?? (() => ({ pid: process.pid }));
    }

    /** The listening port; 0 before `start()` resolved and from the moment `stop()` begins. */
    getPort(): number {
        return this.boundPort;
    }

    /** Tell `listener` about every op this window runs from now on; it replaces the one set before. */
    onOp(listener: OpListener | undefined): void {
        this.opListener = listener;
    }

    /** The ops running in this window now, oldest first; a fenced op stays until it settles (#14). */
    busyOps(): readonly BusyRun[] {
        return this.busy.list();
    }

    /** How long receiving a request and its headers may take; undefined while not listening. */
    receiveLimits(): { requestMs: number; headersMs: number } | undefined {
        const listening = this.listener;
        return listening ? { requestMs: listening.requestTimeout, headersMs: listening.headersTimeout } : undefined;
    }

    /** Hand one op event to the listener; a listener that throws is logged, never felt by the op. */
    private tell(run: BusyRun, phase: OpPhase): void {
        try {
            this.opListener?.(run.op as OpName, phase, { ticket: run.ticket, ranMs: Date.now() - run.startedAt });
        } catch (failure) {
            logger.warn(`The op listener failed on ${run.op} ${phase}`, failure);
        }
    }

    /** Listen on an OS-chosen loopback port and resolve with it. */
    start(): Promise<number> {
        const limits: http.ServerOptions = { requestTimeout: REQUEST_RECEIVE_MS, headersTimeout: HEADERS_RECEIVE_MS };
        const httpServer = http.createServer(limits, (incoming, reply) => this.accept(incoming, reply));
        return new Promise<number>((resolvePort, rejectListen) => {
            httpServer.once('error', rejectListen);
            httpServer.listen(0, LOOPBACK_ONLY, () => {
                httpServer.removeListener('error', rejectListen);
                // From here on an unhandled 'error' would take the extension host down.
                httpServer.on('error', (fault) => logger.error('Control server error', fault));
                this.listener = httpServer;
                this.boundPort = (httpServer.address() as AddressInfo).port;
                logger.info(`Accepting forwarded tool calls on ${LOOPBACK_ONLY}:${this.boundPort}`);
                resolvePort(this.boundPort);
            });
        });
    }

    /**
     * Close within the grace of `closeHttpServer`: idle connections at once,
     * in-flight ones when the grace ends. Their ops are not cancelled, and
     * their fences no longer fire.
     */
    stop(): Promise<void> {
        for (const timer of this.fenceTimers) {
            clearTimeout(timer);
        }
        this.fenceTimers.clear();
        const closing = this.listener;
        this.listener = undefined;
        this.boundPort = 0;
        // Never started, or a stop already under way: nothing to wait for.
        return closing ? closeHttpServer(closing) : Promise.resolve();
    }

    private accept(incoming: http.IncomingMessage, reply: http.ServerResponse): void {
        if (incoming.method !== 'POST' || incoming.url !== OP_ENDPOINT) {
            replyJson(reply, 404, NOT_FOR_AGENTS);
            return;
        }
        if (!comesFromRouter(incoming) || !carriesToken(incoming.headers[TOKEN_HEADER], this.token)) {
            replyJson(reply, 403, NOT_FOR_AGENTS);
            return;
        }

        // Raw bytes, decoded once at the end, so a character split across two
        // chunks arrives whole.
        const received: Buffer[] = [];
        let byteCount = 0;
        let oversize = false;
        incoming.on('data', (piece: Buffer) => {
            byteCount += piece.length;
            if (oversize) {
                return;
            }
            if (byteCount > CONTROL_REQUEST_MAX_BYTES) {
                // Keep draining to the end: answering while the client is
                // still writing resets the connection before it reads the 413.
                oversize = true;
                received.length = 0;
                return;
            }
            received.push(piece);
        });
        incoming.on('error', (fault: Error) => {
            logger.info(`Control request aborted: ${fault.message}`);
            if (!reply.headersSent) { replyBare(reply, 400); }
        });
        const typed = wantsTypedReply(incoming);
        incoming.on('end', () => this.finish(reply, oversize ? undefined : Buffer.concat(received), typed));
    }

    /** Answer a completely received request; `body` is undefined when it was over the cap. */
    private finish(reply: http.ServerResponse, body: Buffer | undefined, typed: boolean): void {
        if (body === undefined) {
            replyJson(reply, 413, { error: `control request above ${CONTROL_REQUEST_MAX_BYTES} bytes` });
            return;
        }
        const failed = (failure: unknown): void => {
            const counted = countersBody(this.journal.counters(), typed);
            replyJson(reply, 500, { ...errorBody(toToolError(failure), typed), ...counted }, typed);
        };
        let request: OpRequest;
        try {
            request = parseOpRequest(body.toString('utf8'));
        } catch (failure) {
            failed(failure);
            return;
        }
        if (!isInternalOp(request.op)) {
            reply.once('close', () => {
                if (!reply.writableEnded) {
                    logger.info(`control op=${request.op}: the router abandoned the call before it was answered; the op runs on`);
                }
            });
        }
        this.execute(request).then(
            ({ outcome, counters }) => {
                const counted = countersBody(counters, typed);
                if (outcome instanceof ToolError) {
                    replyJson(reply, 500, { ...errorBody(outcome, typed), ...counted }, typed);
                } else {
                    replyJson(reply, 200, { ...resultBody(outcome, typed), ...counted }, typed);
                }
            },
            failed,
        );
    }

    /**
     * Run a parsed request: an internal op here and now, any other through
     * `dispatch`. A request that cannot be run — an unknown op — rejects; the
     * op's own failure is the outcome. Fields beyond `op`, `args`, `callId`,
     * `sessionId` and `budgetMs` are ignored.
     */
    private async execute(request: OpRequest): Promise<JournaledOutcome> {
        if (isInternalOp(request.op)) {
            return { outcome: await this.internalOps[request.op](request.args), counters: this.journal.counters() };
        }
        return this.dispatch(request);
    }

    /**
     * Run one op against the handler that owns it, through the journal and
     * inside its fence, and trace the outcome. The op leaves the busy table,
     * and the listener hears its end, when its promise settles, even long
     * after its fence answered.
     */
    private async dispatch(request: OpRequest): Promise<JournaledOutcome> {
        const { op, args: opArgs, call } = request;
        // Before any property lookup: `constructor` or `__proto__` stop here.
        if (!isKnownOp(op)) {
            throw new ToolError('TOOL_DISABLED', `Control op ${op} refused: not a known operation`);
        }
        const owner = this.ownerOf(op);
        const entryPoint: unknown = Reflect.get(owner, op);
        if (!(entryPoint instanceof Function)) {
            throw new ToolError('TOOL_DISABLED', `Control op ${op} is not implemented in this window`);
        }
        const fenceMs = workerFenceMs(request.budgetMs ?? this.defaultBudgetMs(op, opArgs), this.fenceTimings);
        const run = this.busy.begin(op, call?.callId);
        this.tell(run, 'start');
        const journaled = await runJournaled(this.journal, call, () => {
            const work = invoke(entryPoint as EntryPoint, owner, opArgs);
            work.then(() => this.settled(run), () => this.settled(run));
            return this.fence(work, run, fenceMs, call);
        });
        const { outcome } = journaled;
        const ms = Date.now() - run.startedAt;
        logger.debug(outcome instanceof ToolError
            ? `control op=${op} ms=${ms} failed: ${outcome.message}`
            : `control op=${op} ms=${ms} out=${resultBytes(outcome)} B`);
        if (run.fenced) {
            // Told after the outcome was taken, so a notice the listener journals does not ride along with it.
            this.tell(run, 'fenced');
        }
        return journaled;
    }

    /**
     * `work`, unless the fence fires first: then a `WORKER_TIMEOUT` rejection,
     * and `work` runs on. Work that settles in time takes its fence down.
     */
    private fence(work: Promise<ToolText>, run: BusyRun, fenceMs: number, call: CallContext | undefined): Promise<ToolText> {
        const expiry = new Promise<never>((_answered, fail) => {
            const armed = setTimeout(() => {
                this.fenceTimers.delete(armed);
                fail(this.expire(run, fenceMs, call));
            }, fenceMs);
            this.fenceTimers.add(armed);
            const disarm = (): void => {
                clearTimeout(armed);
                this.fenceTimers.delete(armed);
            };
            work.then(disarm, disarm);
        });
        return Promise.race([work, expiry]);
    }

    /** The fence fired: mark the run, journal it in this window, and say so in the `WORKER_TIMEOUT` the router gets. */
    private expire(run: BusyRun, fenceMs: number, call: CallContext | undefined): ToolError {
        this.busy.fence(run);
        const facts = this.facts();
        const where = facts.name ? `window pid ${facts.pid} (${facts.name})` : `window pid ${facts.pid}`;
        const message = `'${toolNameOf(run.op)}' did not finish within ${secondsText(fenceMs)} in ${where}; it is still running there.`;
        const hint = fenceHintOf(run.op);
        this.journal.append({
            source: 'extension', origin: OWN_ORIGIN, severity: 'warning', code: 'WORKER_TIMEOUT', message, hint,
            ...(call ? { toolCallId: call.callId } : {}),
        });
        logger.warn(`control op=${run.op} outlived its ${fenceMs} ms fence: answered WORKER_TIMEOUT, the op runs on`);
        return new ToolError('WORKER_TIMEOUT', message, hint);
    }

    /** The op's promise settled: out of the busy table, and the listener hears its end. */
    private settled(run: BusyRun): void {
        this.busy.end(run);
        if (run.fenced && run.fencedAt !== undefined) {
            logger.info(`control op=${run.op} finished ${secondsText(Date.now() - run.fencedAt)} after its fence; its result was discarded`);
        }
        this.tell(run, 'end');
    }

    /** The `health` reply: this window is alive, and what it is doing. */
    private health(): ToolReply {
        const facts = this.facts();
        const answeredAt = Date.now();
        const busy: JsonObject[] = this.busy.list().map((run) => ({
            op: run.op, ageS: Math.round((answeredAt - run.startedAt) / 1000), fenced: run.fenced,
        }));
        const data: JsonObject = { pid: facts.pid, uptimeS: Math.round(process.uptime()), busy };
        if (facts.version !== undefined) {
            data.version = facts.version;
        }
        if (facts.role !== undefined) {
            data.role = facts.role;
        }
        if (facts.lagMs !== undefined) {
            data.lagMs = { p99: facts.lagMs.p99, max: facts.lagMs.max };
        }
        return { text: `Window pid ${facts.pid} is alive; ${busy.length} op(s) running.`, status: 'ok', data };
    }

    /**
     * The internal op `sessionEnded` (#49): an MCP session ended, so the serial
     * port it held here is released. A request it cannot read is refused like
     * a failed op.
     */
    private async sessionEnded(opArgs: unknown): Promise<ToolText> {
        const sessionId: unknown = (opArgs as { sessionId?: unknown } | null | undefined)?.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > SESSION_ID_MAX_CHARS) {
            throw new ToolError('INVALID_ARGUMENT', 'sessionEnded needs the id of the MCP session that ended');
        }
        const answer = await serialHandler.sessionEnded(sessionId);
        logger.info(`control op=sessionEnded: ${answer}`);
        return answer;
    }

    private ownerOf(op: string): object {
        if (isSerialOp(op)) {
            return serialHandler;
        }
        if (!isPackDocsOp(op)) {
            return this.handler;
        }
        if (this.packDocs === undefined) {
            throw new ToolError('TOOL_DISABLED',
                `Control op ${op}: the documentation and build-artefact handlers are not available in this window`);
        }
        if (isKnowledgeOp(op)) {
            if (this.packDocs.knowledge === undefined) {
                throw new ToolError('TOOL_DISABLED', `Control op ${op}: the knowledge handler is not available in this window`);
            }
            return this.packDocs.knowledge;
        }
        return isPackDocsDocOp(op) ? this.packDocs.docs : this.packDocs.build;
    }
}
