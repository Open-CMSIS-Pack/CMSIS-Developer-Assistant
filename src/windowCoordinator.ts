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

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ControlServer, OpPhase, OpRun, WindowFacts } from './controlServer';
import { DebugMCPServer, DebugMCPServerOptions, PortInUseError, SessionHandlers } from './debugMCPServer';
import { DebuggingExecutor, ConfigurationManager, DebuggingHandler } from '.';
import { HardwareTimeouts, SERVER_VERSION } from './debuggingExecutor';
import { RoutingDebuggingHandler } from './routingDebuggingHandler';
import { windowJobTracker } from './cmsisJobTracker';
import type { PackDocsHandlers } from './packDocsDispatch';
import { BusyCall, EventLoopLag, WindowRole, WorkspaceRegistry } from './utils/workspaceRegistry';
import type { PortClaimingWindow } from './core/gdbPortGuard';
import { GdbPortReservations } from './core/gdbPortReservations';
import { gdbPortClaimsOf, sessionGdbPorts, taskCommandWords, windowGdbPorts, type GdbPortClaim } from './core/gdbServerPorts';
import { cbuildRunGdbPorts } from './core/packDocs/cbuildRun';
import { CHANNEL_TIMINGS, ChannelTimings, OpName, forwardTimeoutMs, mayWaitForUser } from './core/opTable';
import { problemJournal, type ProblemJournal } from './core/problemJournal';
import { serialController } from './core/serialController';
import { serialMonitorBridge } from './core/serialMonitorBridge';
import { LagMonitor, NoticeGate, RouterWarning, RouterWatch, busyCallsOf, portAnswers, portSilent, secondsText } from './core/windowHealth';
import { toolNameOf } from './core/windowStatus';
import { SOLUTION_EXTENSION_ID } from './core/bootstrapState';
import { solutionFileOf } from './core/solutionAnswers';
import { logger } from './utils/logger';
import { notifyWarning } from './utils/notify';
import { liveSessionsExcept, onSessionBegins, registrySession } from './utils/sessionStateTracker';
import { activeCbuildRunFile } from './utils/solutionQueries';
import { withTimeout } from './utils/timeout';
import { WindowStatus } from './windowStatus';

/** Refresh well inside the registry's 60 s staleness window. */
const HEARTBEAT_MS = 20_000;

/** Prefix of the notifications this window shows. */
const PRODUCT = 'CMSIS Developer Assistant';

/** How often a worker re-tries the router port after the router disappears. */
const PROMOTION_POLL_MS = 10_000;

/** How long a worker waits for an answer on the router port before it bids for the port. */
const PORT_PROBE_MS = 1_000;

/** At most one notice per tool in this time when calls outlive their fence (#14). */
const FENCE_NOTICE_EVERY_MS = 10 * 60_000;

/** The notices' button that opens the output channel. */
const SHOW_LOG = 'Show Log';

/** The registry name of a window without a workspace. */
const NO_WORKSPACE = '(no workspace)';

/** Shows a warning with buttons and resolves with the one chosen: `notifyWarning`, or a test's stand-in. */
export type WarningNotifier = (message: string, ...items: string[]) => Thenable<string | undefined> | undefined;

/** The part of `vscode.debug` the registry entry follows: the focused session and the events that republish it. */
export type DebugSessionEvents = Pick<typeof vscode.debug,
    'activeDebugSession' | 'onDidStartDebugSession' | 'onDidTerminateDebugSession' | 'onDidChangeActiveDebugSession'>;

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
    /**
     * Passed through to the `DebugMCPServer` this window builds when it wins
     * the router port. Resolved from settings once at activation; see
     * `DebugMCPServerOptions` for why it is fixed per instance.
     */
    serverOptions?: DebugMCPServerOptions;
    /**
     * This window's documentation / build-artefact handlers. Every window
     * gets a pair (they are lazy until a call arrives), so a forwarded op
     * always finds them on the worker side; the `packDocsEnabled` /
     * `buildInfoEnabled` server options decide whether the router offers the
     * tools at all.
     */
    packDocs?: PackDocsHandlers;
    /**
     * Release this window's serial backends on dispose. Every window may own
     * a serial port (serial ops run in the window the router forwards to),
     * so the teardown lives here, not in the router-only MCP server.
     * Injectable for tests; bounded to two seconds so a wedged tty cannot
     * hold `deactivate`.
     */
    serialTeardown?: () => Promise<void>;
    /**
     * This window's problem journal (#48), which its control server and
     * debugging handler use; the window's own by default. Injectable so a
     * test can tell two windows in one process apart.
     */
    journal?: ProblemJournal;
    /**
     * The control channel's timings (#14): the router's budgets and health
     * checks, and this window's fences. `CHANNEL_TIMINGS` by default; the
     * transport tests shorten them.
     */
    timings?: Partial<ChannelTimings>;
    /** How this window shows its warnings; `notifyWarning` by default, which journals them too. */
    notify?: WarningNotifier;
    /** The clock of the notices and of the stuck-router watch; `Date.now` by default. */
    clock?: () => number;
    /**
     * The answer of `cmsis-csolution.getSolutionFile` for the window listing,
     * or undefined when the CMSIS Solution extension is not active. Injectable
     * for tests.
     */
    solutionFile?: () => Thenable<unknown> | undefined;
    /** VS Code's focused debug session and the session events; `vscode.debug` by default. Injectable for tests. */
    debug?: DebugSessionEvents;
    /**
     * The local GDB ports this window's live debug sessions and CMSIS Run
     * tasks use, without `ending`, the session whose end is being announced;
     * read from the session tracker and the window's CMSIS job tracker by
     * default. Injectable for tests.
     */
    gdbPorts?: (ending?: vscode.DebugSession) => Promise<GdbPortClaim[]>;
}

const SERIAL_TEARDOWN_MS = 2_000;

/** How long the window listing waits for the CMSIS Solution extension's answer. */
const SOLUTION_QUERY_MS = 3_000;

/**
 * Ask the CMSIS Solution extension for its active solution, but only while it
 * is active: running its command would activate it in every window.
 */
function querySolutionFile(): Thenable<unknown> | undefined {
    if (!vscode.extensions.getExtension(SOLUTION_EXTENSION_ID)?.isActive) {
        return undefined;
    }
    return vscode.commands.executeCommand<unknown>('cmsis-csolution.getSolutionFile');
}

async function defaultSerialTeardown(): Promise<void> {
    await serialController.close();
    serialMonitorBridge.unsubscribe();
}

/**
 * The GDB ports of a pyOCD CMSIS Run or launch that reads them from a
 * cbuild-run file: the active target's when the task or launch.json names it
 * through CMSIS Solution's command, else the file it names by an absolute
 * path, as a live session's resolved configuration does. None when there is
 * no such file or it lists no port.
 */
async function cbuildRunPortsOf(file: string): Promise<readonly number[]> {
    const runFile = file.includes('${') ? await activeCbuildRunFile() : path.isAbsolute(file) ? file : undefined;
    if (runFile === undefined) {
        return [];
    }
    try {
        return cbuildRunGdbPorts(await fs.promises.readFile(runFile, 'utf8'));
    } catch {
        return [];
    }
}

/** The GDB ports of this window: its live debug sessions from the session tracker, its CMSIS Run tasks from the job tracker. */
async function defaultGdbPorts(ending?: vscode.DebugSession): Promise<GdbPortClaim[]> {
    const sessions = liveSessionsExcept(ending).map((session) => ({ name: session.name, configuration: session.configuration }));
    const tracker = windowJobTracker();
    const runs = tracker.liveExecutions().filter((live) => live.kind === 'run')
        .map((live) => ({ name: live.name, words: tracker.commandOf(live.key) ?? taskCommandWords(live.execution.task) }));
    return windowGdbPorts(sessions, runs, cbuildRunPortsOf);
}

/**
 * Decides whether this window serves MCP (router) or only executes work
 * forwarded to it (worker), and keeps the shared registry current.
 *
 * Exactly one window binds the well-known port, so agents outside VS Code have
 * one stable URL that reaches every window. Every window — router included —
 * runs a ControlServer, because the router still has to be able to execute work
 * in *itself* through the same path as anywhere else.
 *
 * Once started, the window also shows its role in the status bar, and the
 * item's click chooses the default target window (#16).
 *
 * The control channel is watched from both ends (#14): the control server
 * fences each op inside the budget the router names, and the coordinator
 * tells the user, at most once per tool in ten minutes, when a call outlived
 * its fence here; the routers of this window share one record of when each
 * window last answered, and ask a quiet one for its health first. The
 * heartbeat publishes the calls busy here for more than 10 s and the
 * event-loop lag of the last 20 s. A worker whose bid for the port fails
 * checks whether the router stopped running — a stale router entry whose
 * process lives, and a port that does not answer `GET /mcp` — and then warns
 * its user once per episode: no API lets one window take the port or reload
 * another.
 *
 * The entry also lists the local GDB ports the window's live debug sessions
 * and CMSIS Run tasks use, republished when a session or a task starts or
 * ends; the window's debugging handler reads the other windows' ports before
 * a launch, so that two windows do not start GDB servers on one port.
 */
export class WindowCoordinator {
    private readonly registry: WorkspaceRegistry;
    private readonly portReservations: GdbPortReservations;
    private readonly controlToken = randomUUID();
    private readonly localHandler: DebuggingHandler;
    private readonly journal: ProblemJournal;
    private readonly timings: ChannelTimings;
    private readonly notify: WarningNotifier;
    /** When each window last answered this window's routers, by pid (#14). */
    private readonly heard = new Map<number, number>();
    /** One notice per tool in ten minutes when a call outlives its fence (#14). */
    private readonly fenceNotices = new NoticeGate(FENCE_NOTICE_EVERY_MS);
    /** Whether the window that holds the port stopped running; one warning per episode (#14). */
    private readonly routerWatch = new RouterWatch();
    private readonly clock: () => number;

    private controlServer: ControlServer | undefined;
    private mcpServer: DebugMCPServer | undefined;
    private status: WindowStatus | undefined;
    private lag: LagMonitor | undefined;
    /** The event-loop lag of the last heartbeat interval, as the registry entry carries it. */
    private lastLag: EventLoopLag | undefined;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private promotionTimer: ReturnType<typeof setInterval> | undefined;
    /** True once the log said this window is a worker; the polls that keep losing the port say so at debug level. */
    private workerAnnounced = false;
    /** The windows the last heartbeat saw in the registry, by pid, so that one joining or leaving is one log line. */
    private windowsSeen: Map<number, string> | undefined;
    /** The csolution file the CMSIS Solution extension last named, as the registry entry carries it. */
    private solutionFile: string | undefined;
    /** The `getSolutionFile` query in flight; one at a time. */
    private solutionQuery: Promise<void> | undefined;
    /** A refresh was asked for while a query was in flight: ask again when it ends. */
    private solutionQueryAgain = false;
    /** The GDB ports this window's sessions and CMSIS Run tasks use, as the registry entry carries them; none until the first look. */
    private gdbPorts: GdbPortClaim[] = [];
    /** The look at the GDB ports in flight; one at a time. */
    private gdbPortsQuery: Promise<void> | undefined;
    /** A look was asked for while one was in flight: look again when it ends. */
    private gdbPortsAgain = false;
    private disposed = false;

    constructor(private readonly options: CoordinatorOptions) {
        this.notify = options.notify ?? notifyWarning;
        this.clock = options.clock ?? Date.now;
        this.registry = options.registry ?? new WorkspaceRegistry(undefined, undefined, undefined, {
            onRefused: (message) => void this.notify(`${PRODUCT}: ${message}`),
        });
        this.journal = options.journal ?? problemJournal();
        this.timings = { ...CHANNEL_TIMINGS, ...options.timings };
        const executor = new DebuggingExecutor(options.hardwareTimeouts);
        const configManager = new ConfigurationManager();
        this.portReservations = new GdbPortReservations(this.registry.gdbReservationDirectory(), this.registry.ownPid(), undefined,
            path.dirname(this.registry.gdbReservationDirectory()));
        this.localHandler = new DebuggingHandler(executor, configManager, options.timeoutInSeconds, this.journal,
            () => this.otherWindowPorts(), this.portReservations);
    }

    /** True when this window owns the well-known port. */
    public isRouter(): boolean {
        return this.mcpServer !== undefined;
    }

    /** What this window does in the routing, as the registry and the status bar say it. */
    public role(): WindowRole {
        return this.isRouter() ? 'router' : 'worker';
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
        this.lag = new LagMonitor();
        this.controlServer = new ControlServer(this.localHandler, this.controlToken, this.options.packDocs, this.journal, {
            // A router of 2.5.0 names no budget; this window's own router would allow this much.
            defaultBudgetMs: (op, args) => forwardTimeoutMs(op, args, this.options.timeoutInSeconds * 1000, this.forwardTimings()),
            fenceMarginMs: this.timings.fenceMarginMs,
            minFenceMs: this.timings.minFenceMs,
            facts: () => this.facts(),
        });
        this.controlServer.onOp((op, phase, run) => this.noteOp(op, phase, run));
        await this.controlServer.start();

        this.publish();
        this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);

        // Debug-session state is the routing signal for every tool that has no
        // file path, so republish the moment it changes rather than waiting for
        // the next heartbeat. The ending session is named: VS Code still has it
        // focused while its end is announced, and moves the focus afterwards.
        const debug = this.debugApi();
        context.subscriptions.push(
            debug.onDidStartDebugSession(() => this.publish()),
            debug.onDidTerminateDebugSession((ended) => this.publish(ended)),
            debug.onDidChangeActiveDebugSession(() => this.publish()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.publish()),
        );
        // A start's GDB port reservation belongs to its session once the adapter starts, whatever the tool call
        // waited for: a session whose launch fails is never announced and may end before any port sample.
        context.subscriptions.push(onSessionBegins((session) => this.adoptSessionPorts(session)));
        // A CMSIS Run task that starts or ends changes the GDB ports this window uses.
        const tasks = vscode.tasks as Partial<typeof vscode.tasks> | undefined;
        for (const event of [tasks?.onDidStartTaskProcess, tasks?.onDidEndTaskProcess, tasks?.onDidEndTask]) {
            if (event) {
                context.subscriptions.push(event(() => this.refreshGdbPorts()));
            }
        }

        await this.tryBecomeRouter();
        this.showStatus();
    }

    /**
     * The Select Target Window command of this window: the quick pick that
     * saves the default target. Before `start()` there is nothing to choose
     * from, and the user is told so.
     */
    public async selectTargetWindow(): Promise<void> {
        if (this.status === undefined) {
            void vscode.window.showInformationMessage(`${PRODUCT}: this window has not joined the window registry, so there is no target window to choose.`);
            return;
        }
        await this.status.chooseTarget();
    }

    /** Attempt the router port; on failure stay a worker and keep watching. */
    public async tryBecomeRouter(): Promise<void> {
        if (this.disposed || this.mcpServer) { return; }

        // A worker bids every ten seconds. When something already answers on
        // the port, the bid is lost before a server is built: building one
        // reads the tool rules and binds and releases the port for nothing.
        if (await portAnswers(this.options.port, PORT_PROBE_MS)) {
            this.stayWorker();
            return;
        }

        const server = new DebugMCPServer(
            this.options.port,
            this.options.timeoutInSeconds,
            this.options.hardwareTimeouts,
            () => this.sessionHandlers(),
            this.options.serverOptions,
        );

        try {
            await server.initialize();
            await server.start();
            this.mcpServer = server;
            this.stopPromotionPolling();
            this.routerWatch.end();
            logger.info(`This window is the CMSIS Developer Assistant router on ${this.getEndpoint()}`);
        } catch (error) {
            // Whatever start() managed to set up is released (a no-op when
            // the port bind itself failed).
            await server.stop().catch(() => undefined);
            if (error instanceof PortInUseError) {
                this.stayWorker();
                return;
            }
            throw error;
        }
        // The role is part of the registry entry and of the status bar.
        this.publish();
        this.status?.render();
    }

    /** The port is another window's: say so once, and keep polling for it. */
    private stayWorker(): void {
        if (this.workerAnnounced) {
            logger.debug(`Still a worker: port ${this.options.port} is taken`);
        } else {
            logger.info('Another window is the router; this window is a worker.');
            this.workerAnnounced = true;
        }
        this.startPromotionPolling();
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
            this.pollPromotion().catch((err) => logger.debug(`Router promotion attempt failed: ${err}`));
        }, PROMOTION_POLL_MS);
    }

    /**
     * One promotion poll: bid for the port and, when another window keeps
     * it, check whether that window still runs (#14). Public so that a test
     * runs a poll without waiting ten seconds.
     */
    public async pollPromotion(): Promise<void> {
        await this.tryBecomeRouter();
        if (!this.isRouter()) {
            await this.watchRouter();
        }
    }

    private stopPromotionPolling(): void {
        if (this.promotionTimer) {
            clearInterval(this.promotionTimer);
            this.promotionTimer = undefined;
        }
    }

    /**
     * After a failed bid for the port: has the window that holds it stopped
     * running (#14)? A healthy router of 2.5.1 says so in its fresh entry, and
     * nothing is asked. Otherwise the port is asked `GET /mcp`, and
     * `RouterWatch` decides from a stale router entry, or from a port silent
     * for a minute with no router listed at all (2.5.0 writes no role).
     */
    private async watchRouter(): Promise<void> {
        if (this.disposed) {
            return;
        }
        const now = this.clock();
        const stale = this.registry.findStaleRouter(now);
        const ownPid = this.registry.ownPid();
        const listed = this.registry.list().some((entry) => entry.role === 'router' && entry.pid !== ownPid);
        if (stale === undefined && listed) {
            this.routerWatch.end();
            return;
        }
        const silent = await portSilent(this.options.port, this.timings.routerProbeMs);
        const staleRouter = stale === undefined ? undefined : { pid: stale.pid, name: stale.name, updatedAt: stale.updatedAt };
        const warning = this.routerWatch.observe({ now: this.clock(), staleRouter, routerListed: listed, silent });
        if (warning !== undefined && !this.disposed) {
            this.warnStuckRouter(warning);
        }
    }

    /** The warning that the window holding the port stopped running, with the way out. */
    private warnStuckRouter(warning: RouterWarning): void {
        const named = warning.kind === 'named'
            ? `the router window (pid ${warning.pid}${warning.name && warning.name !== NO_WORKSPACE ? `, ${warning.name}` : ''})`
            : `the window serving port ${this.options.port}`;
        const message = `${PRODUCT}: ${named} has not responded for ${secondsText(warning.silentMs)}, so agents cannot reach any window. `
            + 'Reload or close that window; another window takes over automatically.';
        logger.warn(message);
        this.warn(message);
    }

    /**
     * The 20 s heartbeat: the registry entry is written again with the lag of
     * the interval that ends and the calls busy here for 10 s (#14), a new
     * lag interval begins, and the default target is read again: another
     * window may have chosen one.
     */
    private beat(): void {
        this.lastLag = this.lag?.read();
        this.lag?.reset();
        this.registry.heartbeat({ busy: this.busyCalls(), lagMs: this.lastLag });
        this.status?.reloadDefault();
        // A solution opened or closed since the last publish shows up in the listing.
        this.refreshSolutionFile();
        this.refreshGdbPorts();
        this.observeWindows();
    }

    /**
     * One log line for each window that joined or left the registry since
     * the last look, the windows present at the first look included; a look
     * that finds the same windows logs nothing. Public so that a test
     * observes a change without waiting for the heartbeat.
     */
    public observeWindows(): void {
        const current = new Map(this.registry.list().map((entry) => [entry.pid, entry.name]));
        const before = this.windowsSeen ?? new Map<number, string>();
        this.windowsSeen = current;
        const label = (pid: number, name: string): string => `pid ${pid}${name && name !== NO_WORKSPACE ? ` (${name})` : ''}`;
        const count = `${current.size} window${current.size === 1 ? '' : 's'} registered`;
        for (const [pid, name] of current) {
            if (!before.has(pid)) {
                logger.info(`Window ${label(pid, name)} joined the registry; ${count}`);
            }
        }
        for (const [pid, name] of before) {
            if (!current.has(pid)) {
                logger.info(`Window ${label(pid, name)} left the registry; ${count}`);
            }
        }
    }

    /** The calls busy here for more than 10 s, as the registry entry lists them; undefined when none is. */
    private busyCalls(): BusyCall[] | undefined {
        return busyCallsOf(this.controlServer?.busyOps() ?? [], this.clock());
    }

    /**
     * Put this window's item into the status bar; the control server's op
     * hook feeds it (`noteOp`). A status bar that cannot be shown costs the
     * window nothing else: the failure is logged and routing goes on.
     */
    private showStatus(): void {
        if (this.disposed || this.status !== undefined || this.controlServer === undefined) { return; }
        try {
            this.status = new WindowStatus({
                registry: this.registry,
                role: () => this.role(),
                endpoint: () => `${this.getEndpoint()}/mcp`,
                sessions: () => this.mcpServer?.describeSessions(),
            });
        } catch (error) {
            logger.warn('The window status bar item could not be shown', error);
        }
    }

    /** The control server's op hook: the status bar hears every phase, the user a call past its fence that may wait for them (#14). */
    private noteOp(op: OpName, phase: OpPhase, run: OpRun): void {
        try {
            this.status?.noteOp(op, phase, run.ticket);
        } catch (error) {
            logger.warn(`The status bar item could not show ${op} ${phase}`, error);
        }
        if (phase === 'fenced') {
            this.noticeFence(op, run.ranMs);
        }
    }

    /**
     * Tell the user that an agent call has waited here past its fence, at
     * most once per tool in ten minutes, when it may wait for a picker or a
     * dialog that only the user can answer (`mayWaitForUser`). Any other op
     * waits for the debug adapter, GDB or its own work, which the user cannot
     * answer: no notice; the control server's journal record stays.
     */
    private noticeFence(op: OpName, ranMs: number): void {
        const tool = toolNameOf(op);
        if (this.disposed || !mayWaitForUser(op) || !this.fenceNotices.allow(tool, this.clock())) {
            return;
        }
        const message = `${PRODUCT}: an agent's ${tool} has been waiting ${secondsText(ranMs)} in this window; `
            + 'the agent was told it timed out. A picker or dialog here may be waiting for you.';
        this.warn(message);
    }

    /** Show a warning with the Show Log button; a notifier that fails or answers nothing is fine. */
    private warn(message: string): void {
        try {
            void Promise.resolve(this.notify(message, SHOW_LOG)).then((choice) => {
                if (choice === SHOW_LOG) {
                    logger.show();
                }
            }, () => undefined);
        } catch (error) {
            logger.warn('Could not show a warning', error);
        }
    }

    /** What this window's control server says about it in `health` and its fence's message (#14). */
    private facts(): WindowFacts {
        return {
            pid: this.registry.ownPid(),
            // A window without a workspace is named by its pid alone.
            name: vscode.workspace.name,
            role: this.role(),
            version: SERVER_VERSION,
            lagMs: this.lag?.read(),
        };
    }

    /** The router's budget timings, from this window's channel timings. */
    private forwardTimings(): { marginMs: number; slowFloorMs: number } {
        return { marginMs: this.timings.forwardMarginMs, slowFloorMs: this.timings.slowFloorMs };
    }

    /**
     * Handlers for one MCP session.
     *
     * Always the routing handler, even in the router's own window. Routing to
     * yourself is one loopback hop and keeps a single code path — a "run it
     * locally if the target is me" shortcut would be a second path that only
     * the router exercises, and so the one that rots. When the session ends,
     * the router tells the windows it forwarded to (#49).
     */
    private sessionHandlers(): SessionHandlers {
        const router = new RoutingDebuggingHandler(this.registry, this.options.timeoutInSeconds * 1000, {
            forward: this.forwardTimings(),
            quietMs: this.timings.quietMs,
            healthTimeoutMs: this.timings.healthTimeoutMs,
            watchdogEveryMs: this.timings.watchdogEveryMs,
            heard: this.heard,
        });
        return {
            debug: router,
            serial: (op, args) => router.serialOp(op, args),
            packDocs: (op, args) => router.packDocsOp(op, args),
            ended: (sessionId) => router.sessionEnded(sessionId),
        };
    }

    /** VS Code's debug API, or the stand-in a test gave. */
    private debugApi(): DebugSessionEvents {
        return this.options.debug ?? vscode.debug;
    }

    /**
     * Write this window's current state into the shared registry.
     *
     * Public because debug-session state is a routing input, not just a display
     * detail: until this runs, other windows still believe this one is idle.
     * The session comes from the session tracker's live sessions
     * (`registrySession()`), not from VS Code's focus alone; `ending` is a
     * session whose end is being announced, which no longer counts.
     */
    public publish(ending?: vscode.DebugSession): void {
        if (this.disposed || !this.controlServer) { return; }
        this.refreshSolutionFile();
        this.refreshGdbPorts(ending);

        const session = registrySession(this.debugApi().activeDebugSession, ending);
        this.registry.register({
            controlPort: this.controlServer.getPort(),
            controlToken: this.controlToken,
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
            name: vscode.workspace.name ?? NO_WORKSPACE,
            hasActiveSession: session !== undefined,
            activeConfigurationName: session?.configuration?.name,
            cmsisProject: this.solutionFile,
            role: this.role(),
            version: SERVER_VERSION,
            // Both from the heartbeat: none before the first one.
            lagMs: this.lastLag,
            busy: this.busyCalls(),
            gdbPorts: this.gdbPorts.length > 0 ? this.gdbPorts : undefined,
        });
    }

    /**
     * Look at the GDB ports this window's live sessions and CMSIS Run tasks
     * use, and publish again when they changed. The look starts after the
     * event that asked for it has reached every listener, the job tracker's
     * included. A routing input like the session state, but never a reason
     * to fail: a look that fails keeps the last answer.
     */
    private refreshGdbPorts(ending?: vscode.DebugSession): void {
        if (this.disposed) { return; }
        if (this.gdbPortsQuery !== undefined) {
            this.gdbPortsAgain = true;
            return;
        }
        const source = this.options.gdbPorts ?? defaultGdbPorts;
        const observation = this.portReservations.observationVersion();
        this.gdbPortsQuery = Promise.resolve()
            .then(() => source(ending))
            .then(
                (claims) => {
                    // A start/end event during the query supersedes its
                    // snapshot; the queued refresh below reads the new state.
                    if (!this.gdbPortsAgain) {
                        this.noteGdbPorts(claims, observation);
                    }
                },
                (caught: unknown) => logger.debug(`window listing: GDB ports: ${caught instanceof Error ? caught.message : String(caught)}`),
            )
            .finally(() => {
                this.gdbPortsQuery = undefined;
                if (this.gdbPortsAgain) {
                    this.gdbPortsAgain = false;
                    this.refreshGdbPorts();
                }
            });
    }

    /** A session that begins here owns the reservations of its GDB ports: the session's end releases them. */
    private adoptSessionPorts(session: vscode.DebugSession): void {
        void sessionGdbPorts(session.configuration, cbuildRunPortsOf).then(
            (ports) => {
                if (this.disposed || ports.length === 0) { return; }
                for (const { port } of ports) {
                    this.portReservations.adoptPort(port);
                }
                // A look after the adoption: a session that already ended releases its ports now, not at the heartbeat.
                this.refreshGdbPorts();
            },
            (caught: unknown) => logger.debug(`GDB ports of '${session.name}': ${caught instanceof Error ? caught.message : String(caught)}`),
        );
    }

    /** Keep the GDB ports of the last look; a change is published at once. */
    private noteGdbPorts(claims: GdbPortClaim[], observation: number): void {
        if (this.disposed) { return; }
        this.portReservations.observe(claims, observation);
        if (JSON.stringify(claims) === JSON.stringify(this.gdbPorts)) { return; }
        this.gdbPorts = claims;
        this.publish();
    }

    /** The other registered windows with the GDB ports they publish, for this window's launch checks. */
    private otherWindowPorts(): PortClaimingWindow[] {
        const own = this.registry.ownPid();
        return this.registry.list()
            .filter((entry) => entry.pid !== own)
            .map((entry) => ({ pid: entry.pid, name: entry.name, claims: gdbPortClaimsOf(entry.gdbPorts) }))
            .filter((window) => window.claims.length > 0);
    }

    /**
     * Ask the CMSIS Solution extension which csolution this window has, for
     * the window listing, and publish again when the answer changed. The
     * extension exports no active solution, so this asks its command. A
     * display detail, not a routing decision: it never throws, and a failed
     * or slow query keeps the last answer.
     */
    private refreshSolutionFile(): void {
        if (this.disposed) { return; }
        if (this.solutionQuery !== undefined) {
            this.solutionQueryAgain = true;
            return;
        }
        let answer: Thenable<unknown> | undefined;
        try {
            answer = (this.options.solutionFile ?? querySolutionFile)();
        } catch (caught) {
            logger.debug(`window listing: no csolution from the CMSIS Solution extension: ${caught instanceof Error ? caught.message : String(caught)}`);
            return;
        }
        if (answer === undefined) {
            this.noteSolutionFile(undefined);
            return;
        }
        const pending = answer;
        this.solutionQuery = withTimeout('cmsis getSolutionFile', SOLUTION_QUERY_MS, () => Promise.resolve(pending))
            .then(
                (value) => this.noteSolutionFile(solutionFileOf(value)),
                (caught: unknown) => logger.debug(`window listing: getSolutionFile: ${caught instanceof Error ? caught.message : String(caught)}`),
            )
            .finally(() => {
                this.solutionQuery = undefined;
                if (this.solutionQueryAgain) {
                    this.solutionQueryAgain = false;
                    this.refreshSolutionFile();
                }
            });
    }

    /** Keep the csolution the extension named; a change is published at once. */
    private noteSolutionFile(file: string | undefined): void {
        if (file === this.solutionFile) { return; }
        this.solutionFile = file;
        this.publish();
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        this.stopPromotionPolling();
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }
        this.controlServer?.onOp(undefined);
        this.status?.dispose();
        this.status = undefined;
        this.lag?.dispose();
        this.lag = undefined;
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
        this.portReservations.dispose();
        const teardown = this.options.serialTeardown ?? defaultSerialTeardown;
        let timer: NodeJS.Timeout | undefined;
        const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, SERIAL_TEARDOWN_MS); });
        try {
            await Promise.race([teardown(), bound]);
        } catch (err) {
            logger.warn(`Failed to clean up serial backends on shutdown: ${err}`);
        } finally {
            if (timer) { clearTimeout(timer); }
        }
    }
}
