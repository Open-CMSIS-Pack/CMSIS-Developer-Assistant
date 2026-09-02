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
 * One method per tool, each returning the text the agent sees — the shape
 * of the CMSIS Developer Assistant's `DebuggingHandler`, so this file can
 * sit beside it after the merge. No `vscode` import: the host is injected.
 */

import * as fs from 'fs';
import * as path from 'path';
import { expandQuery } from './core/packDocs/queryExpansion';
import {
    ALL_ASPECTS, Aspect, CbuildRunInfo, Chapter, DocRef, FetchOutcome, LoadedDoc, PackDocsHost, PageStore, PdfExtractor, ResolveContext,
    SvdPeripheral, SvdRegister, TargetArgs, TargetDocs, TargetResolution, armDocId, armDocUrl, buildChapterIndex, buildDossier,
    catalogueVersion, collectTargetDocs, describeProcessors, describeResolution, fetchDocument, findPeripheral, formatPackId, groupOf,
    isReadable, loadSvd, lookupArmDoc, parseArmDocId, parseArmDocUrl, parseCbuildRun, parsePageRange, prefixedLog, registersOf,
    renderDocList, renderDossier, renderDossierMiss, renderFetch, renderFetchFailure, renderPages, renderSearch, resolveSvd,
    resolveTarget, searchLoaded, selectExtractor, shortHash, slug, sortDocs, loadCoreHeader, resolveCoreHeader, SvdSummary,
    loadCoreSvd, resolveCoreSvd,
    loadNpuHeader, npuBaseFromSvd, resolveNpuHeader,
    SvdRef, coreFromSvdCpu,
    ArmDocKind, Dossier, DossierMiss,
} from './core/packDocs';

/** The SVD a target is served with. */
export type DeviceSvd =
    | { kind: 'vendor'; rel: string; path: string; pname?: string; summary: SvdSummary }
    | { kind: 'core'; rel: string; path: string; source: string; why: string; summary: SvdSummary }
    | { kind: 'missing'; rel: string; path: string; why: string };

/** What `inspectTarget` reports for the debug panel. */
export interface TargetInspection {
    error?: string;
    resolution?: string;
    processors?: string;
    device?: string;
    devicePack?: string;
    board?: string;
    boardPack?: string;
    cores: string[];
    npus: string[];
    docs: DocRef[];
    workspaceDirs: string[];
    userDir?: string;
    userMatched?: string[];
    svd?: PeripheralSetInfo;
    /** The Arm core peripherals, from the shipped core SVD or the CMSIS-Core header. */
    core?: PeripheralSetInfo;
    /** How the core was chosen and looked up — shown when there is no core section. */
    coreDiag?: string;
    /** The Ethos-U NPU register map(s) from the driver pack's interface header. */
    npu?: PeripheralSetInfo;
}

/** An SVD or a CMSIS-Core header as the debug panel lists it. */
export interface PeripheralSetInfo {
    /** The pdsc `svd` path, or `core_cm33.h`. */
    rel: string;
    path: string;
    exists: boolean;
    pname?: string;
    /** `ARM::CMSIS@6.3.0` for a core header. */
    pack?: string;
    coreName?: string;
    device?: string;
    error?: string;
    diag?: string;
    peripherals: { name: string; group?: string; baseAddress: number; derivedFrom?: string; registers: number; interrupts: number }[];
}

export interface PackDocsHandlerOptions {
    /** Default per-call timeout. */
    timeoutMs: number;
    /** For workspace-relative paths in the resolution line. */
    workspaceRoot?: () => string | undefined;
    /** Tests inject an extractor; otherwise the settings pick one. */
    extractor?: PdfExtractor;
}

export interface ListArgs extends TargetArgs {
    includeUnlisted?: boolean;
    timeoutMs?: number;
}

export interface SearchArgs extends TargetArgs {
    query: string;
    doc?: string;
    limit?: number;
    /** Also search PDFs the pdsc does not attribute to the device/board (off: they are listed, not searched). */
    includeUnlisted?: boolean;
    timeoutMs?: number;
}

export interface ReadArgs extends TargetArgs {
    doc: string;
    pages: string;
    maxChars?: number;
    timeoutMs?: number;
}

export interface PeripheralArgs extends TargetArgs {
    /** Instance name from the SVD: USART1, TIM2, GPIOA. */
    peripheral: string;
    /** Subset of chapters | registers | clock | irq | errata (default all). */
    aspects?: string[];
    /** Restrict to one document (id or title substring). */
    doc?: string;
    /** Processor name on multi-core devices (picks the SVD). */
    pname?: string;
    maxRegisters?: number;
    maxChars?: number;
    timeoutMs?: number;
}

export interface FetchArgs extends TargetArgs {
    /** A document id from list_target_docs, or an Arm document id (`ddi0553`, `arm/ddi0553-latest`). */
    doc?: string;
    /** Alternatively a developer.arm.com/documentation URL or a direct PDF URL. */
    url?: string;
    /** Download again even when cached. */
    refresh?: boolean;
    timeoutMs?: number;
}

const TIMEOUT_NOTE = 'The work continues in the background; call again in a few seconds to pick up the result from the cache.';

export class PackDocsHandler {
    private readonly store: PageStore;
    private extractor: PdfExtractor;
    /** Documents seen by the last list/search, so read_doc_pages can take an id alone. */
    private readonly knownDocs = new Map<string, DocRef>();
    private readonly chapterCache = new Map<string, Chapter[]>();
    private callCounter = 0;

    constructor(private readonly host: PackDocsHost, private readonly options: PackDocsHandlerOptions) {
        this.store = new PageStore(host.storageDir, host.log);
        this.extractor = options.extractor ?? selectExtractor(host.settings());
    }

    /** Re-read extractor settings (path may have changed). */
    public refreshSettings(): void {
        if (!this.options.extractor) { this.extractor = selectExtractor(this.host.settings()); }
    }

    public getStore(): PageStore { return this.store; }

    /** Forget what was derived from the store — after the panel cleared it. */
    public dropCaches(): void { this.chapterCache.clear(); }
    public getExtractor(): PdfExtractor { return this.extractor; }

    // ------------------------------------------------------------------ tools

    public handleListTargetDocs(args: ListArgs): Promise<string> {
        return this.run('list_target_docs', args, async (log) => {
            const target = await this.resolve(args, log);
            if ('error' in target) { return target.error; }
            const { docs, notes, workspaceDirs, userDir, userMatched, processors, npus } = this.collect(this.hostWith(args), target);
            return renderDocList(this.describe(target), docs, notes, { workspaceDirs, userDir, userMatched, processors: describeProcessors(processors, npus) || undefined });
        });
    }

    public handleSearchTargetDocs(args: SearchArgs): Promise<string> {
        return this.run('search_target_docs', args, async (log, deadline) => {
            if (!args.query?.trim()) { return 'query is required.'; }
            const target = await this.resolve(args, log);
            if ('error' in target) { return target.error; }
            const { docs } = this.collect(this.hostWith(args), target);

            const local = docs.filter(isReadable);
            // Unlisted PDFs (in the pack, but not attributed to this device or board by
            // the pdsc) are searched only on request: a family pack like XMC4000_DFP
            // ships every sibling device's manual, and those would swamp the results.
            // Workspace and fetched PDFs were obtained on purpose and are always searched.
            const unlistedPack = (d: DocRef) => d.scope === 'unlisted' && d.source === 'pack';
            let candidates = args.includeUnlisted ? local : local.filter(d => !unlistedPack(d));
            const unlistedSkipped = args.includeUnlisted ? [] : local.filter(unlistedPack);
            if (args.doc) {
                const wanted = args.doc.toLowerCase();
                const matches = (d: DocRef) => d.id.toLowerCase() === wanted || d.id.toLowerCase().startsWith(wanted) ||
                    d.id.toLowerCase().includes(wanted) || d.title.toLowerCase().includes(wanted);
                // A doc filter reaches unlisted documents too.
                const narrowed = local.filter(matches);
                if (!narrowed.length) {
                    return `No document matches doc '${args.doc}'. Documents: ${local.map(d => d.id).join(', ') || 'none'}.`;
                }
                candidates = narrowed;
                unlistedSkipped.length = 0;
            }

            const { loaded, indexedNow, skipped } = await this.ensureAll(candidates, log, deadline);

            // Identifiers in the query (USART1, RCC_APB2ENR, GPIOAEN) are
            // expanded with their SVD descriptions at a lower weight, so the
            // manual's wording is found even when it never spells the name.
            let expansion = { expansions: {}, notes: [] as string[] };
            try {
                const dev = this.deviceSvd(target, log);
                expansion = expandQuery(args.query, dev && 'summary' in dev ? dev.summary : undefined);
                if (expansion.notes.length) { log.debug(`query expansion: ${expansion.notes.join('; ')}`); }
            } catch (e) {
                log.debug(`query expansion skipped: ${e instanceof Error ? e.message : e}`);
            }

            const limit = Math.min(Math.max(args.limit ?? 8, 1), 25);
            const outcome = searchLoaded(loaded, args.query, limit, log, { expansions: expansion.expansions });
            return renderSearch(args.query, outcome.hits, {
                resolution: this.describe(target),
                indexedNow,
                skipped,
                searched: loaded.map(l => l.doc),
                web: docs.filter(d => d.source === 'web' && !isReadable(d)),
                unlistedSkipped,
                expandedWith: expansion.notes,
                ms: outcome.ms,
            });
        });
    }

    public handleReadDocPages(args: ReadArgs): Promise<string> {
        return this.run('read_doc_pages', args, async (log, deadline) => {
            if (!args.doc) { return 'doc is required (an id from list_target_docs or search_target_docs).'; }
            if (!args.pages) { return "pages is required, e.g. '519' or '519-521'."; }
            let doc = this.findKnown(args.doc);
            if (!doc) {
                const target = await this.resolve(args, log);
                if ('error' in target) { return `Document '${args.doc}' is not known and the target could not be resolved: ${target.error}`; }
                this.collect(this.hostWith(args), target);
                doc = this.findKnown(args.doc);
            }
            if (!doc) { return `No document with id '${args.doc}'. Call list_target_docs for the ids.`; }
            if (doc.source === 'web') {
                this.store.annotate(doc);
                if (!isReadable(doc)) {
                    return doc.format === 'html'
                        ? `${doc.id} is published as HTML on arm.com and cannot be read in this version (${doc.url}).`
                        : `${doc.id} is not fetched yet — call fetch_doc { doc: '${doc.id}' } first (${doc.url}).`;
                }
            }
            if (doc.missing || doc.unsupported || !doc.path) { return `${doc.id} cannot be read: ${doc.missing ? 'missing on disk' : 'not a PDF'} (${doc.path}).`; }

            let loaded = this.store.load(doc);
            if (!loaded) {
                const available = await this.extractor.available();
                if (!available.ok) { return `${doc.id} is not indexed and cannot be extracted: ${available.detail}`; }
                loaded = await this.store.ensure(doc, this.extractor, { timeoutMs: deadline - Date.now(), log });
            }
            const range = parsePageRange(args.pages, loaded.meta.pageCount);
            if ('error' in range) { return range.error; }
            const all = loaded.pages();
            const records = range.pages.map(p => all[p - 1]).filter(Boolean);
            const maxChars = Math.min(Math.max(args.maxChars ?? 12_000, 500), 60_000);
            return renderPages(doc, records, maxChars);
        });
    }

    public handleFetchDoc(args: FetchArgs): Promise<string> {
        return this.run('fetch_doc', args, async (log, deadline) => {
            if (!args.doc && !args.url) {
                return 'Pass doc (an id from list_target_docs, or an Arm document id such as ddi0553) or url (developer.arm.com/documentation/… or a direct PDF link).';
            }
            let doc: DocRef | undefined;
            if (args.url) {
                const url = args.url.trim();
                const arm = parseArmDocUrl(url);
                if (arm) {
                    doc = this.findKnown(armDocId(arm)) ?? {
                        id: armDocId(arm), title: `Arm document ${arm.docId}`, scope: 'arm', source: 'web', url: armDocUrl(arm), arm, cached: false, indexed: false,
                    };
                } else if (/^https?:\/\//i.test(url)) {
                    const host = new URL(url).hostname;
                    doc = [...this.knownDocs.values()].find(d => d.url === url) ?? {
                        id: `web/${slug(host)}/${shortHash(url)}`, title: path.basename(new URL(url).pathname) || host, scope: 'unlisted', source: 'web', url, cached: false, indexed: false,
                    };
                } else {
                    return `url '${args.url}' is not an http(s) URL.`;
                }
            } else {
                doc = this.findKnown(args.doc!);
                if (!doc) {
                    const target = await this.resolve(args, log);
                    if (!('error' in target)) {
                        this.collect(this.hostWith(args), target);
                        doc = this.findKnown(args.doc!);
                    }
                }
                if (!doc) {
                    const arm = parseArmDocId(args.doc!);
                    if (arm) {
                        // A bare id takes the catalogue's version (ddi0439 → b, not the errata "latest").
                        if (!/-/.test(args.doc!.trim())) { arm.version = catalogueVersion(arm.docId); }
                        const entry = lookupArmDoc(arm.docId);
                        doc = {
                            id: armDocId(arm), title: entry?.title ?? `Arm document ${arm.docId}`, scope: 'arm', source: 'web', url: armDocUrl(arm), arm,
                            ...(entry ? { kind: entry.kind } : {}), cached: false, indexed: false,
                        };
                    }
                }
                if (!doc) { return `No document with id '${args.doc}'. Call list_target_docs for the ids, or pass an Arm document id (ddi0553) or a url.`; }
            }
            if (doc.source !== 'web') { return `${doc.id} is a local document (${doc.path ?? '?'}); it is searchable without fetching.`; }
            this.knownDocs.set(doc.id, doc);
            this.store.annotate(doc);

            const t0 = Date.now();
            let outcome: FetchOutcome | undefined;
            if (!doc.cached || args.refresh || doc.format === 'html') {
                outcome = await fetchDocument(doc, this.store, this.fetchContext(log, deadline));
                if (!outcome.ok) {
                    const dirs = this.host.settings().workspaceDocDirs;
                    return renderFetchFailure(doc, outcome, dirs[0]);
                }
            }
            const available = await this.extractor.available();
            if (!available.ok) { return `Fetched ${doc.id} to ${doc.path}, but it cannot be indexed: ${available.detail}`; }
            const loaded = await this.store.ensure(doc, this.extractor, { timeoutMs: deadline - Date.now(), log });
            return renderFetch(doc, outcome, loaded, Date.now() - t0);
        });
    }

    public handleGetPeripheralDocs(args: PeripheralArgs): Promise<string> {
        return this.run('get_peripheral_docs', args, async (log, deadline) => {
            if (!args.peripheral?.trim()) { return 'peripheral is required: an instance name from the SVD, e.g. USART1, TIM2, GPIOA, or a core peripheral such as SCB, SysTick, DWT.'; }
            const target = await this.resolve(args, log);
            if ('error' in target) { return target.error; }
            const notes: string[] = [];
            const dev = this.deviceSvd(target, log, args.pname);
            const svdRef = dev && dev.kind !== 'core' ? { rel: dev.rel } : undefined;
            let svd: SvdSummary | undefined;
            let deviceIsCore = false;
            if (dev?.kind === 'vendor') { svd = dev.summary; }
            else if (dev?.kind === 'core') { svd = dev.summary; deviceIsCore = true; notes.push(`${dev.why} — the core SVD ${dev.rel} is the device SVD`); }
            else if (dev?.kind === 'missing') { notes.push(dev.why); }
            else { notes.push(`the pdsc of ${target.devicePack ? formatPackId(target.devicePack) : 'the device pack'} names no <debug svd> for ${target.device?.name ?? 'the device'}, and no core SVD applies`); }

            const { docs } = this.collect(this.hostWith(args), target);
            let candidates = docs.filter(isReadable).filter(d => !(d.scope === 'unlisted' && d.source === 'pack'));
            if (args.doc) {
                const wanted = args.doc.toLowerCase();
                candidates = docs.filter(isReadable).filter(d => d.id.toLowerCase().includes(wanted) || d.title.toLowerCase().includes(wanted));
                if (!candidates.length) { return `No document matches doc '${args.doc}'.`; }
            }
            const { loaded, skipped } = await this.ensureAll(candidates, log, deadline);
            const dossierDocs = loaded.map(l => ({ loaded: l, chapters: this.chaptersOf(l, log) }));
            const aspects = (args.aspects ?? []).filter((a): a is Aspect => (ALL_ASPECTS as readonly string[]).includes(a));
            const opts = { aspects, maxRegisters: args.maxRegisters };

            // Vendor SVD first, then the Arm core peripherals, then the NPU register map.
            let result: Dossier | DossierMiss | undefined = svd ? buildDossier(args.peripheral, svd, dossierDocs, opts) : undefined;
            let source = deviceIsCore ? `${dev!.rel} (core SVD)` : svdRef?.rel ?? 'no vendor SVD';
            let armKinds: ArmDocKind[] | undefined = deviceIsCore && result && !('candidates' in result) ? ['arch', 'gug', 'trm'] : undefined;
            if (!result || 'candidates' in result) {
                const core = this.coreSummary(target, log);
                const npus = this.npuSummaries(target, log);
                if (core && findPeripheral(core, args.peripheral)) {
                    result = buildDossier(args.peripheral, core, dossierDocs, opts);
                    source = `${path.basename(core.file)} (Arm core peripherals${svdRef ? `; not in ${svdRef.rel}` : ''})`;
                    armKinds = ['arch', 'gug', 'trm'];
                } else {
                    const npu = npus.find(n => findPeripheral(n, args.peripheral));
                    if (npu) {
                        result = buildDossier(args.peripheral, npu, dossierDocs, opts);
                        source = `${path.basename(npu.file)} (Ethos-U driver header${svdRef ? `; not in ${svdRef.rel}` : ''})`;
                        armKinds = ['npu'];
                    } else {
                        const miss: DossierMiss = result ?? { candidates: [], groups: new Map() };
                        if (core) { miss.groups.set('Arm core peripherals', core.peripherals.filter(p => !p.derivedFrom)); }
                        if (npus.length) { miss.groups.set('NPU (Ethos-U driver)', npus.map(n => n.peripherals[0])); }
                        result = miss;
                    }
                }
            }
            const armDocs = armKinds ? docs.filter(d => d.arm && d.kind && armKinds!.includes(d.kind)) : undefined;
            const ctx = { target: this.describe(target), svdRel: source, maxChars: args.maxChars, skipped, notes, ...(armDocs?.length ? { armDocs } : {}) };
            if ('candidates' in result) { return renderDossierMiss(args.peripheral, result, ctx); }
            log.info(`${result.instance.name} (${source}): ${result.chapters.length} chapters, ${result.registerPages.filter(r => r.page).length}/${result.registerPages.length} register pages, ` +
                `${result.clock.length} clock bits, ${result.irqs.length} irqs, ${result.errata.length} errata hits in ${loaded.length} docs`);
            return renderDossier(result, ctx);
        });
    }

    // ------------------------------------------------------- inspection (debug panel)
    /**
     * The device's SVD: the vendor's from the pdsc when it is on disk; else the
     * shipped core SVD of the device's core (Arm's Cortex_DFP names none) — for
     * a bare core the core SVD simply is the device SVD.
     */
    private deviceSvd(target: TargetResolution, log: PackDocsHost['log'], pname?: string): DeviceSvd | undefined {
        const vendor = resolveSvd(this.host, target, pname);
        if (vendor?.exists) { return { kind: 'vendor', rel: vendor.rel, path: vendor.path, ...(vendor.pname ? { pname: vendor.pname } : {}), summary: loadSvd(vendor.path, log) }; }
        const t = collectTargetDocs({ ...this.host, log }, target);
        const coreName = this.chooseCore(t.processors, vendor, undefined).core;
        const why = vendor ? `device SVD ${vendor.rel} is not on disk` : `the pdsc of ${target.devicePack ? formatPackId(target.devicePack) : 'the device pack'} names no <debug svd> for ${target.device?.name ?? 'the device'}`;
        if (!coreName) { return vendor ? { kind: 'missing', rel: vendor.rel, path: vendor.path, why } : undefined; }
        const core = resolveCoreSvd(this.host.assetsDir, coreName);
        if (core?.exists) { return { kind: 'core', rel: core.file, path: core.path, source: core.source, why, summary: loadCoreSvd(core, log) }; }
        const header = resolveCoreHeader(this.host.packRoot, coreName);
        if (header?.exists) { return { kind: 'core', rel: header.file, path: header.path, source: header.pack, why, summary: loadCoreHeader(header, coreName, log) }; }
        return vendor ? { kind: 'missing', rel: vendor.rel, path: vendor.path, why } : undefined;
    }


    /** The cbuild-run contexts the host can see. */
    public async listContexts(): Promise<CbuildRunInfo[]> {
        const files = await this.host.findCbuildRunFiles();
        const out: CbuildRunInfo[] = [];
        for (const f of files) {
            try {
                out.push(parseCbuildRun(fs.readFileSync(f, 'utf-8'), f));
            } catch (e) {
                this.host.log.warn(`cannot read ${f}: ${e}`);
            }
        }
        return out;
    }

    /** Everything the tools would see for a target, without extracting: resolution, core, documents with cache state, the SVD, the core peripherals, the NPU. */
    public async inspectTarget(args: TargetArgs): Promise<TargetInspection> {
        const log = prefixedLog(this.host.log, '[inspect]');
        const target = await this.resolve(args, log);
        if ('error' in target) { return { error: target.error, cores: [], npus: [], docs: [], workspaceDirs: [] }; }
        const t = this.collect(this.host, target);
        const svdRef = resolveSvd(this.host, target);
        const dev = this.deviceSvd(target, log);
        let svd: PeripheralSetInfo | undefined;
        if (dev) {
            svd = { rel: dev.rel, path: dev.path, exists: dev.kind !== 'missing', ...(dev.kind === 'vendor' && dev.pname ? { pname: dev.pname } : {}), peripherals: [] };
            if (dev.kind === 'core') { svd.pack = dev.source; svd.diag = `core SVD — ${dev.why}`; }
            if (dev.kind === 'missing') { svd.error = dev.why; }
            if (dev.kind !== 'missing') {
                const summary = dev.summary;
                svd.device = summary.device;
                svd.peripherals = summary.peripherals.map(p => ({
                    name: p.name, group: groupOf(summary, p), baseAddress: p.baseAddress, derivedFrom: p.derivedFrom,
                    registers: registersOf(summary, p).length, interrupts: p.interrupts.length,
                }));
            }
        }
        let core: PeripheralSetInfo | undefined;
        const chosen = this.chooseCore(t.processors, svdRef, dev?.kind === 'vendor' ? dev.summary : undefined);
        const coreName = chosen.core;
        // The shipped core SVD (with the Arm ARM / TRM descriptions) first; the CMSIS-Core header of the installed pack otherwise.
        const coreSvd = coreName ? resolveCoreSvd(this.host.assetsDir, coreName) : undefined;
        const coreDiag = [
            `pdsc processors: ${t.processors.length ? describeProcessors(t.processors) : 'none (no <processor Dcore>)'}`,
            chosen.note,
            coreName ? `core ${coreName} → shipped SVD ${coreSvd ? `${coreSvd.file}${coreSvd.exists ? '' : ' (missing)'}` : 'none in index.json'}${this.host.assetsDir ? '' : ' (no assets directory)'}` : undefined,
        ].filter(Boolean).join('; ');
        const coreRef = coreName && !coreSvd?.exists ? resolveCoreHeader(this.host.packRoot, coreName) : undefined;
        if (dev?.kind === 'core') {
            core = undefined; // the SVD above is the core SVD
        } else if (coreSvd?.exists) {
            core = { rel: coreSvd.file, path: coreSvd.path, exists: true, pack: coreSvd.source, coreName, peripherals: [], diag: coreDiag };
        } else if (coreRef) {
            core = { rel: coreRef.file, path: coreRef.path, exists: coreRef.exists, pack: coreRef.pack, coreName, peripherals: [], diag: coreDiag };
        }
        if (core && core.exists) {
            try {
                const summary = coreSvd?.exists ? loadCoreSvd(coreSvd, log) : loadCoreHeader(coreRef!, coreName!, log);
                core.device = summary.device;
                core.peripherals = summary.peripherals.map(p => ({
                    name: p.name, group: p.groupName, baseAddress: p.baseAddress, derivedFrom: p.derivedFrom,
                    registers: registersOf(summary, p).length, interrupts: 0,
                }));
            } catch (e) {
                core.error = e instanceof Error ? e.message : String(e);
            }
        }
        let npu: PeripheralSetInfo | undefined;
        if (t.npus.length) {
            const refs = t.npus.map(n => resolveNpuHeader(this.host.packRoot, n)).filter((r): r is NonNullable<typeof r> => !!r);
            if (refs.length) {
                const first = refs[0];
                npu = { rel: refs.map(r => r.file).filter((f, i, a) => a.indexOf(f) === i).join(', '), path: first.path, exists: refs.every(r => r.exists), pack: first.pack, coreName: t.npus.join(', '), peripherals: [] };
                const svdSummary = svdRef?.exists ? loadSvd(svdRef.path, log) : undefined;
                for (const ref of refs) {
                    if (!ref.exists) { continue; }
                    try {
                        const summary = loadNpuHeader(ref, npuBaseFromSvd(svdSummary, ref.npu) ?? 0, log);
                        npu.device = (npu.device ? `${npu.device}, ` : '') + summary.device;
                        npu.peripherals.push(...summary.peripherals.map(p => ({ name: p.name, group: p.groupName, baseAddress: p.baseAddress, registers: p.registers.length, interrupts: 0 })));
                    } catch (e) {
                        npu.error = e instanceof Error ? e.message : String(e);
                    }
                }
            }
        }
        return {
            resolution: this.describe(target),
            processors: describeProcessors(t.processors, t.npus),
            device: target.device?.name,
            devicePack: target.devicePack ? formatPackId(target.devicePack) : undefined,
            board: target.board?.name,
            boardPack: target.boardPack ? formatPackId(target.boardPack) : undefined,
            cores: t.processors.map(p => p.core),
            npus: t.npus,
            docs: t.docs,
            workspaceDirs: t.workspaceDirs,
            userDir: t.userDir,
            userMatched: t.userMatched,
            svd,
            core,
            coreDiag: dev?.kind === 'core' ? `the SVD above is the core SVD (${dev.rel}); ${coreDiag}` : coreDiag,
            npu,
        };
    }

    /**
     * Which core the core-peripheral view is for: the pdsc processor that owns
     * the SVD (`Pname`) on multi-core devices, else the first processor, else
     * the vendor SVD's own `<cpu><name>`.
     */
    private chooseCore(processors: { pname?: string; core: string }[], svdRef: SvdRef | undefined, svd: SvdSummary | undefined): { core?: string; note?: string } {
        if (svdRef?.pname) {
            const match = processors.find(p => (p.pname ?? '').toLowerCase() === svdRef.pname!.toLowerCase());
            if (match) { return { core: match.core, note: `processor ${svdRef.pname} of the SVD` }; }
        }
        if (processors[0]) { return { core: processors[0].core, note: processors.length > 1 ? `first of ${processors.length} processors` : undefined }; }
        const fromCpu = coreFromSvdCpu(svd?.cpu?.name);
        if (fromCpu) { return { core: fromCpu, note: `core from the SVD's <cpu> ${svd!.cpu!.name}` }; }
        return { note: svd?.cpu ? `SVD <cpu> ${svd.cpu.name} not recognised` : 'no <cpu> in the SVD either' };
    }

    /** The core-peripheral summary of the target's core: the shipped core SVD, else the CMSIS-Core header of the installed pack. */
    private coreSummary(target: TargetResolution, log: PackDocsHost['log']): SvdSummary | undefined {
        const t = collectTargetDocs({ ...this.host, log }, target);
        const svdRef = resolveSvd(this.host, target);
        const coreName = this.chooseCore(t.processors, svdRef, svdRef?.exists ? loadSvd(svdRef.path, log) : undefined).core;
        if (!coreName) { return undefined; }
        const svd = resolveCoreSvd(this.host.assetsDir, coreName);
        if (svd?.exists) { return loadCoreSvd(svd, log); }
        const ref = resolveCoreHeader(this.host.packRoot, coreName);
        return ref?.exists ? loadCoreHeader(ref, coreName, log) : undefined;
    }

    /** One Arm core peripheral (SCB, NVIC, DWT …) of the target's core: registers with fields. */
    public async inspectCorePeripheral(args: TargetArgs, name: string): Promise<{ error: string } | { peripheral: SvdPeripheral; group?: string; registers: SvdRegister[] }> {
        const target = await this.resolve(args, this.host.log);
        if ('error' in target) { return { error: target.error }; }
        const summary = this.coreSummary(target, this.host.log);
        if (!summary) { return { error: 'no core peripherals for this target (unknown core, and the ARM::CMSIS pack is not installed)' }; }
        const peripheral = findPeripheral(summary, name);
        if (!peripheral) { return { error: `no core peripheral ${name}` }; }
        return { peripheral, group: groupOf(summary, peripheral), registers: registersOf(summary, peripheral) };
    }

    /** The NPU register maps of the target (one summary per NPU with a driver header). */
    private npuSummaries(target: TargetResolution, log: PackDocsHost['log']): SvdSummary[] {
        const t = collectTargetDocs({ ...this.host, log }, target);
        const svdRef = resolveSvd(this.host, target);
        const svdSummary = svdRef?.exists ? loadSvd(svdRef.path, log) : undefined;
        const out: SvdSummary[] = [];
        for (const n of t.npus) {
            const ref = resolveNpuHeader(this.host.packRoot, n);
            if (ref?.exists) { out.push(loadNpuHeader(ref, npuBaseFromSvd(svdSummary, ref.npu) ?? 0, log)); }
        }
        return out;
    }

    /** One NPU (`Ethos-U55`) of the target: the driver's register map with bitfields. */
    public async inspectNpuPeripheral(args: TargetArgs, name: string): Promise<{ error: string } | { peripheral: SvdPeripheral; group?: string; registers: SvdRegister[] }> {
        const target = await this.resolve(args, this.host.log);
        if ('error' in target) { return { error: target.error }; }
        const summaries = this.npuSummaries(target, this.host.log);
        if (!summaries.length) { return { error: 'no NPU driver header for this target (no NPU declared, or the ARM::ethos-u-core-driver pack is not installed)' }; }
        for (const summary of summaries) {
            const peripheral = findPeripheral(summary, name);
            if (peripheral) { return { peripheral, group: groupOf(summary, peripheral), registers: registersOf(summary, peripheral) }; }
        }
        return { error: `no NPU ${name}; the target has ${summaries.map(s => s.peripherals[0].name).join(', ')}` };
    }

    /** Extract + index one document that is already on disk (after an import). */
    public async indexDocument(doc: DocRef): Promise<LoadedDoc> {
        return this.store.ensure(doc, this.extractor, { timeoutMs: this.options.timeoutMs, log: prefixedLog(this.host.log, '[import]') });
    }

    /** One peripheral of the target's SVD: registers (through derivedFrom), fields, interrupts. */
    public async inspectPeripheral(args: TargetArgs, name: string): Promise<{ error: string } | { peripheral: SvdPeripheral; group?: string; registers: SvdRegister[] }> {
        const target = await this.resolve(args, this.host.log);
        if ('error' in target) { return { error: target.error }; }
        const dev = this.deviceSvd(target, this.host.log);
        if (!dev || dev.kind === 'missing') { return { error: dev ? dev.why : 'no SVD for this target' }; }
        const summary = dev.summary;
        const peripheral = findPeripheral(summary, name);
        if (!peripheral) { return { error: `no peripheral ${name}` }; }
        return { peripheral, group: groupOf(summary, peripheral), registers: registersOf(summary, peripheral) };
    }

    // --------------------------------------------------------------- helpers

    /** Extract + index the candidates that are not cached yet, within the deadline. */
    private async ensureAll(candidates: DocRef[], log: PackDocsHost['log'], deadline: number): Promise<{ loaded: LoadedDoc[]; indexedNow: { doc: DocRef; ms: number }[]; skipped: { doc: DocRef; reason: string }[] }> {
        const available = await this.extractor.available();
        if (!available.ok && candidates.some(d => !this.store.isCurrent(d))) {
            log.warn(`extractor unavailable: ${available.detail}`);
        }
        const maxBytes = this.host.settings().maxPdfMb * 1024 * 1024;
        const loaded: LoadedDoc[] = [];
        const indexedNow: { doc: DocRef; ms: number }[] = [];
        const skipped: { doc: DocRef; reason: string }[] = [];
        for (const d of candidates) {
            if (this.store.isCurrent(d)) {
                const l = this.store.load(d);
                if (l) { loaded.push(l); continue; }
            }
            if (!available.ok) { skipped.push({ doc: d, reason: `cannot extract — ${available.detail}` }); continue; }
            if ((d.sizeBytes ?? 0) > maxBytes) { skipped.push({ doc: d, reason: `${(d.sizeBytes! / 1024 / 1024).toFixed(0)} MB exceeds maxPdfMb ${this.host.settings().maxPdfMb}` }); continue; }
            const remaining = deadline - Date.now();
            if (remaining < 2000) { skipped.push({ doc: d, reason: 'not enough time left in this call; call again' }); continue; }
            const t0 = Date.now();
            try {
                const l = await this.store.ensure(d, this.extractor, { timeoutMs: remaining, log });
                loaded.push(l);
                indexedNow.push({ doc: d, ms: Date.now() - t0 });
            } catch (e) {
                log.error(`indexing ${d.id} failed`, e);
                skipped.push({ doc: d, reason: e instanceof Error ? e.message : String(e) });
            }
        }
        return { loaded, indexedNow, skipped };
    }

    /** The chapter index of a loaded document, built once per extraction. */
    private chaptersOf(l: LoadedDoc, log: PackDocsHost['log']): Chapter[] {
        const key = `${l.doc.id}#${l.meta.sha256}`;
        const hit = this.chapterCache.get(key);
        if (hit) { return hit; }
        const t0 = Date.now();
        const chapters = buildChapterIndex(l.pages());
        log.debug(`${l.doc.id}: ${chapters.length} chapters, ${chapters.reduce((n, c) => n + c.sections.length, 0)} sections in ${Date.now() - t0} ms`);
        this.chapterCache.set(key, chapters);
        while (this.chapterCache.size > 12) {
            const oldest = this.chapterCache.keys().next().value;
            if (oldest === undefined) { break; }
            this.chapterCache.delete(oldest);
        }
        return chapters;
    }

    /**
     * The target's documents plus every document fetched earlier (from the
     * store's fetch records), annotated with their cache state and remembered
     * for id lookups.
     */
    private collect(host: PackDocsHost, target: TargetResolution): TargetDocs {
        const t = collectTargetDocs(host, target);
        const ids = new Set(t.docs.map(d => d.id));
        const extra = this.store.listFetched().filter(d => !ids.has(d.id));
        if (extra.length) {
            host.log.debug(`fetched documents not in the target's set: ${extra.map(d => d.id).join(', ')}`);
            t.docs = sortDocs([...t.docs, ...extra]);
        }
        for (const d of t.docs) {
            if (d.source === 'web' || isReadable(d)) { this.store.annotate(d); }
            this.knownDocs.set(d.id, d);
        }
        return t;
    }

    private fetchContext(log: PackDocsHost['log'], deadline: number): ResolveContext {
        return {
            fetchFn: this.host.fetchFn ?? ((url, init) => fetch(url, init)),
            userAgent: this.host.userAgent,
            log,
            timeoutMs: Math.max(1000, deadline - Date.now()),
            maxBytes: this.host.settings().maxPdfMb * 1024 * 1024,
        };
    }

    /** Extract + index every local document of the target (the human command). */
    public async indexTarget(args: TargetArgs, progress?: (message: string) => void): Promise<string> {
        const log = this.host.log;
        const target = await this.resolve(args, log);
        if ('error' in target) { return target.error; }
        const { docs } = this.collect(this.host, target);
        const local = docs.filter(isReadable);
        const available = await this.extractor.available();
        if (!available.ok) { return `Cannot extract: ${available.detail}`; }
        const maxBytes = this.host.settings().maxPdfMb * 1024 * 1024;
        let done = 0, cached = 0, failed = 0;
        for (const d of local) {
            if ((d.sizeBytes ?? 0) > maxBytes) { continue; }
            progress?.(`${d.id} (${done + cached + 1}/${local.length})`);
            try {
                const before = this.store.isCurrent(d);
                await this.store.ensure(d, this.extractor, { timeoutMs: this.options.timeoutMs, log });
                if (before) { cached++; } else { done++; }
            } catch (e) {
                failed++;
                log.error(`indexing ${d.id} failed`, e);
            }
        }
        return `${this.describe(target)}\nIndexed ${done}, already cached ${cached}, failed ${failed} of ${local.length} documents.`;
    }

    private findKnown(id: string): DocRef | undefined {
        const exact = this.knownDocs.get(id);
        if (exact) { return exact; }
        const lower = id.toLowerCase();
        for (const [k, v] of this.knownDocs) {
            if (k.toLowerCase() === lower) { return v; }
        }
        for (const [k, v] of this.knownDocs) {
            if (k.toLowerCase().endsWith(`/${lower}`) || k.toLowerCase().includes(lower)) { return v; }
        }
        return undefined;
    }

    private resolve(args: TargetArgs, log: PackDocsHost['log']): Promise<TargetResolution | { error: string }> {
        return resolveTarget({ ...this.host, log }, args);
    }

    private describe(target: TargetResolution): string {
        return describeResolution(target, this.options.workspaceRoot?.());
    }

    private hostWith(args: ListArgs | SearchArgs | ReadArgs | FetchArgs | PeripheralArgs): PackDocsHost {
        const includeUnlisted = 'includeUnlisted' in args && args.includeUnlisted !== undefined ? args.includeUnlisted : undefined;
        if (includeUnlisted === undefined) { return this.host; }
        return { ...this.host, settings: () => ({ ...this.host.settings(), includeUnlisted }) };
    }

    /**
     * Timeout fence and trace for one tool call: logs the arguments, the
     * duration and the size of the result, and turns a timeout into a
     * message instead of a hung call.
     */
    private async run(tool: string, args: object, body: (log: PackDocsHost['log'], deadline: number) => Promise<string>): Promise<string> {
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
