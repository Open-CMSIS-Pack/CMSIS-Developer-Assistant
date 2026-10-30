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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DebugConfigurationManager, PickerCancelled } from '../utils/debugConfigurationManager';

/**
 * The configuration picker of `start_debugging` against VS Code's own quick
 * pick (#14): a cancellation token closes it, and the rejection names the
 * configurations it offered. The rest of the module is covered by
 * test/transport/config-scenarios.js.
 */
suite('Debug configuration picker', () => {
    let folder: string;

    setup(() => {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-picker-'));
        fs.mkdirSync(path.join(folder, '.vscode'));
        fs.writeFileSync(path.join(folder, '.vscode', 'launch.json'), [
            '{',
            '    // Comments and a trailing comma, as generated files have them.',
            '    "configurations": [',
            '        { "name": "CMSIS Debugger: pyOCD", "type": "gdbtarget", "request": "launch" },',
            '        { "type": "gdbtarget", "request": "attach" },',
            '        { "name": "Attach", "type": "gdbtarget", "request": "attach" },',
            '    ],',
            '}',
        ].join('\n'));
    });

    teardown(() => {
        fs.rmSync(folder, { recursive: true, force: true });
    });

    test('a cancelled picker closes and rejects with the named configurations it offered', async () => {
        const deadline = new vscode.CancellationTokenSource();
        const timer = setTimeout(() => deadline.cancel(), 300);
        try {
            const began = Date.now();
            await assert.rejects(new DebugConfigurationManager().promptForConfiguration(folder, deadline.token), (failure: unknown) => {
                assert.ok(failure instanceof PickerCancelled, String(failure));
                assert.deepStrictEqual(failure.offered, ['CMSIS Debugger: pyOCD', 'Attach'], 'an entry without a name cannot be passed by name');
                return true;
            });
            assert.ok(Date.now() - began < 5_000, 'closed by the token, not by a person');
        } finally {
            clearTimeout(timer);
            deadline.dispose();
        }
    });

    test('a token cancelled before the picker opens rejects at once', async () => {
        const deadline = new vscode.CancellationTokenSource();
        deadline.cancel();
        try {
            await assert.rejects(new DebugConfigurationManager().promptForConfiguration(folder, deadline.token), PickerCancelled);
        } finally {
            deadline.dispose();
        }
    });
});
