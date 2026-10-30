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
 * The parts of the window's problem journal (#48) that need VS Code:
 *
 * - `registerProblemJournal`, at activation: every record at warning or above
 *   is mirrored into the output channel as `[problem #N] …`, at debug level
 *   so that it shows only when the channel's level is Debug; `logger.error`
 *   entries are journaled (source `extension`, the same message at most once
 *   a minute); and the command "Copy Recent Problems" puts this window's last
 *   50 warnings and errors on the clipboard, for a bug report.
 * - `attachJobJournal`: a failed CMSIS job is `TASK_FAILED` (source `build`
 *   for a build, `task` otherwise), and the error lines of a failed build
 *   (#15) follow as `BUILD_ERROR` records with a workspace-relative file.
 * - `syncProblemsPanel`: the errors of the Problems panel, read when asked
 *   (by `get_recent_problems` and after a failed build) and compared with the
 *   last reading, so each is journaled once. IntelliSense sources are left
 *   out: they reflect its configuration, not the build.
 *
 * The debug adapter tracker, the serial controller and `notify.ts` append to
 * the journal themselves.
 */

import * as vscode from 'vscode';
import type { CmsisJobTracker } from './cmsisJobTracker';
import { isBuildAction, type Job } from './core/cmsisTasks';
import { formatProblemLine, problemJournal, type ProblemInput, type ProblemJournal, type ProblemRecord } from './core/problemJournal';
import { shortenPath } from './core/textBudget';
import { logger, type ErrorSink } from './utils/logger';

const PRODUCT = 'CMSIS Developer Assistant';
const EXTENSION_ID = 'arm.cmsis-developer-assistant';
/** The origin of this extension's own records. */
const OWN_ORIGIN = 'cmsis-developer-assistant';
/** The command that copies the recent problems. */
export const COPY_RECENT_PROBLEMS_COMMAND = 'cmsis-developer-assistant.copyRecentProblems';
/** Records the command copies at most. */
const COPY_LIMIT = 50;
/** The same `logger.error` message is journaled at most once per this interval. */
const SINK_INTERVAL_MS = 60_000;
/** Messages the rate limit remembers before it forgets the stale ones. */
const SINK_KEYS_KEPT = 200;
/** Problems-panel entries journaled per reading at most; the rest follow at the next one. */
const PANEL_SYNC_MAX = 20;
/** Diagnostic sources of the C/C++ IntelliSense engines, compared in lower case. */
const INTELLISENSE_SOURCES: ReadonlySet<string> = new Set(['c/c++', 'cpptools', 'clangd']);
/** `vscode.DiagnosticSeverity.Error`, as a number, so no enum is read where the API is stubbed. */
const DIAGNOSTIC_ERROR = 0;
/** Build messages journaled per failed build at most; a last record counts the rest. */
const BUILD_MESSAGES_MAX = 20;

function workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

// ── Output channel, logger sink, copy command ───────────────────────────────

/** `logger.error` entries as journal records, each message at most once per minute. */
function errorSink(journal: ProblemJournal, clock: () => number): ErrorSink {
    const lastAt = new Map<string, number>();
    return (message, detail) => {
        const now = clock();
        const previous = lastAt.get(message);
        if (previous !== undefined && now - previous < SINK_INTERVAL_MS) {
            return;
        }
        if (lastAt.size >= SINK_KEYS_KEPT) {
            for (const [key, at] of lastAt) {
                if (now - at >= SINK_INTERVAL_MS) {
                    lastAt.delete(key);
                }
            }
        }
        lastAt.set(message, now);
        const cause = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : undefined;
        journal.append({ source: 'extension', origin: OWN_ORIGIN, severity: 'error', message: cause ? `${message}: ${cause}` : message });
    };
}

/** The text "Copy Recent Problems" puts on the clipboard, and how many records it holds. */
export function recentProblemsText(journal: ProblemJournal, about: { vscodeVersion?: string; extensionVersion?: string } = {}): { text: string; count: number } {
    const page = journal.query({ minSeverity: 'warning', limit: COPY_LIMIT });
    const versions = [
        about.extensionVersion ? `${PRODUCT} ${about.extensionVersion}` : PRODUCT,
        about.vscodeVersion ? `VS Code ${about.vscodeVersion}` : undefined,
    ].filter((part) => part !== undefined).join(', ');
    const header = `Problems recorded in this VS Code window (${versions}), warnings and errors, oldest first:`;
    const lines = page.records.map((record) => formatProblemLine(record, { time: true, seq: true, origin: true }));
    const body = lines.length > 0 ? lines : ['(none)'];
    const left = page.omitted > 0 ? [`… ${page.omitted} older records left out.`] : [];
    return { text: [header, ...left, ...body].join('\n'), count: lines.length };
}

async function copyRecentProblems(journal: ProblemJournal): Promise<void> {
    const version: unknown = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version;
    const { text, count } = recentProblemsText(journal, {
        vscodeVersion: vscode.version,
        extensionVersion: typeof version === 'string' ? version : undefined,
    });
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(count === 0
        ? `${PRODUCT}: no warnings or errors are recorded in this window; the note saying so is on the clipboard.`
        : `${PRODUCT}: ${count} recent problem${count === 1 ? '' : 's'} of this window copied to the clipboard.`);
}

/**
 * One journal record in the output channel: a warning or an error as a
 * debug-level `[problem #N] …` line, which shows only when the channel's
 * level is Debug. Records of the logger's own errors are in the channel
 * already, and `info` records are not mirrored.
 */
export function mirrorProblem(record: ProblemRecord): void {
    if (record.severity !== 'info' && record.source !== 'extension') {
        logger.problem(`[problem #${record.seq}] ${formatProblemLine(record, { seq: false, origin: true })}`);
    }
}

/**
 * At activation: the output-channel mirror, the `logger.error` sink and the
 * copy command, all for `journal` (the window's).
 */
export function registerProblemJournal(context: vscode.ExtensionContext, journal: ProblemJournal = problemJournal()): void {
    const mirror = journal.onDidAppend(mirrorProblem);
    logger.setErrorSink(errorSink(journal, () => Date.now()));
    context.subscriptions.push(
        mirror,
        { dispose: () => logger.setErrorSink(undefined) },
        vscode.commands.registerCommand(COPY_RECENT_PROBLEMS_COMMAND, () => copyRecentProblems(journal)),
    );
}

// ── The Problems panel ──────────────────────────────────────────────────────

/** A reading of the panel: each file with its diagnostics. */
export type DiagnosticsReading = ReadonlyArray<readonly [vscode.Uri, readonly vscode.Diagnostic[]]>;

/** The panel's diagnostics, or none where the API is missing (the transport stubs). */
function readProblemsPanel(): DiagnosticsReading {
    const languages: Partial<typeof vscode.languages> | undefined = vscode.languages;
    return typeof languages?.getDiagnostics === 'function' ? languages.getDiagnostics() : [];
}

/** The entries of the panel each journal has already recorded, by file, line and message. */
const panelSeen = new WeakMap<ProblemJournal, Set<string>>();

function diagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
    if (typeof code === 'string' || typeof code === 'number') {
        return String(code);
    }
    return code && (typeof code.value === 'string' || typeof code.value === 'number') ? String(code.value) : undefined;
}

/**
 * Journals the Problems panel's errors that are new since the last reading,
 * at most 20, IntelliSense left out; the rest wait for the next reading.
 * Returns how many were journaled. Never throws.
 */
export function syncProblemsPanel(journal: ProblemJournal, read: () => DiagnosticsReading = readProblemsPanel): number {
    let reading: DiagnosticsReading;
    try {
        reading = read();
    } catch (caught) {
        logger.warn('The Problems panel could not be read for the problem journal', caught);
        return 0;
    }
    const seen = panelSeen.get(journal) ?? new Set<string>();
    const current = new Set<string>();
    const roots = workspaceRoots();
    let added = 0;
    for (const [uri, diagnostics] of reading) {
        for (const diagnostic of diagnostics) {
            const source = diagnostic.source ?? '';
            if (diagnostic.severity !== DIAGNOSTIC_ERROR || INTELLISENSE_SOURCES.has(source.toLowerCase())) {
                continue;
            }
            const key = [uri.toString(), diagnostic.range.start.line, diagnostic.message].join('\u0000');
            if (seen.has(key)) {
                current.add(key);
                continue;
            }
            if (added >= PANEL_SYNC_MAX) {
                continue;
            }
            const code = diagnosticCode(diagnostic.code);
            journal.append({
                source: 'problems',
                origin: source || 'Problems panel',
                severity: 'error',
                message: code ? `${diagnostic.message} [${code}]` : diagnostic.message,
                location: { file: shortenPath(uri.fsPath, roots), line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1 },
            });
            current.add(key);
            added += 1;
        }
    }
    panelSeen.set(journal, current);
    return added;
}

// ── CMSIS jobs ──────────────────────────────────────────────────────────────

/** A failed CMSIS job as a `TASK_FAILED` record; undefined for a job that did not fail. */
export function failedJobProblem(job: Job): ProblemInput | undefined {
    const decided = job.executions.find((execution) => execution.key === job.decidedBy);
    if (job.state !== 'failed' || !decided) {
        return undefined;
    }
    const ended = decided.exitCode !== undefined ? `exited with code ${decided.exitCode}` : 'ended without an exit code';
    return {
        source: isBuildAction(job.action) ? 'build' : 'task',
        origin: decided.name,
        severity: 'error',
        code: 'TASK_FAILED',
        message: `'${decided.name}' ${ended}${job.target ? ` on ${job.target}` : ''} (job ${job.id})`,
        hint: isBuildAction(job.action)
            ? 'cmsis_action {action:\'status\'} shows its error lines.'
            : 'cmsis_action {action:\'status\'} shows the job; flash answers with pyOCD\'s own error lines.',
    };
}

/**
 * The error and warning lines of a failed build's diagnosis (#15) as
 * records: errors first, at most 20, files relative to `roots`, and one
 * record that counts the lines left out.
 */
export function buildMessageProblems(job: Job, roots: readonly string[]): ProblemInput[] {
    const diagnosis = job.diagnosis;
    if (!diagnosis || diagnosis.state !== 'done') {
        return [];
    }
    const origin = job.executions.find((execution) => execution.key === job.decidedBy)?.name ?? 'build';
    const chosen = [...diagnosis.errors, ...diagnosis.warnings].slice(0, BUILD_MESSAGES_MAX);
    const problems: ProblemInput[] = chosen.map((line) => ({
        source: 'build',
        origin: line.context ?? origin,
        severity: line.severity,
        ...(line.severity === 'error' ? { code: 'BUILD_ERROR' as const } : {}),
        message: line.code && line.code !== 'csolution' ? `${line.message} [${line.code}]` : line.message,
        ...(line.file ? {
            location: {
                file: shortenPath(line.file, roots),
                ...(line.line !== undefined ? { line: line.line } : {}),
                ...(line.column !== undefined ? { column: line.column } : {}),
            },
        } : {}),
    }));
    const left = diagnosis.errorCount + diagnosis.warningCount - problems.length;
    if (left > 0) {
        problems.push({
            source: 'build', origin, severity: 'warning', message: `${left} more build message${left === 1 ? '' : 's'} not journaled`,
            hint: 'cmsis_action {action:\'status\'} or get_build_diagnostics lists them.',
        });
    }
    return problems;
}

/**
 * Journals the failed jobs of `tracker` and the error lines of its failed
 * builds into `journal`; after a failed build the Problems panel is read too.
 */
export function attachJobJournal(
    tracker: CmsisJobTracker,
    journal: ProblemJournal,
    roots: () => readonly string[] = workspaceRoots,
): { dispose(): void } {
    const finished = tracker.onDidFinishJob((job) => {
        const failed = failedJobProblem(job);
        if (!failed) {
            return;
        }
        journal.append(failed);
        if (isBuildAction(job.action)) {
            syncProblemsPanel(journal);
        }
    });
    const diagnosed = tracker.onDidDiagnoseJob((job) => {
        // A build whose task exited 0 looked fine when it finished; its check found it failed (CMSIS Solution reports 0 for a failed build).
        const failedOnCheck = job.diagnosis?.check === 'failed' ? failedJobProblem(job) : undefined;
        if (failedOnCheck) {
            journal.append({ ...failedOnCheck, message: `${failedOnCheck.message}, but the build failed` });
        }
        for (const problem of buildMessageProblems(job, roots())) {
            journal.append(problem);
        }
    });
    return {
        dispose: () => {
            finished.dispose();
            diagnosed.dispose();
        },
    };
}
