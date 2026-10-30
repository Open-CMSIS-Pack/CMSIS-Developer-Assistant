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
 * The MCP endpoint of the extension: an express app on the IPv4 loopback
 * interface that speaks MCP over Streamable HTTP at /mcp.
 *
 * Every MCP session owns one transport and one server (built by
 * `buildSessionServer` in debugTools.ts) from its initialize request until
 * its transport closes. Nothing is shared between sessions and nothing is
 * closed while a request is in flight; a server shared across requests is
 * what once made the third `get_threads` call of a session hang.
 *
 * A request that names a session this server does not know gets 404 with
 * JSON-RPC -32001, as the SDK's own transport answers (#14): the answer that
 * tells a client to initialize a new session, for example after another
 * window took over the port. A request that names none and is not an
 * initialize request gets 400.
 *
 * This module reads no settings and does not import `vscode`: port,
 * timeouts, handler factory and options arrive through the constructor, so
 * the transport harness runs the real server outside VS Code.
 *
 * A session ends when its client sends DELETE, or after 30 minutes without a
 * request while it holds no GET stream open (#49); a sweep looks every
 * minute. Either way the session's handlers hear of it (`ended`), so the
 * serial ports it held are released: a router tells the windows it
 * forwarded to, a server without a router tells its own serial handler.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import type * as http from 'http';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type Implementation } from '@modelcontextprotocol/sdk/types.js';
import { ConfigurationManager, DebuggingExecutor, DebuggingHandler, type IDebuggingHandler } from '.';
import { offersNoGetStream } from './core/clientHosting';
import type { MeasuredMcpServer } from './core/measuredMcpServer';
import type { SerialOpName } from './core/opTable';
import { ToolMetrics, formatBytes, type ToolSample } from './core/toolMetrics';
import type { ToolText } from './core/toolResult';
import type { SessionTarget, SessionView } from './core/windowStatus';
import type { HardwareTimeouts } from './debuggingExecutor';
import { ShippedDocs, buildSessionServer, loadToolRules } from './debugTools';
import type { PackDocsDispatch } from './packDocsDispatch';
import { serialHandler } from './serialHandler';
import { closeHttpServer } from './utils/closeHttpServer';
import { logger } from './utils/logger';
import { isLoopbackHostHeader, isLoopbackOrigin } from './utils/loopback';

/** Runs one serial op for a session: on this window's handler, or forwarded by the router. */
export type SerialDispatch = (op: SerialOpName, args?: unknown) => Promise<ToolText>;

/** What one MCP session talks to, fixed for the session's lifetime. */
export interface SessionHandlers {
    debug: IDebuggingHandler;
    serial: SerialDispatch;
    /** Documentation and build-artefact ops; a session without it is offered neither group. */
    packDocs?: PackDocsDispatch;
    /**
     * Told once, without being waited for, when the session ends (#49). Left
     * out, a session whose serial ops run locally tells the local serial
     * handler, and any other session tells nobody.
     */
    ended?: (sessionId: string) => Promise<void>;
}

/** When an idle MCP session ends (#49); tests shorten the times and bring their own clock. */
export interface SessionExpiry {
    /** A session without a request for this long, and with no GET stream open, ends. 30 min by default. */
    idleMs?: number;
    /** How often the sessions are looked at. 60 s by default. */
    sweepMs?: number;
    /** Milliseconds on the expiry's clock. */
    now?: () => number;
}

/**
 * Switches resolved from settings once at activation. They are read when a
 * session is built, never per call: the tool list a client has seen must not
 * change under it.
 */
export interface DebugMCPServerOptions {
    /** The eleven serial tools; on unless false. */
    serialEnabled?: boolean;
    /** The five documentation tools, for sessions that have a pack-docs dispatch. */
    packDocsEnabled?: boolean;
    /** The five build-artefact tools, for sessions that have a pack-docs dispatch. */
    buildInfoEnabled?: boolean;
    /** Append each tool-call sample to this file as one JSON line. */
    telemetry?: { jsonlPath?: string };
    /** When sessions nobody uses end; the defaults suit the extension. */
    sessionExpiry?: SessionExpiry;
}

/** Single-window serial dispatch: the op is the method of the same name on `serialHandler`. */
export const localSerialDispatch: SerialDispatch = (op, args) => {
    const method: unknown = Reflect.get(serialHandler, op);
    if (typeof method !== 'function') {
        return Promise.reject(new Error(`Serial op ${op} is not implemented`));
    }
    return (method as (input?: unknown) => Promise<ToolText>).call(serialHandler, args);
};

/** The end of a session whose serial ops run in this window: its serial handler releases what the session held (#49). */
async function localSessionEnded(sessionId: string): Promise<void> {
    await serialHandler.sessionEnded(sessionId);
}

/** The configured port is bound already, normally by the window that serves MCP; the caller becomes a worker. */
export class PortInUseError extends Error {
    constructor(readonly port: number) {
        super(`Port ${port} is already in use by another CMSIS Developer Assistant window`);
        this.name = 'PortInUseError';
    }
}

/** The loopback checks live in utils/loopback.ts, shared with the control server; importable from here as before. */
export { isLoopbackHostHeader, isLoopbackOrigin };

const LOOPBACK_V4 = '127.0.0.1';
const MCP_ROUTE = '/mcp';
const SESSION_HEADER = 'mcp-session-id';
/** Largest MCP request body; express answers 413 above it. */
const BODY_LIMIT = '1mb';
/** Samples kept per session, and for the whole instance. */
const SESSION_SAMPLES = 200;
const INSTANCE_SAMPLES = 500;

const NO_SESSION_FOR_POST = 'This request names no MCP session, and it is not an initialize request.';
const NO_SESSION = 'This request needs the mcp-session-id of an open MCP session; it names none.';
/** The SDK transport's answer to a session id it does not know, and its JSON-RPC code (#14). */
const SESSION_NOT_FOUND = 'Session not found';
const SESSION_NOT_FOUND_CODE = -32001;
const REQUEST_FAILED = 'The MCP server failed while handling this request.';
const SSE_RETIRED = 'The legacy SSE endpoint /sse has been retired.';
const SSE_SUCCESSOR = 'Connect over Streamable HTTP instead: POST /mcp.';
/** The answer to a GET of a client that is offered no stream (NO_GET_STREAM_CLIENTS). */
const NO_GET_STREAM = 'This server offers this client no SSE stream at GET /mcp; results come with each POST.';
/** The answer on any other path, such as an entry that names the port without /mcp; the client shows it. */
const NOT_THE_ENDPOINT = 'is not the MCP endpoint of the CMSIS Developer Assistant: it serves Streamable HTTP at';
const START_FAILED = 'Could not start the CMSIS Developer Assistant MCP server';
/** A session idle this long ends (#49), unless it holds a GET stream; the sweep looks this often. */
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_SWEEP_MS = 60_000;

/** One MCP session: its transport, server and handlers, kept together until the transport closes. */
interface McpSession {
    transport: StreamableHTTPServerTransport;
    server: MeasuredMcpServer;
    handlers: SessionHandlers;
    /** True once the SDK assigned the session id and the session joined the map. */
    adopted: boolean;
    /** When a request of the session last arrived or finished, on the expiry's clock. */
    lastSeenAt: number;
    /** GET streams of the session open now; a session with one never expires. */
    openStreams: number;
}

const mintSessionId = (): string => randomUUID();

/** A routing handler's `describeTarget()`, recognised by shape so that this module does not import the router. */
function targetOf(handler: IDebuggingHandler): SessionTarget | undefined {
    const describe: unknown = (handler as { describeTarget?: unknown }).describeTarget;
    return typeof describe === 'function' ? (describe as () => SessionTarget | undefined).call(handler) : undefined;
}

/** Refuse Host and Origin values that are not local, before the body is even read. */
function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
    if (!isLoopbackHostHeader(req.headers.host)) {
        res.status(403).json({ error: 'Forbidden: non-local Host header' });
        return;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !isLoopbackOrigin(origin)) {
        res.status(403).json({ error: 'Forbidden: non-local Origin' });
        return;
    }
    next();
}

/** The session id a request names; an absent or empty header names none. */
function claimedSession(req: Request): string | undefined {
    const named = req.headers[SESSION_HEADER];
    return typeof named === 'string' && named.length > 0 ? named : undefined;
}

/** A JSON-RPC error with a null id, unless an answer is already on its way. */
function refuse(reply: Response, status: number, code: number, message: string): void {
    if (reply.headersSent) {
        return;
    }
    reply.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** A client as the log names it: the name and version it sent with `initialize`. */
function describeClient(client: Implementation): string {
    const name = client.name.trim() || '(unnamed client)';
    const version = client.version.trim();
    return version ? `${name} ${version}` : name;
}

/** Close the halves of a session that never opened, ignoring whatever they report. */
async function discard(session: McpSession): Promise<void> {
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
}

/**
 * How long an idle keep-alive connection to the endpoint stays open. Node's
 * default of 5 s races a client that keeps pooled connections longer, as
 * Codex's HTTP client does: a request sent while the server closes the idle
 * socket fails with "error sending request". Above the clients' own pool
 * timeouts, the client closes first. `closeHttpServer` still drops idle
 * sockets when the server is disposed.
 */
const KEEP_ALIVE_MS = 120_000;
/** Above the keep-alive, so that the header timeout never ends an idle socket first. */
const HEADERS_TIMEOUT_MS = KEEP_ALIVE_MS + 5_000;

/**
 * Bind the app to the loopback address. Success is the `listening` event,
 * not the listen callback, which Express 5 also calls on failure. A failed
 * bind closes the half-open handle before the error is handed on.
 */
function listenOnLoopback(app: Express, port: number): Promise<http.Server> {
    return new Promise<http.Server>((bound, failed) => {
        const listener = app.listen(port, LOOPBACK_V4);
        listener.keepAliveTimeout = KEEP_ALIVE_MS;
        listener.headersTimeout = HEADERS_TIMEOUT_MS;
        const onError = (problem: Error): void => {
            listener.removeListener('listening', onListening);
            listener.close();
            failed(problem);
        };
        const onListening = (): void => {
            listener.removeListener('error', onError);
            // From here on an unhandled socket error would take the extension host down; log it instead.
            listener.on('error', (problem) => logger.error('MCP endpoint socket error', problem));
            bound(listener);
        };
        listener.once('error', onError);
        listener.once('listening', onListening);
    });
}

/**
 * Appends samples as JSON lines, never awaited by the call it measures. The
 * first failed append mutes it for the rest of the instance, with a single
 * warning.
 */
function jsonlSink(file: string): (sample: ToolSample) => void {
    let muted = false;
    return (sample) => {
        if (muted) {
            return;
        }
        fs.promises.appendFile(file, `${JSON.stringify(sample)}\n`, 'utf8').catch((problem: unknown) => {
            if (!muted) {
                muted = true;
                logger.warn(`Tool telemetry to ${file} is off for this server: the file cannot be written`, problem);
            }
        });
    };
}

/** The tool rules read by the first server of this process; a window builds a server for each port bid. */
let sharedToolRules: { rules: string | undefined } | undefined;

/** The tool rules of the process, read from the shipped contract on first use. */
function processToolRules(docs: ShippedDocs): string | undefined {
    sharedToolRules ??= { rules: loadToolRules(docs) };
    return sharedToolRules.rules;
}

/** Without a factory: one debugging handler, built now and shared by every session. */
function singleWindowHandlers(timeoutInSeconds: number, hardwareTimeouts?: Partial<HardwareTimeouts>): () => SessionHandlers {
    const debug = new DebuggingHandler(new DebuggingExecutor(hardwareTimeouts), new ConfigurationManager(), timeoutInSeconds);
    return () => ({ debug, serial: localSerialDispatch });
}

/**
 * The MCP server of one window. `WindowCoordinator` builds it when the window
 * wins the well-known port; the transport tests build it directly.
 */
export class DebugMCPServer {
    private readonly options: Readonly<DebugMCPServerOptions>;
    private readonly handlersFor: () => SessionHandlers;
    /** Every tool call of every session of this instance. */
    private readonly instanceTotals = new ToolMetrics(INSTANCE_SAMPLES);
    private readonly sink: ((sample: ToolSample) => void) | undefined;
    private readonly docs = new ShippedDocs();
    /** The tool rules every session's instructions start with, read once per process (#50). */
    private readonly toolRules = processToolRules(this.docs);
    private readonly sessions = new Map<string, McpSession>();
    private listener: http.Server | undefined;
    private boundPort: number | undefined;
    private sweeper: ReturnType<typeof setInterval> | undefined;
    private readonly now: () => number;
    private readonly sessionIdleMs: number;

    /**
     * @param timeoutInSeconds and `hardwareTimeouts` only configure the
     *   single-window handler built when no `handlerFactory` is given.
     * @param handlerFactory called once per MCP session, while it is built.
     */
    constructor(
        private readonly port: number,
        timeoutInSeconds: number,
        hardwareTimeouts?: Partial<HardwareTimeouts>,
        handlerFactory?: () => SessionHandlers,
        options: DebugMCPServerOptions = {},
    ) {
        this.options = Object.freeze({ ...options });
        this.handlersFor = handlerFactory ?? singleWindowHandlers(timeoutInSeconds, hardwareTimeouts);
        const jsonl = this.options.telemetry?.jsonlPath;
        this.sink = typeof jsonl === 'string' && jsonl.length > 0 ? jsonlSink(jsonl) : undefined;
        this.now = options.sessionExpiry?.now ?? Date.now;
        this.sessionIdleMs = options.sessionExpiry?.idleMs ?? SESSION_IDLE_MS;
    }

    /** The options of this instance, frozen. */
    getOptions(): Readonly<DebugMCPServerOptions> {
        return this.options;
    }

    /** Totals over every session of this instance. */
    getMetrics(): ToolMetrics {
        return this.instanceTotals;
    }

    /**
     * First half of the two-step start its callers follow. There is nothing
     * to prepare: a session's MCP server is built when its initialize
     * request arrives.
     */
    async initialize(): Promise<void> {
        // Nothing to do until a client connects.
    }

    /**
     * Bind the configured port on 127.0.0.1, with no fallback: losing the
     * bind means another window serves MCP, reported as `PortInUseError`.
     */
    async start(): Promise<void> {
        // A worker bids for the port every 10 s: the attempt and its usual outcome are debug lines, the bind itself is news.
        logger.debug(`Opening the MCP endpoint on ${LOOPBACK_V4}:${this.port}`);
        try {
            this.listener = await listenOnLoopback(this.buildApp(), this.port);
            const where = this.listener.address();
            if (where === null || typeof where === 'string') {
                throw new Error('the listening socket reports no port');
            }
            this.boundPort = where.port;
            this.sweeper = setInterval(() => this.sweepIdleSessions(), this.options.sessionExpiry?.sweepMs ?? SESSION_SWEEP_MS);
            this.sweeper.unref();
            logger.info(`MCP endpoint ready at http://${LOOPBACK_V4}:${where.port}${MCP_ROUTE}`);
        } catch (failure) {
            if ((failure as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE') {
                logger.debug(`Port ${this.port} is taken; another window serves MCP`);
                throw new PortInUseError(this.port);
            }
            logger.error('The MCP endpoint did not start', failure);
            throw new Error(`${START_FAILED}: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
    }

    /**
     * Close every session, then the HTTP server (idle connections at once,
     * the rest after a grace period). Safe after a failed start or none.
     * The window's own serial ports are the coordinator's to release; each
     * closed session ends as on DELETE, so the windows it reached release
     * what it held there (#49).
     */
    async stop(): Promise<void> {
        if (this.sweeper !== undefined) {
            clearInterval(this.sweeper);
            this.sweeper = undefined;
        }
        for (const session of [...this.sessions.values()]) {
            try {
                await session.transport.close();
            } catch (problem) {
                logger.debug(`MCP session ${session.transport.sessionId ?? '(no id)'} did not close cleanly`, problem);
            }
        }
        this.sessions.clear();
        const listener = this.listener;
        if (listener !== undefined) {
            this.listener = undefined;
            this.boundPort = undefined;
            await closeHttpServer(listener);
            logger.info('MCP endpoint stopped');
        } else {
            // The release after a failed bind, or a second stop: nothing was serving.
            logger.debug('MCP endpoint stopped (it was not listening)');
        }
    }

    /** The bound port while listening (the OS's pick when 0 was configured), else the configured one. */
    getActualPort(): number {
        return this.boundPort ?? this.port;
    }

    /**
     * End every session that has had no request for the idle time and holds
     * no GET stream (#49). The sweep timer calls it every minute; tests call
     * it after moving their clock. Closing the transport ends the session the
     * way a DELETE does, and a later request with its id is refused. Returns
     * how many sessions it ended.
     */
    sweepIdleSessions(): number {
        const now = this.now();
        let ended = 0;
        for (const [id, session] of [...this.sessions.entries()]) {
            if (session.openStreams > 0 || now - session.lastSeenAt < this.sessionIdleMs) {
                continue;
            }
            ended += 1;
            logger.info(`MCP session ${id} expired: no request for ${Math.round((now - session.lastSeenAt) / 60_000)} min`);
            session.transport.close().catch((problem: unknown) => logger.debug(`MCP session ${id} did not close cleanly`, problem));
        }
        return ended;
    }

    /**
     * The open MCP sessions: their id, the client that opened each, and for a
     * session that routes between windows the window its path-less calls go
     * to and why. The router window's status bar lists them (#16).
     */
    describeSessions(): SessionView[] {
        return [...this.sessions.entries()].map(([id, session]) => ({
            id,
            client: session.server.server.getClientVersion()?.name,
            target: targetOf(session.handlers.debug),
        }));
    }

    private buildApp(): Express {
        const app: Express = express();
        app.use(loopbackOnly);
        app.use(express.json({ limit: BODY_LIMIT }));
        app.post(MCP_ROUTE, (req: Request, res: Response) => this.acceptPost(req, res));
        // GET opens a session's SSE stream and DELETE ends the session. Both
        // routes exist from the start: Express's HTML 404 for a route it does
        // not have makes Cursor mark the server as failed. A missing session
        // id gets 400; an unknown one the SDK's JSON 404 (#14).
        app.get(MCP_ROUTE, (req: Request, res: Response) => this.acceptSessionRequest(req, res));
        app.delete(MCP_ROUTE, (req: Request, res: Response) => this.acceptSessionRequest(req, res));
        app.get('/sse', (_req: Request, res: Response) => {
            res.status(410).json({ error: SSE_RETIRED, message: SSE_SUCCESSOR, newEndpoint: MCP_ROUTE });
        });
        // Every other path gets JSON that names the endpoint, not Express's HTML "Cannot POST /".
        app.use((req: Request, res: Response) => {
            const endpoint = `http://localhost:${req.socket.localPort ?? this.port}${MCP_ROUTE}`;
            refuse(res, 404, -32000, `${req.method} ${req.path} ${NOT_THE_ENDPOINT} ${endpoint}.`);
        });
        return app;
    }

    private async acceptPost(req: Request, res: Response): Promise<void> {
        const claimed = claimedSession(req);
        let opened: McpSession | undefined;
        try {
            const live = claimed === undefined ? undefined : this.sessions.get(claimed);
            if (live !== undefined) {
                this.seen(live, res);
                await live.transport.handleRequest(req, res, req.body);
                return;
            }
            // An unknown id, on an initialize request too: the client starts over without it.
            if (claimed !== undefined) {
                refuse(res, 404, SESSION_NOT_FOUND_CODE, SESSION_NOT_FOUND);
                return;
            }
            const initialize: unknown = req.body;
            if (!isInitializeRequest(initialize)) {
                refuse(res, 400, -32000, NO_SESSION_FOR_POST);
                return;
            }
            opened = this.openSession(initialize.params.clientInfo);
            await opened.server.connect(opened.transport);
            await opened.transport.handleRequest(req, res, req.body);
        } catch (failure) {
            logger.error('Handling an MCP request failed', failure);
            if (opened !== undefined && !opened.adopted) {
                await discard(opened);
                logger.debug('Released the transport and server of a session that never opened');
            }
            refuse(res, 500, -32603, REQUEST_FAILED);
        }
    }

    private async acceptSessionRequest(req: Request, res: Response): Promise<void> {
        const claimed = claimedSession(req);
        if (claimed === undefined) {
            refuse(res, 400, -32000, NO_SESSION);
            return;
        }
        const live = this.sessions.get(claimed);
        if (live === undefined) {
            refuse(res, 404, SESSION_NOT_FOUND_CODE, SESSION_NOT_FOUND);
            return;
        }
        this.seen(live, res);
        if (req.method === 'GET' && offersNoGetStream(live.server.server.getClientVersion()?.name)) {
            // For this client a stream that drops when the server restarts ends the server for good (Kimi Code).
            res.set('Allow', 'POST, DELETE');
            refuse(res, 405, -32000, NO_GET_STREAM);
            return;
        }
        if (req.method === 'GET') {
            // An open stream keeps the session from expiring, however long nothing is asked.
            live.openStreams += 1;
            res.on('close', () => { live.openStreams -= 1; });
        }
        await live.transport.handleRequest(req, res);
    }

    /** A request of `session` arrived: it counts as used now and again when the answer is done. */
    private seen(session: McpSession, res: Response): void {
        session.lastSeenAt = this.now();
        res.on('close', () => { session.lastSeenAt = this.now(); });
    }

    /**
     * A transport and server for a new session of `client`; it joins the map
     * once the SDK assigns its id.
     */
    private openSession(client: Implementation): McpSession {
        const ring = new ToolMetrics(SESSION_SAMPLES, (sample) => this.observe(sample));
        // Made here rather than inside the build, so that the session keeps them for describeSessions().
        const handlers = this.handlersFor();
        const server = buildSessionServer({
            options: this.options,
            handlers: () => handlers,
            ring,
            serverTotals: this.instanceTotals,
            docs: this.docs,
            toolRules: this.toolRules,
        });
        const session: McpSession = {
            server,
            handlers,
            adopted: false,
            lastSeenAt: this.now(),
            openStreams: 0,
            transport: new StreamableHTTPServerTransport({
                sessionIdGenerator: mintSessionId,
                onsessioninitialized: (id) => this.adopt(session, id, client),
            }),
        };
        // Assigned before connect: the SDK chains its own close handling onto the handler present at that moment.
        session.transport.onclose = () => this.release(session);
        return session;
    }

    /**
     * The SDK assigned the session's id: it joins the map. The SDK calls this
     * before its server has read the initialize request, so the client is
     * named from that request (`clientInfo`), the same object the server keeps.
     */
    private adopt(session: McpSession, id: string, client: Implementation): void {
        session.adopted = true;
        this.sessions.set(id, session);
        logger.info(`MCP session ${id} opened by ${describeClient(client)}`);
    }

    private release(session: McpSession): void {
        const id = session.transport.sessionId;
        if (id !== undefined && this.sessions.get(id) === session) {
            this.sessions.delete(id);
            logger.info(`MCP session ${id} closed`);
            this.announceEnd(id, session.handlers);
        }
    }

    /** Tell the session's handlers that it ended (#49), without waiting; a failure is only logged. */
    private announceEnd(id: string, handlers: SessionHandlers): void {
        const ended = handlers.ended ?? (handlers.serial === localSerialDispatch ? localSessionEnded : undefined);
        if (ended === undefined) {
            return;
        }
        Promise.resolve().then(() => ended(id)).catch((problem: unknown) =>
            logger.info(`The end of MCP session ${id} could not be passed on`, problem));
    }

    /** One finished tool call of any session: into the instance totals, the JSONL file and the log. */
    private observe(sample: ToolSample): void {
        this.instanceTotals.record(sample);
        this.sink?.(sample);
        const session = sample.sessionId ? ` session=${sample.sessionId.slice(0, 8)}` : '';
        logger.debug(`tool=${sample.tool} ms=${sample.ms} in=${formatBytes(sample.argBytes)} ` +
            `out=${formatBytes(sample.resultBytes)} outcome=${sample.outcome}${session}`);
    }
}
