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

import * as vscode from 'vscode';
import {
    loadSvd, findPeripheral, findRegister, listPeripheralNames,
    decodeFields, SvdPeripheral, SvdRegister, SvdDevice
} from './svdParser.js';
import { customRequestWithTimeout, HardwareTimeoutError } from '../utils/timeout.js';

/**
 * Per-DAP-request timeout for peripheral reads. Matches the default
 * `cmsis-developer-assistant.dapRequestTimeoutMs` setting so a stalled probe cannot
 * hang peripheral dumps indefinitely.
 */
const PERIPHERAL_DAP_TIMEOUT_MS = 10000;

/**
 * Reads peripheral register values.
 *
 * Strategy:
 *  1. Try the Peripheral Inspector extension API (eclipse-cdt.peripheral-inspector)
 *  2. Parse SVD file and read registers via DAP readMemory / GDB evaluate
 */

export interface PeripheralRegisterInfo {
    name: string;
    address: string;
    value: string;
    fields?: { name: string; value: string; bits: string }[];
}

/**
 * Attempt to read peripheral registers via the Peripheral Inspector extension API.
 * Returns null if the extension is not available or does not expose a read API.
 */
export async function tryReadPeripheralViaExtension(
    peripheral: string,
    register?: string
): Promise<string | null> {
    const piExtension = vscode.extensions.getExtension('eclipse-cdt.peripheral-inspector');
    if (!piExtension) {
        return null;
    }

    if (!piExtension.isActive) {
        try {
            await piExtension.activate();
        } catch {
            return null;
        }
    }

    const api = piExtension.exports;
    if (!api) {
        return null;
    }

    // Try common API patterns the Peripheral Inspector might expose
    try {
        if (typeof api.getPeripherals === 'function') {
            const peripherals = await api.getPeripherals();
            const target = peripherals?.find((p: any) =>
                p.name?.toUpperCase() === peripheral.toUpperCase()
            );
            if (!target) {
                return `Peripheral '${peripheral}' not found in SVD data. Available: ${(peripherals || []).map((p: any) => p.name).join(', ')}`;
            }

            if (register) {
                if (typeof api.getRegisterValue === 'function') {
                    const regValue = await api.getRegisterValue(peripheral, register);
                    return formatRegisterValue(peripheral, register, regValue);
                }
            }

            if (typeof api.getRegisters === 'function') {
                const registers = await api.getRegisters(peripheral);
                return formatRegisterList(peripheral, registers);
            }
        }
    } catch {
        // API not available in expected shape, fall through to null
    }

    return null;
}

function formatRegisterValue(peripheral: string, register: string, regValue: any): string {
    if (!regValue) {
        return `Register ${peripheral}.${register}: <unavailable>`;
    }
    let result = `${peripheral}.${register} = 0x${(regValue.value ?? 0).toString(16).padStart(8, '0')}`;
    if (regValue.fields && Array.isArray(regValue.fields)) {
        result += '\n  Fields:\n';
        for (const field of regValue.fields) {
            result += `    ${field.name}: ${field.value} [bits ${field.bitOffset}:${field.bitOffset + field.bitWidth - 1}]\n`;
        }
    }
    return result;
}

function formatRegisterList(peripheral: string, registers: any[]): string {
    if (!registers || registers.length === 0) {
        return `No registers found for peripheral '${peripheral}'`;
    }
    let result = `=== ${peripheral} Registers ===\n`;
    for (const reg of registers) {
        const addr = reg.address ?? reg.addressOffset ?? '?';
        const val = reg.value !== undefined ? `0x${reg.value.toString(16).padStart(8, '0')}` : '<not read>';
        result += `  ${(reg.name || 'unknown').padEnd(20)} @ ${addr}  = ${val}\n`;
    }
    return result;
}

/**
 * Fallback: Read peripheral registers by parsing the SVD file and using
 * DAP readMemory / GDB evaluate to fetch actual register values.
 */
export async function readPeripheralViaMemory(
    session: vscode.DebugSession,
    peripheral: string,
    register?: string,
    frameId?: number | null
): Promise<string> {
    // Try SVD-based read
    const device = await loadSvd();
    if (!device) {
        return noSvdFallback(peripheral);
    }

    const svdPeriph = findPeripheral(device, peripheral);
    if (!svdPeriph) {
        const names = listPeripheralNames(device);
        return `Peripheral '${peripheral}' not found in SVD.\n` +
            `Available peripherals (${names.length}):\n  ${names.join(', ')}\n`;
    }

    if (register) {
        // Read a single register
        const svdReg = findRegister(svdPeriph, register);
        if (!svdReg) {
            const regNames = svdPeriph.registers.map(r => r.name);
            return `Register '${register}' not found in ${peripheral}.\n` +
                `Available registers (${regNames.length}):\n  ${regNames.join(', ')}\n`;
        }
        return await readSingleRegister(session, svdPeriph, svdReg, frameId);
    }

    // Read all registers of the peripheral
    return await readAllRegisters(session, svdPeriph, frameId);
}

// ── SVD-based register reading ──────────────────────────────────

async function readSingleRegister(
    session: vscode.DebugSession,
    peripheral: SvdPeripheral,
    reg: SvdRegister,
    frameId?: number | null
): Promise<string> {
    const addr = peripheral.baseAddress + reg.addressOffset;
    const hexAddr = `0x${addr.toString(16).padStart(8, '0')}`;

    let value: number;
    try {
        value = await readWord(session, hexAddr, frameId);
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
    frameId?: number | null
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
            const value = await readWord(session, hexAddr, frameId);
            valStr = `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
        } catch {
            valStr = '<read failed>';
        }

        result += `  ${reg.name.padEnd(28)} @ ${hexAddr} = ${valStr}\n`;
    }

    if (regs.length > maxRegs) {
        result += `\n  ... and ${regs.length - maxRegs} more registers (specify register name to read individually)\n`;
    }

    return result;
}

// ── Memory read helper ──────────────────────────────────────────

async function readWord(
    session: vscode.DebugSession,
    hexAddr: string,
    frameId?: number | null
): Promise<number> {
    // Try DAP readMemory first
    try {
        const response = await customRequestWithTimeout<any>(session, 'readMemory', {
            memoryReference: hexAddr,
            count: 4,
        }, PERIPHERAL_DAP_TIMEOUT_MS);
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
        }, PERIPHERAL_DAP_TIMEOUT_MS);
        if (result?.result) {
            const val = parseGdbInt(result.result);
            if (val !== null) { return val; }
        }
    } catch (err) {
        if (err instanceof HardwareTimeoutError) { throw err; }
        // Fall through
    }

    // Strategy 2: GDB x command via REPL context
    try {
        const result = await customRequestWithTimeout<any>(session, 'evaluate', {
            expression: `-exec x/1xw ${hexAddr}`,
            context: 'repl',
            ...frameOpt,
        }, PERIPHERAL_DAP_TIMEOUT_MS);
        if (result?.result) {
            const match = result.result.match(/:\s*(0x[0-9a-fA-F]+)/);
            if (match) {
                const val = parseInt(match[1], 16);
                if (!isNaN(val)) { return val; }
            }
        }
    } catch (err) {
        if (err instanceof HardwareTimeoutError) { throw err; }
        // Fall through
    }

    throw new Error(`All read strategies failed for ${hexAddr}`);
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
