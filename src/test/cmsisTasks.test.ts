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

import * as assert from 'assert';
import {
    armJob,
    BUILD_STOPPED_EXIT_CODE,
    bystanders,
    classifyByLabelLoosely,
    classifyCmsisTask,
    CmsisTaskKind,
    executionIn,
    GuardedAction,
    guardProbe,
    hasCmsisTasks,
    isBuildAction,
    Job,
    JobEvent,
    nextTimeCheck,
    NOTHING_STARTED_MS,
    ProbeOwner,
    reduceJob,
    RUN_GRACE_MS,
    settleJob,
    TaskFacts,
} from '../core/cmsisTasks';
import { loadTaskFixtures, replayThroughReducer } from './cmsisTaskFixtures';

/**
 * The task classifier, the job state machine and the probe guard of #47 and
 * #46, without VS Code. The state machine is replayed over the task
 * sequences derived from CMSIS Solution 1.70.1 and 1.72.0 in
 * src/test/fixtures/cmsisTasks.
 */

const fold = (job: Job, ...events: JobEvent[]): Job => events.reduce(reduceJob, job);
const armed = (action: Job['action'], preexisting: number[] = []): Job => armJob({ id: 'j-1', action, origin: 'call', at: 0, preexisting });
const start = (key: number, name: string, kind: CmsisTaskKind, at: number, type: 'taskStart' | 'processStart' = 'processStart'): JobEvent =>
    ({ type, key, name, kind, at });

suite('cmsisTasks', () => {

    suite('classifyCmsisTask', () => {
        const cases: Array<[string, TaskFacts, CmsisTaskKind | undefined]> = [
            // The regression of 2.3.10 (KB5): the haystack was only partly lower-cased and matched case-sensitively.
            ['"CMSIS Load" from tasks.json as a shell task', { name: 'CMSIS Load', source: 'Workspace', type: 'shell' }, 'load'],
            ['CMSIS Run', { name: 'CMSIS Run', source: 'Workspace', type: 'shell' }, 'run'],
            ['the compound Load+Run', { name: 'CMSIS Load+Run', source: 'Workspace', type: '$composite' }, 'loadRun'],
            ['CMSIS Erase', { name: 'CMSIS Erase', source: 'Workspace', type: 'shell' }, 'erase'],
            ['CMSIS TargetInfo', { name: 'CMSIS TargetInfo', source: 'Workspace', type: 'shell' }, 'targetInfo'],
            ['the TargetInfo fallback task', { name: 'Target Information', source: 'CMSIS', type: 'shell' }, 'targetInfo'],
            ['the Arm Debugger flash task', { name: 'CMSIS Load+Run', source: 'Workspace', type: 'arm-debugger.flash' }, 'loadRun'],
            ['the Arm Debugger flash task from its provider', { name: 'CMSIS Load+Run', source: 'Arm Debugger', type: 'arm-debugger.flash' }, 'loadRun'],
            ['a cbuild build', { name: 'cbuild Blinky.csolution.yml --active MPS3 --schema', source: 'cmsis-csolution.build', type: 'cmsis-csolution.build' }, 'build'],
            ['cbuild setup is setup, never build',
                { name: 'cbuild setup Blinky.csolution.yml --active MPS3 --skip-convert', source: 'cmsis-csolution.build', type: 'cmsis-csolution.build', setup: true },
                'setup'],
            ['the Rebuild command\'s task (rebuild: true) is a rebuild',
                { name: 'cbuild Blinky.csolution.yml --target all --rebuild --active MPS3', source: 'cmsis-csolution.build', type: 'cmsis-csolution.build', rebuild: true },
                'rebuild'],
            ['the Clean command\'s task (clean: true, no --active) is a clean',
                { name: 'cbuild Blinky.csolution.yml --clean --target all', source: 'cmsis-csolution.build', type: 'cmsis-csolution.build', clean: true },
                'clean'],
            ['setup wins over the clean and rebuild flags (CMSIS Solution never sets two of them)',
                { name: 'cbuild setup Blinky.csolution.yml', source: 'cmsis-csolution.build', type: 'cmsis-csolution.build', setup: true, clean: true, rebuild: true },
                'setup'],
            ['a task provided from the Run Task menu (rebuild: false) is a build',
                { name: 'cbuild ${command:cmsis-csolution.getSolutionFile} --active ""', source: 'cmsis-csolution.build', type: 'cmsis-csolution.build', rebuild: false },
                'build'],
            ['a label in lower case is not exact', { name: 'cmsis load', source: 'Workspace', type: 'shell' }, undefined],
            ['a CMSIS label from another source', { name: 'CMSIS Load', source: 'User', type: 'shell' }, undefined],
            ['an unrelated task', { name: 'npm: build', source: 'npm', type: 'npm' }, undefined],
            ['another task type named like a build', { name: 'cbuild Blinky.csolution.yml', source: 'Workspace', type: 'shell' }, undefined],
        ];
        for (const [label, facts, kind] of cases) {
            test(label, () => assert.strictEqual(classifyCmsisTask(facts), kind));
        }

        test('the loose label match is a separate fallback: any case, spacing or source', () => {
            assert.strictEqual(classifyByLabelLoosely({ name: 'cmsis load', source: 'Workspace' }), 'load');
            assert.strictEqual(classifyByLabelLoosely({ name: ' CMSIS   Load+Run ', source: 'User' }), 'loadRun');
            assert.strictEqual(classifyByLabelLoosely({ name: 'cbuild demo', source: 'cmsis-csolution.build' }), undefined);
        });
    });

    suite('reduceJob replays the task sequences of CMSIS Solution 1.70.1', () => {
        const fixtures = loadTaskFixtures();
        test('the fixture set covers build, rebuild, clean, a stopped build, load, erase, the three Load+Run shapes, load_and_debug and stop_run', () => {
            assert.deepStrictEqual(fixtures.map((fixture) => fixture.file), [
                'build-failed.json', 'build-ok.json', 'build-stopped.json', 'build-with-setup.json', 'clean-ok.json', 'erase-failed.json',
                'load-and-debug-pyocd.json', 'load-and-run-arm-debugger.json', 'load-and-run-load-failed.json', 'load-and-run-pyocd.json',
                'load-ok.json', 'rebuild-ok.json', 'stop-run.json',
            ]);
        });
        for (const fixture of fixtures) {
            test(fixture.file, () => {
                const { job, keys } = replayThroughReducer(fixture);
                assert.strictEqual(job.state, fixture.expect.state, fixture.description);
                if (fixture.expect.decidedBy) {
                    assert.strictEqual(job.decidedBy, keys.get(fixture.expect.decidedBy));
                }
                const decided = job.executions.find((execution) => execution.key === job.decidedBy);
                if (fixture.expect.exitCode !== undefined) {
                    assert.strictEqual(decided?.exitCode, fixture.expect.exitCode);
                }
                const noted = bystanders(job).map((execution) => [...keys].find(([, key]) => key === execution.key)?.[0]);
                assert.deepStrictEqual(noted, fixture.expect.bystanders ?? []);
                for (const name of fixture.expect.endedAfterStop ?? []) {
                    const execution = job.executions.find((candidate) => candidate.key === keys.get(name));
                    assert.ok(execution?.endedAt !== undefined, `${name} recorded its end`);
                }
            });
        }
    });

    suite('reduceJob rules', () => {
        test('an execution alive when the job was armed never completes it', () => {
            const job = fold(armed('build', [7]),
                { type: 'issued', at: 10 },
                start(7, 'cbuild other', 'build', 20),
                { type: 'processEnd', key: 7, exitCode: 0, at: 30 });
            assert.strictEqual(job.state, 'armed');
            assert.deepStrictEqual(job.executions, []);
        });

        test('the build the command returned is the build, even when another one started first', () => {
            const job = fold(armed('build'),
                start(1, 'cbuild someone else', 'build', 5),
                start(2, 'cbuild ours', 'build', 6),
                { type: 'identity', key: 2, name: 'cbuild ours', kind: 'build', at: 7 },
                { type: 'processEnd', key: 1, exitCode: 0, at: 8 });
            assert.strictEqual(job.state, 'started', 'the other build ending decides nothing');
            assert.strictEqual(executionIn(job, 'main')?.name, 'cbuild ours');
            assert.deepStrictEqual(bystanders(job).map((execution) => execution.name), ['cbuild someone else']);
            assert.strictEqual(reduceJob(job, { type: 'processEnd', key: 2, exitCode: 2, at: 9 }).state, 'failed');
        });

        test('a returned build that was not seen starting is bound all the same', () => {
            const job = fold(armed('build'), { type: 'identity', key: 4, name: 'cbuild x', kind: 'build', at: 3 },
                { type: 'processEnd', key: 4, exitCode: 0, at: 9 });
            assert.strictEqual(job.state, 'ok');
            assert.strictEqual(job.decidedBy, 4);
        });

        test('a process end without an exit code is cancelled', () => {
            const job = fold(armed('load'), start(1, 'CMSIS Load', 'load', 1), { type: 'processEnd', key: 1, exitCode: undefined, at: 2 });
            assert.strictEqual(job.state, 'cancelled');
        });

        test('a rebuild or a clean binds only its own kind: a build, setup or the other one beside it is noted', () => {
            const rebuild = fold(armed('rebuild'), { type: 'issued', at: 0 },
                start(1, 'cbuild x --active MPS3', 'build', 1), start(2, 'cbuild setup x', 'setup', 2), start(3, 'cbuild x --clean', 'clean', 3),
                start(4, 'cbuild x --rebuild --active MPS3', 'rebuild', 4),
                { type: 'processEnd', key: 1, exitCode: 0, at: 5 }, { type: 'processEnd', key: 3, exitCode: 0, at: 6 });
            assert.strictEqual(rebuild.state, 'started', 'the build and the clean ending decide nothing');
            assert.strictEqual(executionIn(rebuild, 'main')?.key, 4);
            assert.deepStrictEqual(bystanders(rebuild).map((execution) => execution.key), [1, 2, 3]);
            assert.strictEqual(reduceJob(rebuild, { type: 'processEnd', key: 4, exitCode: 2, at: 9 }).state, 'failed');

            const clean = fold(armed('clean'), { type: 'issued', at: 0 }, start(5, 'cbuild x --rebuild', 'rebuild', 1),
                { type: 'identity', key: 6, name: 'cbuild x --clean', kind: 'clean', at: 2 }, { type: 'processEnd', key: 6, exitCode: 0, at: 3 });
            assert.strictEqual(clean.state, 'ok');
            assert.strictEqual(clean.decidedBy, 6);
            const wrongIdentity = fold(armed('clean'), { type: 'identity', key: 7, name: 'cbuild x', kind: 'build', at: 1 });
            assert.strictEqual(executionIn(wrongIdentity, 'main'), undefined, 'a returned build is not a clean');

            const build = fold(armed('build'), { type: 'issued', at: 0 }, start(8, 'cbuild x --clean', 'clean', 1),
                { type: 'processEnd', key: 8, exitCode: 0, at: 2 }, { type: 'tick', at: NOTHING_STARTED_MS });
            assert.strictEqual(build.state, 'not-started', 'a clean never answers for a build');
        });

        test(`a build task that closes with ${BUILD_STOPPED_EXIT_CODE} (Stop Build) is stopped, not failed; a stop request makes any end stopped`, () => {
            const running = fold(armed('build'), { type: 'issued', at: 0 }, start(1, 'cbuild x', 'build', 1));
            const stopped = reduceJob(running, { type: 'processEnd', key: 1, exitCode: BUILD_STOPPED_EXIT_CODE, at: 9 });
            assert.strictEqual(stopped.state, 'cancelled');
            assert.strictEqual(stopped.decidedBy, 1);
            assert.strictEqual(reduceJob(running, { type: 'processEnd', key: 1, exitCode: 2, at: 9 }).state, 'failed');
            const load = fold(armed('load'), start(2, 'CMSIS Load', 'load', 1), { type: 'processEnd', key: 2, exitCode: BUILD_STOPPED_EXIT_CODE, at: 2 });
            assert.strictEqual(load.state, 'failed', 'only build-type tasks close with 130 when stopped');

            const asked = reduceJob(running, { type: 'stopRequested', key: 1, at: 5 });
            assert.strictEqual(asked.state, 'started', 'a stop request alone decides nothing');
            assert.strictEqual(executionIn(asked, 'main')?.stopRequested, true);
            assert.strictEqual(reduceJob(asked, { type: 'processEnd', key: 1, exitCode: 0, at: 9 }).state, 'cancelled',
                'a terminated task may close with 0; it was stopped all the same');
            assert.strictEqual(reduceJob(asked, { type: 'processEnd', key: 1, exitCode: undefined, at: 9 }).state, 'cancelled');
            assert.strictEqual(reduceJob(running, { type: 'stopRequested', key: 42, at: 5 }), running, 'a stop for an execution the job does not know changes nothing');
        });

        test('isBuildAction and hasCmsisTasks', () => {
            assert.deepStrictEqual(['build', 'rebuild', 'clean', 'load', 'stop_build', 'status'].map(isBuildAction), [true, true, true, false, false, false]);
            assert.strictEqual(hasCmsisTasks(new Set(['npm: build', 'CMSIS Load'])), true);
            assert.strictEqual(hasCmsisTasks(new Set(['npm: build', 'cmsis load'])), false);
            assert.strictEqual(hasCmsisTasks(new Set()), false);
        });

        test(`nothing started ${NOTHING_STARTED_MS} ms after the command went out is not-started; the window opens when it is issued`, () => {
            const waiting = fold(armed('load'), { type: 'tick', at: 60_000 });
            assert.strictEqual(waiting.state, 'armed', 'without issued there is no window');
            const issued = fold(armed('load'), { type: 'issued', at: 100 });
            assert.strictEqual(nextTimeCheck(issued), 100 + NOTHING_STARTED_MS);
            assert.strictEqual(reduceJob(issued, { type: 'tick', at: 100 + NOTHING_STARTED_MS - 1 }).state, 'armed');
            const late = reduceJob(issued, { type: 'tick', at: 100 + NOTHING_STARTED_MS });
            assert.strictEqual(late.state, 'not-started');
            assert.strictEqual(late.settledAt, 100 + NOTHING_STARTED_MS);
        });

        test('load_and_debug has no not-started: without a pre-launch Load the session decides', () => {
            const job = fold(armed('load_and_debug'), { type: 'issued', at: 0 }, { type: 'tick', at: 60_000 });
            assert.strictEqual(job.state, 'armed');
            assert.strictEqual(nextTimeCheck(job), undefined);
        });

        test('load_and_run: Run must stay up for the grace; ending inside it fails with its code', () => {
            const flashed = fold(armed('load_and_run'), { type: 'issued', at: 0 },
                start(1, 'CMSIS Load', 'load', 1), { type: 'processEnd', key: 1, exitCode: 0, at: 5 },
                start(2, 'CMSIS Run', 'run', 6));
            assert.strictEqual(flashed.state, 'started');
            assert.strictEqual(nextTimeCheck(flashed), 6 + RUN_GRACE_MS);
            const died = reduceJob(flashed, { type: 'processEnd', key: 2, exitCode: 1, at: 7 });
            assert.strictEqual(died.state, 'failed');
            assert.strictEqual(died.decidedBy, 2);
            const exitedZero = reduceJob(flashed, { type: 'processEnd', key: 2, exitCode: 0, at: 7 });
            assert.strictEqual(exitedZero.state, 'failed', 'a GDB server that exits 0 at once is not running either');
            const stayed = reduceJob(flashed, { type: 'tick', at: 6 + RUN_GRACE_MS });
            assert.strictEqual(stayed.state, 'running-ok');
            assert.strictEqual(reduceJob(stayed, { type: 'processEnd', key: 2, exitCode: 1, at: 99 }).state, 'running-ok',
                'a settled job keeps its state');
        });

        test('run: CMSIS Run alone must stay up for the grace; ending at all fails, even with exit 0 (#73)', () => {
            const started = fold(armed('run'), { type: 'issued', at: 0 }, start(1, 'CMSIS Run', 'run', 3));
            assert.strictEqual(started.state, 'started');
            assert.strictEqual(nextTimeCheck(started), 3 + RUN_GRACE_MS);
            assert.strictEqual(reduceJob(started, { type: 'processEnd', key: 1, exitCode: 0, at: 4 }).state, 'failed');
            assert.strictEqual(reduceJob(started, { type: 'processEnd', key: 1, exitCode: undefined, at: 4 }).state, 'cancelled');
            const up = reduceJob(started, { type: 'tick', at: 3 + RUN_GRACE_MS });
            assert.strictEqual(up.state, 'running-ok');
            assert.strictEqual(up.decidedBy, 1);
            assert.strictEqual(nextTimeCheck(up), undefined);
            const nothing = fold(armed('run'), { type: 'issued', at: 0 }, { type: 'tick', at: NOTHING_STARTED_MS });
            assert.strictEqual(nothing.state, 'not-started');
        });

        test('load_and_run: a compound that ends without a live Run fails', () => {
            const job = fold(armed('load_and_run'), start(1, 'CMSIS Load+Run', 'loadRun', 1, 'taskStart'),
                start(2, 'CMSIS Load', 'load', 2), { type: 'processEnd', key: 2, exitCode: 0, at: 3 },
                { type: 'taskEnd', key: 1, at: 4 });
            assert.strictEqual(job.state, 'failed');
            assert.strictEqual(job.decidedBy, 1);
        });

        test('settleJob settles an open job once and leaves a settled one alone', () => {
            const settled = settleJob(armed('load_and_debug'), 'ok', 5, 'note');
            assert.strictEqual(settled.state, 'ok');
            assert.deepStrictEqual(settled.notes, ['note']);
            assert.strictEqual(settleJob(settled, 'failed', 6), settled);
        });
    });

    suite('guardProbe: the matrix of #46', () => {
        const run: ProbeOwner = { name: 'CMSIS Run', kind: 'run', startedAt: 0 };
        const loadRun: ProbeOwner = { name: 'CMSIS Load+Run', kind: 'loadRun', startedAt: 0 };
        const load: ProbeOwner = { name: 'CMSIS Load', kind: 'load', startedAt: 0 };
        const erase: ProbeOwner = { name: 'CMSIS Erase', kind: 'erase', startedAt: 0 };
        const flash: ProbeOwner = { name: 'flash', kind: 'flash', startedAt: 0 };
        type Cell = 'allowed' | 'server' | 'busy' | 'session';
        const verdict = (action: GuardedAction, owners: ProbeOwner[], session: boolean): Cell => {
            const answer = guardProbe(action, owners, session);
            return answer.allowed ? 'allowed' : answer.reason;
        };
        // Columns: Run alive, Load+Run alive, Load in flight, Erase in flight, flash in flight, debug session.
        const matrix: Array<[GuardedAction, Cell[]]> = [
            ['build', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
            ['rebuild', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
            ['clean', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
            ['stop_build', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
            ['status', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
            ['detach', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
            ['stop_run', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
            ['load', ['server', 'server', 'busy', 'busy', 'busy', 'session']],
            ['erase', ['server', 'server', 'busy', 'busy', 'busy', 'session']],
            ['run', ['server', 'server', 'busy', 'busy', 'busy', 'session']],
            ['load_and_run', ['server', 'server', 'busy', 'busy', 'busy', 'session']],
            ['load_and_debug', ['server', 'server', 'busy', 'busy', 'busy', 'session']],
            ['attach', ['allowed', 'allowed', 'busy', 'busy', 'busy', 'session']],
            ['flash', ['server', 'server', 'busy', 'busy', 'busy', 'session']],
        ];
        for (const [action, row] of matrix) {
            test(action, () => {
                const cells: Cell[] = [
                    verdict(action, [run], false), verdict(action, [loadRun], false), verdict(action, [load], false),
                    verdict(action, [erase], false), verdict(action, [flash], false), verdict(action, [], true),
                ];
                assert.deepStrictEqual(cells, row);
                assert.strictEqual(verdict(action, [], false), 'allowed', 'nothing holds the probe');
            });
        }

        test('the refusal names the GDB server before a transient owner, and a transient owner before the session', () => {
            const both = guardProbe('load', [load, run], true);
            assert.ok(!both.allowed && both.reason === 'server' && both.owner === run);
            const attach = guardProbe('attach', [run, load], true);
            assert.ok(!attach.allowed && attach.reason === 'busy' && attach.owner === load);
        });
    });
});
