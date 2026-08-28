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
 * The part of an SVD the documentation link needs: peripherals with their
 * group, base address, `derivedFrom`, registers (name, offset, fields) and
 * interrupts. Parsed with xmlLite (an 8 MB SVD takes ~65 ms) and cached per
 * file. After the merge into the CMSIS Developer Assistant this is served
 * by its `svdParser.ts`; only the `SvdSummary` shape matters.
 */

import * as fs from 'fs';
import { PackDocsLog, silentLog } from './host';
import { XmlElement, childrenOf, parseXml } from './xmlLite';

export interface SvdField {
    name: string;
    bitOffset: number;
    bitWidth: number;
    description?: string;
}

export interface SvdRegister {
    /** `CR1`, or `CCMR.OUT` inside a cluster. */
    name: string;
    offset: number;
    description?: string;
    fields: SvdField[];
}

export interface SvdInterrupt {
    name: string;
    value: number;
    description?: string;
}

export interface SvdPeripheral {
    name: string;
    groupName?: string;
    description?: string;
    baseAddress: number;
    derivedFrom?: string;
    /** Own registers only; `registersOf` follows `derivedFrom`. */
    registers: SvdRegister[];
    interrupts: SvdInterrupt[];
}

export interface SvdSummary {
    file: string;
    device?: string;
    /** The `<cpu>` block: `CM0PLUS`, `CM33` … and its revision, when the SVD has one. */
    cpu?: { name: string; revision?: string };
    peripherals: SvdPeripheral[];
}

/** SVD `<cpu><name>` (`CM0PLUS`, `CM4`, `CM33`, `SC300`, `STAR-MC1`, …) → the pdsc `Dcore` spelling, else undefined. */
export function coreFromSvdCpu(name: string | undefined): string | undefined {
    if (!name) { return undefined; }
    const n = name.trim().toUpperCase().replace(/^CORTEX[-_]?/, 'C');
    const m = n.match(/^CM(\d+)(PLUS|\+|P)?$/);
    if (m) { return `Cortex-M${m[1]}${m[2] ? (m[2] === 'P' ? 'P' : '+') : ''}`; }
    if (/^SC[03]00$/.test(n)) { return n; }
    const star = n.match(/^STAR[-_]?MC(\d)$/);
    if (star) { return `Star-MC${star[1]}`; }
    if (/^ARMV8MBL$/.test(n)) { return 'ARMV8MBL'; }
    if (/^ARMV8MML$/.test(n)) { return 'ARMV8MML'; }
    if (/^ARMV81MML$/.test(n)) { return 'ARMV81MML'; }
    return undefined;
}

function text(el: XmlElement, tag: string): string | undefined {
    const c = childrenOf(el, tag)[0];
    return c ? c.text.replace(/\s+/g, ' ').trim() || undefined : undefined;
}

/** SVD numbers: `0x40013800`, `1234`, `#1010` (binary), `0b1010`. */
export function svdNumber(s: string | undefined): number | undefined {
    if (s === undefined) { return undefined; }
    const v = s.trim().toLowerCase().replace(/ul?$/, '');
    if (/^0x[0-9a-f]+$/.test(v)) { return parseInt(v.slice(2), 16); }
    if (/^#[01x]+$/.test(v)) { return parseInt(v.slice(1).replace(/x/g, '0'), 2); }
    if (/^0b[01]+$/.test(v)) { return parseInt(v.slice(2), 2); }
    if (/^\d+$/.test(v)) { return parseInt(v, 10); }
    return undefined;
}

function parseField(el: XmlElement): SvdField | undefined {
    const name = text(el, 'name');
    if (!name) { return undefined; }
    let bitOffset = svdNumber(text(el, 'bitOffset'));
    let bitWidth = svdNumber(text(el, 'bitWidth'));
    const range = text(el, 'bitRange');
    const m = range?.match(/^\[(\d+):(\d+)\]$/);
    if (m) {
        const msb = parseInt(m[1], 10), lsb = parseInt(m[2], 10);
        bitOffset = lsb;
        bitWidth = msb - lsb + 1;
    }
    const lsb = svdNumber(text(el, 'lsb'));
    const msb = svdNumber(text(el, 'msb'));
    if (bitOffset === undefined && lsb !== undefined) { bitOffset = lsb; }
    if (bitWidth === undefined && lsb !== undefined && msb !== undefined) { bitWidth = msb - lsb + 1; }
    return { name, bitOffset: bitOffset ?? 0, bitWidth: bitWidth ?? 1, ...(text(el, 'description') ? { description: text(el, 'description') } : {}) };
}

/** `dimIndex` is a range `1-15`, a list `A,B,C`, or absent (0 … dim−1). */
export function dimIndices(dimIndex: string | undefined, dim: number): string[] {
    if (dimIndex) {
        const range = dimIndex.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
        if (range) {
            const from = parseInt(range[1], 10);
            return Array.from({ length: dim }, (_, i) => String(from + i));
        }
        const list = dimIndex.split(',').map(s => s.trim()).filter(Boolean);
        if (list.length >= dim) { return list.slice(0, dim); }
    }
    return Array.from({ length: dim }, (_, i) => String(i));
}

function parseRegisters(container: XmlElement, prefix: string, base: number, out: SvdRegister[]): void {
    for (const el of container.children) {
        if (el.tag === 'register') {
            const name = text(el, 'name');
            if (!name) { continue; }
            const fields = childrenOf(childrenOf(el, 'fields')[0] ?? { tag: '', attrs: {}, children: [], text: '' }, 'field')
                .map(parseField).filter((f): f is SvdField => !!f);
            const description = text(el, 'description');
            const offset = base + (svdNumber(text(el, 'addressOffset')) ?? 0);
            const dim = svdNumber(text(el, 'dim'));
            if (dim && (dim > 1 || name.includes('%s'))) {
                // A register array: `ISER%s` with dim 16 → ISER0 … ISER15, dimIncrement apart.
                const increment = svdNumber(text(el, 'dimIncrement')) ?? 4;
                dimIndices(text(el, 'dimIndex'), dim).forEach((idx, i) => {
                    const desc = description?.replace(/%s/g, idx);
                    out.push({ name: prefix + (name.includes('%s') ? name.replace(/%s/g, idx) : name + idx), offset: offset + i * increment, ...(desc ? { description: desc } : {}), fields });
                });
            } else {
                out.push({ name: prefix + name, offset, ...(description ? { description } : {}), fields });
            }
        } else if (el.tag === 'cluster') {
            const name = text(el, 'name');
            const offset = base + (svdNumber(text(el, 'addressOffset')) ?? 0);
            parseRegisters(el, `${prefix}${name ? `${name}.` : ''}`, offset, out);
        }
    }
}

export function parseSvd(xml: string, file: string): SvdSummary {
    const root = parseXml(xml);
    const device = childrenOf(root, 'device')[0] ?? root;
    const peripherals: SvdPeripheral[] = [];
    for (const group of childrenOf(device, 'peripherals')) {
        for (const p of childrenOf(group, 'peripheral')) {
            const name = text(p, 'name');
            if (!name) { continue; }
            const registers: SvdRegister[] = [];
            const regs = childrenOf(p, 'registers')[0];
            if (regs) { parseRegisters(regs, '', 0, registers); }
            const interrupts: SvdInterrupt[] = childrenOf(p, 'interrupt').map(i => ({
                name: text(i, 'name') ?? '',
                value: svdNumber(text(i, 'value')) ?? -1,
                ...(text(i, 'description') ? { description: text(i, 'description') } : {}),
            })).filter(i => i.name && i.value >= 0);
            const groupName = text(p, 'groupName');
            const description = text(p, 'description');
            peripherals.push({
                name,
                ...(groupName ? { groupName } : {}),
                ...(description ? { description } : {}),
                baseAddress: svdNumber(text(p, 'baseAddress')) ?? 0,
                ...(p.attrs.derivedFrom ? { derivedFrom: p.attrs.derivedFrom } : {}),
                registers,
                interrupts,
            });
        }
    }
    const cpuEl = childrenOf(device, 'cpu')[0];
    const cpuName = cpuEl ? text(cpuEl, 'name') : undefined;
    const cpu = cpuName ? { name: cpuName, ...(text(cpuEl!, 'revision') ? { revision: text(cpuEl!, 'revision') } : {}) } : undefined;
    return { file, device: text(device, 'name'), ...(cpu ? { cpu } : {}), peripherals };
}

const cache = new Map<string, { mtimeMs: number; size: number; summary: SvdSummary }>();

export function loadSvd(file: string, log: PackDocsLog = silentLog): SvdSummary {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { return hit.summary; }
    const t0 = Date.now();
    const summary = parseSvd(fs.readFileSync(file, 'utf-8'), file);
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
    log.debug(`parsed ${file} (${(st.size / 1024).toFixed(0)} kB): ${summary.peripherals.length} peripherals in ${Date.now() - t0} ms`);
    return summary;
}

export function findPeripheral(svd: SvdSummary, name: string): SvdPeripheral | undefined {
    const wanted = name.trim().toLowerCase();
    return svd.peripherals.find(p => p.name.toLowerCase() === wanted);
}

/** The registers of a peripheral, following `derivedFrom` (up to 8 hops). */
export function registersOf(svd: SvdSummary, p: SvdPeripheral): SvdRegister[] {
    let cur: SvdPeripheral | undefined = p;
    for (let i = 0; cur && i < 8; i++) {
        if (cur.registers.length) { return cur.registers; }
        cur = cur.derivedFrom ? findPeripheral(svd, cur.derivedFrom) : undefined;
    }
    return [];
}

/** The group name of a peripheral, following `derivedFrom`. */
export function groupOf(svd: SvdSummary, p: SvdPeripheral): string | undefined {
    let cur: SvdPeripheral | undefined = p;
    for (let i = 0; cur && i < 8; i++) {
        if (cur.groupName) { return cur.groupName; }
        cur = cur.derivedFrom ? findPeripheral(svd, cur.derivedFrom) : undefined;
    }
    return undefined;
}

/** Peripherals grouped by `groupName` (own or inherited), for "which one did you mean" listings. */
export function peripheralsByGroup(svd: SvdSummary): Map<string, SvdPeripheral[]> {
    const out = new Map<string, SvdPeripheral[]>();
    for (const p of svd.peripherals) {
        const g = groupOf(svd, p) ?? p.name.replace(/\d+$/, '');
        const list = out.get(g) ?? [];
        list.push(p);
        out.set(g, list);
    }
    return out;
}
