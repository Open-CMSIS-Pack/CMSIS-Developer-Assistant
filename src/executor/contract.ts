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
 * The types the executor is used through. `src/debuggingExecutor.ts`
 * re-exports each of them, so importers keep a single module path.
 *
 * `IDebuggingExecutor` is put together from one interface per concern. The
 * handler takes the whole of it; its unit tests fake only the parts they
 * drive. Parameter names carry no meaning for callers: every `overrideMs` is
 * a one-call replacement of a configured deadline (see `Budgets` in
 * ./common.ts for how it is bounded).
 */

import * as vscode from 'vscode';
import { FaultRegisters } from '../core/faultDecoder';
import type { DebugPortProbe } from '../core/probeWedge';
import { ResetMethod, ResetOutcomeView } from '../core/resetAssist';
import type { DapVariable } from '../core/variableView';
import { DebugState, StackFrame } from '../debugState';
import type { AdoptedBreakpoint, FrameFocusWatch, GdbLogpoint, StartFocusWatch, StopWaitResult } from '../utils/sessionStateTracker';
import type { GdbReply } from './gdbCommand';

export type { AdoptedBreakpoint, FrameFocusWatch, GdbLogpoint, StartFocus, StartFocusWatch } from '../utils/sessionStateTracker';
export type { GdbReply } from './gdbCommand';
export type { DebugPortProbe } from '../core/probeWedge';

/** Deadlines from the settings `dapRequestTimeoutMs` and `memoryReadTimeoutMs`. */
export interface HardwareTimeouts {
    /** One DAP request. */
    dapRequestMs: number;
    /** A whole read that may need several requests: memory, registers, peripherals, DWT, fault status. */
    memoryReadMs: number;
}

/**
 * Where a session stands, judged by the `threads` probe and the stop tracker.
 * `initializing` is an adapter that does not take requests: the probe failed
 * without a timeout, or the CMSIS Debugger's adapter answered without a
 * thread list while GDB connects or the session shuts down. A session that
 * was asked to end is `initializing` whenever the probe gets no thread list,
 * a timeout included, with `endRequestedForMs`.
 */
export type SessionState = 'no-session' | 'initializing' | 'running' | 'stopped' | 'unresponsive';

export interface SessionStatus {
    state: SessionState;
    sessionName: string | null;
    sessionType: string | null;
    configurationName: string | null;
    /** The adapter answered the probe in time. */
    dapResponsive: boolean;
    /** Round trip of the probe in whole milliseconds; null unless it answered. */
    dapProbeMs: number | null;
    /** Why the probe failed or the adapter takes no requests, or why the target is stopped. */
    detail?: string;
    /**
     * Stopped only: how long ago the last DHCSR read of the session got no
     * answer, when neither a stop nor a DHCSR read that answered came since
     * (#3). Nothing is read for it.
     */
    coreSilentForMs?: number;
    /**
     * Initializing only: how long ago a `disconnect` or `terminate` request
     * went to the session's adapter, which then takes no requests while it
     * shuts down. Nothing is read for it.
     */
    endRequestedForMs?: number;
}

/** One entry of the thread list, with the thread's innermost frame when that could be read. */
export interface DapThread {
    id: number;
    name: string;
    topFrame?: StackFrame;
}

/** The record of one reset attempt: exactly what `renderResetOutcome` prints. */
export interface ResetOutcome extends ResetOutcomeView {}

/** What the status tool reports about this build and the sessions the window can see. */
export interface ExecutorDiagnostics {
    serverVersion: string;
    liveSessionCount: number;
    liveSessionNames: string[];
    hasVscodeActiveSession: boolean;
}

/** `waitForStop` found the target halted before it started waiting. */
export interface AlreadyStopped {
    kind: 'already-stopped';
    /** The reason of the stop event the tracker saw, when it saw one. */
    reason: string | null;
}

/** How `restart` restarted the session. */
export interface RestartOutcome {
    /**
     * `relaunched`: a CMSIS Debugger session was stopped and its root
     * session's launch configuration started again through the debug API;
     * `workbench`: VS Code's restart command ran on the focused session.
     */
    via: 'relaunched' | 'workbench';
    configurationName?: string;
    /** The relaunched configuration's `preLaunchTask`, which ran again. */
    preLaunchTask?: string;
}

/** Starting and ending sessions, and finding the one this window acts on. */
export interface SessionLifecycle {
    startDebugging(folderPath: string, launch: vscode.DebugConfiguration): Promise<boolean>;
    /** Resolves `launchName` from launch.json in the workspace folder that fits `folderPath`. */
    startDebuggingByName(folderPath: string, launchName: string): Promise<boolean>;
    stopDebugging(which?: vscode.DebugSession): Promise<void>;
    /**
     * On the CMSIS Debugger: stops the root of the session and starts its
     * launch configuration again through the debug API, so a failure comes
     * back here. Elsewhere: VS Code's restart command on the focused session.
     */
    restart(): Promise<RestartOutcome>;
    /** Synchronous, and sends nothing to the adapter. */
    hasDebugSession(): boolean;
    getActiveSession(): vscode.DebugSession | undefined;
}

/** Whether the adapter answers and the target can be inspected. */
export interface Readiness {
    /** A session exists, answers the `threads` probe (on the CMSIS Debugger with a thread list), and its target is stopped. */
    hasActiveSession(): Promise<boolean>;
    /** Never rejects. */
    getSessionStatus(): Promise<SessionStatus>;
    /** The status as the `check_target_connection` text, with one DHCSR read on a stopped CMSIS Debugger session. Never rejects. */
    checkTargetConnection(): Promise<string>;
    getDiagnostics(): ExecutorDiagnostics;
    getDeviceInfo(): Promise<string>;
}

/**
 * Moving the target. None of these waits for the stop that may follow. A
 * request the adapter rejects (other than by a timeout) throws on the CMSIS
 * Debugger: `TARGET_RUNNING` when GDB says the target is running, `INTERNAL`
 * otherwise. Other adapters answer it with VS Code's workbench command for
 * the same action.
 */
export interface RunControl {
    stepOver(overrideMs?: number): Promise<void>;
    stepInto(overrideMs?: number): Promise<void>;
    stepOut(overrideMs?: number): Promise<void>;
    continue(overrideMs?: number): Promise<void>;
    pause(overrideMs?: number): Promise<void>;
    /** Not async: without a session it throws before the caller sends its request. */
    armStopWaiter(limitMs: number): Promise<StopWaitResult>;
    waitForStop(limitMs?: number): Promise<StopWaitResult | AlreadyStopped>;
    /**
     * Taken before the request, with the stop waiter: after the stop,
     * `selected` waits, bounded, for the frame VS Code selects for it, which
     * the state and register reads go through. A frame VS Code still held
     * from before the request does not count. Without a session it answers
     * false at once.
     */
    watchFrameFocus(): FrameFocusWatch;
    /**
     * Taken before a session starts: once it came up, `settled` waits,
     * bounded, for the frame VS Code selects when the session stopped, which
     * the state is read through. It answers `running` at once for a target
     * that runs, and `none` without a session.
     */
    watchStartFocus(): StartFocusWatch;
}

/** How the session's adapter reports one breakpoint of VS Code's model (`getDebugProtocolBreakpoint`). */
export interface BreakpointBinding {
    /** The adapter has answered for this breakpoint; false when the wait ran out first. */
    reported: boolean;
    verified: boolean;
    /** The adapter's explanation, typically why it could not bind. */
    message?: string;
    /** The line the adapter bound it to. */
    line?: number;
    /** The adapter's id for it; GDB's breakpoint number on the CMSIS Debugger. */
    id?: number;
}

/** What a removal from VS Code's breakpoint model did. */
export interface BreakpointRemoval {
    removed: number;
    /**
     * With a session: whether the adapter answered VS Code's `setBreakpoints`
     * for every file concerned within the wait. Undefined without a session
     * or when nothing was removed.
     */
    applied?: boolean;
}

/**
 * Breakpoints live in VS Code's model on every adapter; the adapter reports
 * how it bound each of them. Logpoints on the CMSIS Debugger are GDB
 * `dprintf`s instead, remembered per session under their GDB number.
 */
export interface BreakpointControl {
    /** Adds one source breakpoint (or logpoint) to VS Code's model and returns it. */
    addBreakpoint(file: vscode.Uri, line: number, extras?: { condition?: string; logMessage?: string }): Promise<vscode.SourceBreakpoint>;
    /**
     * Removes the model's source breakpoints at `line` of `file` (with
     * `logpointsOnly`, only those that log) and waits, bounded, until the
     * session's adapter has taken the change.
     */
    removeBreakpoint(file: vscode.Uri, line: number, options?: { logpointsOnly?: boolean }): Promise<BreakpointRemoval>;
    getBreakpoints(): ReadonlyArray<vscode.Breakpoint>;
    /**
     * The breakpoints VS Code adopted from an adapter's announcement of a new
     * one in this window, which `getBreakpoints` lacks until the window
     * reloads; some may also be in `getBreakpoints` already.
     */
    adoptedBreakpoints(): AdoptedBreakpoint[];
    /** Removes every breakpoint of the model and waits, bounded, until the adapter has taken the change. */
    clearAllBreakpoints(): Promise<BreakpointRemoval>;
    /**
     * How the session's adapter reports `breakpoint`, asking again until it
     * has answered or `waitMs` has passed; undefined without a session.
     */
    breakpointBinding(breakpoint: vscode.Breakpoint, waitMs: number): Promise<BreakpointBinding | undefined>;
    // GDB's own breakpoints, for the CMSIS Debugger's logpoints. Each resolves
    // GDB's reply; telling success from failure is up to the caller.
    /** MI `-dprintf-insert` at `location` (a GDB linespec); the reply is the MI result as JSON. */
    insertDprintfViaGdb(location: string, format: string, values: readonly string[], overrideMs?: number): Promise<GdbReply>;
    /** CLI `condition <n> <condition>`. */
    setBreakpointConditionViaGdb(breakpointNo: number, condition: string, overrideMs?: number): Promise<GdbReply>;
    /** CLI `delete <n>…` with the numbers given; never a bare `delete`. */
    deleteBreakpointsViaGdb(numbers: readonly number[], overrideMs?: number): Promise<GdbReply>;
    /** MI `-break-list`; the reply is GDB's breakpoint table as JSON. */
    listBreakpointsViaGdb(overrideMs?: number): Promise<GdbReply>;
    /** The logpoints set as `dprintf` in the current session, by GDB number. */
    gdbLogpoints(): GdbLogpoint[];
    rememberGdbLogpoint(logpoint: GdbLogpoint): void;
    forgetGdbLogpoints(numbers: readonly number[]): void;
}

/** Program state: location, stack, threads, variables and expressions. */
export interface ProgramInspection {
    getCurrentDebugState(lookahead: number): Promise<DebugState>;
    getCallStack(threadId?: number, levels?: number, overrideMs?: number): Promise<StackFrame[]>;
    getThreads(overrideMs?: number): Promise<DapThread[]>;
    /**
     * `{ scopes }`: the frame's scopes, each with its `variables` or the
     * `error` of their read. `local` and `global` read the scopes whose name
     * contains the word; `all` reads every scope, but on the CMSIS Debugger
     * not an expensive register scope (its Registers scope), whose name
     * comes back in `skipped`.
     */
    getVariables(frameId: number, scope?: 'local' | 'global' | 'all', overrideMs?: number): Promise<any>;
    getVariablesForFrame(frameId: number, scope?: 'local' | 'global' | 'all', overrideMs?: number): Promise<any>;
    /**
     * Resolves the adapter's evaluate reply body unchanged. A GDB command
     * written `-exec <cmd>` or `><cmd>` goes to GDB in the prefix of a CMSIS
     * Debugger session, and its text comes back as the `result`.
     */
    evaluateExpression(expression: string, frameId: number, overrideMs?: number): Promise<any>;
    /**
     * The children of a structured value: one DAP `variables` request for
     * the `variablesReference` an evaluate reply or a variable carried.
     */
    getVariableChildren(variablesReference: number, overrideMs?: number): Promise<DapVariable[]>;
}

/**
 * What `readMemory` read: `bytes` begin `offset` bytes after the requested
 * address. The offset is 0 unless the start of the range could not be read;
 * fewer bytes than asked for after it mean the end could not be read either.
 */
export interface MemoryRead {
    bytes: Buffer;
    offset: number;
}

/**
 * Cortex-M target access: memory, core registers, DWT, fault status,
 * peripherals and reset. On the CMSIS Debugger a memory read that fails
 * rejects with `PROBE_WEDGED` when DHCSR cannot be read either, and with
 * `INVALID_ARGUMENT` when it can (#3); the message keeps each strategy's
 * cause.
 */
export interface TargetAccess {
    readMemory(address: string, length: number, overrideMs?: number): Promise<MemoryRead>;
    readMemoryWord(address: string, overrideMs?: number): Promise<number>;
    writeMemoryWord(address: string, value: number, overrideMs?: number): Promise<void>;
    /**
     * The stacked state context (R0–R3, R12, LR, PC, xPSR) and the
     * `stateOffset` bytes below it, read from the stack pointer up: 0x28 when
     * Armv8-M put the additional state context there, else 0 (the default).
     * Fewer bytes when the frame cannot be read whole, none when its start
     * cannot.
     */
    readExceptionFrame(stackPointer: number, overrideMs?: number, stateOffset?: number): Promise<Buffer>;
    /** Values are GDB's text, or `<timeout>` / `<unavailable>` for a register that could not be read. */
    readCoreRegisters(overrideMs?: number, names?: string[]): Promise<Record<string, string>>;
    readCycleCounter(overrideMs?: number): Promise<{ cycles: number; enabledNow: boolean; present: boolean }>;
    readPeripheralRegister(peripheral: string, register?: string, overrideMs?: number): Promise<string>;
    readFaultRegisters(overrideMs?: number): Promise<FaultRegisters>;
    getFaultInfo(overrideMs?: number): Promise<string>;
    /** One read of DHCSR (4 bytes, DAP `readMemory`, at most 1 s): does the debug port answer, and with what (#3). Never rejects. */
    probeDebugPort(overrideMs?: number): Promise<DebugPortProbe>;
    resetTarget(request: { method?: 'auto' | ResetMethod; halt?: boolean; timeoutMs?: number }): Promise<ResetOutcome>;
}

/** Everything `DebuggingHandler` needs from the debug layer. */
export interface IDebuggingExecutor
    extends SessionLifecycle, Readiness, RunControl, BreakpointControl, ProgramInspection, TargetAccess {}
