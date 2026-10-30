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
import { classifyProblem, serverLineSeverity } from '../core/problemCodes';

/**
 * Every row of the problem-code table (#48) against a line captured from a
 * real session. A row ships only with such a line; the comment above each
 * fixture says where it was captured.
 */
suite('Problem codes', () => {
    test('DAP_POWER_UP_FAILED: the GDB server cannot power up the debug port', () => {
        // Captured: issue #48, "Debug adapter / GDB / GDB server output" row of the table of where errors show up.
        const fixture = 'Failed to power up DAP';
        assert.deepStrictEqual(classifyProblem(fixture, 'dap'), {
            code: 'DAP_POWER_UP_FAILED',
            severity: 'error',
            hint: 'Check the board\'s power and the debug cable, then cmsis_action load_and_debug.',
            source: 'gdb-server',
        });
    });

    test('PROBE_BUSY: pyOCD waits for a probe another task holds, or one it cannot see', () => {
        // Captured: issue #46, the user's report with ULINKplus while several CMSIS Run tasks were alive.
        const fixture = 'Waiting for a debug probe matching unique ID \'cmsisdap:\' to be connected...';
        assert.deepStrictEqual(classifyProblem(fixture, 'dap'), {
            code: 'PROBE_BUSY',
            severity: 'error',
            hint: 'pyOCD sees no free probe: another task or session holds it (cmsis_action stop_run or stop_debugging, then retry), '
                + 'or the probe is not connected or lacks its USB driver (ask the user).',
            source: 'gdb-server',
        });
    });

    test('GDB_SERVER_NOT_FOUND: the debug adapter cannot start the GDB server program', () => {
        // Captured: a tester's load_and_debug with J-Link on Windows (CMSIS Debugger 1.10.0, CDA log of 2026-10-23 17:10:29),
        // the failed launch response; CMSIS Run and attach worked.
        const fixture = 'gdbserver has hit error Error: spawn JLinkGDBServerCL.exe ENOENT';
        const known = classifyProblem(`error response to 'launch': ${fixture}`, 'dap');
        assert.strictEqual(known?.code, 'GDB_SERVER_NOT_FOUND');
        assert.strictEqual(known?.severity, 'error');
        // The finding, one line of fix, the procedure for the steps; run-then-attach is no fix (it programs nothing).
        assert.strictEqual(known?.hint, 'The debug adapter could not start the GDB server program of the launch configuration: it is not installed, '
            + 'or its folder is not on the PATH VS Code was started with. Ask the user to install it (J-Link: the SEGGER J-Link Software) or add its '
            + 'folder to the system or user PATH, then restart VS Code completely (all windows); '
            + 'knowledge_get { id: "proc-debugger-troubleshooting" } has the steps.');
        assert.strictEqual(classifyProblem('spawn arm-none-eabi-gdb ENOENT', 'dap'), undefined, 'only the GDB server start');
    });

    test('TARGET_RUNNING: GDB refuses a command while the target runs', () => {
        // Captured: issue #48, the same row of the table: GDB's refusal of a request on a running target.
        const fixture = 'Cannot execute this command while the target is running';
        assert.deepStrictEqual(classifyProblem(fixture, 'dap'), {
            code: 'TARGET_RUNNING', severity: 'warning', hint: 'Call pause_execution first.',
        });
        // The failed response carries it with the command's name in front, as the adapter tracker words it.
        assert.strictEqual(classifyProblem(`error response to 'setBreakpoints': ${fixture}.`, 'dap')?.code, 'TARGET_RUNNING');
    });

    test('CMSIS_NO_SOLUTION: CMSIS Solution has no active solution in the window', () => {
        // Captured: issue #48, "Notifications (toasts) of CMSIS Solution" row of the table.
        const fixture = 'No active solution';
        assert.deepStrictEqual(classifyProblem(fixture, 'ui'), {
            code: 'CMSIS_NO_SOLUTION',
            severity: 'error',
            hint: 'Open the folder of the project\'s *.csolution.yml in that VS Code window and select the solution in the CMSIS Solution panel.',
        });
    });

    test('pyOCD\'s level weighs a GDB-server line: W a warning, E and C an error, D and I and unprefixed lines nothing', () => {
        // Captured: a tester's load_and_debug on Windows with the pyOCD of CMSIS Debugger 1.10.0, whose STDIO file folder
        // did not exist (2026-10-21); the warning line is the same prefix with pyOCD's W level.
        assert.strictEqual(serverLineSeverity('0000992 E Unhandled exception in \'gdbserver\' subcommand [gdbserver_cmd]'), 'error');
        assert.strictEqual(serverLineSeverity('0001001 C Error: Directory D:\\Test\\DUT\\out\\reports for STDIO file usart-validation.log does not exist [__main__]'), 'error');
        assert.strictEqual(serverLineSeverity('0000410 C No connected debug probes [__main__]'), 'error');
        assert.strictEqual(serverLineSeverity('0000713 W Board ID 0000 is not recognized [board]'), 'warning');
        assert.strictEqual(serverLineSeverity('0000652 I Target device: STM32F746ZGTx [cbuild_run]'), undefined);
        assert.strictEqual(serverLineSeverity('0000012 D Probe found [cmsis_dap]'), undefined);
        assert.strictEqual(serverLineSeverity('gdbserver exited with code 1'), undefined);
        assert.strictEqual(serverLineSeverity('Traceback (most recent call last):'), undefined);
        assert.strictEqual(serverLineSeverity('1234 E four digits are no pyOCD prefix'), undefined);
    });

    test('lines of the other sources are never classified: compiler lines, the Problems panel, serial records', () => {
        for (const source of ['build', 'problems', 'serial'] as const) {
            assert.strictEqual(classifyProblem('Failed to power up DAP', source), undefined, source);
        }
    });

    test('a line no row knows gets nothing', () => {
        assert.strictEqual(classifyProblem('0000410 C No connected debug probes [__main__]', 'dap'), undefined);
        assert.strictEqual(classifyProblem('Reading symbols from blinky.elf...', 'dap'), undefined);
        // Word boundaries: "solutions" and "targets" are other words.
        assert.strictEqual(classifyProblem('no active solutions listed', 'ui'), undefined);
    });
});
