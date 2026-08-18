// Copyright (c) Microsoft Corporation.

import * as http from 'http';
import { IDebuggingHandler } from './debuggingHandler';
import { serialHandler } from './serialHandler';
import { isKnownOp, isSerialOp } from './core/opTable';
import { logger } from './utils/logger';

/**
 * Per-window loopback HTTP server that runs debug operations against this
 * window's own handlers.
 *
 * Every VS Code window runs one. The router window (the one holding the
 * well-known MCP port) forwards each tool call here, so the debugging happens
 * in the window that actually owns the workspace and the probe — not in
 * whichever window happened to win the port race.
 *
 * Bound to 127.0.0.1 and gated by a per-window token published through the
 * registry. The token matters: this endpoint flashes and erases hardware with
 * no other authentication, so anything that can reach the port must prove it
 * read the registry file, which is owned by the user.
 */
export class ControlServer {
    private server: http.Server | undefined;
    private boundPort = 0;

    constructor(
        private readonly handler: IDebuggingHandler,
        private readonly token: string,
    ) {}

    /** The ephemeral loopback port chosen by the OS, or 0 before start(). */
    public getPort(): number {
        return this.boundPort;
    }

    /** Start listening on an ephemeral loopback port. Resolves with the port. */
    public async start(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const server = http.createServer((req, res) => this.onRequest(req, res));
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                this.boundPort = typeof address === 'object' && address ? address.port : 0;
                this.server = server;
                // Keep a permanent error listener: an unhandled 'error' later
                // would otherwise take down the extension host.
                server.removeListener('error', reject);
                server.on('error', (err) => logger.error('Control server error', err));
                logger.info(`CMSIS-DebugMCP control server listening on 127.0.0.1:${this.boundPort}`);
                resolve(this.boundPort);
            });
        });
    }

    /** Stop listening. */
    public async stop(): Promise<void> {
        if (this.server) {
            const server = this.server;
            this.server = undefined;
            this.boundPort = 0;
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.method !== 'POST' || req.url !== '/op') {
            res.writeHead(404).end();
            return;
        }
        if (req.headers['x-cmsis-debugmcp-token'] !== this.token) {
            res.writeHead(403).end();
            return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
            try {
                const { op, args } = JSON.parse(body || '{}') as { op?: string; args?: unknown };
                if (typeof op !== 'string') {
                    throw new Error('Control request has no op');
                }
                const result = await this.dispatch(op, args ?? {});
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result }));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: message }));
            }
        });
    }

    /**
     * Run one op against this window's handlers.
     *
     * The op name is checked against the shared table before use, so this is a
     * lookup in a fixed allowlist rather than dynamic dispatch on attacker-
     * controlled input — `op` never reaches a property access unvalidated.
     */
    private dispatch(op: string, args: unknown): Promise<string> {
        if (!isKnownOp(op)) {
            return Promise.reject(new Error(`Unknown control op: ${op}`));
        }

        const target: Record<string, unknown> = isSerialOp(op)
            ? (serialHandler as unknown as Record<string, unknown>)
            : (this.handler as unknown as Record<string, unknown>);

        const method = target[op];
        if (typeof method !== 'function') {
            return Promise.reject(new Error(`Control op ${op} is not implemented in this window`));
        }

        return Promise.resolve((method as (a: unknown) => Promise<string>).call(target, args));
    }
}
