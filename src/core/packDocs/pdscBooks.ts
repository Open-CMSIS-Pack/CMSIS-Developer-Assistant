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
 * The `<book>` elements of a pdsc, resolved for one device and one board.
 *
 * Books hang off `<device>`, `<subFamily>`, `<family>` and `<board>`; a
 * device inherits the books of its subFamily and family. `name` is either a
 * path relative to the pack directory or a URL. Most books carry no
 * `category`, so the title is what the agent gets to see.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ARM_DOCS, ArmDocEntry, ArmDocKind, armDocId, armDocUrl, armKindOrder, knownNpuOf, normalizeNpu, parseArmDocUrl } from './armDocs';
import { PackId, formatPackId } from './cbuildRun';
import { PackDocsLog, silentLog } from './host';
import { XmlElement, childrenOf, parseXml } from './xmlLite';

/**
 * Where a document was attributed: the pdsc levels, `unlisted` for PDFs in
 * the pack no `<book>` names, `arm` for the built-in Arm document catalogue,
 * `workspace` for PDFs the user dropped into a workspace docs folder.
 */
export type BookScope = 'device' | 'subFamily' | 'family' | 'board' | 'unlisted' | 'arm' | 'user' | 'workspace';
export type BookCategory = 'overview' | 'manual' | 'schematic' | 'setup' | 'other';
/**
 * `pack`: a file inside a pack; `web`: a URL, cached once fetched; `user`: a
 * file in the user documents folder (outside any workspace, attributed to a
 * pack/device/board/core by folder); `workspace`: a file in the workspace.
 */
export type DocSource = 'pack' | 'web' | 'user' | 'workspace';

export interface DocRef {
    /**
     * Stable id used in tool arguments: `<pack slug>/<file slug>` for pack
     * documents, `arm/<doc id>-<version>` for Arm documents,
     * `web/<host>/<hash>` for other web documents, `workspace/<file slug>`.
     */
    id: string;
    title: string;
    category?: BookCategory;
    scope: BookScope;
    /** `Keil::STM32F7xx_DFP@3.0.0` — absent for catalogue and workspace documents. */
    pack?: string;
    packId?: PackId;
    source: DocSource;
    /** Absolute path: the file for pack and workspace documents, the cached download for fetched web documents. */
    path?: string;
    /** The declared URL of a web document (never the transient download link). */
    url?: string;
    sizeBytes?: number;
    /** Known once extracted (pages, or sections for HTML documents). */
    pages?: number;
    cached: boolean;
    indexed: boolean;
    /** A pack document the pdsc names but that is not on disk. */
    missing?: boolean;
    /** Not a PDF (README.md, .chm, .zip …) — listed, never indexed. */
    unsupported?: boolean;
    /** Arm document identity, when the URL or catalogue names one; `resolvedVersion`/`versionLabel` once fetched. */
    arm?: { docId: string; version: string; resolvedVersion?: string; versionLabel?: string };
    /** Kind of Arm document, from the catalogue. */
    kind?: ArmDocKind;
    /** Edition for citations (`E.e`, `r1p2`, `Rev 8`). */
    revision?: string;
    /** Known after resolving a web document. */
    format?: 'pdf' | 'html';
    /** How `p.<n>` is to be read; `section` for HTML documents. */
    unit?: 'page' | 'section';
}

export interface PdscInfo {
    path: string;
    packDir: string;
    packId: PackId;
    root: XmlElement;
}

export interface BookQuery {
    deviceName?: string;
    boardName?: string;
}

/** One `<processor>` of a device, merged from family → subFamily → device → variant. */
export interface ProcessorInfo {
    /** `Pname` on multi-core devices. */
    pname?: string;
    /** `Dcore`, e.g. `Cortex-M33`. */
    core: string;
    /** `DcoreVersion`, e.g. `r0p0`. */
    coreVersion?: string;
}

/** A DocRef for a catalogue entry (not fetched yet). */
export function armDocRef(entry: ArmDocEntry): DocRef {
    const arm = { docId: entry.docId, version: entry.version };
    return {
        id: armDocId(arm), title: entry.title, scope: 'arm', source: 'web', url: armDocUrl(arm), arm, kind: entry.kind, cached: false, indexed: false,
    };
}

const pdscCache = new Map<string, { mtimeMs: number; size: number; info: PdscInfo }>();

/** Find the pdsc in a pack directory: `<Vendor>.<Name>.pdsc` when present, else the only `*.pdsc`. */
export function findPdscFile(dir: string, id?: PackId): string | undefined {
    if (!fs.existsSync(dir)) { return undefined; }
    const preferred = id ? path.join(dir, `${id.vendor}.${id.name}.pdsc`) : undefined;
    if (preferred && fs.existsSync(preferred)) { return preferred; }
    const candidates = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdsc'));
    return candidates.length ? path.join(dir, candidates[0]) : undefined;
}

export function loadPdsc(pdscPath: string, id: PackId, log: PackDocsLog = silentLog): PdscInfo {
    const st = fs.statSync(pdscPath);
    const hit = pdscCache.get(pdscPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        log.debug(`pdsc cache hit: ${pdscPath}`);
        return hit.info;
    }
    const started = Date.now();
    const root = parseXml(fs.readFileSync(pdscPath, 'utf-8'));
    const info: PdscInfo = { path: pdscPath, packDir: path.dirname(pdscPath), packId: id, root };
    pdscCache.set(pdscPath, { mtimeMs: st.mtimeMs, size: st.size, info });
    log.debug(`parsed ${pdscPath} (${(st.size / 1024).toFixed(0)} kB) in ${Date.now() - started} ms`);
    return info;
}

export function clearPdscCache(): void {
    pdscCache.clear();
}

export function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
}

export function fileSlug(name: string): string {
    // Local: the file name without extension. Web: the last meaningful path segment.
    let base = name;
    if (/^https?:\/\//i.test(name)) {
        try {
            const u = new URL(name);
            const segs = u.pathname.split('/').filter(Boolean);
            base = segs.length ? segs[segs.length - 1] : u.hostname;
            if (/^(index|latest|\d+)$/i.test(base) && segs.length > 1) { base = segs.slice(-2).join('-'); }
        } catch {
            base = name;
        }
    } else {
        base = path.basename(name);
    }
    return slug(base.replace(/\.(pdf|chm|md|txt|html?|zip)$/i, ''));
}

const SUPPORTED_EXT = new Set(['.pdf']);
const ARM_DOCS_BY_ID = new Map(ARM_DOCS.map(e => [e.docId, e]));

/** A document whose text can be extracted or read now: on disk, a PDF, and (for web documents) fetched. */
export function isReadable(d: DocRef): boolean {
    if (d.missing || d.unsupported || !d.path) { return false; }
    if (d.source === 'web') { return d.cached && d.format !== 'html'; }
    return true;
}

function normalizeCategory(value: string | undefined): BookCategory | undefined {
    const v = value?.trim().toLowerCase();
    if (v === 'overview' || v === 'manual' || v === 'schematic' || v === 'setup' || v === 'other') { return v; }
    return undefined;
}

interface Found {
    element: XmlElement;
    scope: BookScope;
}

/** The device element (or variant) with this Dname, plus its ancestors. */
function findDeviceChain(root: XmlElement, deviceName: string): Found[] | undefined {
    const wanted = deviceName.toLowerCase();
    const devices = childrenOf(root, 'devices');
    for (const devs of devices) {
        for (const family of childrenOf(devs, 'family')) {
            const visitDevices = (parent: XmlElement, chain: Found[]): Found[] | undefined => {
                for (const device of childrenOf(parent, 'device')) {
                    if ((device.attrs.Dname ?? '').toLowerCase() === wanted) {
                        return [{ element: device, scope: 'device' }, ...chain];
                    }
                    for (const variant of childrenOf(device, 'variant')) {
                        if ((variant.attrs.Dvariant ?? '').toLowerCase() === wanted) {
                            return [{ element: variant, scope: 'device' }, { element: device, scope: 'device' }, ...chain];
                        }
                    }
                }
                return undefined;
            };
            const famChain: Found[] = [{ element: family, scope: 'family' }];
            const direct = visitDevices(family, famChain);
            if (direct) { return direct; }
            for (const sub of childrenOf(family, 'subFamily')) {
                const hit = visitDevices(sub, [{ element: sub, scope: 'subFamily' }, ...famChain]);
                if (hit) { return hit; }
            }
        }
    }
    return undefined;
}

/**
 * The processors of a device: `<processor>` attributes are inherited down
 * the family → subFamily → device → variant chain and merged per `Pname`
 * (the core usually sits at family level, the clock at device level).
 * An unknown device yields the family-level processors.
 */
export function collectProcessors(pdsc: PdscInfo, deviceName: string | undefined): ProcessorInfo[] {
    const chain = deviceName ? findDeviceChain(pdsc.root, deviceName) : undefined;
    const levels = chain
        ? [...chain].reverse().map(c => c.element)
        : childrenOf(pdsc.root, 'devices').flatMap(d => childrenOf(d, 'family')).slice(0, 1);
    const merged = new Map<string, Record<string, string>>();
    for (const level of levels) {
        for (const p of childrenOf(level, 'processor')) {
            const key = p.attrs.Pname ?? '';
            merged.set(key, { ...(merged.get(key) ?? {}), ...p.attrs });
        }
    }
    const out: ProcessorInfo[] = [];
    for (const [key, attrs] of merged) {
        if (!attrs.Dcore) { continue; }
        out.push({ ...(key ? { pname: key } : {}), core: attrs.Dcore, ...(attrs.DcoreVersion ? { coreVersion: attrs.DcoreVersion } : {}) });
    }
    return out;
}

export interface SvdRef {
    /** Absolute path. */
    path: string;
    /** As written in the pdsc, relative to the pack. */
    rel: string;
    pname?: string;
    exists: boolean;
}

/**
 * The SVD of a device from `<debug svd="…">` in its chain, most specific
 * level first; `pname` picks the processor on multi-core devices.
 */
export function findSvd(pdsc: PdscInfo, deviceName: string | undefined, pname?: string): SvdRef | undefined {
    const chain = deviceName ? findDeviceChain(pdsc.root, deviceName) : undefined;
    const levels = chain ? chain.map(c => c.element) : childrenOf(pdsc.root, 'devices').flatMap(d => childrenOf(d, 'family'));
    for (const level of levels) {
        const debugs = childrenOf(level, 'debug').filter(d => !!d.attrs.svd);
        const pick = pname ? debugs.find(d => (d.attrs.Pname ?? '').toLowerCase() === pname.toLowerCase()) : debugs[0];
        if (pick) {
            const rel = pick.attrs.svd!.trim();
            const abs = path.resolve(pdsc.packDir, rel);
            return { path: abs, rel, ...(pick.attrs.Pname ? { pname: pick.attrs.Pname } : {}), exists: fs.existsSync(abs) };
        }
    }
    return undefined;
}

/**
 * The NPUs of a device from its `<feature>` elements — `type="NPU" n="Ethos-U85"`
 * (pdsc 1.7.x) or the older `type="CoreOther" name="… Ethos-U55 HP"` — at any
 * level of the chain; for Arm's own subsystems (SSE-3xx), whose packs say
 * nothing, the known Corstone configuration. Distinct, in order of appearance.
 */
export function collectNpus(pdsc: PdscInfo, deviceName: string | undefined): string[] {
    const chain = deviceName ? findDeviceChain(pdsc.root, deviceName) : undefined;
    const levels = chain ? [...chain].reverse().map(c => c.element) : [];
    const out: string[] = [];
    for (const level of levels) {
        for (const f of childrenOf(level, 'feature')) {
            const type = (f.attrs.type ?? '').toLowerCase();
            const text = type === 'npu' ? (f.attrs.n ?? f.attrs.name ?? '') : (type === 'coreother' || type === 'other') ? (f.attrs.name ?? '') : '';
            const npu = normalizeNpu(text);
            if (npu && !out.includes(npu)) { out.push(npu); }
        }
    }
    if (!out.length) {
        const known = knownNpuOf(deviceName);
        if (known) { out.push(known); }
    }
    return out;
}

function bookToDoc(book: XmlElement, scope: BookScope, pdsc: PdscInfo): DocRef {
    const name = (book.attrs.name ?? '').trim();
    const isWeb = /^https?:\/\//i.test(name);
    const title = (book.attrs.title ?? '').trim() || (isWeb ? name : path.basename(name));
    const doc: DocRef = {
        id: `${slug(pdsc.packId.name)}/${fileSlug(name)}`,
        title,
        category: normalizeCategory(book.attrs.category),
        scope,
        pack: formatPackId(pdsc.packId),
        packId: pdsc.packId,
        source: isWeb ? 'web' : 'pack',
        cached: false,
        indexed: false,
    };
    if (isWeb) {
        doc.url = name;
        // Arm documents get one identity however the pdsc spells the link, so a
        // fetched copy serves every pack that points at it.
        const arm = parseArmDocUrl(name);
        if (arm) {
            doc.id = armDocId(arm);
            doc.arm = arm;
            const entry = ARM_DOCS_BY_ID.get(arm.docId);
            if (entry) { doc.kind = entry.kind; }
        }
    } else {
        const abs = path.resolve(pdsc.packDir, name);
        doc.path = abs;
        if (!SUPPORTED_EXT.has(path.extname(abs).toLowerCase())) { doc.unsupported = true; }
        try {
            doc.sizeBytes = fs.statSync(abs).size;
        } catch {
            doc.missing = true;
        }
    }
    return doc;
}

const SCOPE_ORDER: Record<BookScope, number> = { device: 0, subFamily: 1, family: 2, board: 3, unlisted: 4, arm: 5, user: 6, workspace: 7 };
const CATEGORY_ORDER: Record<string, number> = { manual: 0, overview: 1, undefined: 2, other: 3, setup: 4, schematic: 5 };

export function sortDocs(docs: DocRef[]): DocRef[] {
    return [...docs].sort((a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
        (CATEGORY_ORDER[String(a.category)] ?? 2) - (CATEGORY_ORDER[String(b.category)] ?? 2) ||
        (a.scope === 'arm' ? armKindOrder(a.kind) - armKindOrder(b.kind) : 0) ||
        a.title.localeCompare(b.title));
}

/** Give every doc a unique id within the set by suffixing duplicates. */
export function dedupeIds(docs: DocRef[]): DocRef[] {
    const seen = new Map<string, number>();
    for (const d of docs) {
        const count = seen.get(d.id) ?? 0;
        seen.set(d.id, count + 1);
        if (count > 0) { d.id = `${d.id}-${count + 1}`; }
    }
    return docs;
}

/**
 * Collect the books that apply to the device and/or board named in the
 * query. A book that appears at several levels is kept at its most specific
 * scope.
 */
export function collectBooks(pdsc: PdscInfo, query: BookQuery, log: PackDocsLog = silentLog): { docs: DocRef[]; notes: string[] } {
    const notes: string[] = [];
    const byName = new Map<string, DocRef>();
    const add = (book: XmlElement, scope: BookScope) => {
        const name = (book.attrs.name ?? '').trim();
        if (!name) { return; }
        if (byName.has(name)) { return; }
        byName.set(name, bookToDoc(book, scope, pdsc));
    };

    if (query.deviceName) {
        const chain = findDeviceChain(pdsc.root, query.deviceName);
        if (chain) {
            for (const { element, scope } of chain) {
                for (const book of childrenOf(element, 'book')) { add(book, scope); }
            }
            log.debug(`device ${query.deviceName}: ${chain.map(c => `${c.scope}=${c.element.attrs.Dname ?? c.element.attrs.Dvariant ?? c.element.attrs.DsubFamily ?? c.element.attrs.Dfamily}`).join(' < ')}`);
        } else {
            const families = childrenOf(pdsc.root, 'devices').flatMap(d => childrenOf(d, 'family'));
            if (families.length) {
                notes.push(`device ${query.deviceName} is not in ${path.basename(pdsc.path)}; listing its family-level books`);
                for (const family of families) {
                    for (const book of childrenOf(family, 'book')) { add(book, 'family'); }
                }
            }
        }
    }

    const boards = childrenOf(pdsc.root, 'boards').flatMap(b => childrenOf(b, 'board'));
    if (boards.length) {
        const wanted = query.boardName?.toLowerCase();
        const matching = wanted ? boards.filter(b => (b.attrs.name ?? '').toLowerCase() === wanted) : [];
        const chosen = matching.length ? matching : (wanted ? [] : boards);
        if (wanted && !matching.length) {
            notes.push(`board ${query.boardName} is not in ${path.basename(pdsc.path)} (has: ${boards.map(b => b.attrs.name).join(', ')})`);
        }
        for (const board of chosen) {
            for (const book of childrenOf(board, 'book')) { add(book, 'board'); }
        }
    }

    const docs = [...byName.values()];
    log.debug(`${path.basename(pdsc.path)}: ${docs.length} books (${docs.filter(d => d.source === 'pack').length} in pack, ${docs.filter(d => d.source === 'web').length} web)`);
    return { docs, notes };
}

/** PDFs inside the pack directory that no `<book>` names. Capped; vendored third-party trees are common. */
export function unlistedPdfs(pdsc: PdscInfo, referenced: Set<string>, max = 100): DocRef[] {
    const out: DocRef[] = [];
    const walk = (dir: string, depth: number) => {
        if (out.length >= max || depth > 8) { return; }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (out.length >= max) { return; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name.startsWith('.')) { continue; }
                walk(full, depth + 1);
            } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf') && !referenced.has(path.resolve(full))) {
                let size: number | undefined;
                try { size = fs.statSync(full).size; } catch { size = undefined; }
                out.push({
                    id: `${slug(pdsc.packId.name)}/${fileSlug(e.name)}`,
                    title: e.name.replace(/\.pdf$/i, ''),
                    scope: 'unlisted',
                    pack: formatPackId(pdsc.packId),
                    packId: pdsc.packId,
                    source: 'pack',
                    path: full,
                    sizeBytes: size,
                    cached: false,
                    indexed: false,
                });
            }
        }
    };
    walk(pdsc.packDir, 0);
    return out;
}
