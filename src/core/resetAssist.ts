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
 * Pure helpers for the `reset` tool: which GDB monitor commands to send for a
 * given server + reset method, and how to tell which GDB server is behind the
 * session. Kept free of vscode/DAP imports so the mapping is unit-testable.
 */

export type ResetMethod = 'system' | 'core' | 'hardware';
export type GdbServerKind = 'pyocd' | 'jlink' | 'unknown';

/**
 * J-Link's reset strategy for each method on Cortex-M (UM08001, "Strategies
 * for Cortex-M devices"): 0 normal, which is SYSRESETREQ for most devices,
 * 1 core (VECTRESET), 2 reset pin. The J-Link launch templates of CMSIS
 * Solution map the csolution reset types to the same numbers.
 */
const JLINK_RESET_TYPES: Readonly<Record<ResetMethod, number>> = { system: 0, core: 1, hardware: 2 };

/**
 * Build the GDB monitor command(s) for a target reset.
 *
 * A method names the same reset on every server: system resets core and
 * peripherals (SYSRESETREQ), core only the core (VECTRESET), hardware pulls
 * the reset line (nSRST). pyOCD's `monitor reset [halt] [TYPE]` takes the
 * method name as TYPE, and only as the one argument after the optional halt
 * (`reset run system` would be a reset of the default type); with halt the
 * core stops at the reset vector, without it the core runs. J-Link's
 * `monitor reset <type>` takes the number of its reset strategy and leaves
 * the core halted after every one, so the running form starts it with
 * `monitor go`; the halting form sends `monitor halt` first. Unknown servers
 * get the pyOCD form — pyOCD is the common case for CMSIS gdbtarget
 * sessions, and an unrecognized reply is handled by the caller.
 *
 * GDB sees neither a reset nor a run that a monitor command starts, which is
 * why the `reset` tool sends the halting form and resumes through DAP
 * (src/executor/targetReset.ts).
 */
export function buildResetCommands(server: GdbServerKind, method: ResetMethod, halt: boolean): string[] {
    if (server === 'jlink') {
        const reset = `monitor reset ${JLINK_RESET_TYPES[method]}`;
        return halt ? ['monitor halt', reset] : [reset, 'monitor go'];
    }
    return [halt ? `monitor reset halt ${method}` : `monitor reset ${method}`];
}

/**
 * Identify the GDB server behind a debug session from configuration/name
 * text (e.g. `configuration.target.server`, `configuration.debugger.name`,
 * session name). Callers concatenate whatever fields they have.
 */
export function detectGdbServerKind(haystack: string): GdbServerKind {
    const s = haystack.toLowerCase();
    if (s.includes('pyocd')) { return 'pyocd'; }
    if (s.includes('jlink') || s.includes('j-link')) { return 'jlink'; }
    return 'unknown';
}

/**
 * True when a monitor-command reply reads like "this server does not know
 * that command" — the signal to escalate to the next reset method rather
 * than trusting the reset happened.
 */
export function replyLooksUnsupported(reply: string): boolean {
    return /unknown (monitor )?command|unrecognized|invalid (command|argument|usage)|not supported|syntax error/i.test(reply);
}

/**
 * The verification detail for a reset command the adapter did not know:
 * says whether another method follows, so the last (or only) method never
 * promises a "next" that is not coming.
 */
export function unsupportedResetDetail(method: ResetMethod, remaining: number): string {
    return remaining > 0
        ? `adapter did not recognize the ${method} reset command — trying the next method`
        : `adapter did not recognize the ${method} reset command; no further method to try`;
}

/** What `resetTarget` found out, rendered by `renderResetOutcome`. */
export interface ResetOutcomeView {
    serverKind: GdbServerKind;
    methodsTried: ResetMethod[];
    commandsIssued: string[];
    replies: string[];
    verified: boolean;
    verificationDetail: string;
    /** True when the target was running and the tool halted it to issue the reset. */
    haltedByUs: boolean;
    /** True when the tool resumed the target afterwards (`halt: false` on a verified reset). */
    resumed: boolean;
}

/**
 * What to do when no reset method verified, for every kind of GDB server: a
 * fresh connect needs no one at the board, and it is what brings back J-Link
 * targets and secure-boot parts whose core nSRST alone does not re-vector
 * (#20). Only when that fails too does a person have to act.
 */
const UNVERIFIED_RESET_NEXT_STEP =
    'Next: stop_debugging, then cmsis_action load_and_debug (a fresh connect and reset). That is the working fallback on '
    + 'J-Link and on secure-boot parts such as Alif Ensemble, where nSRST alone does not re-vector the core. '
    + 'If that fails too, power-cycle the board or reconnect the probe.';

/**
 * The `reset` tool's result text. Tells the truth about the end state: an
 * unverified reset leaves the target halted — and says so, including that
 * `halt: false` was not applied and whether the target was running before —
 * and names the next step.
 */
export function renderResetOutcome(outcome: ResetOutcomeView, halt: boolean | undefined): string {
    const commandsLine = outcome.commandsIssued.length > 0
        ? ` Commands: ${outcome.commandsIssued.map(c => `'${c}'`).join(', ')} (server: ${outcome.serverKind}).`
        : '';
    if (outcome.verified) {
        const next = outcome.resumed
            ? ' Target resumed (halt=false).'
            : ' Target is halted at the reset vector — use continue_execution to run.';
        return `Target reset verified. ${outcome.verificationDetail}. ` +
            `Method(s) tried: ${outcome.methodsTried.join(', ')}.${commandsLine}${next}`;
    }
    const before = outcome.haltedByUs ? ' (it was running before the reset)' : '';
    const notApplied = halt === false ? '; halt=false was not applied because the reset could not be verified' : '';
    return `⚠️ Reset was issued but the target does NOT appear to have reset. ${outcome.verificationDetail}. ` +
        `Method(s) tried: ${outcome.methodsTried.join(', ')}.${commandsLine} ` +
        `The target is halted${before}${notApplied} — use continue_execution to run. ` +
        `${UNVERIFIED_RESET_NEXT_STEP} ` +
        `Adapter replies: ${outcome.replies.join(' | ') || '<none>'}`;
}
