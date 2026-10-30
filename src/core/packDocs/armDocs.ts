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
 * Arm document identity. Arm's documents are addressed by a document id
 * (`ddi0553`, `ihi0031`, `100230`) and a version token (`latest`, `bz`,
 * `0100`); every URL form a pdsc uses for them — developer.arm.com,
 * support.arm.com, the documentation-service API, the dead infocenter — maps
 * to that pair, and so does the store id `arm/<id>-<version>`.
 *
 * The tables — the document catalogue, the listing order of its kinds, the
 * core-to-architecture map and the NPUs of Arm's subsystems — live in
 * `armDocs.json` beside this file; this module holds the types that give
 * them meaning and the functions over them.
 */

import { coreArch, docs, kindOrder, knownNpus } from './armDocs.json';

export interface ArmDocRef {
    /** Lower-case document id: `ddi0553`, `ihi0031`, `100230`. */
    docId: string;
    /** Version token as used in URLs, or `latest`. */
    version: string;
}

const DOC_ID = /^(?:[a-z]{3}\d{4}|\d{6,7})$/i;
/** A version token as it appears in URLs (`latest`, `ee`, `bz`, `0100`, `f`) — not a topic slug. */
const VERSION = /^(?:latest|[a-z]{1,3}|\d{2,4}|[a-z]\d|\d[a-z])$/i;

/**
 * `developer.arm.com/documentation/<id>[/<version>][/…]`,
 * `support.arm.com/documentation/<id>/<version>`,
 * `documentation-service.arm.com/documentation/<id>/<version>`,
 * `infocenter.arm.com/help/topic/com.arm.doc.<id><rev>/…` and
 * `…com.arm.doc.<id>_<version>_<n>_en/…`. Anything else → undefined.
 */
export function parseArmDocUrl(url: string): ArmDocRef | undefined {
    let u: URL;
    try {
        u = new URL(url.trim());
    } catch {
        return undefined;
    }
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean);
    if (host === 'developer.arm.com' || host === 'support.arm.com' || host === 'documentation-service.arm.com') {
        if ((segs[0] ?? '').toLowerCase() !== 'documentation' || !segs[1] || !DOC_ID.test(segs[1])) { return undefined; }
        const version = segs[2] && VERSION.test(segs[2]) ? segs[2].toLowerCase() : 'latest';
        return { docId: segs[1].toLowerCase(), version };
    }
    if (host === 'infocenter.arm.com') {
        const m = u.pathname.match(/com\.arm\.doc\.([a-z]{3}\d{4}|\d{6,7})(?:_(\d{4})_\d+_[a-z]{2}|([a-z]))?(?:[/.]|$)/i);
        if (!m) { return undefined; }
        return { docId: m[1].toLowerCase(), version: (m[2] ?? m[3] ?? 'latest').toLowerCase() };
    }
    return undefined;
}

/** The canonical page for humans. */
export function armDocUrl(ref: ArmDocRef): string {
    return `https://developer.arm.com/documentation/${ref.docId}/${ref.version}`;
}

/** The documentation-service endpoint that describes the document (JSON). */
export function armDocApiUrl(ref: ArmDocRef): string {
    return `https://documentation-service.arm.com/documentation/${ref.docId}/${ref.version}`;
}

export function armDocId(ref: ArmDocRef): string {
    return `arm/${ref.docId}-${ref.version}`;
}

/** `arm/ddi0553-latest`, `ddi0553-bz`, `ddi0553`, `DDI0553` → the reference; anything else → undefined. */
export function parseArmDocId(id: string): ArmDocRef | undefined {
    const m = id.trim().match(/^(?:arm\/)?([a-z]{3}\d{4}|\d{6,7})(?:-([a-z0-9.]+))?$/i);
    if (!m) { return undefined; }
    return { docId: m[1].toLowerCase(), version: (m[2] ?? 'latest').toLowerCase() };
}

// ------------------------------------------------------------- catalogue

export type ArmArch = 'Armv6-M' | 'Armv7-M' | 'Armv8-M' | 'Armv8.1-M';
export type ArmDocKind = 'arch' | 'adi' | 'coresight' | 'etm' | 'trm' | 'npu' | 'gug';

export interface ArmDocEntry {
    docId: string;
    /** Version token to fetch; `latest` unless `latest` is the wrong edition (errata). */
    version: string;
    title: string;
    kind: ArmDocKind;
    /** Applies to these cores (pdsc `Dcore` spelling) … */
    cores?: string[];
    /** … or to every core of these architectures … */
    archs?: ArmArch[];
    /** … or to targets with one of these NPUs (`Ethos-U85`) … */
    npus?: string[];
    /** … or to every target. */
    all?: boolean;
    /**
     * What the service offered on `verified` — a hint; the resolver decides at
     * fetch time. Every entry had a PDF resource on 2026-08-27, including the
     * ones whose `contentFormat` is HTMLPDF.
     */
    format: 'pdf' | 'html';
    verified: string;
    note?: string;
}

const ARCHS: readonly ArmArch[] = ['Armv6-M', 'Armv7-M', 'Armv8-M', 'Armv8.1-M'];
const KINDS: readonly ArmDocKind[] = ['arch', 'adi', 'coresight', 'etm', 'trm', 'npu', 'gug'];
const FORMATS: readonly ArmDocEntry['format'][] = ['pdf', 'html'];

function isArch(value: string): value is ArmArch {
    return (ARCHS as readonly string[]).includes(value);
}

function isKind(value: string): value is ArmDocKind {
    return (KINDS as readonly string[]).includes(value);
}

/** One `docs` entry of `armDocs.json`, as TypeScript reads the file; `toEntry` narrows the enumerated fields. */
type RawDocEntry = typeof docs[number];

/** The entry with its `kind`, `format` and `archs` checked; a typo in the JSON fails here, at load. */
function toEntry(raw: RawDocEntry): ArmDocEntry {
    const { kind, format, archs, ...rest } = raw;
    if (!isKind(kind)) {
        throw new Error(`armDocs.json: ${raw.docId} has the unknown kind "${kind}"`);
    }
    if (!(FORMATS as readonly string[]).includes(format)) {
        throw new Error(`armDocs.json: ${raw.docId} has the unknown format "${format}"`);
    }
    const checkedArchs = archs?.map(a => {
        if (!isArch(a)) {
            throw new Error(`armDocs.json: ${raw.docId} names the unknown architecture "${a}"`);
        }
        return a;
    });
    return { ...rest, kind, format: format as ArmDocEntry['format'], ...(checkedArchs ? { archs: checkedArchs } : {}) };
}

/**
 * The Arm documents the debug/trace bring-up skills need: the `docs` of
 * `armDocs.json`, verified by hand against documentation-service.arm.com on
 * the date in `verified`. No script re-checks them against the service:
 * `src/test/armDocs.test.ts` checks, offline, only that every entry has a
 * unique id, a URL that parses back and a date. To re-check before a release,
 * open `armDocApiUrl()` of each entry (or `fetch_doc` it) and update
 * `verified` in the JSON.
 * Generic User Guides are listed so pdsc-linked books get a title, but
 * `armDocsFor` does not add them on its own.
 */
export const ARM_DOCS: ArmDocEntry[] = docs.map(toEntry);

/** `kindOrder` of `armDocs.json`: the listing rank of each kind. */
const KIND_ORDER: Record<ArmDocKind, number> = kindOrder;

/**
 * `knownNpus` of `armDocs.json`: the NPUs of Arm's own subsystems, whose
 * packs declare only the Cortex core (Corstone-300/310 carry an Ethos-U55,
 * Corstone-315 an Ethos-U65, Corstone-320 an Ethos-U85), each as a
 * case-insensitive pattern over the device name.
 */
const KNOWN_NPUS: { pattern: RegExp; npu: string }[] = knownNpus.map(k => ({ pattern: new RegExp(k.pattern, 'i'), npu: k.npu }));

/** `coreArch` of `armDocs.json`: lower-case core name → architecture. */
const CORE_ARCH: Record<string, ArmArch | undefined> = Object.fromEntries(
    Object.entries(coreArch).map(([core, arch]) => {
        if (!isArch(arch)) {
            throw new Error(`armDocs.json: core ${core} names the unknown architecture "${arch}"`);
        }
        return [core, arch];
    }),
);

/** `Ethos-U85`, `ETHOS U55`, `ethos-u65` → the canonical NPU name, else undefined. */
export function normalizeNpu(text: string): string | undefined {
    const m = text.match(/ethos[\s-]*u\s*(\d{2})/i);
    return m ? `Ethos-U${m[1]}` : undefined;
}

/** The NPU an Arm subsystem device is known to have when its pack says nothing. */
export function knownNpuOf(deviceName: string | undefined): string | undefined {
    if (!deviceName) { return undefined; }
    return KNOWN_NPUS.find(k => k.pattern.test(deviceName))?.npu;
}

/** Listing order of Arm documents: architecture first, then debug interface, CoreSight, trace, core. */
export function armKindOrder(kind: ArmDocKind | undefined): number {
    return kind ? KIND_ORDER[kind] : 6;
}

/** pdsc `Dcore` → its canonical spelling (`Cortex-M0+`, `Cortex-M33`, `ARMV8MML`). */
export function normalizeCore(dcore: string): string {
    const c = dcore.trim();
    const lower = c.toLowerCase();
    if (lower === 'cortex-m0plus') { return 'Cortex-M0+'; }
    const m = lower.match(/^cortex-m(\d+)(\+|p)?$/);
    if (m) { return `Cortex-M${m[1]}${m[2] ? (m[2] === '+' ? '+' : 'P') : ''}`; }
    return c;
}

export function archOf(core: string): ArmArch | undefined {
    return CORE_ARCH[normalizeCore(core).toLowerCase()];
}

/** The catalogue entries for these cores and NPUs, in a stable order (architecture, ADI, CoreSight, ETM, TRM, NPU). */
export function armDocsFor(cores: string[], npus: string[] = []): ArmDocEntry[] {
    const names = new Set(cores.map(c => normalizeCore(c).toLowerCase()));
    const archs = new Set(cores.map(archOf).filter((a): a is ArmArch => !!a));
    const npuNames = new Set(npus.map(n => normalizeNpu(n) ?? n).map(n => n.toLowerCase()));
    if (!names.size && !npuNames.size) { return []; }
    return ARM_DOCS
        .filter(e => e.kind !== 'gug')
        .filter(e => e.npus
            ? e.npus.some(n => npuNames.has(n.toLowerCase()))
            : names.size > 0 && (e.all || (e.cores ?? []).some(c => names.has(c.toLowerCase())) || (e.archs ?? []).some(a => archs.has(a))))
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** `ddi0553`, `arm/ddi0553-latest`, `DDI0553`, a developer.arm.com URL → the catalogue entry, when there is one. */
export function lookupArmDoc(text: string): ArmDocEntry | undefined {
    const ref = parseArmDocId(text) ?? parseArmDocUrl(text);
    if (!ref) { return undefined; }
    return ARM_DOCS.find(e => e.docId === ref.docId);
}

/** The catalogue's version for a document id (`b` for ddi0439), else `latest`. */
export function catalogueVersion(docId: string): string {
    return ARM_DOCS.find(e => e.docId === docId.toLowerCase())?.version ?? 'latest';
}
