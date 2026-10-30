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
import { ResetMethod, ResetOutcomeView, buildResetCommands, detectGdbServerKind, renderResetOutcome, replyLooksUnsupported, unsupportedResetDetail } from '../core/resetAssist';

const METHODS: readonly ResetMethod[] = ['system', 'core', 'hardware'];

/**
 * The reset type pyOCD takes from a `monitor reset` command line: an optional
 * halt flag, then TYPE as the only argument left (`ResetCommand.parse` in
 * pyocd/commands/commands.py). Any other line resets with the default type.
 */
function pyocdResetType(command: string): string | undefined {
    const [monitor, reset, ...args] = command.split(/\s+/);
    assert.strictEqual(`${monitor} ${reset}`, 'monitor reset', command);
    if (['-h', '--halt', 'halt'].includes(args[0])) {
        args.shift();
    }
    return args.length === 1 ? args[0] : undefined;
}

/**
 * Test suite for the pure reset-command mapping (server kind × method × halt).
 */
suite('resetAssist', () => {

    test('pyOCD gets the method as its reset type, after halt or as the only argument', () => {
        assert.deepStrictEqual(buildResetCommands('pyocd', 'system', true), ['monitor reset halt system']);
        assert.deepStrictEqual(buildResetCommands('pyocd', 'core', true), ['monitor reset halt core']);
        assert.deepStrictEqual(buildResetCommands('pyocd', 'hardware', true), ['monitor reset halt hardware']);
        assert.deepStrictEqual(buildResetCommands('pyocd', 'system', false), ['monitor reset system']);
        assert.deepStrictEqual(buildResetCommands('pyocd', 'core', false), ['monitor reset core']);
        assert.deepStrictEqual(buildResetCommands('pyocd', 'hardware', false), ['monitor reset hardware']);
        for (const method of METHODS) {
            for (const halt of [true, false]) {
                const commands = buildResetCommands('pyocd', method, halt);
                assert.strictEqual(commands.length, 1, commands.join('; '));
                assert.strictEqual(pyocdResetType(commands[0]), method, `'${commands[0]}' resets with the default type, not ${method}`);
            }
        }
    });

    test('J-Link gets its Cortex-M reset strategy: 0 normal, 1 core, 2 reset pin', () => {
        assert.deepStrictEqual(buildResetCommands('jlink', 'system', true), ['monitor halt', 'monitor reset 0']);
        assert.deepStrictEqual(buildResetCommands('jlink', 'core', true), ['monitor halt', 'monitor reset 1']);
        assert.deepStrictEqual(buildResetCommands('jlink', 'hardware', true), ['monitor halt', 'monitor reset 2']);
    });

    test('J-Link halts after every reset strategy, so the running form starts the core with go', () => {
        assert.deepStrictEqual(buildResetCommands('jlink', 'system', false), ['monitor reset 0', 'monitor go']);
        assert.deepStrictEqual(buildResetCommands('jlink', 'core', false), ['monitor reset 1', 'monitor go']);
        assert.deepStrictEqual(buildResetCommands('jlink', 'hardware', false), ['monitor reset 2', 'monitor go']);
    });

    test('unknown servers get the pyOCD form', () => {
        assert.deepStrictEqual(buildResetCommands('unknown', 'system', true), ['monitor reset halt system']);
        assert.deepStrictEqual(buildResetCommands('unknown', 'hardware', false), ['monitor reset hardware']);
    });

    test('the three methods are three different resets on every server, so auto never repeats one', () => {
        for (const server of ['pyocd', 'jlink', 'unknown'] as const) {
            for (const halt of [true, false]) {
                const forms = METHODS.map(method => buildResetCommands(server, method, halt).join('; '));
                assert.strictEqual(new Set(forms).size, METHODS.length, `${server}, halt=${halt}: ${forms.join(' | ')}`);
            }
        }
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

suite('resetAssist outcome rendering', () => {
    const base: ResetOutcomeView = {
        serverKind: 'pyocd', methodsTried: ['system'], commandsIssued: ['monitor reset halt system'], replies: ['ok'],
        verified: false, verificationDetail: 'PC 0x08000400 is not the reset handler 0x080001c1', haltedByUs: false, resumed: false,
    };

    test('the last (or only) unsupported method does not promise a next one', () => {
        assert.match(unsupportedResetDetail('system', 2), /trying the next method/);
        assert.match(unsupportedResetDetail('hardware', 0), /no further method to try/);
        assert.doesNotMatch(unsupportedResetDetail('hardware', 0), /next method/);
    });

    test('an unverified reset says the target is halted, that halt=false was not applied, and whether it was running before', () => {
        const text = renderResetOutcome({ ...base, haltedByUs: true }, false);
        assert.match(text, /does NOT appear to have reset/);
        assert.match(text, /The target is halted \(it was running before the reset\); halt=false was not applied because the reset could not be verified — use continue_execution to run\./);
        assert.match(text, /Commands: 'monitor reset halt system' \(server: pyocd\)/);
        const plain = renderResetOutcome(base, undefined);
        assert.match(plain, /The target is halted — use continue_execution to run\./);
        assert.doesNotMatch(plain, /halt=false/);
    });

    test('a verified reset reports resumed only when the target was actually resumed', () => {
        assert.match(renderResetOutcome({ ...base, verified: true, resumed: true }, false), /^Target reset verified\..*Target resumed \(halt=false\)\./);
        assert.match(renderResetOutcome({ ...base, verified: true }, undefined), /halted at the reset vector — use continue_execution to run/);
    });

    test('an unverified reset names the fresh connect as the next step, for every server, and power-cycling only after it (#20)', () => {
        for (const serverKind of ['pyocd', 'jlink', 'unknown'] as const) {
            const text = renderResetOutcome({ ...base, serverKind }, undefined);
            assert.match(text, /Next: stop_debugging, then cmsis_action load_and_debug \(a fresh connect and reset\)\./);
            assert.match(text, /secure-boot parts such as Alif Ensemble, where nSRST alone does not re-vector the core\./);
            assert.match(text, /If that fails too, power-cycle the board or reconnect the probe\. Adapter replies: ok$/);
            assert.ok(text.indexOf('use continue_execution to run.') < text.indexOf('Next: stop_debugging'), 'the end state comes first');
        }
    });

    test('a verified reset suggests no fallback', () => {
        for (const resumed of [false, true]) {
            const text = renderResetOutcome({ ...base, verified: true, resumed }, resumed ? false : undefined);
            assert.doesNotMatch(text, /load_and_debug|power-cycle/);
        }
    });
});
