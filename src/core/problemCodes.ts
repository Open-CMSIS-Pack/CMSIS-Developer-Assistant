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
 * The codes of the problem journal (#48). `ProblemCode` is `ErrorCode` (#11)
 * and the codes only the journal uses. A record gets a code from the source
 * that knows it (`TASK_FAILED` for a failed task, `BUILD_ERROR` for a
 * compiler error) or from `classifyProblem`, which recognises known lines of
 * the debug adapter, the GDB server and the other extensions, and adds the
 * next step as the hint. Agents need no list of codes: each record carries
 * its hint.
 *
 * A row ships only together with a line captured from a real session, which
 * `src/test/problemCodes.test.ts` holds as its fixture, with where it was
 * captured. Rows the proposal named without such a line wait for one:
 * pyOCD's "No available debug probes" and a J-Link connect failure
 * (`PROBE_NOT_FOUND`), and "Could not find core in Coresight setup"
 * (`CORE_NOT_FOUND`); so does the J-Link banner that would mark any
 * GDB-server line. pyOCD's log prefix has its line: `serverLineSeverity`
 * weighs a GDB-server line by the level pyOCD gave it.
 *
 * Pure: no vscode.
 */

import type { ProblemSeverity, ProblemSource } from './problemJournal';
import { PROBE_SOFTWARE_STEPS, RESTART_VS_CODE } from './programLookup';
import type { ErrorCode } from './toolResult';

/** What a record's `code` can be: an `ErrorCode`, or a code only the journal uses. */
export type ProblemCode = ErrorCode | 'DAP_POWER_UP_FAILED' | 'BUILD_ERROR' | 'GDB_SERVER_NOT_FOUND';

/** What `classifyProblem` knows about a line. */
export interface ProblemClass {
    code: ProblemCode;
    /** The weight of a line that matches; a failed DAP response keeps the weight its source gives it. */
    severity: ProblemSeverity;
    /** The next step, for the agent. */
    hint: string;
    /** The source the text gives away: a GDB server's own message rather than the adapter's. */
    source?: ProblemSource;
}

interface ProblemRow extends ProblemClass {
    pattern: RegExp;
}

/**
 * The known lines, tried in order; the first that matches decides. The
 * target-running row is a warning: GDB answers it to requests that the
 * tools already report, and the failed response of a request VS Code sent
 * is an error of its own.
 */
const ROWS: readonly ProblemRow[] = [
    {
        pattern: /Failed to power up DAP/i,
        code: 'DAP_POWER_UP_FAILED',
        severity: 'error',
        source: 'gdb-server',
        hint: 'Check the board\'s power and the debug cable, then cmsis_action load_and_debug.',
    },
    {
        pattern: /Waiting for a debug probe matching unique ID/i,
        code: 'PROBE_BUSY',
        severity: 'error',
        source: 'gdb-server',
        hint: 'pyOCD sees no free probe: another task or session holds it (cmsis_action stop_run or stop_debugging, then retry), '
            + 'or the probe is not connected or lacks its USB driver (ask the user).',
    },
    {
        // cdt-gdb-adapter could not start the server program the launch configuration names (Windows: ENOENT).
        pattern: /gdbserver has hit error Error: spawn \S+ ENOENT/i,
        code: 'GDB_SERVER_NOT_FOUND',
        severity: 'error',
        hint: 'The debug adapter could not start the GDB server program of the launch configuration: it is not installed, or its folder is not '
            + 'on the PATH VS Code was started with. Ask the user to install it (J-Link: the SEGGER J-Link Software) or add its folder to the system '
            + `or user PATH, ${RESTART_VS_CODE}; ${PROBE_SOFTWARE_STEPS}`,
    },
    {
        pattern: /\btarget is running\b/i,
        code: 'TARGET_RUNNING',
        severity: 'warning',
        hint: 'Call pause_execution first.',
    },
    {
        pattern: /\bno active (?:CMSIS )?solution\b/i,
        code: 'CMSIS_NO_SOLUTION',
        severity: 'error',
        hint: 'Open the folder of the project\'s *.csolution.yml in that VS Code window and select the solution in the CMSIS Solution panel.',
    },
];

/**
 * The sources whose text relays another program's messages. Compiler lines
 * (`build`) and Problems-panel entries have codes of their own, and serial
 * records are texts of this extension.
 */
const CLASSIFIED_SOURCES: ReadonlySet<ProblemSource> = new Set<ProblemSource>(['dap', 'gdb-server', 'task', 'ui', 'extension']);

/**
 * pyOCD's log line: milliseconds since start, seven digits, and the level's
 * first letter (`0000992 E Unhandled exception in 'gdbserver' subcommand
 * [gdbserver_cmd]`), as the CMSIS Debugger's pyOCD prints it.
 */
const PYOCD_LEVEL = /^\d{7} ([DIWEC]) /;

/**
 * The weight pyOCD gave a GDB-server line: `W` a warning, `E` and `C` (critical)
 * an error; undefined for its debug and info lines and for any line without
 * the prefix, which keep the weight of their output category.
 */
export function serverLineSeverity(text: string): ProblemSeverity | undefined {
    const level = PYOCD_LEVEL.exec(text)?.[1];
    return level === 'W' ? 'warning' : level === 'E' || level === 'C' ? 'error' : undefined;
}

/** The code, weight and next step of a known line; undefined for any other line or source. */
export function classifyProblem(text: string, source: ProblemSource): ProblemClass | undefined {
    if (!CLASSIFIED_SOURCES.has(source)) {
        return undefined;
    }
    const row = ROWS.find((candidate) => candidate.pattern.test(text));
    if (!row) {
        return undefined;
    }
    const known: ProblemClass = { code: row.code, severity: row.severity, hint: row.hint };
    return row.source ? { ...known, source: row.source } : known;
}
