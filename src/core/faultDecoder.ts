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
 * Decodes CFSR, HFSR, DFSR, MMFAR, BFAR, and AFSR registers
 * into human-readable fault analysis reports.
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

/**
 * Decode Cortex-M fault registers into a human-readable report.
 */
export function decodeFaultRegisters(regs: FaultRegisters): string {
    const { CFSR, HFSR, DFSR, MMFAR, BFAR, AFSR } = regs;

    // Decompose CFSR into sub-registers
    const MMFSR = CFSR & 0xFF;
    const BFSR = (CFSR >> 8) & 0xFF;
    const UFSR = (CFSR >> 16) & 0xFFFF;

    let report = '=== Cortex-M Fault Analysis ===\n\n';

    // HardFault Status Register
    report += `HFSR  = 0x${HFSR.toString(16).padStart(8, '0')}\n`;
    if (HFSR & (1 << 30)) { report += '  FORCED: Escalated fault (check CFSR for root cause)\n'; }
    if (HFSR & (1 << 1))  { report += '  VECTTBL: Vector table read fault on exception processing\n'; }

    // MemManage Fault Status
    report += `\nMMFSR = 0x${MMFSR.toString(16).padStart(2, '0')}\n`;
    if (MMFSR & (1 << 7)) { report += `  MMARVALID: Faulting address = 0x${MMFAR.toString(16).padStart(8, '0')}\n`; }
    if (MMFSR & (1 << 5)) { report += '  MLSPERR: MemManage fault during FP lazy state preservation\n'; }
    if (MMFSR & (1 << 4)) { report += '  MSTKERR: MemManage fault on exception entry (stacking)\n'; }
    if (MMFSR & (1 << 3)) { report += '  MUNSTKERR: MemManage fault on exception return (unstacking)\n'; }
    if (MMFSR & (1 << 1)) { report += '  DACCVIOL: Data access violation\n'; }
    if (MMFSR & (1 << 0)) { report += '  IACCVIOL: Instruction access violation\n'; }

    // BusFault Status
    report += `\nBFSR  = 0x${BFSR.toString(16).padStart(2, '0')}\n`;
    if (BFSR & (1 << 7)) { report += `  BFARVALID: Faulting address = 0x${BFAR.toString(16).padStart(8, '0')}\n`; }
    if (BFSR & (1 << 5)) { report += '  LSPERR: BusFault during FP lazy state preservation\n'; }
    if (BFSR & (1 << 4)) { report += '  STKERR: BusFault on exception entry (stacking)\n'; }
    if (BFSR & (1 << 3)) { report += '  UNSTKERR: BusFault on exception return (unstacking)\n'; }
    if (BFSR & (1 << 2)) { report += '  IMPRECISERR: Imprecise data bus error\n'; }
    if (BFSR & (1 << 1)) { report += '  PRECISERR: Precise data bus error\n'; }
    if (BFSR & (1 << 0)) { report += '  IBUSERR: Instruction bus error\n'; }

    // UsageFault Status
    report += `\nUFSR  = 0x${UFSR.toString(16).padStart(4, '0')}\n`;
    if (UFSR & (1 << 9)) { report += '  DIVBYZERO: Divide by zero\n'; }
    if (UFSR & (1 << 8)) { report += '  UNALIGNED: Unaligned memory access\n'; }
    if (UFSR & (1 << 3)) { report += '  NOCP: Coprocessor access (FPU not enabled?)\n'; }
    if (UFSR & (1 << 2)) { report += '  INVPC: Invalid PC load on return (corrupted stack?)\n'; }
    if (UFSR & (1 << 1)) { report += '  INVSTATE: Invalid EPSR.T bit (ARM mode on Cortex-M?)\n'; }
    if (UFSR & (1 << 0)) { report += '  UNDEFINSTR: Undefined instruction\n'; }

    // Debug Fault Status
    report += `\nDFSR  = 0x${DFSR.toString(16).padStart(8, '0')}\n`;
    if (DFSR & (1 << 4)) { report += '  EXTERNAL: External debug request\n'; }
    if (DFSR & (1 << 3)) { report += '  VCATCH: Vector catch\n'; }
    if (DFSR & (1 << 2)) { report += '  DWTTRAP: DWT match\n'; }
    if (DFSR & (1 << 1)) { report += '  BKPT: Breakpoint instruction\n'; }
    if (DFSR & (1 << 0)) { report += '  HALTED: Halt request\n'; }

    // Auxiliary Fault Status
    if (AFSR !== 0) {
        report += `\nAFSR  = 0x${AFSR.toString(16).padStart(8, '0')} (implementation-defined)\n`;
    }

    if (CFSR === 0 && HFSR === 0) {
        report += '\nNo fault flags set. Target may not be in a fault handler.\n';
    }

    return report;
}
