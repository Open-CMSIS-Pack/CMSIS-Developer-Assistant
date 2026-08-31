// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import express from 'express';
import {
    DebuggingExecutor,
    ConfigurationManager,
    DebuggingHandler,
    IDebuggingHandler
} from '.';
import { HardwareTimeouts, SERVER_VERSION } from './debuggingExecutor';
import { logger } from './utils/logger';
import { serialHandler } from './serialHandler';
import { SerialOpName } from './core/opTable';
import type { PackDocsDispatch } from './packDocsDispatch';
import { registerPackDocsTools } from './packDocsTools';
import { registerBuildInfoTools } from './buildInfoTools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MeasuredMcpServer } from './core/measuredMcpServer';
import { ToolMetrics, ToolSample, formatBytes } from './core/toolMetrics';
import { TOPICS, Topic, sliceTopic } from './core/instructionTopics';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

/** The server must never be reachable off-box — it flashes and erases hardware without auth. */
const LOOPBACK_BIND_ADDRESS = '127.0.0.1';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True when an HTTP Host header (hostname with optional port) refers to the
 * loopback interface. A missing Host header is rejected — every legitimate
 * HTTP/1.1 client sends one.
 */
export function isLoopbackHostHeader(host: unknown): boolean {
    if (typeof host !== 'string' || host.length === 0) {
        return false;
    }
    // Strip the port: "[::1]:3001" → "[::1]", "localhost:3001" → "localhost".
    const hostname = host.startsWith('[')
        ? host.replace(/^(\[[^\]]*\]).*$/, '$1')
        : host.replace(/:\d+$/, '');
    return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * True when an Origin header value is a loopback origin (or a non-web value
 * like "null" is absent — browsers send Origin on cross-site POSTs, so a
 * present non-loopback Origin means a foreign web page is calling us).
 */
export function isLoopbackOrigin(origin: string): boolean {
    try {
        return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
    } catch {
        return false;
    }
}

/**
 * The configured port is already served, so another window is the router.
 * Routine, not a failure — every window after the first hits this.
 */
export class PortInUseError extends Error {
    constructor(public readonly port: number) {
        super(`Port ${port} is already in use by another CMSIS Developer Assistant window`);
        this.name = 'PortInUseError';
    }
}

/**
 * How a session reaches the serial backends. Indirected through an op name
 * rather than calling the singleton, because in the multi-window setup the
 * board's USB-serial port is owned by the window that has the board — not by
 * whichever window happens to be running the router.
 */
export type SerialDispatch = (op: SerialOpName, args?: unknown) => Promise<string>;

/** The pair of handlers one MCP session talks to. */
export interface SessionHandlers {
    debug: IDebuggingHandler;
    serial: SerialDispatch;
    /**
     * Documentation / build-artefact dispatch. Absent in the single-window
     * default (no handlers were built), in which case those tools are not
     * registered even when their gates are on.
     */
    packDocs?: PackDocsDispatch;
}

/**
 * True when this session's handler forwards to other windows.
 *
 * A structural check rather than `instanceof RoutingDebuggingHandler`: importing
 * the router here would make debugMCPServer depend on the routing layer even in
 * the single-window build, and these two methods are exactly the contract the
 * routing tools need.
 */
function isRoutingHandler(
    handler: IDebuggingHandler,
): handler is IDebuggingHandler & {
    listDebugWindows(): string;
    selectDebugWindow(args: { pid?: number; workspaceFolder?: string }): string;
} {
    const h = handler as unknown as Record<string, unknown>;
    return typeof h.listDebugWindows === 'function' && typeof h.selectDebugWindow === 'function';
}

/** Single-window dispatch: straight to the local serial handler singleton. */
export const localSerialDispatch: SerialDispatch = (op, args) => {
    const target = serialHandler as unknown as Record<string, unknown>;
    const method = target[op];
    if (typeof method !== 'function') {
        return Promise.reject(new Error(`Serial op ${op} is not implemented`));
    }
    return Promise.resolve((method as (a?: unknown) => Promise<string>).call(serialHandler, args));
};

/**
 * Behaviour switches for one server instance.
 *
 * This module does not import `vscode`, so settings cannot be read here; the
 * extension resolves them once at activation and hands them over through the
 * constructor. The values are fixed for the lifetime of the instance and are
 * applied when each MCP session's `McpServer` is built at `initialize`. A
 * consumer must never toggle behaviour per call on them: the tool list a
 * client sees has to stay stable between turns, otherwise the client's prompt
 * cache is invalidated on every request. A changed setting therefore takes
 * effect for the next client connection after a window reload.
 */
export interface DebugMCPServerOptions {
    /**
     * Register the `serial_*` tools. Default `true`. Off drops them from the
     * tool list for clients that never touch a UART, which shrinks what every
     * turn carries.
     */
    serialEnabled?: boolean;
    /**
     * Register the documentation tools (list_target_docs, search_target_docs,
     * read_doc_pages, fetch_doc, get_peripheral_docs). Default `false` for
     * now: five more tools on every turn, and a `pdftotext` on the PATH to
     * be useful. Fixed per instance like `serialEnabled`.
     */
    packDocsEnabled?: boolean;
    /**
     * Register the build-artefact tools (list_build_artifacts,
     * get_memory_usage, lookup_symbol, get_section_layout,
     * get_build_diagnostics). Default `false` for now; fixed per instance.
     */
    buildInfoEnabled?: boolean;
    /** Per-tool call telemetry. */
    telemetry?: {
        /**
         * Append one JSON line per tool call to this file. Empty or unset
         * disables the sink; the in-memory statistics are always kept.
         */
        jsonlPath?: string;
    };
}

/**
 * Append one JSON line per tool sample to `file`. The first write failure is
 * reported once and the sink goes quiet — telemetry must never turn into a
 * warning on every tool call.
 */
function createJsonlSink(file: string | undefined): ((sample: ToolSample) => void) | undefined {
    if (!file) { return undefined; }
    let muted = false;
    return (sample) => {
        if (muted) { return; }
        fs.appendFile(file, JSON.stringify(sample) + '\n', (err) => {
            if (err && !muted) {
                muted = true;
                logger.warn(`Tool telemetry: cannot append to ${file} (${err.message}); the JSONL sink is off for this server instance`);
            }
        });
    };
}

/**
 * Main MCP server class that exposes debugging functionality as tools and resources.
 * Uses the official @modelcontextprotocol/sdk with SSE transport over express.
 */
export class DebugMCPServer {
    private httpServer: http.Server | null = null;
    private port: number;
    private actualPort: number | null = null;
    private initialized: boolean = false;

    /**
     * Per-MCP-session handler factory. A fresh handler per session is what lets
     * each agent session keep its own routing target (which VS Code window owns
     * the board) once the routing handler is wired in.
     */
    private handlerFactory: () => SessionHandlers;

    /**
     * Live Streamable-HTTP transports keyed by MCP session id. A transport is
     * created on `initialize` and reused for that session's POSTs, its GET SSE
     * stream, and its DELETE teardown.
     */
    private transports: Record<string, StreamableHTTPServerTransport> = {};

    /** See {@link DebugMCPServerOptions}; fixed for this instance. */
    private readonly options: Readonly<DebugMCPServerOptions>;

    /** Every tool call of every session on this instance (bounded ring, running totals). */
    private readonly aggregate = new ToolMetrics(500);

    /** Optional JSONL file sink, from `options.telemetry.jsonlPath`. */
    private readonly sampleSink: ((sample: ToolSample) => void) | undefined;

    constructor(
        port: number,
        timeoutInSeconds: number,
        hardwareTimeouts?: Partial<HardwareTimeouts>,
        handlerFactory?: () => SessionHandlers,
        options: DebugMCPServerOptions = {},
    ) {
        this.options = Object.freeze({ ...options });
        this.sampleSink = createJsonlSink(this.options.telemetry?.jsonlPath);
        if (handlerFactory) {
            this.handlerFactory = handlerFactory;
        } else {
            // Single-window default: debug in this very window, and drive the
            // serial backends directly rather than over a control server.
            const executor = new DebuggingExecutor(hardwareTimeouts);
            const configManager = new ConfigurationManager();
            const handler = new DebuggingHandler(executor, configManager, timeoutInSeconds);
            this.handlerFactory = () => ({ debug: handler, serial: localSerialDispatch });
        }
        this.port = port;
    }

    /** The options this instance was built with. */
    public getOptions(): Readonly<DebugMCPServerOptions> {
        return this.options;
    }

    /** Tool-call statistics across every session this instance has served. */
    public getMetrics(): ToolMetrics {
        return this.aggregate;
    }

    /**
     * Initialize the MCP server. No shared McpServer is constructed — one is
     * built per session, in the POST /mcp handler.
     */
    async initialize() {
        this.initialized = true;
    }

    /**
     * Build a fresh McpServer for one MCP session and register every tool +
     * resource on it.
     *
     * Per *session*, not per request and not shared. The original shared
     * instance was closed and reconnected on every request, so a concurrent
     * call stripped the other's transport and its response went nowhere —
     * that is what made `get_threads` hang after the third call. A
     * session-scoped server never closes mid-flight, so that bug stays fixed
     * while GET /mcp still has a real stream to attach to.
     */
    private createMcpServer(): McpServer {
        // One metrics ring per session: the stats resource and the
        // get_session_status trailer report the session, the aggregate keeps
        // the instance-wide picture, the sink and the log see every sample.
        const metrics = new ToolMetrics(200, (sample) => {
            this.aggregate.record(sample);
            this.sampleSink?.(sample);
            logger.info(`tool=${sample.tool} ms=${sample.ms} in=${formatBytes(sample.argBytes)} ` +
                `out=${formatBytes(sample.resultBytes)} outcome=${sample.outcome}` +
                (sample.sessionId ? ` session=${sample.sessionId.slice(0, 8)}` : ''));
        });
        const mcpServer = new MeasuredMcpServer({
            name: 'cmsis-developer-assistant',
            version: SERVER_VERSION,
        }, {
            // Surfaced to clients at `initialize`. Points agents at the
            // `cmsis-debug-live` Agent Skill, which the extension installs
            // into the standard skills directories, and at
            // get_debug_instructions for harnesses that do not load skills.
            instructions: 'These tools drive a live Arm Cortex-M debug session through the CMSIS Debugger to ' +
                'investigate runtime bugs, faults, crashes, hangs, failing tests, wrong/null values, unexpected ' +
                'output and other "it does not work on the board" reports. For runtime investigations, ' +
                'invoke the "cmsis-debug-live" Agent Skill first: it provides the target-awareness checklist, ' +
                'the session-status gate, breakpoint strategy, step-and-inspect workflow, fault decode and ' +
                'root-cause guidance needed to use these tools effectively instead of guessing or adding ' +
                'temporary printf/UART logging. Harnesses that do not load skills (GitHub Copilot Chat) ' +
                'should call get_debug_instructions instead. Tools that accept timeoutMs use it as a one-call ' +
                'override of the default, capped at 60 s; set it when you can estimate the work.' +
                this.packDocsInstructions(),
        }, metrics);
        const handlers = this.handlerFactory();
        this.setupTools(mcpServer, handlers.debug, handlers.serial, handlers.packDocs, metrics);
        this.setupResources(mcpServer, metrics);
        return mcpServer;
    }

    /**
     * Register every tool on `mcpServer`, routed through `debuggingHandler`.
     *
     * The handler is a parameter rather than an instance field because each
     * MCP session gets its own — in the multi-window setup that handler
     * carries the session's routing target.
     */
    /**
     * The sentence the server instructions gain when a pack-docs gate is on.
     * Options are fixed per instance, so the text is stable per connection.
     */
    private packDocsInstructions(): string {
        let text = '';
        if (this.options.packDocsEnabled) {
            text += ' The documentation tools (list_target_docs, search_target_docs, read_doc_pages, fetch_doc, ' +
                'get_peripheral_docs) answer from the manuals the target\'s packs ship or link, page-cited; they ' +
                'accept timeoutMs up to 600 s because indexing a manual on first use can take minutes. Use them ' +
                'before asking the user for a datasheet or reference manual (list_target_docs, then fetch_doc for ' +
                'a web-linked one) and instead of reading a PDF into your context: a document the user provides ' +
                'belongs in the workspace docs/ folder or the "Import Document for Current Target" command, then ' +
                'search it.';
        } else {
            // Off by default: say so, or an agent on a default install asks the
            // user for the manual and reads PDFs itself.
            text += ' Page-cited documentation tools (search over the target\'s pack manuals, datasheets and errata) ' +
                'are available behind the setting cmsis-developer-assistant.packDocs.enabled; suggest enabling ' +
                'it rather than asking the user for a document or reading a PDF yourself.';
        }
        if (this.options.buildInfoEnabled) {
            text += ' The build-artefact tools (list_build_artifacts, get_memory_usage, lookup_symbol, ' +
                'get_section_layout, get_build_diagnostics) read the ELF, linker map and build log of the current target.';
        }
        return text;
    }

    private setupTools(
        mcpServer: McpServer,
        debuggingHandler: IDebuggingHandler,
        serial: SerialDispatch,
        packDocs: PackDocsDispatch | undefined,
        metrics: ToolMetrics,
    ) {
        // One short line per tool; the rationale lives once in the server instructions.
        const TIMEOUT_DESC = 'Per-call timeout in ms, max 60000 (see server instructions).';

        // Get debug instructions tool (for clients that don't support MCP
        // resources like GitHub Copilot). Served by topic so a harness pays for
        // one section, not the whole guide, on every session.
        mcpServer.registerTool('get_debug_instructions', {
            description: 'Debugging guide for harnesses that do not load the "cmsis-debug-live" Agent Skill. ' +
                'Default: a short overview plus the topic list; pass topic for one section ' +
                '(session, build, breakpoints, inspection, faults, troubleshooting).',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                topic: z.enum(TOPICS).optional().describe('Section to return. Default: overview (~2 KB) with the topic list.'),
            },
        }, async (args: { topic?: Topic }) => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            let text: string;
            try {
                text = sliceTopic(content, args.topic);
            } catch (err) {
                // A broken marker in the shipped guide must not take the tool down.
                logger.warn(`get_debug_instructions: cannot slice topics (${err instanceof Error ? err.message : String(err)}); serving the whole guide`);
                text = content;
            }
            return { content: [{ type: 'text' as const, text }] };
        });

        // Start debugging tool
        mcpServer.registerTool('start_debugging', {
            description: 'Start a debug session through the VS Code debug pipeline (launch.json). ' +
                'Invoke the "cmsis-debug-live" skill first. For CMSIS / Cortex-M projects prefer cmsis_action ' +
                'load_and_debug (builds, flashes, attaches); start_debugging skips the flash step and suits ' +
                'non-CMSIS projects or attaching to an already-flashed target. Refuses while a session is active.',
            inputSchema: {
                fileFullPath: z.string().optional().describe('Source file to debug; optional when configurationName is given.'),
                workingDirectory: z.string().describe('Working directory for the debug session'),
                testName: z.string().optional().describe('Only when debugging a single test; empty for the whole file.'),
                configurationName: z.string().optional().describe(
                    'launch.json configuration name, e.g. "CMSIS Debugger: pyOCD"; empty prompts the user.'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleStartDebugging(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Stop debugging tool
        mcpServer.registerTool('stop_debugging', {
            description: 'Stop the current debug session',
        }, async () => {
            const result = await debuggingHandler.handleStopDebugging();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step over tool
        mcpServer.registerTool('step_over', {
            description: 'Execute the current line of code without diving into it.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleStepOver(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step into tool
        mcpServer.registerTool('step_into', {
            description: 'Dive into the current line of code.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleStepInto(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step out tool
        mcpServer.registerTool('step_out', {
            description: 'Step out of the current function',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleStepOut(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Pause tool — halts a running target without ending the session.
        mcpServer.registerTool('pause_execution', {
            description: 'Pause a running target so inspection tools (variables, memory, registers, ' +
                'call stack) become valid. No-op if the target is already stopped. Returns the new ' +
                'debug state on success, or a structured error if the probe is unresponsive.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handlePause(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Continue execution tool
        mcpServer.registerTool('continue_execution', {
            description: 'Resume program execution until the next breakpoint is hit or the program completes.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleContinue(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Wait-for-stop tool — blocks until the target next stops, without
        // issuing any execution command itself.
        mcpServer.registerTool('wait_for_stop', {
            description: 'Block until the target next stops (breakpoint, fault, step, pause) and return the reason and ' +
                'state, or a structured timeout — instead of sleeping blind after continue_execution or "-exec continue". ' +
                'Returns at once if already stopped; issues no execution commands.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleWaitForStop(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Restart debugging tool
        mcpServer.registerTool('restart_debugging', {
            description: 'Restart the debug session from the beginning with the same configuration.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleRestart(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Reset tool — resets the target inside the live session, verified.
        mcpServer.registerTool('reset', {
            description: 'Reset the target inside the live session (breakpoints survive, unlike restart_debugging) ' +
                'and verify it: the PC is compared against the reset vector and the result says when the target ' +
                'did NOT reset. A running target is halted first.',
            annotations: { readOnlyHint: false, destructiveHint: true },
            inputSchema: {
                method: z.enum(['auto', 'system', 'core', 'hardware']).optional()
                    .describe("'auto' (default) escalates system (SYSRESETREQ) → core (VECTRESET) → hardware " +
                        '(nSRST, needs the reset line wired) until one verifies.'),
                halt: z.boolean().optional()
                    .describe('Leave the target halted at the reset vector (default true). false resumes after verification.'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { method?: 'auto' | 'system' | 'core' | 'hardware'; halt?: boolean; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleReset(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Add breakpoint tool
        mcpServer.registerTool('add_breakpoint', {
            description: 'Set a breakpoint at a line. Cortex-M binds only a few at once (FPB comparators, ' +
                'typically 4–8) — clear ones you no longer need.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().int().min(1).optional().describe('Line number (1-based). Preferred.'),
                condition: z.string().optional().describe(
                    'Optional condition, e.g. "i == 100" — GDB-native, so the core halts only when it holds.'),
                lineContent: z.string().optional().describe(
                    'DEPRECATED: substring match that breaks on EVERY line containing the text; pass line instead.'),
            },
        }, async (args: { fileFullPath: string; line?: number; condition?: string; lineContent?: string }) => {
            const result = await debuggingHandler.handleAddBreakpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Add logpoint tool
        mcpServer.registerTool('add_logpoint', {
            description: 'Breakpoint that prints a message and resumes. Interpolate with {expr} (%d) or ' +
                '{expr:%s|%f|%p|%08lx}; {{ }} are literal braces. On Cortex-M the core still halts on every hit ' +
                'while GDB prints — in an ISR or hot loop prefer read_cycle_counter or a RAM buffer read with read_memory.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().int().min(1).describe('Line number (1-based)'),
                logMessage: z.string().describe('Message; {expr} interpolates runtime values.'),
                condition: z.string().optional().describe('Optional condition; logs only when true.'),
            },
        }, async (args: { fileFullPath: string; line: number; logMessage: string; condition?: string }) => {
            const result = await debuggingHandler.handleAddLogpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Remove breakpoint tool
        mcpServer.registerTool('remove_breakpoint', {
            description: 'Remove a breakpoint that is no longer needed.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().describe('Line number (1-based)'),
            },
        }, async (args: { fileFullPath: string; line: number }) => {
            const result = await debuggingHandler.handleRemoveBreakpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Clear all breakpoints tool
        mcpServer.registerTool('clear_all_breakpoints', {
            description: 'Clear all breakpoints at once. Use this after verifying the root cause to clean up before moving on to the next task.',
        }, async () => {
            const result = await debuggingHandler.handleClearAllBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // List breakpoints tool
        mcpServer.registerTool('list_breakpoints', {
            description: 'View all currently set breakpoints across all files.',
        }, async () => {
            const result = await debuggingHandler.handleListBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // List variable names tool (discovery without reading any values)
        mcpServer.registerTool('list_variable_names', {
            description: 'List the names and types of variables visible at the current execution point, without reading their values. ' +
                'Use this to discover what exists, then pull only what you need with get_variables_values — on a slow probe that is the difference between one round trip and thirty.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { scope?: 'local' | 'global' | 'all'; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleListVariableNames(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get variables tool
        mcpServer.registerTool('get_variables_values', {
            description: 'Inspect variable values at the current execution point. This is your window into program state - see what data looks like at runtime, verify assumptions, identify unexpected values, and understand why code behaves as it does. ' +
                'Omit variableNames to dump the whole scope (capped at 40 variables per scope and 200 chars per value); pass variableNames to read exactly what you need, uncapped.',
            inputSchema: {
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
                variableNames: z.array(z.string()).min(1).max(50).optional().describe(
                    'Optional filter: read only these variables, e.g. ["adc_raw", "state"]. ' +
                    'Names that match nothing are reported back. Omit to return everything in scope.',
                ),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { scope?: 'local' | 'global' | 'all'; variableNames?: string[]; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleGetVariables(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Evaluate expression tool
        mcpServer.registerTool('evaluate_expression', {
            description: 'Powerful runtime expression evaluator: Test hypotheses, check computed values, call methods, or inspect object properties in the live debug context. Goes beyond simple variable inspection - evaluate any valid expression in the target language.',
            inputSchema: {
                expression: z.string().describe('Expression to evaluate in the current programming language context'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { expression: string; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleEvaluateExpression(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // ========== Embedded / Cortex-M Tools ==========

        // Read memory tool
        mcpServer.registerTool('read_memory', {
            description: 'Read a range of bytes from the target\'s memory. ' +
                'Use this for inspecting SRAM, Flash, peripheral registers, or the stack. ' +
                'Returns hex dump and/or ASCII representation. Hex by default; format ascii or both on request.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                address: z.string().describe("Memory address as hex string, e.g. '0x20000000'"),
                length: z.number().int().min(1).max(4096).describe('Number of bytes to read (1-4096)'),
                format: z.enum(['hex', 'ascii', 'both']).default('hex').describe("'hex' (default), 'ascii', or 'both'"),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleReadMemory(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Read core registers tool
        mcpServer.registerTool('read_core_registers', {
            description: 'Read Cortex-M core registers: R0-R12, SP, LR, PC, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK. ' +
                'Essential for analyzing crash state, stack pointers, and processor mode.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleReadCoreRegisters(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // DWT cycle counter tool — cycle-accurate timing on the target.
        mcpServer.registerTool('read_cycle_counter', {
            description: 'Read the DWT cycle counter for cycle-accurate timing: read, run to the end point, read again, ' +
                'subtract mod 2^32. Wraps (~10.7 s @ 400 MHz); counts ACTIVE cycles only (stops while halted and in ' +
                'WFE). Enables DWT/CYCCNT on first use; reports cores without one.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleReadCycleCounter(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Read peripheral register tool
        mcpServer.registerTool('read_peripheral_register', {
            description: 'Read named peripheral registers using SVD data from the Peripheral Inspector extension. ' +
                'Provide a peripheral name (e.g. "GPIOA", "UART0", "SPI1") and optionally a register name. ' +
                'If the Peripheral Inspector is not available, provides guidance on using read_memory instead.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                peripheral: z.string().describe("Peripheral name, e.g. 'GPIOA', 'UART0', 'RCC'"),
                register: z.string().optional().describe("Register name, e.g. 'ODR', 'CR1'. If omitted, lists all registers in the peripheral."),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { peripheral: string; register?: string; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleReadPeripheralRegister(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get fault info tool
        mcpServer.registerTool('get_fault_info', {
            description: 'Read and decode the Cortex-M fault status registers (CFSR, HFSR, BFAR, MMFAR, DFSR, AFSR) ' +
                'bit by bit. For a one-call triage with the stacked frame, the call stack and hypotheses, ' +
                'prefer diagnose_fault.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleGetFaultInfo(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // One-call fault triage.
        mcpServer.registerTool('diagnose_fault', {
            description: 'Triage a HardFault / BusFault / MemManage / UsageFault in one call on a stopped target: decoded ' +
                'fault registers, the stacked exception frame (PC of the faulting instruction, its caller), the top ' +
                'frames, the faulting address resolved against the SVD, and up to three ranked hypotheses each with ' +
                'the next tool call. Reports a short stop context when no fault flag is set.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                levels: z.number().int().min(1).max(20).optional().describe('Call-stack frames to include (default 3)'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { levels?: number; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleDiagnoseFault(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // SVD lookups — no target access, no session required.
        mcpServer.registerTool('lookup_peripheral', {
            description: 'Answer "which peripheral is at this address" or "which registers does this peripheral have" ' +
                'from the device SVD — no session, no target access. name: the register map; address: the peripheral ' +
                'and register containing it (resolve a BFAR); neither: the peripheral list. Unknown names get suggestions.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                name: z.string().optional().describe('Peripheral name, e.g. RCC (case-insensitive)'),
                address: z.string().optional().describe('Address to resolve, e.g. 0x40005400'),
                filter: z.string().optional().describe('Name prefix to narrow the list or the register map'),
                svdFile: z.string().optional().describe('Explicit .svd path; default: session, cbuild-run.yml, workspace'),
                pname: z.string().optional().describe('Processor name selecting the SVD in a multi-core cbuild-run'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { name?: string; address?: string; filter?: string; svdFile?: string; pname?: string; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleLookupPeripheral(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('lookup_register', {
            description: 'Describe one register from the device SVD without reading the target: address, access, reset ' +
                'value, bit fields with their enumerated values. Use it to learn which bit is the clock enable before ' +
                'read_peripheral_register or read_memory.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                peripheral: z.string().describe('Peripheral name, e.g. RCC'),
                register: z.string().describe('Register name, e.g. APB1ENR'),
                svdFile: z.string().optional().describe('Explicit .svd path; default: session, cbuild-run.yml, workspace'),
                pname: z.string().optional().describe('Processor name selecting the SVD in a multi-core cbuild-run'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { peripheral: string; register: string; svdFile?: string; pname?: string; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleLookupRegister(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get device info tool
        mcpServer.registerTool('get_device_info', {
            description: 'Return information about the connected debug target: session name, debug type, program path, ' +
                'GDB path, GDB server, port, and CMSIS config details.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await debuggingHandler.handleGetDeviceInfo();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Check target connection tool
        mcpServer.registerTool('check_target_connection', {
            description: 'Probe the hardware debug connection with a short-timeout DAP ping. ' +
                'Use this when other tool calls start timing out or returning "unavailable" ' +
                'to determine whether the probe/GDB server is alive and whether the target ' +
                'is stopped (so DAP reads are valid). Never hangs — uses an internal short timeout.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await debuggingHandler.handleCheckTargetConnection();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get call stack tool
        mcpServer.registerTool('get_call_stack', {
            description: 'Return the full call stack (function names, source, line, frameId) for the active thread, ' +
                'or a specific thread when threadId is provided. Use the returned frameId values with ' +
                'get_frame_variables to inspect variables of caller frames without changing the active frame. Paths are workspace-relative; beyond 20 frames the rest is counted unless levels is given.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                threadId: z.number().int().optional().describe('Optional DAP thread id (from get_threads). Defaults to the active thread.'),
                levels: z.number().int().min(1).max(200).optional().describe('Maximum frames to return (default 50).'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { threadId?: number; levels?: number; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleGetCallStack(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get threads / RTOS tasks tool
        mcpServer.registerTool('get_threads', {
            description: 'List DAP threads reported by the debug adapter. With an RTOS-aware GDB server ' +
                '(pyOCD --rtos, J-Link RTOS plugin) each FreeRTOS / RTX / ThreadX task appears as a thread, ' +
                'matching the xRTOS viewer task list. Returns the thread id, name and top frame; pair with ' +
                'get_call_stack(threadId=...) to inspect any task\'s call stack. Lists up to 32 tasks inline.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await debuggingHandler.handleGetThreads(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get frame variables tool
        mcpServer.registerTool('get_frame_variables', {
            description: 'Inspect variables of a specific stack frame by its frameId (obtained from get_call_stack). ' +
                'Lets you walk up the call stack and examine caller-frame state without changing the ' +
                'editor\'s active frame. Without variableNames the listing is capped (40 per scope, 200 chars per value); with it, uncapped.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                frameId: z.number().int().describe('DAP frame id, as returned by get_call_stack.'),
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
                variableNames: z.array(z.string()).min(1).max(50).optional().describe(
                    'Optional filter: read only these variables. Omit to return everything in the frame.',
                ),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { frameId: number; scope?: 'local' | 'global' | 'all'; variableNames?: string[]; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleGetFrameVariables(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // ========== Serial — dual backend ==========
        //
        // Two backends, one tool surface:
        //   • OWNED: serialController opens a port via `serialport` (we own it).
        //   • BRIDGE: serialMonitorBridge taps the MS Serial Monitor extension
        //     API at runtime — uses whatever the public API exposes today
        //     (port enum), and auto-lights up data subscription if MS adds it.
        //
        // OS reality: only one process can read a tty in non-exclusive mode.
        // If the user has an MS Serial Monitor session open on the same path,
        // the OWNED backend will fail to open. Use serial_subscribe_monitor
        // in that case (zero conflict — taps via API, not the kernel).

        // Gated per server instance (never per call — the tool list a client
        // sees must stay stable between turns) by the serial.enabled setting.
        if (this.options.serialEnabled !== false) {
            mcpServer.registerTool('serial_list_ports', {
                description: 'List available serial ports. Tries the MS Serial Monitor API first (friendly names), ' +
                    'falls back to the bundled serialport library.',
                annotations: { readOnlyHint: true, destructiveHint: false },
            }, async () => {
                const result = await serial('handleListPorts');
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_open', {
                description: 'Open an OWNED serial port. The MCP server holds the connection and buffers RX. ' +
                    'Use only when no MS Serial Monitor UI session is active on the same path — the OS allows ' +
                    'one reader per tty. Defaults: 115200 baud, 8N1, no flow control.',
                inputSchema: {
                    path: z.string().describe("Device path, e.g. '/dev/tty.usbmodemABCD' on macOS or 'COM3' on Windows"),
                    baudRate: z.number().int().optional().describe('Baud rate (default 115200)'),
                    dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
                    parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional(),
                    stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
                    rtscts: z.boolean().optional().describe('RTS/CTS hardware flow control (default false)'),
                },
            }, async (args: { path: string; baudRate?: number; dataBits?: 5 | 6 | 7 | 8; parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'; stopBits?: 1 | 1.5 | 2; rtscts?: boolean }) => {
                const result = await serial('handleOpen', args);
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_close', {
                description: 'Close the OWNED serial port (does not affect the MS Serial Monitor UI).',
            }, async () => {
                const result = await serial('handleClose');
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_status', {
                description: 'Report state of both backends: owned port (open / buffer size) and Serial Monitor ' +
                    'bridge (extension installed / activated / data-subscription available / subscribed). ' +
                    'Includes the discovered API keys so you can see what MS exposes in the installed build.',
                annotations: { readOnlyHint: true, destructiveHint: false },
            }, async () => {
                const result = await serial('handleStatus');
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_write', {
                description: 'Write to the OWNED serial port. Encoding utf8 (default) or hex.',
                inputSchema: {
                    data: z.string().describe("Payload. For encoding='hex' use a hex string like '0a 1b 2c'."),
                    encoding: z.enum(['utf8', 'hex']).optional(),
                    appendNewline: z.boolean().optional().describe("Append '\\n' to utf8 payloads (default false)"),
                },
            }, async (args: { data: string; encoding?: 'utf8' | 'hex'; appendNewline?: boolean }) => {
                const result = await serial('handleWrite', args);
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_read', {
                description: 'Read buffered RX bytes from either backend. ' +
                    "Set from='owned' (default) for the MCP-owned port, from='monitor' for bytes captured " +
                    'via the Serial Monitor bridge subscription. consume=true (default) drains the buffer; ' +
                    'consume=false peeks. waitMs blocks up to that many ms when buffer is empty.',
                annotations: { readOnlyHint: true, destructiveHint: false },
                inputSchema: {
                    maxBytes: z.number().int().min(1).optional(),
                    waitMs: z.number().int().min(0).max(60000).optional(),
                    consume: z.boolean().optional(),
                    format: z.enum(['utf8', 'hex', 'both']).optional(),
                    from: z.enum(['owned', 'monitor']).optional().describe("Backend to read from (default 'owned')"),
                },
            }, async (args: { maxBytes?: number; waitMs?: number; consume?: boolean; format?: 'utf8' | 'hex' | 'both'; from?: 'owned' | 'monitor' }) => {
                const result = await serial('handleRead', args);
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_clear_buffer', {
                description: "Discard buffered RX without reading. from='owned' (default) or 'monitor'.",
                inputSchema: {
                    from: z.enum(['owned', 'monitor']).optional(),
                },
            }, async (args: { from?: 'owned' | 'monitor' }) => {
                const result = await serial('handleClearBuffer', args);
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_subscribe_monitor', {
                description: 'Subscribe to the MS Serial Monitor extension\'s data event to read the bytes the user\'s ' +
                    'UI session receives — no port fight. Errors clearly when the installed build exposes no data ' +
                    "event (then serial_open). Read with serial_read from='monitor'.",
            }, async () => {
                const result = await serial('handleSubscribeMonitor');
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_unsubscribe_monitor', {
                description: 'Stop the Serial Monitor data subscription (the user\'s UI session is unaffected).',
            }, async () => {
                const result = await serial('handleUnsubscribeMonitor');
                return { content: [{ type: 'text' as const, text: result }] };
            });

            mcpServer.registerTool('serial_open_monitor', {
                description: 'Focus the Microsoft Serial Monitor panel so the user can see / drive their existing ' +
                    'session. UI-only — does not open or read a port. Pair with serial_subscribe_monitor to also ' +
                    'feed bytes back to the agent.',
            }, async () => {
                const result = await serial('handleOpenInUi');
                return { content: [{ type: 'text' as const, text: result }] };
            });
        }

        // Documentation and build-artefact tools — gated per server instance
        // like the serial group, and only when this session has a dispatch
        // (the extension built the handlers; the bare single-window default
        // has none).
        if (packDocs && this.options.packDocsEnabled) {
            registerPackDocsTools(mcpServer, packDocs);
        }
        if (packDocs && this.options.buildInfoEnabled) {
            registerBuildInfoTools(mcpServer, packDocs);
        }

        // CMSIS Solution flash / debug control tool — wraps the CMSIS panel buttons.
        mcpServer.registerTool('cmsis_action', {
            description: 'The entry point for CMSIS / Cortex-M debugging: drives the CMSIS Solution extension on ' +
                'the active csolution target, like the panel buttons; every result names the target it ran on. ' +
                'build / load / erase / load_and_run wait for the task and end with ✅ or ❌ plus the exit code — ' +
                'read that line, do not poll for files. load_and_debug (flash + debug, the Debug button) and ' +
                'attach (no programming) return with the session state; detach and stop_run are immediate. ' +
                'Long builds: get_debug_instructions topic build.',
            inputSchema: {
                action: z.enum([
                    'build', 'load', 'erase',
                    'load_and_run', 'load_and_debug',
                    'attach', 'detach', 'stop_run',
                ]).describe('Which CMSIS Solution action to invoke'),
                target: z.string().optional().describe('Target-type or type@set from the csolution (e.g. "MPS3", ' +
                    '"HP@debug"). Switched and verified when it differs from the active one; omit to use the panel selection.'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC + ' For load_and_debug / attach: the session-readiness wait.'),
            },
        }, async (args: { action: 'build' | 'load' | 'erase' | 'load_and_run' | 'load_and_debug' | 'attach' | 'detach' | 'stop_run'; target?: string; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleCmsisCommand(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Flash tool — programs the target via `pyocd load --cbuild-run` and
        // returns bytes programmed / structured error synchronously.
        mcpServer.registerTool('flash', {
            description: 'Program the target with pyocd load --cbuild-run (every image in the cbuild-run file) and ' +
                'return bytes programmed, or the exit code with pyOCD\'s error lines. Refuses while a debug session ' +
                'is active: stop_debugging → flash → cmsis_action attach. The cbuild-run file is auto-resolved when ' +
                'omitted; needs pyocd on PATH.',
            annotations: { readOnlyHint: false, destructiveHint: true },
            inputSchema: {
                cbuildRunFile: z.string().optional()
                    .describe('Path to the .cbuild-run.yml to program. Omit to auto-resolve from launch.json / out/.'),
                timeoutMs: z.number().int().min(1_000).max(60_000).optional()
                    .describe(TIMEOUT_DESC + ' Flash defaults to 60 s.'),
            },
        }, async (args: { cbuildRunFile?: string; timeoutMs?: number }) => {
            const result = await debuggingHandler.handleFlash(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get session status tool
        mcpServer.registerTool('get_session_status', {
            description: 'Report the debug-session state: no-session, initializing, running, stopped or unresponsive, ' +
                'with the right next action and the session\'s tool-call totals. Never hangs, never throws — call it ' +
                'whenever a tool said the session is not ready or a call seemed to time out.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await debuggingHandler.handleGetSessionStatus();
            // The session's tool-call statistics ride along here so an agent
            // (or its user) sees the running cost without a separate call.
            return { content: [{ type: 'text' as const, text: `${result}\n\n${metrics.formatTotals()}` }] };
        });

        // ========== Multi-window routing ==========
        //
        // Only registered when this server is actually routing. In a
        // single-window setup there is nothing to choose between, and offering
        // the tools would just invite the agent to reason about a non-problem.
        if (isRoutingHandler(debuggingHandler)) {
            const router = debuggingHandler;

            mcpServer.registerTool('list_debug_windows', {
                description: 'List the VS Code windows this MCP server can drive, with their workspace folders, ' +
                    'whether each has an active debug session, and which one this session is currently targeting. ' +
                    'Use it when a tool reports an ambiguous target, or when you suspect you are driving the wrong board.',
                annotations: { readOnlyHint: true, destructiveHint: false },
            }, async () => {
                return { content: [{ type: 'text' as const, text: router.listDebugWindows() }] };
            });

            mcpServer.registerTool('select_debug_window', {
                description: 'Pin this session to one VS Code window, by process id or by a path inside its workspace. ' +
                    'Every subsequent tool call runs in that window. Needed when several windows are open and more ' +
                    'than one has a debug session, since the server refuses to guess which board you mean.',
                inputSchema: {
                    pid: z.number().int().optional().describe('Process id of the window, as reported by list_debug_windows.'),
                    workspaceFolder: z.string().optional().describe('Any path inside the target window\'s workspace folder.'),
                },
            }, async (args: { pid?: number; workspaceFolder?: string }) => {
                return { content: [{ type: 'text' as const, text: router.selectDebugWindow(args) }] };
            });
        }
    }

    /**
     * Setup MCP resources for documentation
     */
    private setupResources(mcpServer: McpServer, metrics: ToolMetrics) {
        // Live tool-call statistics: what this session and this server
        // instance have sent so far. JSON, so a driver can diff it around a run.
        mcpServer.registerResource('Tool call statistics', 'cmsis-developer-assistant://stats', {
            description: 'Per-tool call counts, bytes in/out, durations and outcomes for this MCP session ' +
                'and for the whole server instance, plus the most recent samples',
            mimeType: 'application/json',
        }, async (uri: URL) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({
                    session: metrics.totals(),
                    server: this.aggregate.totals(),
                    recent: metrics.samples().slice(-50),
                }, null, 2),
            }],
        }));

        // Add MCP resources for debugging documentation
        mcpServer.registerResource('Debugging Instructions Guide', 'cmsis-developer-assistant://docs/debug_instructions', {
            description: 'Step-by-step instructions for debugging with CMSIS Developer Assistant',
            mimeType: 'text/markdown',
        }, async (uri: URL) => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/markdown',
                    text: content,
                }]
            };
        });

        // Add language-specific resources
        const languages = ['python', 'javascript', 'java', 'csharp'];
        const languageTitles: Record<string, string> = {
            'python': 'Python Debugging Tips',
            'javascript': 'JavaScript Debugging Tips',
            'java': 'Java Debugging Tips',
            'csharp': 'C# Debugging Tips'
        };

        languages.forEach(language => {
            mcpServer.registerResource(
                languageTitles[language],
                `cmsis-developer-assistant://docs/troubleshooting/${language}`,
                {
                    description: `Debugging tips specific to ${language}`,
                    mimeType: 'text/markdown',
                },
                async (uri: URL) => {
                    const content = await this.loadMarkdownFile(`agent-resources/troubleshooting/${language}.md`);
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: 'text/markdown',
                            text: content,
                        }]
                    };
                }
            );
        });

        // Add CMSIS embedded debugging guide resource
        mcpServer.registerResource(
            'CMSIS Embedded Debugging Guide',
            'cmsis-developer-assistant://docs/cmsis-embedded-guide',
            {
                description: 'Comprehensive guide for debugging Cortex-M embedded targets using CMSIS tools, including fault analysis, peripheral inspection, and memory layout.',
                mimeType: 'text/markdown',
            },
            async (uri: URL) => {
                const content = await this.loadMarkdownFile('agent-resources/cmsis-embedded-guide.md');
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: 'text/markdown',
                        text: content,
                    }]
                };
            }
        );

        // Add embedded troubleshooting resource
        mcpServer.registerResource(
            'Embedded Debugging Tips',
            'cmsis-developer-assistant://docs/troubleshooting/embedded',
            {
                description: 'Troubleshooting tips for embedded Cortex-M debugging, HardFault analysis, and peripheral issues.',
                mimeType: 'text/markdown',
            },
            async (uri: URL) => {
                const content = await this.loadMarkdownFile('agent-resources/troubleshooting/embedded.md');
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: 'text/markdown',
                        text: content,
                    }]
                };
            }
        );
    }

    /** Shipped docs are immutable per install, so each is read once per server instance. */
    private readonly markdownCache = new Map<string, string>();

    /**
     * Load content from a Markdown file in the docs directory
     */
    private async loadMarkdownFile(relativePath: string): Promise<string> {
        const cached = this.markdownCache.get(relativePath);
        if (cached !== undefined) {
            return cached;
        }
        // Packaged, docs/ sits next to dist/; compiled to out/src for the
        // headless transport harness it is one level further up.
        const candidates = [
            path.join(__dirname, '..', 'docs', relativePath),
            path.join(__dirname, '..', '..', 'docs', relativePath),
        ];
        try {
            let content: string | undefined;
            let docsPath = candidates[0];
            for (const candidate of candidates) {
                try {
                    content = await fs.promises.readFile(candidate, 'utf8');
                    docsPath = candidate;
                    break;
                } catch {
                    // try the next location
                }
            }
            if (content === undefined) {
                throw new Error(`not found at ${candidates.join(' or ')}`);
            }
            logger.debug(`Loaded ${relativePath} (${content.length} chars) from ${docsPath}`);
            this.markdownCache.set(relativePath, content);

            return content;
        } catch (error) {
            console.error(`Failed to load ${relativePath}:`, error);
            return `Error loading documentation from ${relativePath}: ${error}`;
        }
    }

    /**
     * Start the MCP server with Streamable HTTP transport
     */
    async start(): Promise<void> {
        try {
            logger.info(`Starting CMSIS Developer Assistant server (preferred port ${this.port})...`);

            const app = express();

            // Defense-in-depth against DNS rebinding: the server is bound to
            // the loopback interface (below), but a malicious web page can
            // still reach 127.0.0.1 through the victim's browser by pointing
            // its own DNS record at 127.0.0.1 — the browser then happily
            // POSTs to "attacker.com" which resolves to this server. Such
            // requests carry the attacker's Host/Origin, so reject anything
            // that isn't loopback. Port-agnostic on purpose: the server may
            // run on an OS-assigned fallback port.
            app.use((req: any, res: any, next: any) => {
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
            });

            // Parse JSON body for incoming requests
            app.use(express.json());

            // POST /mcp — client→server JSON-RPC. An `initialize` request with
            // no session id opens a session (transport + McpServer pair) and is
            // remembered by the generated id; later requests carrying that
            // `mcp-session-id` reuse the same transport.
            //
            // Stateful session mode, not stateless. Stateless
            // (sessionIdGenerator: undefined) cannot serve the server→client
            // SSE stream a client opens with GET /mcp right after initialize,
            // and it has no session identity for the routing handler to hang a
            // target window off. It is also not what fixed the old
            // `get_threads`-hangs-after-three-calls bug: that was a *shared*
            // McpServer being closed and reconnected per request. A
            // session-scoped server is never closed mid-flight.
            app.post('/mcp', async (req: any, res: any) => {
                try {
                    const sessionId = req.headers['mcp-session-id'] as string | undefined;
                    let transport: StreamableHTTPServerTransport;

                    if (sessionId && this.transports[sessionId]) {
                        transport = this.transports[sessionId];
                    } else if (!sessionId && isInitializeRequest(req.body)) {
                        transport = new StreamableHTTPServerTransport({
                            sessionIdGenerator: () => randomUUID(),
                            onsessioninitialized: (sid: string) => {
                                this.transports[sid] = transport;
                                logger.info(`MCP session initialized: ${sid}`);
                            },
                        });
                        transport.onclose = () => {
                            const sid = transport.sessionId;
                            if (sid && this.transports[sid]) {
                                delete this.transports[sid];
                                logger.info(`MCP session closed: ${sid}`);
                            }
                        };
                        const sessionServer = this.createMcpServer();
                        await sessionServer.connect(transport);
                    } else {
                        res.status(400).json({
                            jsonrpc: '2.0',
                            error: { code: -32000, message: 'Bad Request: no valid session ID provided' },
                            id: null,
                        });
                        return;
                    }

                    await transport.handleRequest(req, res, req.body);
                } catch (err) {
                    logger.error('MCP request handling failed', err);
                    if (!res.headersSent) {
                        res.status(500).json({
                            jsonrpc: '2.0',
                            error: { code: -32603, message: 'Internal MCP server error' },
                            id: null,
                        });
                    }
                }
            });

            // GET /mcp opens the server→client SSE notification stream for an
            // existing session; DELETE /mcp tears one down. Both MUST be
            // registered here at startup: previously only POST was, so GET fell
            // through to Express's default 404. Cursor's MCP client treats that
            // failed stream open as a fatal transport error and tombstones the
            // connection as "errored" even while POST tool calls work fine.
            const handleSessionRequest = async (req: any, res: any) => {
                const sessionId = req.headers['mcp-session-id'] as string | undefined;
                if (!sessionId || !this.transports[sessionId]) {
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: { code: -32000, message: 'Bad Request: invalid or missing session ID' },
                        id: null,
                    });
                    return;
                }
                await this.transports[sessionId].handleRequest(req, res);
            };
            app.get('/mcp', handleSessionRequest);
            app.delete('/mcp', handleSessionRequest);

            // Legacy SSE endpoint for backward compatibility
            app.get('/sse', async (req: any, res: any) => {
                res.status(410).json({
                    error: 'SSE endpoint deprecated',
                    message: 'Please use POST /mcp endpoint instead',
                    newEndpoint: '/mcp'
                });
            });

            // Bind the configured port. There is deliberately no fallback to an
            // OS-assigned port: that fallback is what produced the misrouting.
            // Every window got its own server, agentConfigurationManager wrote
            // whichever port this window happened to receive, and the last
            // window to start won — so the agent's single MCP URL pointed at an
            // arbitrary window rather than the one holding the board. Losing the
            // bind now means "another window is the router", and the caller
            // makes this window a worker instead.
            this.httpServer = await this.listenOnce(app, this.port, LOOPBACK_BIND_ADDRESS);

            // The port is read back from the bound socket, never assumed from
            // `this.port` — a wrong value here would make us advertise another
            // window's server to our agents.
            const addr = this.httpServer.address();
            if (typeof addr !== 'object' || addr === null) {
                throw new Error('HTTP server reported no address after binding');
            }
            this.actualPort = addr.port;

            // Keep a permanent error listener attached: an unhandled 'error'
            // on the server (e.g. the socket dies later) would otherwise take
            // down the extension host.
            this.httpServer.on('error', (err) => logger.error('MCP HTTP server error', err));

            logger.info(`CMSIS Developer Assistant server started successfully on 127.0.0.1:${this.actualPort}`);

        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
                // Expected whenever a second window opens: another window is
                // already the router. Distinguishable so the caller can become
                // a worker rather than reporting a failure to the user.
                logger.info(`Port ${this.port} is already served — this window will be a worker`);
                throw new PortInUseError(this.port);
            }
            logger.error(`Failed to start CMSIS Developer Assistant server`, error);
            throw new Error(`Failed to start CMSIS Developer Assistant server: ${error}`);
        }
    }

    /**
     * Bind one listener and resolve only once the socket is really listening.
     *
     * Do NOT use express's `app.listen(port, host, callback)` callback as a
     * success signal: in Express 5 that callback is invoked unconditionally,
     * before the bind result is known, so on EADDRINUSE it fires with
     * `server.address() === null` and the 'error' event follows afterwards.
     * Only the server's own 'listening' event means the bind succeeded.
     */
    private listenOnce(app: ReturnType<typeof express>, port: number, host: string): Promise<http.Server> {
        return new Promise<http.Server>((resolve, reject) => {
            const server = app.listen(port, host);

            const onListening = () => {
                server.removeListener('error', onError);
                resolve(server);
            };
            const onError = (err: NodeJS.ErrnoException) => {
                server.removeListener('listening', onListening);
                server.close(() => { /* nothing bound; just release the handle */ });
                reject(err);
            };

            server.once('listening', onListening);
            server.once('error', onError);
        });
    }

    /**
     * Stop the MCP server
     */
    async stop() {
        // Close every live MCP session transport. In stateful mode these
        // outlive individual requests, so without this the SSE streams and
        // their sockets survive the HTTP server close.
        for (const sessionId of Object.keys(this.transports)) {
            try {
                await this.transports[sessionId].close();
            } catch (err) {
                logger.warn(`Failed to close MCP session ${sessionId}: ${err}`);
            }
        }
        this.transports = {};

        // Release any owned serial port and unsubscribe from the Serial Monitor bridge.
        try {
            const { serialController } = await import('./core/serialController.js');
            await serialController.close();
            const { serialMonitorBridge } = await import('./core/serialMonitorBridge.js');
            serialMonitorBridge.unsubscribe();
        } catch (err) {
            logger.warn(`Failed to clean up serial backends on shutdown: ${err}`);
        }


        // Close the HTTP server
        if (this.httpServer) {
            const server = this.httpServer;
            this.httpServer = null;
            this.actualPort = null;
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        logger.info('CMSIS Developer Assistant server stopped');
    }

    /**
     * Get the port the server is actually listening on.
     * May differ from the configured port when the preferred port was busy.
     */
    getActualPort(): number {
        return this.actualPort ?? this.port;
    }

    /**
     * Get the server endpoint
     */
    getEndpoint(): string {
        return `http://localhost:${this.getActualPort()}`;
    }

    /**
     * Build a handler the way a new MCP session would (for testing purposes).
     */
    getDebuggingHandler(): IDebuggingHandler {
        return this.handlerFactory().debug;
    }

    /**
     * Check if the server is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}