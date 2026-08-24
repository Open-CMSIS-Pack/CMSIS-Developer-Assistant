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

import { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolMetrics, classifyOutcome } from './toolMetrics';

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

/**
 * An McpServer that measures every registered tool.
 *
 * The wrapper sits at the MCP boundary, so what it sees is exactly what the
 * client sees: the arguments after schema parsing, the result after every
 * handler, redaction and routing step, and the wall time including any
 * forward to another window. Registration is untouched — callers keep using
 * `registerTool(name, config, cb)` with literal names, which the skill test
 * greps for.
 *
 * Nothing here depends on vscode; logging and sinks hang off the metrics'
 * onSample callback.
 */
export class MeasuredMcpServer extends McpServer {
    constructor(serverInfo: ServerInfo, options: ServerOptions, private readonly metrics: ToolMetrics) {
        super(serverInfo, options);
    }

    public override registerTool(name: string, config: RegisterToolConfig, cb: unknown): RegisteredTool {
        // Tools without an input schema receive only the request extra; tools
        // with one receive (args, extra).
        const hasArgs = config.inputSchema !== undefined;
        const original = cb as AnyToolCallback;
        const metrics = this.metrics;

        const measured: AnyToolCallback = async (...callArgs: unknown[]) => {
            const started = Date.now();
            const args = hasArgs ? callArgs[0] : undefined;
            const extra = (hasArgs ? callArgs[1] : callArgs[0]) as { sessionId?: string } | undefined;
            const argBytes = args === undefined ? 0 : Buffer.byteLength(JSON.stringify(args));
            try {
                const result = await original(...callArgs);
                const text = (result.content ?? [])
                    .map((item) => (item.type === 'text' ? item.text : ''))
                    .join('');
                metrics.record({
                    tool: name,
                    argBytes,
                    resultBytes: Buffer.byteLength(JSON.stringify(result)),
                    ms: Date.now() - started,
                    outcome: classifyOutcome(text, result.isError === true),
                    at: Date.now(),
                    sessionId: extra?.sessionId,
                });
                return result;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                metrics.record({
                    tool: name,
                    argBytes,
                    resultBytes: Buffer.byteLength(message),
                    ms: Date.now() - started,
                    outcome: 'error',
                    at: Date.now(),
                    sessionId: extra?.sessionId,
                });
                throw err;
            }
        };

        // The base signature is generic over the zod shapes; the wrapper is
        // shape-agnostic, so hand it over untyped rather than re-deriving them.
        const register = super.registerTool as unknown as (
            this: McpServer, n: string, c: RegisterToolConfig, f: AnyToolCallback,
        ) => RegisteredTool;
        return register.call(this, name, config, measured);
    }
}
