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
    bankedStackRegisters, classifyAddress, hypothesize, parseStackedFrame, renderDiagnosis, selectExceptionFrame, DiagnosisInput,
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
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFFD, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'PSP', sp: 0x2000ff00, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFF9, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFF1, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFED, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'PSP', sp: 0x2000ff00, extended: true, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFE9, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: true, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFE1, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: true, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0x08001235, 0x20000f00, 0x2000ff00), { isExcReturn: false, source: null, sp: null, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(undefined, 1, 2), { isExcReturn: false, source: null, sp: null, extended: false, stateOffset: 0 });
        // Armv6-M and Armv7-M set S, DCRS and ES: nothing banked is read for them.
        for (const lr of [0xFFFFFFF1, 0xFFFFFFF9, 0xFFFFFFFD, 0xFFFFFFE1, 0xFFFFFFE9, 0xFFFFFFED]) {
            assert.deepStrictEqual(bankedStackRegisters(lr), [], lr.toString(16));
        }
        // FNC_RETURN, the return payload of a Secure call into Non-secure code, is not an EXC_RETURN.
        assert.deepStrictEqual(selectExceptionFrame(0xFEFFFFFF, 0x20000f00, 0x2000ff00), { isExcReturn: false, source: null, sp: null, extended: false, stateOffset: 0 });
    });

    test('Armv8-M without the Security Extension: S and ES read zero, the frame is on MSP or PSP', () => {
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFBC, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'PSP', sp: 0x2000ff00, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFB8, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFB0, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'MSP', sp: 0x20000f00, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFAC, 0x20000f00, 0x2000ff00), { isExcReturn: true, source: 'PSP', sp: 0x2000ff00, extended: true, stateOffset: 0 });
        assert.deepStrictEqual(bankedStackRegisters(0xFFFFFFBC), []);
    });

    test('TrustZone: DCRS clear puts the integrity signature and R4–R11 below R0', () => {
        // Secure handler, Secure background (S = ES = 1) with the additional state context on PSP_S, the current PSP.
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFDD, 0x30000f00, 0x3000ff00), { isExcReturn: true, source: 'PSP', sp: 0x3000ff00, extended: false, stateOffset: 0x28 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFCD, 0x30000f00, 0x3000ff00), { isExcReturn: true, source: 'PSP', sp: 0x3000ff00, extended: true, stateOffset: 0x28 });
        assert.deepStrictEqual(bankedStackRegisters(0xFFFFFFDD), []);
        // DCRS clear on a Non-secure stack adds nothing: PopStack unstacks the additional state context only from a Secure stack.
        assert.strictEqual(selectExceptionFrame(0xFFFFFF9C, 0x20000f00, 0x2000ff00).stateOffset, 0);
    });

    test('TrustZone: a frame on the other Security state\'s stack is read from that state\'s banked stack pointer', () => {
        const banked = { msp_s: 0x30000f00, psp_s: 0x3000ff00, msp_ns: 0x20000e00, psp_ns: 0x2000fe00 };
        // Non-secure handler, Secure background (S = 1, ES = 0): the additional state context is always there, and
        // CONTROL_S.SPSEL, not EXC_RETURN bit 2 (the Non-secure state's), picks the process stack.
        assert.deepStrictEqual(bankedStackRegisters(0xFFFFFFF8), ['msp_s', 'psp_s', 'control_s']);
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFF8, 0x20000f00, 0x2000ff00, { ...banked, control_s: 0x2 }),
            { isExcReturn: true, source: 'PSP_S', sp: 0x3000ff00, extended: false, stateOffset: 0x28 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFFC, 0x20000f00, 0x2000ff00, { ...banked, control_s: 0x1 }),
            { isExcReturn: true, source: 'MSP_S', sp: 0x30000f00, extended: false, stateOffset: 0x28 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFE8, 0x20000f00, 0x2000ff00, { ...banked, control_s: 0x6 }),
            { isExcReturn: true, source: 'PSP_S', sp: 0x3000ff00, extended: true, stateOffset: 0x28 });
        // Secure handler, Non-secure background (S = 0, ES = 1), e.g. a SecureFault in Non-secure code: no additional state context.
        assert.deepStrictEqual(bankedStackRegisters(0xFFFFFFB9), ['msp_ns', 'psp_ns', 'control_ns']);
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFB9, 0x30000f00, 0x3000ff00, { ...banked, control_ns: 0x2 }),
            { isExcReturn: true, source: 'PSP_NS', sp: 0x2000fe00, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFAD, 0x30000f00, 0x3000ff00, { ...banked, control_ns: 0x0 }),
            { isExcReturn: true, source: 'MSP_NS', sp: 0x20000e00, extended: true, stateOffset: 0 });
        // From Handler mode the frame is on the banked MSP, whatever CONTROL says.
        assert.deepStrictEqual(bankedStackRegisters(0xFFFFFFB1), ['msp_ns']);
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFB1, 0x30000f00, 0x3000ff00, banked),
            { isExcReturn: true, source: 'MSP_NS', sp: 0x20000e00, extended: false, stateOffset: 0 });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFF0, 0x20000f00, 0x2000ff00, banked),
            { isExcReturn: true, source: 'MSP_S', sp: 0x30000f00, extended: false, stateOffset: 0x28 });
    });

    test('TrustZone: a banked register the GDB server does not report leaves the frame unread, and says why', () => {
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFB9, 0x30000f00, 0x3000ff00), {
            isExcReturn: true, source: null, sp: null, extended: false, stateOffset: 0,
            note: 'on MSP_NS or PSP_NS, as CONTROL_NS selects, which the GDB server did not report — MSP and PSP are the Secure state\'s (EXC_RETURN 0xffffffb9)',
        });
        assert.deepStrictEqual(selectExceptionFrame(0xFFFFFFF8, 0x20000f00, 0x2000ff00, { msp_s: 0x30000f00, control_s: 0x2 }), {
            isExcReturn: true, source: 'PSP_S', sp: null, extended: false, stateOffset: 0x28,
            note: 'on PSP_S, which the GDB server did not report — MSP and PSP are the Non-secure state\'s (EXC_RETURN 0xfffffff8)',
        });
    });

    test('the basic frame is eight little-endian words', () => {
        const buf = Buffer.alloc(32);
        [1, 2, 3, 4, 12, 0x08001235, 0x08004000, 0x21000003].forEach((v, i) => buf.writeUInt32LE(v, i * 4));
        assert.deepStrictEqual(parseStackedFrame(buf), { r0: 1, r1: 2, r2: 3, r3: 4, r12: 12, lr: 0x08001235, pc: 0x08004000, xpsr: 0x21000003 });
        assert.strictEqual(parseStackedFrame(Buffer.alloc(16)), null);
    });

    test('behind the additional state context, R0 is at +0x28 and the signature at SP', () => {
        const buf = Buffer.alloc(0x48);
        buf.writeUInt32LE(0xFEFA125B, 0);
        [4, 5, 6, 7, 8, 9, 10, 11].forEach((v, i) => buf.writeUInt32LE(v, 8 + i * 4));
        [1, 2, 3, 4, 12, 0x10001235, 0x10004000, 0x21000003].forEach((v, i) => buf.writeUInt32LE(v, 0x28 + i * 4));
        assert.deepStrictEqual(parseStackedFrame(buf, 0x28),
            { r0: 1, r1: 2, r2: 3, r3: 4, r12: 12, lr: 0x10001235, pc: 0x10004000, xpsr: 0x21000003, signature: 0xFEFA125B });
        assert.strictEqual(parseStackedFrame(buf.subarray(0, 0x40), 0x28), null);
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
        selection: { isExcReturn: false, source: null, sp: null, extended: false, stateOffset: 0 },
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
        assert.deepStrictEqual(fire({ decoded: decodeFault(regs({ CFSR: 0x00100000 })), selection: { isExcReturn: true, source: 'PSP', sp: 0x2000f000, extended: false, stateOffset: 0 }, regs: { psp: 0x2000f000, psplim: 0x20010000 } })[0],
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
            selection: { isExcReturn: true, source: 'PSP', sp: 0x2000f000, extended: false, stateOffset: 0 },
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
            selection: { isExcReturn: true, source: 'PSP', sp: 0x2000ff00, extended: false, stateOffset: 0 },
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

    test('a TrustZone frame names its banked stack and where R0 is, and checks the integrity signature', () => {
        const stacked = (signature: number): Buffer => {
            const buf = Buffer.alloc(0x48);
            buf.writeUInt32LE(signature, 0);
            [0, 0x40005400, 0, 0, 0, 0x10001235, 0x10004000, 0x21000000].forEach((v, i) => buf.writeUInt32LE(v, 0x28 + i * 4));
            return buf;
        };
        const diagnose = (signature: number, lr: number): string[] => renderDiagnosis(input({
            decoded: decodeFault(regs({ CFSR: 0x8200, HFSR: 0x40000000, BFAR: 0x40005400 })),
            frame: parseStackedFrame(stacked(signature), 0x28),
            selection: selectExceptionFrame(lr, 0x20000f00, 0x2000ff00, { msp_s: 0x30000f00, psp_s: 0x3000ff00, control_s: 0x2 }),
            regs: { pc: 0x0800000c, sp: 0x20000f00, lr, xpsr: 0x3, msp: 0x20000f00, psp: 0x2000ff00 },
            faultAddress: classifyAddress(0x40005400, device),
            stopReason: 'exception',
        })).split('\n');
        const lines = diagnose(0xFEFA125B, 0xFFFFFFF8);
        assert.strictEqual(lines[4], 'Exception frame: PSP_S @ 0x3000ff00, R0 at +0x28 after the integrity signature and R4–R11 (EXC_RETURN 0xfffffff8)');
        assert.match(lines[6], /^ {2}PC=0x10004000 ← faulting instruction {2}LR=0x10001235 \(caller\) {2}xPSR=0x21000000$/);
        assert.strictEqual(diagnose(0xFEFA125A, 0xFFFFFFE8)[4],
            'Exception frame: PSP_S @ 0x3000ff00, FP-extended, R0 at +0x28 after the integrity signature and R4–R11 (EXC_RETURN 0xffffffe8)');
        assert.strictEqual(diagnose(0, 0xFFFFFFF8)[5],
            '  Integrity signature 0x00000000 is not 0xfefa125b: the stack was overwritten, or the frame is not where EXC_RETURN says');
        assert.strictEqual(diagnose(0xFEFA125B, 0xFFFFFFE8)[5],
            '  Integrity signature 0xfefa125b is not 0xfefa125a: the stack was overwritten, or the frame is not where EXC_RETURN says');
    });

    test('the stack-overflow hypothesis compares the frame\'s own stack with its limit', () => {
        const overflow = (over: Partial<DiagnosisInput>): string => hypothesize(input({ decoded: decodeFault(regs({ CFSR: 0x00100000 })), ...over }))[0].text;
        assert.match(overflow({ selection: selectExceptionFrame(0xFFFFFFF9, 0x20000f00, 0x2000ff00), regs: { msp: 0x20000f00, msplim: 0x20001000 } }),
            /\(MSP 0x20000f00 is below its limit 0x20001000\)/);
        // The limits read belong to the state the core is in, not to a banked stack of the other one.
        assert.doesNotMatch(overflow({
            selection: selectExceptionFrame(0xFFFFFFB1, 0x20000f00, 0x2000ff00, { msp_ns: 0x2000fe00 }),
            regs: { msp: 0x20000f00, msplim: 0x20001000 },
        }), /below its limit/);
    });

    test('with no fault flags the report is a short stop context', () => {
        const out = renderDiagnosis(input({ stopReason: 'breakpoint', regs: { pc: 0x08000100, xpsr: 0 }, frames: [{ name: 'main', source: 'main.c', line: 10 }] }));
        const lines = out.split('\n');
        assert.ok(lines.length <= 10);
        assert.strictEqual(lines[0], '=== No fault flags set ===');
        assert.strictEqual(lines[1], 'Stop: breakpoint, thread mode, PC 0x08000100');
        assert.match(out, /Next: get_call_stack/);
        assert.match(out, /The target is not in a fault: CFSR and HFSR are clear/);
    });

    test('with no fault flags but a fault handler active, the report does not say the target is not in a fault', () => {
        for (const [xpsr, handler] of [[0x61000003, 'HardFault'], [0x01000004, 'MemManage'], [0x01000007, 'SecureFault']] as const) {
            const out = renderDiagnosis(input({ stopReason: 'breakpoint', regs: { pc: 0x1000219e, xpsr } }));
            assert.doesNotMatch(out, /not in a fault/);
            assert.ok(out.includes(`The fault status reads clear (CFSR and HFSR 0), yet the ${handler} handler is active: `
                + 'the handler cleared it, or the debug server does not report it.'), out);
            assert.match(out, /Next: get_call_stack for where the exception came from\.$/);
        }
        for (const xpsr of [0x01000002, 0x0100000b, 0x01000010]) {
            assert.match(renderDiagnosis(input({ regs: { xpsr } })), /The target is not in a fault/, `exception ${xpsr & 0x1ff} is no fault handler`);
        }
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
