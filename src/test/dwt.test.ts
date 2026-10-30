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
import { architectureHasCycleCounter, DEMCR_TRCENA, DWT_ADDRESSES, DWT_CTRL_CYCCNTENA, DWT_CTRL_NOCYCCNT } from '../core/dwt';

/**
 * read_cycle_counter decides from these whether a core has a cycle counter.
 * The positions are CMSIS-Core's (core_cm3/4/7/23/33/55/85.h) and the
 * architecture manuals'; DWT_CTRL values are those the cores read with
 * DEMCR.TRCENA set.
 */
suite('DWT cycle counter registers', () => {

    test('addresses and bits are those of CMSIS-Core', () => {
        assert.deepStrictEqual(DWT_ADDRESSES, {
            CPUID: '0xE000ED00', DEMCR: '0xE000EDFC', DWT_CTRL: '0xE0001000', DWT_CYCCNT: '0xE0001004',
        });
        assert.strictEqual(DEMCR_TRCENA, 0x01000000, 'DCB_DEMCR_TRCENA_Pos 24');
        assert.strictEqual(DWT_CTRL_CYCCNTENA, 0x00000001, 'DWT_CTRL_CYCCNTENA_Pos 0');
        assert.strictEqual(DWT_CTRL_NOCYCCNT, 0x02000000, 'DWT_CTRL_NOCYCCNT_Pos 25');
    });

    test('NOCYCCNT lies below NUMCOMP: a core with a cycle counter is seen whatever its number of comparators', () => {
        for (let numcomp = 0; numcomp <= 15; numcomp++) {
            assert.strictEqual(((numcomp << 28) >>> 0) & DWT_CTRL_NOCYCCNT, 0, `NUMCOMP=${numcomp}`);
        }
        assert.strictEqual(0x10000000 & DWT_CTRL_NOCYCCNT, 0, 'one comparator, cycle counter present');
        assert.strictEqual(0x30000000 & DWT_CTRL_NOCYCCNT, 0, 'three comparators, cycle counter present');
        assert.strictEqual(0x40000000 & DWT_CTRL_NOCYCCNT, 0, 'Cortex-M4: four comparators, cycle counter present');
    });

    test('NOCYCCNT is set where the cycle counter is missing', () => {
        // Cortex-M23: NOTRCPKT, NOCYCCNT and NOPRFCNT are RES1 without the Main Extension.
        assert.notStrictEqual(0x2b000000 & DWT_CTRL_NOCYCCNT, 0, 'Cortex-M23, two comparators');
        assert.notStrictEqual(0x4b000000 & DWT_CTRL_NOCYCCNT, 0, 'Cortex-M23, four comparators');
        assert.notStrictEqual(0x1b000000 & DWT_CTRL_NOCYCCNT, 0, 'Armv7-M without cycle counter, one comparator');
    });

    test('Armv6-M and Armv8-M Baseline never have a cycle counter, whatever DWT_CTRL holds', () => {
        // CPUID: implementer, variant, ARCHITECTURE (bits 19:16), part number, revision.
        const none: [string, number][] = [
            ['Cortex-M0 r0p0', 0x410cc200], ['Cortex-M0+ r0p1', 0x410cc601], ['Cortex-M1 r1p0', 0x411cc210],
            ['SC000 r0p0', 0x410cc300], ['Cortex-M23 r1p0', 0x411cd200],
        ];
        for (const [core, cpuid] of none) {
            assert.strictEqual(architectureHasCycleCounter(cpuid), false, core);
        }
        // Armv6-M's DWT_CTRL is NUMCOMP alone, so it cannot say so itself.
        assert.strictEqual(0x20000000 & DWT_CTRL_NOCYCCNT, 0, 'Cortex-M0+ with two comparators');
    });

    test('Armv7-M and Armv8-M Mainline leave it to DWT_CTRL.NOCYCCNT', () => {
        const some: [string, number][] = [
            ['Cortex-M3 r2p1', 0x412fc231], ['Cortex-M4 r0p1', 0x410fc241], ['Cortex-M7 r1p2', 0x411fc272],
            ['SC300 r0p1', 0x410fc331], ['Cortex-M33 r0p4', 0x410fd214], ['Cortex-M55 r1p0', 0x411fd220],
            ['Cortex-M85 r0p0', 0x410fd230], ['Star-MC1 r0p0', 0x630f1320],
        ];
        for (const [core, cpuid] of some) {
            assert.strictEqual(architectureHasCycleCounter(cpuid), true, core);
        }
        assert.strictEqual(architectureHasCycleCounter(0), true, 'a CPUID that reads 0 leaves the answer to DWT_CTRL');
    });
});
