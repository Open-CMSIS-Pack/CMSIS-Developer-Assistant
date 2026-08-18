// SPDX-License-Identifier: Apache-2.0 OR MIT
// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

/**
 * Flash programming via `pyocd load --cbuild-run <file>` as a synchronous,
 * machine-readable operation: bytes programmed + structured error on failure,
 * instead of "check the output channel" (which an agent cannot read).
 *
 * This module deliberately imports ONLY node builtins — no vscode — so the
 * parsing and process logic is testable outside the extension host.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';

/** Outcome of one `pyocd load` run. */
export interface FlashResult {
    /** True only on exit 0 AND no error-shaped output. */
    ok: boolean;
    exitCode: number | null;
    /** True when the process had to be killed at the deadline. */
    timedOut: boolean;
    /** Bytes reported programmed by pyOCD, or null when not parseable (never invented). */
    programmedBytes: number | null;
    /** Reported programming rate, or null when not parseable. */
    kbps: number | null;
    /** The exact command line, for the result message. */
    commandLine: string;
    /** Last ~12 non-empty output lines, for context on failure. */
    outputTail: string[];
    /** Error-shaped lines (last ~8), for the failure summary. */
    errorLines: string[];
}

/**
 * Parse pyOCD flash-loader output (pyocd/flash/loader.py prints
 * "Erased %d bytes (%s), programmed %d bytes (%s), identical %d bytes (%s)
 * at %.02f kB/s" on completion; chip-erase runs say "Erased chip, ...").
 * Pure — unit-tested. Older/newer pyOCD versions may phrase differently, so
 * callers must treat null fields as "unknown", never as zero.
 */
export function parsePyocdLoadOutput(stdout: string, stderr: string): {
    programmedBytes: number | null;
    kbps: number | null;
    errorLines: string[];
    tail: string[];
} {
    const text = `${stdout}\n${stderr}`;
    const bytesMatch = text.match(/programmed (\d+) bytes/i);
    const rateMatch = text.match(/at ([\d.]+) kB\/s/i);
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const errorLines = lines
        .filter(l => /error|traceback|failed|exception|no probe|no target|not connected/i.test(l))
        .filter(l => !/\b0 errors?\b/i.test(l)) // benign "0 errors" summaries are not failures
        .slice(-8);
    return {
        programmedBytes: bytesMatch ? parseInt(bytesMatch[1], 10) : null,
        kbps: rateMatch ? parseFloat(rateMatch[1]) : null,
        errorLines,
        tail: lines.slice(-12),
    };
}

/**
 * Resolve pyocd on PATH. Returns the reported version string, or null when
 * pyocd is missing / not runnable.
 */
export async function probePyocd(timeoutMs = 5_000): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (version: string | null) => {
            if (!settled) { settled = true; resolve(version); }
        };
        let child;
        try {
            child = spawn('pyocd', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            finish(null);
            return;
        }
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, timeoutMs);
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        child.on('error', () => { clearTimeout(timer); finish(null); });
        child.on('close', (code) => {
            clearTimeout(timer);
            finish(code === 0 ? out.trim().split(/\r?\n/)[0] || 'pyocd (version unknown)' : null);
        });
    });
}

/**
 * Program all images listed under `output:` in a cbuild-run file via pyOCD.
 * spawn without a shell — no quoting or injection surface. The process is
 * SIGTERMed at the deadline (SIGKILL 2 s later) so a wedged probe cannot
 * hang the tool call.
 */
export async function flashWithPyocd(cbuildRunFile: string, timeoutMs: number): Promise<FlashResult> {
    const args = ['load', '--cbuild-run', cbuildRunFile];
    const commandLine = `pyocd ${args.join(' ')}`;
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const child = spawn('pyocd', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        // Cap captured output so a chatty run cannot grow unbounded.
        const CAP = 256 * 1024;
        child.stdout.on('data', (d) => { if (stdout.length < CAP) { stdout += d.toString(); } });
        child.stderr.on('data', (d) => { if (stderr.length < CAP) { stderr += d.toString(); } });

        const killTimer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => { if (!child.killed) { child.kill('SIGKILL'); } }, 2_000).unref();
        }, timeoutMs);

        const finish = (exitCode: number | null) => {
            clearTimeout(killTimer);
            const parsed = parsePyocdLoadOutput(stdout, stderr);
            resolve({
                ok: !timedOut && exitCode === 0 && parsed.errorLines.length === 0,
                exitCode,
                timedOut,
                programmedBytes: parsed.programmedBytes,
                kbps: parsed.kbps,
                commandLine,
                outputTail: parsed.tail,
                errorLines: parsed.errorLines,
            });
        };
        child.on('error', (err) => {
            // spawn failure (e.g. ENOENT despite probePyocd) — surface as a
            // failed run rather than throwing.
            stderr += `\nspawn error: ${err.message}`;
            finish(1);
        });
        child.on('close', (code) => finish(code));
    });
}

/** True when the path exists and is a file — used for explicit-path validation. */
export function fileExists(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}
