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
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import {
    CoreIndexLock,
    FETCH_COMMAND,
    INDEX_RELATIVE,
    LOCK_RELATIVE,
    SOURCES_RELATIVE,
    assertPinnedIndex,
    downloadVerified,
    fetchIndex,
    fetchSources,
    indexState,
    lockFromRelease,
    parseLock,
    parseReleaseRecord,
    readLock,
    releaseRecordUrl,
    sha256OfFile,
    sourcesState,
    writeLock,
} from '../core/knowledge/coreIndexLock';

/**
 * The core knowledge index is pinned by resources/knowledge/core.lock.json
 * and fetched by `npm run knowledge:fetch`; `npm run package` refuses a VSIX
 * without the pinned file. These tests cover the lock's reader, the hash
 * check against a file, the packaging gate and the download (against a
 * loopback server: redirects followed, a wrong hash discarded), without
 * touching the repository's own index or the network.
 */
suite('Core knowledge index lock', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const sha256Of = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
    const content = Buffer.from('the core index, in the tests a few bytes');
    const sourcesText = Buffer.from('# Sources of the CMSIS knowledge index\n\n<!-- sources:table:begin -->\n| Source |\n<!-- sources:table:end -->\n');
    const sampleLock: CoreIndexLock = {
        version: '2026.10.21',
        url: 'https://example.invalid/kb/releases/download/core-2026.10.21/knowledge-core-2026.10.21.db',
        sha256: sha256Of(content),
        size: content.length,
        units: 7064,
        kbCommit: '574367ea7ed7bfd2fdfa3bb2867a4f5136386f09',
    };
    const withSources: CoreIndexLock = {
        ...sampleLock,
        sources: 'https://example.invalid/kb/releases/download/core-2026.10.21/SOURCES.md',
        sourcesSha256: sha256Of(sourcesText),
    };

    let scratch: string;
    const roots: string[] = [];
    setup(() => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-knowledge-lock-'));
    });
    teardown(() => {
        fs.rmSync(scratch, { recursive: true, force: true });
        roots.length = 0;
    });

    /** A repository root in the scratch folder with the lock and, when given, an index. */
    function fakeRepo(lock: CoreIndexLock, index?: Buffer, sources?: Buffer): string {
        const root = path.join(scratch, `repo-${roots.length}`);
        roots.push(root);
        fs.mkdirSync(path.dirname(path.join(root, LOCK_RELATIVE)), { recursive: true });
        writeLock(root, lock);
        if (index) {
            fs.writeFileSync(path.join(root, INDEX_RELATIVE), index);
        }
        if (sources) {
            fs.writeFileSync(path.join(root, SOURCES_RELATIVE), sources);
        }
        return root;
    }

    test('the committed lock is valid and names a release asset of the knowledge base', () => {
        const lock = readLock(repoRoot);
        assert.match(lock.version, /^\d{4}\.\d{2}\.\d{2}/);
        assert.ok(lock.url.endsWith(`/core-${lock.version}/knowledge-core-${lock.version}.db`), lock.url);
        assert.match(lock.sha256, /^[0-9a-f]{64}$/);
        assert.ok(lock.size > 1_000_000 && lock.units > 1000);
        assert.strictEqual(releaseRecordUrl(lock.url, lock.version),
            lock.url.replace(/\.db$/, '.json'));
        // The attribution ships committed and is the release's: the lock names it and the file matches the hash.
        assert.strictEqual(lock.sources, lock.url.replace(/knowledge-core-[^/]+\.db$/, 'SOURCES.md'));
        assert.deepStrictEqual(sourcesState(repoRoot, lock), { kind: 'pinned', sha256: lock.sourcesSha256 });
        const sources = fs.readFileSync(path.join(repoRoot, SOURCES_RELATIVE), 'utf8');
        assert.ok(sources.includes('<!-- sources:table:begin -->') && sources.includes('## Licence texts'), 'the table and the licence texts');
    });

    test('parseLock rejects a lock that is incomplete or malformed, naming the field', () => {
        const valid = JSON.stringify(sampleLock);
        assert.deepStrictEqual(parseLock(valid, 'lock'), sampleLock);
        const without = (key: keyof CoreIndexLock): string => JSON.stringify({ ...sampleLock, [key]: undefined });
        assert.throws(() => parseLock(without('sha256'), 'lock'), /lock: missing field "sha256"/);
        assert.throws(() => parseLock(without('url'), 'lock'), /missing field "url"/);
        assert.throws(() => parseLock(JSON.stringify({ ...sampleLock, sha256: 'abc' }), 'lock'), /64 hex digits/);
        assert.throws(() => parseLock(JSON.stringify({ ...sampleLock, size: -1 }), 'lock'), /"size" must be a positive integer/);
        assert.throws(() => parseLock(JSON.stringify({ ...sampleLock, url: 'http://insecure' }), 'lock'), /https/);
        assert.throws(() => parseLock('[]', 'lock'), /expected a JSON object/);
        assert.throws(() => parseLock('{', 'lock'), /not JSON/);
        // The attribution is optional, but named together with its hash, as an https URL.
        assert.deepStrictEqual(parseLock(JSON.stringify(withSources), 'lock'), withSources);
        assert.throws(() => parseLock(JSON.stringify({ ...withSources, sourcesSha256: undefined }), 'lock'), /missing field "sourcesSha256"/);
        assert.throws(() => parseLock(JSON.stringify({ ...withSources, sources: 'http://insecure/SOURCES.md' }), 'lock'), /"sources" must be an https URL/);
        // Hashes are compared lower-case whatever the lock's spelling.
        assert.strictEqual(parseLock(JSON.stringify({ ...sampleLock, sha256: sampleLock.sha256.toUpperCase() }), 'lock').sha256, sampleLock.sha256);
    });

    test('a release record becomes the lock of that version, counts accepted as strings', () => {
        const record = parseReleaseRecord(JSON.stringify({
            schema_version: 1, kb_commit: 'abc123', units: '7064', nodes: 33994,
            file: 'knowledge-core-2026.11.01.db', sha256: sampleLock.sha256, size: 65429504,
        }), 'record');
        const next = lockFromRelease(sampleLock.url, '2026.11.01', record);
        assert.deepStrictEqual(next, {
            version: '2026.11.01',
            url: 'https://example.invalid/kb/releases/download/core-2026.11.01/knowledge-core-2026.11.01.db',
            sha256: sampleLock.sha256,
            size: 65429504,
            units: 7064,
            kbCommit: 'abc123',
        });
        assert.throws(() => releaseRecordUrl('https://example.invalid/elsewhere/file.db', '2026.11.01'), /release's assets/);
        // A release that carries SOURCES.md names it in the record, and the lock then names the asset by URL.
        const withAttribution = parseReleaseRecord(JSON.stringify({
            kb_commit: 'abc123', units: 7064, file: 'knowledge-core-2026.11.01.db', sha256: sampleLock.sha256, size: 65429504,
            sources: 'SOURCES.md', sources_sha256: withSources.sourcesSha256,
        }), 'record');
        const pinned = lockFromRelease(sampleLock.url, '2026.11.01', withAttribution);
        assert.strictEqual(pinned.sources, 'https://example.invalid/kb/releases/download/core-2026.11.01/SOURCES.md');
        assert.strictEqual(pinned.sourcesSha256, withSources.sourcesSha256);
        assert.strictEqual(next.sources, undefined);
    });

    test('sourcesState compares the committed SOURCES.md with the lock, and is none when the lock names no file', () => {
        assert.deepStrictEqual(sourcesState(fakeRepo(sampleLock, content), sampleLock), { kind: 'none' });
        assert.deepStrictEqual(sourcesState(fakeRepo(withSources, content), withSources), { kind: 'missing' });
        assert.deepStrictEqual(sourcesState(fakeRepo(withSources, content, sourcesText), withSources),
            { kind: 'pinned', sha256: withSources.sourcesSha256 });
        const other = Buffer.from('an older SOURCES.md');
        assert.deepStrictEqual(sourcesState(fakeRepo(withSources, content, other), withSources),
            { kind: 'unpinned', sha256: sha256Of(other) });
    });

    test('sha256OfFile and indexState compare the file with the lock', () => {
        const file = path.join(scratch, 'index.db');
        fs.writeFileSync(file, content);
        assert.strictEqual(sha256OfFile(file), sampleLock.sha256);

        assert.deepStrictEqual(indexState(fakeRepo(sampleLock), sampleLock), { kind: 'missing' });
        assert.deepStrictEqual(indexState(fakeRepo(sampleLock, content), sampleLock),
            { kind: 'pinned', sha256: sampleLock.sha256, size: content.length });
        const other = Buffer.from('a rebuilt index');
        assert.deepStrictEqual(indexState(fakeRepo(sampleLock, other), sampleLock),
            { kind: 'unpinned', sha256: sha256Of(other), size: other.length });
    });

    test('the packaging gate refuses a missing index always, an unpinned one unless allowed, and names the fetch command', () => {
        const warnings: string[] = [];
        const warn = (message: string): void => { warnings.push(message); };
        const missing = fakeRepo(sampleLock);
        assert.throws(() => assertPinnedIndex(missing, { allowUnpinned: false, warn }), (error: unknown) =>
            error instanceof Error && error.message.includes(FETCH_COMMAND) && error.message.includes('missing'));
        assert.throws(() => assertPinnedIndex(missing, { allowUnpinned: true, warn }), /missing/);

        const unpinned = fakeRepo(sampleLock, Buffer.from('a rebuilt index'));
        assert.throws(() => assertPinnedIndex(unpinned, { allowUnpinned: false, warn }), (error: unknown) =>
            error instanceof Error && error.message.includes(FETCH_COMMAND) && error.message.includes('--index-unpinned'));
        assert.strictEqual(warnings.length, 0);
        const allowed = assertPinnedIndex(unpinned, { allowUnpinned: true, warn });
        assert.strictEqual(allowed.state.kind, 'unpinned');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /WARNING: packaging an UNPINNED core knowledge index/);

        const pinned = assertPinnedIndex(fakeRepo(sampleLock, content), { allowUnpinned: false, warn });
        assert.strictEqual(pinned.state.kind, 'pinned');
        assert.strictEqual(pinned.sources.kind, 'none');
        assert.strictEqual(pinned.lock.version, sampleLock.version);
        assert.strictEqual(warnings.length, 1);

        // The attribution the lock names must be the committed one: refused like an unpinned index, warned about when allowed.
        assert.throws(() => assertPinnedIndex(fakeRepo(withSources, content), { allowUnpinned: false, warn }), (error: unknown) =>
            error instanceof Error && error.message.includes('SOURCES.md') && error.message.includes('missing') && error.message.includes(FETCH_COMMAND));
        assert.throws(() => assertPinnedIndex(fakeRepo(withSources, content, Buffer.from('older')), { allowUnpinned: false, warn }), /SOURCES\.md has sha256/);
        assert.strictEqual(assertPinnedIndex(fakeRepo(withSources, content, Buffer.from('older')), { allowUnpinned: true, warn }).sources.kind, 'unpinned');
        assert.strictEqual(warnings.length, 2);
        assert.strictEqual(assertPinnedIndex(fakeRepo(withSources, content, sourcesText), { allowUnpinned: false, warn }).sources.kind, 'pinned');
        assert.strictEqual(warnings.length, 2);
    });

    suite('download from a loopback server', () => {
        let server: http.Server;
        let base: string;
        let hits: string[];
        suiteSetup(async () => {
            hits = [];
            server = http.createServer((request, response) => {
                hits.push(request.url ?? '');
                if (request.url === '/redirect') {
                    response.writeHead(302, { location: '/moved' });
                    response.end();
                } else if (request.url === '/moved') {
                    response.writeHead(307, { location: `${base}/index.db` });
                    response.end();
                } else if (request.url === '/index.db') {
                    response.writeHead(200, { 'content-type': 'application/octet-stream' });
                    response.end(content);
                } else if (request.url === '/SOURCES.md') {
                    response.writeHead(200, { 'content-type': 'text/markdown' });
                    response.end(sourcesText);
                } else if (request.url === '/short.db') {
                    response.writeHead(200);
                    response.end(content.subarray(0, 5));
                } else {
                    response.writeHead(404);
                    response.end();
                }
            });
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        });
        suiteTeardown(async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        });

        test('follows redirects, verifies hash and size, and renames the file into place', async () => {
            const destination = path.join(scratch, 'fetched', 'core.db');
            await downloadVerified(`${base}/redirect`, destination, sampleLock);
            assert.deepStrictEqual(hits, ['/redirect', '/moved', '/index.db']);
            assert.ok(content.equals(fs.readFileSync(destination)));
            assert.deepStrictEqual(fs.readdirSync(path.dirname(destination)), ['core.db'], 'no partial file left');
        });

        test('discards a download whose hash or size differs and keeps what was there', async () => {
            const destination = path.join(scratch, 'kept', 'core.db');
            fs.mkdirSync(path.dirname(destination));
            fs.writeFileSync(destination, 'the old index');
            await assert.rejects(downloadVerified(`${base}/short.db`, destination, sampleLock), /does not match the lock/);
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'the old index');
            assert.deepStrictEqual(fs.readdirSync(path.dirname(destination)), ['core.db']);
            await assert.rejects(downloadVerified(`${base}/absent.db`, destination, sampleLock), /answered 404/);
        });

        test('fetchIndex keeps a pinned index, downloads a missing one and replaces an unpinned one', async () => {
            const lock: CoreIndexLock = { ...sampleLock, url: `${base}/index.db` };
            assert.strictEqual(await fetchIndex(fakeRepo(lock, content), lock), 'kept');
            const missing = fakeRepo(lock);
            assert.strictEqual(await fetchIndex(missing, lock), 'downloaded');
            assert.strictEqual(sha256OfFile(path.join(missing, INDEX_RELATIVE)), lock.sha256);
            const unpinned = fakeRepo(lock, Buffer.from('a rebuilt index'));
            assert.strictEqual(await fetchIndex(unpinned, lock), 'replaced');
            assert.deepStrictEqual(indexState(unpinned, lock).kind, 'pinned');
        });

        test('fetchSources keeps the committed SOURCES.md, downloads a missing one, replaces an older one, and does nothing without a lock entry', async () => {
            const lock: CoreIndexLock = { ...withSources, url: `${base}/index.db`, sources: `${base}/SOURCES.md` };
            assert.strictEqual(await fetchSources(fakeRepo(sampleLock, content), sampleLock), 'none');
            assert.strictEqual(await fetchSources(fakeRepo(lock, content, sourcesText), lock), 'kept');
            const missing = fakeRepo(lock, content);
            assert.strictEqual(await fetchSources(missing, lock), 'downloaded');
            assert.ok(sourcesText.equals(fs.readFileSync(path.join(missing, SOURCES_RELATIVE))));
            const older = fakeRepo(lock, content, Buffer.from('older'));
            assert.strictEqual(await fetchSources(older, lock), 'replaced');
            assert.deepStrictEqual(sourcesState(older, lock).kind, 'pinned');
            // A download whose hash differs is discarded; the size is not part of the lock for this file.
            const wrong: CoreIndexLock = { ...lock, sourcesSha256: sha256Of('something else') };
            await assert.rejects(fetchSources(fakeRepo(wrong, content), wrong), /does not match the lock/);
        });
    });
});
