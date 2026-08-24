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

import { DecodedFault } from './faultDecoder';
import { SvdDevice } from './svdParser';
import { lookupAddress } from './svdLookup';
import { regionOf } from './memoryMap';
import { StackFrame } from '../debugState';

/**
 * One-call fault triage for diagnose_fault: where the exception frame is,
 * what it says, what the faulting address is, and the most likely causes with
 * the next tool call for each. Pure — the handler does the reads.
 */

const hex8 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

export interface ExceptionFrameSelection {
    /** LR holds an EXC_RETURN value, i.e. the core is halted inside a handler. */
    isExcReturn: boolean;
    source: 'PSP' | 'MSP' | null;
    sp: number | null;
    /** FP-extended frame (26 words) rather than the basic 8. */
    extended: boolean;
}

/** EXC_RETURN: bit 2 selects PSP, bit 4 clear means an FP-extended frame. */
export function selectExceptionFrame(lr: number | undefined, msp: number | undefined, psp: number | undefined): ExceptionFrameSelection {
    if (lr === undefined || (lr >>> 28) !== 0xF) {
        return { isExcReturn: false, source: null, sp: null, extended: false };
    }
    const usesPsp = (lr & (1 << 2)) !== 0;
    const sp = usesPsp ? psp : msp;
    return { isExcReturn: true, source: usesPsp ? 'PSP' : 'MSP', sp: sp ?? null, extended: (lr & (1 << 4)) === 0 };
}

export interface StackedFrame {
    r0: number; r1: number; r2: number; r3: number; r12: number; lr: number; pc: number; xpsr: number;
}

/** The basic exception frame: R0–R3, R12, LR, PC, xPSR, little-endian. */
export function parseStackedFrame(buf: Buffer): StackedFrame | null {
    if (buf.length < 32) { return null; }
    const w = (i: number) => buf.readUInt32LE(i * 4);
    return { r0: w(0), r1: w(1), r2: w(2), r3: w(3), r12: w(4), lr: w(5), pc: w(6), xpsr: w(7) };
}

export interface AddressInfo {
    addr: number;
    /** From the system map: code, sram, peripheral, ppb, … */
    region: string;
    regionName: string;
    peripheral?: string;
    register?: string;
    /** Below 0x100 — a null pointer plus a small offset. */
    nearNull: boolean;
}

/** What an address is, from the SVD when it covers it, else the Cortex-M system map. */
export function classifyAddress(addr: number, device: SvdDevice | null): AddressInfo {
    const region = regionOf(addr);
    const info: AddressInfo = {
        addr: addr >>> 0,
        region: region?.kind ?? 'unknown',
        regionName: region?.name ?? 'outside the system map',
        nearNull: (addr >>> 0) < 0x100,
    };
    if (device) {
        const hit = lookupAddress(device, addr >>> 0);
        if (hit) {
            info.peripheral = hit.peripheral.name;
            info.register = hit.register?.name;
        }
    }
    return info;
}

export function formatAddressInfo(info: AddressInfo): string {
    if (info.peripheral) {
        return `${hex8(info.addr)} = ${info.peripheral}${info.register ? `.${info.register}` : ''} (${info.regionName})`;
    }
    if (info.nearNull) { return `${hex8(info.addr)} — a null pointer plus ${info.addr} (${info.regionName})`; }
    return `${hex8(info.addr)} (${info.regionName}${info.region === 'peripheral' ? ', not in the SVD' : ''})`;
}

export interface Hypothesis {
    text: string;
    confidence: 'high' | 'medium' | 'low';
    nextCall: string;
}

export interface TriageInput {
    decoded: DecodedFault;
    frame: StackedFrame | null;
    selection: ExceptionFrameSelection;
    regs: { sp?: number; lr?: number; pc?: number; xpsr?: number; msp?: number; psp?: number; msplim?: number; psplim?: number };
    faultAddress?: AddressInfo;
    /** The instruction that faulted: the stacked PC when there is a frame, else the live PC. */
    pcInfo?: AddressInfo;
}

/** Ordered by how strongly the evidence supports each; at most three are shown. */
export function hypothesize(input: TriageInput): Hypothesis[] {
    const { decoded, regs, faultAddress, pcInfo, selection } = input;
    const has = (name: string) => decoded.flags.some(f => f.name === name);
    const out: Hypothesis[] = [];
    const pcHex = pcInfo ? hex8(pcInfo.addr) : '<PC>';

    if (has('STKOF') || has('STKERR') || has('MSTKERR')) {
        const lim = selection.source === 'PSP' ? regs.psplim : regs.msplim;
        const spNow = selection.source === 'PSP' ? regs.psp : regs.msp;
        const below = lim !== undefined && spNow !== undefined && spNow < lim ? ` (${selection.source} ${hex8(spNow)} is below its limit ${hex8(lim)})` : '';
        out.push({
            text: `Stack overflow: the exception frame could not be pushed${below}. Deep recursion, a large local array, or an RTOS task stack that is too small.`,
            confidence: 'high',
            nextCall: 'read_core_registers, then compare MSP/PSP with the stack bounds from the linker map (evaluate_expression on the stack symbol)',
        });
    }
    if ((has('PRECISERR') || has('DACCVIOL')) && faultAddress) {
        if (faultAddress.peripheral || faultAddress.region === 'peripheral') {
            const what = faultAddress.peripheral ? `${faultAddress.peripheral}${faultAddress.register ? '.' + faultAddress.register : ''}` : 'a peripheral address not in the SVD';
            out.push({
                text: `Precise access to ${what}: the peripheral's clock is gated, the block is disabled, or it does not exist on this part. An unclocked block bus-faults on the first access.`,
                confidence: 'high',
                nextCall: `read_peripheral_register on the clock-enable register (RCC AHBxENR/APBxENR or the vendor's equivalent), then lookup_peripheral { address: '${hex8(faultAddress.addr)}' }`,
            });
        } else if (faultAddress.nearNull) {
            out.push({
                text: `Null-pointer dereference: the access went to ${hex8(faultAddress.addr)}, a struct or array member through a null base.`,
                confidence: 'high',
                nextCall: `get_frame_variables on the faulting frame — which pointer was null; the stacked R0–R3 above hold the arguments`,
            });
        } else {
            out.push({
                text: `Access to ${formatAddressInfo(faultAddress)}: a wild or stale pointer, or an index past the end of a buffer.`,
                confidence: 'medium',
                nextCall: 'get_frame_variables on the faulting frame; read_memory around the address to see what is there',
            });
        }
    }
    if (has('IMPRECISERR')) {
        out.push({
            text: `Imprecise bus error: a buffered write faulted after the core moved on, so the stacked PC ${pcHex} is past the store. Look one or two stores back — typically a write to an unclocked peripheral or beyond RAM.`,
            confidence: 'medium',
            nextCall: `read_memory { address: '${pcHex}', length: 32 } (disassemble the instructions before PC), or set a breakpoint before the suspect write and step`,
        });
    }
    if (has('IBUSERR') || has('IACCVIOL') || (pcInfo && pcInfo.region !== 'code' && decoded.faultClass !== 'None')) {
        out.push({
            text: `Execution left the code region (PC ${pcHex}): a corrupted function pointer, a return address overwritten by a stack overflow, or a jump table indexed out of range.`,
            confidence: pcInfo && pcInfo.region !== 'code' ? 'high' : 'medium',
            nextCall: 'get_call_stack (the frame below the fault shows who jumped); read_memory at the stacked SP for the overwritten return address',
        });
    }
    if (has('UNDEFINSTR') || has('INVSTATE')) {
        out.push({
            text: has('INVSTATE')
                ? `Branch to an even address: Thumb needs bit 0 set in the target, so a function pointer or vector entry is missing the Thumb bit (PC ${pcHex}).`
                : `Undefined instruction at ${pcHex}: executing data, a jump into the middle of an instruction, or an instruction the core does not implement (e.g. FP or DSP on an M0/M3).`,
            confidence: 'high',
            nextCall: `read_memory { address: '${pcHex}', length: 16 } to see what was fetched; check the vector table and function pointers for a missing Thumb bit`,
        });
    }
    if (has('UNALIGNED')) {
        out.push({
            text: 'Unaligned access with UNALIGN_TRP set (or a multi-word/exclusive access, which always traps): a packed struct member, a cast of a byte pointer to a wider type, or a misaligned DMA buffer.',
            confidence: 'high',
            nextCall: 'get_frame_variables on the faulting frame — find the pointer whose value is not a multiple of the access size',
        });
    }
    if (has('DIVBYZERO')) {
        out.push({
            text: 'Integer division by zero with DIV_0_TRP set in CCR.',
            confidence: 'high',
            nextCall: 'get_frame_variables on the faulting frame for the divisor',
        });
    }
    if (has('NOCP')) {
        out.push({
            text: 'Coprocessor access with the FPU off: CPACR does not grant CP10/CP11, or the code was built with FP instructions for a core without an FPU.',
            confidence: 'high',
            nextCall: "read_memory { address: '0xE000ED88', length: 4 } (CPACR) — bits 20–23 must be set; check SystemInit enables the FPU",
        });
    }
    if (has('VECTTBL')) {
        out.push({
            text: 'Vector table fetch failed: VTOR points at the wrong image or an unprogrammed region.',
            confidence: 'high',
            nextCall: "read_memory { address: '0xE000ED08', length: 4 } (VTOR) and compare with the linker's vector table address",
        });
    }
    if (has('INVPC') || has('UNSTKERR') || has('MUNSTKERR')) {
        out.push({
            text: 'Corrupted exception return: the stacked frame was overwritten before the handler returned (stack overflow into the frame, or a wrong EXC_RETURN).',
            confidence: 'medium',
            nextCall: 'read_memory at the stacked SP (32 bytes) and compare with what the frame should hold',
        });
    }
    if (has('MLSPERR') || has('LSPERR')) {
        out.push({
            text: 'Fault during FP lazy state preservation: the FP context could not be saved — the stack reserved for it is unmapped or too small.',
            confidence: 'low',
            nextCall: 'read_core_registers (CONTROL.FPCA) and check the stack size for FP-using tasks',
        });
    }
    if (out.length === 0 && decoded.escalated) {
        out.push({
            text: 'HardFault with no configurable-fault bit set: a fault inside a fault handler, or a fault taken with the configurable handlers disabled and the status already cleared.',
            confidence: 'low',
            nextCall: 'get_call_stack to see whether a handler was already active; enable the MemManage/BusFault/UsageFault handlers to get a precise class',
        });
    }
    return out;
}

export interface DiagnosisInput extends TriageInput {
    stopReason?: string | null;
    frames: StackFrame[];
    frameNote?: string;
    /** Sections that timed out or failed, by name. */
    skipped: string[];
    svdNote?: string;
    /** Frames shown before the rest is counted. */
    maxFrames?: number;
}

const IPSR_NAMES: Record<number, string> = { 2: 'NMI', 3: 'HardFault', 4: 'MemManage', 5: 'BusFault', 6: 'UsageFault', 7: 'SecureFault', 11: 'SVCall', 12: 'DebugMonitor', 14: 'PendSV', 15: 'SysTick' };

/** The diagnose_fault report; at most ~40 lines. */
export function renderDiagnosis(input: DiagnosisInput): string {
    const { decoded, frame, selection, regs, frames, skipped } = input;
    const lines: string[] = [];
    const flagNames = decoded.flags.filter(f => f.reg !== 'DFSR').map(f => f.name);
    const ipsr = regs.xpsr !== undefined ? regs.xpsr & 0x1FF : undefined;
    const ipsrText = ipsr === undefined ? '' : ipsr === 0 ? 'thread mode' : `exception ${ipsr}${IPSR_NAMES[ipsr] ? ` (${IPSR_NAMES[ipsr]})` : ipsr >= 16 ? ` (IRQ ${ipsr - 16})` : ''}`;

    if (decoded.faultClass === 'None') {
        lines.push('=== No fault flags set ===');
        lines.push(`Stop: ${input.stopReason ?? 'unknown reason'}${ipsrText ? `, ${ipsrText}` : ''}${regs.pc !== undefined ? `, PC ${hex8(regs.pc)}` : ''}`);
        if (frames.length) {
            lines.push('Call stack:');
            for (const [i, f] of frames.slice(0, input.maxFrames ?? 3).entries()) {
                lines.push(`  #${i} ${f.name} @ ${f.source ?? '<no source>'}:${f.line ?? '?'}`);
            }
        }
        lines.push('The target is not in a fault: CFSR and HFSR are clear. If it faulted earlier, the flags were cleared by a reset or by the handler.');
        lines.push('Next: get_call_stack for where it stopped; wait_for_stop after continue_execution to catch the fault when it happens.');
        return lines.join('\n');
    }

    lines.push('=== Fault diagnosis ===');
    lines.push(`Class: ${decoded.faultClass}${decoded.escalated ? ' escalated to HardFault (FORCED)' : ''} — ${flagNames.join(', ') || 'no status bits'}`);
    lines.push(`Stop: ${input.stopReason ?? 'unknown reason'}${ipsrText ? `, halted in ${ipsrText}` : ''}`);
    if (input.faultAddress) {
        lines.push(`Fault address (${decoded.faultAddress?.source}): ${formatAddressInfo(input.faultAddress)}`);
    }

    if (frame && selection.sp !== null) {
        lines.push(`Exception frame: ${selection.source} @ ${hex8(selection.sp)}${selection.extended ? ', FP-extended' : ''} (EXC_RETURN ${hex8(regs.lr ?? 0)})`);
        lines.push(`  R0=${hex8(frame.r0)} R1=${hex8(frame.r1)} R2=${hex8(frame.r2)} R3=${hex8(frame.r3)} R12=${hex8(frame.r12)}`);
        const precise = decoded.flags.some(f => ['PRECISERR', 'DACCVIOL', 'IACCVIOL', 'IBUSERR', 'UNDEFINSTR', 'INVSTATE', 'UNALIGNED', 'DIVBYZERO', 'NOCP'].includes(f.name));
        lines.push(`  PC=${hex8(frame.pc)} ${precise ? '← faulting instruction' : '(imprecise: the fault happened before this)'}  LR=${hex8(frame.lr)} (caller)  xPSR=${hex8(frame.xpsr)}`);
        if (input.pcInfo) { lines.push(`  PC is in ${input.pcInfo.regionName}${input.pcInfo.region !== 'code' ? ' — not code' : ''}`); }
    } else if (input.frameNote) {
        lines.push(`Exception frame: ${input.frameNote}`);
    }

    const now: string[] = [];
    if (regs.pc !== undefined) { now.push(`PC=${hex8(regs.pc)}`); }
    if (regs.sp !== undefined) { now.push(`SP=${hex8(regs.sp)}`); }
    if (regs.msp !== undefined) { now.push(`MSP=${hex8(regs.msp)}`); }
    if (regs.psp !== undefined) { now.push(`PSP=${hex8(regs.psp)}`); }
    if (regs.msplim !== undefined) { now.push(`MSPLIM=${hex8(regs.msplim)}`); }
    if (regs.psplim !== undefined) { now.push(`PSPLIM=${hex8(regs.psplim)}`); }
    if (now.length) { lines.push(`Registers now: ${now.join(' ')}`); }

    if (frames.length) {
        const max = input.maxFrames ?? 3;
        lines.push(`Call stack (${frames.length}${frames.length > max ? `, top ${max}` : ''}):`);
        for (const [i, f] of frames.slice(0, max).entries()) {
            lines.push(`  #${i} ${f.name} @ ${f.source ?? '<no source>'}:${f.line ?? '?'}${f.frameId !== undefined ? ` [frameId=${f.frameId}]` : ''}`);
        }
    }

    const hypotheses = hypothesize(input).slice(0, 3);
    if (hypotheses.length) {
        lines.push('Hypotheses:');
        hypotheses.forEach((h, i) => {
            lines.push(`  ${i + 1}. [${h.confidence}] ${h.text}`);
            lines.push(`     next: ${h.nextCall}`);
        });
    }
    if (input.svdNote) { lines.push(`Note: ${input.svdNote}`); }
    if (skipped.length) { lines.push(`Skipped (timeout or read failure): ${skipped.join(', ')} — get_fault_info / read_core_registers / get_call_stack read them individually.`); }
    lines.push(`Next: ${hypotheses[0]?.nextCall ?? 'get_call_stack, then get_frame_variables on the faulting frame'}`);
    return lines.join('\n');
}
