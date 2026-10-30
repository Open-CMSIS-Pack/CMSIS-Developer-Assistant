/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as assert from 'assert';
import { dropsInstructions, offersNoGetStream, survivesWindowReload, wantsTextOnly } from '../core/clientHosting';

suite('Which MCP clients survive a window reload', () => {
    test('the CLIs do: Claude Code, Codex, Gemini CLI, by name prefix, case-insensitively', () => {
        for (const name of ['claude-code', 'Claude-Code', 'codex-mcp-client', 'gemini-cli-mcp-client']) {
            assert.strictEqual(survivesWindowReload(name), true, name);
        }
    });

    test('a chat inside the window does not, nor an unknown or absent client', () => {
        for (const name of ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cline', 'Roo Code', 'cursor-vscode', 'windsurf', '', undefined]) {
            assert.strictEqual(survivesWindowReload(name), false, String(name));
        }
    });
});

suite('Which MCP clients get tool results as text alone', () => {
    test('a name on the list, exactly and in the case it is sent', () => {
        const list = ['some-sdk-client'];
        assert.strictEqual(wantsTextOnly('some-sdk-client', list), true);
        for (const name of ['Some-SDK-Client', ' some-sdk-client', 'some-sdk-client-2', 'some-sdk', '', undefined]) {
            assert.strictEqual(wantsTextOnly(name, list), false, String(name));
        }
    });

    test('the shipped list: Kimi Code, which appends structuredContent to the text', () => {
        assert.strictEqual(wantsTextOnly('kimi-code'), true);
        assert.strictEqual(wantsTextOnly('claude-code'), false);
    });

    test('an absent or empty name never does, whatever the shipped list holds', () => {
        assert.strictEqual(wantsTextOnly(undefined), false);
        assert.strictEqual(wantsTextOnly(''), false);
    });
});

suite('Which MCP clients never show the model the server instructions', () => {
    test('Kimi Code, by its exact name; an absent or other name does not count', () => {
        assert.strictEqual(dropsInstructions('kimi-code'), true);
        for (const name of ['Kimi-Code', 'claude-code', 'Visual Studio Code', '', undefined]) {
            assert.strictEqual(dropsInstructions(name), false, String(name));
        }
    });
});

suite('Which MCP clients are offered no GET stream', () => {
    test('Kimi Code, by its exact name; every other client keeps its stream', () => {
        assert.strictEqual(offersNoGetStream('kimi-code'), true);
        for (const name of ['Kimi-Code', 'claude-code', 'codex-mcp-client', 'Visual Studio Code', '', undefined]) {
            assert.strictEqual(offersNoGetStream(name), false, String(name));
        }
    });
});
