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
    /** Tests and loopback fixtures only: skip the private-address block. */
    allowPrivateHosts?: boolean;
    /** Ends every request and the download early, as the time limit does: a download job that is disposed. */
    signal?: AbortSignal;
    /** Told the bytes received so far, and the length the server announced, as a PDF arrives. */
    onProgress?: (bytes: number, total: number | undefined) => void;
}

/** Redirect hops followed before giving up. */
export const MAX_REDIRECTS = 5;

function ipv4Octets(host: string): number[] | undefined {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) { return undefined; }
    const o = m.slice(1).map(Number);
    return o.every(n => n <= 255) ? o : undefined;
}

/**
 * Why `hostname` (as `new URL(url).hostname` gives it — the WHATWG parser
 * already normalises `2130706433`, `0x7f.1` and `017700000001` to dotted
 * quads) must not be fetched: loopback, link-local, RFC 1918, CGNAT,
 * multicast, the cloud metadata names, or `localhost`. Undefined for a
 * public host. No DNS lookup: a public name resolving to a private address
 * is not caught here.
 */
export function blockedHostReason(hostname: string): string | undefined {
    const h = hostname.toLowerCase().replace(/\.$/, '');
    if (h === 'localhost' || h.endsWith('.localhost')) { return 'localhost'; }
    if (h === 'metadata' || h === 'metadata.google.internal' || h === 'instance-data') { return 'cloud metadata service'; }
    const v4 = ipv4Octets(h);
    if (v4) {
        const [a, b] = v4;
        if (a === 0) { return 'this-host address 0.0.0.0/8'; }
        if (a === 10) { return 'private address 10.0.0.0/8'; }
        if (a === 127) { return 'loopback address 127.0.0.0/8'; }
        if (a === 169 && b === 254) { return 'link-local address 169.254.0.0/16'; }
        if (a === 172 && b >= 16 && b <= 31) { return 'private address 172.16.0.0/12'; }
        if (a === 192 && b === 168) { return 'private address 192.168.0.0/16'; }
        if (a === 100 && b >= 64 && b <= 127) { return 'carrier-grade NAT address 100.64.0.0/10'; }
        if (a >= 224) { return 'multicast or reserved address'; }
        return undefined;
    }
    const v6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
    if (v6.includes(':')) {
        if (v6 === '::' || v6 === '::1') { return 'IPv6 loopback or unspecified address'; }
        const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
        if (mapped) { return blockedHostReason(mapped[1]); }
        const first = v6.split(':')[0];
        const word = parseInt(first || '0', 16);
        if (first.length && (word & 0xffc0) === 0xfe80) { return 'IPv6 link-local address fe80::/10'; }
        if (first.length && (word & 0xfe00) === 0xfc00) { return 'IPv6 unique-local address fc00::/7'; }
    }
    return undefined;
}

/** A URL the guard refused — final, never retried through another strategy. */
export class BlockedHostError extends Error {
    constructor(url: string, reason: string) {
        super(`${url} points at a local or private address (${reason}); fetch_doc downloads public documents only — copy the PDF into the workspace docs folder instead`);
        this.name = 'BlockedHostError';
    }
}

function refuseIfBlocked(url: string, ctx: ResolveContext): void {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BlockedHostError(url, 'not an http(s) URL');
    }
    if (ctx.allowPrivateHosts) { return; }
    const reason = blockedHostReason(parsed.hostname);
    if (reason) {
        throw new BlockedHostError(url, reason);
    }
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * `ctx.fetchFn` with the private-address check on the URL and on every
 * redirect target: redirects are followed one hop at a time so a public
 * URL cannot bounce the request onto the MCP or control port. A fetchFn
 * that followed redirects on its own is checked on `res.url` as well.
 */
export async function fetchGuarded(url: string, init: RequestInit, ctx: ResolveContext): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        refuseIfBlocked(current, ctx);
        const res = await ctx.fetchFn(current, { ...init, redirect: 'manual' });
        const location = res.headers.get('location');
        if (REDIRECT_STATUS.has(res.status) && location) {
            const next = new URL(location, current).href;
            ctx.log.debug(`${current} → ${res.status} redirect to ${next}`);
            current = next;
            continue;
        }
        if (res.url && res.url !== current) { refuseIfBlocked(res.url, ctx); }
        return res;
    }
    throw new Error(`${url}: too many redirects (more than ${MAX_REDIRECTS})`);
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
    const timeout = AbortSignal.timeout(Math.max(100, ctx.timeoutMs));
    return ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
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
        const res = await fetchGuarded(url, { headers: headers(ctx, 'application/json'), signal: signal(ctx) }, ctx);
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

/**
 * The same URL with one `.pdf` where it ends in `.pdf.pdf`, or undefined. A
 * pack can name its book so (Keil::STM32F4xx_DFP 3.1.1 lists
 * `…/datasheet/stm32f427vg.pdf.pdf`), and the vendor answers 404.
 */
export function singlePdfExtension(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        if (!/\.pdf\.pdf$/i.test(parsed.pathname)) {
            return undefined;
        }
        parsed.pathname = parsed.pathname.slice(0, -'.pdf'.length);
        return parsed.toString();
    } catch {
        return undefined;
    }
}

export const directPdfResolver: DocResolver = {
    name: 'direct',
    matches: (doc) => !!doc.url && /^https?:\/\//i.test(doc.url),
    async resolve(doc, ctx) {
        const url = doc.url!;
        const first = await resolveDirect(url, doc, ctx);
        const single = 'error' in first && / answered HTTP 404$/.test(first.error) ? singlePdfExtension(url) : undefined;
        if (single === undefined) {
            return first;
        }
        ctx.log.debug(`${url} answered 404; trying ${single}`);
        const second = await resolveDirect(single, doc, ctx);
        return 'error' in second ? first : second;
    },
};

/** A direct PDF link: HEAD first, else the first bytes of a ranged GET, decide whether it is a PDF the size limit allows. */
async function resolveDirect(url: string, doc: DocRef, ctx: ResolveContext): Promise<ResolveResult> {
    const filename = path.basename(new URL(url).pathname) || 'document.pdf';
    const ok = (): ResolvedDoc => ({ kind: 'pdf', downloadUrl: url, filename, title: doc.title });
    try {
        refuseIfBlocked(url, ctx);
    } catch (e) {
        return { error: describeError(e) };
    }
    const t0 = Date.now();
    try {
        const head = await fetchGuarded(url, { method: 'HEAD', headers: headers(ctx, 'application/pdf,*/*'), signal: signal(ctx) }, ctx);
        const type = (head.headers.get('content-type') ?? '').toLowerCase();
        const length = Number(head.headers.get('content-length') ?? 0);
        ctx.log.debug(`HEAD ${url} → ${head.status} ${type} ${length} in ${Date.now() - t0} ms`);
        if (head.ok && length > ctx.maxBytes) { return { error: `${url} is ${(length / 1024 / 1024).toFixed(0)} MB, above the maxPdfMb limit` }; }
        if (head.ok && type.includes('application/pdf')) { return ok(); }
        if (head.ok && type.includes('text/html')) { return { error: `${url} is a web page, not a PDF — open the link in a browser and download the PDF into the workspace docs folder` }; }
    } catch (e) {
        if (e instanceof BlockedHostError) { return { error: e.message }; }
        ctx.log.debug(`HEAD ${url} failed: ${describeError(e)}`);
    }
    // No usable HEAD: peek at the first bytes.
    try {
        const res = await fetchGuarded(url, { headers: headers(ctx, 'application/pdf,*/*', { Range: 'bytes=0-1023' }), signal: signal(ctx) }, ctx);
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
}

export const resolvers: DocResolver[] = [armResolver, directPdfResolver];

// ---------------------------------------------------------------- download

export interface Downloaded { bytes: number; sha256: string; ms: number }

/** Stream a PDF to `dest` (via `dest.part`), refusing non-PDF bodies and anything above `maxBytes`. */
export async function downloadPdf(url: string, dest: string, ctx: ResolveContext): Promise<Downloaded> {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(100, ctx.timeoutMs));
    const stop = (): void => controller.abort();
    ctx.signal?.addEventListener('abort', stop, { once: true });
    if (ctx.signal?.aborted) { controller.abort(); }
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(part);
    // Observed from the first byte: a stream error mid-download (full disk,
    // unwritable store) must become this call's error, not an unhandled
    // 'error' event on the extension host — and must end a back-pressure
    // wait that would otherwise never resolve.
    const failed = new Promise<never>((_resolve, reject) => out.once('error', reject));
    failed.catch(() => undefined);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let first = true;
    try {
        const res = await fetchGuarded(url, { headers: headers(ctx, 'application/pdf,*/*'), signal: controller.signal }, ctx);
        if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
        const length = Number(res.headers.get('content-length') ?? 0);
        if (length > ctx.maxBytes) { throw new Error(`${(length / 1024 / 1024).toFixed(0)} MB is above the maxPdfMb limit`); }
        const total = length > 0 ? length : undefined;
        ctx.onProgress?.(0, total);
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
            ctx.onProgress?.(bytes, total);
            hash.update(chunk);
            if (!out.write(chunk)) { await Promise.race([new Promise<void>(resolve => out.once('drain', resolve)), failed]); }
        }
        if (bytes === 0) { throw new Error('empty response'); }
        // `end`'s callback receives the stream error when the open failed (a directory, EACCES) — reject on it too.
        await Promise.race([new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve()))), failed]);
        fs.renameSync(part, dest);
        const ms = Date.now() - t0;
        ctx.log.info(`downloaded ${url} → ${dest} (${(bytes / 1024 / 1024).toFixed(1)} MB in ${ms} ms)`);
        return { bytes, sha256: hash.digest('hex'), ms };
    } catch (e) {
        controller.abort();
        // The stream opens the .part file asynchronously. Destroy it and wait
        // for 'close' before unlinking: an open that completes after the
        // unlink would leave the file behind (seen on a slow macOS runner).
        await new Promise<void>(resolve => {
            if (out.closed) { resolve(); return; }
            out.once('close', resolve);
            out.destroy();
        });
        try { fs.unlinkSync(part); } catch { /* nothing to clean */ }
        const received = bytes > 0 ? ` after ${(bytes / 1024 / 1024).toFixed(1)} MB` : '';
        throw new Error(`download of ${url} failed: ${ctx.signal?.aborted ? 'stopped' : describeError(e)}${received}`);
    } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', stop);
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
