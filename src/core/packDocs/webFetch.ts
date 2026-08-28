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
 * Fetching web documents into the store — only ever on an explicit
 * `fetch_doc` call.
 *
 * arm.com: `developer.arm.com/documentation/<id>` is a JavaScript-only page,
 * which is what defeats agents; the service behind it is open. The
 * resolver reads `documentation-service.arm.com/documentation/<id>/<ver>`
 * (JSON: title, version, versionLabel, metadata.contentFormat,
 * _links.resources) and downloads the PDF resource. The `static/<objectId>`
 * links change over time, so they are used once and never stored as
 * identity. Documents without a PDF resource (`contentFormat` HTML or
 * HTMLPDF with SVG resources only) are reported as `html`.
 *
 * Other hosts: the URL must answer with a PDF (content type, or a body that
 * starts with `%PDF-`).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ArmDocRef, armDocApiUrl, parseArmDocUrl } from './armDocs';
import { PackDocsLog } from './host';
import { FetchRecord, PageStore } from './pageStore';
import { DocRef } from './pdscBooks';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResolveContext {
    fetchFn: FetchFn;
    userAgent: string;
    log: PackDocsLog;
    timeoutMs: number;
    /** Largest download accepted. */
    maxBytes: number;
}

export interface ResolvedDoc {
    kind: 'pdf' | 'html';
    /** The link to download (pdf). Transient — never persisted as identity. */
    downloadUrl?: string;
    filename?: string;
    title?: string;
    /** Version token the request resolved to (`bz` for `latest`). */
    version?: string;
    /** Human edition (`B.z`, `r1p2`). */
    versionLabel?: string;
    contentFormat?: string;
    /** html: the document JSON to walk for sections. */
    docJsonUrl?: string;
    /** Other editions worth knowing about (when `latest` is an errata document). */
    alternatives?: { version: string; versionLabel: string }[];
}

export type ResolveResult = ResolvedDoc | { error: string };

export interface DocResolver {
    name: string;
    matches(doc: DocRef): boolean;
    resolve(doc: DocRef, ctx: ResolveContext): Promise<ResolveResult>;
}

function headers(ctx: ResolveContext, accept: string, extra: Record<string, string> = {}): Record<string, string> {
    return { 'User-Agent': ctx.userAgent, 'Accept': accept, ...extra };
}

function signal(ctx: ResolveContext): AbortSignal {
    return AbortSignal.timeout(Math.max(100, ctx.timeoutMs));
}

function describeError(e: unknown): string {
    if (e instanceof Error) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') { return 'timed out'; }
        return e.message;
    }
    return String(e);
}

function stripQuery(url: string): string {
    const i = url.indexOf('?');
    return i >= 0 ? url.slice(0, i) : url;
}

// ------------------------------------------------------------------ arm.com

interface ArmResource { href?: string; name?: string; extension?: string; contentType?: string }
interface ArmDocJson {
    document?: string;
    version?: string;
    versionLabel?: string;
    title?: string;
    metadata?: { contentFormat?: string };
    _links?: { resources?: ArmResource[]; versions?: { href?: string }[] };
}
interface ArmVersion { version?: string; versionLabel?: string }

async function getJson<T>(url: string, ctx: ResolveContext): Promise<{ status: number; body?: T; error?: string }> {
    const t0 = Date.now();
    try {
        const res = await ctx.fetchFn(url, { headers: headers(ctx, 'application/json'), signal: signal(ctx), redirect: 'follow' });
        const text = await res.text();
        ctx.log.debug(`GET ${url} → ${res.status} ${res.headers.get('content-type') ?? ''} ${text.length} chars in ${Date.now() - t0} ms`);
        if (!res.ok) { return { status: res.status, error: `HTTP ${res.status}` }; }
        try {
            return { status: res.status, body: JSON.parse(text) as T };
        } catch {
            return { status: res.status, error: 'not JSON' };
        }
    } catch (e) {
        ctx.log.debug(`GET ${url} failed after ${Date.now() - t0} ms: ${describeError(e)}`);
        return { status: 0, error: describeError(e) };
    }
}

export const armResolver: DocResolver = {
    name: 'arm.com',
    matches: (doc) => !!doc.arm || (!!doc.url && !!parseArmDocUrl(doc.url)),
    async resolve(doc, ctx) {
        const ref: ArmDocRef | undefined = doc.arm ?? (doc.url ? parseArmDocUrl(doc.url) : undefined);
        if (!ref) { return { error: `${doc.id} is not an Arm document` }; }
        const url = armDocApiUrl(ref);
        const r = await getJson<ArmDocJson>(url, ctx);
        if (!r.body) {
            return {
                error: r.status === 404
                    ? `arm.com has no document ${ref.docId}/${ref.version} (${url}); check the id, or list its editions at https://documentation-service.arm.com/documentation/${ref.docId}/versions`
                    : `arm.com did not answer for ${ref.docId}/${ref.version}: ${r.error} (${url})`,
            };
        }
        const j = r.body;
        const resources = (j._links?.resources ?? []).filter(x => !!x.href);
        const pdfs = resources.filter(x => (x.extension ?? '').toLowerCase() === 'pdf' || (x.contentType ?? '').toLowerCase() === 'application/pdf');
        const preferred = pdfs.find(x => (x.name ?? '').toLowerCase().startsWith(ref.docId)) ?? pdfs[0];
        const base: ResolvedDoc = {
            kind: preferred ? 'pdf' : 'html',
            title: j.title?.trim() || undefined,
            version: j.version,
            versionLabel: j.versionLabel,
            contentFormat: j.metadata?.contentFormat,
        };
        if (preferred) {
            base.downloadUrl = stripQuery(preferred.href!);
            base.filename = preferred.name;
        } else {
            base.docJsonUrl = url;
        }
        if (/errata/i.test(base.title ?? '') && j._links?.versions?.[0]?.href) {
            const v = await getJson<ArmVersion[]>(j._links.versions[0].href, ctx);
            if (Array.isArray(v.body)) {
                base.alternatives = v.body
                    .filter(x => x.version && x.versionLabel && !/errata/i.test(x.versionLabel) && x.version !== j.version)
                    .map(x => ({ version: x.version!, versionLabel: x.versionLabel! }));
            }
        }
        ctx.log.info(`${doc.id}: arm.com ${ref.docId}/${ref.version} → ${j.version ?? '?'} (${j.versionLabel ?? '?'}), ${base.contentFormat ?? '?'}, ` +
            `${pdfs.length} pdf resource${pdfs.length === 1 ? '' : 's'}${preferred ? ` — ${preferred.name}` : ''}`);
        return base;
    },
};

// ------------------------------------------------------------- direct PDF

export const directPdfResolver: DocResolver = {
    name: 'direct',
    matches: (doc) => !!doc.url && /^https?:\/\//i.test(doc.url),
    async resolve(doc, ctx) {
        const url = doc.url!;
        const filename = path.basename(new URL(url).pathname) || 'document.pdf';
        const ok = (): ResolvedDoc => ({ kind: 'pdf', downloadUrl: url, filename, title: doc.title });
        const t0 = Date.now();
        try {
            const head = await ctx.fetchFn(url, { method: 'HEAD', headers: headers(ctx, 'application/pdf,*/*'), signal: signal(ctx), redirect: 'follow' });
            const type = (head.headers.get('content-type') ?? '').toLowerCase();
            const length = Number(head.headers.get('content-length') ?? 0);
            ctx.log.debug(`HEAD ${url} → ${head.status} ${type} ${length} in ${Date.now() - t0} ms`);
            if (head.ok && length > ctx.maxBytes) { return { error: `${url} is ${(length / 1024 / 1024).toFixed(0)} MB, above the maxPdfMb limit` }; }
            if (head.ok && type.includes('application/pdf')) { return ok(); }
            if (head.ok && type.includes('text/html')) { return { error: `${url} is a web page, not a PDF — open the link in a browser and download the PDF into the workspace docs folder` }; }
        } catch (e) {
            ctx.log.debug(`HEAD ${url} failed: ${describeError(e)}`);
        }
        // No usable HEAD: peek at the first bytes.
        try {
            const res = await ctx.fetchFn(url, { headers: headers(ctx, 'application/pdf,*/*', { Range: 'bytes=0-1023' }), signal: signal(ctx), redirect: 'follow' });
            if (!res.ok) { return { error: `${url} answered HTTP ${res.status}` }; }
            const type = (res.headers.get('content-type') ?? '').toLowerCase();
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.subarray(0, 5).toString('latin1') === '%PDF-') { return ok(); }
            if (type.includes('text/html') || buf.subarray(0, 512).toString('latin1').toLowerCase().includes('<html')) {
                return { error: `${url} is a web page, not a PDF — open the link in a browser and download the PDF into the workspace docs folder` };
            }
            return { error: `${url} is not a PDF (${type || 'unknown content type'})` };
        } catch (e) {
            return { error: `${url}: ${describeError(e)}` };
        }
    },
};

export const resolvers: DocResolver[] = [armResolver, directPdfResolver];

// ---------------------------------------------------------------- download

export interface Downloaded { bytes: number; sha256: string; ms: number }

/** Stream a PDF to `dest` (via `dest.part`), refusing non-PDF bodies and anything above `maxBytes`. */
export async function downloadPdf(url: string, dest: string, ctx: ResolveContext): Promise<Downloaded> {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(100, ctx.timeoutMs));
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let first = true;
    try {
        const res = await ctx.fetchFn(url, { headers: headers(ctx, 'application/pdf,*/*'), signal: controller.signal, redirect: 'follow' });
        if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
        const length = Number(res.headers.get('content-length') ?? 0);
        if (length > ctx.maxBytes) { throw new Error(`${(length / 1024 / 1024).toFixed(0)} MB is above the maxPdfMb limit`); }
        if (!res.body) { throw new Error('empty response'); }
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            if (first) {
                first = false;
                if (Buffer.from(chunk.subarray(0, 5)).toString('latin1') !== '%PDF-') {
                    throw new Error(`not a PDF (${res.headers.get('content-type') ?? 'unknown content type'})`);
                }
            }
            bytes += chunk.length;
            if (bytes > ctx.maxBytes) { throw new Error(`download exceeded the maxPdfMb limit`); }
            hash.update(chunk);
            if (!out.write(chunk)) { await new Promise<void>(resolve => out.once('drain', resolve)); }
        }
        if (bytes === 0) { throw new Error('empty response'); }
        await new Promise<void>((resolve, reject) => { out.on('error', reject); out.end(resolve); });
        fs.renameSync(part, dest);
        const ms = Date.now() - t0;
        ctx.log.info(`downloaded ${url} → ${dest} (${(bytes / 1024 / 1024).toFixed(1)} MB in ${ms} ms)`);
        return { bytes, sha256: hash.digest('hex'), ms };
    } catch (e) {
        controller.abort();
        out.destroy();
        try { fs.unlinkSync(part); } catch { /* nothing to clean */ }
        throw new Error(`download of ${url} failed: ${describeError(e)}`);
    } finally {
        clearTimeout(timer);
    }
}

// ------------------------------------------------------------ orchestration

export type FetchOutcome =
    | { ok: true; record: FetchRecord; resolved: ResolvedDoc; resolver: string }
    | { ok: false; error: string; resolved?: ResolvedDoc; resolver?: string };

/**
 * Resolve and download one web document into the store. On success the
 * DocRef points at the cached file (`path`, `cached`, `revision`, `format`)
 * and `fetch.json` records the provenance; the caller indexes it.
 */
export async function fetchDocument(doc: DocRef, store: PageStore, ctx: ResolveContext): Promise<FetchOutcome> {
    if (doc.source !== 'web') { return { ok: false, error: `${doc.id} is not a web document` }; }
    const resolver = resolvers.find(r => r.matches(doc));
    if (!resolver) { return { ok: false, error: `${doc.id}: no way to fetch ${doc.url ?? 'a document without URL'}` }; }
    const resolved = await resolver.resolve(doc, ctx);
    if ('error' in resolved) { return { ok: false, error: resolved.error, resolver: resolver.name }; }

    if (resolved.title && (doc.title === doc.url || doc.title === doc.id || !doc.title || doc.arm)) { doc.title = resolved.title; }
    if (resolved.versionLabel) { doc.revision = resolved.versionLabel; }
    doc.format = resolved.kind;
    if (doc.arm && resolved.version) { doc.arm = { ...doc.arm, resolvedVersion: resolved.version, versionLabel: resolved.versionLabel }; }

    const p = store.paths(doc);
    if (resolved.kind === 'html') {
        // Remember the outcome so the listing can say "HTML" without asking again.
        fs.mkdirSync(p.dir, { recursive: true });
        const record: FetchRecord = {
            version: 1, docId: doc.id, sourceUrl: doc.url ?? '', resolver: resolver.name, kind: 'html', title: doc.title,
            ...(resolved.version ? { resolvedVersion: resolved.version } : {}),
            ...(resolved.versionLabel ? { versionLabel: resolved.versionLabel } : {}),
            ...(resolved.contentFormat ? { contentFormat: resolved.contentFormat } : {}),
            downloadUrl: resolved.docJsonUrl ?? '', bytes: 0, sha256: '', fetchedAt: new Date().toISOString(), userAgent: ctx.userAgent,
        };
        fs.writeFileSync(p.fetchRecord, JSON.stringify(record, null, 2));
        return { ok: false, resolved, resolver: resolver.name, error: `${doc.id} is published as HTML on arm.com (${resolved.contentFormat ?? 'HTML'}); this version fetches PDFs only` };
    }
    let downloaded: Downloaded;
    try {
        downloaded = await downloadPdf(resolved.downloadUrl!, p.download, ctx);
    } catch (e) {
        return { ok: false, resolved, resolver: resolver.name, error: e instanceof Error ? e.message : String(e) };
    }
    const record: FetchRecord = {
        version: 1,
        docId: doc.id,
        sourceUrl: doc.url ?? '',
        resolver: resolver.name,
        kind: 'pdf',
        title: doc.title,
        ...(resolved.version ? { resolvedVersion: resolved.version } : {}),
        ...(resolved.versionLabel ? { versionLabel: resolved.versionLabel } : {}),
        ...(resolved.contentFormat ? { contentFormat: resolved.contentFormat } : {}),
        ...(resolved.filename ? { filename: resolved.filename } : {}),
        downloadUrl: resolved.downloadUrl!,
        bytes: downloaded.bytes,
        sha256: downloaded.sha256,
        fetchedAt: new Date().toISOString(),
        userAgent: ctx.userAgent,
    };
    fs.writeFileSync(p.fetchRecord, JSON.stringify(record, null, 2));
    doc.path = p.download;
    doc.cached = true;
    doc.indexed = false;
    doc.sizeBytes = downloaded.bytes;
    return { ok: true, record, resolved, resolver: resolver.name };
}
