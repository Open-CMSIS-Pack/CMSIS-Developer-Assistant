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

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocRef } from '../core/packDocs/pdscBooks';
import { PageStore } from '../core/packDocs/pageStore';
import { PdfExtractor, PdftotextExtractor, splitPages } from '../core/packDocs/pdfExtract';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

class FakeExtractor implements PdfExtractor {
    readonly name = 'fake';
    calls = 0;
    constructor(private readonly pages: string[]) { }
    async available() { return { ok: true, detail: 'fake' }; }
    async extract() { this.calls++; return { pages: this.pages, extractor: this.name, ms: 1 }; }
}

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-test-'));
}

function docFor(file: string): DocRef {
    return { id: 'p/test-rm', title: 'Test RM', scope: 'device', pack: 'V::P@1.0.0', packId: { vendor: 'V', name: 'P', version: '1.0.0' }, source: 'pack', path: file, sizeBytes: fs.statSync(file).size, cached: false, indexed: false };
}

suite('pageStore', () => {
    test('extracts once, writes the three sidecars, and reuses them until the file changes', async () => {
        const dir = tmp();
        const file = path.join(dir, 'test-rm.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
        const store = new PageStore(path.join(dir, 'store'));
        const fake = new FakeExtractor(['1 Intro\nHello RCC_AHB1ENR', '2 More\nGPIOAEN bit']);
        const doc = docFor(file);

        assert.strictEqual(store.isCurrent(doc), false);
        const first = await store.ensure(doc, fake);
        assert.strictEqual(fake.calls, 1);
        assert.strictEqual(first.meta.pageCount, 2);
        assert.strictEqual(first.pages()[1].heading, '2 More');
        assert.ok(first.index.postings['gpioaen']);
        const p = store.paths(doc);
        assert.ok(fs.existsSync(p.pages) && fs.existsSync(p.meta) && fs.existsSync(p.index));
        assert.strictEqual(p.dir, path.join(dir, 'store', 'v', 'p', '1.0.0'));
        assert.strictEqual(doc.indexed, true);
        assert.strictEqual(doc.pages, 2);

        const store2 = new PageStore(path.join(dir, 'store'));
        const second = await store2.ensure(doc, fake);
        assert.strictEqual(fake.calls, 1, 'cache hit');
        assert.strictEqual(second.pages().length, 2);
        assert.strictEqual(store2.annotate({ ...doc, cached: false, indexed: false, pages: undefined }).pages, 2);

        // Touch the file → re-extracted.
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(file, later, later);
        assert.strictEqual(store2.isCurrent(doc), false);
        await store2.ensure(doc, fake);
        assert.strictEqual(fake.calls, 2);
    });

    test('workspace documents are keyed by their folder; version-1 metadata from 0.1.x is still accepted', async () => {
        const dir = tmp();
        const a = path.join(dir, 'one', 'docs', 'um.pdf');
        const b = path.join(dir, 'two', 'docs', 'um.pdf');
        fs.mkdirSync(path.dirname(a), { recursive: true });
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), a);
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), b);
        const store = new PageStore(path.join(dir, 'store'));
        const wsDoc = (file: string): DocRef => ({ id: 'workspace/um', title: 'um', scope: 'workspace', source: 'workspace', path: file, cached: false, indexed: false });
        const pa = store.paths(wsDoc(a));
        const pb = store.paths(wsDoc(b));
        assert.match(pa.dir, /[\\/]store[\\/]workspace[\\/][0-9a-f]{12}$/);
        assert.notStrictEqual(pa.dir, pb.dir, 'same file name in two folders → two cache directories');
        assert.strictEqual(path.basename(pa.pages), 'um.pages.jsonl');

        const fake = new FakeExtractor(['page one', 'page two']);
        const doc = wsDoc(a);
        const loaded = await store.ensure(doc, fake);
        assert.strictEqual(loaded.meta.version, 2);
        assert.strictEqual(loaded.meta.source, 'workspace');
        assert.strictEqual(loaded.meta.unit, 'page');
        assert.strictEqual(doc.unit, 'page');

        // A sidecar written by 0.1.x (version 1, no source/unit) is still current.
        const meta = JSON.parse(fs.readFileSync(pa.meta, 'utf-8'));
        delete meta.source; delete meta.title; delete meta.unit;
        meta.version = 1;
        fs.writeFileSync(pa.meta, JSON.stringify(meta));
        const store2 = new PageStore(path.join(dir, 'store'));
        assert.strictEqual(store2.isCurrent(wsDoc(a)), true);
        assert.strictEqual(store2.annotate(wsDoc(a)).pages, 2);
        assert.strictEqual(store2.readMeta(wsDoc(b)), undefined, 'the other folder has no cache');
    });

    test('listCached enumerates every extracted document with its sidecars', async () => {
        const dir = tmp();
        const file = path.join(dir, 'test-rm.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
        const store = new PageStore(path.join(dir, 'store'));
        assert.deepStrictEqual(store.listCached(), []);
        const doc = docFor(file);
        doc.revision = 'Rev 3';
        await store.ensure(doc, new FakeExtractor(['1 Intro\nHello', '2 More\nWorld']));
        const ws: DocRef = { id: 'workspace/um', title: 'um', scope: 'workspace', source: 'workspace', path: file, cached: false, indexed: false };
        await store.ensure(ws, new FakeExtractor(['only']));
        const list = store.listCached();
        assert.deepStrictEqual(list.map(e => e.id), ['p/test-rm', 'workspace/um']);
        const first = list[0];
        assert.strictEqual(first.source, 'pack');
        assert.strictEqual(first.title, 'Test RM');
        assert.strictEqual(first.revision, 'Rev 3');
        assert.strictEqual(first.pageCount, 2);
        assert.strictEqual(first.unit, 'page');
        assert.strictEqual(first.extractor, 'fake');
        assert.strictEqual(first.file, file);
        assert.strictEqual(first.fileExists, true);
        assert.strictEqual(first.sizeBytes, fs.statSync(file).size);
        assert.ok(first.storedBytes > 100);
        assert.strictEqual(first.dir, path.join(dir, 'store', 'v', 'p', '1.0.0'));
        assert.strictEqual(first.metaPath, path.join(first.dir, 'test-rm.meta.json'));
        assert.strictEqual(first.fetch, undefined);
        assert.deepStrictEqual(store.readCachedPages(first).map(p => p.heading), ['1 Intro', '2 More']);
        assert.ok(store.readCachedIndex(first).postings['hello']);
        assert.strictEqual(list[1].source, 'workspace');
        assert.strictEqual(store.dir, path.join(dir, 'store'));
    });

    test('listFetched rebuilds DocRefs from fetch.json records under arm/ and web/', () => {
        const dir = tmp();
        const store = new PageStore(dir);
        const write = (sub: string, record: object) => {
            fs.mkdirSync(path.join(dir, sub), { recursive: true });
            fs.writeFileSync(path.join(dir, sub, 'fetch.json'), JSON.stringify(record));
        };
        write('arm/ddi0553-latest', { version: 1, docId: 'arm/ddi0553-latest', sourceUrl: 'https://developer.arm.com/documentation/ddi0553/latest', resolver: 'arm.com', kind: 'pdf', title: 'Armv8-M ARM', resolvedVersion: 'bz', versionLabel: 'B.z', downloadUrl: 'x', bytes: 5, sha256: 'a', fetchedAt: 't', userAgent: 'u' });
        write('arm/ddi0489-latest', { version: 1, docId: 'arm/ddi0489-latest', sourceUrl: 'https://developer.arm.com/documentation/ddi0489/latest', resolver: 'arm.com', kind: 'html', title: 'Cortex-M7 TRM', versionLabel: 'r1p2', downloadUrl: '', bytes: 0, sha256: '', fetchedAt: 't', userAgent: 'u' });
        write('web/example-com/0123456789ab', { version: 1, docId: 'web/example-com/0123456789ab', sourceUrl: 'https://example.com/um.pdf', resolver: 'direct', kind: 'pdf', title: 'um.pdf', downloadUrl: 'https://example.com/um.pdf', bytes: 5, sha256: 'a', fetchedAt: 't', userAgent: 'u' });
        write('arm/broken', { nonsense: true });
        fs.mkdirSync(path.join(dir, 'keil', 'x', '1.0.0'), { recursive: true });

        const found = store.listFetched().sort((a, b) => a.id.localeCompare(b.id));
        assert.deepStrictEqual(found.map(d => d.id), ['arm/ddi0489-latest', 'arm/ddi0553-latest', 'web/example-com/0123456789ab']);
        const arm = found[1];
        assert.strictEqual(arm.scope, 'arm');
        assert.strictEqual(arm.source, 'web');
        assert.strictEqual(arm.title, 'Armv8-M ARM');
        assert.strictEqual(arm.revision, 'B.z');
        assert.strictEqual(arm.format, 'pdf');
        assert.deepStrictEqual(arm.arm, { docId: 'ddi0553', version: 'latest', resolvedVersion: 'bz', versionLabel: 'B.z' });
        assert.strictEqual(found[0].format, 'html');
        assert.strictEqual(found[2].scope, 'unlisted');
        assert.strictEqual(found[2].arm, undefined);
        assert.deepStrictEqual(new PageStore(path.join(dir, 'empty')).listFetched(), []);
    });

    test('concurrent ensure calls share one extraction', async () => {
        const dir = tmp();
        const file = path.join(dir, 'test-rm.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
        const store = new PageStore(path.join(dir, 'store'));
        const fake = new FakeExtractor(['only page']);
        const doc = docFor(file);
        const [a, b] = await Promise.all([store.ensure(doc, fake), store.ensure(doc, fake)]);
        assert.strictEqual(fake.calls, 1);
        assert.strictEqual(a.meta.sha256, b.meta.sha256);
    });

    test('splitPages drops the trailing empty segment only', () => {
        assert.deepStrictEqual(splitPages('a\fb\f'), ['a', 'b']);
        assert.deepStrictEqual(splitPages('a\f\fb\f'), ['a', '', 'b']);
        assert.deepStrictEqual(splitPages('single'), ['single']);
    });

    test('pdftotext extracts the fixture PDF page by page (skipped when poppler is absent)', async function () {
        const extractor = new PdftotextExtractor();
        const avail = await extractor.available();
        if (!avail.ok) { this.skip(); return; }
        const result = await extractor.extract(path.join(FIXTURES, 'test-rm.pdf'));
        assert.strictEqual(result.pages.length, 2);
        assert.match(result.pages[0], /RCC_AHB1ENR/);
        assert.match(result.pages[0], /GPIOAEN: IO port A clock enable/);
        assert.match(result.pages[1], /0x4002_3800/);
    });

    test('a missing executable is reported, not thrown', async () => {
        const extractor = new PdftotextExtractor('/definitely/not/here/pdftotext');
        const avail = await extractor.available();
        assert.strictEqual(avail.ok, false);
        assert.match(avail.detail, /pdftotext/);
    });
});
