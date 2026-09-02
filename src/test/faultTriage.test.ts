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
import * as fs from 'fs';
import * as path from 'path';
import { decodeFault, FaultRegisters } from '../core/faultDecoder';
import { parseSvdXml } from '../core/svdParser';
import {
    classifyAddress, hypothesize, parseStackedFrame, renderDiagnosis, selectExceptionFrame, DiagnosisInput,
} from '../core/faultTriage';

/**
 * diagnose_fault's reasoning, without a target: which stack the frame is on,
 * what the frame holds, what an address is, and which hypothesis fires on
 * which evidence — and only on that evidence.
 */
suite('Fault triage', () => {

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const device = parseSvdXml(fs.readFileSync(path.join(repoRoot, 'src', 'test', 'fixtures', 'test-device.svd'), 'utf8'));
    const regs = (over: Partial<FaultRegisters> = {}): FaultRegisters =>
        ({ CFSR: 0, HFSR: 0, DFSR: 0, MMFAR: 0, BFAR: 0, AFSR: 0, ...over });

    test('EXC_RETURN selects the stack and the frame layout', () => {
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFFD, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'PSP', sp: 0x2000ff00, extended: false });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFF9, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: false });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFF1, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: false });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFED, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'PSP', sp: 0x2000ff00, extended: true });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFE9, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: true });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFE1, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: true });
        assert.deepStrictEqual(selectExceptionFrame(0x08001235, 0x20000f00, 0x2000ff00), { isExcReturn: false, source: null, sp: null, extended: false });
        assert.deepStrictEqual(selectExceptionFrame(undefined, 1, 2), { isExcReturn: false, source: null, sp: null, extended: false });
    });

    test('the basic frame is eight little-endian words', () => {
        const buf = Buffer.alloc(32);
        [1, 2, 3, 4, 12, 0x08001235, 0x08004000, 0x21000003].forEach((v, i) => buf.writeUInt32LE(v, i * 4));
        assert.deepStrictEqual(parseStackedFrame(buf), { r0: 1, r1: 2, r2: 3, r3: 4, r12: 12, lr: 0x08001235, pc: 0x08004000, xpsr: 0x21000003 });
        assert.strictEqual(parseStackedFrame(Buffer.alloc(16)), null);
    });

    test('addresses are classified by the SVD first, then the system map', () => {
        const i2c = classifyAddress(0x40005400, device);
        assert.deepStrictEqual([i2c.peripheral, i2c.register, i2c.region], ['I2C1', 'CR1', 'peripheral']);
        const sram = classifyAddress(0x20001000, device);
        assert.deepStrictEqual([sram.peripheral, sram.region, sram.nearNull], [undefined, 'sram', false]);
        assert.strictEqual(classifyAddress(0x14, null).nearNull, true);
        assert.strictEqual(classifyAddress(0x40010000, null).region, 'peripheral');
    });

    const input = (over: Partial<DiagnosisInput>): DiagnosisInput => ({
        decoded: decodeFault(regs()),
        frame: null,
        selection: { isExcReturn: false, source: null, sp: null, extended: false },
        regs: {},
        frames: [],
        skipped: [],
        ...over,
    });

    test('each hypothesis fires on its evidence and not otherwise', () => {
        const fire = (over: Partial<DiagnosisInput>) => hypothesize(input(over)).map(h => h.text.split(':')[0]);

        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x8200, BFAR: 0x40005400 })), faultAddress: classifyAddress(0x40005400, device) }),
            ['Precise access to I2C1.CR1']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x0082, MMFAR: 0x14 })), faultAddress: classifyAddress(0x14, device) }),
            ['Null-pointer dereference']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x0400 })), pcInfo: classifyAddress(0x08001000, device) }),
            ['Imprecise bus error']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x00100000 })), selection: { isExcReturn: true, source: 'PSP', sp: 0x2000f000, extended: false }, regs: { psp: 0x2000f000, psplim: 0x20010000 } })[0],
            'Stack overflow');
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x00010000 })), pcInfo: classifyAddress(0x08001000, device) }),
            ['Undefined instruction at 0x08001000']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x00020000 })) }), ['Branch to an even address']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x01000000 })) }), ['Unaligned access with UNALIGN_TRP set (or a multi-word/exclusive access, which always traps)']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x02000000 })) }), ['Integer division by zero with DIV_0_TRP set in CCR.']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x00080000 })) }), ['Coprocessor access with the FPU off']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ HFSR: 0x2 })) }), ['Vector table fetch failed']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x0001, HFSR: 0x40000000 })), pcInfo: classifyAddress(0x20001000, device) }),
            ['Execution left the code region (PC 0x20001000)']);
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ HFSR: 0x40000000 })) }), ['HardFault with no configurable-fault bit set']);
        assert.deepStrictEqual(fire({}), []);
    });

    test('the stack-overflow hypothesis names the crossed limit', () => {
        const [h] = hypothesize(input({
            decoded: decodeFault(regs({ CFSR: 0x00100000 })),
            selection: { isExcReturn: true, source: 'PSP', sp: 0x2000f000, extended: false },
            regs: { psp: 0x2000f000, psplim: 0x20010000 },
        }));
        assert.match(h.text, /PSP 0x2000f000 is below its limit 0x20010000/);
    });

    test('the report is compact, ordered, and points at the next call', () => {
        const buf = Buffer.alloc(32);
        [0, 0x40005400, 0, 0, 0, 0x08001235, 0x08004000, 0x21000000].forEach((v, i) => buf.writeUInt32LE(v, i * 4));
        const out = renderDiagnosis(input({
            decoded: decodeFault(regs({ CFSR: 0x8200, HFSR: 0x40000000, BFAR: 0x40005400 })),
            frame: parseStackedFrame(buf),
            selection: { isExcReturn: true, source: 'PSP', sp: 0x2000ff00, extended: false },
            regs: { pc: 0x0800000c, sp: 0x2000ff00, lr: 0xFFFFFFFD, xpsr: 0x3, msp: 0x20000f00, psp: 0x2000ff00 },
            faultAddress: classifyAddress(0x40005400, device),
            pcInfo: classifyAddress(0x08004000, device),
            stopReason: 'exception',
            frames: [{ name: 'HardFault_Handler', source: 'startup.c', line: 120, frameId: 1000 }, { name: 'i2c_init', source: 'i2c.c', line: 42, frameId: 1001 }],
        }));
        const lines = out.split('\n');
        assert.ok(lines.length <= 40, `${lines.length} lines`);
        assert.strictEqual(lines[0], '=== Fault diagnosis ===');
        assert.strictEqual(lines[1], 'Class: BusFault escalated to HardFault (FORCED) — FORCED, BFARVALID, PRECISERR');
        assert.strictEqual(lines[2], 'Stop: exception, halted in exception 3 (HardFault)');
        assert.strictEqual(lines[3], 'Fault address (BFAR): 0x40005400 = I2C1.CR1 (Peripheral)');
        assert.strictEqual(lines[4], 'Exception frame: PSP @ 0x2000ff00 (EXC_RETURN 0xfffffffd)');
        assert.match(lines[6], /PC=0x08004000 ← faulting instruction {2}LR=0x08001235 \(caller\)/);
        assert.match(out, /Call stack \(2\):\n  #0 HardFault_Handler @ startup\.c:120 \[frameId=1000\]/);
        assert.match(out, /Hypotheses:\n  1\. \[high\] Precise access to I2C1\.CR1/);
        assert.match(out, /\nNext: read_peripheral_register on the clock-enable register/);
    });

    test('with no fault flags the report is a short stop context', () => {
        const out = renderDiagnosis(input({ stopReason: 'breakpoint', regs: { pc: 0x08000100, xpsr: 0 }, frames: [{ name: 'main', source: 'main.c', line: 10 }] }));
        const lines = out.split('\n');
        assert.ok(lines.length <= 10);
        assert.strictEqual(lines[0], '=== No fault flags set ===');
        assert.strictEqual(lines[1], 'Stop: breakpoint, thread mode, PC 0x08000100');
        assert.match(out, /Next: get_call_stack/);
    });

    test('a missing frame and skipped sections are stated, not hidden', () => {
        const out = renderDiagnosis(input({
            decoded: decodeFault(regs({ CFSR: 0x00010000 })),
            frameNote: 'LR is not an EXC_RETURN value — halted deeper inside the handler; get_call_stack has the frames',
            skipped: ['core registers'],
        }));
        assert.match(out, /Exception frame: LR is not an EXC_RETURN value/);
        assert.match(out, /Skipped \(timeout or read failure\): core registers/);
    });
});
