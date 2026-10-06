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

/** Read-only catalog selection. The small structural types describe only the
 * public CMSIS Solution v2 properties we consume (api/csolution-api-v2.d.ts).
 * No VS Code, source-manager internals, hardware or project creation here. */

export interface CatalogId { readonly key: string; readonly vendor: string; readonly name: string }
export interface CatalogPack extends CatalogId { readonly version?: string }
export interface CatalogProcessor { readonly name?: string; readonly core: string }
export interface CatalogBoard {
    readonly id: CatalogId;
    readonly vendor: string;
    readonly name: string;
    readonly revision?: string;
    readonly devices: Promise<CatalogId[]>;
    readonly pack: Promise<CatalogPack | undefined>;
}
export interface CatalogDevice {
    readonly id: CatalogId;
    readonly vendor: string;
    readonly name: string;
    readonly family: string;
    readonly pack: Promise<CatalogPack | undefined>;
    readonly processors: Promise<CatalogProcessor[]>;
}
export interface CatalogFilter { vendor?: string; name?: string; revision?: string }
export interface DiscoveryApi {
    getBoards(filter?: CatalogFilter): Promise<CatalogBoard[]>;
    getDevices(filter?: CatalogFilter): Promise<CatalogDevice[]>;
}
export interface DiscoveryRequest {
    kind: 'board' | 'device';
    name: string;
    vendor?: string;
    revision?: string;
    match?: 'exact' | 'contains';
    /** Independently established device, also used to disambiguate compatible devices. */
    device?: string;
    processor?: string;
    limit?: number;
    timeoutMs?: number;
}
export interface DiscoveryCandidate {
    id: string;
    vendor: string;
    name: string;
    revision?: string;
}
export interface DiscoveryReport {
    status: 'resolved' | 'ambiguous' | 'unresolved' | 'unavailable';
    evidence: 'catalog';
    scope: 'returned candidates only; no physical hardware verification';
    reason: string;
    candidates: DiscoveryCandidate[];
    totalCandidates: number;
    truncated: boolean;
    board?: DiscoveryCandidate;
    device?: DiscoveryCandidate;
    processors?: { name: string | null; core: string }[];
    processor?: string;
    bsp?: string;
    dfp?: string;
    packs: string[];
    issues: string[];
}

/** Literal names never become user-supplied regular expressions. */
export function literalCatalogPattern(name: string, match: 'exact' | 'contains' = 'exact'): string {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return match === 'exact' ? `^${escaped}$` : escaped;
}

/** Stable identifiers, with revisions retained and duplicate rows collapsed. */
export function catalogCandidates<T extends CatalogBoard | CatalogDevice>(items: readonly T[]): T[] {
    const seen = new Set<string>();
    return items.filter(item => {
        const id = item.id.key;
        if (seen.has(id)) { return false; }
        seen.add(id);
        return true;
    }).sort((a, b) => a.id.key < b.id.key ? -1 : a.id.key > b.id.key ? 1 : 0);
}

class DiscoveryTimeout extends Error {}
class DiscoveryInputError extends Error {}

function identity(value: string | undefined, label: string): string | undefined {
    if (value === undefined) { return undefined; }
    const normalized = value.trim();
    if (!normalized || normalized.length > 256) {
        throw new DiscoveryInputError(`${label} must contain 1 to 256 characters.`);
    }
    return normalized;
}

/** One deadline covers activation, list retrieval and every detail promise.
 * v2 has no cancellation token: a timed-out promise can finish, but no later
 * stage starts after this deadline, and its rejection remains observed. */
class Deadline {
    private readonly end: number;
    constructor(ms: number) { this.end = Date.now() + ms; }

    async wait<T>(work: () => PromiseLike<T> | T): Promise<T> {
        const remaining = this.end - Date.now();
        if (remaining <= 0) { throw new DiscoveryTimeout('Catalog discovery deadline exceeded.'); }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                Promise.resolve().then(work),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new DiscoveryTimeout('Catalog discovery deadline exceeded.')), remaining);
                }),
            ]);
        } finally {
            if (timer !== undefined) { clearTimeout(timer); }
        }
    }
}

function candidate(item: CatalogBoard | CatalogDevice | CatalogId): DiscoveryCandidate {
    const id = 'id' in item ? item.id.key : item.key;
    return { id, vendor: item.vendor, name: item.name,
        ...('revision' in item && item.revision !== undefined ? { revision: item.revision } : {}),
    };
}

function initialReport(): DiscoveryReport {
    return {
        status: 'unresolved', evidence: 'catalog',
        scope: 'returned candidates only; no physical hardware verification',
        reason: '', candidates: [], totalCandidates: 0, truncated: false, packs: [], issues: [],
    };
}

function queryFilter(name: string, vendor: string | undefined, match: 'exact' | 'contains'): CatalogFilter {
    const parts = name.split('::');
    if (parts.length > 2 || (parts.length === 2 && vendor && parts[0] !== vendor)) {
        throw new DiscoveryInputError('Conflicting or malformed vendor-qualified name.');
    }
    const partName = parts.length === 2 ? parts[1] : parts[0];
    if (!partName || (parts.length === 2 && !parts[0])) { throw new DiscoveryInputError('A nonempty catalog name is required.'); }
    return { name: literalCatalogPattern(partName, match), ...(vendor || parts.length === 2 ? { vendor: vendor ?? parts[0] } : {}) };
}

function isRequestedDevice(device: CatalogId, requested: string): boolean {
    return requested.includes('::') ? device.key === requested : device.name === requested;
}

/** Resolve a literal board/device query through supported API v2 only.
 * Resolved means the required catalog facts agree; source completeness and the
 * identity of attached hardware are deliberately never claimed. */
export async function discoverDevice(
    source: DiscoveryApi | (() => Promise<DiscoveryApi>), request: DiscoveryRequest,
): Promise<DiscoveryReport> {
    const report = initialReport();
    const limit = Math.max(1, Math.min(25, Math.floor(request.limit ?? 10)));
    const deadline = new Deadline(Math.max(1, Math.min(60_000, request.timeoutMs ?? 30_000)));
    const finish = (status: DiscoveryReport['status'], reason: string): DiscoveryReport => {
        report.status = status;
        report.reason = reason;
        report.packs = [...new Set([report.bsp, report.dfp].filter((p): p is string => !!p))];
        // Count and byte budgets are independent. Never shorten an identifier.
        if (Buffer.byteLength(JSON.stringify(report)) > 16_000) {
            return { ...initialReport(), reason: 'Catalog fields exceed the response budget; narrow the query.',
                totalCandidates: report.totalCandidates, truncated: true };
        }
        return report;
    };
    const present = (items: DiscoveryCandidate[]): void => {
        report.totalCandidates = items.length;
        report.candidates = items.slice(0, limit);
        report.truncated = items.length > limit;
    };
    const detail = async <T>(label: string, get: () => Promise<T>): Promise<T | undefined> => {
        try { return await deadline.wait(get); } catch (error) {
            report.issues.push(`${label}: ${error instanceof DiscoveryTimeout ? 'timed out' : 'detail rejected'}.`);
            return undefined;
        }
    };
    const packId = (pack: CatalogPack | undefined): string | undefined => {
        if (!pack?.vendor || !pack.name) { return undefined; }
        return `${pack.vendor}::${pack.name}${pack.version ? `@${pack.version}` : ''}`;
    };

    try {
        if (!Number.isFinite(limit) || (request.timeoutMs !== undefined && !Number.isFinite(request.timeoutMs))) {
            return finish('unresolved', 'A nonempty name and finite limits are required.');
        }
        const name = identity(request.name, 'Name')!;
        const vendor = identity(request.vendor, 'Vendor');
        const revision = identity(request.revision, 'Revision');
        const requestedDevice = identity(request.device, 'Device');
        const requestedProcessor = identity(request.processor, 'Processor');
        const api = typeof source === 'function' ? await deadline.wait(source) : source;
        const match = request.match ?? 'exact';
        let deviceFilter: CatalogFilter;
        if (request.kind === 'board') {
            const filter = queryFilter(name, vendor, match);
            if (revision !== undefined) { filter.revision = literalCatalogPattern(revision); }
            const boards = catalogCandidates(await deadline.wait(() => api.getBoards(filter)));
            present(boards.map(candidate));
            if (boards.length > 1) { return finish('ambiguous', 'Choose an exact board vendor, name and revision.'); }
            if (boards.length === 0) {
                if (!requestedDevice) {
                    return finish('unresolved', 'No board returned; coverage is unknown. Supply an independently verified fitted device for DFP-only lookup.');
                }
                report.issues.push('No board returned; checking only the supplied device. BSP availability remains unknown.');
                deviceFilter = queryFilter(requestedDevice, undefined, 'exact');
            } else {
                report.board = candidate(boards[0]);
                if (match !== 'exact') { return finish('unresolved', 'Confirm this candidate with an exact board query before resolving support.'); }
                const [devices, pack] = await Promise.all([
                    detail('Board devices', () => boards[0].devices),
                    detail('Board pack', () => boards[0].pack),
                ]);
                report.bsp = packId(pack);
                if (!devices?.length) { return finish('unresolved', 'Board device details are missing; fitted device is unresolved.'); }
                // All compatible devices participate, including those beyond the output limit.
                const unique = [...new Map(devices.map(d => [d.key, d])).values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
                const choices = requestedDevice ? unique.filter(d => isRequestedDevice(d, requestedDevice)) : unique;
                present((choices.length ? choices : unique).map(candidate));
                if (!choices.length) { return finish('unresolved', 'Supplied device conflicts with the board catalog; verify the fitted device.'); }
                if (choices.length > 1) { return finish('ambiguous', 'Choose the fitted device; the first compatible device is only an upstream default hint.'); }
                deviceFilter = queryFilter(choices[0].name, choices[0].vendor, 'exact');
            }
        } else {
            deviceFilter = queryFilter(name, vendor, match);
        }

        const devices = catalogCandidates(await deadline.wait(() => api.getDevices(deviceFilter)));
        present(devices.map(candidate));
        if (!devices.length) { return finish('unresolved', 'No device returned; unknown catalog coverage does not establish absence of a DFP.'); }
        if (devices.length > 1) { return finish('ambiguous', 'Choose an exact device vendor and name.'); }
        report.device = candidate(devices[0]);
        if (request.kind === 'device' && match !== 'exact') {
            return finish('unresolved', 'Confirm this candidate with an exact device query before resolving support.');
        }
        const [pack, processors] = await Promise.all([
            detail('Device pack', () => devices[0].pack),
            detail('Device processors', () => devices[0].processors),
        ]);
        report.dfp = packId(pack);
        report.processors = processors?.slice(0, limit).map(p => ({ name: p.name?.trim() || null, core: p.core }));
        report.truncated ||= (processors?.length ?? 0) > limit;
        if (!processors?.length) { return finish('unresolved', 'Processor details are missing; device support is not fully resolved.'); }
        if (requestedProcessor) {
            const matching = processors.filter(p => p.name?.trim() === requestedProcessor);
            if (matching.length !== 1) { return finish('unresolved', 'Requested processor is not uniquely named in the returned device details.'); }
            report.processor = matching[0].name?.trim();
        } else if (processors.length > 1) {
            return finish('ambiguous', 'Choose a processor from the returned device details; unnamed processors need independent verification.');
        } else if (processors[0].name?.trim()) {
            report.processor = processors[0].name.trim();
        }
        if (!report.dfp || report.issues.some(i => /detail rejected|timed out/.test(i))) {
            return finish('unresolved', 'Required pack or device details are missing; do not claim complete support.');
        }
        if (report.board && !report.bsp) { report.issues.push('Board pack is missing; only DFP support is established.'); }
        return finish('resolved', report.bsp ? 'BSP and DFP resolved for the exact catalog identities.' : 'DFP resolved for the exact device; BSP support is not established.');
    } catch (error) {
        if (error instanceof DiscoveryInputError) { return finish('unresolved', error.message); }
        if (error instanceof DiscoveryTimeout) { return finish('unavailable', 'Catalog discovery timed out; no automatic retry was started.'); }
        return finish('unavailable', 'CMSIS Solution API v2 or its catalog query is unavailable; no support conclusion can be drawn.');
    }
}
