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
 * From "the current target" to the list of documents that belong to it.
 *
 * Resolution order mirrors the CMSIS Developer Assistant's SVD lookup:
 * explicit arguments first (`pack`, `device`, `board`, `cbuildRunFile`),
 * then the workspace's `out/**\/*.cbuild-run.yml` files, narrowed by `target`
 * when there are several.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    CbuildRunInfo, PackId, QualifiedName, formatPackId, packDir, parseCbuildRun, parsePackId, parseQualifiedName,
} from './cbuildRun';
import { PackDocsHost } from './host';
import { activeContextOf, describeActiveContext, matchesActiveContext } from './cbuildRun';
import { archOf, armDocsFor } from './armDocs';
import {
    DocRef, ProcessorInfo, SvdRef, armDocRef, collectBooks, collectNpus, collectProcessors, dedupeIds, findPdscFile, findSvd, loadPdsc, sortDocs, unlistedPdfs,
} from './pdscBooks';
import { collectUserDocs, resolveUserDocsDir } from './userDocs';
import { collectWorkspaceDocs } from './workspaceDocs';

export interface TargetArgs {
    /** Substring of the cbuild-run file name or target-type to pick one of several contexts. */
    target?: string;
    /** `Keil::STM32F7xx_DFP@3.0.0` — bypasses the cbuild-run lookup. */
    pack?: string;
    /** Device name (`STM32F756ZGTx`) when `pack` is given or to override the cbuild-run. */
    device?: string;
    board?: string;
    cbuildRunFile?: string;
}

export interface TargetResolution {
    device?: QualifiedName;
    devicePack?: PackId;
    board?: QualifiedName;
    boardPack?: PackId;
    cbuildRunFile?: string;
    notes: string[];
}

export type TargetResult = TargetResolution | { error: string };

function describeCbuildRun(info: CbuildRunInfo): string {
    return `${path.basename(info.file)} (${info.targetType ?? '?'}: ${info.device ? info.device.name : 'no device'}${info.devicePack ? ` / ${formatPackId(info.devicePack)}` : ''})`;
}

export async function resolveTarget(host: PackDocsHost, args: TargetArgs): Promise<TargetResult> {
    const log = host.log;
    const notes: string[] = [];

    if (args.pack) {
        const id = parsePackId(args.pack);
        if (!id) { return { error: `pack '${args.pack}' is not of the form Vendor::Name@version` }; }
        if (!id.version) {
            const picked = pickInstalledVersion(host.packRoot, id);
            if (!picked) { return { error: `pack ${formatPackId(id)} is not installed under ${host.packRoot}` }; }
            notes.push(`pack version not given; using installed ${picked}`);
            id.version = picked;
        }
        log.debug(`target from arguments: pack ${formatPackId(id)} device ${args.device ?? '-'} board ${args.board ?? '-'}`);
        return {
            devicePack: id,
            device: args.device ? parseQualifiedName(args.device) : undefined,
            board: args.board ? parseQualifiedName(args.board) : undefined,
            notes,
        };
    }

    let files: string[];
    if (args.cbuildRunFile) {
        if (!fs.existsSync(args.cbuildRunFile)) { return { error: `cbuild-run file not found: ${args.cbuildRunFile}` }; }
        files = [args.cbuildRunFile];
    } else {
        files = await host.findCbuildRunFiles();
        log.debug(`cbuild-run files in workspace: ${files.length}${files.length ? '\n  ' + files.join('\n  ') : ''}`);
    }
    if (!files.length) {
        return {
            error: 'No *.cbuild-run.yml found in the workspace. Build the solution (cbuild) so the target is ' +
                'known, or pass pack (Vendor::Name@version) and device explicitly.',
        };
    }

    const infos = files.map(f => {
        try {
            return parseCbuildRun(fs.readFileSync(f, 'utf-8'), f);
        } catch (e) {
            log.warn(`cannot read ${f}: ${e}`);
            return undefined;
        }
    }).filter((i): i is CbuildRunInfo => !!i && !!i.devicePack);

    if (!infos.length) { return { error: `None of the ${files.length} cbuild-run files names a device-pack.` }; }

    let chosen = infos;
    if (args.target) {
        const wanted = args.target.toLowerCase();
        chosen = infos.filter(i => path.basename(i.file).toLowerCase().includes(wanted) || (i.targetType ?? '').toLowerCase().includes(wanted));
        if (!chosen.length) {
            return { error: `No cbuild-run context matches target '${args.target}'. Contexts:\n  - ${infos.map(i => describeCbuildRun(i)).join('\n  - ')}` };
        }
    }
    if (chosen.length > 1) {
        // Several solutions in the workspace (a fixture next to the real
        // project, two boards): the CMSIS Solution panel's active context
        // decides when the host knows it, so the first call works without
        // `target` — the friction that sends agents to the web otherwise.
        let hintText = '';
        if (!args.target) {
            const hint = await activeContextOf(host);
            if (hint) {
                const preferred = chosen.filter(i => matchesActiveContext(i, hint));
                if (preferred.length) {
                    chosen = preferred;
                    notes.push(`active csolution context ${describeActiveContext(hint)}: using ${path.basename(chosen[0].file)}`);
                } else {
                    hintText = `Active csolution ${describeActiveContext(hint)} has no cbuild-run here (build it first?). `;
                }
            }
        }
        const distinct = new Set(chosen.map(i => `${formatPackId(i.devicePack!)}|${i.boardPack ? formatPackId(i.boardPack) : ''}|${i.device?.name}`));
        if (distinct.size > 1) {
            return {
                error: `${hintText}${chosen.length} cbuild-run contexts with different targets — pass target to pick one:\n  - ` +
                    chosen.map(i => describeCbuildRun(i)).join('\n  - '),
            };
        }
        notes.push(`${chosen.length} contexts share the same device and packs; using ${path.basename(chosen[0].file)}`);
    }
    const info = chosen[0];
    log.debug(`target from ${info.file}: device ${info.device?.name} pack ${formatPackId(info.devicePack!)}` +
        `${info.board ? ` board ${info.board.name}` : ''}${info.boardPack ? ` pack ${formatPackId(info.boardPack)}` : ''}`);
    return {
        device: args.device ? parseQualifiedName(args.device) : info.device,
        devicePack: info.devicePack,
        board: args.board ? parseQualifiedName(args.board) : info.board,
        boardPack: info.boardPack,
        cbuildRunFile: info.file,
        notes,
    };
}

function versionKey(v: string): (number | string)[] {
    return v.split(/[.-]/).map(p => (/^\d+$/.test(p) ? Number(p) : p));
}

function compareVersions(a: string, b: string): number {
    const ka = versionKey(a), kb = versionKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const x = ka[i], y = kb[i];
        if (x === undefined) { return -1; }
        if (y === undefined) { return 1; }
        if (typeof x === 'number' && typeof y === 'number') { if (x !== y) { return x - y; } }
        else if (String(x) !== String(y)) { return String(x) < String(y) ? -1 : 1; }
    }
    return 0;
}

/** Highest installed version of a pack, or undefined. */
export function pickInstalledVersion(packRoot: string, id: PackId): string | undefined {
    const dir = path.join(packRoot, id.vendor, id.name);
    if (!fs.existsSync(dir)) { return undefined; }
    const versions = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    if (!versions.length) { return undefined; }
    return versions.sort(compareVersions)[versions.length - 1];
}

/**
 * The pack directory for an id, falling back to the highest installed
 * version when the exact one is missing (the cbuild-run may predate a pack
 * update).
 */
export function locatePack(host: PackDocsHost, id: PackId, notes: string[]): { dir: string; id: PackId } | undefined {
    const exact = packDir(host.packRoot, id);
    if (exact && fs.existsSync(exact)) { return { dir: exact, id }; }
    const fallback = pickInstalledVersion(host.packRoot, id);
    if (!fallback) {
        notes.push(`pack ${formatPackId(id)} is not installed under ${host.packRoot}`);
        return undefined;
    }
    const alt = { ...id, version: fallback };
    notes.push(`pack ${formatPackId(id)} is not installed; using ${formatPackId(alt)}`);
    return { dir: packDir(host.packRoot, alt)!, id: alt };
}

export interface TargetDocs {
    docs: DocRef[];
    notes: string[];
    /** Workspace docs folders that exist (for the listing header). */
    workspaceDirs: string[];
    /** The user documents folder and the sub-folders that matched the target. */
    userDir: string;
    userMatched: string[];
    /** The device's processors (from the device pack's pdsc). */
    processors: ProcessorInfo[];
    /** The device's NPUs (`Ethos-U85`), from the pdsc features or the known Corstone configuration. */
    npus: string[];
}

/** `Cortex-M33 r0p0 (Armv8-M)`, or `cm33_core0: Cortex-M33 r1p0 (Armv8-M), cm33_core1: …`, with `· NPU Ethos-U85` when known. */
export function describeProcessors(processors: ProcessorInfo[], npus: string[] = []): string {
    const cores = processors.map(p => {
        const arch = archOf(p.core);
        return `${p.pname ? `${p.pname}: ` : ''}${p.core}${p.coreVersion ? ` ${p.coreVersion}` : ''}${arch ? ` (${arch})` : ''}`;
    }).join(', ');
    return npus.length ? `${cores || 'unknown core'} · NPU ${npus.join(', ')}` : cores;
}

/**
 * Every document that belongs to the resolved target — pack books, unlisted
 * pack PDFs, the Arm documents for its core, workspace PDFs — sorted and
 * with unique ids.
 */
export function collectTargetDocs(host: PackDocsHost, res: TargetResolution): TargetDocs {
    const log = host.log;
    const notes = [...res.notes];
    const docs: DocRef[] = [];
    const seenPaths = new Set<string>();
    const includeUnlisted = host.settings().includeUnlisted;
    const processors: ProcessorInfo[] = [];
    const npus: string[] = [];

    const visit = (id: PackId | undefined, query: { deviceName?: string; boardName?: string }, label: string) => {
        if (!id) { return; }
        const located = locatePack(host, id, notes);
        if (!located) { return; }
        const pdscPath = findPdscFile(located.dir, located.id);
        if (!pdscPath) {
            notes.push(`no .pdsc in ${located.dir}`);
            return;
        }
        const pdsc = loadPdsc(pdscPath, located.id, log);
        if (label === 'device-pack') {
            processors.push(...collectProcessors(pdsc, query.deviceName));
            npus.push(...collectNpus(pdsc, query.deviceName));
            if (processors.length || npus.length) { log.debug(`processors: ${describeProcessors(processors, npus)}`); }
        }
        const { docs: found, notes: n } = collectBooks(pdsc, query, log);
        notes.push(...n);
        for (const d of found) {
            if (d.path) {
                if (seenPaths.has(d.path)) { continue; }
                seenPaths.add(d.path);
            }
            docs.push(d);
        }
        if (includeUnlisted) {
            const extra = unlistedPdfs(pdsc, seenPaths);
            for (const d of extra) { seenPaths.add(d.path!); }
            if (extra.length) { log.debug(`${label}: ${extra.length} unlisted PDFs in ${located.dir}`); }
            docs.push(...extra);
        }
    };

    visit(res.devicePack, { deviceName: res.device?.name, boardName: res.board?.name }, 'device-pack');
    if (res.boardPack && (!res.devicePack || formatPackId(res.boardPack) !== formatPackId(res.devicePack))) {
        visit(res.boardPack, { boardName: res.board?.name }, 'board-pack');
    }

    // The Arm documents for the core, unless a pack already links them.
    const ids = new Set(docs.map(d => d.id));
    const arm = armDocsFor(processors.map(p => p.core), npus).map(armDocRef).filter(d => !ids.has(d.id));
    docs.push(...arm);

    const user = collectUserDocs(resolveUserDocsDir(host.settings().userDocsDir), {
        devicePack: res.devicePack, boardPack: res.boardPack, device: res.device?.name, board: res.board?.name, cores: processors.map(p => p.core),
    }, log);
    docs.push(...user.docs);
    notes.push(...user.notes);

    const ws = collectWorkspaceDocs(host);
    docs.push(...ws.docs);
    notes.push(...ws.notes);

    const sorted = dedupeIds(sortDocs(docs));
    log.info(`target docs: ${sorted.length} (${sorted.filter(d => d.source === 'pack').length} in packs, ` +
        `${sorted.filter(d => d.source === 'web' && d.scope !== 'arm').length} web, ${arm.length} Arm catalogue, ${user.docs.length} user, ${ws.docs.length} in the workspace)`);
    return { docs: sorted, notes, workspaceDirs: ws.dirs, userDir: user.root, userMatched: user.matched, processors, npus };
}

/** The device pack's SVD for the resolved target, if the pdsc names one. */
export function resolveSvd(host: PackDocsHost, res: TargetResolution, pname?: string): SvdRef | undefined {
    if (!res.devicePack) { return undefined; }
    const notes: string[] = [];
    const located = locatePack(host, res.devicePack, notes);
    if (!located) { return undefined; }
    const pdscPath = findPdscFile(located.dir, located.id);
    if (!pdscPath) { return undefined; }
    return findSvd(loadPdsc(pdscPath, located.id, host.log), res.device?.name, pname);
}

export function describeResolution(res: TargetResolution, root?: string): string {
    const parts: string[] = [];
    if (res.device) { parts.push(`device ${res.device.vendor ? `${res.device.vendor}::` : ''}${res.device.name}`); }
    if (res.devicePack) { parts.push(`device-pack ${formatPackId(res.devicePack)}`); }
    if (res.board) { parts.push(`board ${res.board.name}${res.board.revision ? `:${res.board.revision}` : ''}`); }
    if (res.boardPack) { parts.push(`board-pack ${formatPackId(res.boardPack)}`); }
    const from = res.cbuildRunFile ? ` — from ${root ? path.relative(root, res.cbuildRunFile) || res.cbuildRunFile : res.cbuildRunFile}` : ' — from arguments';
    return `Target: ${parts.join(', ') || 'unknown'}${from}`;
}
