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
import * as path from 'path';
import { readPeripheralViaMemory, readWord } from '../core/peripheralReader';
import { HardwareTimeoutError } from '../utils/timeout';

const FIXTURE_SVD = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'test-device.svd');

/** A DAP session whose answers are scripted per command. */
function session(answer: (command: string, args: Record<string, unknown>) => Promise<unknown>, type?: string): vscode.DebugSession {
    return { type, customRequest: answer } as unknown as vscode.DebugSession;
}

suite('peripheralReader readWord', () => {
    test('the caller\'s DAP timeout applies to every strategy, and a timeout is not retried', async () => {
        let calls = 0;
        const hanging = session(() => { calls++; return new Promise(() => { /* never */ }); });
        const t0 = Date.now();
        await assert.rejects(() => readWord(hanging, '0x40000000', null, 50), (e: unknown) =>
            e instanceof HardwareTimeoutError && e.timeoutMs === 50 && e.operation === 'DAP readMemory');
        assert.ok(Date.now() - t0 < 1_000);
        assert.strictEqual(calls, 1, 'a hung probe is reported at once, not retried through the GDB ladder');
    });

    test('falls back from readMemory to a GDB evaluate and parses the value', async () => {
        const seen: string[] = [];
        const s = session(async (command, args) => {
            seen.push(command);
            if (command === 'readMemory') { throw new Error('not supported'); }
            if (command === 'evaluate' && (args.expression as string).startsWith('*(unsigned int*)')) { return { result: '0x12345678' }; }
            throw new Error(`unexpected ${command}`);
        });
        assert.strictEqual(await readWord(s, '0x40000000', 3, 1_000), 0x12345678);
        assert.deepStrictEqual(seen, ['readMemory', 'evaluate']);
    });

    test('the x/1xw strategy parses GDB\'s "addr:\\tvalue" form; everything failing is an error', async () => {
        const s = session(async (command, args) => {
            if (command === 'readMemory') { return {}; }
            const expr = args.expression as string;
            if (expr.startsWith('-exec x/1xw')) { return { result: '0x20000000:\t0x000000ff' }; }
            return { result: 'garbage' };
        });
        assert.strictEqual(await readWord(s, '0x20000000', null, 1_000), 255);
        const failing = session(async () => { throw new Error('nope'); });
        await assert.rejects(() => readWord(failing, '0x20000000', null, 1_000), /All read strategies failed for 0x20000000/);
    });

    test('on the CMSIS Debugger the GDB read is the MI command, whose result comes back in the reply (#56)', async () => {
        const expressions: string[] = [];
        const s = session(async (command, args) => {
            if (command === 'readMemory') { throw new Error('Unable to read memory.'); }
            const expr = args.expression as string;
            expressions.push(`${args.context} ${expr}`);
            if (expr.startsWith('*(unsigned int*)')) { return { result: 'Error: could not evaluate expression' }; }
            if (expr === '>-data-read-memory-bytes 0x40023800 4') {
                return { result: JSON.stringify({ memory: [{ begin: '0x40023800', offset: '0x00000000', end: '0x40023804', contents: '83000003' }] }) };
            }
            return { result: '\r' };
        }, 'gdbtarget');
        assert.strictEqual(await readWord(s, '0x40023800', 1000, 1_000), 0x03000083);
        assert.deepStrictEqual(expressions, ['watch *(unsigned int*)0x40023800', 'repl >-data-read-memory-bytes 0x40023800 4']);
    });
});

suite('peripheralReader readPeripheralViaMemory', () => {
    test('decodes with the SVD of the session it reads, which VS Code need not have focused', async () => {
        // The test host focuses no session; the executor passes the tracked one, whose launch configuration names the SVD.
        const requests: unknown[] = [];
        const tracked = {
            name: 'CMSIS Debugger: pyOCD', type: 'gdbtarget', configuration: { svdFile: FIXTURE_SVD },
            customRequest: async (command: string, args: Record<string, unknown>) => {
                requests.push([command, args]);
                if (command === 'readMemory') { return { data: Buffer.from([0x83, 0x00, 0x00, 0x03]).toString('base64') }; }
                throw new Error(`unexpected ${command}`);
            },
        } as unknown as vscode.DebugSession;
        const text = await readPeripheralViaMemory(tracked, 'RCC', 'CR', null, 1_000);
        assert.ok(text.startsWith('RCC.CR @ 0x40023800 = 0x03000083\n'), text);
        assert.deepStrictEqual(requests, [['readMemory', { memoryReference: '0x40023800', count: 4 }]]);
    });
});
