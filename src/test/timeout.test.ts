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
import { HardwareTimeoutError, customRequestWithTimeout, withTimeout } from '../utils/timeout';

suite('withTimeout', () => {
    const never = () => new Promise<never>(() => { /* pending */ });
    const after = <T>(ms: number, value: T) => new Promise<T>(r => setTimeout(() => r(value), ms));

    test('a task that finishes in time resolves with its value', async () => {
        assert.strictEqual(await withTimeout('op', 100, after(5, 1)), 1);
        assert.strictEqual(await withTimeout('op', 100, () => after(5, 'x')), 'x');
    });

    test('a task that does not finish rejects with HardwareTimeoutError naming the operation', async () => {
        await assert.rejects(withTimeout('probe read', 20, never()), (e: unknown) =>
            e instanceof HardwareTimeoutError && e.operation === 'probe read' && e.timeoutMs === 20 && /timed out after 20ms/.test(e.message));
    });

    test('a non-positive timeout leaves the task alone', async () => {
        const raced = await Promise.race([withTimeout('op', 0, never()).then(() => 'settled'), after(50, 'still pending')]);
        assert.strictEqual(raced, 'still pending');
        assert.strictEqual(await withTimeout('op', -1, after(5, 2)), 2);
    });

    test('the task\'s own rejection propagates unwrapped, and the thunk runs once', async () => {
        let runs = 0;
        await assert.rejects(withTimeout('op', 100, () => { runs++; return Promise.reject(new Error('boom')); }), /^Error: boom$/);
        assert.strictEqual(runs, 1);
    });

    test('customRequestWithTimeout names the DAP command', async () => {
        const session = { customRequest: () => never() } as unknown as vscode.DebugSession;
        await assert.rejects(customRequestWithTimeout(session, 'threads', undefined, 20), (e: unknown) =>
            e instanceof HardwareTimeoutError && e.operation === 'DAP threads');
        const quick = { customRequest: async (cmd: string) => ({ cmd }) } as unknown as vscode.DebugSession;
        assert.deepStrictEqual(await customRequestWithTimeout(quick, 'threads', undefined, 20), { cmd: 'threads' });
    });
});
