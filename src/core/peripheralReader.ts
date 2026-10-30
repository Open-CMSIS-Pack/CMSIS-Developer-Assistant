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
 * Reads peripheral register values: the device SVD gives each register's
 * address and bit fields, DAP readMemory (else GDB) reads the word.
 *
 * The Peripheral Inspector extension is not asked: its API registers SVD
 * files and parsers and reloads its view, and has no call that reads a
 * register.
 */

import * as vscode from 'vscode';
import {
    loadSvd, findPeripheral, findRegister, listPeripheralNames,
    decodeFields, SvdPeripheral, SvdRegister, SvdDevice
} from './svdParser.js';
import { matchName } from './svdLookup.js';
import { bytesFromMiMemoryReply, CMSIS_DEBUGGER_TYPE, miReadMemoryCommand } from './gdbDialect.js';
import { customRequestWithTimeout, HardwareTimeoutError } from '../utils/timeout.js';

/**
 * Per-DAP-request timeout for peripheral reads when the caller passes none —
 * the default of `cmsis-developer-assistant.dapRequestTimeoutMs`. The
 * executor passes the configured value (capped by the call's `timeoutMs`).
 */
const DEFAULT_DAP_TIMEOUT_MS = 10000;

export interface PeripheralRegisterInfo {
    name: string;
    address: string;
    value: string;
    fields?: { name: string; value: string; bits: string }[];
}

/**
 * Read peripheral registers by parsing the SVD file and using
 * DAP readMemory / GDB evaluate to fetch actual register values.
 */
export async function readPeripheralViaMemory(
    session: vscode.DebugSession,
    peripheral: string,
    register?: string,
    frameId?: number | null,
    dapTimeoutMs: number = DEFAULT_DAP_TIMEOUT_MS,
): Promise<string> {
    // The SVD of the session the read goes to, which need not be VS Code's focused one.
    const device = await loadSvd(session);
    if (!device) {
        return noSvdFallback(peripheral);
    }

    const svdPeriph = findPeripheral(device, peripheral);
    if (!svdPeriph) {
        // Suggestions instead of every name: a 200-peripheral list is the
        // kind of result that compacts an agent's context for a typo.
        const { suggestions } = matchName(listPeripheralNames(device), peripheral);
        return `Peripheral '${peripheral}' not found in SVD.` +
            (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '') +
            '\nBrowse the device with lookup_peripheral (no arguments lists every peripheral).\n';
    }

    if (register) {
        // Read a single register
        const svdReg = findRegister(svdPeriph, register);
        if (!svdReg) {
            const { suggestions } = matchName(svdPeriph.registers.map(r => r.name), register);
            return `Register '${register}' not found in ${peripheral}.` +
                (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '') +
                `\nlookup_peripheral { name: '${svdPeriph.name}' } shows the register map without reading the target.\n`;
        }
        return await readSingleRegister(session, svdPeriph, svdReg, frameId, dapTimeoutMs);
    }

    // Read all registers of the peripheral
    return await readAllRegisters(session, svdPeriph, frameId, dapTimeoutMs);
}

// ── SVD-based register reading ──────────────────────────────────

async function readSingleRegister(
    session: vscode.DebugSession,
    peripheral: SvdPeripheral,
    reg: SvdRegister,
    frameId: number | null | undefined,
    dapTimeoutMs: number,
): Promise<string> {
    const addr = peripheral.baseAddress + reg.addressOffset;
    const hexAddr = `0x${addr.toString(16).padStart(8, '0')}`;

    let value: number;
    try {
        value = await readWord(session, hexAddr, frameId, dapTimeoutMs);
    } catch (e) {
        return `${peripheral.name}.${reg.name} @ ${hexAddr}: <read failed: ${e}>`;
    }

    const hexVal = `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
    let result = `${peripheral.name}.${reg.name} @ ${hexAddr} = ${hexVal}`;
    if (reg.description) {
        result += `\n  ${reg.description}`;
    }

    if (reg.fields.length > 0) {
        result += '\n  Fields:\n';
        const decoded = decodeFields(reg, value);
        for (const f of decoded) {
            const fHex = `0x${f.value.toString(16)}`;
            result += `    ${f.name.padEnd(24)} ${f.bits.padEnd(8)} = ${fHex} (${f.value})`;
            if (f.description) {
                // Truncate long descriptions
                const desc = f.description.length > 80
                    ? f.description.substring(0, 77) + '...'
                    : f.description;
                result += `  — ${desc}`;
            }
            result += '\n';
        }
    }
    return result;
}

async function readAllRegisters(
    session: vscode.DebugSession,
    peripheral: SvdPeripheral,
    frameId: number | null | undefined,
    dapTimeoutMs: number,
): Promise<string> {
    const regs = peripheral.registers;
    if (regs.length === 0) {
        return `${peripheral.name}: no registers defined in SVD`;
    }

    let result = `=== ${peripheral.name} @ 0x${peripheral.baseAddress.toString(16).padStart(8, '0')} ===\n`;
    if (peripheral.description) {
        result += `  ${peripheral.description}\n`;
    }
    result += `  (${regs.length} registers)\n\n`;

    // Read up to 32 registers to avoid timeouts on large peripherals
    const maxRegs = Math.min(regs.length, 32);
    for (let i = 0; i < maxRegs; i++) {
        const reg = regs[i];
        const addr = peripheral.baseAddress + reg.addressOffset;
        const hexAddr = `0x${addr.toString(16).padStart(8, '0')}`;

        let valStr: string;
        try {
            const value = await readWord(session, hexAddr, frameId, dapTimeoutMs);
            valStr = `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
        } catch {
            valStr = '<read failed>';
        }

        result += `  ${reg.name.padEnd(28)} @ ${hexAddr} = ${valStr}\n`;
    }

    if (regs.length > maxRegs) {
        result += `\n  ... and ${regs.length - maxRegs} more registers — lookup_peripheral shows the whole map without reading the target; pass register to read one.\n`;
    }

    return result;
}

// ── Memory read helper ──────────────────────────────────────────

export async function readWord(
    session: vscode.DebugSession,
    hexAddr: string,
    frameId: number | null | undefined,
    dapTimeoutMs: number = DEFAULT_DAP_TIMEOUT_MS,
): Promise<number> {
    // Try DAP readMemory first
    try {
        const response = await customRequestWithTimeout<any>(session, 'readMemory', {
            memoryReference: hexAddr,
            count: 4,
        }, dapTimeoutMs);
        if (response?.data) {
            const buf = Buffer.from(response.data, 'base64');
            return buf.readUInt32LE(0);
        }
    } catch (err) {
        if (err instanceof HardwareTimeoutError) { throw err; }
        // Fall through to GDB evaluate
    }

    const frameOpt = frameId !== null && frameId !== undefined ? { frameId } : {};

    // Strategy 1: evaluate expression in watch context
    try {
        const result = await customRequestWithTimeout<any>(session, 'evaluate', {
            expression: `*(unsigned int*)${hexAddr}`,
            context: 'watch',
            ...frameOpt,
        }, dapTimeoutMs);
        if (result?.result) {
            const val = parseGdbInt(result.result);
            if (val !== null) { return val; }
        }
    } catch (err) {
        if (err instanceof HardwareTimeoutError) { throw err; }
        // Fall through
    }

    // Strategy 2: a raw GDB read whose answer comes back in the reply — on the
    // CMSIS Debugger the MI command (a CLI command's text only reaches the
    // Debug Console there), elsewhere `x` through `-exec`.
    const cmsisDebugger = session.type === CMSIS_DEBUGGER_TYPE;
    try {
        const result = await customRequestWithTimeout<any>(session, 'evaluate', {
            expression: cmsisDebugger ? `>${miReadMemoryCommand(hexAddr, 4)}` : `-exec x/1xw ${hexAddr}`,
            context: 'repl',
            ...frameOpt,
        }, dapTimeoutMs);
        if (typeof result?.result === 'string') {
            const val = cmsisDebugger ? wordFromMiReply(result.result, hexAddr) : wordAfterColon(result.result);
            if (val !== null) { return val; }
        }
    } catch (err) {
        if (err instanceof HardwareTimeoutError) { throw err; }
        // Fall through
    }

    throw new Error(`All read strategies failed for ${hexAddr}`);
}

/** `x/1xw` answers `0x20000000:\t0x12345678`: the word follows the colon. */
function wordAfterColon(raw: string): number | null {
    const match = raw.match(/:\s*(0x[0-9a-fA-F]+)/);
    if (!match) { return null; }
    const val = parseInt(match[1], 16);
    return isNaN(val) ? null : val;
}

/** `-data-read-memory-bytes` answers the bytes as hex text: the word is the first four, little-endian. */
function wordFromMiReply(raw: string, hexAddr: string): number | null {
    const bytes = bytesFromMiMemoryReply(raw, hexAddr);
    return bytes && bytes.length >= 4 ? bytes.readUInt32LE(0) : null;
}

function parseGdbInt(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) { return null; }
    const val = trimmed.startsWith('0x') || trimmed.startsWith('0X')
        ? parseInt(trimmed, 16)
        : parseInt(trimmed, 10);
    return isNaN(val) ? null : val;
}

// ── No-SVD guidance ─────────────────────────────────────────────

function noSvdFallback(peripheral: string): string {
    let msg = `No SVD file found for the current debug session.\n`;
    msg += `To read peripheral registers by name, the extension needs an SVD file.\n\n`;
    msg += `You can:\n`;
    msg += `  1. Add "svdFile": "/path/to/device.svd" to your launch.json configuration\n`;
    msg += `  2. Use read_memory with the register address, e.g.: address="0x40020000" length=4\n`;
    msg += `  3. Use evaluate_expression: "*(unsigned int*)0x40020000"\n\n`;
    msg += `Tip: Peripheral base addresses can be found in the device datasheet.\n`;
    return msg;
}
