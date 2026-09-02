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
import { DebugState } from '../debugState';

/**
 * Motion tools (step, continue, pause, wait_for_stop) return the debug state
 * after every move, so its size is paid on every step of an investigation.
 * The compact form keeps what the next step needs and collapses the rest;
 * the full form is unchanged and still used when a session comes up.
 */
suite('DebugState serialization', () => {

    const populated = (): DebugState => {
        const s = new DebugState();
        s.sessionActive = true;
        s.updateConfigurationName('CMSIS Debugger: pyOCD');
        s.updateContext(1000, 1);
        s.fileFullPath = '/ws/src/main.c';
        s.fileName = 'main.c';
        s.currentLine = 42;
        s.currentLineContent = 'i2c_init();';
        s.nextLines = ['sensor_start();', 'while (1) {', '  __WFI();'];
        s.updateFrameName('main');
        s.updateStackTrace(Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, line: 100 + i })));
        s.updateBreakpoints(['main.c:42', 'isr.c:10 [when: n > 3]']);
        return s;
    };

    test('the full form is unchanged: every field, every frame, every breakpoint', () => {
        const obj = JSON.parse(populated().toString());
        assert.deepStrictEqual(Object.keys(obj), [
            'sessionActive', 'configurationName', 'stackTrace', 'breakpoints', 'fileFullPath', 'fileName',
            'currentLine', 'currentLineContent', 'nextLines', 'frameId', 'threadId', 'frameName',
        ]);
        assert.strictEqual(obj.stackTrace.length, 12);
        assert.deepStrictEqual(obj.breakpoints, ['main.c:42', 'isr.c:10 [when: n > 3]']);
    });

    test('the compact form keeps the location and collapses the stack', () => {
        const obj = JSON.parse(populated().toCompactString({ includeBreakpoints: true }));
        assert.deepStrictEqual(Object.keys(obj), [
            'sessionActive', 'frameName', 'fileFullPath', 'currentLine', 'currentLineContent', 'nextLines',
            'frameId', 'threadId', 'stackTrace', 'breakpoints',
        ]);
        assert.strictEqual(obj.fileFullPath, '/ws/src/main.c', 'add_breakpoint needs the full path');
        assert.strictEqual(obj.currentLine, 42);
        assert.deepStrictEqual(obj.stackTrace, ['f0:100', 'f1:101', 'f2:102', 'f3:103', 'f4:104', '… 7 more — get_call_stack']);
        assert.deepStrictEqual(obj.breakpoints, ['main.c:42', 'isr.c:10 [when: n > 3]']);
    });

    test('unchanged breakpoints are reported by count, not repeated', () => {
        const obj = JSON.parse(populated().toCompactString({ includeBreakpoints: false }));
        assert.strictEqual(obj.breakpoints, undefined);
        assert.strictEqual(obj.breakpointsUnchanged, 2);
    });

    test('a short stack is not decorated', () => {
        const s = populated();
        s.updateStackTrace([{ name: 'main', line: 1 }]);
        const obj = JSON.parse(s.toCompactString({ includeBreakpoints: true, maxFrames: 5 }));
        assert.deepStrictEqual(obj.stackTrace, ['main:1']);
    });

    test('no session is one field in both forms', () => {
        const s = new DebugState();
        assert.strictEqual(s.toString(), JSON.stringify({ sessionActive: false }, null, 2));
        assert.strictEqual(s.toCompactString({ includeBreakpoints: true }), JSON.stringify({ sessionActive: false }, null, 2));
    });

    test('the compact form is a fraction of the full one on a deep stack with many breakpoints', () => {
        const s = populated();
        s.updateStackTrace(Array.from({ length: 50 }, (_, i) => ({ name: `function_number_${i}`, line: i })));
        s.updateBreakpoints(Array.from({ length: 6 }, (_, i) => `file${i}.c:${i * 10} [when: state == ${i}]`));
        const full = s.toString().length;
        const compact = s.toCompactString({ includeBreakpoints: false }).length;
        assert.ok(compact < full / 3, `compact ${compact} vs full ${full}`);
    });
});
