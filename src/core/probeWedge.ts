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
 * A wedged probe, told apart from an address that cannot be read (#3,
 * phase 1).
 *
 * When a memory read fails on the CMSIS Debugger, the executor reads DHCSR
 * (0xE000EDF0, 4 bytes, DAP `readMemory`, at most 1 s) once. A debugger can
 * read DHCSR on every Cortex-M while the debug port works, so
 * `classifyReadFailure` decides:
 *
 *   - DHCSR unreadable, or timed out: the probe or its GDB server is wedged,
 *     `PROBE_WEDGED`, with the cause of every read strategy kept;
 *   - DHCSR readable after a failed read: the address is not readable in this
 *     state, `INVALID_ARGUMENT`;
 *   - DHCSR readable after a read that timed out: the read was only slow, and
 *     its timeout stands;
 *   - DHCSR refused because the target runs: `TARGET_RUNNING`, not a wedge.
 *
 * A readable DHCSR with S_LOCKUP adds a lockup note to the fault tools.
 * `check_target_connection` reads DHCSR on a stopped session as well, and
 * `read_core_registers` when no register could be read: `coreVerdict` says
 * whether the core answered, and the session tracker remembers a read that
 * got no answer for `get_session_status`, which reads nothing itself.
 *
 * The way out depends on who owns the GDB server (`wedgeHint`): an attached
 * session reconnects with `cmsis_action detach` and `attach`, which does not
 * reset; a launched session owns its server, so keeping the fault state takes
 * a server restarted without a reset — by the user, since agents do not start
 * GDB servers. Nothing here retries or reconnects on its own: a reconnect
 * replaces the debug session and must not happen as a side effect of a read.
 *
 * Pure: no `vscode`.
 */

import { saysTargetRunning, TARGET_RUNNING_HINT } from './gdbDialect';
import { ToolError } from './toolResult';

/** The Debug Halting Control and Status Register, readable whenever the debug port works. */
export const DHCSR_ADDRESS = '0xE000EDF0';
/** DHCSR.S_HALT: the core is in Debug state, halted. */
export const DHCSR_S_HALT = 1 << 17;
/** DHCSR.S_SLEEP: the core sleeps (WFI, WFE or sleep-on-exit). */
export const DHCSR_S_SLEEP = 1 << 18;
/** DHCSR.S_LOCKUP: the core is locked up by an unrecoverable exception. */
export const DHCSR_S_LOCKUP = 1 << 19;
/** The DHCSR read gets at most this long. */
export const CANARY_MS = 1_000;
/** Each read strategy's cause is kept to this many characters. */
export const CAUSE_MAX_CHARS = 200;

/** One way of reading that did not give the value, and why. */
export interface ReadAttempt {
    /** `DAP readMemory`, `watch expression`, `MI read`, `x/1xw`, `print/x`. */
    strategy: string;
    cause: string;
}

/** What the DHCSR read found: the port answers with DHCSR, or it does not, and why. */
export type DebugPortProbe =
    | { readable: true; dhcsr: number }
    | { readable: false; timedOut: boolean; cause: string };

/** A DHCSR read that did not give the value. */
export type SilentProbe = Extract<DebugPortProbe, { readable: false }>;

/**
 * What one DHCSR read says about the core: it `answers`, it is `silent`
 * (unreadable or timed out), or nothing is `unknown` — an adapter without
 * DAP `readMemory`, or GDB answering that the target runs.
 */
export type CoreVerdict = 'answers' | 'silent' | 'unknown';

/** The facts a failed read is judged by. */
export interface ReadFailureFacts {
    /** The address that could not be read. */
    address: string;
    /** Each strategy's cause, in the order they were tried. */
    attempts: readonly ReadAttempt[];
    /** The read ended in a `HardwareTimeoutError`. */
    timedOut: boolean;
    probe: DebugPortProbe;
    /** `session.configuration.request`: `attach` or `launch`. */
    request: string | undefined;
}

/** An adapter without DAP `readMemory` says so; its DHCSR read then tells nothing about the port. */
const UNSUPPORTED = /unrecognized request|not supported|unsupported|not implemented/i;

/**
 * The CMSIS Run task starts pyOCD with `--persist`: its GDB server outlives every detach and ends with the task.
 * pyOCD halts the target when GDB connects and resumes it when the last client leaves.
 */
const ATTACH_HINT = 'This session is attached to a GDB server that lives as long as its CMSIS Run task: cmsis_action detach, '
    + 'then cmsis_action attach reconnects without a reset (pyOCD lets the target run while detached and halts it on attach); '
    + 'then get_fault_info. If attach then fails with "could not connect", the server ended with its task (window closed or reloaded, '
    + 'stop_run): cmsis_action run in the window that owns the board starts it again, with a reset.';

const LAUNCH_HINT = 'This session launched its own GDB server: detaching or stopping the session stops that server, and '
    + 'restart_debugging or cmsis_action load_and_debug re-flash and reset the target. To keep the fault state, ask the user to '
    + 'restart the GDB server without a reset (J-Link -nohalt -noreset, pyOCD -O connect_mode=attach) — do not start one yourself — '
    + 'then cmsis_action attach and get_fault_info. If the fault state does not matter: cmsis_action load_and_debug.';

const UNREADABLE_HINT = 'Check the address against the device\'s memory map — lookup_peripheral { address } names what is there. '
    + 'A peripheral whose clock is off, memory behind the MPU or TrustZone, or an address with nothing behind it cannot be read.';

/** Shown by get_fault_info and diagnose_fault when DHCSR.S_LOCKUP is set. */
export const LOCKUP_NOTE = 'The core is in lockup (DHCSR.S_LOCKUP=1): it met a fault it could not handle — a fault inside the HardFault '
    + 'or NMI handler, or while entering one — and stopped executing. The fault status shows what went wrong; a reset leaves lockup.';

/** A cause on one line, at most `CAUSE_MAX_CHARS` characters. */
export function clipCause(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= CAUSE_MAX_CHARS ? flat : `${flat.slice(0, CAUSE_MAX_CHARS - 1)}…`;
}

/** `DAP readMemory: …; watch expression: …`, each cause clipped, repeats left out. */
export function attemptsText(attempts: readonly ReadAttempt[]): string {
    const lines: string[] = [];
    for (const attempt of attempts) {
        const line = `${attempt.strategy}: ${clipCause(attempt.cause)}`;
        if (!lines.includes(line)) {
            lines.push(line);
        }
    }
    return lines.join('; ');
}

export function isLockedUp(dhcsr: number): boolean {
    return (dhcsr & DHCSR_S_LOCKUP) !== 0;
}

/** The verdict of one DHCSR read (`CoreVerdict`). */
export function coreVerdict(probe: DebugPortProbe): CoreVerdict {
    if (probe.readable) {
        return 'answers';
    }
    if (!probe.timedOut && (UNSUPPORTED.test(probe.cause) || saysTargetRunning(probe.cause))) {
        return 'unknown';
    }
    return 'silent';
}

/** `DHCSR at 0xE000EDF0 timed out`, or `… unreadable: <cause>` with the cause clipped. */
export function silentPortText(probe: SilentProbe): string {
    return probe.timedOut ? `DHCSR at ${DHCSR_ADDRESS} timed out` : `DHCSR at ${DHCSR_ADDRESS} unreadable: ${clipCause(probe.cause)}`;
}

/** What a DHCSR read that got no answer means for the reads to come; a sentence without its subject's capital. */
export function silentCoreText(probe: SilentProbe): string {
    return `the core does not answer (${silentPortText(probe)}): memory and register reads will fail with PROBE_WEDGED.`;
}

/** `DHCSR=0x00030003 (halted)`: the value, and whether the core is halted, sleeps or is in lockup. */
export function dhcsrSummary(dhcsr: number): string {
    const facts = [(dhcsr & DHCSR_S_HALT) !== 0 ? 'halted' : 'not halted'];
    if ((dhcsr & DHCSR_S_SLEEP) !== 0) {
        facts.push('sleeping');
    }
    if (isLockedUp(dhcsr)) {
        facts.push('in lockup — get_fault_info');
    }
    return `DHCSR=0x${(dhcsr >>> 0).toString(16).padStart(8, '0')} (${facts.join(', ')})`;
}

/** `12 s` below two minutes, `40 min` from then on. */
export function ageText(ageMs: number): string {
    const seconds = Math.max(0, Math.round(ageMs / 1000));
    return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** How to reconnect, for a session started with `request` (`attach` or `launch`). */
export function wedgeHint(request: string | undefined): string {
    return request === 'attach' ? ATTACH_HINT : LAUNCH_HINT;
}

/**
 * The error a failed read becomes once DHCSR was read: `PROBE_WEDGED`,
 * `INVALID_ARGUMENT`, or undefined to keep the read's own error (a timeout
 * on a port that answers, or a DHCSR read the adapter cannot do at all).
 */
export function classifyReadFailure(facts: ReadFailureFacts): ToolError | undefined {
    const { address, probe, timedOut } = facts;
    const reads = attemptsText(facts.attempts);
    if (probe.readable) {
        if (timedOut) {
            return undefined;
        }
        return new ToolError('INVALID_ARGUMENT',
            `Cannot read ${address} — the debug port answers, the address is not readable in this state: ${reads}`, UNREADABLE_HINT);
    }
    if (!probe.timedOut && UNSUPPORTED.test(probe.cause)) {
        return undefined;
    }
    if (!probe.timedOut && saysTargetRunning(probe.cause)) {
        return new ToolError('TARGET_RUNNING', `Cannot read ${address}: the target is running — ${reads}`, TARGET_RUNNING_HINT);
    }
    const port = silentPortText(probe);
    const lead = timedOut ? 'Memory reads time out' : 'Memory reads fail';
    return new ToolError('PROBE_WEDGED', `${lead} and the debug port does not answer (${port}). Reading ${address} — ${reads}`,
        wedgeHint(facts.request));
}
