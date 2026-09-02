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
 * Where the build artefacts of a csolution target are. csolution writes
 * `out/<solution>+<target>.cbuild-run.yml` with an `output:` list (elf/hex
 * per project, paths relative to that file, `pname` on multi-core devices)
 * and `system-resources.memory` (the device's regions). The map file is not
 * in it: cbuild writes `<project>/<target>/<build>/<project>.<build>+<target>
 * .cbuild.yml` next to the image with `compiler:` and its own `output:`
 * list (elf, hex, bin, map, comp-db). Both are read with a line scanner
 * like `cbuildRun.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CbuildRunInfo, activeContextOf, describeActiveContext, matchesActiveContext, parseCbuildRun } from '../packDocs/cbuildRun';
import { BuildInfoHost } from './host';

export interface MemoryRegion {
    name: string;
    /** `rwxs`, `rxn` — r/w/x plus s(ecure)/n(on-secure). */
    access?: string;
    start: number;
    size: number;
    /** Name of the region this one aliases (secure/non-secure view). */
    alias?: string;
    default?: boolean;
    fromPack?: string;
    pname?: string;
}

export interface OutputEntry {
    /** Absolute path. */
    file: string;
    /** `elf`, `hex`, `bin`, `map`, `lib`, `comp-db`, … */
    type: string;
    load?: string;
    info?: string;
    pname?: string;
}

export interface CbuildRunOutputs {
    compiler?: string;
    outputs: OutputEntry[];
    memory: MemoryRegion[];
}

export interface CbuildContext {
    file: string;
    context?: string;
    compiler?: string;
    device?: string;
    processor?: string;
    outputs: OutputEntry[];
    linkerScript?: string;
}

export interface FileInfo {
    path: string;
    exists: boolean;
    sizeBytes?: number;
    mtimeMs?: number;
}

/** One linked image (one project of the solution) and what belongs to it. */
export interface ImageArtifacts {
    /** `Blinky` — the image base name. */
    name: string;
    pname?: string;
    context?: string;
    compiler?: string;
    elf: FileInfo;
    map?: FileInfo;
    hex?: FileInfo;
    bin?: FileInfo;
    cbuildYml?: string;
    linkerScript?: string;
    /** Hints when the map/log are missing. */
    notes: string[];
}

export interface BuildContext {
    run: CbuildRunInfo;
    compiler?: string;
    memory: MemoryRegion[];
    images: ImageArtifacts[];
    notes: string[];
}

export type BuildContextResult = BuildContext | { error: string };

function unquote(v: string): string {
    const t = v.trim();
    return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

function num(v: string | undefined): number {
    if (!v) { return 0; }
    const t = v.trim();
    return /^0x/i.test(t) ? parseInt(t, 16) >>> 0 : Number(t) >>> 0;
}

/**
 * A minimal scanner for the generated two-space YAML: returns the `- key: value`
 * items of a list under `<indent>key:`. Items are flat maps.
 */
function scanList(lines: string[], start: number, itemIndent: number): { items: Record<string, string>[]; end: number } {
    const items: Record<string, string>[] = [];
    let i = start;
    let current: Record<string, string> | undefined;
    for (; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw.trim() || raw.trim().startsWith('#')) { continue; }
        const indent = raw.length - raw.trimStart().length;
        if (indent < itemIndent) { break; }
        const item = raw.match(/^ *- ([a-zA-Z-]+):\s*(.*?)\s*$/);
        if (item && indent === itemIndent) {
            current = { [item[1]]: unquote(item[2]) };
            items.push(current);
            continue;
        }
        const kv = raw.match(/^ *([a-zA-Z-]+):\s*(.*?)\s*$/);
        if (kv && current && indent === itemIndent + 2) { current[kv[1]] = unquote(kv[2]); }
    }
    return { items, end: i };
}

/** The `compiler`, `output:` and `system-resources.memory` of a cbuild-run file; paths resolved against its directory. */
export function parseCbuildRunOutputs(content: string, file: string): CbuildRunOutputs {
    const lines = content.split('\n');
    const dir = path.dirname(file);
    const result: CbuildRunOutputs = { outputs: [], memory: [] };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/^ {2}([a-z-]+):\s*(.*?)\s*$/);
        if (!m) { continue; }
        if (m[1] === 'compiler') { result.compiler = unquote(m[2]); continue; }
        if (m[1] === 'output') {
            const { items, end } = scanList(lines, i + 1, 4);
            for (const it of items) {
                if (!it.file) { continue; }
                result.outputs.push({ file: path.resolve(dir, it.file), type: it.type ?? path.extname(it.file).slice(1), load: it.load, info: it.info, pname: it.pname });
            }
            i = end - 1;
            continue;
        }
        if (m[1] === 'system-resources') {
            for (let j = i + 1; j < lines.length; j++) {
                if (/^ {2}[a-z-]+:/.test(lines[j])) { i = j - 1; break; }
                if (/^ {4}memory:\s*$/.test(lines[j])) {
                    const { items, end } = scanList(lines, j + 1, 6);
                    for (const it of items) {
                        if (!it.name) { continue; }
                        result.memory.push({
                            name: it.name, access: it.access, start: num(it.start), size: num(it.size), alias: it.alias,
                            default: it.default === 'true' ? true : undefined, fromPack: it['from-pack'], pname: it.pname,
                        });
                    }
                    j = end - 1;
                }
            }
        }
    }
    return result;
}

/** `compiler`, `context`, `device`, `processor.*`, `output:` (resolved against `output-dirs.outdir`) and `linker.script` of a cbuild file. */
export function parseCbuildYml(content: string, file: string): CbuildContext {
    const lines = content.split('\n');
    const dir = path.dirname(file);
    const ctx: CbuildContext = { file, outputs: [] };
    let outdir = '.';
    const rawOutputs: Record<string, string>[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^ {2}([a-z-]+):\s*(.*?)\s*$/);
        if (!m) { continue; }
        switch (m[1]) {
            case 'compiler': ctx.compiler = unquote(m[2]); break;
            case 'context': ctx.context = unquote(m[2]); break;
            case 'device': ctx.device = unquote(m[2]); break;
            case 'output-dirs': {
                const od = lines.slice(i + 1, i + 6).find(l => /^ {4}outdir:/.test(l));
                if (od) { outdir = unquote(od.replace(/^ {4}outdir:/, '')); }
                break;
            }
            case 'processor': {
                const core = lines.slice(i + 1, i + 8).find(l => /^ {4}core:/.test(l));
                if (core) { ctx.processor = unquote(core.replace(/^ {4}core:/, '')); }
                break;
            }
            case 'output': {
                const { items, end } = scanList(lines, i + 1, 4);
                rawOutputs.push(...items);
                i = end - 1;
                break;
            }
            case 'linker': {
                const script = lines.slice(i + 1, i + 4).find(l => /^ {4}script:/.test(l));
                if (script) { ctx.linkerScript = path.resolve(dir, unquote(script.replace(/^ {4}script:/, ''))); }
                break;
            }
            default: break;
        }
    }
    for (const it of rawOutputs) {
        if (!it.file) { continue; }
        ctx.outputs.push({ file: path.resolve(dir, outdir, it.file), type: it.type ?? path.extname(it.file).slice(1) });
    }
    return ctx;
}

export function fileInfo(p: string): FileInfo {
    try {
        const st = fs.statSync(p);
        return { path: p, exists: st.isFile(), sizeBytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
        return { path: p, exists: false };
    }
}

function firstExisting(candidates: string[]): FileInfo | undefined {
    for (const c of candidates) {
        const fi = fileInfo(c);
        if (fi.exists) { return fi; }
    }
    return undefined;
}

/** The image's siblings: the cbuild.yml in its folder names the map/hex/bin; otherwise conventional names next to the elf. */
export function collectImage(elfEntry: OutputEntry, log: BuildInfoHost['log']): ImageArtifacts {
    const elf = fileInfo(elfEntry.file);
    const dir = path.dirname(elfEntry.file);
    const stem = path.basename(elfEntry.file).replace(/\.(elf|axf)$/i, '');
    const image: ImageArtifacts = { name: stem, pname: elfEntry.pname, elf, notes: [] };
    let cbuild: CbuildContext | undefined;
    try {
        const ymls = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.cbuild.yml')) : [];
        const preferred = ymls.find(f => f.startsWith(`${stem}.`)) ?? ymls[0];
        if (preferred) {
            cbuild = parseCbuildYml(fs.readFileSync(path.join(dir, preferred), 'utf-8'), path.join(dir, preferred));
            image.cbuildYml = cbuild.file;
            image.context = cbuild.context;
            image.compiler = cbuild.compiler;
            image.linkerScript = cbuild.linkerScript;
        }
    } catch (e) {
        log.warn(`cannot read the cbuild.yml next to ${elfEntry.file}: ${e}`);
    }
    const byType = (t: string) => cbuild?.outputs.find(o => o.type === t)?.file;
    image.map = firstExisting([byType('map'), `${elfEntry.file}.map`, path.join(dir, `${stem}.map`), path.join(dir, `${stem}.elf.map`), path.join(dir, `${stem}.axf.map`)].filter((p): p is string => !!p));
    image.hex = firstExisting([byType('hex'), path.join(dir, `${stem}.hex`)].filter((p): p is string => !!p));
    image.bin = firstExisting([byType('bin'), path.join(dir, `${stem}.bin`)].filter((p): p is string => !!p));
    if (!image.map) {
        const declared = byType('map');
        image.notes.push(declared
            ? `map ${path.basename(declared)} is declared in ${path.basename(cbuild!.file)} but missing — rebuild`
            : `no map file — add \`map: on\` (csolution output: { type: map }) or a linker map option to the project and rebuild`);
    }
    return image;
}

function describeRun(run: CbuildRunInfo, extra?: CbuildRunOutputs): string {
    const images = extra?.outputs.filter(o => o.type === 'elf').map(o => path.basename(o.file)).join(', ');
    return `${path.basename(run.file)} (${run.targetType ?? '?'}: ${run.device?.name ?? 'no device'}${extra?.compiler ? `, ${extra.compiler}` : ''}${images ? `; ${images}` : ''})`;
}

export interface BuildContextArgs {
    /** Substring of the cbuild-run file name, target-type, image name or pname. */
    target?: string;
}

/** The cbuild hint for "nothing built yet". */
export function buildHint(workspaceFolders: string[]): string {
    let solution: string | undefined;
    for (const ws of workspaceFolders) {
        try {
            solution = fs.readdirSync(ws).find(f => f.endsWith('.csolution.yml'));
            if (solution) { break; }
        } catch { /* unreadable folder */ }
    }
    return `Build first: \`cbuild ${solution ?? '<name>.csolution.yml'} --packs --update-rte\` (or the CMSIS Solution view's Build button); ` +
        'the build writes out/<solution>+<target>.cbuild-run.yml and the images.';
}

export async function resolveBuildContext(host: BuildInfoHost, args: BuildContextArgs): Promise<BuildContextResult> {
    const log = host.log;
    const files = await host.findFiles('**/*.cbuild-run.yml');
    log.debug(`cbuild-run files in workspace: ${files.length}${files.length ? '\n  ' + files.join('\n  ') : ''}`);
    if (!files.length) {
        return { error: `No *.cbuild-run.yml found in the workspace — no build output yet. ${buildHint(host.workspaceFolders())}` };
    }
    const runs = files.map(f => {
        try {
            const content = fs.readFileSync(f, 'utf-8');
            return { run: parseCbuildRun(content, f), extra: parseCbuildRunOutputs(content, f) };
        } catch (e) {
            log.warn(`cannot read ${f}: ${e}`);
            return undefined;
        }
    }).filter((r): r is { run: CbuildRunInfo; extra: CbuildRunOutputs } => !!r);

    let chosen = runs;
    let imageFilter: string | undefined;
    if (args.target) {
        const wanted = args.target.toLowerCase();
        const byRun = runs.filter(r => path.basename(r.run.file).toLowerCase().includes(wanted) || (r.run.targetType ?? '').toLowerCase().includes(wanted));
        if (byRun.length) {
            chosen = byRun;
        } else {
            const byImage = runs.filter(r => r.extra.outputs.some(o => o.type === 'elf' && (path.basename(o.file).toLowerCase().includes(wanted) || (o.pname ?? '').toLowerCase().includes(wanted))));
            if (!byImage.length) {
                return { error: `No cbuild-run context or image matches target '${args.target}'. Contexts:\n  - ${runs.map(r => describeRun(r.run, r.extra)).join('\n  - ')}` };
            }
            chosen = byImage;
            imageFilter = wanted;
        }
    }
    const notes: string[] = [];
    if (chosen.length > 1 && !args.target) {
        // The CMSIS Solution panel's active context picks one when the host
        // knows it (several solutions in the workspace); see targetDocs.ts.
        const hint = await activeContextOf(host);
        if (hint) {
            const preferred = chosen.filter(r => matchesActiveContext(r.run, hint));
            if (preferred.length === 1) {
                chosen = preferred;
                notes.push(`active csolution context ${describeActiveContext(hint)}: using ${path.basename(chosen[0].run.file)}`);
            } else if (preferred.length > 1) {
                chosen = preferred;
            }
        }
    }
    if (chosen.length > 1) {
        // Prefer the newest image set when the contexts differ.
        const newest = (r: { extra: CbuildRunOutputs }) => Math.max(0, ...r.extra.outputs.filter(o => o.type === 'elf').map(o => fileInfo(o.file).mtimeMs ?? 0));
        chosen = [...chosen].sort((a, b) => newest(b) - newest(a));
        return {
            error: `${chosen.length} cbuild-run contexts — pass target to pick one (newest first):\n  - ` +
                chosen.map(r => describeRun(r.run, r.extra)).join('\n  - '),
        };
    }
    const { run, extra } = chosen[0];
    let elfs = extra.outputs.filter(o => o.type === 'elf');
    if (imageFilter) {
        elfs = elfs.filter(o => path.basename(o.file).toLowerCase().includes(imageFilter!) || (o.pname ?? '').toLowerCase().includes(imageFilter!));
    }
    if (!elfs.length) { notes.push(`${path.basename(run.file)} lists no elf output`); }
    const images = elfs.map(e => collectImage(e, log));
    log.debug(`context ${path.basename(run.file)}: compiler ${extra.compiler ?? '?'}, ${images.length} image(s), ${extra.memory.length} memory region(s)`);
    for (const im of images) {
        log.debug(`  ${im.name}${im.pname ? ` [${im.pname}]` : ''}: elf ${im.elf.exists ? `${im.elf.sizeBytes} B` : 'missing'}, map ${im.map ? path.basename(im.map.path) : '-'}, hex ${im.hex ? 'yes' : '-'}, cbuild ${im.cbuildYml ? path.basename(im.cbuildYml) : '-'}`);
    }
    return { run, compiler: extra.compiler, memory: extra.memory, images, notes };
}

/** Regions of the context, for one processor when the device has several. */
export function regionsFor(memory: readonly MemoryRegion[], pname?: string): MemoryRegion[] {
    const mine = memory.filter(m => !m.pname || !pname || m.pname === pname);
    return mine.length ? mine : [...memory];
}
