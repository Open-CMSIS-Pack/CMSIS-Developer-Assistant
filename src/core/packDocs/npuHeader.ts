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
 * The Ethos-U NPU register map, from the interface header of the
 * ARM::ethos-u-core-driver pack (`ethosu55_interface.h` for U55 and U65,
 * `ethosu85_interface.h` for U85):
 *
 *   #define NPU_REG_STATUS 0x0004
 *   #define NPU_REG_BASEP_BASE 0x0080
 *   #define NPU_REG_BASEP_ARRLEN 0x0008
 *   struct status_r { #ifndef __cplusplus union { struct {
 *       uint32_t state : 1;      // NPU state, 0 = Stopped, 1 = Running
 *       uint32_t irq_raised : 1; // Raw IRQ status …
 *   }; uint32_t word; }; #else … };
 *
 * C bitfields are laid out LSB first, so the bit offsets accumulate in
 * declaration order. Parsed into the SVD summary shape. The base address
 * is SoC-specific and comes from the vendor SVD when it has an NPU
 * peripheral; otherwise it is reported as unknown.
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeNpu } from './armDocs';
import { PackDocsLog, silentLog } from './host';
import { SvdField, SvdPeripheral, SvdRegister, SvdSummary } from './svdLite';
import { pickInstalledVersion } from './targetDocs';

export interface NpuHeaderRef {
    /** `Ethos-U55` */
    npu: string;
    /** `ethosu55_interface.h` */
    file: string;
    path: string;
    /** `ARM::ethos-u-core-driver@1.26.2` */
    pack: string;
    exists: boolean;
}

const HEADER_BY_NPU: Record<string, string> = { 'Ethos-U55': 'ethosu55_interface.h', 'Ethos-U65': 'ethosu65_interface.h', 'Ethos-U85': 'ethosu85_interface.h' };

/** The driver interface header for an NPU, from the highest installed ARM::ethos-u-core-driver pack. */
export function resolveNpuHeader(packRoot: string, npu: string): NpuHeaderRef | undefined {
    const name = normalizeNpu(npu) ?? npu;
    const file = HEADER_BY_NPU[name];
    if (!file) { return undefined; }
    const version = pickInstalledVersion(packRoot, { vendor: 'ARM', name: 'ethos-u-core-driver' });
    if (!version) { return { npu: name, file, path: '', pack: 'ARM::ethos-u-core-driver (not installed)', exists: false }; }
    const base = path.join(packRoot, 'ARM', 'ethos-u-core-driver', version);
    // The U65 map is the U55 map; older packs may ship only the U55 header.
    const files = name === 'Ethos-U65' ? [file, 'ethosu55_interface.h'] : [file];
    const candidates = files.flatMap(f => [path.join(base, 'ethos_u_core_driver', 'src', f), path.join(base, 'src', f)]);
    const found = candidates.find(p => fs.existsSync(p));
    return { npu: name, file: found ? path.basename(found) : file, path: found ?? candidates[0], pack: `ARM::ethos-u-core-driver@${version}`, exists: !!found };
}

/** Parse an Ethos-U interface header into one peripheral with every `NPU_REG_*` register and its bitfields. */
export function parseNpuHeader(text: string, file: string, npu: string, baseAddress = 0): SvdSummary {
    const offsets = new Map<string, number>();
    const arrays = new Map<string, number>();
    for (const m of text.matchAll(/^#define\s+NPU_REG_(\w+)\s+(0x[0-9A-Fa-f]+)\s*$/gm)) {
        if (m[1].endsWith('_ARRLEN')) { arrays.set(m[1].slice(0, -'_ARRLEN'.length), parseInt(m[2], 16)); }
        else { offsets.set(m[1], parseInt(m[2], 16)); }
    }
    // struct <name>_r { #ifndef __cplusplus union { struct { uint32_t f : w; // … }; … } — the C view only.
    const structs = new Map<string, SvdField[]>();
    for (const m of text.matchAll(/^struct\s+(\w+)_r\s*\{\s*#ifndef\s+__cplusplus\s+union\s*\{\s*struct\s*\{([\s\S]*?)\}\s*;/gm)) {
        const fields: SvdField[] = [];
        let bit = 0;
        for (const f of m[2].matchAll(/uint32_t\s+(\w+)\s*:\s*(\d+)\s*;[ \t]*(?:\/\/[ \t]*([^\n]*))?/g)) {
            const width = parseInt(f[2], 10);
            if (!/^reserved\d*$/i.test(f[1])) {
                const description = f[3]?.trim();
                fields.push({ name: f[1], bitOffset: bit, bitWidth: width, ...(description ? { description } : {}) });
            }
            bit += width;
        }
        structs.set(m[1].toUpperCase(), fields);
    }
    const registers: SvdRegister[] = [];
    for (const [name, offset] of offsets) {
        // An array register keeps its struct under the stem: BASEP_BASE → struct basep_r.
        const fields = structs.get(name) ?? (name.endsWith('_BASE') ? structs.get(name.slice(0, -'_BASE'.length)) : undefined) ?? [];
        const count = arrays.get(name) ?? (name.endsWith('_BASE') ? arrays.get(name.slice(0, -'_BASE'.length)) : undefined);
        registers.push({
            name,
            offset,
            ...(count ? { description: `${count} × 32-bit` } : {}),
            fields,
        });
    }
    registers.sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name));
    const peripheral: SvdPeripheral = {
        name: npu,
        groupName: 'NPU',
        description: `Arm ${npu} NPU register map (${path.basename(file)})${baseAddress ? '' : ' — base address not in the driver header: SoC-specific, see the vendor SVD or manual'}`,
        baseAddress,
        registers,
        interrupts: [],
    };
    return { file, device: `${npu} (${path.basename(file)})`, peripherals: [peripheral] };
}

const cache = new Map<string, { mtimeMs: number; size: number; summary: SvdSummary }>();

export function loadNpuHeader(ref: NpuHeaderRef, baseAddress = 0, log: PackDocsLog = silentLog): SvdSummary {
    const key = `${ref.path}|${ref.npu}|${baseAddress}`;
    const st = fs.statSync(ref.path);
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { return hit.summary; }
    const t0 = Date.now();
    const summary = parseNpuHeader(fs.readFileSync(ref.path, 'utf-8'), ref.path, ref.npu, baseAddress);
    cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, summary });
    const p = summary.peripherals[0];
    log.debug(`parsed ${ref.path}: ${p.registers.length} NPU registers, ${p.registers.reduce((n, r) => n + r.fields.length, 0)} fields in ${Date.now() - t0} ms`);
    return summary;
}

/** The NPU's base address from a vendor SVD peripheral named like the NPU (`ETHOS_U55`, `NPU`, …), if any. */
export function npuBaseFromSvd(svd: SvdSummary | undefined, npu: string): number | undefined {
    if (!svd) { return undefined; }
    const digits = (normalizeNpu(npu) ?? npu).replace(/\D/g, '');
    const exact = svd.peripherals.find(p => new RegExp(`ethos[_-]?u?${digits}`, 'i').test(p.name));
    if (exact) { return exact.baseAddress; }
    // A generic NPU peripheral is only trusted when it is the only one (two NPUs, e.g. Alif's NPU_HP/NPU_HE, cannot be told apart).
    const generic = svd.peripherals.filter(p => /ethos|^npu(_|$)|_npu(_|$)/i.test(p.name));
    return generic.length === 1 ? generic[0].baseAddress : undefined;
}
