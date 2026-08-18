// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ControlServer } from './controlServer';
import { DebugMCPServer, PortInUseError, SessionHandlers } from './debugMCPServer';
import { DebuggingExecutor, ConfigurationManager, DebuggingHandler } from '.';
import { HardwareTimeouts } from './debuggingExecutor';
import { RoutingDebuggingHandler } from './routingDebuggingHandler';
import { WorkspaceRegistry } from './utils/workspaceRegistry';
import { logger } from './utils/logger';

/** Refresh well inside the registry's 60 s staleness window. */
const HEARTBEAT_MS = 20_000;

/** How often a worker re-tries the router port after the router disappears. */
const PROMOTION_POLL_MS = 10_000;

export interface CoordinatorOptions {
    port: number;
    timeoutInSeconds: number;
    hardwareTimeouts: Partial<HardwareTimeouts>;
    /**
     * Registry to publish into. Injectable so a test can stand up several
     * coordinators against one temporary directory with distinct identities,
     * which is what two real windows look like.
     */
    registry?: WorkspaceRegistry;
}

/**
 * Decides whether this window serves MCP (router) or only executes work
 * forwarded to it (worker), and keeps the shared registry current.
 *
 * Exactly one window binds the well-known port, so agents outside VS Code have
 * one stable URL that reaches every window. Every window — router included —
 * runs a ControlServer, because the router still has to be able to execute work
 * in *itself* through the same path as anywhere else.
 */
export class WindowCoordinator {
    private readonly registry: WorkspaceRegistry;
    private readonly controlToken = randomUUID();
    private readonly localHandler: DebuggingHandler;

    private controlServer: ControlServer | undefined;
    private mcpServer: DebugMCPServer | undefined;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private promotionTimer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;

    constructor(private readonly options: CoordinatorOptions) {
        this.registry = options.registry ?? new WorkspaceRegistry();
        const executor = new DebuggingExecutor(options.hardwareTimeouts);
        const configManager = new ConfigurationManager();
        this.localHandler = new DebuggingHandler(executor, configManager, options.timeoutInSeconds);
    }

    /** True when this window owns the well-known port. */
    public isRouter(): boolean {
        return this.mcpServer !== undefined;
    }

    /**
     * The URL agents should use — always the router's, in every window.
     *
     * A worker deliberately advertises the router's port rather than its own
     * control port. In-window Copilot then goes through the same routing as
     * every external agent, so both agree on which window owns the board.
     */
    public getEndpoint(): string {
        return `http://localhost:${this.options.port}`;
    }

    public async start(context: vscode.ExtensionContext): Promise<void> {
        this.controlServer = new ControlServer(this.localHandler, this.controlToken);
        await this.controlServer.start();

        this.publish();
        this.heartbeat = setInterval(() => this.registry.heartbeat(), HEARTBEAT_MS);

        // Debug-session state is the routing signal for every tool that has no
        // file path, so republish the moment it changes rather than waiting for
        // the next heartbeat.
        context.subscriptions.push(
            vscode.debug.onDidStartDebugSession(() => this.publish()),
            vscode.debug.onDidTerminateDebugSession(() => this.publish()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.publish()),
        );

        await this.tryBecomeRouter();
    }

    /** Attempt the router port; on failure stay a worker and keep watching. */
    public async tryBecomeRouter(): Promise<void> {
        if (this.disposed || this.mcpServer) { return; }

        const server = new DebugMCPServer(
            this.options.port,
            this.options.timeoutInSeconds,
            this.options.hardwareTimeouts,
            () => this.sessionHandlers(),
        );

        try {
            await server.initialize();
            await server.start();
            this.mcpServer = server;
            this.stopPromotionPolling();
            logger.info(`This window is the CMSIS-DebugMCP router on ${this.getEndpoint()}`);
        } catch (error) {
            if (error instanceof PortInUseError) {
                logger.info('Another window is the router; this window is a worker.');
                this.startPromotionPolling();
                return;
            }
            throw error;
        }
    }

    /**
     * Watch for the router going away.
     *
     * When the router window closes, its port frees up and some worker must
     * take it or the agents' single URL goes dead. Whoever wins the bind first
     * becomes the new router; the rest keep polling and keep losing, which is
     * harmless.
     */
    private startPromotionPolling(): void {
        if (this.promotionTimer || this.disposed) { return; }
        this.promotionTimer = setInterval(() => {
            this.tryBecomeRouter().catch((err) => logger.warn(`Router promotion attempt failed: ${err}`));
        }, PROMOTION_POLL_MS);
    }

    private stopPromotionPolling(): void {
        if (this.promotionTimer) {
            clearInterval(this.promotionTimer);
            this.promotionTimer = undefined;
        }
    }

    /**
     * Handlers for one MCP session.
     *
     * Always the routing handler, even in the router's own window. Routing to
     * yourself is one loopback hop and keeps a single code path — a "run it
     * locally if the target is me" shortcut would be a second path that only
     * the router exercises, and so the one that rots.
     */
    private sessionHandlers(): SessionHandlers {
        const router = new RoutingDebuggingHandler(this.registry, this.options.timeoutInSeconds * 1000);
        return {
            debug: router,
            serial: (op, args) => router.serialOp(op, args),
        };
    }

    /**
     * Write this window's current state into the shared registry.
     *
     * Public because debug-session state is a routing input, not just a display
     * detail: until this runs, other windows still believe this one is idle.
     */
    public publish(): void {
        if (this.disposed || !this.controlServer) { return; }

        const session = vscode.debug.activeDebugSession;
        this.registry.register({
            controlPort: this.controlServer.getPort(),
            controlToken: this.controlToken,
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
            name: vscode.workspace.name ?? '(no workspace)',
            hasActiveSession: !!session,
            activeConfigurationName: session?.configuration?.name,
            cmsisProject: this.cmsisProjectPath(),
        });
    }

    /**
     * Best-effort path of the CMSIS solution in this window, for the window
     * listing. Never throws: the CMSIS Solution extension may not be installed,
     * and this is a display detail, not a routing decision.
     */
    private cmsisProjectPath(): string | undefined {
        try {
            const ext = vscode.extensions.getExtension('Arm.cmsis-csolution');
            if (!ext?.isActive) { return undefined; }
            const solution = (ext.exports as { activeSolution?: unknown } | undefined)?.activeSolution;
            if (typeof solution === 'string') { return solution; }
            const asRecord = solution as Record<string, any> | undefined;
            return asRecord?.fsPath ?? asRecord?.path ?? undefined;
        } catch {
            return undefined;
        }
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        this.stopPromotionPolling();
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }
        // Unregister before stopping the servers so no other window can pick
        // this entry up and try to forward into a closing extension host.
        this.registry.unregister();
        if (this.mcpServer) {
            await this.mcpServer.stop().catch(err => logger.error('Error stopping MCP server', err));
            this.mcpServer = undefined;
        }
        if (this.controlServer) {
            await this.controlServer.stop().catch(err => logger.error('Error stopping control server', err));
            this.controlServer = undefined;
        }
    }
}
