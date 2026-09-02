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

import { SvdDevice, SvdPeripheral, SvdRegister } from './svdParser';
import { regionOf } from './memoryMap';

/**
 * Answers about a device description that need no target access: which
 * peripheral and register sit at an address, what a name might have meant,
 * and capped renderings of a peripheral's map or a register's bit fields.
 * Pure — the handler supplies the device, this module never touches vscode.
 */

export interface AddressHit {
    peripheral: SvdPeripheral;
    register?: SvdRegister;
    /** Byte offset of `addr` inside `register`. */
    offsetInRegister?: number;
}

interface AddressRange {
    start: number;
    /** Exclusive. */
    end: number;
    peripheral: SvdPeripheral;
}

const indexCache = new WeakMap<SvdDevice, AddressRange[]>();

/** Byte extent of a register (SVD sizes are in bits). */
function registerBytes(r: SvdRegister): number {
    return Math.max(1, Math.ceil((r.size || 32) / 8));
}

/**
 * Address ranges of every peripheral, sorted. From the `addressBlock`s when
 * the SVD has them, else the extent of the registers. Built once per device.
 */
export function buildAddressIndex(device: SvdDevice): AddressRange[] {
    const cached = indexCache.get(device);
    if (cached) { return cached; }
    const ranges: AddressRange[] = [];
    for (const peripheral of device.peripherals) {
        if (peripheral.addressBlocks.length > 0) {
            for (const block of peripheral.addressBlocks) {
                if (block.size > 0) {
                    ranges.push({ start: peripheral.baseAddress + block.offset, end: peripheral.baseAddress + block.offset + block.size, peripheral });
                }
            }
        } else if (peripheral.registers.length > 0) {
            const end = Math.max(...peripheral.registers.map(r => r.addressOffset + registerBytes(r)));
            ranges.push({ start: peripheral.baseAddress, end: peripheral.baseAddress + end, peripheral });
        }
    }
    ranges.sort((a, b) => a.start - b.start);
    indexCache.set(device, ranges);
    return ranges;
}

/** The peripheral (and register, when one covers it) at `addr`, or null. */
export function lookupAddress(device: SvdDevice, addr: number): AddressHit | null {
    for (const range of buildAddressIndex(device)) {
        if (addr < range.start) { break; }
        if (addr >= range.end) { continue; }
        const peripheral = range.peripheral;
        const register = peripheral.registers.find(r => {
            const start = peripheral.baseAddress + r.addressOffset;
            return addr >= start && addr < start + registerBytes(r);
        });
        return register
            ? { peripheral, register, offsetInRegister: addr - (peripheral.baseAddress + register.addressOffset) }
            : { peripheral };
    }
    return null;
}

/** `0x40005400`, `40005400h`, or a decimal; null when unparsable. */
export function parseAddress(text: string): number | null {
    const t = text.trim();
    let m = t.match(/^0[xX]([0-9a-fA-F_]+)$/);
    if (m) { return parseInt(m[1].replace(/_/g, ''), 16); }
    m = t.match(/^([0-9a-fA-F]+)[hH]$/);
    if (m) { return parseInt(m[1], 16); }
    if (/^\d+$/.test(t)) { return parseInt(t, 10); }
    return null;
}

function editDistance(a: string, b: string): number {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length];
}

/**
 * Resolve a name the agent typed: the exact match (case-insensitive), else up
 * to five suggestions — prefix, then substring, then within two edits. Never
 * picks a suggestion silently; the caller shows them.
 */
export function matchName(candidates: readonly string[], query: string): { exact?: string; suggestions: string[] } {
    const q = query.trim().toUpperCase();
    if (!q) { return { suggestions: [] }; }
    const exact = candidates.find(c => c.toUpperCase() === q);
    if (exact) { return { exact, suggestions: [] }; }
    // Two edits reach unrelated names when the query is short (I2C → RCC),
    // so short queries get one edit, longer ones two.
    const maxEdits = q.length >= 6 ? 2 : 1;
    const ranked = candidates
        .map(c => {
            const u = c.toUpperCase();
            const edits = editDistance(u, q);
            const rank = u.startsWith(q) ? 0 : u.includes(q) ? 1 : edits <= maxEdits ? 1 + edits : -1;
            return { c, rank };
        })
        .filter(x => x.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.c.localeCompare(b.c));
    return { suggestions: ranked.slice(0, 5).map(x => x.c) };
}

const hex = (n: number, width = 8) => `0x${(n >>> 0).toString(16).padStart(width, '0')}`;

/** The device's peripherals, one line each, capped. */
export function renderPeripheralList(device: SvdDevice, options: { filter?: string; max?: number } = {}): string {
    const max = options.max ?? 64;
    const filter = options.filter?.toUpperCase();
    const all = filter ? device.peripherals.filter(p => p.name.toUpperCase().startsWith(filter)) : device.peripherals;
    if (all.length === 0) {
        return filter
            ? `No peripheral of ${device.name} starts with '${options.filter}'. Call lookup_peripheral without filter for the full list.`
            : `${device.name}: the SVD defines no peripherals.`;
    }
    const shown = all.slice(0, max);
    const lines = [`${device.name}: ${all.length} peripheral${all.length === 1 ? '' : 's'}${filter ? ` starting with '${options.filter}'` : ''}`];
    for (const p of shown) {
        lines.push(`  ${p.name.padEnd(16)} @ ${hex(p.baseAddress)}  ${p.registers.length} reg${p.registers.length === 1 ? '' : 's'}${p.description ? `  ${p.description}` : ''}`);
    }
    if (all.length > shown.length) {
        lines.push(`  … ${all.length - shown.length} more — narrow with filter (name prefix)`);
    }
    lines.push('', 'Next: lookup_peripheral { name } for a register map, lookup_register { peripheral, register } for bit fields.');
    return lines.join('\n');
}

/** A peripheral's register map, capped. */
export function renderPeripheral(p: SvdPeripheral, options: { filter?: string; maxRegisters?: number } = {}): string {
    const max = options.maxRegisters ?? 32;
    const filter = options.filter?.toUpperCase();
    const all = filter ? p.registers.filter(r => r.name.toUpperCase().startsWith(filter)) : p.registers;
    const lines = [`=== ${p.name} @ ${hex(p.baseAddress)} ===`];
    if (p.description) { lines.push(`  ${p.description}`); }
    if (p.addressBlocks.length > 0) {
        lines.push(`  address blocks: ${p.addressBlocks.map(b => `${hex(p.baseAddress + b.offset)}+${hex(b.size, 1)}${b.usage ? ` (${b.usage})` : ''}`).join(', ')}`);
    }
    if (all.length === 0) {
        lines.push(filter
            ? `  no register starts with '${options.filter}' (${p.registers.length} registers in total)`
            : '  no registers defined in the SVD');
        return lines.join('\n');
    }
    lines.push(`  ${all.length} register${all.length === 1 ? '' : 's'}${filter ? ` starting with '${options.filter}'` : ''}:`);
    for (const r of all.slice(0, max)) {
        const desc = r.description ? `  ${r.description}` : '';
        lines.push(`  ${r.name.padEnd(16)} +${hex(r.addressOffset, 3)} = ${hex(p.baseAddress + r.addressOffset)}  ${(r.access ?? 'rw').padEnd(10)}${desc}`);
    }
    if (all.length > max) {
        lines.push(`  … ${all.length - max} more — narrow with filter (register name prefix)`);
    }
    lines.push('', `Next: lookup_register { peripheral: '${p.name}', register } for bit fields; read_peripheral_register to read the target.`);
    return lines.join('\n');
}

/** One register: address, access, reset value, bit fields with enumerated values, capped. */
export function renderRegister(p: SvdPeripheral, r: SvdRegister, options: { maxFields?: number } = {}): string {
    const max = options.maxFields ?? 32;
    const lines = [`=== ${p.name}.${r.name} @ ${hex(p.baseAddress + r.addressOffset)} (offset ${hex(r.addressOffset, 3)}, ${r.size} bits, ${r.access ?? 'read-write'}) ===`];
    if (r.description) { lines.push(`  ${r.description}`); }
    if (r.resetValue !== undefined) { lines.push(`  reset value: ${hex(r.resetValue)}`); }
    if (r.fields.length === 0) {
        lines.push('  no bit fields defined in the SVD');
    } else {
        lines.push(`  ${r.fields.length} field${r.fields.length === 1 ? '' : 's'}:`);
        const sorted = [...r.fields].sort((a, b) => a.bitLow - b.bitLow);
        for (const f of sorted.slice(0, max)) {
            const bits = f.bitHigh === f.bitLow ? `[${f.bitLow}]` : `[${f.bitHigh}:${f.bitLow}]`;
            const enums = f.enumeratedValues?.length
                ? `  {${f.enumeratedValues.map(e => `${e.value}=${e.name}`).join(', ')}}`
                : '';
            lines.push(`  ${bits.padEnd(8)} ${f.name.padEnd(16)}${f.access ? ` ${f.access}` : ''}${f.description ? `  ${f.description}` : ''}${enums}`);
        }
        if (sorted.length > max) {
            lines.push(`  … ${sorted.length - max} more fields`);
        }
    }
    lines.push('', `Next: read_peripheral_register { peripheral: '${p.name}', register: '${r.name}' } to read and decode the live value.`);
    return lines.join('\n');
}

/** What sits at an address, from lookupAddress. */
export function renderAddressHit(addr: number, hit: AddressHit | null, deviceName: string): string {
    if (!hit) {
        const region = regionOf(addr);
        const where = region ? ` — that is the ${region.name} region (${hex(region.start)}–${hex(region.end)})` : '';
        return `${hex(addr)} is not inside any peripheral described by the SVD of ${deviceName}${where}. ` +
            'SRAM, Flash and the Cortex-M private peripheral bus are not in the SVD; use read_memory for raw access.';
    }
    const p = hit.peripheral;
    if (!hit.register) {
        return `${hex(addr)} is inside ${p.name} (@ ${hex(p.baseAddress)}, offset ${hex(addr - p.baseAddress, 3)}) but no register is defined there.\n` +
            `Next: lookup_peripheral { name: '${p.name}' } for the register map.`;
    }
    const r = hit.register;
    const inside = hit.offsetInRegister ? ` (byte ${hit.offsetInRegister} of the register)` : '';
    return `${hex(addr)} = ${p.name}.${r.name}${inside} — offset ${hex(r.addressOffset, 3)} in ${p.name} @ ${hex(p.baseAddress)}` +
        `${r.description ? `: ${r.description}` : ''}\n` +
        `Next: lookup_register { peripheral: '${p.name}', register: '${r.name}' } for the bit fields.`;
}
