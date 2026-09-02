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
import { decodeFault, decodeFaultRegisters, faultRegistersFromBlock, FaultRegisters } from '../core/faultDecoder';

/**
 * get_fault_info's text is what agents (and the skill) have learnt to read;
 * the structured decode underneath it feeds diagnose_fault. Pin both: every
 * bit, the class precedence, and that the text did not change for the bits
 * that existed before.
 */
suite('Fault decoder', () => {

    const regs = (over: Partial<FaultRegisters> = {}): FaultRegisters =>
        ({ CFSR: 0, HFSR: 0, DFSR: 0, MMFAR: 0, BFAR: 0, AFSR: 0, ...over });

    test('a precise bus fault escalated to HardFault decodes class, address and flags', () => {
        const d = decodeFault(regs({ CFSR: 0x8200, HFSR: 0x40000000, BFAR: 0x40005400 }));
        assert.strictEqual(d.faultClass, 'BusFault');
        assert.strictEqual(d.escalated, true);
        assert.deepStrictEqual(d.faultAddress, { source: 'BFAR', value: 0x40005400 });
        assert.deepStrictEqual(d.flags.map(f => f.name), ['FORCED', 'BFARVALID', 'PRECISERR']);
        const text = decodeFaultRegisters(regs({ CFSR: 0x8200, HFSR: 0x40000000, BFAR: 0x40005400 }));
        assert.match(text, /HFSR  = 0x40000000\n  FORCED: Escalated fault \(check CFSR for root cause\)\n/);
        assert.match(text, /BFSR  = 0x82\n  BFARVALID: Faulting address = 0x40005400\n  PRECISERR: Precise data bus error\n/);
    });

    test('class precedence: MemManage before BusFault before UsageFault before bare HardFault', () => {
        assert.strictEqual(decodeFault(regs({ CFSR: 0x0002 })).faultClass, 'MemManage');
        assert.strictEqual(decodeFault(regs({ CFSR: 0x0002 | 0x0200 })).faultClass, 'MemManage');
        assert.strictEqual(decodeFault(regs({ CFSR: 0x0200 | 0x00010000 })).faultClass, 'BusFault');
        assert.strictEqual(decodeFault(regs({ CFSR: 0x00010000 })).faultClass, 'UsageFault');
        assert.strictEqual(decodeFault(regs({ HFSR: 0x2 })).faultClass, 'HardFault');
        assert.strictEqual(decodeFault(regs()).faultClass, 'None');
        assert.strictEqual(decodeFault(regs({ CFSR: 0x80, MMFAR: 0x20 })).faultClass, 'None', 'MMARVALID alone is not a fault');
    });

    test('MMFAR is only reported with MMARVALID, and BFAR wins when both are valid', () => {
        assert.strictEqual(decodeFault(regs({ CFSR: 0x0002, MMFAR: 0x10 })).faultAddress, undefined);
        assert.deepStrictEqual(decodeFault(regs({ CFSR: 0x0082, MMFAR: 0x10 })).faultAddress, { source: 'MMFAR', value: 0x10 });
        assert.deepStrictEqual(decodeFault(regs({ CFSR: 0x8082, MMFAR: 0x10, BFAR: 0x20 })).faultAddress, { source: 'BFAR', value: 0x20 });
    });

    test('the two new bits decode: STKOF (Armv8-M) and DEBUGEVT', () => {
        const stkof = decodeFault(regs({ CFSR: 0x00100000 }));
        assert.deepStrictEqual(stkof.flags.map(f => f.name), ['STKOF']);
        assert.match(decodeFaultRegisters(regs({ CFSR: 0x00100000 })), /UFSR  = 0x0010\n  STKOF: Stack overflow/);
        assert.deepStrictEqual(decodeFault(regs({ HFSR: 0x80000000 })).flags.map(f => f.name), ['DEBUGEVT']);
    });

    test('every UsageFault and DFSR bit is named in report order', () => {
        const d = decodeFault(regs({ CFSR: 0x031F0000, DFSR: 0x1F }));
        assert.deepStrictEqual(d.flags.map(f => f.name),
            ['DIVBYZERO', 'UNALIGNED', 'STKOF', 'NOCP', 'INVPC', 'INVSTATE', 'UNDEFINSTR', 'EXTERNAL', 'VCATCH', 'DWTTRAP', 'BKPT', 'HALTED']);
    });

    test('the text form for a clean core is unchanged', () => {
        assert.strictEqual(decodeFaultRegisters(regs()),
            '=== Cortex-M Fault Analysis ===\n\nHFSR  = 0x00000000\n\nMMFSR = 0x00\n\nBFSR  = 0x00\n\nUFSR  = 0x0000\n\nDFSR  = 0x00000000\n\nNo fault flags set. Target may not be in a fault handler.\n');
        assert.match(decodeFaultRegisters(regs({ AFSR: 0x5 })), /AFSR  = 0x00000005 \(implementation-defined\)/);
    });

    test('the six registers come out of one 24-byte block in SCS order', () => {
        const buf = Buffer.alloc(24);
        [0x8200, 0x40000000, 0x1, 0x11, 0x40005400, 0x0].forEach((v, i) => buf.writeUInt32LE(v, i * 4));
        assert.deepStrictEqual(faultRegistersFromBlock(buf), { CFSR: 0x8200, HFSR: 0x40000000, DFSR: 1, MMFAR: 0x11, BFAR: 0x40005400, AFSR: 0 });
        assert.throws(() => faultRegistersFromBlock(Buffer.alloc(20)), /24/);
    });
});
