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
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachBuildDiagnosis, DiagnosisHost, DiagnosticChild, DiagnosticSpawnOptions } from '../cmsisBuildDiagnosis';
import { CmsisJobTracker } from '../cmsisJobTracker';
import { DIAGNOSTIC_RERUN_CAP_MS } from '../core/buildFailure';
import { BUILD_STOPPED_EXIT_CODE, type Job, type JobAction } from '../core/cmsisTasks';
import { idleStatus, jobResult } from '../handler/jobText';
import { ToolError } from '../core/toolResult';
import { FakeExecution, FakeTasks, FixtureTask, ManualClock } from './cmsisTaskFixtures';

/**
 * The runner of #15 over a tracker fed with fake task events: which stage
 * answers, the re-run's command line and guards (the cap, a build that
 * starts meanwhile, a build already running, no environment file, the
 * setting), and how the lines reach a waiting call and `status`. cbuild is a
 * fake: the test writes its log and ends it.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'buildinfo');
const GCC_LOG = fs.readFileSync(path.join(FIXTURES, 'build-failed-gcc.log'), 'utf8');
const IDX = fs.readFileSync(path.join(FIXTURES, 'Blinky.cbuild-idx.yml'), 'utf8');

/** A cbuild that does nothing until the test ends it. */
class FakeChild extends EventEmitter implements DiagnosticChild {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    killed = 0;

    constructor(readonly pid: number | undefined, readonly command: string, readonly args: readonly string[], readonly options: DiagnosticSpawnOptions) {
        super();
    }

    kill(): boolean {
        this.killed++;
        return true;
    }

    /** cbuild prints, writes its log and exits. */
    finish(code: number | null, log?: string, printed = ''): void {
        if (log !== undefined) {
            const logFile = this.args[this.args.indexOf('--log') + 1];
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.writeFileSync(logFile, log);
        }
        if (printed) {
            this.stdout.emit('data', Buffer.from(printed));
        }
        this.emit('close', code);
    }
}

interface World {
    dir: string;
    solution: string;
    tasks: FakeTasks;
    clock: ManualClock;
    tracker: CmsisJobTracker;
    host: DiagnosisHost;
    children: FakeChild[];
    killed: FakeChild[];
    settings: { rerun: boolean; closeOnKill: boolean };
    dispose(): void;
}

/** A solution folder with (optionally) the environment file and a cbuild, a tracker, and the diagnosis attached to it. */
function world(options: { environment?: boolean; cbuild?: boolean } = {}): World {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-diagnosis-'));
    const solution = path.join(dir, 'Blinky.csolution.yml');
    fs.writeFileSync(solution, 'solution:\n');
    const bin = path.join(dir, 'toolbox', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (options.cbuild !== false) {
        fs.writeFileSync(path.join(bin, 'cbuild'), '');
    }
    if (options.environment !== false) {
        fs.mkdirSync(path.join(dir, '.cmsis'));
        fs.writeFileSync(path.join(dir, '.cmsis', 'tools-environment.yml'), [
            'cmsis-tools-environment:',
            '  environment:',
            '    path:',
            `      - ${bin.replace(/\\/g, '/')}`,
            '    variables:',
            '      GCC_TOOLCHAIN_14_3_1: /opt/gcc/bin',
            '  tools:',
            '    - name: CMSIS-Toolbox',
            '      version: 2.14.1',
            `      directory: ${bin.replace(/\\/g, '/')}`,
            '',
        ].join('\n'));
    }
    const tasks = new FakeTasks();
    const clock = new ManualClock(Date.now());
    const tracker = new CmsisJobTracker(tasks, clock);
    const children: FakeChild[] = [];
    const killed: FakeChild[] = [];
    const settings = { rerun: true, closeOnKill: true };
    const host: DiagnosisHost = {
        rerunEnabled: () => settings.rerun,
        solutionFile: async () => solution,
        activeTarget: async () => 'MPS3',
        outputDirectorySetting: () => undefined,
        packRoot: async () => '/packs',
        workingDirectory: () => dir,
        baseEnvironment: () => ({ PATH: '/usr/bin' }),
        platform: 'linux',
        spawn: (command, args, spawnOptions) => {
            const child = new FakeChild(4242 + children.length, command, args, spawnOptions);
            children.push(child);
            return child;
        },
        killTree: (child) => {
            killed.push(child as FakeChild);
            if (settings.closeOnKill) {
                setImmediate(() => (child as FakeChild).emit('close', null));
            }
        },
        clock,
    };
    const attached = attachBuildDiagnosis(tracker, host);
    return {
        dir, solution, tasks, clock, tracker, host, children, killed, settings,
        dispose: () => {
            attached.dispose();
            tracker.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

function buildTask(w: World, definition: Record<string, unknown> = {}): FixtureTask {
    return {
        name: 'cbuild Blinky.csolution.yml --active MPS3 --packs', source: 'cmsis-csolution.build',
        definition: {
            type: 'cmsis-csolution.build', solution: w.solution, schemaCheck: false, active: 'MPS3', clean: false, rebuild: false,
            setup: false, buildOutputVerbosity: 'normal', downloadPacks: true, cmakeTarget: 'all', ...definition,
        },
    };
}

/** Let promise chains and `setImmediate` callbacks run until `done` holds. */
async function until(done: () => boolean, what: string): Promise<void> {
    for (let round = 0; round < 200; round++) {
        if (done()) {
            return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail(`never happened: ${what}`);
}

/** A build job (or `action`) whose task starts and fails with `exitCode`; the diagnosis starts from its end. */
function failBuild(w: World, exitCode = 2, definition: Record<string, unknown> = {}, action: JobAction = 'build'): { job: Job; execution: FakeExecution } {
    const job = w.tracker.begin(action, 'MPS3');
    w.tracker.issued(job.id);
    const execution = w.tasks.start(w.tasks.execution(buildTask(w, definition)));
    w.clock.advance(w.clock.now() + 3_000);
    w.tasks.finish(execution, exitCode);
    return { job, execution };
}

async function diagnosed(w: World, id: string): Promise<Job> {
    await until(() => w.tracker.job(id)?.diagnosis?.state === 'done', 'the diagnosis is done');
    return w.tracker.job(id) as Job;
}

/**
 * A build job (or `action`) whose task starts and exits 0, which CMSIS Solution 1.70.1 reports for failed builds
 * too; `during` runs while cbuild would build (write the image there). The check starts from its end.
 */
function passBuild(w: World, definition: Record<string, unknown> = {}, action: JobAction = 'build', during: () => void = () => undefined): { job: Job; execution: FakeExecution } {
    const job = w.tracker.begin(action, 'MPS3');
    w.tracker.issued(job.id);
    const execution = w.tasks.start(w.tasks.execution(buildTask(w, definition)));
    during();
    w.clock.advance(w.clock.now() + 3_000);
    w.tasks.finish(execution, 0);
    return { job, execution };
}

/**
 * What CMSIS-Toolbox 2.14 leaves after a build of Blinky for MPS3: the index,
 * which names the context's cbuild.yml, that cbuild.yml with its outputs, and
 * the image, `ageMs` older than the build's start (0: written by the build),
 * or none. Returns the image's path.
 */
function builtLayout(w: World, image: { ageMs: number } | 'none' = { ageMs: 0 }): string {
    const debug = path.join(w.dir, 'out', 'Blinky', 'MPS3', 'Debug');
    fs.mkdirSync(debug, { recursive: true });
    fs.writeFileSync(path.join(w.dir, 'Blinky.cbuild-idx.yml'), [
        'build-idx:',
        '  generated-by: csolution version 2.14.1',
        '  csolution: Blinky.csolution.yml',
        '  cbuild-run: out/Blinky+MPS3.cbuild-run.yml',
        '  cbuilds:',
        '    - cbuild: out/Blinky/MPS3/Debug/Blinky.Debug+MPS3.cbuild.yml',
        '      project: Blinky',
        '      configuration: .Debug+MPS3',
        '      messages:',
        '        info:',
        '          - Blinky.Debug+MPS3.cbuild.yml - file is already up-to-date',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(debug, 'Blinky.Debug+MPS3.cbuild.yml'), [
        'build:',
        '  context: Blinky.Debug+MPS3',
        '  compiler: AC6',
        '  output-dirs:',
        '    intdir: ../../../../tmp',
        '    outdir: .',
        '  output:',
        '    - type: elf',
        '      file: Blinky.axf',
        '    - type: hex',
        '      file: Blinky.hex',
        '    - type: map',
        '      file: Blinky.axf.map',
        '',
    ].join('\n'));
    const file = path.join(debug, 'Blinky.axf');
    if (image !== 'none') {
        fs.writeFileSync(file, 'ELF');
        if (image.ageMs > 0) {
            const at = new Date(w.clock.now() - image.ageMs);
            fs.utimesSync(file, at, at);
        }
    }
    return file;
}

/** The error `jobResult` throws for a job, or a failure of the test when it returns. */
function resultError(job: Job, now: number): ToolError {
    try {
        jobResult(job, { tag: ' on MPS3', now });
    } catch (caught) {
        assert.ok(caught instanceof ToolError, String(caught));
        return caught;
    }
    return assert.fail('jobResult did not throw');
}

suite('build diagnosis (#15)', () => {
    let current: World | undefined;
    teardown(() => {
        current?.dispose();
        current = undefined;
    });
    const make = (options?: Parameters<typeof world>[0]): World => {
        current = world(options);
        return current;
    };

    test('the result names the knowledge unit of an error message the index knows; a lookup that throws changes nothing', async () => {
        const known = 'Known message: knowledge_get { id: "ts-x" } has its cause and fix.';
        const w = make();
        const asked: string[][] = [];
        w.host.knownMessageLines = (messages) => {
            asked.push([...messages]);
            return [known, known, known, known];
        };
        const first = failBuild(w).job;
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.children[0].finish(1, GCC_LOG);
        const text = (await diagnosed(w, first.id)).diagnosis?.text ?? '';
        assert.ok(text.endsWith(`get_build_diagnostics reads it).\n${known}\n${known}\n${known}`), text);
        assert.strictEqual(asked[0][0], '\'ledx\' undeclared (first use in this function)');

        w.host.knownMessageLines = () => { throw new Error('index gone'); };
        const second = failBuild(w).job;
        await until(() => w.children.length === 2, 'cbuild was spawned again');
        w.children[1].finish(1, GCC_LOG);
        assert.ok((await diagnosed(w, second.id)).diagnosis?.text.endsWith('get_build_diagnostics reads it).'));
    });

    test('a failed build is re-run once with --log and without --packs, and its log gives the lines', async () => {
        const w = make();
        const { job } = failBuild(w);
        assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending', 'the job carries a pending diagnosis at once');
        assert.ok(w.tracker.isCompleting(job.id));
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const child = w.children[0];
        const logFile = path.join(w.dir, 'out', 'cmsis-developer-assistant', 'build-diagnostic.log');
        assert.strictEqual(child.command, path.posix.join(path.join(w.dir, 'toolbox', 'bin').replace(/\\/g, '/'), 'cbuild'));
        assert.deepStrictEqual(child.args, [w.solution, '--target', 'all', '--active', 'MPS3', '--log', logFile],
            'no fresh index, so the re-run converts again; no --packs, no --schema (schemaCheck false)');
        assert.strictEqual(child.options.shell, false);
        assert.strictEqual(child.options.cwd, w.dir);
        assert.strictEqual(child.options.env.CMSIS_PACK_ROOT, '/packs');
        assert.strictEqual(child.options.env.GCC_TOOLCHAIN_14_3_1, '/opt/gcc/bin');
        assert.ok(child.options.env.PATH.endsWith(':/usr/bin'), child.options.env.PATH);

        child.finish(1, GCC_LOG);
        const done = await diagnosed(w, job.id);
        const diagnosis = done.diagnosis;
        assert.ok(diagnosis);
        assert.strictEqual(diagnosis.source, 'rerun');
        assert.strictEqual(diagnosis.errorCount, 2);
        assert.strictEqual(diagnosis.warningCount, 1);
        assert.deepStrictEqual(diagnosis.errors[0], {
            severity: 'error', file: '/Users/dev/work/Blinky/Blinky/main.c', line: 42, column: 5, message: '\'ledx\' undeclared (first use in this function)',
        });
        assert.strictEqual(diagnosis.logFile, logFile);
        assert.match(diagnosis.text, /^2 errors \(from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 1\):\n/);
        assert.ok(diagnosis.text.endsWith('Full log: out/cmsis-developer-assistant/build-diagnostic.log (get_build_diagnostics reads it).'), diagnosis.text);
        assert.strictEqual(w.tracker.isCompleting(job.id), false);
        assert.strictEqual(w.clock.pendingTimers(), 0, 'the cap timer was cancelled');
    });

    test('stage A: a fresh cbuild-idx.yml with errors answers without a re-run', async () => {
        const w = make();
        fs.writeFileSync(path.join(w.dir, 'Blinky.cbuild-idx.yml'), IDX);
        const { job } = failBuild(w);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(w.children.length, 0, 'nothing was re-run');
        assert.strictEqual(done.diagnosis?.source, 'csolution');
        assert.strictEqual(done.diagnosis?.errorCount, 2);
        assert.strictEqual(done.diagnosis?.warningCount, 4);
        assert.match(done.diagnosis?.text ?? '', /^2 errors from csolution \(Blinky\.cbuild-idx\.yml, context \.Debug\+MPS3\), 4 warnings:\n {2}error: component 'Compiler:CORE'/);
    });

    test('a fresh index without errors: the re-run skips the convert step, and csolution\'s warnings come along', async () => {
        const w = make();
        fs.writeFileSync(path.join(w.dir, 'Blinky.cbuild-idx.yml'),
            'build-idx:\n  cbuilds:\n    - cbuild: x.cbuild.yml\n      configuration: .Debug+MPS3\n      messages:\n        warnings:\n          - no compiler registered\n');
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.strictEqual(w.children[0].args[w.children[0].args.length - 1], '--skip-convert');
        w.children[0].finish(1, GCC_LOG);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(done.diagnosis?.warningCount, 2, 'the re-run\'s warning and csolution\'s');
        assert.ok(done.diagnosis?.text.includes('  csolution warning: no compiler registered'), done.diagnosis?.text);
    });

    test('an index older than the build is not the build\'s: the re-run converts again', async () => {
        const w = make();
        const idx = path.join(w.dir, 'Blinky.cbuild-idx.yml');
        fs.writeFileSync(idx, IDX);
        const old = new Date(w.clock.now() - 60_000);
        fs.utimesSync(idx, old, old);
        failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.ok(!w.children[0].args.includes('--skip-convert'));
        w.children[0].finish(1, '');
    });

    test('no re-run without the environment file; the result says why and names get_build_diagnostics', async () => {
        const w = make({ environment: false });
        const { job } = failBuild(w);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(w.children.length, 0);
        assert.strictEqual(done.diagnosis?.source, 'none');
        assert.strictEqual(done.diagnosis?.text, 'No error lines: .cmsis/tools-environment.yml is missing (CMSIS Solution 1.70.1 and later write it), '
            + 'so cbuild was not re-run.\n'
            + 'cmsis_action build re-runs cbuild with --log itself when it can.');
    });

    test('no cbuild where the environment file says, the setting off, a clean: no re-run, each said', async () => {
        const noCbuild = make({ cbuild: false });
        const first = failBuild(noCbuild);
        assert.match((await diagnosed(noCbuild, first.job.id)).diagnosis?.text ?? '', /^No error lines: cbuild was not found in the CMSIS-Toolbox directory/);
        noCbuild.dispose();

        const off = make();
        off.settings.rerun = false;
        fs.writeFileSync(path.join(off.dir, 'Blinky.cbuild-idx.yml'), IDX.replace(/errors:[\s\S]*?warnings:/, 'warnings:'));
        const second = failBuild(off);
        const text = (await diagnosed(off, second.job.id)).diagnosis?.text ?? '';
        assert.ok(text.startsWith('No error lines: the diagnostic re-run of cbuild is off (setting cmsis-developer-assistant.build.diagnosticRerun).\n'
            + '  csolution warning: Blinky.csolution.yml - solution created for unknown tool'), text);
        assert.strictEqual(off.children.length, 0);
        off.dispose();

        const clean = make();
        const third = failBuild(clean, 2, { clean: true }, 'clean');
        assert.match((await diagnosed(clean, third.job.id)).diagnosis?.text ?? '', /^No error lines: a failed clean is not re-run\./);
        assert.strictEqual(clean.children.length, 0);
    });

    test('a failed rebuild is diagnosed like a build: the re-run leaves out --rebuild, and the result names the rebuild', async () => {
        const w = make();
        const { job } = failBuild(w, 2, { rebuild: true }, 'rebuild');
        assert.strictEqual(w.tracker.job(job.id)?.state, 'failed');
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.ok(!w.children[0].args.includes('--rebuild'), w.children[0].args.join(' '));
        w.children[0].finish(1, GCC_LOG);
        const done = await diagnosed(w, job.id);
        const failure = resultError(done, w.clock.now());
        assert.match(failure.message, /^❌ CMSIS 'rebuild' FAILED on MPS3 — task '.*' exited with code 2 after 3 s \(job rb-1\)\.\n2 errors \(from a diagnostic re-run/);
        assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()), /\nRebuild job rb-1 failed: 2 errors/);
    });

    test(`a build stopped with ${BUILD_STOPPED_EXIT_CODE} (Stop Build, cmsis_action stop_build) is not diagnosed: no re-run starts`, () => {
        const w = make();
        const { job } = failBuild(w, BUILD_STOPPED_EXIT_CODE);
        assert.strictEqual(w.tracker.job(job.id)?.state, 'cancelled');
        assert.strictEqual(w.tracker.job(job.id)?.diagnosis, undefined);
        assert.strictEqual(w.tracker.isCompleting(job.id), false);
        assert.strictEqual(w.children.length, 0);
        const stopped = resultError(w.tracker.job(job.id) as Job, w.clock.now());
        assert.strictEqual(stopped.message, 'CMSIS \'build\' on MPS3 — task \'cbuild Blinky.csolution.yml --active MPS3 --packs\' was stopped after 3 s (job b-1), '
            + 'so its outputs are incomplete: cmsis_action build before load or flash.');
        assert.strictEqual(stopped.hint, 'cmsis_action build starts it again.');
        assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()), /build on MPS3 stopped [\d.]+ s ago \(job b-1, /);
    });

    test('a build or setup that starts meanwhile kills the re-run, and its result says so', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.tasks.start(w.tasks.execution({ name: 'cbuild setup Blinky.csolution.yml', source: 'cmsis-csolution.build',
            definition: { type: 'cmsis-csolution.build', setup: true } }));
        assert.deepStrictEqual(w.killed, [w.children[0]], 'the new build killed the child at once');
        const done = await diagnosed(w, job.id);
        assert.strictEqual(done.diagnosis?.text, 'No error lines: the diagnostic re-run of cbuild was stopped because another build started; '
            + 'that build\'s result replaces this one.\n'
            + 'cmsis_action build re-runs cbuild with --log itself when it can.');
    });

    test('the re-run is killed at 120 s; what its log had by then is shown', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const child = w.children[0];
        const logFile = child.args[child.args.indexOf('--log') + 1];
        fs.writeFileSync(logFile, GCC_LOG);
        w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS - 1);
        assert.deepStrictEqual(w.killed, []);
        w.clock.advance(w.clock.now() + 1);
        assert.deepStrictEqual(w.killed, [child]);
        const done = await diagnosed(w, job.id);
        assert.match(done.diagnosis?.text ?? '', /^2 errors \(from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 1; the re-run was stopped after 120 s\):/);
    });

    test('a child that does not close after the kill counts as ended 5 s later', async () => {
        const w = make();
        w.settings.closeOnKill = false;
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS);
        await until(() => w.killed.length === 1, 'the cap killed it');
        assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending');
        w.clock.advance(w.clock.now() + 5_000);
        const done = await diagnosed(w, job.id);
        assert.match(done.diagnosis?.text ?? '', /^A diagnostic re-run of cbuild with --log was stopped after 120 s before it printed an error line\./);
    });

    test('no re-run beside another build that is running', async () => {
        const w = make();
        w.tasks.start(w.tasks.execution({ name: 'cbuild other.csolution.yml', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' } }));
        const { job } = failBuild(w);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(w.children.length, 0);
        assert.match(done.diagnosis?.text ?? '', /^No error lines: 'cbuild other\.csolution\.yml' is running, so cbuild was not re-run beside it\./);
    });

    test('cbuild\'s own output stands in when the log is missing; a spawn failure is said', async () => {
        const w = make();
        const first = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.children[0].finish(1, undefined, '/w/main.c:3:1: error: expected \';\' before \'}\' token\n');
        const done = await diagnosed(w, first.job.id);
        assert.strictEqual(done.diagnosis?.errorCount, 1);
        assert.strictEqual(done.diagnosis?.logFile, undefined);

        w.host.spawn = () => {
            throw new Error('spawn EACCES');
        };
        const second = failBuild(w);
        assert.match((await diagnosed(w, second.job.id)).diagnosis?.text ?? '', /^No error lines: the diagnostic re-run of cbuild could not start \(spawn EACCES\)\./);
    });

    test('a definition naming the solution through a variable asks CMSIS Solution for it', async () => {
        const w = make();
        const { job } = failBuild(w, 2, { solution: '${command:cmsis-csolution.getSolutionFile}', active: '${command:cmsis-csolution.getActiveTargetSet}' });
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.deepStrictEqual(w.children[0].args.slice(0, 5), [w.solution, '--target', 'all', '--active', 'MPS3']);
        w.children[0].finish(0, 'Build summary: 1 succeeded, 0 failed - Time Elapsed: 00:00:01\n');
        assert.match((await diagnosed(w, job.id)).diagnosis?.text ?? '', /^A diagnostic re-run of cbuild with --log succeeded \(exit 0\)/);
    });

    suite('a build that exited 0 is checked before it counts as a success', () => {
        test('an image written since the build started confirms it without a re-run', async () => {
            const w = make();
            const image = builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w, {}, 'build', () => fs.writeFileSync(image, 'ELF, linked again'));
            assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending', 'the success waits for the check');
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'ok');
            assert.strictEqual(done.diagnosis?.check, 'rebuilt');
            assert.strictEqual(w.children.length, 0, 'nothing was re-run');
            assert.match(jobResult(done, { tag: ' on MPS3', now: w.clock.now() }) as string,
                /^✅ CMSIS 'build' succeeded on MPS3 \(task 'cbuild Blinky\.csolution\.yml --active MPS3 --packs' exited 0 after 3 s, job b-1\)\. The firmware is built/);
        });

        test('an image older than the build: the check re-run fails where the build failed, and the job fails with the error lines', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            const args = w.children[0].args;
            assert.ok(!args.includes('--packs'), 'no pack download');
            assert.strictEqual(args[args.length - 1], '--skip-convert', 'the index is fresh, so csolution is not run again');
            w.children[0].finish(1, GCC_LOG);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'failed', 'exit 0 with errors is a failed job');
            assert.strictEqual(done.diagnosis?.check, 'failed');
            assert.strictEqual(done.diagnosis?.errorCount, 2);
            const failure = resultError(done, w.clock.now());
            assert.strictEqual(failure.code, 'TASK_FAILED');
            assert.match(failure.message, /^❌ CMSIS 'build' FAILED on MPS3 — task '.*' exited 0 after 3 s, but the build failed \(CMSIS Solution reports exit 0 for a failed build too\) \(job b-1\)\.\n2 errors \(from a diagnostic re-run of cbuild with --log;/);
            assert.strictEqual(failure.hint, 'Fix the first error, then cmsis_action build again. This is a terminal result — do not wait for an output file.');
            assert.strictEqual((failure.data?.diagnosis as Record<string, unknown>).check, 'failed');
            const idle = idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now());
            assert.match(idle, /build on MPS3 ❌ build errors \(exit 0\) [\d.]+ s ago \(job b-1, /);
            assert.match(idle, /\nBuild job b-1 failed: 2 errors \(from a diagnostic re-run/);
        });

        test('an image older than the build and a check re-run that succeeds: up to date, a success', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.children[0].finish(0, 'Build summary: 1 succeeded, 0 failed - Time Elapsed: 00:00:01\n');
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'ok');
            assert.strictEqual(done.diagnosis?.check, 'up-to-date');
            assert.strictEqual(jobResult(done, { tag: ' on MPS3', now: w.clock.now() }),
                '✅ CMSIS \'build\' succeeded on MPS3 (task \'cbuild Blinky.csolution.yml --active MPS3 --packs\' exited 0 after 3 s, job b-1). '
                + 'The image out/Blinky/MPS3/Debug/Blinky.axf was not rewritten: it is from 60 min before the build started; '
                + 'a check re-run of cbuild succeeded (exit 0), so the build is up to date. '
                + 'The firmware is built — use cmsis_action load or load_and_debug to flash it.');
        });

        test('errors in a fresh cbuild-idx.yml fail it without a re-run', async () => {
            const w = make();
            fs.writeFileSync(path.join(w.dir, 'Blinky.cbuild-idx.yml'), IDX);
            const { job } = passBuild(w);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(w.children.length, 0);
            assert.strictEqual(done.state, 'failed');
            assert.deepStrictEqual([done.diagnosis?.check, done.diagnosis?.source, done.diagnosis?.errorCount], ['failed', 'csolution', 2]);
            assert.match(resultError(done, w.clock.now()).message, /exited 0 after 3 s, but the build failed .*\n2 errors from csolution/);
        });

        test('a missing image and no way to re-run cbuild: exit 0 is reported, but not as a confirmed success', async () => {
            const w = make({ environment: false });
            builtLayout(w, 'none');
            const { job } = passBuild(w);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'ok');
            assert.strictEqual(done.diagnosis?.check, 'unverified');
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.strictEqual(reply.status, 'ok');
            assert.strictEqual(reply.text, '⚠️ CMSIS \'build\' on MPS3: task \'cbuild Blinky.csolution.yml --active MPS3 --packs\' exited 0 after 3 s (job b-1), '
                + 'but that does not confirm the build. The image out/Blinky/MPS3/Debug/Blinky.axf is missing, and CMSIS Solution reports exit 0 '
                + 'for a failed build too, so this build may have failed. It could not be checked: .cmsis/tools-environment.yml is missing '
                + '(CMSIS Solution 1.70.1 and later write it), so cbuild was not re-run. '
                + 'Before you load this image, ask the user whether the build in the cbuild terminal succeeded — do not run cbuild yourself.');
            assert.strictEqual(((reply.data as Record<string, unknown>).diagnosis as Record<string, unknown>).check, 'unverified');
            const idle = idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now());
            assert.match(idle, /build on MPS3 ⚠️ exit 0, not confirmed [\d.]+ s ago/);
            assert.match(idle, /\nBuild job b-1 exited 0, but that does not confirm it: The image /);
        });

        test('a check still going when the call\'s wait ends answers running; status gives the result', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const job = w.tracker.begin('build', 'MPS3');
            const waiting = w.tracker.waitFor(job.id, w.clock.now() + 10_000);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            w.clock.advance(w.clock.now() + 3_000);
            w.tasks.finish(execution, 0);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.clock.advance(w.clock.now() + 7_000);
            const early = await waiting as Job;
            assert.deepStrictEqual([early.state, early.diagnosis?.state], ['ok', 'pending']);
            const reply = jobResult(early, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.strictEqual(reply.status, 'running');
            assert.match(reply.text, /^CMSIS 'build' on MPS3: task '.*' exited 0 after 3 s \(job b-1\); its result is still being checked .*Call cmsis_action \{action:'status'\} for the result — do not start another build\.$/);
            assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()),
                /build on MPS3 exit 0, being checked .*\nThe result of build job b-1 \(exit 0\) is still being checked/);
            const status = w.tracker.waitFor(job.id, w.clock.now() + 60_000);
            w.children[0].finish(2, GCC_LOG);
            assert.strictEqual((await status)?.state, 'failed');
        });

        test('a build that starts meanwhile stops the check re-run: not confirmed, and why', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.tasks.start(w.tasks.execution({ name: 'cbuild other.csolution.yml', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' } }));
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.check, 'unverified');
            assert.match(done.diagnosis?.text ?? '', /It could not be checked: the diagnostic re-run of cbuild was stopped because another build started/);
        });

        test('an image younger than 2 s but unchanged since the build started is not its: the re-run decides', async () => {
            // A tester's failed build that started under 2 s after a good one read ✅ from the age of that one's image.
            const w = make();
            builtLayout(w, { ageMs: 500 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.children[0].finish(1, GCC_LOG);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'failed');
            assert.strictEqual(done.diagnosis?.check, 'failed');
            assert.strictEqual(done.diagnosis?.errorCount, 2);
        });

        test('without a note from the start (a solution named through a variable), an image under 2 s older than the build still counts', async () => {
            const w = make();
            builtLayout(w, { ageMs: 500 });
            const { job } = passBuild(w, { solution: '${command:cmsis-csolution.getSolutionFile}' });
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.check, 'rebuilt');
            assert.strictEqual(w.children.length, 0);
        });

        test('a rebuild that exited 0 is checked like a build', async () => {
            const w = make();
            const image = builtLayout(w, 'none');
            const { job } = passBuild(w, { rebuild: true }, 'rebuild', () => fs.writeFileSync(image, 'ELF'));
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.check, 'rebuilt');
            assert.strictEqual(w.children.length, 0);
            assert.match(jobResult(done, { tag: ' on MPS3', now: w.clock.now() }) as string,
                /^✅ CMSIS 'rebuild' succeeded on MPS3 \(task '.*' exited 0 after 3 s, job rb-1\)\. The firmware is rebuilt from scratch — use cmsis_action load or load_and_debug to flash it\.$/);
        });
    });

    suite('a clean that exited 0 is checked against the images its target had when it started', () => {
        /** A clean job whose task starts now; `during` runs while cbuild would clean, then the task exits 0. */
        const runClean = (w: World, during: () => void, definition: Record<string, unknown> = {}): Job => {
            const job = w.tracker.begin('clean', 'MPS3');
            w.tracker.issued(job.id);
            const execution = w.tasks.start(w.tasks.execution({
                ...buildTask(w, { clean: true, ...definition }), name: 'cbuild Blinky.csolution.yml --clean --target all --packs',
            }));
            during();
            w.clock.advance(w.clock.now() + 1_000);
            w.tasks.finish(execution, 0);
            return job;
        };

        test('the images are gone: cleaned, and the result says what it removed and that the whole solution is clean', async () => {
            const w = make();
            const image = builtLayout(w);
            const done = await diagnosed(w, runClean(w, () => fs.rmSync(path.join(w.dir, 'out'), { recursive: true })).id);
            assert.strictEqual(done.state, 'ok');
            assert.strictEqual(done.diagnosis?.check, 'cleaned');
            assert.ok(!fs.existsSync(image));
            assert.strictEqual(w.children.length, 0, 'a clean is never re-run');
            assert.strictEqual(jobResult(done, { tag: ' on MPS3', now: w.clock.now() }),
                '✅ CMSIS \'clean\' succeeded on MPS3 (task \'cbuild Blinky.csolution.yml --clean --target all --packs\' exited 0 after 1 s, job c-1). '
                + 'Removed: out/Blinky/MPS3/Debug/Blinky.axf. It covers the whole solution (CMSIS Solution: "Clean All \'out\' and \'tmp\' Directories"), '
                + 'not only this target: cmsis_action build before load or flash.');
        });

        test('an image is still there: not confirmed, with the next step', async () => {
            const w = make();
            builtLayout(w);
            const done = await diagnosed(w, runClean(w, () => undefined).id);
            assert.strictEqual(done.diagnosis?.check, 'unverified');
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.strictEqual(reply.status, 'ok');
            assert.strictEqual(reply.text, '⚠️ CMSIS \'clean\' on MPS3: task \'cbuild Blinky.csolution.yml --clean --target all --packs\' exited 0 after 1 s (job c-1), '
                + 'but that does not confirm the clean. out/Blinky/MPS3/Debug/Blinky.axf is still there, and CMSIS Solution reports exit 0 for a failed clean too, '
                + 'so this clean may have failed. Ask the user whether the clean in the cbuild terminal succeeded — do not delete the files yourself; '
                + 'a build compiles what is out of date either way.');
            assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()),
                /clean on MPS3 ⚠️ exit 0, not confirmed [\d.]+ s ago \(job c-1, .*\nClean job c-1 exited 0, but that does not confirm it: out\/Blinky/);
        });

        test('nothing built before, or a solution named through a variable: cleaned, and the result says what it could tell', async () => {
            const w = make();
            const none = await diagnosed(w, runClean(w, () => undefined).id);
            assert.strictEqual(none.diagnosis?.check, 'cleaned');
            assert.strictEqual(none.diagnosis?.text, 'No image of MPS3 was there to remove.');
            builtLayout(w);
            const unknown = await diagnosed(w, runClean(w, () => undefined, { solution: '${command:cmsis-csolution.getSolutionFile}' }).id);
            assert.strictEqual(unknown.diagnosis?.check, 'cleaned');
            assert.strictEqual(unknown.diagnosis?.text, 'Which images were there before the clean is not known, so their removal was not checked.');
        });
    });

    suite('the lines reach the waiting call, or status afterwards', () => {
        test('within the deadline: the failed build\'s result carries the lines and the data', async () => {
            const w = make();
            const job = w.tracker.begin('build', 'MPS3');
            const waiting = w.tracker.waitFor(job.id, w.clock.now() + 60_000);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            w.clock.advance(w.clock.now() + 3_000);
            w.tasks.finish(execution, 2);
            await until(() => w.children.length === 1, 'cbuild was spawned');
            let woken = false;
            void waiting.then(() => {
                woken = true;
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.strictEqual(woken, false, 'the waiter waits for the diagnosis, not only for the job');
            w.children[0].finish(1, GCC_LOG);
            const outcome = await waiting as Job;
            assert.strictEqual(outcome.diagnosis?.state, 'done');
            let failure: unknown;
            try {
                jobResult(outcome, { tag: ' on MPS3', now: w.clock.now() });
            } catch (caught) {
                failure = caught;
            }
            assert.ok(failure instanceof ToolError && failure.code === 'TASK_FAILED');
            assert.match(failure.message, /^❌ CMSIS 'build' FAILED on MPS3 — task '.*' exited with code 2 after 3 s \(job b-1\)\.\n2 errors \(from a diagnostic re-run/);
            assert.strictEqual(failure.hint, 'Fix the first error, then cmsis_action build again. This is a terminal result — do not wait for an output file.');
            const data = failure.data?.diagnosis as Record<string, unknown>;
            assert.deepStrictEqual([data.state, data.source, data.errorCount, data.warningCount], ['done', 'rerun', 2, 1]);
            assert.deepStrictEqual((data.errors as unknown[])[0], {
                severity: 'error', message: '\'ledx\' undeclared (first use in this function)', file: '/Users/dev/work/Blinky/Blinky/main.c', line: 42, column: 5,
            });
        });

        test('after the deadline: the result says the lines are coming, and status shows them', async () => {
            const w = make();
            const job = w.tracker.begin('build', 'MPS3');
            const waiting = w.tracker.waitFor(job.id, w.clock.now() + 10_000);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            w.clock.advance(w.clock.now() + 3_000);
            w.tasks.finish(execution, 2);
            await until(() => w.children.length === 1, 'cbuild was spawned');
            w.clock.advance(w.clock.now() + 7_000);
            const early = await waiting as Job;
            assert.strictEqual(early.diagnosis?.state, 'pending');
            let failure: unknown;
            try {
                jobResult(early, { tag: ' on MPS3', now: w.clock.now() });
            } catch (caught) {
                failure = caught;
            }
            assert.ok(failure instanceof ToolError);
            assert.ok(failure.message.endsWith('\nError lines: still being collected (a diagnostic re-run of cbuild with --log, at most 120 s).'), failure.message);
            assert.strictEqual(failure.hint, 'Call cmsis_action {action:\'status\'} for the error lines — do not start another build to see them. '
                + 'This is a terminal result — do not wait for an output file.');
            assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()),
                /\nThe error lines of build job b-1 are still being collected — cmsis_action \{action:'status'\} again shows them\.\n/);

            const status = w.tracker.waitFor(job.id, w.clock.now() + 60_000);
            w.children[0].finish(1, GCC_LOG);
            await status;
            const idle = idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now());
            assert.match(idle, /^No CMSIS job in flight in this window\. Last results: build on MPS3 ❌ exit 2 [\d.]+ s ago \(job b-1, '.*'\)\.\nBuild job b-1 failed: 2 errors \(from a diagnostic re-run of cbuild with --log; /);
            assert.ok(idle.includes('\n  Blinky/main.c:42:5 error:') || idle.includes('main.c:42:5 error:'), idle);
        });

        test('a listener hears the job when its diagnosis is in, for the journal (#48)', async () => {
            const w = make({ environment: false });
            const heard: string[] = [];
            w.tracker.onDidDiagnoseJob((job) => heard.push(`${job.id}:${job.diagnosis?.state}:${job.diagnosis?.source}`));
            const { job } = failBuild(w);
            await diagnosed(w, job.id);
            assert.deepStrictEqual(heard, [`${job.id}:done:none`]);
        });
    });
});
