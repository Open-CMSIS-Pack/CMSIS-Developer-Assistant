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

/** Synthetic catalogs for deterministic discovery regression tests.
 * Names deliberately describe no real silicon. Counters measure property access,
 * not network requests: upstream may coalesce several lazy properties. */
import type { CatalogBoard, CatalogDevice, CatalogFilter, CatalogId, CatalogPack, DiscoveryApi, DiscoveryRequest } from '../core/deviceDiscovery';

interface BoardSpec { name: string; revision?: string; devices: string[]; pack?: string; fail?: boolean }
interface ProcessorSpec { name?: string; core: string }
interface DeviceSpec { name: string; pack?: string; processors?: ProcessorSpec[]; fail?: boolean; vendor?: string }
export interface DiscoveryFixture {
    name: string;
    request: DiscoveryRequest;
    boards: BoardSpec[];
    devices: DeviceSpec[];
    unavailable?: boolean;
    expected: 'resolved' | 'ambiguous' | 'unresolved' | 'unavailable';
    selected?: string;
}
const processor = (name?: string): ProcessorSpec => ({ ...(name === undefined ? {} : { name }), core: 'Cortex-M33' });
const device: DeviceSpec = { name: 'Chip1', pack: 'Devices', processors: [processor('cpu0')] };
const board: BoardSpec = { name: 'Eval', devices: ['Chip1'], pack: 'Boards' };

/** Gold outcomes are explicit and independent of the resolver. */
export const DISCOVERY_FIXTURES: DiscoveryFixture[] = [
    { name: 'exact-separate-packs', request: { kind: 'board', name: 'Eval' }, boards: [board], devices: [device], expected: 'resolved', selected: 'Acme::Chip1' },
    { name: 'literal-punctuation', request: { kind: 'board', name: 'Eval.1+' }, boards: [{ ...board, name: 'Eval.1+' }, { ...board, name: 'EvalX11' }], devices: [device], expected: 'resolved', selected: 'Acme::Chip1' },
    { name: 'ambiguous-revisions', request: { kind: 'board', name: 'Eval' }, boards: [{ ...board, revision: 'A' }, { ...board, revision: 'B' }], devices: [device], expected: 'ambiguous' },
    { name: 'explicit-revision', request: { kind: 'board', name: 'Eval', revision: 'B' }, boards: [{ ...board, revision: 'A' }, { ...board, revision: 'B' }], devices: [device], expected: 'resolved', selected: 'Acme::Chip1' },
    { name: 'device-only', request: { kind: 'device', name: 'Chip1' }, boards: [], devices: [device], expected: 'resolved', selected: 'Acme::Chip1' },
    { name: 'no-bsp-known-device', request: { kind: 'board', name: 'Custom', device: 'Acme::Chip1' }, boards: [], devices: [device], expected: 'resolved', selected: 'Acme::Chip1' },
    { name: 'no-bsp-unknown-device', request: { kind: 'board', name: 'Custom' }, boards: [], devices: [device], expected: 'unresolved' },
    { name: 'combined-pack', request: { kind: 'board', name: 'Eval' }, boards: [{ ...board, pack: 'Combined' }], devices: [{ ...device, pack: 'Combined' }], expected: 'resolved', selected: 'Acme::Chip1' },
    { name: 'multiple-devices', request: { kind: 'board', name: 'Eval' }, boards: [{ ...board, devices: ['Chip1', 'Chip2'] }], devices: [device, { ...device, name: 'Chip2' }], expected: 'ambiguous' },
    { name: 'explicit-second-device', request: { kind: 'board', name: 'Eval', device: 'Acme::Chip2' }, boards: [{ ...board, devices: ['Chip1', 'Chip2'] }], devices: [device, { ...device, name: 'Chip2' }], expected: 'resolved', selected: 'Acme::Chip2' },
    { name: 'multiple-processors', request: { kind: 'device', name: 'Chip1' }, boards: [], devices: [{ ...device, processors: [processor('cpu0'), processor('cpu1')] }], expected: 'ambiguous' },
    { name: 'explicit-processor', request: { kind: 'device', name: 'Chip1', processor: 'cpu1' }, boards: [], devices: [{ ...device, processors: [processor('cpu0'), processor('cpu1')] }], expected: 'resolved', selected: 'Acme::Chip1' },
    { name: 'missing-processor-name', request: { kind: 'device', name: 'Chip1' }, boards: [], devices: [{ ...device, processors: [processor()] }], expected: 'resolved', selected: 'Acme::Chip1' },
    { name: 'required-missing-processor', request: { kind: 'device', name: 'Chip1', processor: 'Cortex-M33' }, boards: [], devices: [{ ...device, processors: [processor()] }], expected: 'unresolved' },
    { name: 'conflicting-device-evidence', request: { kind: 'board', name: 'Eval', device: 'Acme::Chip2' }, boards: [board], devices: [device, { ...device, name: 'Chip2' }], expected: 'unresolved' },
    { name: 'rejected-board-detail', request: { kind: 'board', name: 'Eval' }, boards: [{ ...board, fail: true }], devices: [device], expected: 'unresolved' },
    { name: 'rejected-device-detail', request: { kind: 'device', name: 'Chip1' }, boards: [], devices: [{ ...device, fail: true }], expected: 'unresolved' },
    { name: 'missing-dfp', request: { kind: 'board', name: 'Eval' }, boards: [board], devices: [{ ...device, pack: undefined }], expected: 'unresolved' },
    { name: 'source-rejection', request: { kind: 'board', name: 'Eval' }, boards: [], devices: [], unavailable: true, expected: 'unavailable' },
    { name: 'empty-unknown-coverage', request: { kind: 'device', name: 'Unknown' }, boards: [], devices: [], expected: 'unresolved' },
    { name: 'fuzzy-single-candidate', request: { kind: 'board', name: 'Eva', match: 'contains' }, boards: [board], devices: [device], expected: 'unresolved' },
    { name: 'bounded-fuzzy-list', request: { kind: 'device', name: 'Chip', match: 'contains', limit: 1 }, boards: [], devices: [device, { ...device, name: 'Chip2' }], expected: 'ambiguous' },
];

/** A public API-shaped mock with getters, lazy errors, and per-property counters. */
export function fixtureCatalog(fixture: DiscoveryFixture, noise = 0): {
    api: DiscoveryApi; calls: string[]; details: string[];
} {
    const calls: string[] = [];
    const details: string[] = [];
    const id = (name: string, vendor = 'Acme'): CatalogId => ({ key: `${vendor}::${name}`, vendor, name });
    const pack = (name: string | undefined): CatalogPack | undefined => name ? { ...id(name), key: `Acme::${name}@1.0.0`, version: '1.0.0' } : undefined;
    const detail = <T>(label: string, value: T, fail = false): Promise<T> => {
        details.push(label);
        return fail ? Promise.reject(new Error('fixture detail unavailable')) : Promise.resolve(value);
    };
    const boards: CatalogBoard[] = [...fixture.boards, ...Array.from({ length: noise }, (_, i) => ({ ...board, name: `UnrelatedBoard${i}` }))].map(b => ({
        id: { ...id(b.name), key: `Acme::${b.name}${b.revision ? `:${b.revision}` : ''}` }, vendor: 'Acme', name: b.name, revision: b.revision,
        get devices() { return detail(`${b.name}.devices`, b.devices.map(d => id(d)), b.fail); },
        get pack() { return detail(`${b.name}.pack`, pack(b.pack), b.fail); },
    }));
    const devices: CatalogDevice[] = [...fixture.devices, ...Array.from({ length: noise }, (_, i) => ({ ...device, name: `UnrelatedChip${i}` }))].map(d => ({
        id: id(d.name, d.vendor), vendor: d.vendor ?? 'Acme', name: d.name, family: 'Synthetic',
        get pack() { return detail(`${d.name}.pack`, pack(d.pack), d.fail); },
        get processors() { return detail(`${d.name}.processors`, d.processors ?? [], d.fail); },
    }));
    const matches = (entry: CatalogBoard | CatalogDevice, filter?: CatalogFilter): boolean =>
        (!filter?.vendor || entry.vendor === filter.vendor) && (!filter?.name || new RegExp(filter.name).test(entry.name)) &&
        (!filter?.revision || ('revision' in entry && new RegExp(filter.revision).test(entry.revision ?? '')));
    return { calls, details, api: {
        async getBoards(filter) {
            calls.push(`getBoards:${JSON.stringify(filter ?? {})}`);
            if (fixture.unavailable) { throw new Error('fixture catalog unavailable'); }
            return boards.filter(b => matches(b, filter));
        },
        async getDevices(filter) {
            calls.push(`getDevices:${JSON.stringify(filter ?? {})}`);
            if (fixture.unavailable) { throw new Error('fixture catalog unavailable'); }
            return devices.filter(d => matches(d, filter));
        },
    } };
}
