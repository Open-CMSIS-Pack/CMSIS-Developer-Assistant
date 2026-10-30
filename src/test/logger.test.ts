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
import { ProblemJournal } from '../core/problemJournal';
import { logger } from '../utils/logger';
import { mirrorProblem } from '../windowProblems';

/** A log channel that records what reaches it, at the level the user picked. */
class RecordingChannel {
    readonly lines: string[] = [];
    constructor(public logLevel: number) { }
    trace(line: string): void { this.lines.push(`trace ${line}`); }
    debug(line: string): void { this.lines.push(`debug ${line}`); }
    info(line: string): void { this.lines.push(`info ${line}`); }
    warn(line: string): void { this.lines.push(`warn ${line}`); }
    error(line: string): void { this.lines.push(`error ${line}`); }
}

/** The logger's channel, swapped for the test. */
type WithChannel = { channel: unknown };

/**
 * The output channel stays quiet in normal operation: the journal's mirror
 * and the routine lines are debug entries, which show only when the user
 * sets the channel to Debug.
 */
suite('Logger levels', () => {
    let original: unknown;
    let channel: RecordingChannel;
    const use = (level: number): void => {
        channel = new RecordingChannel(level);
        (logger as unknown as WithChannel).channel = channel;
    };

    setup(() => {
        original = (logger as unknown as WithChannel).channel;
    });

    teardown(() => {
        (logger as unknown as WithChannel).channel = original;
    });

    test('a debug entry reaches a channel at Debug and is not even written to one at Info', () => {
        use(vscode.LogLevel.Debug);
        logger.debug('routine');
        logger.info('fact');
        assert.deepStrictEqual(channel.lines, ['debug routine', 'info fact']);
        use(vscode.LogLevel.Info);
        logger.debug('routine');
        logger.warn('act on this');
        assert.deepStrictEqual(channel.lines, ['warn act on this']);
    });

    test('the journal mirror writes each warning and error as a debug [problem #N] line, never as a warning or an error', () => {
        use(vscode.LogLevel.Debug);
        const journal = new ProblemJournal();
        const subscription = journal.onDidAppend(mirrorProblem);
        try {
            journal.append({ source: 'dap', origin: 'CMSIS Debugger: pyOCD', severity: 'error', message: 'Failed to power up DAP' });
            journal.append({ source: 'serial', origin: 'COM7', severity: 'warning', message: 'COM7 disconnected' });
            journal.append({ source: 'serial', origin: 'COM7', severity: 'info', message: 'released' });
            journal.append({ source: 'extension', origin: 'cmsis-developer-assistant', severity: 'error', message: 'logged already' });
        } finally {
            subscription.dispose();
        }
        assert.deepStrictEqual(channel.lines, [
            'debug [problem #1] error dap (CMSIS Debugger: pyOCD) Failed to power up DAP',
            'debug [problem #2] warning serial (COM7) COM7 disconnected',
        ]);
        use(vscode.LogLevel.Info);
        mirrorProblem(journal.query().records[0]);
        assert.deepStrictEqual(channel.lines, [], 'at the default level the mirror is silent');
    });
});
