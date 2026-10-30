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
 * then the cbuild-run file of the CMSIS Solution extension's active target
 * when the host can ask for it, then the workspace's `*.cbuild-run.yml`
 * files, narrowed by `target` when there are several.
 *
 * A pack is looked for first in the folder the extension names for the
 * active target's DFP or BSP, when that folder's PDSC is the pack; such a
 * folder may lie outside the pack root (a csolution `packs:` entry with
 * `path:`). Then under the pack root, where another installed version
 * stands in for a missing one and the notes say so.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    CbuildRunInfo, PackId, QualifiedName, formatPackId, packDir, parseCbuildRun, parsePackId, parseQualifiedName,
} from './cbuildRun';
import { PackDocsHost, PackDocsLog, effectivePackRoot } from './host';
import { activeContextOf, describeActiveContext, matchesActiveContext } from './cbuildRun';
import { archOf, armDocsFor } from './armDocs';
import {
    DocRef, ProcessorInfo, SvdRef, armDocRef, collectBooks, collectNpus, collectProcessors, dedupeIds, findPdscFile, findSvd, holdsPack, loadPdsc,
    sortDocs, unlistedPdfs,
} from './pdscBooks';
import { parseCbuildRunOutputs } from '../buildInfo/artifacts';
import { ActivePackFolders, packFolderCandidates } from '../solutionAnswers';
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
    /**
     * The pack root the resolution was made under: the CMSIS Solution
     * extension's answer when the host can ask it, else `host.packRoot`.
     * Every consumer reads this rather than the host, so a host copy taken
     * before the toolchain answered cannot send it to the wrong directory.
     */
    packRoot: string;
    /**
     * The folders the CMSIS Solution extension names for this target's
     * packs (`getDfpPath`, `getBspPath`) whose PDSC is the pack; `locatePack`
     * takes them before the pack root. Absent when the extension is not
     * asked, names none, or names a folder that holds another pack.
     */
    packDirs?: { devicePack?: string; boardPack?: string };
    notes: string[];
}

export type TargetResult = TargetResolution | { error: string };

function describeCbuildRun(info: CbuildRunInfo): string {
    return `${path.basename(info.file)} (${info.targetType ?? '?'}: ${info.device ? info.device.name : 'no device'}${info.devicePack ? ` / ${formatPackId(info.devicePack)}` : ''})`;
}

/** The cbuild-run files that name a device-pack, parsed. */
function readCbuildRuns(files: string[], log: PackDocsLog): CbuildRunInfo[] {
    return files.map(f => {
        try {
            return parseCbuildRun(fs.readFileSync(f, 'utf-8'), f);
        } catch (e) {
            log.warn(`cannot read ${f}: ${e}`);
            return undefined;
        }
    }).filter((i): i is CbuildRunInfo => !!i && !!i.devicePack);
}

/** The cbuild-run file of the extension's active target, when the host can ask and the file exists. Never throws. */
async function activeCbuildRun(host: PackDocsHost): Promise<string | undefined> {
    if (!host.activeCbuildRunFile) { return undefined; }
    try {
        const file = await host.activeCbuildRunFile();
        if (file && fs.existsSync(file)) { return file; }
        if (file) { host.log.debug(`the CMSIS Solution extension names ${file} as the active cbuild-run, which does not exist`); }
    } catch (e) {
        host.log.debug(`no active cbuild-run from the CMSIS Solution extension: ${e}`);
    }
    return undefined;
}

/** The DFP and BSP folders the extension answers for its active target. Never throws. */
async function answeredPackFolders(host: PackDocsHost): Promise<ActivePackFolders> {
    if (!host.activePackFolders) { return {}; }
    try {
        const answer = await host.activePackFolders();
        return {
            ...(typeof answer.dfp === 'string' && answer.dfp.length > 0 ? { dfp: answer.dfp } : {}),
            ...(typeof answer.bsp === 'string' && answer.bsp.length > 0 ? { bsp: answer.bsp } : {}),
        };
    } catch (e) {
        host.log.debug(`no pack folders from the CMSIS Solution extension: ${e}`);
        return {};
    }
}

/** The answered folders, `first` before the other: a pack is looked for in the folder answered for its kind first. */
function foldersOf(answer: ActivePackFolders, first: 'dfp' | 'bsp'): string[] {
    const ordered = first === 'dfp' ? [answer.dfp, answer.bsp] : [answer.bsp, answer.dfp];
    return [...new Set(ordered.filter((folder): folder is string => !!folder))];
}

/** Where the cbuild.yml files of a cbuild-run's target lie: next to each image it lists, then beside the cbuild-run itself. */
function cbuildFolders(cbuildRunFile: string): string[] {
    const own = path.dirname(cbuildRunFile);
    try {
        const outputs = parseCbuildRunOutputs(fs.readFileSync(cbuildRunFile, 'utf-8'), cbuildRunFile).outputs;
        return [...new Set([...outputs.map(output => path.dirname(output.file)), own])];
    } catch {
        return [own];
    }
}

/** The first folder the extension named that holds the pack `id`, by its PDSC. */
function namedPackDir(folders: string[], bases: string[], id: PackId): string | undefined {
    for (const folder of folders) {
        for (const candidate of packFolderCandidates(folder, bases)) {
            if (holdsPack(candidate, id)) { return candidate; }
        }
    }
    return undefined;
}

/**
 * Record on `res` the folders the extension names for its packs, each only
 * when its PDSC is the pack. A relative answer is resolved against the
 * folders of the cbuild.yml files, found from the active cbuild-run (asked
 * for only then) and the resolution's own.
 */
async function withPackDirs(host: PackDocsHost, res: TargetResolution, activeRun: () => Promise<string | undefined>): Promise<TargetResolution> {
    const answer = await answeredPackFolders(host);
    const folders = foldersOf(answer, 'dfp');
    if (!folders.length) { return res; }
    let bases: string[] = [];
    if (folders.some(folder => !path.isAbsolute(folder))) {
        const runs = [await activeRun(), res.cbuildRunFile].filter((file): file is string => !!file);
        bases = [...new Set(runs.flatMap(cbuildFolders))];
    }
    const devicePack = res.devicePack ? namedPackDir(folders, bases, res.devicePack) : undefined;
    const boardPack = res.boardPack ? namedPackDir(foldersOf(answer, 'bsp'), bases, res.boardPack) : undefined;
    if (devicePack || boardPack) {
        res.packDirs = { ...(devicePack ? { devicePack } : {}), ...(boardPack ? { boardPack } : {}) };
    }
    host.log.debug(`pack folders from the CMSIS Solution extension: ${folders.join(', ')}; `
        + `device-pack ${devicePack ?? 'not among them'}, board-pack ${res.boardPack ? boardPack ?? 'not among them' : '-'}`);
    return res;
}

export async function resolveTarget(host: PackDocsHost, args: TargetArgs): Promise<TargetResult> {
    // The CMSIS Solution extension's pack root when it is active, else the
    // host's; recorded on the resolution for every consumer.
    const packRoot = await effectivePackRoot(host);
    const log = host.log;
    const notes: string[] = [];
    // The extension's active cbuild-run, asked for at most once per resolution.
    let activeAnswer: Promise<string | undefined> | undefined;
    const activeRun = (): Promise<string | undefined> => (activeAnswer ??= activeCbuildRun(host));

    if (args.pack) {
        const id = parsePackId(args.pack);
        if (!id) { return { error: `pack '${args.pack}' is not of the form Vendor::Name@version` }; }
        if (!id.version) {
            const picked = pickInstalledVersion(packRoot, id);
            if (!picked) { return { error: `pack ${formatPackId(id)} is not installed under ${packRoot}` }; }
            notes.push(`pack version not given; using installed ${picked}`);
            id.version = picked;
        }
        log.debug(`target from arguments: pack ${formatPackId(id)} device ${args.device ?? '-'} board ${args.board ?? '-'}`);
        return withPackDirs(host, {
            devicePack: id,
            device: args.device ? parseQualifiedName(args.device) : undefined,
            board: args.board ? parseQualifiedName(args.board) : undefined,
            packRoot,
            notes,
        }, activeRun);
    }

    let files: string[];
    let infos: CbuildRunInfo[] = [];
    if (args.cbuildRunFile) {
        if (!fs.existsSync(args.cbuildRunFile)) { return { error: `cbuild-run file not found: ${args.cbuildRunFile}` }; }
        files = [args.cbuildRunFile];
    } else {
        // The extension knows which target is active: its cbuild-run decides
        // unless the call names a target. A file that names no device-pack
        // leaves the choice to the workspace scan.
        const active = args.target ? undefined : await activeRun();
        infos = active ? readCbuildRuns([active], log) : [];
        if (active && infos.length) {
            files = [active];
            log.debug(`cbuild-run of the CMSIS Solution extension's active target: ${active}`);
        } else {
            files = await host.findCbuildRunFiles();
            log.debug(`cbuild-run files in workspace: ${files.length}${files.length ? '\n  ' + files.join('\n  ') : ''}`);
        }
    }
    if (!files.length) {
        return {
            error: 'No *.cbuild-run.yml found in the workspace. Build the solution (cmsis_action build) so the target is ' +
                'known, or pass pack (Vendor::Name@version) and device explicitly.',
        };
    }

    if (!infos.length) { infos = readCbuildRuns(files, log); }

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
    return withPackDirs(host, {
        device: args.device ? parseQualifiedName(args.device) : info.device,
        devicePack: info.devicePack,
        board: args.board ? parseQualifiedName(args.board) : info.board,
        boardPack: info.boardPack,
        cbuildRunFile: info.file,
        packRoot,
        notes,
    }, activeRun);
}

/**
 * The active target's packs in the folders the CMSIS Solution extension
 * names for them, each checked against its PDSC: what the knowledge tools
 * read besides the pack root. Empty when the extension names no folder.
 * Never throws.
 */
export async function namedPackFolders(host: PackDocsHost): Promise<{ pack: PackId; dir: string }[]> {
    try {
        const answered = await answeredPackFolders(host);
        if (!foldersOf(answered, 'dfp').length) { return []; }
        // The folders are known now; the resolution need not ask for them again.
        const res = await resolveTarget({ ...host, activePackFolders: async () => answered }, {});
        if ('error' in res || !res.packDirs) { return []; }
        const found: { pack: PackId; dir: string }[] = [];
        if (res.devicePack && res.packDirs.devicePack) { found.push({ pack: res.devicePack, dir: res.packDirs.devicePack }); }
        if (res.boardPack && res.packDirs.boardPack) { found.push({ pack: res.boardPack, dir: res.packDirs.boardPack }); }
        return found;
    } catch (e) {
        host.log.debug(`no pack folders for the knowledge indexes: ${e}`);
        return [];
    }
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
 * The pack directory for an id: `named` when the CMSIS Solution extension
 * named a folder whose PDSC is the pack (`TargetResolution.packDirs`), else
 * the one under the pack root, falling back to the highest installed version
 * when the exact one is missing (the cbuild-run may predate a pack update).
 * The notes say when another version than the one asked for was taken.
 */
export function locatePack(packRoot: string, id: PackId, notes: string[], named?: string): { dir: string; id: PackId } | undefined {
    if (named) { return { dir: named, id }; }
    const exact = packDir(packRoot, id);
    if (exact && fs.existsSync(exact)) { return { dir: exact, id }; }
    const fallback = pickInstalledVersion(packRoot, id);
    if (!fallback) {
        notes.push(`pack ${formatPackId(id)} is not installed under ${packRoot}`);
        return undefined;
    }
    const alt = { ...id, version: fallback };
    notes.push(`pack ${formatPackId(id)} is not installed under ${packRoot}; using ${formatPackId(alt)}, another version than the one asked for`);
    return { dir: packDir(packRoot, alt)!, id: alt };
}

/** The folder the extension named for `id`, when it is one of the resolution's packs. */
export function namedDirOf(res: TargetResolution, id: PackId | undefined): string | undefined {
    if (!id || !res.packDirs) { return undefined; }
    const wanted = formatPackId(id);
    if (res.devicePack && formatPackId(res.devicePack) === wanted && res.packDirs.devicePack) { return res.packDirs.devicePack; }
    if (res.boardPack && formatPackId(res.boardPack) === wanted) { return res.packDirs.boardPack; }
    return undefined;
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
        const named = namedDirOf(res, id);
        const located = locatePack(res.packRoot, id, notes, named);
        if (!located) { return; }
        if (named && path.resolve(named) !== path.resolve(packDir(res.packRoot, id) ?? '')) {
            notes.push(`${label} ${formatPackId(id)} read from ${named}, the folder the CMSIS Solution extension names for it`);
        }
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
    const located = locatePack(res.packRoot, res.devicePack, notes, res.packDirs?.devicePack);
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
    const relRun = root && res.cbuildRunFile ? path.relative(root, res.cbuildRunFile).split(path.sep).join('/') : '';
    const from = res.cbuildRunFile ? ` — from ${relRun || res.cbuildRunFile}` : ' — from arguments';
    return `Target: ${parts.join(', ') || 'unknown'}${from}`;
}
