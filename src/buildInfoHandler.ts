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
 * One method per build-info tool, each returning the text the agent sees —
 * the shape of `PackDocsHandler` and the CMSIS Developer Assistant's
 * `DebuggingHandler`. No `vscode` import: the host is injected. Parsed
 * images and maps are cached by path, size and mtime so a 90 MB debug
 * image is read once per build.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    BuildContext, BuildInfoHost, ElfInfo, ImageArtifacts, MapFile, MemoryRegion, SymbolHit, computeRegionUsage, findRegion, hex, inputSectionAt,
    looksLikeBuildLog, outputSectionAt, parseMapFile, prefixedLog, readBuildLog, readElf, regionsFor, renderArtifacts, renderDiagnostics,
    renderLayout, renderLookup, renderNoBuild, renderNoLog, renderUsage, resolveBuildContext, sectionAt, symbolAt, topSymbols, uncoveredRanges, usageRegions,
} from './core/buildInfo';

export interface BuildInfoHandlerOptions {
    /** Default per-call timeout. */
    timeoutMs: number;
    /** For workspace-relative paths in the output. */
    workspaceRoot?: () => string | undefined;
}

export interface BuildTargetArgs {
    /** Substring of the cbuild-run file name, target-type, image name or pname. */
    target?: string;
    timeoutMs?: number;
}

export interface UsageArgs extends BuildTargetArgs {
    /** Symbols and objects to list (default from settings). */
    top?: number;
    maxChars?: number;
}

export interface LookupArgs extends BuildTargetArgs {
    name?: string;
    /** Hex (`0x0800_1234`) or decimal. */
    address?: string;
}

export interface LayoutArgs extends BuildTargetArgs {
    top?: number;
    maxChars?: number;
}

export interface DiagnosticsArgs extends BuildTargetArgs {
    /** A log file to read instead of the newest one found by the settings' globs. */
    file?: string;
    limit?: number;
    maxChars?: number;
}

const TIMEOUT_NOTE = 'The parse continues in the background; call again in a few seconds.';
const MAX_MAP_BYTES = 128 * 1024 * 1024;

interface Cached<T> { key: string; value: T; /** ELF parsed with its symbol table. */ full?: boolean }

export class BuildInfoHandler {
    private callCounter = 0;
    private readonly elfCache = new Map<string, Cached<ElfInfo>>();
    private readonly mapCache = new Map<string, Cached<MapFile>>();

    constructor(private readonly host: BuildInfoHost, private readonly options: BuildInfoHandlerOptions) { }

    // ------------------------------------------------------------------ tools

    public handleListBuildArtifacts(args: BuildTargetArgs): Promise<string> {
        return this.run('list_build_artifacts', args, async (log) => {
            const ctx = await this.resolve(args, log);
            if ('error' in ctx) { return ctx.error; }
            const elfs = new Map<string, ElfInfo | { error: string }>();
            for (const im of ctx.images) {
                if (!im.elf.exists) { continue; }
                try {
                    elfs.set(im.elf.path, this.elf(im.elf.path, log, { skipSymbols: true }));
                } catch (e) {
                    elfs.set(im.elf.path, { error: e instanceof Error ? e.message : String(e) });
                }
            }
            const logs = await this.findLogs(ctx, log);
            let logInfo: { file: string; sizeBytes: number; mtimeMs: number; ok?: boolean; errors: number; warnings: number } | undefined;
            if (logs[0]) {
                try {
                    const s = readBuildLog(logs[0]);
                    logInfo = { file: s.file, sizeBytes: s.sizeBytes, mtimeMs: s.mtimeMs, ok: s.ok, errors: s.errors, warnings: s.warnings };
                } catch (e) { log.warn(`cannot read ${logs[0]}: ${e}`); }
            }
            const built = ctx.images.some(i => i.elf.exists);
            if (!built && ctx.images.length) { return `${renderNoBuild(ctx, this.root())}${logInfo ? `\nNewest build log: ${logInfo.file} — ${logInfo.ok === false ? 'FAILED' : 'see get_build_diagnostics'}` : ''}`; }
            return renderArtifacts({ ctx, elfs, log: logInfo, logNote: `searched ${this.host.settings().logGlobs.join(', ')}; capture one with cbuild … --log out/build.log`, root: this.root() });
        });
    }

    public handleGetMemoryUsage(args: UsageArgs): Promise<string> {
        return this.run('get_memory_usage', args, async (log) => {
            const picked = await this.pickImage(args, log);
            if ('error' in picked) { return picked.error; }
            const { ctx, image } = picked;
            const elf = this.elf(image.elf.path, log);
            const map = this.map(image, log);
            const regions = regionsFor(ctx.memory, image.pname);
            const { regions: measured, source } = usageRegions(regions, map);
            const usage = computeRegionUsage(elf, measured);
            const top = this.top(args.top);
            const symbols = topSymbols(elf, top, { map, regions: measured });
            return renderUsage({
                ctx, image, elf, map, regions: usage, regionSource: source, uncovered: measured.length ? uncoveredRanges(elf, measured) : [],
                symbols, objects: map?.objectTotals ?? [], libraries: map?.libraryTotals ?? [], top, root: this.root(), maxChars: args.maxChars,
            });
        });
    }

    public handleLookupSymbol(args: LookupArgs): Promise<string> {
        return this.run('lookup_symbol', args, async (log) => {
            if (!args.name?.trim() && !args.address?.trim()) { return 'Pass name (a symbol, e.g. HAL_Init or a substring) or address (hex, e.g. 0x08001234).'; }
            const picked = await this.pickImage(args, log);
            if ('error' in picked) { return picked.error; }
            const { ctx, image } = picked;
            const elf = this.elf(image.elf.path, log);
            const map = this.map(image, log);
            const regions = regionsFor(ctx.memory, image.pname);
            const { regions: measured, source } = usageRegions(regions, map);
            const regionFile = source === 'map' ? map?.file : ctx.run.file;
            const hitFor = (s: ElfInfo['symbols'][number]): SymbolHit => {
                const at = map ? inputSectionAt(map, s.value) : undefined;
                return { symbol: s, object: at?.input.object, inputSection: at?.input.name, region: findRegion(measured, s.value)?.name };
            };
            if (args.address?.trim()) {
                const value = parseAddress(args.address);
                if (value === undefined) { return `address '${args.address}' is not a hex (0x…) or decimal number.`; }
                const found = symbolAt(elf.symbols, value);
                const section = sectionAt(elf.sections, value);
                return renderLookup({
                    ctx, image, elf, map, query: args.address, hits: [],
                    address: {
                        value, hit: found ? hitFor(found.symbol) : undefined, offset: found?.offset, exact: found?.exact, section: section?.name,
                        region: findRegion(measured, value), outputSection: map ? outputSectionAt(map, value) : undefined,
                    },
                    regionFile,
                    root: this.root(),
                });
            }
            const name = args.name!.trim();
            const defined = elf.symbols.filter(s => s.shndx !== 0);
            let hits = defined.filter(s => s.name === name);
            let matchKind: 'exact' | 'case-insensitive' | 'substring' = 'exact';
            if (!hits.length) {
                const lower = name.toLowerCase();
                hits = defined.filter(s => s.name.toLowerCase() === lower);
                matchKind = 'case-insensitive';
                if (!hits.length) {
                    hits = defined.filter(s => s.name.toLowerCase().includes(lower)).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name)).slice(0, 10);
                    matchKind = 'substring';
                }
            }
            log.debug(`'${name}': ${hits.length} ${matchKind} match(es) among ${defined.length} defined symbols`);
            return renderLookup({ ctx, image, elf, map, query: name, hits: hits.map(hitFor), matchKind, regionFile, root: this.root() });
        });
    }

    public handleGetSectionLayout(args: LayoutArgs): Promise<string> {
        return this.run('get_section_layout', args, async (log) => {
            const picked = await this.pickImage(args, log);
            if ('error' in picked) { return picked.error; }
            const { ctx, image } = picked;
            const elf = this.elf(image.elf.path, log, { skipSymbols: true });
            const map = this.map(image, log);
            const regions = usageRegions(regionsFor(ctx.memory, image.pname), map).regions;
            return renderLayout({ ctx, image, elf, map, regions, top: Math.min(Math.max(args.top ?? 5, 1), 10), root: this.root(), maxChars: args.maxChars });
        });
    }

    public handleGetBuildDiagnostics(args: DiagnosticsArgs): Promise<string> {
        return this.run('get_build_diagnostics', args, async (log) => {
            let ctxLine: string | undefined;
            let candidates: string[] = [];
            if (args.file?.trim()) {
                const file = path.isAbsolute(args.file) ? args.file : path.resolve(this.root() ?? process.cwd(), args.file);
                if (!fs.existsSync(file)) { return `Log file not found: ${file}`; }
                candidates = [file];
            } else {
                const ctx = await this.resolve(args, log);
                if (!('error' in ctx)) {
                    ctxLine = `Build: target ${ctx.run.targetType ?? '?'}${ctx.compiler ? `, compiler ${ctx.compiler}` : ''} — from ${this.rel(ctx.run.file)}`;
                    candidates = await this.findLogs(ctx, log);
                } else {
                    candidates = await this.findLogs(undefined, log);
                }
                if (!candidates.length) { return renderNoLog(this.host.settings().logGlobs, ctxLine); }
            }
            const summary = readBuildLog(candidates[0]);
            log.debug(`${path.basename(summary.file)}: ${summary.lines} lines, ${summary.errors} errors, ${summary.warnings} warnings, status '${summary.status ?? '-'}'`);
            const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
            return renderDiagnostics({ summary, limit, ctxLine, candidates, root: this.root(), maxChars: args.maxChars });
        });
    }

    // --------------------------------------------------------------- helpers

    private root(): string | undefined {
        return this.options.workspaceRoot?.() ?? this.host.workspaceFolders()[0];
    }

    private rel(p: string): string {
        const root = this.root();
        if (!root) { return p; }
        const r = path.relative(root, p);
        return r && !r.startsWith('..') ? r : p;
    }

    private top(requested?: number): number {
        const n = requested ?? this.host.settings().maxSymbols;
        return Math.min(Math.max(n, 1), 200);
    }

    private resolve(args: BuildTargetArgs, log: BuildInfoHost['log']): Promise<BuildContext | { error: string }> {
        return resolveBuildContext({ ...this.host, log }, { target: args.target });
    }

    /** The context and its single built image; several images need `target` to name one. */
    private async pickImage(args: BuildTargetArgs, log: BuildInfoHost['log']): Promise<{ ctx: BuildContext; image: ImageArtifacts } | { error: string }> {
        const ctx = await this.resolve(args, log);
        if ('error' in ctx) { return ctx; }
        const built = ctx.images.filter(i => i.elf.exists);
        if (!built.length) { return { error: renderNoBuild(ctx, this.root()) }; }
        if (built.length > 1) {
            return {
                error: `${built.length} images in ${path.basename(ctx.run.file)} — pass target with the image name or processor:\n  - ` +
                    built.map(i => `${i.name}${i.pname ? ` (${i.pname})` : ''}: ${this.rel(i.elf.path)}`).join('\n  - '),
            };
        }
        return { ctx, image: built[0] };
    }

    private elf(file: string, log: BuildInfoHost['log'], options: { skipSymbols?: boolean } = {}): ElfInfo {
        const st = fs.statSync(file);
        const key = `${st.size}:${st.mtimeMs}`;
        const cached = this.elfCache.get(file);
        // A symbol-less parse is enough for the artefact listing, but never serve it where symbols are wanted.
        if (cached && cached.key === key && (options.skipSymbols || cached.full)) { return cached.value; }
        const t0 = Date.now();
        const info = readElf(file, options);
        log.debug(`${path.basename(file)}: ${info.fileType} ${info.machine}${info.cpuName ? ` ${info.cpuName}` : ''}, ${info.sections.length} sections, ${info.segments.length} segments, ${info.symbols.length}/${info.symbolCount} symbols kept, ${Date.now() - t0} ms`);
        if (!cached || cached.key !== key || !options.skipSymbols) { this.elfCache.set(file, { key, value: info, full: !options.skipSymbols }); }
        return info;
    }

    private map(image: ImageArtifacts, log: BuildInfoHost['log']): MapFile | undefined {
        if (!image.map?.exists) { return undefined; }
        const file = image.map.path;
        const key = `${image.map.sizeBytes}:${image.map.mtimeMs}`;
        const cached = this.mapCache.get(file);
        if (cached && cached.key === key) { return cached.value; }
        if ((image.map.sizeBytes ?? 0) > MAX_MAP_BYTES) { log.warn(`${file} is larger than ${MAX_MAP_BYTES} bytes; not parsed`); return undefined; }
        const t0 = Date.now();
        const parsed = parseMapFile(fs.readFileSync(file, 'utf-8'), file);
        log.debug(`${path.basename(file)}: ${parsed.format}, ${parsed.regions.length} regions, ${parsed.sections.length} sections, ${parsed.symbols.length} symbols, ${parsed.objectTotals.length} objects, ${Date.now() - t0} ms${parsed.notes.length ? `; ${parsed.notes.join('; ')}` : ''}`);
        this.mapCache.set(file, { key, value: parsed });
        return parsed;
    }

    /** Candidate build logs, newest first; logs under the context's out/ folder come before workspace-wide ones. */
    private async findLogs(ctx: BuildContext | undefined, log: BuildInfoHost['log']): Promise<string[]> {
        const found = new Set<string>();
        for (const glob of this.host.settings().logGlobs) {
            try {
                for (const f of await this.host.findFiles(glob)) { found.add(f); }
            } catch (e) { log.warn(`findFiles(${glob}) failed: ${e}`); }
        }
        const outDir = ctx ? path.dirname(ctx.run.file) : undefined;
        const entries = [...found].map(f => {
            try {
                const st = fs.statSync(f);
                return { file: f, mtimeMs: st.mtimeMs, inOut: outDir ? f.startsWith(outDir + path.sep) : false };
            } catch { return undefined; }
        }).filter((e): e is { file: string; mtimeMs: number; inOut: boolean } => !!e && looksLikeBuildLog(e.file));
        entries.sort((a, b) => Number(b.inOut) - Number(a.inOut) || b.mtimeMs - a.mtimeMs);
        log.debug(`build logs: ${entries.length}${entries.length ? ' — ' + entries.slice(0, 5).map(e => path.basename(e.file)).join(', ') : ''}`);
        return entries.map(e => e.file);
    }

    /**
     * Timeout fence and trace for one tool call: logs the arguments, the
     * duration and the size of the result, and turns a timeout into a
     * message instead of a hung call.
     */
    private async run(tool: string, args: object, body: (log: BuildInfoHost['log'], deadline: number) => Promise<string>): Promise<string> {
        const n = ++this.callCounter;
        const log = prefixedLog(this.host.log, `[${tool} #${n}]`);
        const requested = (args as { timeoutMs?: number }).timeoutMs;
        const timeoutMs = requested ? Math.min(Math.max(requested, 100), 600_000) : this.options.timeoutMs;
        const started = Date.now();
        log.info(`→ ${JSON.stringify(args)}`);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<string>(resolve => {
            timer = setTimeout(() => resolve(`${tool} timed out after ${timeoutMs} ms. ${TIMEOUT_NOTE}`), timeoutMs);
        });
        try {
            const result = await Promise.race([body(log, started + timeoutMs), timeout]);
            const ms = Date.now() - started;
            log.info(`← ${ms} ms, ${Buffer.byteLength(result)} bytes`);
            log.debug(`result:\n${result.split('\n').slice(0, 30).map(l => '    ' + l).join('\n')}${result.split('\n').length > 30 ? '\n    …' : ''}`);
            return result;
        } catch (e) {
            log.error(`failed after ${Date.now() - started} ms`, e);
            return `${tool} failed: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
            if (timer) { clearTimeout(timer); }
        }
    }
}

/** `0x0800_1234`, `08001234h`, `08001234` (8 digits with a leading zero: hex), `134222388` (decimal) → number. */
export function parseAddress(text: string): number | undefined {
    const t = text.trim().replace(/_/g, '');
    if (/^0x[0-9a-f]+$/i.test(t)) { return parseInt(t, 16) >>> 0; }
    if (/^[0-9a-f]+h$/i.test(t)) { return parseInt(t.slice(0, -1), 16) >>> 0; }
    if (/^0\d{7}$/.test(t)) { return parseInt(t, 16) >>> 0; }
    if (/^\d+$/.test(t)) { return Number(t) >>> 0; }
    if (/^[0-9a-f]{5,8}$/i.test(t)) { return parseInt(t, 16) >>> 0; }
    return undefined;
}

export { hex, MemoryRegion };
