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
 * The set of operations that can cross a window boundary.
 *
 * Upstream hand-writes a switch over ~16 ops in the control server and a
 * matching set of forwarding methods in the router. This project has 35 debugging
 * ops plus 11 serial ops; writing 46 cases twice guarantees the two drift, and
 * a tool that falls out of the switch becomes silently unroutable — it would
 * run in the router window instead, against the wrong board.
 *
 * So both sides read one table. The `OpName` type below is checked against
 * `IDebuggingHandler` at compile time (see `assertCoversDebugHandler`), which
 * turns "added a tool but forgot to make it routable" into a build error rather
 * than a bug you find on the bench.
 *
 * Pure — no runtime vscode import — so the coverage assertions are
 * unit-testable outside the extension host.
 */

import type { IDebuggingHandler } from '../debuggingHandler';
import type { SerialHandler } from '../serialHandler';
import type { PackDocsHandler } from '../packDocsHandler';
import type { BuildInfoHandler } from '../buildInfoHandler';
import type { KnowledgeHandler } from '../knowledgeHandler';

/**
 * Body caps on the control channel — a runaway stop, not a budget. Tool
 * arguments never exceed the MCP request limit (1 MiB, express.json);
 * results are clipped by every renderer's `maxChars` well below 16 MiB.
 */
export const CONTROL_REQUEST_MAX_BYTES = 1024 * 1024;
export const CONTROL_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The control envelope (#11). A router that sends this header with a version
 * of 2 or more gets typed replies — `{result: ToolText}`, or `{error: {message,
 * code, hint?, data?}}` with 500 — and the worker marks them with the same
 * header. Without it the worker answers as 2.3.10 did: `{result: string}` or
 * `{error: string}`. Unknown fields in either direction are ignored.
 */
export const CONTROL_ENVELOPE_HEADER = 'x-cmsis-developer-assistant-envelope';
export const CONTROL_ENVELOPE_VERSION = 2;

/** Ops served by the debugging handler. */
export const DEBUG_OPS = [
    'handleStartDebugging',
    'handleStopDebugging',
    'handleStepOver',
    'handleStepInto',
    'handleStepOut',
    'handleContinue',
    'handlePause',
    'handleWaitForStop',
    'handleRestart',
    'handleReset',
    'handleAddBreakpoint',
    'handleAddLogpoint',
    'handleRemoveBreakpoint',
    'handleClearAllBreakpoints',
    'handleListBreakpoints',
    'handleListVariableNames',
    'handleGetVariables',
    'handleEvaluateExpression',
    'handleReadMemory',
    'handleReadCoreRegisters',
    'handleReadCycleCounter',
    'handleReadPeripheralRegister',
    'handleGetFaultInfo',
    'handleDiagnoseFault',
    'handleLookupPeripheral',
    'handleLookupRegister',
    'handleGetDeviceInfo',
    'handleCheckTargetConnection',
    'handleGetSessionStatus',
    'handleGetRecentProblems',
    'handleGetCallStack',
    'handleGetThreads',
    'handleGetFrameVariables',
    'handleCmsisCommand',
    'handleCmsisQuery',
    'handleFlash',
] as const;

/** Ops served by the serial handler singleton. */
export const SERIAL_OPS = [
    'handleListPorts',
    'handleCapture',
    'handleOpen',
    'handleClose',
    'handleStatus',
    'handleWrite',
    'handleRead',
    'handleClearBuffer',
    'handleSubscribeMonitor',
    'handleUnsubscribeMonitor',
    'handleOpenInUi',
] as const;

/** Ops served by the documentation handler (`PackDocsHandler`). */
export const PACKDOCS_DOC_OPS = [
    'handleListTargetDocs',
    'handleSearchTargetDocs',
    'handleReadDocPages',
    'handleFetchDoc',
    'handleGetPeripheralDocs',
] as const;

/** Ops served by the build-artefact handler (`BuildInfoHandler`). */
export const PACKDOCS_BUILD_OPS = [
    'handleListBuildArtifacts',
    'handleGetMemoryUsage',
    'handleLookupSymbol',
    'handleGetSectionLayout',
    'handleGetBuildDiagnostics',
] as const;

/** Ops served by the knowledge handler (`KnowledgeHandler`); experimental. */
export const KNOWLEDGE_OPS = [
    'handleKnowledgeSearch',
    'handleKnowledgeGet',
    'handleKnowledgeExpand',
] as const;

/** Both pack-docs groups: one dispatch, one routing path, two enable gates. */
export const PACKDOCS_OPS = [...PACKDOCS_DOC_OPS, ...PACKDOCS_BUILD_OPS] as const;

/** Everything the pack-docs dispatch carries: the two groups above and the knowledge ops. */
const PACKDOCS_DISPATCH_OPS = [...PACKDOCS_OPS, ...KNOWLEDGE_OPS] as const;

/**
 * Ops between windows that are no tools: the control server answers them
 * itself, before the op table is consulted, at once — never queued behind an
 * op that runs — without the op hook of the status bar and without the
 * problem journal.
 * - `health` (#14): the window's extension host is alive, with what it is busy
 *   with; a window of 2.5.0 answers it with 500, which says the same.
 * - `sessionEnded {sessionId}` (#49): the router says that an MCP session
 *   ended, and the window releases the serial port and the Serial Monitor
 *   subscription that session held there. A window of an earlier version
 *   answers "not a known operation", which the router ignores.
 */
export const INTERNAL_OPS = ['health', 'sessionEnded'] as const;

export type DebugOpName = typeof DEBUG_OPS[number];
export type SerialOpName = typeof SERIAL_OPS[number];
export type PackDocsDocOpName = typeof PACKDOCS_DOC_OPS[number];
export type PackDocsBuildOpName = typeof PACKDOCS_BUILD_OPS[number];
export type KnowledgeOpName = typeof KNOWLEDGE_OPS[number];
export type PackDocsOpName = PackDocsDocOpName | PackDocsBuildOpName | KnowledgeOpName;
export type OpName = DebugOpName | SerialOpName | PackDocsOpName;
export type InternalOpName = typeof INTERNAL_OPS[number];

const DEBUG_OP_SET: ReadonlySet<string> = new Set(DEBUG_OPS);
const SERIAL_OP_SET: ReadonlySet<string> = new Set(SERIAL_OPS);
const PACKDOCS_DOC_OP_SET: ReadonlySet<string> = new Set(PACKDOCS_DOC_OPS);
const PACKDOCS_OP_SET: ReadonlySet<string> = new Set(PACKDOCS_DISPATCH_OPS);
const KNOWLEDGE_OP_SET: ReadonlySet<string> = new Set(KNOWLEDGE_OPS);
const INTERNAL_OP_SET: ReadonlySet<string> = new Set(INTERNAL_OPS);

/** True when `op` is a name the control server is willing to dispatch. */
export function isKnownOp(op: string): op is OpName {
    return DEBUG_OP_SET.has(op) || SERIAL_OP_SET.has(op) || PACKDOCS_OP_SET.has(op);
}

export function isSerialOp(op: string): op is SerialOpName {
    return SERIAL_OP_SET.has(op);
}

export function isPackDocsOp(op: string): op is PackDocsOpName {
    return PACKDOCS_OP_SET.has(op);
}

/** True for a knowledge op, which the pack-docs dispatch carries too. */
export function isKnowledgeOp(op: string): op is KnowledgeOpName {
    return KNOWLEDGE_OP_SET.has(op);
}

/** True for the documentation ops (else build artefacts or knowledge). */
export function isPackDocsDocOp(op: string): op is PackDocsDocOpName {
    return PACKDOCS_DOC_OP_SET.has(op);
}

/** True for an op the control server answers itself (`INTERNAL_OPS`). */
export function isInternalOp(op: string): op is InternalOpName {
    return INTERNAL_OP_SET.has(op);
}

/**
 * Ops that legitimately run far longer than a normal tool call, so the
 * router→worker forward must not preempt them. A build can take minutes and
 * flashing a large image is not quick either; cutting those off mid-write is
 * how you get a half-programmed part. Documentation ops extract and index a
 * manual on first use — a 3 000-page reference manual takes minutes — and
 * accept timeoutMs up to 600 s, so they get the same floor.
 */
const SLOW_OPS: ReadonlySet<string> = new Set([
    'handleCmsisCommand',
    'handleFlash',
    ...PACKDOCS_DOC_OPS,
]);

/**
 * Ops that can wait for the user in VS Code (#14): `start_debugging` (the
 * launch.json picker) and `restart_debugging`, both also through a
 * preLaunchTask's prompt or VS Code's "Errors exist after running
 * preLaunchTask" dialog, and `cmsis_action` (the CMSIS Solution extension's
 * pickers and save prompt, the licence dialog of `install_pack`). Only for
 * these can a call that outlives its fence be waiting for a picker or
 * dialog, and only for these is the user told; every other op waits for the
 * debug adapter, GDB, the probe or its own work, which the user cannot
 * answer.
 */
const USER_WAIT_OPS: ReadonlySet<string> = new Set([
    'handleStartDebugging',
    'handleRestart',
    'handleCmsisCommand',
]);

/** True for an op that can wait for a picker or dialog in VS Code (`USER_WAIT_OPS`). */
export function mayWaitForUser(op: string): boolean {
    return USER_WAIT_OPS.has(op);
}

/** True for an op the debugging handler serves (`DEBUG_OPS`). */
export function isDebugOp(op: string): op is DebugOpName {
    return DEBUG_OP_SET.has(op);
}

/**
 * The timings of the control channel (#14). Every figure can be injected, so
 * that the tests of the fences and the watchdog run in milliseconds.
 */
export interface ChannelTimings {
    /** Router: a forward's budget is the call's tool timeout plus this. */
    forwardMarginMs: number;
    /** Router: the least budget of `cmsis_action`, `flash` and the documentation ops. */
    slowFloorMs: number;
    /** Worker: its fence answers this long before the router's budget runs out. */
    fenceMarginMs: number;
    /** Worker: the shortest fence, whatever budget a router names. */
    minFenceMs: number;
    /** Router: silence from a window after which a call checks the window's health first. */
    quietMs: number;
    /** Router: how long a health check may take. */
    healthTimeoutMs: number;
    /** Router: how often a pending forward checks its window's health, the first time after this long. */
    watchdogEveryMs: number;
    /** Worker: how long `GET /mcp` on the router port may stay unanswered before the router counts as stuck. */
    routerProbeMs: number;
}

/** The timings the extension runs with. */
export const CHANNEL_TIMINGS: Readonly<ChannelTimings> = Object.freeze({
    forwardMarginMs: 15_000,
    slowFloorMs: 10 * 60_000,
    fenceMarginMs: 5_000,
    minFenceMs: 1_000,
    quietMs: 30_000,
    healthTimeoutMs: 2_000,
    watchdogEveryMs: 15_000,
    routerProbeMs: 2_000,
});

/** What `forwardTimeoutMs` adds to a tool timeout, and the floor of the slow ops. */
export interface ForwardTimings {
    marginMs?: number;
    slowFloorMs?: number;
}

/**
 * How long the router waits for a worker to answer: its budget, which the
 * envelope also tells the worker (`budgetMs`, #14).
 *
 * Always above the worker's own bound so the worker's error — which is specific
 * and actionable — wins over a generic router timeout. A serial call that
 * waits the time it names (`serial_read {waitMs}`, `serial_capture
 * {durationMs}`, each up to 60 s) gets at least that long (#49).
 */
export function forwardTimeoutMs(op: string, args: unknown, defaultToolMs: number, timings: ForwardTimings = {}): number {
    const { marginMs = CHANNEL_TIMINGS.forwardMarginMs, slowFloorMs = CHANNEL_TIMINGS.slowFloorMs } = timings;
    const given = (typeof args === 'object' && args !== null ? args : {}) as { timeoutMs?: unknown; waitMs?: unknown; durationMs?: unknown };
    const positive = (value: unknown): value is number => typeof value === 'number' && value > 0;
    const toolMs = Math.max(positive(given.timeoutMs) ? given.timeoutMs : defaultToolMs,
        ...[given.waitMs, given.durationMs].filter(positive));
    const floor = SLOW_OPS.has(op) ? slowFloorMs : 0;
    return Math.max(toolMs + marginMs, floor);
}

/** `setTimeout`'s longest delay; a longer one fires at once. */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * The worker's fence for a forward's budget (#14): `fenceMarginMs` inside
 * it, so the worker's `WORKER_TIMEOUT` reaches the router before the router
 * gives up, and never shorter than `minFenceMs`.
 */
export function workerFenceMs(budgetMs: number, timings: Pick<ChannelTimings, 'fenceMarginMs' | 'minFenceMs'> = CHANNEL_TIMINGS): number {
    return Math.min(LONGEST_TIMER_MS, Math.max(timings.minFenceMs, budgetMs - timings.fenceMarginMs));
}

/**
 * The argument that names a call's window (#16). A routed session offers it
 * on the tools that start or own something; the router reads it and never
 * forwards it.
 */
export const WINDOW_ARGUMENT = 'window';

/**
 * What a call says about its window: the `window` argument — a pid when it
 * is all digits, else a path inside the window's workspace — or the file or
 * directory it is about (`source: 'path'`).
 */
export type TargetHint =
    | { source: 'window'; pid: number }
    | { source: 'window'; path: string }
    | { source: 'path'; path: string };

/** A string argument with something in it, trimmed; undefined otherwise. */
function filled(value: unknown): string | undefined {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : undefined;
}

/**
 * The strongest routing signal an op's arguments carry, if any: `window`,
 * then `fileFullPath`, then `workingDirectory`; empty strings say nothing.
 *
 * Only the source-oriented ops carry a path, and only a routed session's
 * tools that start or own something carry `window`. Everything else
 * (memory, registers, peripherals, serial reads, documentation and build
 * artefacts) has nothing to match on and falls through to the session rules
 * in the router.
 */
export function targetHintOf(args: unknown): TargetHint | undefined {
    const given = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    const named = filled(given[WINDOW_ARGUMENT]);
    if (named !== undefined) {
        return /^\d+$/.test(named) ? { source: 'window', pid: Number(named) } : { source: 'window', path: named };
    }
    for (const key of ['fileFullPath', 'workingDirectory']) {
        const value = given[key];
        if (typeof value === 'string' && value.length > 0) {
            return { source: 'path', path: value };
        }
    }
    return undefined;
}

// --- Compile-time exhaustiveness -----------------------------------------
//
// These are `import type` and so are erased entirely — this module emits no
// require for vscode-touching code and stays loadable in a plain node test.
//
// If a tool is added to IDebuggingHandler (or SerialHandler) and not to the
// tables above, `_Missing*` stops being `never`, the conditional resolves to
// `never`, and `const … = true` fails to compile. A name in the table that no
// longer exists on the handler trips `_Extra*` the same way. The failure lands
// at build time instead of as an unroutable tool discovered on the bench.

// The serial and pack-docs handlers also expose methods that are no tools:
// the serial handler's `sessionEnded` (an internal op, #49), the commands and
// the panel of the pack-docs handlers (refreshSettings, indexTarget, …). Only
// their `handle*` methods are tool ops, so the coverage check is over those.
type _HandleKeys<T> = Extract<keyof T, `handle${string}`>;

type _MissingDebugOps = Exclude<keyof IDebuggingHandler, DebugOpName>;
type _ExtraDebugOps = Exclude<DebugOpName, keyof IDebuggingHandler>;
type _MissingSerialOps = Exclude<_HandleKeys<SerialHandler>, SerialOpName>;
type _ExtraSerialOps = Exclude<SerialOpName, _HandleKeys<SerialHandler>>;
type _MissingPackDocsDocOps = Exclude<_HandleKeys<PackDocsHandler>, PackDocsDocOpName>;
type _ExtraPackDocsDocOps = Exclude<PackDocsDocOpName, _HandleKeys<PackDocsHandler>>;
type _MissingPackDocsBuildOps = Exclude<_HandleKeys<BuildInfoHandler>, PackDocsBuildOpName>;
type _ExtraPackDocsBuildOps = Exclude<PackDocsBuildOpName, _HandleKeys<BuildInfoHandler>>;
type _MissingKnowledgeOps = Exclude<_HandleKeys<KnowledgeHandler>, KnowledgeOpName>;
type _ExtraKnowledgeOps = Exclude<KnowledgeOpName, _HandleKeys<KnowledgeHandler>>;

const _debugOpsAreExhaustive: [_MissingDebugOps, _ExtraDebugOps] extends [never, never] ? true : never = true;
const _serialOpsAreExhaustive: [_MissingSerialOps, _ExtraSerialOps] extends [never, never] ? true : never = true;
const _packDocsDocOpsAreExhaustive: [_MissingPackDocsDocOps, _ExtraPackDocsDocOps] extends [never, never] ? true : never = true;
const _packDocsBuildOpsAreExhaustive: [_MissingPackDocsBuildOps, _ExtraPackDocsBuildOps] extends [never, never] ? true : never = true;
const _knowledgeOpsAreExhaustive: [_MissingKnowledgeOps, _ExtraKnowledgeOps] extends [never, never] ? true : never = true;
void _debugOpsAreExhaustive;
void _serialOpsAreExhaustive;
void _packDocsDocOpsAreExhaustive;
void _packDocsBuildOpsAreExhaustive;
void _knowledgeOpsAreExhaustive;
