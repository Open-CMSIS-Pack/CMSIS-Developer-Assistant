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
 * On-disk cache of extracted pages and their index:
 *
 *   <storageDir>/<vendor>/<pack>/<version>/<file slug>.pages.jsonl   {p, heading, text} per line
 *   <storageDir>/<vendor>/<pack>/<version>/<file slug>.meta.json     size, mtime, sha256, page count …
 *   <storageDir>/<vendor>/<pack>/<version>/<file slug>.idx.json      DocIndex
 *   <storageDir>/workspace/<folder hash>/<file slug>.*               workspace PDFs
 *   <storageDir>/user/<folder hash>/<file slug>.*                    user documents (NDA manuals etc.)
 *   <storageDir>/web/<id path>/doc.{pdf,pages.jsonl,meta.json,idx.json} + fetch.json   fetched web documents
 *
 * A document is re-extracted when its size or mtime changed. Concurrent
 * requests for the same document share one extraction. The store never
 * touches the network: web documents are downloaded by the handler first.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { lookupArmDoc, parseArmDocId } from './armDocs';
import { DocIndex, buildIndex } from './bm25Index';
import { detectHeading } from './headings';
import { PackDocsLog, silentLog } from './host';
import { DocRef, DocSource, slug } from './pdscBooks';
import { PdfExtractor } from './pdfExtract';

export interface PageRecord {
    /** 1-based page number (section ordinal for HTML documents). */
    p: number;
    heading: string;
    text: string;
}

export interface StoreMeta {
    /** 1: written by 0.1.x for pack documents; 2: adds source, title, unit, revision. */
    version: 1 | 2;
    docId: string;
    file: string;
    size: number;
    mtimeMs: number;
    sha256: string;
    pageCount: number;
    extractor: string;
    extractMs: number;
    createdAt: string;
    source?: DocSource;
    title?: string;
    unit?: 'page' | 'section';
    revision?: string;
    arm?: { docId: string; version: string; resolvedVersion?: string; versionLabel?: string };
    sourceUrl?: string;
}

/** What the store needs to know about pages that did not come from a PDF extractor. */
export interface PagesInfo {
    extractor: string;
    extractMs: number;
    unit?: 'page' | 'section';
}

/** One extracted document as the store sees it (debug listing). */
export interface CachedDoc {
    id: string;
    title: string;
    source: DocSource;
    unit: 'page' | 'section';
    revision?: string;
    pageCount: number;
    /** Size of the source file when extracted. */
    sizeBytes: number;
    /** Size of the sidecars (pages, index, meta). */
    storedBytes: number;
    createdAt: string;
    extractor: string;
    file: string;
    fileExists: boolean;
    dir: string;
    metaPath: string;
    pagesPath: string;
    indexPath: string;
    fetch?: FetchRecord;
}

/** Provenance of a fetched web document (`fetch.json` next to the download). */
export interface FetchRecord {
    version: 1;
    docId: string;
    sourceUrl: string;
    resolver: string;
    kind: 'pdf' | 'html';
    title: string;
    resolvedVersion?: string;
    versionLabel?: string;
    contentFormat?: string;
    filename?: string;
    downloadUrl: string;
    bytes: number;
    sha256: string;
    fetchedAt: string;
    userAgent: string;
}

export interface LoadedDoc {
    doc: DocRef;
    meta: StoreMeta;
    index: DocIndex;
    /** Loaded lazily; the whole document's pages. */
    pages: () => PageRecord[];
}

export interface Paths {
    dir: string;
    pages: string;
    meta: string;
    index: string;
    /** Web documents: the cached download and the record of where it came from. */
    download: string;
    fetchRecord: string;
}

function sha256File(file: string): string {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(file));
    return h.digest('hex');
}

/** 12 hex characters of sha1 — enough to keep two workspace folders apart. */
export function shortHash(text: string): string {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export class PageStore {
    private readonly inFlight = new Map<string, Promise<LoadedDoc>>();
    private readonly pageCache = new Map<string, PageRecord[]>();
    private readonly indexCache = new Map<string, DocIndex>();
    private readonly maxCached = 6;

    constructor(private readonly storageDir: string, private readonly log: PackDocsLog = silentLog) { }

    /** The storage directory (for diagnostics). */
    get dir(): string { return this.storageDir; }

    paths(doc: DocRef): Paths {
        let dir: string;
        let fileSlug: string;
        if (doc.source === 'pack' && doc.packId) {
            dir = path.join(this.storageDir, slug(doc.packId.vendor), slug(doc.packId.name), doc.packId.version ?? 'unversioned');
            fileSlug = slug(path.basename(doc.path ?? doc.id).replace(/\.pdf$/i, ''));
        } else if ((doc.source === 'workspace' || doc.source === 'user') && doc.path) {
            dir = path.join(this.storageDir, doc.source, shortHash(path.dirname(doc.path)));
            fileSlug = slug(path.basename(doc.path).replace(/\.pdf$/i, ''));
        } else {
            // Web documents: the id is the identity (arm/ddi0553-latest, web/<host>/<hash>).
            dir = path.join(this.storageDir, ...doc.id.split('/').map(s => slug(s)));
            fileSlug = 'doc';
        }
        return {
            dir,
            pages: path.join(dir, `${fileSlug}.pages.jsonl`),
            meta: path.join(dir, `${fileSlug}.meta.json`),
            index: path.join(dir, `${fileSlug}.idx.json`),
            download: path.join(dir, 'doc.pdf'),
            fetchRecord: path.join(dir, 'fetch.json'),
        };
    }

    readMeta(doc: DocRef): StoreMeta | undefined {
        const p = this.paths(doc);
        try {
            const meta = JSON.parse(fs.readFileSync(p.meta, 'utf-8')) as StoreMeta;
            return meta.version === 1 || meta.version === 2 ? meta : undefined;
        } catch {
            return undefined;
        }
    }

    /** Whether the cached extraction still matches the file on disk. */
    isCurrent(doc: DocRef, meta: StoreMeta | undefined = this.readMeta(doc)): boolean {
        if (!meta || !doc.path) { return false; }
        const p = this.paths(doc);
        if (!fs.existsSync(p.pages) || !fs.existsSync(p.index)) { return false; }
        try {
            const st = fs.statSync(doc.path);
            return st.size === meta.size && Math.floor(st.mtimeMs) === Math.floor(meta.mtimeMs);
        } catch {
            return false;
        }
    }

    /**
     * Every extracted document in the store, from its `.meta.json` sidecar —
     * for the debug panel and diagnostics, not for the tools (those start
     * from the target).
     */
    listCached(): CachedDoc[] {
        const out: CachedDoc[] = [];
        const walk = (dir: string, depth: number) => {
            if (depth > 6) { return; }
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walk(full, depth + 1); continue; }
                if (!e.isFile() || !e.name.endsWith('.meta.json')) { continue; }
                let meta: StoreMeta;
                try {
                    meta = JSON.parse(fs.readFileSync(full, 'utf-8')) as StoreMeta;
                } catch {
                    continue;
                }
                if (meta.version !== 1 && meta.version !== 2) { continue; }
                const base = full.slice(0, -'.meta.json'.length);
                let fetch: FetchRecord | undefined;
                try {
                    fetch = JSON.parse(fs.readFileSync(path.join(dir, 'fetch.json'), 'utf-8')) as FetchRecord;
                } catch {
                    fetch = undefined;
                }
                const pagesPath = `${base}.pages.jsonl`;
                let storedBytes = 0;
                for (const f of [pagesPath, `${base}.idx.json`, full]) {
                    try { storedBytes += fs.statSync(f).size; } catch { /* partial */ }
                }
                out.push({
                    id: meta.docId,
                    title: meta.title ?? fetch?.title ?? path.basename(base),
                    source: meta.source ?? (fetch ? 'web' : 'pack'),
                    unit: meta.unit ?? 'page',
                    ...(meta.revision ? { revision: meta.revision } : {}),
                    pageCount: meta.pageCount,
                    sizeBytes: meta.size,
                    storedBytes,
                    createdAt: meta.createdAt,
                    extractor: meta.extractor,
                    file: meta.file,
                    fileExists: fs.existsSync(meta.file),
                    dir,
                    metaPath: full,
                    pagesPath,
                    indexPath: `${base}.idx.json`,
                    ...(fetch ? { fetch } : {}),
                });
            }
        };
        walk(this.storageDir, 0);
        return out.sort((a, b) => a.id.localeCompare(b.id));
    }

    /** The pages of a cached document (from the debug listing). */
    readCachedPages(entry: CachedDoc): PageRecord[] {
        return fs.readFileSync(entry.pagesPath, 'utf-8').split('\n').filter(l => l.length).map(l => JSON.parse(l) as PageRecord);
    }

    readCachedIndex(entry: CachedDoc): DocIndex {
        return JSON.parse(fs.readFileSync(entry.indexPath, 'utf-8')) as DocIndex;
    }

    /**
     * Every web document that was fetched (or found to be HTML) — read from
     * the `fetch.json` records under `arm/` and `web/`, so fetched documents
     * outlive the session and join whatever target is current.
     */
    listFetched(): DocRef[] {
        const out: DocRef[] = [];
        const readDir = (dir: string): string[] => {
            try {
                return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
            } catch {
                return [];
            }
        };
        const dirs = [...readDir(path.join(this.storageDir, 'arm')), ...readDir(path.join(this.storageDir, 'web')).flatMap(readDir)];
        for (const dir of dirs) {
            let record: FetchRecord;
            try {
                record = JSON.parse(fs.readFileSync(path.join(dir, 'fetch.json'), 'utf-8')) as FetchRecord;
            } catch {
                continue;
            }
            if (record.version !== 1 || !record.docId) { continue; }
            const arm = parseArmDocId(record.docId);
            const entry = arm ? lookupArmDoc(arm.docId) : undefined;
            out.push({
                id: record.docId,
                title: record.title || record.docId,
                scope: arm ? 'arm' : 'unlisted',
                source: 'web',
                url: record.sourceUrl,
                ...(arm ? { arm: { ...arm, ...(record.resolvedVersion ? { resolvedVersion: record.resolvedVersion } : {}), ...(record.versionLabel ? { versionLabel: record.versionLabel } : {}) } } : {}),
                ...(entry ? { kind: entry.kind } : {}),
                ...(record.versionLabel ? { revision: record.versionLabel } : {}),
                format: record.kind,
                cached: false,
                indexed: false,
            });
        }
        return out;
    }

    /** The download record of a web document, when it was fetched. */
    readFetchRecord(doc: DocRef): FetchRecord | undefined {
        const p = this.paths(doc);
        try {
            const record = JSON.parse(fs.readFileSync(p.fetchRecord, 'utf-8')) as FetchRecord;
            return record.version === 1 ? record : undefined;
        } catch {
            return undefined;
        }
    }

    /** Fill `cached`, `indexed`, `pages` (and `revision`/`unit` when stored) on a DocRef without extracting. */
    annotate(doc: DocRef): DocRef {
        if (doc.source === 'web') {
            const record = this.readFetchRecord(doc);
            const p = this.paths(doc);
            if (record && record.kind === 'pdf' && fs.existsSync(p.download)) {
                doc.path = p.download;
                doc.cached = true;
                doc.format = 'pdf';
                doc.sizeBytes = record.bytes;
                if (record.versionLabel) { doc.revision = record.versionLabel; }
                if (record.title && doc.arm) { doc.title = record.title; }
            } else {
                doc.cached = false;
                doc.indexed = false;
                if (record?.kind === 'html') { doc.format = 'html'; }
                return doc;
            }
        }
        const meta = this.readMeta(doc);
        if (meta && this.isCurrent(doc, meta)) {
            doc.cached = true;
            doc.indexed = true;
            doc.pages = meta.pageCount;
            if (meta.revision && !doc.revision) { doc.revision = meta.revision; }
            if (meta.unit) { doc.unit = meta.unit; }
        } else {
            doc.indexed = false;
            if (doc.source !== 'web') { doc.cached = false; }
        }
        return doc;
    }

    /** Pages and index for a document, extracting and indexing on first use. */
    ensure(doc: DocRef, extractor: PdfExtractor, opts: { timeoutMs?: number; log?: PackDocsLog } = {}): Promise<LoadedDoc> {
        const key = doc.path ?? doc.id;
        const running = this.inFlight.get(key);
        if (running) {
            (opts.log ?? this.log).debug(`${doc.id}: extraction already in progress, joining`);
            return running;
        }
        const task = this.ensureNow(doc, extractor, opts).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, task);
        return task;
    }

    private async ensureNow(doc: DocRef, extractor: PdfExtractor, opts: { timeoutMs?: number; log?: PackDocsLog }): Promise<LoadedDoc> {
        const log = opts.log ?? this.log;
        if (!doc.path) { throw new Error(`${doc.id} is not a local document`); }
        const p = this.paths(doc);
        const meta = this.readMeta(doc);
        if (meta && this.isCurrent(doc, meta)) {
            log.debug(`${doc.id}: cache hit (${meta.pageCount} pages, extracted ${meta.createdAt})`);
            const index = this.loadIndex(doc, p);
            doc.cached = doc.indexed = true;
            doc.pages = meta.pageCount;
            if (meta.unit) { doc.unit = meta.unit; }
            return { doc, meta, index, pages: () => this.loadPages(doc, p) };
        }

        const st = fs.statSync(doc.path);
        log.info(`${doc.id}: extracting ${path.basename(doc.path)} (${(st.size / 1024 / 1024).toFixed(1)} MB) with ${extractor.name}`);
        const result = await extractor.extract(doc.path, { timeoutMs: opts.timeoutMs, log });
        const pages: PageRecord[] = result.pages.map((text, i) => ({ p: i + 1, heading: detectHeading(text), text }));
        return this.ensureFromPages(doc, pages, { extractor: result.extractor, extractMs: result.ms, unit: 'page' }, log);
    }

    /**
     * Index and persist pages that are already text — the tail of an
     * extraction, or sections fetched from an HTML document. `doc.path` is
     * the file whose size/mtime decide when the cache is stale.
     */
    ensureFromPages(doc: DocRef, pages: PageRecord[], info: PagesInfo, log: PackDocsLog = this.log): LoadedDoc {
        if (!doc.path) { throw new Error(`${doc.id} has no file to key the cache on`); }
        const p = this.paths(doc);
        const st = fs.statSync(doc.path);
        const t0 = Date.now();
        const index = buildIndex(doc.id, pages.map(r => r.text));
        const indexMs = Date.now() - t0;
        const t1 = Date.now();
        const newMeta: StoreMeta = {
            version: 2,
            docId: doc.id,
            file: doc.path,
            size: st.size,
            mtimeMs: st.mtimeMs,
            sha256: sha256File(doc.path),
            pageCount: pages.length,
            extractor: info.extractor,
            extractMs: info.extractMs,
            createdAt: new Date().toISOString(),
            source: doc.source,
            title: doc.title,
            unit: info.unit ?? doc.unit ?? 'page',
            ...(doc.revision ? { revision: doc.revision } : {}),
            ...(doc.arm ? { arm: { ...doc.arm } } : {}),
            ...(doc.url ? { sourceUrl: doc.url } : {}),
        };
        fs.mkdirSync(p.dir, { recursive: true });
        fs.writeFileSync(p.pages, pages.map(r => JSON.stringify(r)).join('\n') + '\n');
        fs.writeFileSync(p.index, JSON.stringify(index));
        fs.writeFileSync(p.meta, JSON.stringify(newMeta, null, 2));
        const tokens = Object.keys(index.postings).length;
        log.info(`${doc.id}: ${pages.length} ${newMeta.unit}s, ${tokens} distinct tokens — extract ${info.extractMs} ms, index ${indexMs} ms, write ${Date.now() - t1} ms → ${p.dir}`);
        this.remember(this.pageCache, doc.id, pages);
        this.remember(this.indexCache, doc.id, index);
        doc.cached = doc.indexed = true;
        doc.pages = pages.length;
        doc.unit = newMeta.unit;
        return { doc, meta: newMeta, index, pages: () => pages };
    }

    /** Pages of an already-extracted document, or undefined when not cached. */
    load(doc: DocRef): LoadedDoc | undefined {
        const meta = this.readMeta(doc);
        if (!meta || !this.isCurrent(doc, meta)) { return undefined; }
        const p = this.paths(doc);
        doc.cached = doc.indexed = true;
        doc.pages = meta.pageCount;
        if (meta.unit) { doc.unit = meta.unit; }
        return { doc, meta, index: this.loadIndex(doc, p), pages: () => this.loadPages(doc, p) };
    }

    private loadIndex(doc: DocRef, p: Paths): DocIndex {
        const hit = this.indexCache.get(doc.id);
        if (hit) { return hit; }
        const t0 = Date.now();
        const index = JSON.parse(fs.readFileSync(p.index, 'utf-8')) as DocIndex;
        this.log.debug(`${doc.id}: loaded index (${Object.keys(index.postings).length} tokens) in ${Date.now() - t0} ms`);
        this.remember(this.indexCache, doc.id, index);
        return index;
    }

    private loadPages(doc: DocRef, p: Paths): PageRecord[] {
        const hit = this.pageCache.get(doc.id);
        if (hit) { return hit; }
        const t0 = Date.now();
        const pages = fs.readFileSync(p.pages, 'utf-8').split('\n').filter(l => l.length).map(l => JSON.parse(l) as PageRecord);
        this.log.debug(`${doc.id}: loaded ${pages.length} pages in ${Date.now() - t0} ms`);
        this.remember(this.pageCache, doc.id, pages);
        return pages;
    }

    private remember<T>(cache: Map<string, T>, key: string, value: T): void {
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > this.maxCached) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) { break; }
            cache.delete(oldest);
        }
    }
}
