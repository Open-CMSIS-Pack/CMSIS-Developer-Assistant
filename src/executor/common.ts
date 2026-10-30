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
 * What the executor modules share: the deadlines of a call, the parts of DAP
 * reply bodies they read, the session and focus lookups, and the mapping of
 * an adapter frame onto the `StackFrame` the tools print.
 */

import * as vscode from 'vscode';
import { StackFrame } from '../debugState';
import { resolveActiveSession } from '../utils/sessionStateTracker';
import { HardwareTimeouts } from './contract';

// ── Deadlines ────────────────────────────────────────────────────

export const DEFAULT_HARDWARE_TIMEOUTS: HardwareTimeouts = { dapRequestMs: 10_000, memoryReadMs: 30_000 };

/** The most a single call may ask for through its `overrideMs`. */
const CALL_CEILING_MS = 60_000;

/** The readiness probe either answers quickly or counts as hung, whatever the request setting is. */
const PROBE_CEILING_MS = 3_000;

/**
 * `requested` when it is a positive finite number, held to the one-minute
 * ceiling; otherwise `fallback`, which is not held to the ceiling. There is no
 * lower bound.
 */
export function boundedOr(requested: number | undefined, fallback: number): number {
    if (!Number.isFinite(requested) || (requested as number) <= 0) {
        return fallback;
    }
    return Math.min(requested as number, CALL_CEILING_MS);
}

/**
 * The deadlines of one executor. A method that hands its request budget to
 * another public method as that method's override lets the callee derive its
 * own budgets from it.
 */
export class Budgets {
    constructor(private readonly limits: HardwareTimeouts) {}

    /** Each DAP request of a call. */
    request(overrideMs?: number): number {
        return boundedOr(overrideMs, this.limits.dapRequestMs);
    }

    /** The fence around a whole multi-request operation. */
    operation(overrideMs?: number): number {
        return boundedOr(overrideMs, this.limits.memoryReadMs);
    }

    /** The `threads` readiness probe; no override. */
    probe(): number {
        return Math.min(this.limits.dapRequestMs, PROBE_CEILING_MS);
    }

    /** The state snapshot's `stackTrace`; no override, even inside a call that has one (KB8). */
    snapshot(): number {
        return this.limits.dapRequestMs;
    }

    /** A wait for the next stop event (the tracker clamps it once more). */
    stopWait(overrideMs?: number): number {
        return boundedOr(overrideMs, CALL_CEILING_MS);
    }
}

// ── DAP reply bodies, reduced to the members read here ────────────

export interface DapFrameBody {
    id?: number;
    name?: string;
    source?: { path?: string; name?: string };
    line?: number;
    column?: number;
}

export interface StackTraceBody {
    stackFrames?: DapFrameBody[];
}

export interface ThreadsBody {
    threads?: Array<{ id: number; name?: string }>;
}

export interface EvaluateBody {
    result?: string;
}

export interface ReadMemoryBody {
    /** Where the first byte of `data` lies (DAP), which need not be the address asked for. */
    address?: string;
    data?: string;
}

/** A scope as the adapter returns it; `variables` and `error` are added here. */
export interface ScopeBody {
    name: string;
    variablesReference: number;
    /** DAP semantic scope classification; `registers` is independent of the cost hint. */
    presentationHint?: string;
    /** DAP: the scope is large or expensive to read; VS Code reads it only when it is expanded. */
    expensive?: boolean;
    variables?: unknown[];
    error?: string;
    [other: string]: unknown;
}

export interface ScopesBody {
    scopes?: ScopeBody[];
}

export interface VariablesBody {
    variables?: unknown[];
}

// ── Session, focus and frames ──────────────────────────────────────

/** How every operation that needs a session fails when this window has none. */
export const NO_SESSION_TEXT = 'No debug session is running in this window';

/** Stand-in for a missing frame or file name; the tools have always printed this word. */
export const NAME_PLACEHOLDER = 'unknown';

/** The session this window acts on; throws the no-session error when there is none. */
export function sessionOrThrow(): vscode.DebugSession {
    const found = resolveActiveSession();
    if (!found) {
        throw new Error(NO_SESSION_TEXT);
    }
    return found;
}

/**
 * The thread of VS Code's focused stack item (a thread or a frame), else 1.
 * The item is not checked against the session a request goes to (KB7).
 */
export function focusedThreadId(): number {
    return vscode.debug.activeStackItem?.threadId ?? 1;
}

/** Spread into an evaluate request: `{ frameId }`, or nothing when no frame is known. */
export type FrameArg = { frameId?: number };

export function frameArgOf(frameId: number | null | undefined): FrameArg {
    return frameId === null || frameId === undefined ? {} : { frameId };
}

/** An adapter frame as the tools show it. `withId` keeps the frame handle when the adapter sent one. */
export function toStackFrame(raw: DapFrameBody, withId: boolean): StackFrame {
    const shaped: StackFrame = {
        name: raw.name || NAME_PLACEHOLDER,
        source: raw.source?.path || raw.source?.name || undefined,
        line: raw.line || undefined,
        column: raw.column || undefined,
    };
    if (withId && raw.id !== undefined) {
        shaped.frameId = raw.id;
    }
    return shaped;
}

// ── Small conversions ──────────────────────────────────────────────

/** The text of a caught value: an Error's message, anything else stringified. */
export function messageOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/** `0x` and eight lower-case hex digits of the value taken as unsigned 32-bit. */
export function hex8(value: number): string {
    return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}
