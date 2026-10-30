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
 * Provenance check against microsoft/DebugMCP (issue #53).
 *
 * Two measures over trimmed, non-trivial lines:
 *   - per file with a DebugMCP counterpart: lines shared, in order, with that
 *     file at the last synced commit (longest common subsequence);
 *   - per source file: distinct lines found anywhere in DebugMCP's history
 *     (every text file of every commit up to the synced one).
 *
 *   npm run provenance:check                 both tables
 *   npm run provenance:check -- --gate       also fail when a gated file (a path DebugMCP
 *                                            ever had, or new since REWRITE_BASE)
 *                                            without the Microsoft line contains more
 *                                            than GATE_MAX_SHARED lines from the history
 *   npm run provenance:check -- --at REV     measure the files as they were at REV
 *   npm run provenance:check -- --lines F    print the shared lines of file F
 *                                            (shows DebugMCP text: not for implementers)
 *
 * Needs network on first use: DebugMCP is cloned once into a cache directory.
 * Not part of CI for that reason; it is the acceptance tool for rewrite PRs.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UPSTREAM_URL = 'https://github.com/microsoft/DebugMCP.git';
/** v2.3.1, the last upstream state this project took changes from. */
const UPSTREAM_SHA = '148cbb9a';
// Assembled so that this file does not itself carry the line it looks for.
const MS_LINE = ['Copyright (c)', 'Microsoft', 'Corporation'].join(' ');
/**
 * Lines found anywhere in DebugMCP's history that a gated file may contain.
 * Independently written files of this repository measure 0-5 with the filters below.
 */
const GATE_MAX_SHARED = 5;
/**
 * Files the gate does not judge, with the reason. Everything else with a
 * DebugMCP counterpart, or new since REWRITE_BASE, must pass.
 */
const GATE_EXEMPT: Record<string, string> = {
    'package.json': 'manifest: identifiers, script names and contribution keys',
    'CHANGELOG.md': 'historical release entries (issue #53, phase 5)',
    'CHANGES-VS-UPSTREAM.md': 'the provenance record itself (issue #53, phase 5)',
    'NOTICE': 'license review pending (issue #54)',
    'LICENSE-MIT': 'license review pending (issue #54)',
};
/** The commit the rewrite started from; files created after it are gated too. */
const REWRITE_BASE = '951530e';
/** Files whose counterpart upstream lives under another name. */
const RENAMED: Record<string, string> = {
    'scripts/test-skill-trigger.ts': 'scripts/test-debug-skill-trigger.js',
    'scripts/lib/copilotCli.ts': 'scripts/test-debug-skill-trigger.js',
    'src/utils/timeout.ts': 'src/utils/withTimeout.ts',
    'src/test/timeout.test.ts': 'src/test/withTimeout.test.ts',
    'skills/cmsis-debug-live/SKILL.md': 'skills/debug-live/SKILL.md',
};
/** Directories whose files map by base name onto an upstream directory. */
const RENAMED_DIRS: Array<[string, string]> = [
    ['docs/agent-resources/troubleshooting/', 'skills/debug-live/references/troubleshooting/'],
    ['skills/cmsis-debug-live/references/troubleshooting/', 'skills/debug-live/references/troubleshooting/'],
];
/** Files whose lines are compared: code, prose, data and ignore lists. */
const TEXT_FILE = /(\.(ts|js|mjs|cjs|md|json|ya?ml)|(^|\/)\.[\w-]*ignore)$/;
/** Lines too generic to say anything about where a file came from. */
const BOILERPLATE = new Set([
    "import * as vscode from 'vscode';",
    "import * as path from 'path';",
    "import * as fs from 'fs';",
    "import * as os from 'os';",
    "import * as http from 'http';",
    "import * as assert from 'assert';",
    "'use strict';",
    'export {};',
    '} catch (error) {',
    '} catch (err) {',
    '} finally {',
    '} else {',
    'return undefined;',
    'return false;',
    'return true;',
    'return result;',
    // Idioms any Node or MCP code writes the same way.
    "const http = require('http');",
    'return new Promise((resolve, reject) => {',
    "req.on('error', reject);",
    "'Content-Type': 'application/json',",
    "'Accept': 'application/json, text/event-stream',",
    "'Accept': 'text/event-stream',",
    "'Host': `127.0.0.1:${port}`,",
    'async function main() {',
    'await server.initialize();',
    'await server.start();',
    'await server.stop();',
    'const timer = setTimeout(() => {',
    'timer = setTimeout(() => {',
    'clearTimeout(timer);',
    'const started = Date.now();',
]);

interface FileReport {
    file: string;
    upstream: string;
    lines: number;
    shared: number;
    hasMsLine: boolean;
    sharedLines: string[];
}

function repoRoot(): string {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function upstreamCheckout(): string {
    const dir = path.join(os.tmpdir(), `cda-provenance-debugmcp-${UPSTREAM_SHA}`);
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.rmSync(dir, { recursive: true, force: true });
        execFileSync('git', ['clone', '--quiet', UPSTREAM_URL, dir], { stdio: 'inherit' });
    }
    execFileSync('git', ['-C', dir, 'checkout', '--quiet', UPSTREAM_SHA], { stdio: 'inherit' });
    return dir;
}

function isTrivial(line: string): boolean {
    if (line.length < 20) { return true; }
    if (BOILERPLATE.has(line)) { return true; }
    // Imports are dictated by module names, short declarations by the types they declare.
    if (/^import\b.*\bfrom\s+['"][^'"]+['"];?$/.test(line)) { return true; }
    if (line.length < 48 && /^(readonly\s+|private\s+|public\s+)*[\w$]+\??\s*:\s*[\w$.<>[\]| ']+[;,]?$/.test(line)) { return true; }
    // Formats, not prose: Markdown tables with one-word headings, lists of
    // identifiers (tool names, keys), and short JSON settings.
    if (/^\|(\s*[\w#.-]+\s*\|)+$/.test(line)) { return true; }
    if (/^[-*]\s+`?[\w.-]+`?$/.test(line)) { return true; }
    if (line.length < 48 && /^"[\w$.-]+"\s*:\s*("[^"]*"|true|false|null|-?\d+|\{|\[)\s*,?$/.test(line)) { return true; }
    return /^[\s{}()[\];,.:*/\\|-]*$/.test(line);
}

function significantText(text: string): string[] {
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => !isTrivial(l));
}

function significantLines(file: string): string[] {
    return significantText(fs.readFileSync(file, 'utf8'));
}

/** Lines of `a` that are part of a longest common subsequence with `b`. */
function sharedInOrder(a: string[], b: string[]): string[] {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = new Uint16Array(rows * cols);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * cols + j] = a[i] === b[j]
                ? table[(i + 1) * cols + j + 1] + 1
                : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
        }
    }
    const out: string[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { out.push(a[i]); i++; j++; }
        else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { i++; }
        else { j++; }
    }
    return out;
}

function counterpart(file: string, upstream: string): string | undefined {
    const candidates = [RENAMED[file], file];
    for (const [ours, theirs] of RENAMED_DIRS) {
        if (file.startsWith(ours)) { candidates.push(theirs + file.slice(ours.length)); }
    }
    return candidates.find((c) => c !== undefined && fs.existsSync(path.join(upstream, c)));
}

/**
 * Every non-trivial line that ever existed in a text file of DebugMCP, in any
 * commit up to the pinned one. Catches strings that came from an older
 * upstream version or moved between upstream files.
 */
function upstreamHistoryLines(upstream: string, pathsEver: Set<string>): Set<string> {
    const objects = execFileSync('git', ['-C', upstream, 'rev-list', '--objects', UPSTREAM_SHA], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const blobs = new Set<string>();
    for (const line of objects.split('\n')) {
        const [sha, file] = line.split(' ');
        if (file) { pathsEver.add(file); }
        if (sha && file && TEXT_FILE.test(file) && !file.endsWith('package-lock.json')) { blobs.add(sha); }
    }
    const batch = execFileSync('git', ['-C', upstream, 'cat-file', '--batch'], { input: [...blobs].join('\n') + '\n', maxBuffer: 512 << 20 });
    const lines = new Set<string>();
    let pos = 0;
    while (pos < batch.length) {
        const headerEnd = batch.indexOf(0x0a, pos);
        const [, type, size] = batch.subarray(pos, headerEnd).toString('utf8').split(' ');
        const start = headerEnd + 1;
        const end = start + Number(size);
        if (type === 'blob') {
            for (const l of batch.subarray(start, end).toString('utf8').split(/\r?\n/)) {
                const t = l.trim();
                if (!isTrivial(t)) { lines.add(t); }
            }
        }
        pos = end + 1;
    }
    return lines;
}

interface AnyReport { file: string; lines: number; anyShared: string[]; hasMsLine: boolean }

function main(): void {
    const args = process.argv.slice(2);
    const gate = args.includes('--gate');
    const linesOf = args.includes('--lines') ? args[args.indexOf('--lines') + 1] : undefined;
    // --at REV measures the files as they were at a revision instead of the working tree.
    const at = args.includes('--at') ? args[args.indexOf('--at') + 1] : undefined;
    const root = repoRoot();
    const readOurs = (file: string): string => at
        ? execFileSync('git', ['-C', root, 'show', `${at}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
        : fs.readFileSync(path.join(root, file), 'utf8');
    const upstream = upstreamCheckout();
    // Every path that existed in DebugMCP at any commit up to the pinned one.
    const pathsEver = new Set<string>();
    const history = upstreamHistoryLines(upstream, pathsEver);
    const tracked = at
        ? execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', at], { encoding: 'utf8' }).split('\n').filter(Boolean)
        : execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
            .split('\n').filter((f) => f && fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());

    const reports: FileReport[] = [];
    const anyReports: AnyReport[] = [];
    for (const file of tracked) {
        if (file.endsWith('package-lock.json') || file.startsWith('docs/provenance/')) { continue; }
        const text = TEXT_FILE.test(file) ? readOurs(file) : '';
        const ours = significantText(text);
        const hasMsLine = text.includes(MS_LINE);
        if (text.length > 0 && !file.endsWith('.snapshot.json') && !file.startsWith('docs/proposals/')) {
            anyReports.push({ file, lines: ours.length, anyShared: [...new Set(ours.filter((l) => history.has(l)))], hasMsLine });
        }
        const theirs = counterpart(file, upstream);
        if (!theirs) { continue; }
        const shared = sharedInOrder(ours, significantLines(path.join(upstream, theirs)));
        if (shared.length === 0 && !linesOf) { continue; }
        reports.push({ file, upstream: theirs, lines: ours.length, shared: shared.length, sharedLines: shared, hasMsLine });
    }

    if (linesOf) {
        const report = reports.find((r) => r.file === linesOf);
        const any = anyReports.find((r) => r.file === linesOf);
        if (report) {
            console.log(`${report.file} ↔ DebugMCP ${report.upstream} at ${UPSTREAM_SHA}: ${report.shared} shared line(s), in order`);
            for (const line of report.sharedLines) { console.log(`  ${line}`); }
        }
        if (any) {
            console.log(`${any.file}: ${any.anyShared.length} line(s) found anywhere in DebugMCP's history`);
            for (const line of any.anyShared) { console.log(`  ${line}`); }
        }
        if (!report && !any) { console.log(`${linesOf}: nothing shared with DebugMCP`); }
        return;
    }

    reports.sort((x, y) => y.shared / Math.max(y.lines, 1) - x.shared / Math.max(x.lines, 1));
    console.log(`DebugMCP ${UPSTREAM_SHA}: shared non-trivial lines per file with a counterpart (in order, trimmed)\n`);
    console.log(`${'file'.padEnd(58)} ${'lines'.padStart(6)} ${'shared'.padStart(7)} ${'%'.padStart(6)}  MS line`);
    let totalLines = 0;
    let totalShared = 0;
    for (const r of reports) {
        totalLines += r.lines;
        totalShared += r.shared;
        const pct = (100 * r.shared / Math.max(r.lines, 1)).toFixed(1);
        console.log(`${r.file.padEnd(58)} ${String(r.lines).padStart(6)} ${String(r.shared).padStart(7)} ${pct.padStart(6)}  ${r.hasMsLine ? 'yes' : '-'}`);
    }
    console.log(`\n${reports.length} file(s), ${totalShared} of ${totalLines} non-trivial lines shared`);

    const withHistory = anyReports.filter((r) => r.anyShared.length > 0).sort((x, y) => y.anyShared.length - x.anyShared.length);
    console.log(`\nFiles with lines found anywhere in DebugMCP's history (${history.size} distinct upstream lines, all commits to ${UPSTREAM_SHA}):\n`);
    for (const r of withHistory) {
        console.log(`${r.file.padEnd(58)} ${String(r.lines).padStart(6)} ${String(r.anyShared.length).padStart(7)}  ${r.hasMsLine ? 'MS line' : ''}`);
    }

    if (gate) {
        // Gated: files whose path exists or existed in DebugMCP (or is mapped to one), and every
        // file created since the rewrite began (an implementer may split a file into new modules).
        const atBase = new Set(execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', REWRITE_BASE], { encoding: 'utf8' }).split('\n'));
        const exempt = anyReports.filter((r) => GATE_EXEMPT[r.file] !== undefined && r.anyShared.length > 0);
        const descends = (file: string): boolean => counterpart(file, upstream) !== undefined
            || pathsEver.has(file) || (RENAMED[file] !== undefined && pathsEver.has(RENAMED[file]));
        const gated = anyReports.filter((r) => !r.hasMsLine && GATE_EXEMPT[r.file] === undefined
            && (descends(r.file) || !atBase.has(r.file)));
        if (exempt.length > 0) {
            console.log('\nNot gated, with the reason:');
            for (const r of exempt) { console.log(`  ${r.file} (${r.anyShared.length}): ${GATE_EXEMPT[r.file]}`); }
        }
        const offenders = gated.filter((r) => r.anyShared.length > GATE_MAX_SHARED);
        if (offenders.length > 0) {
            console.log(`\nGATE FAILED: ${offenders.length} file(s) without the Microsoft line contain more than ${GATE_MAX_SHARED} lines found in DebugMCP's history:`);
            for (const r of offenders) { console.log(`  ${r.file} (${r.anyShared.length})`); }
            process.exit(1);
        }
        console.log(`\ngate passed: ${gated.length} gated file(s) (paths DebugMCP ever had, and files new since ${REWRITE_BASE}) each contain at most ${GATE_MAX_SHARED} lines found in DebugMCP's history`);
    }
}

main();
