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
import { defaultPackRoot, expandPackRoot, formatPackId, packDir, parseCbuildRun, parsePackId, parseQualifiedName } from '../core/packDocs/cbuildRun';

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

    test('pack ids and qualified names', () => {
        assert.deepStrictEqual(parsePackId('AlifSemiconductor::Ensemble@2.0.0-rc1.29'), { vendor: 'AlifSemiconductor', name: 'Ensemble', version: '2.0.0-rc1.29' });
        assert.deepStrictEqual(parsePackId('Keil::STM32F7xx_DFP'), { vendor: 'Keil', name: 'STM32F7xx_DFP', version: undefined });
        assert.strictEqual(parsePackId('nonsense'), undefined);
        assert.strictEqual(formatPackId({ vendor: 'Keil', name: 'X', version: '1.0.0' }), 'Keil::X@1.0.0');
        assert.deepStrictEqual(parseQualifiedName('Alif Semiconductor::AE722F80F55D5LS'), { vendor: 'Alif Semiconductor', name: 'AE722F80F55D5LS' });
        assert.deepStrictEqual(parseQualifiedName('STM32F756ZGTx'), { vendor: undefined, name: 'STM32F756ZGTx' });
    });

    test('pack root default and expansion', () => {
        assert.strictEqual(defaultPackRoot({}, '/home/u'), path.join('/home/u', '.cache', 'arm', 'packs'));
        assert.strictEqual(defaultPackRoot({ CMSIS_PACK_ROOT: '/opt/packs' }, '/home/u'), '/opt/packs');
        assert.strictEqual(expandPackRoot('${CMSIS_PACK_ROOT}/Keil/X/1.0.0/a.svd', '/p'), '/p/Keil/X/1.0.0/a.svd');
        assert.strictEqual(packDir('/p', { vendor: 'Keil', name: 'X', version: '1.0.0' }), path.join('/p', 'Keil', 'X', '1.0.0'));
        assert.strictEqual(packDir('/p', { vendor: 'Keil', name: 'X' }), undefined);
    });
});
