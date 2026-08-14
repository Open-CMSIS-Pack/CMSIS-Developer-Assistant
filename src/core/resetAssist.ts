// Copyright (c) Microsoft Corporation.

/**
 * Pure helpers for the `reset` tool: which GDB monitor commands to send for a
 * given server + reset method, and how to tell which GDB server is behind the
 * session. Kept free of vscode/DAP imports so the mapping is unit-testable.
 */

export type ResetMethod = 'system' | 'core' | 'hardware';
export type GdbServerKind = 'pyocd' | 'jlink' | 'unknown';

/**
 * Build the GDB monitor command(s) for a target reset.
 *
 * pyOCD accepts OpenOCD-style `monitor reset [run|halt|init] [system|core|hardware]`
 * (system = SYSRESETREQ, core = VECTRESET, hardware = nSRST). J-Link accepts
 * `monitor reset [N]` where 0 = normal (uses nSRST when wired, i.e. the
 * hardware path) and 1 = core only; halt is a separate monitor command.
 * Unknown servers get the pyOCD form — pyOCD is the common case for CMSIS
 * gdbtarget sessions, and an unrecognized reply is handled by the caller.
 */
export function buildResetCommands(server: GdbServerKind, method: ResetMethod, halt: boolean): string[] {
    if (server === 'jlink') {
        const type = method === 'core' ? 1 : 0;
        return halt ? ['monitor halt', `monitor reset ${type}`] : [`monitor reset ${type}`];
    }
    return [`monitor reset ${halt ? 'halt' : 'run'} ${method}`];
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
