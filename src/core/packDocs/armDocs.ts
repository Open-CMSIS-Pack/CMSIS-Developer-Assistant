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
 */

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

const V = '2026-08-27';

/**
 * The Arm documents the debug/trace bring-up skills need, verified against
 * documentation-service.arm.com on the date in `verified` (see
 * test/transport/arm-catalogue-check.js to re-check before a release).
 * Generic User Guides are listed so pdsc-linked books get a title, but
 * `armDocsFor` does not add them on its own.
 */
export const ARM_DOCS: ArmDocEntry[] = [
    { docId: 'ddi0419', version: 'latest', title: 'Armv6-M Architecture Reference Manual', kind: 'arch', archs: ['Armv6-M'], format: 'pdf', verified: V },
    { docId: 'ddi0403', version: 'latest', title: 'ARMv7-M Architecture Reference Manual', kind: 'arch', archs: ['Armv7-M'], format: 'pdf', verified: V },
    { docId: 'ddi0553', version: 'latest', title: 'Armv8-M Architecture Reference Manual', kind: 'arch', archs: ['Armv8-M', 'Armv8.1-M'], format: 'pdf', verified: V },
    { docId: 'ihi0031', version: 'latest', title: 'Arm Debug Interface Architecture Specification ADIv5.0 to ADIv5.2', kind: 'adi', all: true, format: 'pdf', verified: V },
    { docId: 'ihi0074', version: 'latest', title: 'Arm Debug Interface Architecture Specification ADIv6.0', kind: 'adi', all: true, format: 'pdf', verified: V },
    { docId: 'ihi0029', version: 'latest', title: 'Arm CoreSight Architecture Specification v3.0', kind: 'coresight', all: true, format: 'pdf', verified: V },
    { docId: 'ddi0314', version: 'latest', title: 'CoreSight Components Technical Reference Manual', kind: 'coresight', all: true, format: 'pdf', verified: V },
    { docId: 'ddi0480', version: 'latest', title: 'CoreSight SoC-400 Technical Reference Manual', kind: 'coresight', all: true, format: 'pdf', verified: V },
    { docId: '100806', version: 'latest', title: 'CoreSight SoC-600 Technical Reference Manual', kind: 'coresight', all: true, format: 'pdf', verified: V },
    { docId: 'ihi0014', version: 'latest', title: 'Embedded Trace Macrocell Architecture Specification (ETMv1.0 to ETMv3.5)', kind: 'etm', cores: ['Cortex-M3', 'Cortex-M4', 'SC300'], format: 'pdf', verified: V },
    { docId: 'ihi0064', version: 'latest', title: 'Embedded Trace Macrocell Architecture Specification ETMv4.0 to ETM4.6', kind: 'etm', cores: ['Cortex-M7'], archs: ['Armv8-M', 'Armv8.1-M'], format: 'pdf', verified: V },
    { docId: 'ddi0440', version: 'latest', title: 'CoreSight ETM-M4 Technical Reference Manual', kind: 'etm', cores: ['Cortex-M4'], format: 'pdf', verified: V },
    { docId: 'ddi0494', version: 'latest', title: 'CoreSight ETM-M7 Technical Reference Manual', kind: 'etm', cores: ['Cortex-M7'], format: 'pdf', verified: V },
    { docId: '100232', version: 'latest', title: 'CoreSight ETM-M33 Technical Reference Manual', kind: 'etm', cores: ['Cortex-M33'], format: 'pdf', verified: V },
    { docId: 'ddi0486', version: 'latest', title: 'CoreSight MTB-M0+ Technical Reference Manual', kind: 'etm', cores: ['Cortex-M0+'], format: 'pdf', verified: V },
    { docId: 'ddi0432', version: 'latest', title: 'Cortex-M0 Technical Reference Manual', kind: 'trm', cores: ['Cortex-M0'], format: 'pdf', verified: V },
    { docId: 'ddi0484', version: 'latest', title: 'Cortex-M0+ Technical Reference Manual', kind: 'trm', cores: ['Cortex-M0+'], format: 'pdf', verified: V },
    { docId: 'ddi0337', version: 'latest', title: 'Cortex-M3 Technical Reference Manual', kind: 'trm', cores: ['Cortex-M3'], format: 'pdf', verified: V },
    { docId: 'ddi0439', version: 'b', title: 'Cortex-M4 Technical Reference Manual', kind: 'trm', cores: ['Cortex-M4'], format: 'pdf', verified: V, note: 'latest is "DDI0439B Errata 01"; b is r0p0' },
    { docId: 'ddi0489', version: 'latest', title: 'Cortex-M7 Processor Technical Reference Manual', kind: 'trm', cores: ['Cortex-M7'], format: 'pdf', verified: V },
    { docId: 'ddi0550', version: 'latest', title: 'Cortex-M23 Processor Technical Reference Manual', kind: 'trm', cores: ['Cortex-M23'], format: 'pdf', verified: V },
    { docId: '100230', version: 'latest', title: 'Cortex-M33 Processor Technical Reference Manual', kind: 'trm', cores: ['Cortex-M33'], format: 'pdf', verified: V },
    { docId: '101051', version: 'latest', title: 'Cortex-M55 Processor Technical Reference Manual', kind: 'trm', cores: ['Cortex-M55'], format: 'pdf', verified: V },
    { docId: '101924', version: 'latest', title: 'Cortex-M85 Processor Technical Reference Manual', kind: 'trm', cores: ['Cortex-M85'], format: 'pdf', verified: V },
    { docId: '102776', version: 'latest', title: 'Arm China Cortex-M52 Processor Technical Reference Manual', kind: 'trm', cores: ['Cortex-M52'], format: 'pdf', verified: V },
    { docId: '102420', version: 'latest', title: 'Arm Ethos-U55 NPU Technical Reference Manual', kind: 'npu', npus: ['Ethos-U55'], format: 'pdf', verified: '2026-08-28' },
    { docId: '102023', version: 'latest', title: 'Arm Ethos-U65 NPU Technical Reference Manual', kind: 'npu', npus: ['Ethos-U65'], format: 'pdf', verified: '2026-08-28' },
    { docId: '102685', version: 'latest', title: 'Arm Ethos-U85 NPU Technical Reference Manual', kind: 'npu', npus: ['Ethos-U85'], format: 'pdf', verified: '2026-08-28' },
    { docId: '102684', version: 'latest', title: 'Arm Ethos-U85 NPU Technical Overview', kind: 'npu', npus: ['Ethos-U85'], format: 'pdf', verified: '2026-08-28' },
    { docId: 'dui1095', version: 'latest', title: 'Cortex-M23 Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M23'], format: 'pdf', verified: '2026-08-28' },
    { docId: 'dui0497', version: 'latest', title: 'Cortex-M0 Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M0'], format: 'pdf', verified: V },
    { docId: 'dui0662', version: 'latest', title: 'Cortex-M0+ Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M0+'], format: 'pdf', verified: V },
    { docId: 'dui0552', version: 'latest', title: 'Cortex-M3 Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M3'], format: 'pdf', verified: V },
    { docId: 'dui0553', version: 'latest', title: 'Cortex-M4 Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M4'], format: 'pdf', verified: V },
    { docId: 'dui0646', version: 'latest', title: 'Cortex-M7 Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M7'], format: 'pdf', verified: V },
    { docId: '100235', version: 'latest', title: 'Cortex-M33 Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M33'], format: 'pdf', verified: V },
    { docId: '101273', version: 'latest', title: 'Cortex-M55 Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M55'], format: 'pdf', verified: V },
    { docId: '101928', version: 'latest', title: 'Cortex-M85 Devices Generic User Guide', kind: 'gug', cores: ['Cortex-M85'], format: 'pdf', verified: V },
];

const KIND_ORDER: Record<ArmDocKind, number> = { arch: 0, adi: 1, coresight: 2, etm: 3, trm: 4, npu: 5, gug: 6 };

/**
 * NPUs of Arm's own subsystems, whose packs declare only the Cortex core:
 * Corstone-300/310 carry an Ethos-U55, Corstone-315 an Ethos-U65,
 * Corstone-320 an Ethos-U85.
 */
const KNOWN_NPUS: { pattern: RegExp; npu: string }[] = [
    { pattern: /^SSE-30[0-9]\b/i, npu: 'Ethos-U55' },
    { pattern: /^SSE-31[0-4]\b/i, npu: 'Ethos-U55' },
    { pattern: /^SSE-31[5-9]\b/i, npu: 'Ethos-U65' },
    { pattern: /^SSE-32[0-9]\b/i, npu: 'Ethos-U85' },
];

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

const CORE_ARCH: Record<string, ArmArch> = {
    'cortex-m0': 'Armv6-M', 'cortex-m0+': 'Armv6-M', 'cortex-m0plus': 'Armv6-M', 'cortex-m1': 'Armv6-M', 'sc000': 'Armv6-M',
    'cortex-m3': 'Armv7-M', 'cortex-m4': 'Armv7-M', 'cortex-m7': 'Armv7-M', 'sc300': 'Armv7-M',
    'cortex-m23': 'Armv8-M', 'cortex-m33': 'Armv8-M', 'cortex-m35p': 'Armv8-M', 'armv8mbl': 'Armv8-M', 'armv8mml': 'Armv8-M',
    'cortex-m52': 'Armv8.1-M', 'cortex-m55': 'Armv8.1-M', 'cortex-m85': 'Armv8.1-M', 'armv81mml': 'Armv8.1-M',
    'star-mc1': 'Armv8-M', 'star-mc3': 'Armv8.1-M',
};

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
