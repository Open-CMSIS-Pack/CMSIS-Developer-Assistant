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
 * Build log reader: diagnostics from GCC/Clang/armclang (`file:line:col:
 * severity: message`), the older armcc/armclang style (`"file", line N:
 * Error: #NNN: message`), armlink (`Error: L6218E: ...`), GNU ld
 * (`undefined reference to`), CMake, ninja (`FAILED:`) and cbuild/csolution
 * lines, plus the build's final status line. ANSI colour codes are stripped
 * first; identical diagnostics from several translation units are folded.
 */

import * as fs from 'fs';

export type Severity = 'error' | 'warning' | 'note';

export interface Diagnostic {
    severity: Severity;
    file?: string;
    line?: number;
    col?: number;
    /** Compiler/linker code: `L6218E`, `#20`, `-Wunused-variable`. */
    code?: string;
    message: string;
    tool: 'compiler' | 'linker' | 'cmake' | 'ninja' | 'cbuild';
    /** 1-based line in the log. */
    logLine: number;
    /** Occurrences folded into this entry. */
    count: number;
}

export interface BuildLogSummary {
    file: string;
    sizeBytes: number;
    mtimeMs: number;
    lines: number;
    errors: number;
    warnings: number;
    notes: number;
    diagnostics: Diagnostic[];
    /** ninja `FAILED:` targets, shortened. */
    failedSteps: string[];
    /** `(1/2) Building context: "..."` names. */
    contexts: string[];
    /** `Using compiler: AC6 V6.24.0` or similar. */
    compilerLine?: string;
    /** The last status line: cbuild summary, ninja stop, "build finished successfully". */
    status?: string;
    ok?: boolean;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function sev(word: string): Severity {
    const w = word.toLowerCase();
    if (w.includes('error')) { return 'error'; }
    if (w.includes('warning')) { return 'warning'; }
    return 'note';
}

function keyOf(d: Omit<Diagnostic, 'logLine' | 'count'>): string {
    return `${d.severity}|${d.file ?? ''}|${d.line ?? ''}|${d.col ?? ''}|${d.code ?? ''}|${d.message}`;
}

/** `/very/long/path/src/main.c` → `src/main.c`-ish: keep the last three path elements. */
export function shortPath(p: string): string {
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length <= 3 ? p : `…/${parts.slice(-3).join('/')}`;
}

export function parseBuildLog(text: string, file: string, stat?: { size: number; mtimeMs: number }): BuildLogSummary {
    const lines = text.replace(ANSI, '').split(/\r?\n/);
    const summary: BuildLogSummary = {
        file, sizeBytes: stat?.size ?? Buffer.byteLength(text), mtimeMs: stat?.mtimeMs ?? 0, lines: lines.length,
        errors: 0, warnings: 0, notes: 0, diagnostics: [], failedSteps: [], contexts: [],
    };
    const seen = new Map<string, Diagnostic>();
    const push = (d: Omit<Diagnostic, 'logLine' | 'count'>, logLine: number) => {
        const key = keyOf(d);
        const prev = seen.get(key);
        if (prev) { prev.count++; return; }
        const entry: Diagnostic = { ...d, logLine, count: 1 };
        seen.set(key, entry);
        summary.diagnostics.push(entry);
    };

    // GCC / Clang / armclang (new style), also GNU as (`file.S:12: Error: ...`).
    const gccRe = /^(?:.*?\s)?([^\s:"][^:"]*?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note|Error|Warning|Note):\s*(.*?)\s*$/;
    // armcc / armclang legacy: "file", line N: Error: #NNN: msg  |  "file", line N (column M): Warning: #NNN-D: msg
    const armOldRe = /^"([^"]+)", line (\d+)(?: \(column (\d+)\))?:\s*(Error|Warning|Fatal error|Remark|Info):\s*(#[\w-]+:)?\s*(.*?)\s*$/;
    // armlink: Error: L6218E: Undefined symbol ...  /  Warning: L6329W: ... / Fatal error: L6002U:
    const armlinkRe = /^(?:.*?:\s*)?(Error|Warning|Fatal error):\s*(L\d{4}[A-Z]):\s*(.*?)\s*$/;
    // GNU ld: file.o: in function `x': path:12: undefined reference to `y'   /   ld: region `FLASH' overflowed by 123 bytes
    const ldUndefRe = /^(?:\S*(?:ld|ld\.lld|ld\.bfd|collect2): )?(?:(\S+?):(\d+):|(\S+?):\(\S+?\+0x[0-9a-fA-F]+\):)?\s*(undefined reference to .*|multiple definition of .*|cannot find .*|.*will not fit in region .*|region [`'].*?' overflowed by .*|.* exceeds available memory .*)$/;
    const ldGenericRe = /^(?:.*?)(?:arm-none-eabi-ld|ld\.lld|ld|collect2|clang(?:\+\+)?|armlink|gcc|g\+\+|armclang):\s*(fatal error|error|warning):\s*(.*?)\s*$/;
    // CMake: CMake Error at CMakeLists.txt:12 (message):  /  CMake Error: ...
    const cmakeRe = /^CMake (Error|Warning|Deprecation Warning)(?: at ([^:]+):(\d+)(?: \([^)]*\))?)?:\s*(.*?)\s*$/;
    // cbuild / csolution: `error csolution: ...`, `warning cbuild: ...`, `error cbuild: ...`
    const cbuildRe = /^(error|warning|info)\s+(csolution|cbuild|cpackget|cbuild2cmake|cbuildgen):\s*(.*?)\s*$/;
    const ninjaFailedRe = /^FAILED:\s*(?:\[code=\d+\]\s*)?(.*?)\s*$/;
    const contextRe = /^\(\d+\/\d+\) Building context:\s*"?([^"]+)"?\s*$/;
    const compilerRe = /^(?:Using compiler:\s*(.+)|Using (\S+ V[\d.]+) compiler,.*)$/;
    const statusRe = /^(Build summary: .*|.*build (?:finished successfully|failed)!?|ninja: build stopped: .*|ninja: no work to do\.|.*Build completed successfully.*|.*Build failed.*|Finished: \d+ information, \d+ warning, \d+ error and \d+ fatal error messages\.)\s*$/i;

    let pendingCMake: { d: Omit<Diagnostic, 'logLine' | 'count'>; logLine: number } | undefined;

    lines.forEach((raw, i) => {
        const line = raw.trimEnd();
        const n = i + 1;
        if (!line.trim()) {
            if (pendingCMake) { push(pendingCMake.d, pendingCMake.logLine); pendingCMake = undefined; }
            return;
        }
        if (pendingCMake) {
            // Message text follows on the indented lines after `CMake Error at ...:`.
            if (line.startsWith('  ')) { pendingCMake.d.message = `${pendingCMake.d.message} ${line.trim()}`.trim(); return; }
            push(pendingCMake.d, pendingCMake.logLine); pendingCMake = undefined;
        }
        let m: RegExpMatchArray | null;
        if ((m = line.match(contextRe))) { summary.contexts.push(m[1]); return; }
        if ((m = line.match(compilerRe))) { summary.compilerLine = (m[1] ?? m[2]).trim(); return; }
        if ((m = line.match(ninjaFailedRe))) { summary.failedSteps.push(shortPath(m[1].split(/\s+/)[0] ?? m[1])); return; }
        if ((m = line.match(statusRe))) { summary.status = m[1].trim(); return; }
        if ((m = line.match(cmakeRe))) {
            pendingCMake = { d: { severity: sev(m[1]), file: m[2], line: m[3] ? Number(m[3]) : undefined, message: m[4], tool: 'cmake' }, logLine: n };
            return;
        }
        if ((m = line.match(cbuildRe))) {
            if (m[1] === 'info') { return; }
            push({ severity: sev(m[1]), message: m[3], tool: 'cbuild', code: m[2] }, n);
            return;
        }
        if ((m = line.match(armlinkRe))) {
            push({ severity: sev(m[1]), code: m[2], message: m[3], tool: 'linker' }, n);
            return;
        }
        if ((m = line.match(armOldRe))) {
            if (m[4] === 'Remark' || m[4] === 'Info') { return; }
            push({ severity: sev(m[4]), file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, code: m[5]?.replace(/:$/, ''), message: m[6], tool: 'compiler' }, n);
            return;
        }
        if ((m = line.match(gccRe))) {
            // `In file included from x.h:3:` has no severity and is not matched; `note:` lines that only say "in expansion of macro" are noise.
            let message = m[5];
            let code: string | undefined;
            const flag = message.match(/\s\[(-W[\w#=+.-]+|-Werror(?:=[\w#-]+)?)\]$/);
            if (flag) { code = flag[1]; message = message.slice(0, -flag[0].length); }
            if (m[4].toLowerCase() === 'note' && /^in expansion of macro|^in definition of macro|^expanded from macro/.test(message)) { return; }
            push({ severity: sev(m[4]), file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, code, message, tool: 'compiler' }, n);
            return;
        }
        if ((m = line.match(ldUndefRe))) {
            push({ severity: 'error', file: m[1] ?? m[3], line: m[2] ? Number(m[2]) : undefined, message: m[4], tool: 'linker' }, n);
            return;
        }
        if ((m = line.match(ldGenericRe))) {
            if (/ld returned \d+ exit status/.test(m[2])) { return; }
            push({ severity: sev(m[1]), message: m[2], tool: 'linker' }, n);
            return;
        }
    });
    if (pendingCMake) { push(pendingCMake.d, pendingCMake.logLine); }

    for (const d of summary.diagnostics) {
        if (d.severity === 'error') { summary.errors += d.count; } else if (d.severity === 'warning') { summary.warnings += d.count; } else { summary.notes += d.count; }
    }
    if (summary.status) {
        const s = summary.status.toLowerCase();
        summary.ok = /successfully|no work to do|completed successfully/.test(s) ? true
            : /failed|stopped/.test(s) ? !(/\b[1-9]\d* failed\b/.test(s) || /stopped|build failed/.test(s))
            : /(\d+) error and (\d+) fatal/.test(s) ? (s.match(/(\d+) error and (\d+) fatal/)![1] === '0' && s.match(/(\d+) error and (\d+) fatal/)![2] === '0') : undefined;
    } else if (summary.errors || summary.failedSteps.length) {
        summary.ok = false;
    }
    return summary;
}

export function readBuildLog(file: string, maxBytes = 16 * 1024 * 1024): BuildLogSummary {
    const stat = fs.statSync(file);
    let text: string;
    if (stat.size > maxBytes) {
        // Keep the tail: the failure and the summary are at the end.
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(maxBytes);
            fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
            text = buf.toString('utf-8');
        } finally { fs.closeSync(fd); }
    } else {
        text = fs.readFileSync(file, 'utf-8');
    }
    return parseBuildLog(text, file, { size: stat.size, mtimeMs: stat.mtimeMs });
}

/** Cheap check that a `.log` is a build log and not, say, a serial capture. */
export function looksLikeBuildLog(file: string, probeBytes = 64 * 1024): boolean {
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(probeBytes);
            const n = fs.readSync(fd, buf, 0, probeBytes, 0);
            const head = buf.toString('utf-8', 0, n);
            return /Building context|cbuild|csolution|cmake|ninja|armclang|armlink|arm-none-eabi|clang|gcc|\berror\b|\bwarning\b|Build summary/i.test(head);
        } finally { fs.closeSync(fd); }
    } catch {
        return false;
    }
}
