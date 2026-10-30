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
import { defaultPackRoot } from '../core/packDocs/cbuildRun';
import { effectiveToolchainPackRoot, invalidateToolchainPackRoot, toolchainPackRoot } from '../utils/toolchainPackRoot';

/**
 * The test host has no CMSIS Solution extension, so the command name is free
 * for a stand-in. Each test registers its own and disposes it.
 */
suite('toolchainPackRoot', () => {
    let disposable: vscode.Disposable | undefined;
    setup(() => invalidateToolchainPackRoot());
    teardown(() => { disposable?.dispose(); disposable = undefined; invalidateToolchainPackRoot(); });

    test('asks the CMSIS Solution extension once and reuses the answer', async () => {
        let calls = 0;
        disposable = vscode.commands.registerCommand('cmsis-csolution.getPackRootPath', () => { calls++; return ' /from/csolution '; });
        const answers = await Promise.all([toolchainPackRoot(), toolchainPackRoot(), toolchainPackRoot()]);
        assert.deepStrictEqual(answers, ['/from/csolution', '/from/csolution', '/from/csolution']);
        assert.strictEqual(await effectiveToolchainPackRoot(), '/from/csolution');
        assert.strictEqual(calls, 1, 'one executeCommand round trip for four consumers');
    });

    test('an empty answer is remembered until invalidated', async () => {
        let calls = 0;
        disposable = vscode.commands.registerCommand('cmsis-csolution.getPackRootPath', () => { calls++; return ''; });
        assert.strictEqual(await toolchainPackRoot(), undefined);
        assert.strictEqual(await toolchainPackRoot(), undefined);
        assert.strictEqual(calls, 1);
        assert.strictEqual(await effectiveToolchainPackRoot(), defaultPackRoot());
        invalidateToolchainPackRoot();
        assert.strictEqual(await toolchainPackRoot(), undefined);
        assert.strictEqual(calls, 2, 'invalidation asks again');
    });

    test('an absent or failing extension keeps the default', async () => {
        // No command registered: executeCommand rejects at once.
        assert.strictEqual(await toolchainPackRoot(), undefined);
        assert.strictEqual(await effectiveToolchainPackRoot(), defaultPackRoot());
        invalidateToolchainPackRoot();
        disposable = vscode.commands.registerCommand('cmsis-csolution.getPackRootPath', () => { throw new Error('not ready'); });
        assert.strictEqual(await toolchainPackRoot(), undefined);
        assert.strictEqual(await effectiveToolchainPackRoot(), defaultPackRoot());
    });

    test('a non-string answer is ignored', async () => {
        disposable = vscode.commands.registerCommand('cmsis-csolution.getPackRootPath', () => ({ path: '/x' }));
        assert.strictEqual(await toolchainPackRoot(), undefined);
    });
});
