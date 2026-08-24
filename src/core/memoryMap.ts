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
 * The Armv7-M / Armv8-M system address map. Used to say something useful
 * about an address the SVD does not cover ("that is SRAM, not a peripheral")
 * before a device-specific map from cbuild-run.yml is available.
 */

export type MemoryKind = 'code' | 'sram' | 'peripheral' | 'external-ram' | 'external-device' | 'ppb' | 'vendor';

export interface MemoryRegion {
    name: string;
    kind: MemoryKind;
    /** Inclusive. */
    start: number;
    /** Inclusive. */
    end: number;
}

export function defaultCortexMRegions(): MemoryRegion[] {
    return [
        { name: 'Code', kind: 'code', start: 0x0000_0000, end: 0x1FFF_FFFF },
        { name: 'SRAM', kind: 'sram', start: 0x2000_0000, end: 0x3FFF_FFFF },
        { name: 'Peripheral', kind: 'peripheral', start: 0x4000_0000, end: 0x5FFF_FFFF },
        { name: 'External RAM', kind: 'external-ram', start: 0x6000_0000, end: 0x9FFF_FFFF },
        { name: 'External device', kind: 'external-device', start: 0xA000_0000, end: 0xDFFF_FFFF },
        { name: 'Private peripheral bus', kind: 'ppb', start: 0xE000_0000, end: 0xE00F_FFFF },
        { name: 'Vendor-specific', kind: 'vendor', start: 0xE010_0000, end: 0xFFFF_FFFF },
    ];
}

export function regionOf(address: number, regions: readonly MemoryRegion[] = defaultCortexMRegions()): MemoryRegion | undefined {
    const addr = address >>> 0;
    return regions.find((r) => addr >= r.start && addr <= r.end);
}

export function formatAddress(address: number): string {
    return `0x${(address >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
}
