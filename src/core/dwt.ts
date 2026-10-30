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
 * DWT (Data Watchpoint and Trace) cycle-counter register map for Cortex-M,
 * and which cores have a cycle counter at all. Addresses are strings to match
 * the readMemoryWord/writeMemoryWord call convention used elsewhere
 * (faultDecoder.ts style). Bit positions are those of CMSIS-Core
 * (core_cm*.h) and the Armv6-M, Armv7-M and Armv8-M architecture manuals.
 */
export const DWT_ADDRESSES = {
    /** CPUID Base Register — its ARCHITECTURE field names the cores that never have a cycle counter. */
    CPUID: '0xE000ED00',
    /** Debug Exception and Monitor Control Register — TRCENA gates all DWT/ITM. */
    DEMCR: '0xE000EDFC',
    /** DWT Control Register — CYCCNTENA plus the NOCYCCNT presence flag. */
    DWT_CTRL: '0xE0001000',
    /** DWT Cycle Count Register — free-running 32-bit counter of active cycles. */
    DWT_CYCCNT: '0xE0001004',
} as const;

/** DEMCR bit 24: global trace enable. Must be set before any DWT unit runs. */
export const DEMCR_TRCENA = 1 << 24;

/** DWT_CTRL bit 0: enables the cycle counter itself. */
export const DWT_CTRL_CYCCNTENA = 1;

/**
 * DWT_CTRL bit 25: reads 1 when an Armv7-M or Armv8-M core has NO cycle
 * counter (always on Armv8-M Baseline, e.g. Cortex-M23). Bits 31:28 above it
 * are NUMCOMP, the number of comparators. Armv6-M has no such bit: its
 * DWT_CTRL holds only NUMCOMP, so `architectureHasCycleCounter` decides there.
 */
export const DWT_CTRL_NOCYCCNT = 1 << 25;

/** CPUID.ARCHITECTURE (bits 19:16) of Armv6-M and of Armv8-M without the Main Extension. */
const CPUID_ARCHITECTURE_NO_MAIN_EXTENSION = 0xc;

/**
 * Whether the core's architecture provides for a DWT cycle counter, by CPUID:
 * false for Armv6-M (Cortex-M0, M0+, M1, SC000) and Armv8-M Baseline
 * (Cortex-M23), which never have one; true otherwise, where DWT_CTRL.NOCYCCNT
 * tells.
 */
export function architectureHasCycleCounter(cpuid: number): boolean {
    return ((cpuid >>> 16) & 0xf) !== CPUID_ARCHITECTURE_NO_MAIN_EXTENSION;
}
