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

/**
 * Placeholder that keeps one trivially passing test in the suite. It checks
 * JavaScript, not the extension.
 */
suite('CMSIS Developer Assistant extension tests', () => {
    // Raised while mocha defines the suite, not in a hook; not awaited.
    void vscode.window.showInformationMessage('Extension test run starting.');

    test('placeholder example', () => {
        const numbers = [1, 2, 3];
        assert.strictEqual(numbers.indexOf(5), -1);
        assert.strictEqual(numbers.indexOf(0), -1);
    });
});
