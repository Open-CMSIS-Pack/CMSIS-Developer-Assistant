// SPDX-License-Identifier: Apache-2.0 OR MIT
// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

/**
 * DWT (Data Watchpoint and Trace) cycle-counter register map for Cortex-M.
 * Addresses are strings to match the readMemoryWord/writeMemoryWord call
 * convention used elsewhere (faultDecoder.ts style).
 */
export const DWT_ADDRESSES = {
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

/** DWT_CTRL bit 28: reads 1 when the core has NO cycle counter (e.g. some M0/M23). */
export const DWT_CTRL_NOCYCCNT = 1 << 28;
