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

/**
 * Build log reader over `build-failed.log` (two cbuild contexts: armclang
 * new and legacy diagnostics, GNU as, GCC, GNU ld, armlink, CMake, cbuild
 * and ninja lines, modelled on a real `cbuild` run) and `build-ok.log`.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { looksLikeBuildLog, parseBuildLog, readBuildLog, shortPath } from '../core/buildInfo/buildLog';
import { BUILDINFO_FIXTURES } from './buildInfoElf.test';

suite('buildInfo/buildLog', () => {
    test('a failed cbuild run: contexts, status, folded diagnostics of every tool', () => {
        const s = readBuildLog(path.join(BUILDINFO_FIXTURES, 'build-failed.log'));
        assert.deepStrictEqual(s.contexts, ['Blinky.Debug+NUCLEO-F756ZG', 'Blinky.Debug+FVP']);
        assert.strictEqual(s.compilerLine, 'GCC V13.3.1');
        assert.strictEqual(s.status, 'Build summary: 0 succeeded, 2 failed - Time Elapsed: 00:00:04');
        assert.strictEqual(s.ok, false);
        assert.deepStrictEqual(s.failedSteps, ['…/dev/Blinky/main.o', 'Blinky.elf']);
        const d = (pred: (x: typeof s.diagnostics[number]) => boolean) => s.diagnostics.find(pred);
        // armclang, new style; the repeated warning is folded.
        assert.deepStrictEqual(pick(d(x => x.line === 12)!), ['error', '/Users/dev/Blinky/main.c', 12, 10, undefined, 'expected "FILENAME" or <FILENAME>', 'compiler', 7, 1]);
        assert.deepStrictEqual(pick(d(x => x.message === "unused variable 'tmp'")!), ['warning', '/Users/dev/Blinky/main.c', 30, 5, '-Wunused-variable', "unused variable 'tmp'", 'compiler', 10, 2]);
        assert.deepStrictEqual(pick(d(x => !!x.file?.endsWith('RTE_Device.h'))!), ['warning', '/Users/dev/Blinky/RTE/Device/STM32F756ZGTx/RTE_Device.h', 44, 2, '-W#warnings', '"RTE_USART3 not configured"', 'compiler', 14, 1]);
        // armclang legacy style with #codes, GNU as, GCC with note.
        assert.deepStrictEqual(pick(d(x => x.code === '#223-D')!), ['warning', '/Users/dev/Blinky/legacy.c', 17, undefined, '#223-D', 'function "old_api" declared implicitly', 'compiler', 22, 1]);
        assert.deepStrictEqual(pick(d(x => x.code === '#20')!), ['error', '/Users/dev/Blinky/legacy.c', 25, 9, '#20', 'identifier "undefined_thing" is undefined', 'compiler', 25, 1]);
        assert.deepStrictEqual(pick(d(x => x.file === 'startup_stm32f756xx.S')!), ['error', 'startup_stm32f756xx.S', 88, undefined, undefined, "bad instruction `movs r0,#0'", 'compiler', 27, 1]);
        assert.deepStrictEqual(pick(d(x => x.code === '-Wimplicit-function-declaration')!), ['warning', '/Users/dev/Blinky/main.c', 41, 12, '-Wimplicit-function-declaration', "implicit declaration of function 'vioSetSignal'", 'compiler', 36, 1]);
        assert.deepStrictEqual(pick(d(x => x.message.startsWith("'vioLED0' undeclared"))!), ['error', '/Users/dev/Blinky/main.c', 41, 25, undefined, "'vioLED0' undeclared (first use in this function)", 'compiler', 39, 1]);
        assert.strictEqual(d(x => x.severity === 'note')!.message, 'each undeclared identifier is reported only once for each function it appears in');
        // GNU ld, armlink, CMake, cbuild.
        assert.deepStrictEqual(pick(d(x => x.message.startsWith('undefined reference'))!), ['error', '/Users/dev/Blinky/main.c', 41, undefined, undefined, "undefined reference to `vioSetSignal'", 'linker', 43, 1]);
        assert.deepStrictEqual(pick(d(x => x.message.startsWith('region'))!), ['error', undefined, undefined, undefined, undefined, "region `FLASH' overflowed by 1234 bytes", 'linker', 44, 1]);
        assert.ok(!s.diagnostics.some(x => x.message.includes('ld returned')));
        assert.deepStrictEqual(pick(d(x => x.code === 'L6218E')!), ['error', undefined, undefined, undefined, 'L6218E', 'Undefined symbol osKernelStart (referred from main.o).', 'linker', 47, 1]);
        assert.strictEqual(d(x => x.code === 'L6329W')!.severity, 'warning');
        assert.strictEqual(d(x => x.code === 'L6002U')!.severity, 'error');
        assert.deepStrictEqual(pick(d(x => x.tool === 'cmake')!), ['error', 'CMakeLists.txt', 12, undefined, undefined, 'Missing pack component ARM::CMSIS:CORE', 'cmake', 50, 1]);
        assert.deepStrictEqual(pick(d(x => x.code === 'csolution')!), ['error', undefined, undefined, undefined, 'csolution', 'undefined variables in Blinky.cproject.yml: $Board-Layer$', 'cbuild', 53, 1]);
        assert.deepStrictEqual(pick(d(x => x.code === 'cbuild')!), ['warning', undefined, undefined, undefined, 'cbuild', 'build of context "Blinky.Debug+FVP" skipped', 'cbuild', 54, 1]);
        assert.deepStrictEqual([s.errors, s.warnings, s.notes, s.diagnostics.length], [10, 7, 1, 17]);
    });

    test('a clean build', () => {
        const s = readBuildLog(path.join(BUILDINFO_FIXTURES, 'build-ok.log'));
        assert.strictEqual(s.ok, true);
        assert.strictEqual(s.status, 'Build summary: 1 succeeded, 0 failed - Time Elapsed: 00:00:03');
        assert.deepStrictEqual([s.errors, s.warnings, s.failedSteps.length, s.contexts.length, s.compilerLine], [0, 1, 0, 1, 'AC6 V6.24.0']);
    });

    test('status heuristics, ANSI colours, ld object-offset style, armlink final line', () => {
        const a = parseBuildLog('\x1b[1m/p/main.c:3:5: \x1b[31merror:\x1b[0m boom\n\ninfo cbuild: build finished successfully!\n', 'a.log');
        assert.deepStrictEqual([a.errors, a.diagnostics[0].file, a.diagnostics[0].message, a.status, a.ok], [1, '/p/main.c', 'boom', 'info cbuild: build finished successfully!', true]);
        const b = parseBuildLog('main.o: In function `main\':\nmain.c:(.text+0x10): undefined reference to `foo\'\n/opt/ld: app.elf section `.text\' will not fit in region `FLASH\'\n', 'b.log');
        assert.deepStrictEqual(b.diagnostics.map(d => [d.file, d.message]), [['main.c', "undefined reference to `foo'"], [undefined, "app.elf section `.text' will not fit in region `FLASH'"]]);
        assert.strictEqual(b.ok, false);
        const c = parseBuildLog('Finished: 0 information, 2 warning, 0 error and 0 fatal error messages.\n', 'c.log');
        assert.strictEqual(c.ok, true);
        const d = parseBuildLog('Finished: 0 information, 0 warning, 1 error and 0 fatal error messages.\n', 'd.log');
        assert.strictEqual(d.ok, false);
        const e = parseBuildLog('ninja: no work to do.\n', 'e.log');
        assert.strictEqual(e.ok, true);
        const f = parseBuildLog('hello world\n', 'f.log');
        assert.strictEqual(f.ok, undefined);
        const g = parseBuildLog('x.c:1:1: note: in expansion of macro FOO\nx.c:1:1: warning: w\n', 'g.log');
        assert.deepStrictEqual([g.notes, g.warnings], [0, 1]);
    });

    test('looksLikeBuildLog and shortPath', () => {
        assert.ok(looksLikeBuildLog(path.join(BUILDINFO_FIXTURES, 'build-ok.log')));
        const tmp = path.join(BUILDINFO_FIXTURES, '..', '..', '..', '..', 'out', 'not-a-build.log.tmp');
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, 'serial capture 12:00:01 temperature 21.5\n');
        try { assert.ok(!looksLikeBuildLog(tmp)); } finally { fs.unlinkSync(tmp); }
        assert.strictEqual(shortPath('/Users/dev/proj/src/main.c'), '…/proj/src/main.c');
        assert.strictEqual(shortPath('main.c'), 'main.c');
    });
});

function pick(d: { severity: string; file?: string; line?: number; col?: number; code?: string; message: string; tool: string; logLine: number; count: number }) {
    return [d.severity, d.file, d.line, d.col, d.code, d.message, d.tool, d.logLine, d.count];
}
