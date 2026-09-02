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
 * matching set of forwarding methods in the router. This fork has 31 debugging
 * ops plus 11 serial ops; writing 42 cases twice guarantees the two drift, and
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
    'handleGetCallStack',
    'handleGetThreads',
    'handleGetFrameVariables',
    'handleCmsisCommand',
    'handleFlash',
] as const;

/** Ops served by the serial handler singleton. */
export const SERIAL_OPS = [
    'handleListPorts',
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

/** Both pack-docs groups: one dispatch, one routing path, two enable gates. */
export const PACKDOCS_OPS = [...PACKDOCS_DOC_OPS, ...PACKDOCS_BUILD_OPS] as const;

export type DebugOpName = typeof DEBUG_OPS[number];
export type SerialOpName = typeof SERIAL_OPS[number];
export type PackDocsDocOpName = typeof PACKDOCS_DOC_OPS[number];
export type PackDocsBuildOpName = typeof PACKDOCS_BUILD_OPS[number];
export type PackDocsOpName = PackDocsDocOpName | PackDocsBuildOpName;
export type OpName = DebugOpName | SerialOpName | PackDocsOpName;

const DEBUG_OP_SET: ReadonlySet<string> = new Set(DEBUG_OPS);
const SERIAL_OP_SET: ReadonlySet<string> = new Set(SERIAL_OPS);
const PACKDOCS_DOC_OP_SET: ReadonlySet<string> = new Set(PACKDOCS_DOC_OPS);
const PACKDOCS_OP_SET: ReadonlySet<string> = new Set(PACKDOCS_OPS);

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

/** True for the documentation half of the pack-docs ops (else build artefacts). */
export function isPackDocsDocOp(op: string): op is PackDocsDocOpName {
    return PACKDOCS_DOC_OP_SET.has(op);
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
 * How long the router waits for a worker to answer.
 *
 * Always above the worker's own bound so the worker's error — which is specific
 * and actionable — wins over a generic router timeout.
 */
export function forwardTimeoutMs(op: string, args: unknown, defaultToolMs: number): number {
    const requested = (args as { timeoutMs?: unknown } | undefined)?.timeoutMs;
    const toolMs = typeof requested === 'number' && requested > 0 ? requested : defaultToolMs;
    const floor = SLOW_OPS.has(op) ? 10 * 60_000 : 0;
    return Math.max(toolMs + 15_000, floor);
}

/**
 * The path an op names, if any — the strongest routing signal available.
 *
 * Only the source-oriented ops carry one. Everything else (memory, registers,
 * peripherals, CMSIS actions, flash, serial, documentation and build
 * artefacts) has nothing to match on and falls through to the
 * session/active-session rules in the router.
 */
export function pathHintOf(args: unknown): string | undefined {
    const a = args as { fileFullPath?: unknown; workingDirectory?: unknown } | undefined;
    if (typeof a?.fileFullPath === 'string' && a.fileFullPath.length > 0) {
        return a.fileFullPath;
    }
    if (typeof a?.workingDirectory === 'string' && a.workingDirectory.length > 0) {
        return a.workingDirectory;
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

type _MissingDebugOps = Exclude<keyof IDebuggingHandler, DebugOpName>;
type _ExtraDebugOps = Exclude<DebugOpName, keyof IDebuggingHandler>;
type _MissingSerialOps = Exclude<keyof SerialHandler, SerialOpName>;
type _ExtraSerialOps = Exclude<SerialOpName, keyof SerialHandler>;

// The pack-docs handlers also expose non-tool methods for the commands and
// the panel (refreshSettings, indexTarget, …); only their `handle*` methods
// are tool ops, so the coverage check is over those.
type _HandleKeys<T> = Extract<keyof T, `handle${string}`>;
type _MissingPackDocsDocOps = Exclude<_HandleKeys<PackDocsHandler>, PackDocsDocOpName>;
type _ExtraPackDocsDocOps = Exclude<PackDocsDocOpName, _HandleKeys<PackDocsHandler>>;
type _MissingPackDocsBuildOps = Exclude<_HandleKeys<BuildInfoHandler>, PackDocsBuildOpName>;
type _ExtraPackDocsBuildOps = Exclude<PackDocsBuildOpName, _HandleKeys<BuildInfoHandler>>;

const _debugOpsAreExhaustive: [_MissingDebugOps, _ExtraDebugOps] extends [never, never] ? true : never = true;
const _serialOpsAreExhaustive: [_MissingSerialOps, _ExtraSerialOps] extends [never, never] ? true : never = true;
const _packDocsDocOpsAreExhaustive: [_MissingPackDocsDocOps, _ExtraPackDocsDocOps] extends [never, never] ? true : never = true;
const _packDocsBuildOpsAreExhaustive: [_MissingPackDocsBuildOps, _ExtraPackDocsBuildOps] extends [never, never] ? true : never = true;
void _debugOpsAreExhaustive;
void _serialOpsAreExhaustive;
void _packDocsDocOpsAreExhaustive;
void _packDocsBuildOpsAreExhaustive;
