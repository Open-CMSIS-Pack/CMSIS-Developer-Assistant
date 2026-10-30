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
import * as path from 'path';
import {
    BuildFailureReport,
    cbuildDiagnosticArgs,
    cbuildExecutable,
    diagnosticEnvironment,
    idxBuildFiles,
    idxFileName,
    idxMessages,
    messagesFromLog,
    parseCmsisYaml,
    primaryOutputs,
    readToolsEnvironment,
    rerunSkipText,
} from '../core/buildFailure';
import { readBuildLog } from '../core/buildInfo/buildLog';
import { renderBuildFailure } from '../core/buildInfo/render';
import type { BuildMessage } from '../core/cmsisTasks';

/**
 * The pure half of #15: the csolution messages of a cbuild-idx.yml, the
 * tools environment CMSIS Solution records, the diagnostic re-run's command
 * line and environment, and the block a failed build's result shows. The
 * fixtures are generated files from a real installation, anonymised.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'buildinfo');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** The definition `cmsis-csolution.build` creates in CMSIS Solution 1.70.1 (`createDefinitionFromUriOrSolutionNode`). */
const COMMAND_DEFINITION = {
    type: 'cmsis-csolution.build', solution: '/w/Blinky.csolution.yml', schemaCheck: false, active: 'MPS3', clean: false, rebuild: false,
    setup: false, buildOutputVerbosity: 'normal', downloadPacks: true, cmakeTarget: 'all', virtualProject: false,
};
const LOG = '/w/out/cmsis-developer-assistant/build-diagnostic.log';

function report(fields: Partial<BuildFailureReport>): BuildFailureReport {
    return { source: 'rerun', errors: [], warnings: [], errorCount: 0, warningCount: 0, failedSteps: [], csolutionWarnings: [], ...fields };
}

suite('build failure (#15)', () => {

    suite('the YAML the CMSIS tools write', () => {
        test('block mappings and sequences, quoted and plain scalars, comments, flow empties', () => {
            const doc = parseCmsisYaml([
                '# header comment',
                'root:',
                '  plain: some text # trailing comment',
                '  "quoted key": \'it\'\'s\'',
                '  escaped: "tab\\there\\nnext \\u00e9"',
                '  empty: {}',
                '  none: []',
                '  list:',
                '    - one',
                '    - key: value',
                '      other: 2',
                '  compact:',
                '  - a',
                '  - b',
                '  folded: "first',
                '    second"',
                '  block: |',
                '    line 1',
                '      line 2',
            ].join('\n'));
            assert.deepStrictEqual(doc, {
                root: {
                    plain: 'some text', 'quoted key': 'it\'s', escaped: 'tab\there\nnext é', empty: {}, none: [],
                    list: ['one', { key: 'value', other: '2' }], compact: ['a', 'b'], folded: 'first second', block: 'line 1\n  line 2\n',
                },
            });
        });

        test('#102: a comment after a key, a flow sequence and a block scalar read as YAML defines them', () => {
            assert.deepStrictEqual(parseCmsisYaml('solution:\n  select-compiler: # tested compilers\n    - compiler: AC6\n    - compiler: GCC\n'),
                { solution: { 'select-compiler': [{ compiler: 'AC6' }, { compiler: 'GCC' }] } });
            assert.deepStrictEqual(parseCmsisYaml('solution:\n  cdefault: # use the default\n  compiler: AC6\n'),
                { solution: { cdefault: null, compiler: 'AC6' } });
            assert.deepStrictEqual(parseCmsisYaml('project:\n  output:\n    type: [elf, hex, map]\n'),
                { project: { output: { type: ['elf', 'hex', 'map'] } } });
            assert.deepStrictEqual(parseCmsisYaml('a:\n  execute: |\n    DAP_Delay(500000);  // Delay for 500ms\n'),
                { a: { execute: 'DAP_Delay(500000);  // Delay for 500ms\n' } });
        });

        test('scalars stay strings, an empty value is null, and a file that is not YAML reads as nothing', () => {
            assert.deepStrictEqual(parseCmsisYaml('port: 3333\nversion: 1.0\nflag: true\nempty:\ntilde: ~\nquoted: "null"\n'),
                { port: '3333', version: '1.0', flag: 'true', empty: null, tilde: null, quoted: 'null' });
            assert.strictEqual(parseCmsisYaml(''), null);
            assert.strictEqual(parseCmsisYaml('a: [unclosed'), null);
            assert.deepStrictEqual(idxMessages('build-idx: [unclosed'), { errors: [], warnings: [] });
        });

        test('a Windows path and a URL are values, not keys', () => {
            assert.deepStrictEqual(parseCmsisYaml('- C:/Users/dev/bin\n- https://pyocd.io/docs/\n- C:\\tools'),
                ['C:/Users/dev/bin', 'https://pyocd.io/docs/', 'C:\\tools']);
        });
    });

    suite('stage A: csolution\'s messages in the cbuild-idx.yml', () => {
        test('the corstone-blinky index: two errors and four warnings of context .Debug+MPS3, info left out', () => {
            const found = idxMessages(fixture('Blinky.cbuild-idx.yml'));
            assert.deepStrictEqual(found.errors.map((message) => [message.severity, message.context]), [['error', '.Debug+MPS3'], ['error', '.Debug+MPS3']]);
            assert.strictEqual(found.errors[0].message, 'component \'Compiler:CORE\' not found in included packs\n  did you mean \'CMSIS-Compiler:CORE\'?');
            assert.strictEqual(found.warnings.length, 4);
            assert.ok(found.warnings[2].message.startsWith('no compiler registered. Add path to compiler \'bin\' directory'), found.warnings[2].message);
            assert.ok(!found.warnings.some((message) => message.message.includes('up-to-date')), 'info entries are not warnings');
        });

        test('messages of the index itself, several contexts, a message repeated per context kept once', () => {
            const found = idxMessages([
                'build-idx:',
                '  messages:',
                '    errors:',
                '      - solution-wide problem',
                '  cbuilds:',
                '    - cbuild: a.cbuild.yml',
                '      configuration: .Debug+HE',
                '      messages:',
                '        warnings:',
                '          - shared warning',
                '    - cbuild: b.cbuild.yml',
                '      project: Blinky',
                '      messages:',
                '        errors: []',
                '        warnings:',
                '          - shared warning',
                '          - \'only in Blinky\'',
            ].join('\n'));
            assert.deepStrictEqual(found.errors, [{ severity: 'error', message: 'solution-wide problem' }]);
            assert.deepStrictEqual(found.warnings, [
                { severity: 'warning', message: 'shared warning', context: '.Debug+HE' },
                { severity: 'warning', message: 'only in Blinky', context: 'Blinky' },
            ]);
            assert.deepStrictEqual(idxMessages('build-idx:\n  cbuilds:\n    - cbuild: x.cbuild.yml\n'), { errors: [], warnings: [] });
        });

        test('the index is named after the solution', () => {
            assert.strictEqual(idxFileName('/w/Blinky.csolution.yml'), 'Blinky.cbuild-idx.yml');
            assert.strictEqual(idxFileName('C:\\w\\Two.Parts.csolution.yaml'.replace(/\\/g, '/')), 'Two.Parts.cbuild-idx.yml');
        });

        test('the index names each context\'s cbuild.yml and the cbuild-run.yml, whose images show whether a build that exited 0 rebuilt', () => {
            assert.deepStrictEqual(idxBuildFiles(fixture('Blinky.cbuild-idx.yml')), {
                cbuilds: ['build/MPS3/GCC/Debug/Blinky/outdir/Blinky.Debug+MPS3.cbuild.yml'],
                cbuildRun: 'build/GCC/outdir/Blinky+MPS3.cbuild-run.yml',
            });
            assert.deepStrictEqual(idxBuildFiles('build-idx:\n  csolution: x.csolution.yml\n'), { cbuilds: [] });
            const outputs = [
                { file: '/o/Blinky.axf.map', type: 'map' }, { file: '/o/Blinky.hex', type: 'hex' }, { file: '/o/Blinky.axf', type: 'elf' },
                { file: '/o/compile_commands.json', type: 'comp-db' },
            ];
            assert.deepStrictEqual(primaryOutputs(outputs), ['/o/Blinky.axf'], 'the ELF image when there is one');
            assert.deepStrictEqual(primaryOutputs([{ file: '/o/libx.a', type: 'lib' }, { file: '/o/x.map', type: 'map' }]), ['/o/libx.a']);
            assert.deepStrictEqual(primaryOutputs([{ file: '/o/x.bin', type: 'bin' }, { file: '/o/x.hex', type: 'hex' }]), ['/o/x.bin', '/o/x.hex']);
            assert.deepStrictEqual(primaryOutputs([{ file: '/o/x.map', type: 'map' }]), []);
        });
    });

    suite('stage B: the tools environment, the command line and the environment of the re-run', () => {
        test('tools-environment.yml of CMSIS Solution 1.70.1 on macOS: PATH directories, no variables, the tools', () => {
            const environment = readToolsEnvironment(fixture('tools-environment.yml'));
            assert.strictEqual(environment.path.length, 3);
            assert.ok(environment.path[1].endsWith('/tools/cmsis-toolbox/bin'), environment.path[1]);
            assert.deepStrictEqual(environment.variables, {});
            assert.deepStrictEqual(environment.tools.map((tool) => [tool.name, tool.version]),
                [['pyOCD', '0.45.1'], ['CMSIS-Toolbox', '2.14.1-64-ge745dc0'], ['Arm GNU GDB', '15.2.1']]);
            assert.strictEqual(cbuildExecutable(environment, 'darwin'),
                '/Users/dev/.vscode/extensions/arm.cmsis-csolution-1.70.1-63-20260910/tools/cmsis-toolbox/bin/cbuild');
        });

        test('the Windows variant: forward slashes in the file, backslashes and cbuild.exe for the process, quoted values', () => {
            const environment = readToolsEnvironment(fixture('tools-environment-windows.yml'));
            assert.strictEqual(environment.path.length, 6);
            assert.deepStrictEqual(Object.keys(environment.variables), ['GCC_TOOLCHAIN_14_3_1', 'CMSIS_COMPILER_ROOT', 'BLINKY_TRACE']);
            assert.strictEqual(environment.variables.BLINKY_TRACE, 'true');
            assert.strictEqual(cbuildExecutable(environment, 'win32'),
                'C:\\Users\\dev\\.vscode\\extensions\\arm.cmsis-csolution-1.70.1-63-20260910\\tools\\cmsis-toolbox\\bin\\cbuild.exe');
            const env = diagnosticEnvironment({ Path: 'C:\\Windows', cmsis_pack_root: 'C:\\old' }, environment, 'C:\\packs', 'win32');
            assert.deepStrictEqual(Object.keys(env).sort(), ['BLINKY_TRACE', 'CMSIS_COMPILER_ROOT', 'GCC_TOOLCHAIN_14_3_1', 'Path', 'cmsis_pack_root']);
            assert.strictEqual(env.cmsis_pack_root, 'C:\\packs', 'a variable that differs only in case is replaced');
            const entries = env.Path.split(';');
            assert.strictEqual(entries.length, 7);
            assert.strictEqual(entries[0], 'C:\\Users\\dev\\.vscode\\extensions\\arm.vscode-cmsis-debugger-1.8.0-win32-x64\\tools\\pyocd');
            assert.strictEqual(entries[6], 'C:\\Windows');
        });

        test('elsewhere the directories go in front of PATH with a colon, and CMSIS_PACK_ROOT is set', () => {
            const environment = readToolsEnvironment(fixture('tools-environment.yml'));
            const env = diagnosticEnvironment({ PATH: '/usr/bin', HOME: '/home/dev', UNSET: undefined }, environment, '/packs', 'linux');
            assert.deepStrictEqual(Object.keys(env).sort(), ['CMSIS_PACK_ROOT', 'HOME', 'PATH']);
            assert.strictEqual(env.CMSIS_PACK_ROOT, '/packs');
            assert.strictEqual(env.PATH, [...environment.path, '/usr/bin'].join(':'));
            assert.strictEqual(diagnosticEnvironment({}, environment, undefined, 'linux').PATH, environment.path.join(':'));
            assert.strictEqual(cbuildExecutable({ path: [], variables: {}, tools: [] }, 'linux'), undefined);
        });

        test('the re-run mirrors the task definition without --packs, --update-rte, --clean, --rebuild and setup, and adds --log', () => {
            assert.deepStrictEqual(cbuildDiagnosticArgs(COMMAND_DEFINITION,
                { solution: '/w/Blinky.csolution.yml', active: 'MPS3', logFile: LOG, skipConvert: true }),
            ['/w/Blinky.csolution.yml', '--target', 'all', '--active', 'MPS3', '--log', LOG, '--skip-convert']);

            const everything = {
                ...COMMAND_DEFINITION, clean: false, rebuild: true, updateRte: true, setup: true, schemaCheck: true, downloadPacks: true,
                buildOutputVerbosity: 'verbose', generator: 'Ninja', intermediateDirectory: 'tmp', outputDirectory: 'out/x',
                toolchain: 'GCC', jobs: 4,
            };
            assert.deepStrictEqual(cbuildDiagnosticArgs(everything,
                { solution: '/w/Blinky.csolution.yml', active: 'HP@debug', output: '/w/build', logFile: LOG, skipConvert: false }),
            ['/w/Blinky.csolution.yml', '--verbose', '--generator', 'Ninja', '--intdir', 'tmp', '--outdir', 'out/x', '--target', 'all',
                '--active', 'HP@debug', '--schema', '--toolchain', 'GCC', '--jobs', '4', '--output', '/w/build', '--log', LOG]);

            const quiet = cbuildDiagnosticArgs({ type: 'cmsis-csolution.build', buildOutputVerbosity: 'quiet', jobs: '8' },
                { solution: 'Blinky.csolution.yml', active: '', logFile: LOG, skipConvert: false });
            assert.deepStrictEqual(quiet, ['Blinky.csolution.yml', '--active', '', '--schema', '--log', LOG],
                'quiet is left out so warnings reach the log; a jobs value that is not a number is not passed; no active mirrors --active ""');
        });
    });

    suite('what the result shows', () => {
        test('a failing GCC and ninja log: errors first with file:line relative to the solution, the failed step, the honest warning count', () => {
            const summary = readBuildLog(path.join(FIXTURES, 'build-failed-gcc.log'));
            const { errors, warnings } = messagesFromLog(summary);
            assert.deepStrictEqual(errors[0], {
                severity: 'error', file: '/Users/dev/work/Blinky/Blinky/main.c', line: 42, column: 5, message: '\'ledx\' undeclared (first use in this function)',
            });
            assert.deepStrictEqual(warnings[0].code, '-Wunused-variable');
            const text = renderBuildFailure(report({
                errors, warnings, errorCount: summary.errors, warningCount: summary.warnings, failedSteps: summary.failedSteps,
                logFile: '/Users/dev/work/Blinky/out/cmsis-developer-assistant/build-diagnostic.log',
                rerun: { exitCode: 1, stoppedAtCap: false, status: summary.status },
            }), { root: '/Users/dev/work/Blinky' });
            assert.strictEqual(text, [
                '2 errors (from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 1):',
                '  Blinky/main.c:42:5 error: \'ledx\' undeclared (first use in this function)',
                '  error cbuild: error building \'cmake --build /Users/dev/work/Blinky/tmp --target Blinky.Debug+MPS3\'',
                '  ninja FAILED: …/Blinky/Blinky/main.c.obj',
                '  Blinky/main.c:40:12 warning: unused variable \'tick\' [-Wunused-variable]',
                'Full log: out/cmsis-developer-assistant/build-diagnostic.log (get_build_diagnostics reads it).',
            ].join('\n'));
        });

        test('csolution\'s errors are labelled as such, with the index and the shared context', () => {
            const found = idxMessages(fixture('Blinky.cbuild-idx.yml'));
            const text = renderBuildFailure(report({
                source: 'csolution', errors: found.errors, warnings: found.warnings, errorCount: 2, warningCount: 4, idxFile: '/w/Blinky.cbuild-idx.yml',
            }), { root: '/w' });
            const lines = text.split('\n');
            assert.strictEqual(lines[0], '2 errors from csolution (Blinky.cbuild-idx.yml, context .Debug+MPS3), 4 warnings:');
            assert.strictEqual(lines[1], '  error: component \'Compiler:CORE\' not found in included packs; did you mean \'CMSIS-Compiler:CORE\'?');
            assert.strictEqual(lines.length, 7);
        });

        test('at most 10 message lines and 3 000 characters, errors before warnings', () => {
            const many = (severity: BuildMessage['severity'], count: number): BuildMessage[] => Array.from({ length: count },
                (_, index) => ({ severity, file: `/w/src/file${index}.c`, line: index + 1, message: `${severity} ${index} ${'x'.repeat(400)}` }));
            const text = renderBuildFailure(report({
                errors: many('error', 30), warnings: many('warning', 30), errorCount: 30, warningCount: 30, logFile: LOG,
                rerun: { exitCode: 2, stoppedAtCap: false },
            }), { root: '/w' });
            assert.ok(text.length <= 3_000, `${text.length} characters`);
            const messageLines = text.split('\n').filter((line) => /^ {2}src\/file\d+\.c:/.test(line));
            assert.ok(messageLines.length > 0 && messageLines.length <= 10, `${messageLines.length} message lines`);
            assert.ok(messageLines.every((line) => line.includes(' error: ')), 'errors come first');
            assert.ok(messageLines.every((line) => line.length <= 300), 'each line is cut');
            assert.match(text, /\n {2}… \d+ more in the log\nFull log: out\/cmsis-developer-assistant\/build-diagnostic\.log/);
            const short = renderBuildFailure(report({ errors: many('error', 12), errorCount: 12 }), { limit: 3, maxChars: 100_000 });
            assert.strictEqual(short.split('\n').length, 5, 'header, three lines and the rest counted');
        });

        test('no lines: why, csolution\'s warnings, and where a log would be read', () => {
            const text = renderBuildFailure(report({
                source: 'none', skipped: rerunSkipText({ kind: 'no-environment', file: '.cmsis/tools-environment.yml' }),
                csolutionWarnings: [{ severity: 'warning', message: 'no compiler registered', context: '.Debug+MPS3' }],
            }));
            assert.strictEqual(text, 'No error lines: .cmsis/tools-environment.yml is missing (CMSIS Solution 1.70.1 and later write it), '
                + 'so cbuild was not re-run.\n'
                + '  csolution warning: no compiler registered\n'
                + 'cmsis_action build re-runs cbuild with --log itself when it can.');
        });

        test('a re-run that passes, one stopped at the cap, and one that printed nothing known', () => {
            assert.strictEqual(renderBuildFailure(report({ rerun: { exitCode: 0, stoppedAtCap: false }, logFile: LOG }), { root: '/w' }),
                'A diagnostic re-run of cbuild with --log succeeded (exit 0): the failure did not repeat. cmsis_action build again to confirm.\n'
                + 'Full log: out/cmsis-developer-assistant/build-diagnostic.log (get_build_diagnostics reads it).');
            assert.ok(renderBuildFailure(report({ rerun: { exitCode: null, stoppedAtCap: true } }))
                .startsWith('A diagnostic re-run of cbuild with --log was stopped after 120 s before it printed an error line.'));
            assert.strictEqual(renderBuildFailure(report({ rerun: { exitCode: 2, stoppedAtCap: false, status: 'ninja: build stopped: interrupted by user.' } })),
                'A diagnostic re-run of cbuild with --log failed with exit code 2, "ninja: build stopped: interrupted by user." '
                + 'but printed no error line in a known format.');
        });

        test('each reason for no re-run reads as a clause', () => {
            const reasons = [
                rerunSkipText({ kind: 'setting-off' }),
                rerunSkipText({ kind: 'no-cbuild', directory: '/x/bin' }),
                rerunSkipText({ kind: 'no-cbuild' }),
                rerunSkipText({ kind: 'no-solution' }),
                rerunSkipText({ kind: 'clean' }),
                rerunSkipText({ kind: 'unresolved', field: 'toolchain' }),
                rerunSkipText({ kind: 'build-running', name: 'cbuild setup Blinky.csolution.yml' }),
                rerunSkipText({ kind: 'superseded' }),
                rerunSkipText({ kind: 'spawn-failed', error: 'spawn EACCES' }),
            ];
            assert.ok(reasons.every((reason) => reason.length > 10 && !reason.endsWith('.')), reasons.join('\n'));
            assert.strictEqual(reasons[0], 'the diagnostic re-run of cbuild is off (setting cmsis-developer-assistant.build.diagnosticRerun)');
        });
    });
});
