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
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { flashWithPyocd, parsePyocdLoadOutput, pyocdDirectoryIn, pyocdLoadArgs, pyocdProbeType, resolvePyocd } from '../core/flashController';

/**
 * Test suite for pyOCD flash-output parsing. Strings mirror
 * pyocd/flash/loader.py completion and failure output.
 */
suite('flashController parsePyocdLoadOutput', () => {

    test('sector-erase completion yields bytes and rate', () => {
        const stdout = [
            '0001234 I Erasing sectors [0x00000000-0x00040000] [eraser]',
            '0002345 I Erased 262144 bytes (128 sectors), programmed 196608 bytes (48 pages), identical 0 bytes (0 pages) at 85.31 kB/s [loader]',
        ].join('\n');
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.programmedBytes, 196608);
        assert.strictEqual(parsed.kbps, 85.31);
        assert.strictEqual(parsed.errorLines.length, 0);
    });

    test('chip-erase completion yields bytes', () => {
        const stdout = '0001987 I Erased chip, programmed 524288 bytes (128 pages) at 120.05 kB/s [loader]';
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.programmedBytes, 524288);
        assert.strictEqual(parsed.kbps, 120.05);
    });

    test('empty output yields nulls, not zeros', () => {
        const parsed = parsePyocdLoadOutput('', '');
        assert.strictEqual(parsed.programmedBytes, null);
        assert.strictEqual(parsed.kbps, null);
        assert.deepStrictEqual(parsed.errorLines, []);
        assert.deepStrictEqual(parsed.tail, []);
    });

    test('traceback on stderr: its first line and the exception land in errorLines, not the frames', () => {
        const stderr = [
            'Traceback (most recent call last):',
            '  File "pyocd/probe/pydapaccess.py", line 100, in open',
            'pyocd.core.exceptions.ProbeError: No probe connected',
        ].join('\n');
        const parsed = parsePyocdLoadOutput('', stderr);
        assert.deepStrictEqual(parsed.errorLines, ['Traceback (most recent call last):', 'pyocd.core.exceptions.ProbeError: No probe connected']);
        assert.strictEqual(parsed.programmedBytes, null);
    });

    test('--no-wait without a free probe: both of pyOCD\'s lines land in errorLines, without their colours (#81)', () => {
        // pyocd/core/helpers.py prints the first in red, load_cmd.py logs the second (pyOCD 0.45.1).
        const parsed = parsePyocdLoadOutput('\u001b[31mNo connected debug probes\u001b[0m\n', '0000412 E No target device available [load_cmd]\n');
        assert.deepStrictEqual(parsed.errorLines, ['No connected debug probes', '0000412 E No target device available [load_cmd]']);
        // A log line in colour (--color always, color_log.py) is still an error line.
        const coloured = parsePyocdLoadOutput('', '\u001b[34m0000412\u001b[0m \u001b[91mE\u001b[0m \u001b[31mNo target device available \u001b[2m[load_cmd]\u001b[0m\n');
        assert.deepStrictEqual(coloured.errorLines, ['0000412 E No target device available [load_cmd]']);
    });

    test('info, debug and warning lines are no error lines, whatever they say: a path or a warning never fails a load', () => {
        // load_cmd.py:169 logs each file at INFO; session.py:285 and file_programmer.py:242 warn with "Error" and "Failed".
        const stderr = [
            '0000123 I Loading /proj/out/ErrorHandling/Debug/failed-tests.hex [load_cmd]',
            '0000150 D Exception vector table at 0x00000000 [cortex_m]',
            '0000210 W Error attempting to access config file \'/proj/pyocd.yaml\': [Errno 13] Permission denied [session]',
            '0000230 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]',
            '0002345 I Erased 4096 bytes (1 sector), programmed 4096 bytes (16 pages), identical 0 bytes (0 pages) at 52.00 kB/s [loader]',
        ].join('\n');
        const parsed = parsePyocdLoadOutput('[==================================================]\n', stderr);
        assert.deepStrictEqual(parsed.errorLines, []);
        assert.deepStrictEqual(parsed.probeChoices, []);
        assert.strictEqual(parsed.programmedBytes, 4096);
        // The warnings are kept for the success to list, and the chunk pyOCD could not add is counted.
        assert.deepStrictEqual(parsed.warningLines, [
            '0000210 W Error attempting to access config file \'/proj/pyocd.yaml\': [Errno 13] Permission denied [session]',
            '0000230 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]',
        ]);
        assert.strictEqual(parsed.droppedChunks, 1);
    });

    test('warning lines: the last 5, without colours; every data chunk pyOCD could not add is counted, kept or not', () => {
        // file_programmer.py:239-257 warns for each chunk loader.py:237,257 or builder.py:264 refuses, and goes on;
        // the programming that follows warns too (flash_dsq.py:114,133, builder.py:585), here in colour (color_log.py).
        const stderr = [
            '0000300 I Loading /w/out/app.hex [load_cmd]',
            '0000301 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]',
            '0000302 W Failed to add data chunk: memory region at address 0x1fff7800 is not writable [file_programmer]',
            '0000310 I Loading /w/out/core1.elf [load_cmd]',
            '0000311 W Failed to add data chunk: Error adding data - Data at 0x8000..0x8100 overlaps with 0x80f0..0x8200 [file_programmer]',
            '0000400 W flash init sequence not available [flash_dsq]',
            '0000401 W flash uninit sequence not available [flash_dsq]',
            '0000402 W flash init sequence not available [flash_dsq]',
            '0000403 W flash uninit sequence not available [flash_dsq]',
            '\u001b[34m0000500\u001b[0m \u001b[93mW\u001b[0m \u001b[33mNo data to program, skipping programming \u001b[2m[builder]\u001b[0m',
        ].join('\n');
        const parsed = parsePyocdLoadOutput('', stderr);
        assert.deepStrictEqual(parsed.warningLines, [
            '0000400 W flash init sequence not available [flash_dsq]',
            '0000401 W flash uninit sequence not available [flash_dsq]',
            '0000402 W flash init sequence not available [flash_dsq]',
            '0000403 W flash uninit sequence not available [flash_dsq]',
            '0000500 W No data to program, skipping programming [builder]',
        ]);
        assert.strictEqual(parsed.droppedChunks, 3);
        assert.deepStrictEqual(parsed.errorLines, []);
        // No warning, nothing dropped.
        const clean = parsePyocdLoadOutput('', '0002345 I Erased chip, programmed 1024 bytes (4 pages) at 10.00 kB/s [loader]\n');
        assert.deepStrictEqual(clean.warningLines, []);
        assert.strictEqual(clean.droppedChunks, 0);
    });

    test('error lines: the error and critical log lines, a traceback\'s first and last line, pyOCD\'s words when no probe is chosen', () => {
        // __main__.py:174-176 logs a critical line; with debug.traceback the traceback follows it (color_log.py:96-97).
        const stderr = [
            '0000400 I Loading /w/out/app.hex [load_cmd]',
            '0000500 E Failed to get unique id for open [dap_access_cmsis_dap]',
            '0000900 C USB error [__main__]',
            'Traceback (most recent call last):',
            '  File "/x/pyocd/__main__.py", line 165, in run',
            '    status = cmd.invoke()',
            '             ^^^^^^^^^^^^',
            '  File "/x/pyocd/probe/pydapaccess/interface/pyusb_v2_backend.py", line 230, in read',
            '    raise DAPAccessIntf.DeviceError("USB error")',
            'pyocd.probe.pydapaccess.dap_access_api.DAPAccessIntf.DeviceError: USB error',
        ].join('\n');
        const parsed = parsePyocdLoadOutput('No connected debug probe matches unique ID \'DAP_T1n4che\'\n', stderr);
        assert.deepStrictEqual(parsed.errorLines, [
            'No connected debug probe matches unique ID \'DAP_T1n4che\'',
            '0000500 E Failed to get unique id for open [dap_access_cmsis_dap]',
            '0000900 C USB error [__main__]',
            'Traceback (most recent call last):',
            'pyocd.probe.pydapaccess.dap_access_api.DAPAccessIntf.DeviceError: USB error',
        ]);
    });

    test('errorLines keeps only the last 8 matches', () => {
        const stderr = Array.from({ length: 20 }, (_, i) => `00001${String(i).padStart(2, '0')} E error number ${i} [loader]`).join('\n');
        const parsed = parsePyocdLoadOutput('', stderr);
        assert.strictEqual(parsed.errorLines.length, 8);
        assert.strictEqual(parsed.errorLines[7], '0000119 E error number 19 [loader]');
    });

    test('several probes for a unique ID: the description and unique ID of each that pyOCD lists', () => {
        // helpers.py:164-173: with --probe cmsisdap: and two CMSIS-DAP probes pyOCD lists them and chooses none; load_cmd.py:107 logs.
        const stdout = 'More than one debug probe matches unique ID \'cmsisdap:\':\n'
            + 'Arm DAPLink CMSIS-DAP | 9904360258994e45002e0012a6e1000038a1000097969900\n'
            + 'NXP Semiconductors LPC-LINK2 CMSIS-DAP V5.460 | jsaqcqiq\n';
        const parsed = parsePyocdLoadOutput(stdout, '0000412 E No target device available [load_cmd]\n');
        assert.deepStrictEqual(parsed.probeChoices, [
            { description: 'Arm DAPLink CMSIS-DAP', uid: '9904360258994e45002e0012a6e1000038a1000097969900' },
            { description: 'NXP Semiconductors LPC-LINK2 CMSIS-DAP V5.460', uid: 'jsaqcqiq' },
        ]);
        assert.deepStrictEqual(parsed.errorLines, ['More than one debug probe matches unique ID \'cmsisdap:\':', '0000412 E No target device available [load_cmd]']);
    });

    test('several probes and no unique ID: the rows of pyOCD\'s table before the prompt that the closed stdin ends', () => {
        // helpers.py:188-195 prints the table (_print_probe_list) and calls input(); __main__.py:174-176 logs the EOFError.
        // The table as prettytable 3 renders it without a terminal; a probe's board has a row without a number.
        const stdout = [
            '  #   Probe/Board                               Unique ID                                          Target',
            '---------------------------------------------------------------------------------------------------------------',
            '  0   Arm DAPLink CMSIS-DAP                     9904360258994e45002e0012a6e1000038a1000097969900   ✔︎ nrf52833',
            '      BBC                                       micro:bit V2',
            '',
            '  1   Segger J-Link OB-SAM3U128-V2-NordicSemi   000683000000                                       n/a',
            '',
            'Enter the number of the debug probe or \'q\' to quit> ',
        ].join('\n');
        const parsed = parsePyocdLoadOutput(stdout, '0000921 C Error: EOF when reading a line [__main__]\n');
        assert.deepStrictEqual(parsed.probeChoices, [
            { description: 'Arm DAPLink CMSIS-DAP', uid: '9904360258994e45002e0012a6e1000038a1000097969900' },
            { description: 'Segger J-Link OB-SAM3U128-V2-NordicSemi', uid: '000683000000' },
        ]);
        assert.deepStrictEqual(parsed.errorLines, ['0000921 C Error: EOF when reading a line [__main__]']);
    });

    test('tail keeps the last 12 non-empty lines', () => {
        const stdout = Array.from({ length: 30 }, (_, i) => `line ${i}\n\n`).join('\n');
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.tail.length, 12);
        assert.strictEqual(parsed.tail[11], 'line 29');
        assert.strictEqual(parsed.tail[0], 'line 18');
    });
});

suite('flashWithPyocd kill escalation', () => {
    /** A child that answers `kill` the way `child_process` does, driven by the test. */
    function fakeChild(onKill: (child: FakeChild, signal: NodeJS.Signals) => void) {
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(),
            exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
            signals: [] as NodeJS.Signals[],
            kill(signal: NodeJS.Signals) { child.signals.push(signal); child.killed = true; onKill(child, signal); return true; },
        });
        return child;
    }
    type FakeChild = ReturnType<typeof fakeChild>;
    const spawnFake = (child: FakeChild) => ((() => child) as unknown as typeof spawn);
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    test('a child that honours SIGTERM is not SIGKILLed', async () => {
        const child = fakeChild((c, signal) => {
            if (signal === 'SIGTERM') { c.signalCode = 'SIGTERM'; setImmediate(() => c.emit('close', null)); }
        });
        const result = await flashWithPyocd('x.cbuild-run.yml', 20, { spawn: spawnFake(child), killGraceMs: 30 });
        assert.strictEqual(result.timedOut, true);
        await sleep(80);
        assert.deepStrictEqual(child.signals, ['SIGTERM']);
    });

    test('killed=true alone does not stop the escalation: a child still alive after SIGTERM is SIGKILLed', async () => {
        // `killed` is set as soon as the signal is *sent* — the old guard checked exactly that.
        const child = fakeChild((c, signal) => {
            if (signal === 'SIGKILL') { c.signalCode = 'SIGKILL'; setImmediate(() => c.emit('close', null)); }
        });
        const result = await flashWithPyocd('x.cbuild-run.yml', 20, { spawn: spawnFake(child), killGraceMs: 30 });
        assert.strictEqual(result.timedOut, true);
        assert.strictEqual(result.exitCode, null);
        assert.deepStrictEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    });

    test('a real process that ignores SIGTERM is killed after the grace period', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const spawnIgnoring = ((_cmd: string, _args: string[], opts: object) =>
            spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], opts as never)) as unknown as typeof spawn;
        // A generous deadline: node must have started and installed the
        // SIGTERM handler before the signal arrives (a slow CI runner takes
        // well over 200 ms), else the default action kills it early.
        const t0 = Date.now();
        const result = await flashWithPyocd('x.cbuild-run.yml', 2_000, { spawn: spawnIgnoring, killGraceMs: 300 });
        const elapsed = Date.now() - t0;
        assert.strictEqual(result.timedOut, true);
        assert.strictEqual(result.exitCode, null, 'died by signal, not by exit');
        assert.ok(elapsed >= 2_250 && elapsed < 10_000, `elapsed ${elapsed} ms`);
    });
});

/** A tools-environment.yml as CMSIS Solution 1.70.1 writes it (trimmed). */
const TOOLS_ENVIRONMENT = [
    'cmsis-tools-environment:',
    '  version: 1.0.0',
    '  generated-by: arm.cmsis-csolution version 1.70.1-63-20260910',
    '  solution: ../Blinky.csolution.yml',
    '  environment:',
    '    path:',
    '      - /home/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-linux-x64/tools/pyocd',
    '  tools:',
    '    - name: CMSIS-Toolbox',
    '      version: 2.14.1',
    '      origin: built-in',
    '      directory: /home/me/.vscode/extensions/arm.cmsis-csolution-1.70.1/tools/cmsis-toolbox/bin',
    '    - name: pyOCD',
    '      version: 0.45.1',
    '      origin: built-in',
    '      provider:',
    '        type: vscode-extension',
    '        id: arm.vscode-cmsis-debugger',
    '        directory: /not/this/one',
    '      directory: /home/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-linux-x64/tools/pyocd',
    '      manual: https://pyocd.io/docs/',
    '    - name: Arm GNU GDB',
    '      directory: /home/me/gdb/bin',
    '',
].join('\n');

suite('pyOCD lookup (#46, #45)', () => {
    const only = (...present: string[]) => (candidate: string): boolean => present.includes(candidate);

    test('tools-environment.yml: the directory of the pyOCD entry, not of a nested key or another tool', () => {
        assert.strictEqual(pyocdDirectoryIn(TOOLS_ENVIRONMENT), '/home/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-linux-x64/tools/pyocd');
        assert.strictEqual(pyocdDirectoryIn('cmsis-tools-environment:\r\n  tools:\r\n    - name: "pyocd"\r\n      directory: \'C:/tools/pyocd\'\r\n'),
            'C:/tools/pyocd');
        assert.strictEqual(pyocdDirectoryIn('cmsis-tools-environment:\n  tools:\n    - name: CMSIS-Toolbox\n      directory: /x\n'), undefined);
        assert.strictEqual(pyocdDirectoryIn(''), undefined);
    });

    test('macOS and Linux: the CMSIS Debugger\'s bundled pyOCD first, then tools-environment.yml, then the first on PATH', () => {
        const extension = '/Users/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-darwin-arm64';
        const bundled = `${extension}/tools/pyocd/pyocd`;
        const listed = '/home/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-linux-x64/tools/pyocd/pyocd';
        const found = resolvePyocd({
            debuggerExtensionPath: extension, debuggerVersion: '1.8.0', toolsEnvironmentYml: TOOLS_ENVIRONMENT,
            platform: 'darwin', pathEnv: '/usr/bin:/opt/pyocd/bin:/usr/local/bin',
            isFile: only(bundled, listed, '/opt/pyocd/bin/pyocd', '/usr/local/bin/pyocd'),
        });
        assert.deepStrictEqual(found, [
            { bin: bundled, origin: 'debugger-extension', from: 'CMSIS Debugger 1.8.0' },
            { bin: listed, origin: 'tools-environment', from: '.cmsis/tools-environment.yml' },
            { bin: '/opt/pyocd/bin/pyocd', origin: 'path', from: 'PATH' },
        ]);
        const linux = resolvePyocd({ debuggerExtensionPath: '/home/me/ext', platform: 'linux', isFile: only('/home/me/ext/tools/pyocd/pyocd') });
        assert.deepStrictEqual(linux, [{ bin: '/home/me/ext/tools/pyocd/pyocd', origin: 'debugger-extension', from: 'CMSIS Debugger' }]);
    });

    test('Windows: pyocd.exe, backslash paths, PATH split on ; with quoted entries', () => {
        const extension = 'C:\\Users\\me\\.vscode\\extensions\\arm.vscode-cmsis-debugger-1.8.0-win32-x64';
        const bundled = 'C:\\Users\\me\\.vscode\\extensions\\arm.vscode-cmsis-debugger-1.8.0-win32-x64\\tools\\pyocd\\pyocd.exe';
        const listed = 'C:\\tools\\pyocd\\pyocd.exe';
        const onPath = 'C:\\Program Files\\Python\\Scripts\\pyocd.exe';
        const found = resolvePyocd({
            debuggerExtensionPath: extension, debuggerVersion: '1.8.0',
            toolsEnvironmentYml: 'cmsis-tools-environment:\n  tools:\n    - name: pyOCD\n      directory: C:/tools/pyocd\n',
            platform: 'win32', pathEnv: 'C:\\Windows;"C:\\Program Files\\Python\\Scripts"',
            isFile: only(bundled, listed, onPath),
        });
        assert.deepStrictEqual(found.map((candidate) => candidate.bin), [bundled, listed, onPath]);
    });

    test('nothing installed is an empty list; the same file is offered once', () => {
        assert.deepStrictEqual(resolvePyocd({ platform: 'linux', pathEnv: '/usr/bin', isFile: only() }), []);
        const same = resolvePyocd({
            toolsEnvironmentYml: 'x:\n  tools:\n    - name: pyOCD\n      directory: /usr/bin\n', platform: 'linux', pathEnv: '/usr/bin',
            isFile: only('/usr/bin/pyocd'),
        });
        assert.deepStrictEqual(same.map((candidate) => candidate.origin), ['tools-environment']);
    });

    test('a real extension folder resolves under the path it was given, /private/var realpath or not', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-pyocd-'));
        try {
            const executable = process.platform === 'win32' ? 'pyocd.exe' : 'pyocd';
            fs.mkdirSync(path.join(root, 'tools', 'pyocd'), { recursive: true });
            fs.writeFileSync(path.join(root, 'tools', 'pyocd', executable), '');
            for (const given of [root, fs.realpathSync(root)]) {
                const found = resolvePyocd({ debuggerExtensionPath: given, platform: process.platform, pathEnv: '' });
                assert.deepStrictEqual(found.map((candidate) => candidate.bin), [path.join(given, 'tools', 'pyocd', executable)]);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('flashWithPyocd runs the resolved binary and shows it in the command line, quoted when it has a space', async () => {
        const seen: Array<{ command: string; args: string[] }> = [];
        const fakeSpawn = ((command: string, args: string[]) => {
            seen.push({ command, args });
            const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true });
            setImmediate(() => {
                child.stdout.end('programmed 1024 bytes (4 pages) at 10.00 kB/s\n');
                child.emit('close', 0);
            });
            return child;
        }) as unknown as typeof spawn;
        const bin = '/Users/me/Library/Application Support/ext/tools/pyocd/pyocd';
        const result = await flashWithPyocd('/w/out/x.cbuild-run.yml', 5_000, { spawn: fakeSpawn, bin });
        // --no-wait: without a free probe pyOCD ends at once instead of waiting until it is killed (#81).
        assert.deepStrictEqual(seen, [{ command: bin, args: ['load', '--no-wait', '--cbuild-run', '/w/out/x.cbuild-run.yml'] }]);
        assert.strictEqual(result.commandLine, `"${bin}" load --no-wait --cbuild-run /w/out/x.cbuild-run.yml`);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.programmedBytes, 1024);
    });
});

suite('pyocd load: the probe CMSIS Load selects, and the exit status', () => {
    /** A spawn whose child prints `stderr` and exits with `code`; it records the arguments it was given. */
    function scripted(stderr: string, code: number, seen: string[][] = []): typeof spawn {
        return ((_command: string, args: string[]) => {
            seen.push(args);
            const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true });
            setImmediate(() => {
                child.stdout.end();
                child.stderr.end(stderr);
                child.emit('close', code);
            });
            return child;
        }) as unknown as typeof spawn;
    }

    test('the probe type of each debug adapter of CMSIS Solution 1.72.0, by name or alias in any case', () => {
        // templates/debug: the CMSIS Load of CMSIS-DAP-pyOCD and STLink-pyOCD.adapter.json, J-Link's -USB, the Arm Debugger's connectionType.
        for (const name of ['CMSIS-DAP@pyOCD', 'cmsis-dap', 'DAP-Link', 'ULINKplus@pyOCD', 'MCU-Link@pyOCD', 'Nu-Link-Pro', 'PICkit Basic',
            'KitProg3@pyOCD', 'RPiDebugProbe@pyOCD', 'RaspberryPiDebugProbe', 'CMSIS-DAP@Arm-Debugger']) {
            assert.strictEqual(pyocdProbeType(name), 'cmsisdap:', name);
        }
        for (const name of ['ST-Link@pyOCD', 'ST-LINK', 'st-link@armdbg']) {
            assert.strictEqual(pyocdProbeType(name), 'stlink:', name);
        }
        for (const name of ['J-Link Server', ' J-Link ', 'JLink Server']) {
            assert.strictEqual(pyocdProbeType(name), 'jlink:', name);
        }
        for (const name of [undefined, '', 'Arm-FVP', 'Keil uVision', 'My-Probe@pyOCD']) {
            assert.strictEqual(pyocdProbeType(name), undefined, String(name));
        }
    });

    test('the CMSIS Load task\'s --probe, then --uid, after --no-wait; none when nothing is selected', () => {
        const file = '/w/out/x.cbuild-run.yml';
        assert.deepStrictEqual(pyocdLoadArgs(file), ['load', '--no-wait', '--cbuild-run', file]);
        assert.deepStrictEqual(pyocdLoadArgs(file, { type: 'stlink:' }), ['load', '--no-wait', '--probe', 'stlink:', '--cbuild-run', file]);
        assert.deepStrictEqual(pyocdLoadArgs(file, { type: 'cmsisdap:', uid: 'DAP_T1n4che', uidFrom: 'setting' }),
            ['load', '--no-wait', '--probe', 'cmsisdap:', '--uid', 'DAP_T1n4che', '--cbuild-run', file]);
        assert.deepStrictEqual(pyocdLoadArgs(file, { uid: '000683000000', uidFrom: 'cbuild-run' }), ['load', '--no-wait', '--uid', '000683000000', '--cbuild-run', file]);
    });

    test('flashWithPyocd hands pyOCD the selection and shows it in the command line', async () => {
        const seen: string[][] = [];
        const result = await flashWithPyocd('/w/out/x.cbuild-run.yml', 5_000,
            { spawn: scripted('programmed 1024 bytes (4 pages) at 10.00 kB/s\n', 0, seen), probe: { type: 'cmsisdap:', uid: 'DAP_T1n4che', uidFrom: 'setting' } });
        assert.deepStrictEqual(seen, [['load', '--no-wait', '--probe', 'cmsisdap:', '--uid', 'DAP_T1n4che', '--cbuild-run', '/w/out/x.cbuild-run.yml']]);
        assert.strictEqual(result.commandLine, 'pyocd load --no-wait --probe cmsisdap: --uid DAP_T1n4che --cbuild-run /w/out/x.cbuild-run.yml');
    });

    test('exit 0 is a success whatever the log says; exit 1 a failure whatever it says', async () => {
        const loaded = await flashWithPyocd('/w/out/x.cbuild-run.yml', 5_000, {
            spawn: scripted('0000123 I Loading /proj/out/ErrorHandling/Debug/app.hex [load_cmd]\n'
                + '0000150 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]\n'
                + '0002345 I Erased chip, programmed 1024 bytes (4 pages), identical 0 bytes (0 pages) at 10.00 kB/s [loader]\n', 0),
        });
        assert.strictEqual(loaded.ok, true);
        assert.deepStrictEqual(loaded.errorLines, []);
        assert.strictEqual(loaded.programmedBytes, 1024);
        // The success carries the warning and the chunk pyOCD went on without.
        assert.deepStrictEqual(loaded.warningLines, ['0000150 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]']);
        assert.strictEqual(loaded.droppedChunks, 1);
        const failed = await flashWithPyocd('/w/out/x.cbuild-run.yml', 5_000, { spawn: scripted('0000123 I Loading /proj/out/app.hex [load_cmd]\n', 1) });
        assert.strictEqual(failed.ok, false);
        assert.deepStrictEqual(failed.errorLines, []);
        assert.deepStrictEqual(failed.warningLines, []);
        assert.strictEqual(failed.droppedChunks, 0);
    });

    test('a spawn that fails is a failure whose error line says so', async () => {
        const failing = (() => {
            const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true });
            setImmediate(() => child.emit('error', new Error('spawn /x/pyocd EACCES')));
            return child;
        }) as unknown as typeof spawn;
        const result = await flashWithPyocd('/w/out/x.cbuild-run.yml', 5_000, { spawn: failing });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.errorLines, ['spawn error: spawn /x/pyocd EACCES']);
    });
});
