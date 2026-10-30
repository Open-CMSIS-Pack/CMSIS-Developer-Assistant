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
import * as path from 'path';
import {
    cbuildRunDebugger, cbuildRunFilePath, cbuildRunProbeId, defaultPackRoot, expandPackRoot, formatPackId, packDir, parseCbuildRun, parsePackId,
    parseQualifiedName,
} from '../core/packDocs/cbuildRun';

export const SAMPLE_CBUILD_RUN = `cbuild-run:
  generated-by: csolution version 2.8.0
  solution: TFLiteRT_HelloWorld.csolution.yml
  target-type: STM32F756ZGTx
  compiler: AC6
  device: STMicroelectronics::STM32F756ZGTx
  device-pack: Keil::STM32F7xx_DFP@3.0.0
  board: STMicroelectronics::NUCLEO-F756ZG:Rev.B
  board-pack: Keil::NUCLEO-F756ZG_BSP@2.0.0
  programming:
    - algorithm: \${CMSIS_PACK_ROOT}/Keil/STM32F7xx_DFP/3.0.0/CMSIS/Flash/STM32F7x_1024.FLM
  system-descriptions:
    - file: \${CMSIS_PACK_ROOT}/Keil/STM32F7xx_DFP/3.0.0/CMSIS/SVD/STM32F756.svd
      type: svd
`;

suite('cbuildRun', () => {
    test('reads the target identity lines', () => {
        const info = parseCbuildRun(SAMPLE_CBUILD_RUN, '/ws/out/x.cbuild-run.yml');
        assert.strictEqual(info.solution, 'TFLiteRT_HelloWorld.csolution.yml');
        assert.strictEqual(info.targetType, 'STM32F756ZGTx');
        assert.deepStrictEqual(info.device, { vendor: 'STMicroelectronics', name: 'STM32F756ZGTx' });
        assert.deepStrictEqual(info.devicePack, { vendor: 'Keil', name: 'STM32F7xx_DFP', version: '3.0.0' });
        assert.deepStrictEqual(info.board, { vendor: 'STMicroelectronics', name: 'NUCLEO-F756ZG', revision: 'Rev.B' });
        assert.deepStrictEqual(info.boardPack, { vendor: 'Keil', name: 'NUCLEO-F756ZG_BSP', version: '2.0.0' });
    });

    test('ignores nested keys with the same names', () => {
        const info = parseCbuildRun('cbuild-run:\n  output:\n    - file: x\n      device: nope\n  device: A::B\n', 'f');
        assert.deepStrictEqual(info.device, { vendor: 'A', name: 'B' });
    });

    test('the debugger name: the name of the top-level debugger node, nothing else', () => {
        const withDebugger = `${SAMPLE_CBUILD_RUN}  debugger:\n    protocol: swd\n    name: "CMSIS-DAP@pyOCD"\n    clock: 10000000\n  debug-topology:\n    name: other\n`;
        assert.strictEqual(cbuildRunDebugger(withDebugger), 'CMSIS-DAP@pyOCD');
        assert.strictEqual(cbuildRunDebugger(withDebugger.replace(/\n/g, '\r\n')), 'CMSIS-DAP@pyOCD', 'Windows line ends');
        assert.strictEqual(cbuildRunDebugger(SAMPLE_CBUILD_RUN), undefined, 'no debugger node');
        assert.strictEqual(cbuildRunDebugger('cbuild-run:\n  debugger:\n    protocol: swd\n  device: A::B\n    name: late\n'), undefined,
            'a name after the node ended is not the debugger\'s');
        assert.strictEqual(cbuildRunDebugger('cbuild-run:\n  output:\n    - debugger:\n        name: nested\n'), undefined);
        assert.strictEqual(cbuildRunDebugger('cbuild-run:\n  debugger:\n    name:\n'), undefined, 'an empty name');
    });

    test('the probe ID: probe-id of the debugger node, which csolution copies from the target set\'s debugger', () => {
        // ProjMgrYamlParser.cpp:653 keeps unknown debugger keys, ProjMgrCbuildRun.cpp:194 writes them under debugger:.
        const withProbe = `${SAMPLE_CBUILD_RUN}  debugger:\n    name: CMSIS-DAP@pyOCD\n    probe-id: "0240000034544e45"\n    clock: 10000000\n`
            + '  debug-topology:\n    probe-id: other\n';
        assert.strictEqual(cbuildRunProbeId(withProbe), '0240000034544e45');
        assert.strictEqual(cbuildRunDebugger(withProbe), 'CMSIS-DAP@pyOCD');
        assert.strictEqual(cbuildRunProbeId(withProbe.replace(/\n/g, '\r\n')), '0240000034544e45', 'Windows line ends');
        assert.strictEqual(cbuildRunProbeId(`${SAMPLE_CBUILD_RUN}  debugger:\n    name: CMSIS-DAP@pyOCD\n`), undefined, 'none set');
        assert.strictEqual(cbuildRunProbeId('cbuild-run:\n  debugger:\n    name: X\n    gdbserver:\n      - port: 3333\n        probe-id: nested\n'), undefined,
            'not a key of a nested node');
        assert.strictEqual(cbuildRunProbeId(SAMPLE_CBUILD_RUN), undefined, 'no debugger node');
    });

    test('pack ids and qualified names', () => {
        assert.deepStrictEqual(parsePackId('AlifSemiconductor::Ensemble@2.0.0-rc1.29'), { vendor: 'AlifSemiconductor', name: 'Ensemble', version: '2.0.0-rc1.29' });
        assert.deepStrictEqual(parsePackId('Keil::STM32F7xx_DFP'), { vendor: 'Keil', name: 'STM32F7xx_DFP', version: undefined });
        assert.strictEqual(parsePackId('nonsense'), undefined);
        assert.strictEqual(formatPackId({ vendor: 'Keil', name: 'X', version: '1.0.0' }), 'Keil::X@1.0.0');
        assert.deepStrictEqual(parseQualifiedName('Alif Semiconductor::AE722F80F55D5LS'), { vendor: 'Alif Semiconductor', name: 'AE722F80F55D5LS' });
        assert.deepStrictEqual(parseQualifiedName('STM32F756ZGTx'), { vendor: undefined, name: 'STM32F756ZGTx' });
    });

    test('pack root default and expansion', () => {
        assert.strictEqual(defaultPackRoot({}, '/home/u', 'linux'), path.join('/home/u', '.cache', 'arm', 'packs'));
        assert.strictEqual(defaultPackRoot({}, '/Users/u', 'darwin'), path.join('/Users/u', '.cache', 'arm', 'packs'));
        assert.strictEqual(defaultPackRoot({ CMSIS_PACK_ROOT: '/opt/packs' }, '/home/u', 'linux'), '/opt/packs');
        assert.strictEqual(defaultPackRoot({ CMSIS_PACK_ROOT: '  ' }, '/home/u', 'linux'), path.join('/home/u', '.cache', 'arm', 'packs'));
        // Windows: %LOCALAPPDATA%\Arm\Packs, never ~/.cache — and CMSIS_PACK_ROOT still wins.
        assert.strictEqual(
            defaultPackRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32'),
            path.join('C:\\Users\\u\\AppData\\Local', 'Arm', 'Packs'));
        assert.strictEqual(
            defaultPackRoot({}, 'C:\\Users\\u', 'win32'),
            path.join('C:\\Users\\u', 'AppData', 'Local', 'Arm', 'Packs'));
        assert.strictEqual(
            defaultPackRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', CMSIS_PACK_ROOT: 'D:\\packs' }, 'C:\\Users\\u', 'win32'),
            'D:\\packs');
        assert.strictEqual(expandPackRoot('${CMSIS_PACK_ROOT}/Keil/X/1.0.0/a.svd', '/p'), '/p/Keil/X/1.0.0/a.svd');
        assert.strictEqual(packDir('/p', { vendor: 'Keil', name: 'X', version: '1.0.0' }), path.join('/p', 'Keil', 'X', '1.0.0'));
        assert.strictEqual(packDir('/p', { vendor: 'Keil', name: 'X' }), undefined);
    });

    test('a file the cbuild-run names is relative to its folder, not the working directory', () => {
        // csolution writes the file of a local pack (packs: - path: ../DFP_machine) relative to out/.
        const run = path.join('/ws', 'app', 'out', 'app+HW.cbuild-run.yml');
        assert.strictEqual(cbuildRunFilePath('../../DFP_machine/Device/x.svd', run, '/p'), path.resolve('/ws', 'DFP_machine', 'Device', 'x.svd'));
        assert.strictEqual(cbuildRunFilePath('app/HW/Debug/app.elf', run, '/p'), path.resolve('/ws', 'app', 'out', 'app', 'HW', 'Debug', 'app.elf'));
        assert.strictEqual(cbuildRunFilePath('${CMSIS_PACK_ROOT}/Keil/X/1.0.0/a.svd', run, '/p'), path.resolve('/p', 'Keil', 'X', '1.0.0', 'a.svd'));
        assert.strictEqual(cbuildRunFilePath(path.resolve('/elsewhere', 'b.svd'), run, '/p'), path.resolve('/elsewhere', 'b.svd'), 'an absolute file stays');
    });
});
