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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmsisJobTracker, JOB_RETENTION_MS, LABEL_FETCH_MS } from '../cmsisJobTracker';
import { executionIn, Job, JobDiagnosis } from '../core/cmsisTasks';
import { flashFailedHint, formatDuration, idleStatus, LONG_FLASH_MS, sessionTaskLine, stillRunning, stuckFlashTask } from '../handler/jobText';
import { FakeExecution, FakeTasks, FixtureTask, loadTaskFixtures, ManualClock, workspaceTasks } from './cmsisTaskFixtures';

/**
 * The window's CMSIS job tracker (#47, #46, #12) over a fake `vscode.tasks`
 * and a clock moved by hand: correlation of executions and jobs, adoption,
 * retention, deadlines, probe owners, the stop wait and the label
 * pre-check. The handler's use of it is tested with the handler.
 */

const shell = (name: string): FixtureTask => ({ name, source: 'Workspace', definition: { type: 'shell' } });
const BUILD: FixtureTask = { name: 'cbuild Blinky.csolution.yml --active MPS3', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' } };
const SETUP: FixtureTask = { name: 'cbuild setup Blinky.csolution.yml', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build', setup: true } };

function world(withTaskEvents = true): { tasks: FakeTasks; clock: ManualClock; tracker: CmsisJobTracker; log: string[] } {
    const tasks = new FakeTasks(withTaskEvents);
    const clock = new ManualClock(1_000);
    const log: string[] = [];
    return { tasks, clock, tracker: new CmsisJobTracker(tasks, clock, (line) => log.push(line)), log };
}

suite('CmsisJobTracker', () => {

    suite('replays the CMSIS Solution 1.70.1 task sequences', () => {
        for (const fixture of loadTaskFixtures()) {
            test(fixture.file, () => {
                const { tasks, clock, tracker } = world();
                const executions = new Map<string, FakeExecution>(
                    Object.entries(fixture.tasks).map(([name, task]) => [name, tasks.execution(task)]));
                const base = clock.now();
                const job = tracker.begin(fixture.action, 'NUCLEO-F401RE');
                for (const step of fixture.events) {
                    clock.advance(base + step.at);
                    const execution = step.task ? executions.get(step.task) : undefined;
                    switch (step.event) {
                        case 'issued':
                            tracker.issued(job.id);
                            break;
                        case 'commandReturned':
                            tracker.identify(job.id, execution);
                            break;
                        case 'tick':
                        case 'stopRun':
                            break;
                        default:
                            tasks.emit(step.event, execution as FakeExecution, step.exitCode);
                    }
                }
                const final = tracker.job(job.id);
                assert.strictEqual(final?.state, fixture.expect.state, fixture.description);
                if (fixture.expect.decidedBy) {
                    const decided = final?.executions.find((execution) => execution.key === final.decidedBy);
                    assert.strictEqual(decided?.name, fixture.tasks[fixture.expect.decidedBy].name);
                }
                if (fixture.expect.endedAfterStop) {
                    assert.deepStrictEqual(tracker.liveExecutions(), [], 'nothing is alive after the stop');
                    assert.deepStrictEqual(tracker.probeOwners(), []);
                }
            });
        }
    });

    suite('correlation', () => {
        test('an execution alive before begin never completes the job; the next one of its kind does', () => {
            const { tasks, clock, tracker } = world();
            const earlier = tasks.start(tasks.execution(BUILD));
            const adopted = tracker.inFlight('build');
            assert.strictEqual(adopted?.origin, 'adopted', 'a build started elsewhere is followed as a job');
            const job = tracker.begin('build', 'MPS3');
            tracker.issued(job.id);
            clock.advance(2_000);
            tasks.finish(earlier, 0);
            assert.strictEqual(tracker.job(job.id)?.state, 'armed', 'the earlier build ended; it is not this job\'s');
            assert.strictEqual(tracker.job(adopted?.id ?? '')?.state, 'ok', 'the adopted job settles with its own build');
            const ours = tasks.start(tasks.execution(BUILD));
            clock.advance(3_000);
            tasks.finish(ours, 0);
            assert.strictEqual(tracker.job(job.id)?.state, 'ok');
        });

        test('a cbuild setup is noted, never adopted and never the result', () => {
            const { tasks, tracker } = world();
            const job = tracker.begin('build', undefined);
            const setup = tasks.start(tasks.execution(SETUP));
            tasks.finish(setup, undefined);
            assert.strictEqual(tracker.inFlight('build')?.id, job.id, 'no job was adopted for the setup');
            const current = tracker.job(job.id) as Job;
            assert.strictEqual(current.state, 'armed');
            assert.deepStrictEqual(current.executions.map((execution) => [execution.kind, execution.role]), [['setup', undefined]]);
        });

        test('the build the command returns is bound even when its start was not seen', () => {
            const { tasks, tracker } = world();
            const job = tracker.begin('build', undefined);
            const returned = tasks.execution(BUILD);
            tracker.identify(job.id, returned);
            assert.strictEqual(executionIn(tracker.job(job.id) as Job, 'main')?.name, BUILD.name);
            tasks.emit('onDidStartTaskProcess', returned);
            tasks.emit('onDidEndTaskProcess', returned, 0);
            assert.strictEqual(tracker.job(job.id)?.state, 'ok');
            tracker.identify(job.id, 'not an execution');
            assert.strictEqual(tracker.job(job.id)?.state, 'ok');
        });

        test('with process events only (the transport stubs) a fresh wrapper per event still finds its execution', () => {
            const { tasks, tracker } = world(false);
            const job = tracker.begin('load', undefined);
            const task = shell('CMSIS Load');
            tasks.emit('onDidStartTaskProcess', tasks.execution(task));
            tasks.emit('onDidEndTaskProcess', tasks.execution(task), 1);
            const final = tracker.job(job.id) as Job;
            assert.strictEqual(final.state, 'failed');
            assert.strictEqual(executionIn(final, 'main')?.exitCode, 1);
        });

        test('a label that matches only when case is ignored is used and logged', () => {
            const { tasks, tracker, log } = world();
            const job = tracker.begin('erase', undefined);
            tasks.finish(tasks.start(tasks.execution({ name: 'cmsis erase', source: 'Workspace', definition: { type: 'shell' } })), 0);
            assert.strictEqual(tracker.job(job.id)?.state, 'ok');
            assert.ok(log.some((line) => line.includes('taken as erase by a case-insensitive label match')), log.join('\n'));
        });

        test('executions alive when the tracker starts are known, without a start time', () => {
            const tasks = new FakeTasks();
            const run = tasks.execution(shell('CMSIS Run'));
            tasks.alive.push(run);
            const tracker = new CmsisJobTracker(tasks, new ManualClock());
            assert.deepStrictEqual(tracker.probeOwners(), [{ name: 'CMSIS Run', kind: 'run', startedAt: undefined }]);
            assert.strictEqual(tracker.liveExecutions()[0].seeded, true);
            tracker.dispose();
            assert.strictEqual(tasks.listenerCount(), 0, 'dispose drops the listeners');
        });
    });

    suite('deadlines, retention and notification', () => {
        test('waitFor resolves at the deadline with the job as it is, and at once when it settles first', async () => {
            const { tasks, clock, tracker } = world();
            const job = tracker.begin('load', undefined);
            const load = tasks.start(tasks.execution(shell('CMSIS Load')));
            const pending = tracker.waitFor(job.id, clock.now() + 5_000);
            clock.advance(clock.now() + 5_000);
            assert.strictEqual((await pending)?.state, 'started');
            const second = tracker.waitFor(job.id, clock.now() + 60_000);
            tasks.finish(load, 0);
            assert.strictEqual((await second)?.state, 'ok');
            assert.strictEqual(clock.pendingTimers(), 0, 'the waiter\'s timer was cancelled');
            assert.strictEqual((await tracker.waitFor(job.id, 0))?.state, 'ok');
        });

        test('nothing started 10 s after issue settles as not-started without any event', async () => {
            const { clock, tracker } = world();
            const job = tracker.begin('load', undefined);
            tracker.issued(job.id);
            const pending = tracker.waitFor(job.id, clock.now() + 60_000);
            clock.advance(clock.now() + 10_000);
            assert.strictEqual((await pending)?.state, 'not-started');
        });

        test('load_and_run turns running-ok 2 s after Run\'s process started, on the clock alone', () => {
            const { tasks, clock, tracker } = world();
            const job = tracker.begin('load_and_run', undefined);
            tasks.start(tasks.execution(shell('CMSIS Load+Run')), false);
            const load = tasks.start(tasks.execution(shell('CMSIS Load')));
            tasks.finish(load, 0);
            tasks.start(tasks.execution(shell('CMSIS Run')));
            clock.advance(clock.now() + 1_999);
            assert.strictEqual(tracker.job(job.id)?.state, 'started');
            clock.advance(clock.now() + 1);
            assert.strictEqual(tracker.job(job.id)?.state, 'running-ok');
        });

        test(`the latest settled job of each action stays until a newer one settles; older ones are kept ${JOB_RETENTION_MS / 60_000} min; open ones are never dropped`, () => {
            const { tasks, clock, tracker } = world();
            const first = tracker.begin('erase', 'MPS3');
            tasks.finish(tasks.start(tasks.execution(shell('CMSIS Erase'))), 0);
            const open = tracker.begin('build', undefined);
            const settledAt = clock.now();
            // A failed build at 13:54, status asked at 14:15: the result is still there.
            clock.advance(settledAt + 3 * JOB_RETENTION_MS);
            assert.strictEqual(tracker.last('erase')?.id, first.id);
            assert.deepStrictEqual(tracker.recent().map((job) => job.id), [first.id]);
            const second = tracker.begin('erase', 'MPS3');
            tasks.finish(tasks.start(tasks.execution(shell('CMSIS Erase'))), 1);
            assert.strictEqual(tracker.last('erase')?.id, second.id);
            // The replaced one is past the retention, so it is gone; the newer one stays however old it gets.
            assert.strictEqual(tracker.job(first.id), undefined);
            clock.advance(clock.now() + 2 * JOB_RETENTION_MS);
            assert.strictEqual(tracker.job(second.id)?.state, 'failed');
            assert.strictEqual(tracker.inFlight()?.id, open.id);
        });

        test(`a replaced job is still kept ${JOB_RETENTION_MS / 60_000} min after it settled`, () => {
            const { tasks, clock, tracker } = world();
            const first = tracker.begin('load', undefined);
            tasks.finish(tasks.start(tasks.execution(shell('CMSIS Load'))), 0);
            const settledAt = clock.now();
            const second = tracker.begin('load', undefined);
            tasks.finish(tasks.start(tasks.execution(shell('CMSIS Load'))), 0);
            clock.advance(settledAt + JOB_RETENTION_MS);
            tracker.recent();
            assert.strictEqual(tracker.job(first.id)?.state, 'ok');
            clock.advance(settledAt + JOB_RETENTION_MS + 1);
            tracker.recent();
            assert.strictEqual(tracker.job(first.id), undefined);
            assert.strictEqual(tracker.last('load')?.id, second.id);
        });

        test('onDidFinishJob hears each job once, when it settles', () => {
            const { tasks, tracker } = world();
            const heard: string[] = [];
            const subscription = tracker.onDidFinishJob((job) => heard.push(`${job.id}:${job.state}`));
            const job = tracker.begin('load', undefined);
            const load = tasks.start(tasks.execution(shell('CMSIS Load')));
            tasks.emit('onDidEndTaskProcess', load, 0);
            tasks.emit('onDidEndTask', load);
            subscription.dispose();
            tasks.finish(tasks.start(tasks.execution(BUILD)), 0);
            assert.deepStrictEqual(heard, [`${job.id}:ok`]);
        });

        test('a build that exited 0 waits for its check; a check that finds it failed makes it a failed job', async () => {
            const { tasks, clock, tracker } = world();
            const verdicts: Array<(diagnosis: JobDiagnosis) => void> = [];
            tracker.onDidFinishJob((job) => tracker.completeWith(job.id, new Promise<JobDiagnosis>((resolve) => verdicts.push(resolve))));
            const diagnosed: string[] = [];
            tracker.onDidDiagnoseJob((job) => diagnosed.push(`${job.id}:${job.state}:${job.diagnosis?.check}`));
            const done = (check: JobDiagnosis['check']): JobDiagnosis => ({
                state: 'done', check, source: 'none', errors: [], warnings: [], errorCount: 0, warningCount: 0, text: '',
            });

            const failing = tracker.begin('build', 'MPS3');
            const waiting = tracker.waitFor(failing.id, clock.now() + 60_000);
            tasks.finish(tasks.start(tasks.execution(BUILD)), 0);
            assert.strictEqual(tracker.job(failing.id)?.state, 'ok', 'exit 0 settles the job');
            assert.strictEqual(tracker.job(failing.id)?.diagnosis?.state, 'pending');
            verdicts[0](done('failed'));
            const failed = await waiting;
            assert.deepStrictEqual([failed?.state, failed?.diagnosis?.check], ['failed', 'failed'], 'the waiter wakes with the failed job');
            assert.strictEqual(tracker.last('build')?.state, 'failed');

            const passing = tracker.begin('build', 'MPS3');
            tasks.finish(tasks.start(tasks.execution(BUILD)), 0);
            verdicts[1](done('rebuilt'));
            const passed = await tracker.waitFor(passing.id, clock.now() + 60_000);
            assert.deepStrictEqual([passed?.state, passed?.diagnosis?.check], ['ok', 'rebuilt']);
            assert.deepStrictEqual(diagnosed, [`${failing.id}:failed:failed`, `${passing.id}:ok:rebuilt`]);
        });

        test('discard forgets an open job and wakes its waiters', async () => {
            const { clock, tracker } = world();
            const job = tracker.begin('load_and_debug', undefined);
            const pending = tracker.waitFor(job.id, clock.now() + 30_000);
            tracker.discard(job.id);
            assert.strictEqual((await pending)?.id, job.id);
            assert.strictEqual(tracker.job(job.id), undefined);
            assert.strictEqual(tracker.inFlight(), undefined);
        });
    });

    suite('the probe and stop_run', () => {
        test('probe owners are the live Run, Load+Run, Load, Erase and TargetInfo, and this window\'s flash', () => {
            const { tasks, clock, tracker } = world();
            tasks.start(tasks.execution(BUILD));
            tasks.start(tasks.execution(shell('CMSIS Run')));
            const release = tracker.beginFlash();
            assert.deepStrictEqual(tracker.probeOwners(), [
                { name: 'CMSIS Run', kind: 'run', startedAt: clock.now() },
                { name: 'flash', kind: 'flash', startedAt: clock.now() },
            ]);
            release();
            assert.deepStrictEqual(tracker.probeOwners().map((owner) => owner.kind), ['run']);
        });

        test('waitForEnd reports the executions that ignore terminate()', async () => {
            const { tasks, clock, tracker } = world();
            const run = tasks.start(tasks.execution(shell('CMSIS Run'), true));
            const loadRun = tasks.start(tasks.execution(shell('CMSIS Load+Run')), false);
            const stoppable = tracker.stoppableExecutions();
            assert.deepStrictEqual(stoppable.map((execution) => execution.task.name), ['CMSIS Run', 'CMSIS Load+Run']);
            loadRun.terminate();
            run.terminate();
            const pending = tracker.waitForEnd(stoppable, 3_000);
            clock.advance(clock.now() + 3_000);
            const report = await pending;
            assert.deepStrictEqual(report.alive, [run]);
            assert.ok(report.endedAt.has(loadRun));
            assert.strictEqual(run.terminateCalls, 1);
        });
    });

    suite('label pre-check', () => {
        let folder: string;
        setup(() => {
            folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-labels-'));
        });
        teardown(() => fs.rmSync(folder, { recursive: true, force: true }));

        test('the labels of the folder\'s Workspace tasks, cached until tasks.json changes', async () => {
            const { tasks, tracker } = world();
            tasks.fetched = [
                ...workspaceTasks(folder, ['CMSIS Load', 'CMSIS Run']),
                ...workspaceTasks(path.join(folder, 'other'), ['CMSIS Erase']),
                { name: 'CMSIS Load+Run', source: 'Arm Debugger', scope: { uri: { fsPath: folder } } },
            ];
            assert.deepStrictEqual([...(await tracker.taskLabels(folder)) ?? []], ['CMSIS Load', 'CMSIS Run']);
            await tracker.taskLabels(folder);
            assert.strictEqual(tasks.fetchCount, 1, 'cached');
            fs.mkdirSync(path.join(folder, '.vscode'));
            fs.writeFileSync(path.join(folder, '.vscode', 'tasks.json'), '{}');
            tasks.fetched = workspaceTasks(folder, ['CMSIS Load+Run']);
            assert.deepStrictEqual([...(await tracker.taskLabels(folder)) ?? []], ['CMSIS Load+Run']);
            assert.strictEqual(tasks.fetchCount, 2, 'fetched again after tasks.json changed');
        });

        test('a task scope written in another case is the same folder where file names ignore case (VS Code\'s c:\\ on Windows)', async function () {
            if (process.platform !== 'win32' && process.platform !== 'darwin') {
                this.skip();
            }
            const { tasks, tracker } = world();
            // VS Code's Uri.fsPath writes a Windows drive letter in lower case; the folder may come with an upper-case one.
            const otherCase = folder.replace(/^[a-z]/, (letter) => letter.toUpperCase()).replace(/cda-labels-/, 'CDA-LABELS-');
            tasks.fetched = workspaceTasks(otherCase, ['CMSIS Load', 'CMSIS Run']);
            assert.deepStrictEqual([...(await tracker.taskLabels(folder)) ?? []], ['CMSIS Load', 'CMSIS Run']);
        });

        test('no answer when fetchTasks fails or takes longer than 3 s', async () => {
            const { tasks, clock, tracker } = world();
            tasks.fetched = undefined;
            assert.strictEqual(await tracker.taskLabels(folder), undefined);
            tasks.fetchTasks = () => new Promise(() => undefined);
            const slow = tracker.taskLabels(folder);
            clock.advance(clock.now() + LABEL_FETCH_MS);
            assert.strictEqual(await slow, undefined);
            const bare = new CmsisJobTracker({}, clock);
            assert.strictEqual(await bare.taskLabels(folder), undefined, 'a source without fetchTasks gives no answer');
        });
    });

    suite('texts', () => {
        test('durations read as 0.6 s, 9 s, 140 s, 3 min and 2 h', () => {
            assert.deepStrictEqual([600, 9_400, 140_000, 180_000, 7_200_000 * 1.5].map(formatDuration), ['0.6 s', '9 s', '140 s', '3 min', '3 h']);
            assert.strictEqual(formatDuration(-5), '0.0 s');
        });

        test('the get_session_status line: live tasks and recent results; nothing to say is no line', () => {
            const { tasks, clock, tracker } = world();
            assert.strictEqual(sessionTaskLine(tracker.recent(), tracker.liveExecutions(), clock.now()), undefined);
            tracker.begin('load', 'HP@debug');
            tasks.finish(tasks.start(tasks.execution(shell('CMSIS Load'))), 0);
            tasks.start(tasks.execution(shell('CMSIS Run')));
            clock.advance(clock.now() + 180_000);
            assert.strictEqual(sessionTaskLine(tracker.recent(), tracker.liveExecutions(), clock.now()),
                'CMSIS tasks: \'CMSIS Run\' alive 3 min (holds the probe); last load ✅ 3 min ago');
        });

        test('a build still running after 2 min names stop_build for a task that outlived its build', () => {
            const { tasks, clock, tracker } = world();
            const job = tracker.begin('build', 'HE');
            tasks.start(tasks.execution(BUILD));
            clock.advance(clock.now() + 60_000);
            const early = stillRunning(tracker.job(job.id) ?? job, { tag: ' on HE', now: clock.now() });
            assert.ok(!early.text.includes('stop_build'), early.text);
            clock.advance(clock.now() + 70_000);
            const late = stillRunning(tracker.job(job.id) ?? job, { tag: ' on HE', now: clock.now() });
            assert.ok(late.text.endsWith('do not start another build. If VS Code shows the build finished while this stays running, '
                + 'cmsis_action stop_build ends the task.'), late.text);
        });

        const STUCK = 'far longer than programming takes: it is stuck, almost always waiting for a debug probe. Its terminal, which no tool reads, '
            + 'then shows "Waiting for a debug probe" or a probe error. "Waiting for a debug probe" there means pyOCD sees no free probe: another task '
            + 'or session holds it (cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks), or the probe is not connected or lacks its USB '
            + 'driver (ask the user). cmsis_action {action:\'stop_run\'} ends the task; load again only once the probe is free and visible.';

        test('a Load still running after 2 min is called stuck, with the probe causes and stop_run; earlier it is merely running', () => {
            const { tasks, clock, tracker } = world();
            const job = tracker.begin('load', 'B-L475E-IOT01A');
            tasks.start(tasks.execution(shell('CMSIS Load')));
            clock.advance(clock.now() + LONG_FLASH_MS - 1_000);
            const early = stillRunning(tracker.job(job.id) ?? job, { tag: ' on L475', now: clock.now() });
            assert.match(early.text, /This is not a failure/);
            assert.strictEqual(stuckFlashTask(tracker.job(job.id) ?? job, clock.now()), undefined);
            clock.advance(clock.now() + 31 * 60_000);
            const late = stillRunning(tracker.job(job.id) ?? job, { tag: ' on L475', now: clock.now() });
            assert.strictEqual(late.text, `CMSIS 'load' on L475 has not finished after 33 min (job ${job.id}). 'CMSIS Load' has run for 33 min, ${STUCK}`);
            assert.strictEqual(late.status, 'running');
            assert.strictEqual((late.data?.job as { stuck?: boolean } | undefined)?.stuck, true);
            assert.ok(!late.text.includes('not a failure'), late.text);
        });

        test('the stuck verdict: Load and Erase only, never CMSIS Run, and only while the task runs', () => {
            const { tasks, clock, tracker } = world();
            const run = tracker.begin('run', 'HP');
            tasks.start(tasks.execution(shell('CMSIS Run')));
            clock.advance(clock.now() + 10 * 60_000);
            assert.strictEqual(stuckFlashTask(tracker.job(run.id) ?? run, clock.now()), undefined, 'a GDB server runs for hours');
            const erase = tracker.begin('erase', 'HP');
            const execution = tasks.start(tasks.execution(shell('CMSIS Erase')));
            clock.advance(clock.now() + LONG_FLASH_MS);
            assert.strictEqual(stuckFlashTask(tracker.job(erase.id) ?? erase, clock.now())?.name, 'CMSIS Erase');
            tasks.finish(execution, 0);
            assert.strictEqual(stuckFlashTask(tracker.job(erase.id) ?? erase, clock.now()), undefined, 'settled');
        });

        test('a Load the user started stuck shows in status without a job and in the get_session_status line', () => {
            const { tasks, clock, tracker } = world();
            tasks.start(tasks.execution(shell('CMSIS Load')));
            clock.advance(clock.now() + 3 * 60_000);
            assert.strictEqual(idleStatus(tracker.recent(), tracker.liveExecutions(), clock.now()),
                'No CMSIS job in this window: nothing is in flight and none has finished since the window started.\n'
                + 'CMSIS tasks running: \'CMSIS Load\' for 3 min (holds the probe).\n'
                + `'CMSIS Load' has run for 3 min, ${STUCK}`);
            assert.strictEqual(sessionTaskLine(tracker.recent(), tracker.liveExecutions(), clock.now()),
                `CMSIS tasks: 'CMSIS Load' alive 3 min (holds the probe)\n'CMSIS Load' has run for 3 min, ${STUCK}`);
        });

        test('a failed Load: pyOCD, or a command not known, keeps the flash hint word for word; J-Link and other programs get their own', () => {
            const pyocd = 'Its output is in the \'CMSIS Load\' terminal, which no tool reads: call flash, which returns pyOCD\'s own error lines, '
                + 'or ask the user for the terminal\'s last lines. "Waiting for a debug probe" there means pyOCD sees no free probe: another task or '
                + 'session holds it (cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks), or the probe is not connected or lacks its '
                + 'USB driver (ask the user). This is a terminal result — do not wait for an output file.';
            assert.strictEqual(flashFailedHint('CMSIS Load'), pyocd);
            assert.strictEqual(flashFailedHint('CMSIS Load', { kind: 'pyocd' }), pyocd);
            assert.strictEqual(flashFailedHint('CMSIS Load', { kind: 'unknown' }), pyocd);
            assert.strictEqual(flashFailedHint('CMSIS Load', { kind: 'other' }),
                'Its output is in the \'CMSIS Load\' terminal, which no tool reads: ask the user for the terminal\'s last lines. '
                + 'This is a terminal result — do not wait for an output file.');

            const jlinkMeaning = '"Cannot connect to J-Link" there means J-Link finds no free probe: another task or session holds it '
                + '(cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks), or the probe is not connected or lacks its USB driver (ask the user); '
                + '"Cannot connect to target" means the probe answers but the device does not: its power, the cable, or the device name the task passes. '
                + 'This is a terminal result — do not wait for an output file.';
            assert.strictEqual(flashFailedHint('CMSIS Load', { kind: 'jlink', program: 'JLink.exe' }),
                `Its output is in the 'CMSIS Load' terminal, which no tool reads: ask the user for the terminal's last lines. ${jlinkMeaning}`);
            // A program missing from a PATH: the finding, one line of fix, and the procedure for the steps; no run-then-attach detour.
            const steps = 'then restart VS Code completely (all windows); knowledge_get { id: "proc-debugger-troubleshooting" } has the steps. '
                + 'This is a terminal result — do not wait for an output file.';
            const searched = ['.cmsis/tools-environment.yml', 'terminal.integrated.env.windows', 'VS Code\'s PATH'];
            const notInstalled = flashFailedHint('CMSIS Load', { kind: 'jlink', program: 'JLink.exe', lookup: { searched } });
            assert.strictEqual(notInstalled,
                'JLink.exe is not on the PATH of the CMSIS tasks (searched: .cmsis/tools-environment.yml, terminal.integrated.env.windows, VS Code\'s PATH), '
                + 'so \'CMSIS Load\' could not start it. Ask the user to install the SEGGER J-Link Software or add its folder to the system or user '
                + `PATH, ${steps}`);
            const notOnPath = flashFailedHint('CMSIS Erase', {
                kind: 'jlink', program: 'JLink.exe', lookup: { searched: ['VS Code\'s PATH'], installedIn: 'C:\\Program Files\\SEGGER\\JLink' },
            });
            assert.strictEqual(notOnPath, 'JLink.exe is not on the PATH of the CMSIS tasks (searched: VS Code\'s PATH), so \'CMSIS Erase\' could not start it, '
                + `but C:\\Program Files\\SEGGER\\JLink holds it. Ask the user to add that folder to the system or user PATH, ${steps}`);
            for (const hint of [notInstalled, notOnPath]) {
                assert.ok(!/cmsis_action (?:run|attach)/.test(hint), hint);
            }
            const found = { file: 'C:\\Program Files\\SEGGER\\JLink\\JLink.exe', folder: 'C:\\Program Files\\SEGGER\\JLink', place: 'terminal.integrated.env.windows' };
            assert.strictEqual(flashFailedHint('CMSIS Load', { kind: 'jlink', program: 'JLink.exe', lookup: { found, searched } }),
                'Its output is in the \'CMSIS Load\' terminal, which no tool reads: ask the user for the terminal\'s last lines. JLink.exe is on the PATH '
                + 'of the CMSIS tasks (C:\\Program Files\\SEGGER\\JLink\\JLink.exe, from terminal.integrated.env.windows), so it ran and reported the '
                + `failure there. ${jlinkMeaning}`);
        });

        test('the tracker keeps the command line a task ran, for the hint after its failure', () => {
            const { tasks, tracker } = world();
            const job = tracker.begin('load', 'XMC4700');
            const commandLine = 'echo Connect > .cmd.jlink && echo Exit >> .cmd.jlink && JLink.exe -device XMC4700-F144x2048 -if swd -commandfile .cmd.jlink';
            tasks.finish(tasks.start(tasks.execution({ ...shell('CMSIS Load'), execution: { commandLine } })), 1);
            const settled = tracker.job(job.id) ?? job;
            const load = executionIn(settled, 'main');
            assert.ok(load);
            assert.deepStrictEqual(tracker.commandOf(load.key), ['echo', 'Connect', '>', '.cmd.jlink', '&&', 'echo', 'Exit', '>>', '.cmd.jlink', '&&',
                'JLink.exe', '-device', 'XMC4700-F144x2048', '-if', 'swd', '-commandfile', '.cmd.jlink']);
            const plain = tracker.begin('erase', 'XMC4700');
            tasks.finish(tasks.start(tasks.execution(shell('CMSIS Erase'))), 1);
            const erase = executionIn(tracker.job(plain.id) ?? plain, 'main');
            assert.ok(erase);
            assert.strictEqual(tracker.commandOf(erase.key), undefined, 'a task without an execution has no command');
        });

        test('status without a job in flight: the recent results and the live tasks, or that there is nothing', () => {
            const { tasks, clock, tracker } = world();
            assert.strictEqual(idleStatus(tracker.recent(), tracker.liveExecutions(), clock.now()),
                'No CMSIS job in this window: nothing is in flight and none has finished since the window started.\n'
                + 'No CMSIS task is running in this window.');
            const job = tracker.begin('build', 'MPS3');
            tasks.finish(tasks.start(tasks.execution(BUILD)), 2);
            tasks.start(tasks.execution(shell('CMSIS Run')));
            clock.advance(clock.now() + 5_000);
            assert.strictEqual(idleStatus(tracker.recent(), tracker.liveExecutions(), clock.now()),
                `No CMSIS job in flight in this window. Last results: build on MPS3 ❌ exit 2 5 s ago (job ${job.id}, '${BUILD.name}').\n`
                + 'CMSIS tasks running: \'CMSIS Run\' for 5 s (holds the probe). cmsis_action {action:\'stop_run\'} ends them.');
        });
    });
});
