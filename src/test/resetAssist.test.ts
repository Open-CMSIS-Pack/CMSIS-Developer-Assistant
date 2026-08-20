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
import { buildResetCommands, detectGdbServerKind, replyLooksUnsupported } from '../core/resetAssist';

/**
 * Test suite for the pure reset-command mapping (server kind × method × halt).
 */
suite('resetAssist', () => {

    test('pyOCD builds OpenOCD-style reset commands', () => {
        assert.deepStrictEqual(buildResetCommands('pyocd', 'system', true), ['monitor reset halt system']);
        assert.deepStrictEqual(buildResetCommands('pyocd', 'core', true), ['monitor reset halt core']);
        assert.deepStrictEqual(buildResetCommands('pyocd', 'hardware', true), ['monitor reset halt hardware']);
        assert.deepStrictEqual(buildResetCommands('pyocd', 'system', false), ['monitor reset run system']);
    });

    test('J-Link builds numeric reset commands with a separate halt', () => {
        assert.deepStrictEqual(buildResetCommands('jlink', 'system', true), ['monitor halt', 'monitor reset 0']);
        assert.deepStrictEqual(buildResetCommands('jlink', 'hardware', true), ['monitor halt', 'monitor reset 0']);
        assert.deepStrictEqual(buildResetCommands('jlink', 'core', true), ['monitor halt', 'monitor reset 1']);
        assert.deepStrictEqual(buildResetCommands('jlink', 'system', false), ['monitor reset 0']);
    });

    test('unknown servers get the pyOCD form', () => {
        assert.deepStrictEqual(buildResetCommands('unknown', 'system', true), ['monitor reset halt system']);
    });

    test('server detection from session text', () => {
        assert.strictEqual(detectGdbServerKind('pyOCD gdb server on port 3333'), 'pyocd');
        assert.strictEqual(detectGdbServerKind('J-Link GDB Server V7.94'), 'jlink');
        assert.strictEqual(detectGdbServerKind('JLINKARM_CID'), 'jlink');
        assert.strictEqual(detectGdbServerKind('CMSIS-DAP'), 'unknown');
        assert.strictEqual(detectGdbServerKind(''), 'unknown');
    });

    test('unsupported-reply classification', () => {
        assert.strictEqual(replyLooksUnsupported('Unknown monitor command'), true);
        assert.strictEqual(replyLooksUnsupported('invalid command'), true);
        assert.strictEqual(replyLooksUnsupported('Error: command not supported'), true);
        assert.strictEqual(replyLooksUnsupported('Resetting target'), false);
        assert.strictEqual(replyLooksUnsupported(''), false);
    });
});
