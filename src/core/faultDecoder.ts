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
 * Cortex-M fault register decoder.
 *
 * decodeFault() turns CFSR, HFSR, DFSR, MMFAR, BFAR and AFSR into a structured
 * DecodedFault that both get_fault_info (rendered by renderFaultReport) and
 * diagnose_fault (triage) consume. decodeFaultRegisters() is the text form
 * get_fault_info has always returned.
 */

export interface FaultRegisters {
    CFSR: number;
    HFSR: number;
    DFSR: number;
    MMFAR: number;
    BFAR: number;
    AFSR: number;
}

/** Well-known Cortex-M System Control Space (SCS) addresses */
export const FAULT_REGISTER_ADDRESSES = {
    CFSR:  '0xE000ED28',  // Configurable Fault Status Register
    HFSR:  '0xE000ED2C',  // HardFault Status Register
    DFSR:  '0xE000ED30',  // Debug Fault Status Register
    MMFAR: '0xE000ED34',  // MemManage Fault Address Register
    BFAR:  '0xE000ED38',  // BusFault Address Register
    AFSR:  '0xE000ED3C',  // Auxiliary Fault Status Register
} as const;

/** The six registers are contiguous from CFSR; one 24-byte read covers them. */
export const FAULT_REGISTER_BLOCK = { address: FAULT_REGISTER_ADDRESSES.CFSR, bytes: 24 } as const;

/** Little-endian words in SCS order: CFSR, HFSR, DFSR, MMFAR, BFAR, AFSR. */
export function faultRegistersFromBlock(buf: Buffer): FaultRegisters {
    if (buf.length < FAULT_REGISTER_BLOCK.bytes) {
        throw new Error(`fault register block is ${buf.length} bytes, need ${FAULT_REGISTER_BLOCK.bytes}`);
    }
    return {
        CFSR: buf.readUInt32LE(0),
        HFSR: buf.readUInt32LE(4),
        DFSR: buf.readUInt32LE(8),
        MMFAR: buf.readUInt32LE(12),
        BFAR: buf.readUInt32LE(16),
        AFSR: buf.readUInt32LE(20),
    };
}

export type FaultStatusRegister = 'HFSR' | 'MMFSR' | 'BFSR' | 'UFSR' | 'DFSR';
export type FaultClass = 'HardFault' | 'MemManage' | 'BusFault' | 'UsageFault' | 'None';

export interface FaultFlag {
    reg: FaultStatusRegister;
    name: string;
    bit: number;
    /** The line get_fault_info prints for this bit. */
    text: string;
}

export interface DecodedFault {
    regs: FaultRegisters;
    mmfsr: number;
    bfsr: number;
    ufsr: number;
    /** Every set bit, in report order. */
    flags: FaultFlag[];
    /** The configurable fault that fired, or HardFault when only HFSR says something. */
    faultClass: FaultClass;
    /** HFSR.FORCED: a configurable fault escalated to HardFault. */
    escalated: boolean;
    /** BFAR / MMFAR when the matching VALID bit is set. */
    faultAddress?: { source: 'BFAR' | 'MMFAR'; value: number };
}

const hex8 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

/** Bit tables in report order. Texts are the lines get_fault_info has always printed. */
const HFSR_BITS: ReadonlyArray<[number, string, string]> = [
    [31, 'DEBUGEVT', 'DEBUGEVT: Debug event escalated to HardFault (debug monitor disabled)'],
    [30, 'FORCED', 'FORCED: Escalated fault (check CFSR for root cause)'],
    [1, 'VECTTBL', 'VECTTBL: Vector table read fault on exception processing'],
];
const MMFSR_BITS: ReadonlyArray<[number, string, string]> = [
    [5, 'MLSPERR', 'MLSPERR: MemManage fault during FP lazy state preservation'],
    [4, 'MSTKERR', 'MSTKERR: MemManage fault on exception entry (stacking)'],
    [3, 'MUNSTKERR', 'MUNSTKERR: MemManage fault on exception return (unstacking)'],
    [1, 'DACCVIOL', 'DACCVIOL: Data access violation'],
    [0, 'IACCVIOL', 'IACCVIOL: Instruction access violation'],
];
const BFSR_BITS: ReadonlyArray<[number, string, string]> = [
    [5, 'LSPERR', 'LSPERR: BusFault during FP lazy state preservation'],
    [4, 'STKERR', 'STKERR: BusFault on exception entry (stacking)'],
    [3, 'UNSTKERR', 'UNSTKERR: BusFault on exception return (unstacking)'],
    [2, 'IMPRECISERR', 'IMPRECISERR: Imprecise data bus error'],
    [1, 'PRECISERR', 'PRECISERR: Precise data bus error'],
    [0, 'IBUSERR', 'IBUSERR: Instruction bus error'],
];
const UFSR_BITS: ReadonlyArray<[number, string, string]> = [
    [9, 'DIVBYZERO', 'DIVBYZERO: Divide by zero'],
    [8, 'UNALIGNED', 'UNALIGNED: Unaligned memory access'],
    [4, 'STKOF', 'STKOF: Stack overflow (Armv8-M stack limit crossed)'],
    [3, 'NOCP', 'NOCP: Coprocessor access (FPU not enabled?)'],
    [2, 'INVPC', 'INVPC: Invalid PC load on return (corrupted stack?)'],
    [1, 'INVSTATE', 'INVSTATE: Invalid EPSR.T bit (ARM mode on Cortex-M?)'],
    [0, 'UNDEFINSTR', 'UNDEFINSTR: Undefined instruction'],
];
const DFSR_BITS: ReadonlyArray<[number, string, string]> = [
    [4, 'EXTERNAL', 'EXTERNAL: External debug request'],
    [3, 'VCATCH', 'VCATCH: Vector catch'],
    [2, 'DWTTRAP', 'DWTTRAP: DWT match'],
    [1, 'BKPT', 'BKPT: Breakpoint instruction'],
    [0, 'HALTED', 'HALTED: Halt request'],
];

function setBits(reg: FaultStatusRegister, value: number, table: ReadonlyArray<[number, string, string]>): FaultFlag[] {
    return table.filter(([bit]) => (value & (1 << bit)) !== 0).map(([bit, name, text]) => ({ reg, name, bit, text }));
}

/** Decode the registers into flags, class and faulting address. */
export function decodeFault(regs: FaultRegisters): DecodedFault {
    const { CFSR, HFSR, MMFAR, BFAR } = regs;
    const mmfsr = CFSR & 0xFF;
    const bfsr = (CFSR >> 8) & 0xFF;
    const ufsr = (CFSR >> 16) & 0xFFFF;

    const flags: FaultFlag[] = [];
    flags.push(...setBits('HFSR', HFSR, HFSR_BITS));
    if (mmfsr & (1 << 7)) { flags.push({ reg: 'MMFSR', name: 'MMARVALID', bit: 7, text: `MMARVALID: Faulting address = ${hex8(MMFAR)}` }); }
    flags.push(...setBits('MMFSR', mmfsr, MMFSR_BITS));
    if (bfsr & (1 << 7)) { flags.push({ reg: 'BFSR', name: 'BFARVALID', bit: 7, text: `BFARVALID: Faulting address = ${hex8(BFAR)}` }); }
    flags.push(...setBits('BFSR', bfsr, BFSR_BITS));
    flags.push(...setBits('UFSR', ufsr, UFSR_BITS));
    flags.push(...setBits('DFSR', regs.DFSR, DFSR_BITS));

    const has = (reg: FaultStatusRegister, exclude: string[] = []) =>
        flags.some(f => f.reg === reg && !exclude.includes(f.name));
    let faultClass: FaultClass = 'None';
    if (has('MMFSR', ['MMARVALID'])) { faultClass = 'MemManage'; }
    else if (has('BFSR', ['BFARVALID'])) { faultClass = 'BusFault'; }
    else if (has('UFSR')) { faultClass = 'UsageFault'; }
    else if (has('HFSR')) { faultClass = 'HardFault'; }

    const faultAddress = (bfsr & (1 << 7)) ? { source: 'BFAR' as const, value: BFAR >>> 0 }
        : (mmfsr & (1 << 7)) ? { source: 'MMFAR' as const, value: MMFAR >>> 0 }
        : undefined;

    return { regs, mmfsr, bfsr, ufsr, flags, faultClass, escalated: (HFSR & (1 << 30)) !== 0, faultAddress };
}

/** The get_fault_info text. */
export function renderFaultReport(decoded: DecodedFault): string {
    const { regs, mmfsr, bfsr, ufsr, flags } = decoded;
    const lines = (reg: FaultStatusRegister) => flags.filter(f => f.reg === reg).map(f => `  ${f.text}\n`).join('');

    let report = '=== Cortex-M Fault Analysis ===\n\n';
    report += `HFSR  = ${hex8(regs.HFSR)}\n` + lines('HFSR');
    report += `\nMMFSR = 0x${mmfsr.toString(16).padStart(2, '0')}\n` + lines('MMFSR');
    report += `\nBFSR  = 0x${bfsr.toString(16).padStart(2, '0')}\n` + lines('BFSR');
    report += `\nUFSR  = 0x${ufsr.toString(16).padStart(4, '0')}\n` + lines('UFSR');
    report += `\nDFSR  = ${hex8(regs.DFSR)}\n` + lines('DFSR');
    if (regs.AFSR !== 0) {
        report += `\nAFSR  = ${hex8(regs.AFSR)} (implementation-defined)\n`;
    }
    if (regs.CFSR === 0 && regs.HFSR === 0) {
        report += '\nNo fault flags set. Target may not be in a fault handler.\n';
    }
    return report;
}

/**
 * Decode Cortex-M fault registers into a human-readable report.
 */
export function decodeFaultRegisters(regs: FaultRegisters): string {
    return renderFaultReport(decodeFault(regs));
}
