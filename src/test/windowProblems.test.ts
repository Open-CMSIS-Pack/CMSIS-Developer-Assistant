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

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import type { CmsisJobTracker } from '../cmsisJobTracker';
import type { BuildMessage, Job, JobDiagnosis } from '../core/cmsisTasks';
import { ProblemJournal } from '../core/problemJournal';
import {
    DiagnosticsReading,
    attachJobJournal,
    buildMessageProblems,
    failedJobProblem,
    recentProblemsText,
    syncProblemsPanel,
} from '../windowProblems';

const ROOT = path.resolve('/work/blinky');

function job(fields: Partial<Job>): Job {
    return {
        id: 'b-1', action: 'build', origin: 'call', armedAt: 0, state: 'failed', settledAt: 10, decidedBy: 1, preexisting: [], notes: [],
        executions: [{ key: 1, name: 'cbuild blinky.csolution.yml --active HE', kind: 'build', role: 'main', startedAt: 1, exitCode: 2 }],
        ...fields,
    };
}

function diagnosis(errors: BuildMessage[], warnings: BuildMessage[], counts?: { errors: number; warnings: number }): JobDiagnosis {
    return {
        state: 'done', source: 'rerun', errors, warnings,
        errorCount: counts?.errors ?? errors.length, warningCount: counts?.warnings ?? warnings.length, text: '',
    };
}

const UNDECLARED: BuildMessage = {
    severity: 'error', file: path.join(ROOT, 'src', 'main.c'), line: 42, column: 5, message: '\'x\' undeclared', context: '.Debug+HE',
};
const UNUSED: BuildMessage = {
    severity: 'warning', file: path.join(ROOT, 'src', 'main.c'), line: 7, message: 'unused variable \'y\'', code: '-Wunused-variable',
};

/**
 * The sources of the problem journal (#48) that need VS Code: failed CMSIS
 * jobs and the error lines of a failed build, the Problems panel, and the
 * text "Copy Recent Problems" puts on the clipboard.
 */
suite('Window problem sources', () => {
    test('a failed job is TASK_FAILED: source build for a build, task otherwise; other outcomes are no problem', () => {
        assert.deepStrictEqual(failedJobProblem(job({ target: 'HE' })), {
            source: 'build', origin: 'cbuild blinky.csolution.yml --active HE', severity: 'error', code: 'TASK_FAILED',
            message: '\'cbuild blinky.csolution.yml --active HE\' exited with code 2 on HE (job b-1)',
            hint: 'cmsis_action {action:\'status\'} shows its error lines.',
        });
        const load = failedJobProblem(job({
            id: 'l-2', action: 'load', decidedBy: 4,
            executions: [{ key: 4, name: 'CMSIS Load', kind: 'load', role: 'main', startedAt: 1, exitCode: 1 }],
        }));
        assert.deepStrictEqual([load?.source, load?.message], ['task', '\'CMSIS Load\' exited with code 1 (job l-2)']);
        assert.strictEqual(failedJobProblem(job({ state: 'ok' })), undefined);
        assert.strictEqual(failedJobProblem(job({ state: 'cancelled' })), undefined);
        assert.strictEqual(failedJobProblem(job({ decidedBy: undefined })), undefined);
        const rebuild = failedJobProblem(job({
            id: 'rb-3', action: 'rebuild',
            executions: [{ key: 1, name: 'cbuild blinky.csolution.yml --rebuild --active HE', kind: 'rebuild', role: 'main', startedAt: 1, exitCode: 2 }],
        }));
        assert.deepStrictEqual([rebuild?.source, rebuild?.hint], ['build', 'cmsis_action {action:\'status\'} shows its error lines.'],
            'a rebuild is a build');
    });

    test('the error lines of a failed build are BUILD_ERROR records with a workspace-relative file; warnings carry no code', () => {
        const problems = buildMessageProblems(job({ diagnosis: diagnosis([UNDECLARED], [UNUSED]) }), [ROOT]);
        assert.deepStrictEqual(problems, [
            {
                source: 'build', origin: '.Debug+HE', severity: 'error', code: 'BUILD_ERROR', message: '\'x\' undeclared',
                location: { file: path.join('src', 'main.c'), line: 42, column: 5 },
            },
            {
                source: 'build', origin: 'cbuild blinky.csolution.yml --active HE', severity: 'warning', message: 'unused variable \'y\' [-Wunused-variable]',
                location: { file: path.join('src', 'main.c'), line: 7 },
            },
        ]);
        assert.deepStrictEqual(buildMessageProblems(job({}), [ROOT]), [], 'no diagnosis yet');
        assert.deepStrictEqual(buildMessageProblems(job({ diagnosis: { ...diagnosis([], []), state: 'pending' } }), [ROOT]), []);
    });

    test('at most 20 build lines are journaled, errors first; one more record counts the rest', () => {
        const errors = Array.from({ length: 25 }, (_, index) => ({ ...UNDECLARED, line: index + 1 }));
        const problems = buildMessageProblems(job({ diagnosis: diagnosis(errors, [UNUSED], { errors: 240, warnings: 3 }) }), [ROOT]);
        assert.strictEqual(problems.length, 21);
        assert.ok(problems.slice(0, 20).every((problem) => problem.code === 'BUILD_ERROR'));
        assert.deepStrictEqual([problems[20].severity, problems[20].message], ['warning', '223 more build messages not journaled']);
    });

    test('the job journal follows a tracker: a failed job when it settles, the build lines when they arrive, nothing after dispose', () => {
        const finished = new Set<(job: Job) => void>();
        const diagnosed = new Set<(job: Job) => void>();
        const tracker = {
            onDidFinishJob: (listener: (job: Job) => void) => { finished.add(listener); return { dispose: () => finished.delete(listener) }; },
            onDidDiagnoseJob: (listener: (job: Job) => void) => { diagnosed.add(listener); return { dispose: () => diagnosed.delete(listener) }; },
        } as unknown as CmsisJobTracker;
        const journal = new ProblemJournal();
        const link = attachJobJournal(tracker, journal, () => [ROOT]);
        finished.forEach((listener) => listener(job({ action: 'load', executions: [{ key: 1, name: 'CMSIS Load', kind: 'load', startedAt: 1, exitCode: 1 }] })));
        finished.forEach((listener) => listener(job({ state: 'ok' })));
        diagnosed.forEach((listener) => listener(job({ diagnosis: diagnosis([UNDECLARED], []) })));
        assert.deepStrictEqual(journal.query().records.map((record) => [record.source, record.code]), [['task', 'TASK_FAILED'], ['build', 'BUILD_ERROR']]);
        link.dispose();
        assert.deepStrictEqual([finished.size, diagnosed.size], [0, 0]);
    });

    test('a build that exited 0 but failed its check is journaled as TASK_FAILED when the check comes in', () => {
        const diagnosed = new Set<(job: Job) => void>();
        const tracker = {
            onDidFinishJob: () => ({ dispose: () => undefined }),
            onDidDiagnoseJob: (listener: (job: Job) => void) => { diagnosed.add(listener); return { dispose: () => diagnosed.delete(listener) }; },
        } as unknown as CmsisJobTracker;
        const journal = new ProblemJournal();
        attachJobJournal(tracker, journal, () => [ROOT]);
        const exitedZero = job({ state: 'failed', executions: [{ key: 1, name: 'cbuild blinky.csolution.yml', kind: 'build', startedAt: 1, exitCode: 0 }] });
        diagnosed.forEach((listener) => listener({ ...exitedZero, diagnosis: { ...diagnosis([UNDECLARED], []), check: 'failed' } }));
        const records = journal.query().records;
        assert.deepStrictEqual(records.map((record) => [record.source, record.code]), [['build', 'TASK_FAILED'], ['build', 'BUILD_ERROR']]);
        assert.match(records[0].message, /exited with code 0 .*but the build failed$/);
    });

    suite('the Problems panel', () => {
        const uri = vscode.Uri.file(path.join(ROOT, 'blinky.csolution.yml'));
        const at = (line: number, message: string, severity = vscode.DiagnosticSeverity.Error, source?: string): vscode.Diagnostic => {
            const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 2, line, 9), message, severity);
            diagnostic.source = source;
            return diagnostic;
        };

        test('errors are journaled once each, with the diagnostic source as origin; IntelliSense and lighter entries are left out', () => {
            const journal = new ProblemJournal();
            let reading: DiagnosticsReading = [[uri, [
                at(3, 'pack not found', vscode.DiagnosticSeverity.Error, 'csolution'),
                at(4, 'unknown key', vscode.DiagnosticSeverity.Warning, 'csolution'),
                at(5, 'identifier "uint32_t" is undefined', vscode.DiagnosticSeverity.Error, 'C/C++'),
                at(6, 'no member named x', vscode.DiagnosticSeverity.Error, 'clangd'),
            ]]];
            assert.strictEqual(syncProblemsPanel(journal, () => reading), 1);
            const [record] = journal.query().records;
            assert.deepStrictEqual([record.source, record.origin, record.severity, record.message, record.location?.line, record.location?.column],
                ['problems', 'csolution', 'error', 'pack not found', 4, 3]);
            assert.strictEqual(syncProblemsPanel(journal, () => reading), 0, 'the same reading adds nothing');
            reading = [];
            syncProblemsPanel(journal, () => reading);
            reading = [[uri, [at(3, 'pack not found', vscode.DiagnosticSeverity.Error, 'csolution')]]];
            assert.strictEqual(syncProblemsPanel(journal, () => reading), 1, 'an error that went away and came back is new again');
        });

        test('at most 20 new entries per reading; the rest follow at the next one; a failing read journals nothing', () => {
            const journal = new ProblemJournal();
            const reading: DiagnosticsReading = [[uri, Array.from({ length: 25 }, (_, index) => at(index, `error ${index}`))]];
            assert.strictEqual(syncProblemsPanel(journal, () => reading), 20);
            assert.strictEqual(syncProblemsPanel(journal, () => reading), 5);
            assert.strictEqual(syncProblemsPanel(journal, () => { throw new Error('no panel'); }), 0);
            assert.strictEqual(journal.size, 25);
        });
    });

    test('the copied text has a header and one line per warning or error, with time and origin', () => {
        const journal = new ProblemJournal(() => Date.UTC(2026, 8, 24, 10, 42, 7));
        journal.append({ source: 'dap', origin: 'CMSIS Debugger: pyOCD', severity: 'info', message: 'banner' });
        journal.append({ source: 'gdb-server', origin: 'CMSIS Debugger: pyOCD', severity: 'error', code: 'DAP_POWER_UP_FAILED', message: 'Failed to power up DAP' });
        assert.deepStrictEqual(recentProblemsText(journal, { vscodeVersion: '1.109.0', extensionVersion: '2.5.1' }), {
            text: 'Problems recorded in this VS Code window (CMSIS Developer Assistant 2.5.1, VS Code 1.109.0), warnings and errors, oldest first:\n'
                + '2026-09-24T10:42:07.000Z #2 error gdb-server (CMSIS Debugger: pyOCD) [DAP_POWER_UP_FAILED] Failed to power up DAP',
            count: 1,
        });
        assert.ok(recentProblemsText(new ProblemJournal()).text.endsWith('\n(none)'));
    });
});
