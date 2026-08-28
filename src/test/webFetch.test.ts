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
 * The arm.com resolver against trimmed copies of real documentation-service
 * responses (fixtures/packdocs/arm), the direct-PDF resolver, the download
 * guard rails, and fetchDocument end to end — all through an injected fetch.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { armDocApiUrl, armDocId, armDocUrl, parseArmDocId, parseArmDocUrl } from '../core/packDocs/armDocs';
import { silentLog } from '../core/packDocs/host';
import { PageStore } from '../core/packDocs/pageStore';
import { DocRef } from '../core/packDocs/pdscBooks';
import { FetchFn, ResolveContext, armResolver, directPdfResolver, downloadPdf, fetchDocument } from '../core/packDocs/webFetch';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');
const ARM = path.join(FIXTURES, 'arm');
const API = 'https://documentation-service.arm.com/documentation';
const PDF_BYTES = fs.readFileSync(path.join(FIXTURES, 'test-rm.pdf'));

type Route = (init?: RequestInit) => Response;

export function fakeFetch(routes: Record<string, Route>): { fn: FetchFn; calls: { url: string; init?: RequestInit }[] } {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fn: FetchFn = async (url, init) => {
        calls.push({ url, init });
        const key = url.includes('?') ? url.slice(0, url.indexOf('?')) : url;
        const route = routes[url] ?? routes[key];
        return route ? route(init) : new Response('{"status":404}', { status: 404, headers: { 'content-type': 'application/json' } });
    };
    return { fn, calls };
}

export function json(file: string): Route {
    const body = fs.readFileSync(path.join(ARM, file), 'utf-8');
    return () => new Response(body, { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } });
}

export function pdf(bytes: Buffer = PDF_BYTES, name = 'doc.pdf'): Route {
    return (init) => new Response(init?.method === 'HEAD' ? null : new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length), 'content-disposition': `attachment; filename="${name}"` },
    });
}

export const ARM_ROUTES: Record<string, Route> = {
    [`${API}/ddi0553/latest`]: json('ddi0553-latest.json'),
    'https://documentation-service.arm.com/static/699eb70d77ad5021756604d8': pdf(PDF_BYTES, 'DDI0553B_z_armv8m_arm.pdf'),
    // A synthetic document with SVG resources only (no PDF) — the shape of an HTML-only publication.
    [`${API}/ddi0000/latest`]: json('html-only.json'),
    [`${API}/ddi0439/latest`]: json('ddi0439-latest.json'),
    [`${API}/ddi0439/versions`]: json('ddi0439-versions.json'),
    'https://documentation-service.arm.com/static/688210cfda264e793aeebf52': pdf(PDF_BYTES, 'DDI0439B_ERRATA_01.pdf'),
    [`${API}/ddi0439/b`]: () => new Response(JSON.stringify({
        document: 'ddi0439', version: 'b', versionLabel: 'r0p0', title: 'Cortex-M4 Technical Reference Manual', metadata: { contentFormat: 'PDFOnly' },
        _links: { resources: [{ href: 'https://documentation-service.arm.com/static/000000000000000000000439?token=', name: 'DDI0439B_cortex_m4_r0p0_trm.pdf', extension: 'pdf', contentType: 'application/pdf' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    'https://documentation-service.arm.com/static/000000000000000000000439': pdf(PDF_BYTES, 'DDI0439B_cortex_m4_r0p0_trm.pdf'),
};

function ctx(fn: FetchFn, extra: Partial<ResolveContext> = {}): ResolveContext {
    return { fetchFn: fn, userAgent: 'cmsis-pack-docs/test', log: silentLog, timeoutMs: 5000, maxBytes: 1 << 20, ...extra };
}

function armDoc(docId: string, version = 'latest'): DocRef {
    const arm = { docId, version };
    return { id: armDocId(arm), title: `Arm document ${docId}`, scope: 'arm', source: 'web', url: armDocUrl(arm), arm, cached: false, indexed: false };
}

function webDoc(url: string): DocRef {
    return { id: 'web/example-com/abc', title: 'x.pdf', scope: 'unlisted', source: 'web', url, cached: false, indexed: false };
}

suite('armDocs ids and URLs', () => {
    test('parseArmDocUrl understands every arm.com form a pdsc uses', () => {
        assert.deepStrictEqual(parseArmDocUrl('https://developer.arm.com/documentation/dui0646/latest'), { docId: 'dui0646', version: 'latest' });
        assert.deepStrictEqual(parseArmDocUrl('https://developer.arm.com/documentation/100235/latest/'), { docId: '100235', version: 'latest' });
        assert.deepStrictEqual(parseArmDocUrl('https://developer.arm.com/documentation/101273'), { docId: '101273', version: 'latest' });
        assert.deepStrictEqual(parseArmDocUrl('https://developer.arm.com/documentation/ddi0403/ee/'), { docId: 'ddi0403', version: 'ee' });
        assert.deepStrictEqual(parseArmDocUrl('https://developer.arm.com/documentation/DDI0489/f/preface?lang=en'), { docId: 'ddi0489', version: 'f' });
        assert.deepStrictEqual(parseArmDocUrl('https://developer.arm.com/documentation/100230/0100/introduction'), { docId: '100230', version: '0100' });
        assert.deepStrictEqual(parseArmDocUrl('https://support.arm.com/documentation/ddi0553/latest'), { docId: 'ddi0553', version: 'latest' });
        assert.deepStrictEqual(parseArmDocUrl('https://documentation-service.arm.com/documentation/ihi0031/h'), { docId: 'ihi0031', version: 'h' });
        assert.deepStrictEqual(parseArmDocUrl('http://infocenter.arm.com/help/topic/com.arm.doc.ddi0433c/index.html'), { docId: 'ddi0433', version: 'c' });
        assert.deepStrictEqual(parseArmDocUrl('http://infocenter.arm.com/help/topic/com.arm.doc.dui0646b/index.html'), { docId: 'dui0646', version: 'b' });
        assert.deepStrictEqual(parseArmDocUrl('http://infocenter.arm.com/help/topic/com.arm.doc.100511_0401_10_en/index.html'), { docId: '100511', version: '0401' });
        assert.strictEqual(parseArmDocUrl('https://developer.arm.com/documentation/??'), undefined);
        assert.strictEqual(parseArmDocUrl('https://developer.arm.com/tools-and-software/open-source-software/arm-platforms-software/arm-ecosystem-fvps'), undefined);
        assert.strictEqual(parseArmDocUrl('https://www.st.com/resource/en/datasheet/stm32f756bg.pdf'), undefined);
        assert.strictEqual(parseArmDocUrl('not a url'), undefined);
    });

    test('ids, API and page URLs round-trip', () => {
        const ref = { docId: 'ddi0553', version: 'latest' };
        assert.strictEqual(armDocId(ref), 'arm/ddi0553-latest');
        assert.strictEqual(armDocUrl(ref), 'https://developer.arm.com/documentation/ddi0553/latest');
        assert.strictEqual(armDocApiUrl(ref), 'https://documentation-service.arm.com/documentation/ddi0553/latest');
        assert.deepStrictEqual(parseArmDocUrl(armDocUrl(ref)), ref);
        assert.deepStrictEqual(parseArmDocId('arm/ddi0553-latest'), ref);
        assert.deepStrictEqual(parseArmDocId('DDI0553'), ref);
        assert.deepStrictEqual(parseArmDocId('ddi0439-b'), { docId: 'ddi0439', version: 'b' });
        assert.deepStrictEqual(parseArmDocId('100230'), { docId: '100230', version: 'latest' });
        assert.strictEqual(parseArmDocId('stm32f7xx-dfp/test-rm'), undefined);
        assert.strictEqual(parseArmDocId('rm0456'), undefined);
    });
});

suite('webFetch resolvers', () => {
    test('arm.com: picks the PDF resource, strips the token, reports version and edition, sends the user agent', async () => {
        const { fn, calls } = fakeFetch(ARM_ROUTES);
        const r = await armResolver.resolve(armDoc('ddi0553'), ctx(fn));
        assert.ok(!('error' in r));
        assert.strictEqual(r.kind, 'pdf');
        assert.strictEqual(r.downloadUrl, 'https://documentation-service.arm.com/static/699eb70d77ad5021756604d8');
        assert.strictEqual(r.filename, 'DDI0553B_z_armv8m_arm.pdf');
        assert.strictEqual(r.title, 'Armv8-M Architecture Reference Manual');
        assert.strictEqual(r.version, 'bz');
        assert.strictEqual(r.versionLabel, 'B.z');
        assert.strictEqual(r.contentFormat, 'PDFOnly');
        assert.strictEqual(r.alternatives, undefined);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].url, `${API}/ddi0553/latest`);
        assert.strictEqual((calls[0].init?.headers as Record<string, string>)['User-Agent'], 'cmsis-pack-docs/test');
    });

    test('arm.com: a document with SVG resources only is HTML', async () => {
        const { fn } = fakeFetch(ARM_ROUTES);
        const r = await armResolver.resolve(armDoc('ddi0000'), ctx(fn));
        assert.ok(!('error' in r));
        assert.strictEqual(r.kind, 'html');
        assert.strictEqual(r.contentFormat, 'HTMLPDF');
        assert.strictEqual(r.versionLabel, 'r1p2');
        assert.strictEqual(r.docJsonUrl, `${API}/ddi0000/latest`);
    });

    test('arm.com: an errata edition lists the other editions; unknown ids are reported with the versions URL', async () => {
        const { fn, calls } = fakeFetch(ARM_ROUTES);
        const r = await armResolver.resolve(armDoc('ddi0439'), ctx(fn));
        assert.ok(!('error' in r));
        assert.strictEqual(r.versionLabel, 'r0p0 Errata 01');
        assert.deepStrictEqual(r.alternatives, [{ version: 'b', versionLabel: 'r0p0' }]);
        assert.strictEqual(calls.length, 2);
        const missing = await armResolver.resolve(armDoc('ddi9999'), ctx(fn));
        assert.ok('error' in missing);
        assert.match(missing.error, /arm\.com has no document ddi9999\/latest .*documentation\/ddi9999\/versions/);
        const down = await armResolver.resolve(armDoc('ddi0553'), ctx(async () => { throw new Error('ECONNRESET'); }));
        assert.ok('error' in down && /did not answer.*ECONNRESET/.test(down.error));
    });

    test('direct: content type, sniffed %PDF- bodies, web pages and oversize files', async () => {
        const html: Route = () => new Response('<html><body>login</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
        const octet: Route = (init) => new Response(init?.method === 'HEAD' ? null : new Uint8Array(PDF_BYTES), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
        const big: Route = () => new Response(null, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(5 << 20) } });
        const noHead: Route = (init) => init?.method === 'HEAD'
            ? new Response(null, { status: 405 })
            : new Response(new Uint8Array(PDF_BYTES), { status: 200, headers: { 'content-type': 'application/pdf' } });
        const { fn } = fakeFetch({ 'https://x/a.pdf': pdf(), 'https://x/page': html, 'https://x/b.pdf': octet, 'https://x/big.pdf': big, 'https://x/c.pdf': noHead });
        const c = ctx(fn);
        const a = await directPdfResolver.resolve(webDoc('https://x/a.pdf'), c);
        assert.ok(!('error' in a) && a.kind === 'pdf' && a.downloadUrl === 'https://x/a.pdf' && a.filename === 'a.pdf');
        const p = await directPdfResolver.resolve(webDoc('https://x/page'), c);
        assert.ok('error' in p && /is a web page, not a PDF/.test(p.error));
        const b = await directPdfResolver.resolve(webDoc('https://x/b.pdf'), c);
        assert.ok(!('error' in b) && b.kind === 'pdf', 'octet-stream with a %PDF- body is accepted');
        const g = await directPdfResolver.resolve(webDoc('https://x/big.pdf'), c);
        assert.ok('error' in g && /above the maxPdfMb limit/.test(g.error));
        const h = await directPdfResolver.resolve(webDoc('https://x/c.pdf'), c);
        assert.ok(!('error' in h) && h.kind === 'pdf', 'HEAD 405 falls back to a ranged GET');
        const missing = await directPdfResolver.resolve(webDoc('https://x/nope.pdf'), c);
        assert.ok('error' in missing && /HTTP 404/.test(missing.error));
    });
});

suite('webFetch download and fetchDocument', () => {
    test('downloadPdf streams to a .part file, hashes, and refuses non-PDF or oversize bodies', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-dl-'));
        const html: Route = () => new Response('<html>no</html>', { status: 200, headers: { 'content-type': 'text/html' } });
        const huge: Route = () => new Response(new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 0x20)])), { status: 200, headers: { 'content-type': 'application/pdf' } });
        const { fn } = fakeFetch({ 'https://x/a.pdf': pdf(), 'https://x/page': html, 'https://x/huge.pdf': huge });
        const dest = path.join(dir, 'doc.pdf');
        const got = await downloadPdf('https://x/a.pdf', dest, ctx(fn));
        assert.strictEqual(got.bytes, PDF_BYTES.length);
        assert.strictEqual(got.sha256.length, 64);
        assert.ok(fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
        await assert.rejects(downloadPdf('https://x/page', path.join(dir, 'b.pdf'), ctx(fn)), /not a PDF \(text\/html\)/);
        assert.ok(!fs.existsSync(path.join(dir, 'b.pdf.part')), 'no leftover');
        await assert.rejects(downloadPdf('https://x/huge.pdf', path.join(dir, 'c.pdf'), ctx(fn, { maxBytes: 1000 })), /maxPdfMb/);
        await assert.rejects(downloadPdf('https://x/missing.pdf', path.join(dir, 'd.pdf'), ctx(fn)), /HTTP 404/);
    });

    test('fetchDocument caches the PDF and its provenance under the store id; annotate reads it back', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-fetch-'));
        const store = new PageStore(dir);
        const { fn } = fakeFetch(ARM_ROUTES);
        const doc = armDoc('ddi0553');
        const out = await fetchDocument(doc, store, ctx(fn));
        assert.ok(out.ok, JSON.stringify(out));
        assert.strictEqual(out.resolver, 'arm.com');
        assert.strictEqual(doc.path, path.join(dir, 'arm', 'ddi0553-latest', 'doc.pdf'));
        assert.strictEqual(doc.cached, true);
        assert.strictEqual(doc.revision, 'B.z');
        assert.strictEqual(doc.format, 'pdf');
        assert.strictEqual(doc.title, 'Armv8-M Architecture Reference Manual');
        assert.deepStrictEqual(doc.arm, { docId: 'ddi0553', version: 'latest', resolvedVersion: 'bz', versionLabel: 'B.z' });
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'arm', 'ddi0553-latest', 'fetch.json'), 'utf-8'));
        assert.strictEqual(record.downloadUrl, 'https://documentation-service.arm.com/static/699eb70d77ad5021756604d8');
        assert.strictEqual(record.filename, 'DDI0553B_z_armv8m_arm.pdf');
        assert.strictEqual(record.bytes, PDF_BYTES.length);

        const fresh = store.annotate(armDoc('ddi0553'));
        assert.strictEqual(fresh.cached, true);
        assert.strictEqual(fresh.indexed, false, 'not extracted yet');
        assert.strictEqual(fresh.revision, 'B.z');
        assert.strictEqual(fresh.path, doc.path);
        assert.strictEqual(fresh.title, 'Armv8-M Architecture Reference Manual');

        const html = armDoc('ddi0000');
        const h = await fetchDocument(html, store, ctx(fn));
        assert.ok(!h.ok && /published as HTML on arm\.com \(HTMLPDF\)/.test(h.error));
        assert.strictEqual(html.format, 'html');
        assert.strictEqual(html.revision, 'r1p2');
        assert.strictEqual(store.annotate(armDoc('ddi0000')).format, 'html', 'the outcome is remembered');

        const local: DocRef = { id: 'p/x', title: 'x', scope: 'device', source: 'pack', path: '/x.pdf', cached: false, indexed: false };
        assert.ok(!(await fetchDocument(local, store, ctx(fn))).ok);
    });
});
