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
 * End to end through the handler: a synthetic pack root with the trimmed
 * pdsc fixtures and the two-page test PDF, a workspace with a cbuild-run
 * file, and the three tools. Real pdftotext when present; the search and
 * read tests skip otherwise.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PackDocsHost, PackDocsLog, defaultSettings } from '../core/packDocs/host';
import { PdfExtractor, PdftotextExtractor } from '../core/packDocs/pdfExtract';
import { resolveTarget } from '../core/packDocs/targetDocs';
import { PackDocsHandler } from '../packDocsHandler';
import { SAMPLE_CBUILD_RUN } from './cbuildRun.test';
import { ARM_ROUTES, fakeFetch, json, pdf } from './webFetch.test';

export class FakeExtractor implements PdfExtractor {
    readonly name = 'fake';
    constructor(private readonly pages: string[]) { }
    async available() { return { ok: true, detail: 'fake' }; }
    async extract() { return { pages: this.pages, extractor: this.name, ms: 1 }; }
}

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

export interface World {
    root: string;
    packRoot: string;
    workspace: string;
    host: PackDocsHost;
    lines: string[];
    fetchCalls: { url: string; init?: RequestInit }[];
}

export function buildWorld(): World {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-e2e-'));
    const packRoot = path.join(root, 'packs');
    const dfp = path.join(packRoot, 'Keil', 'STM32F7xx_DFP', '3.0.0');
    const bsp = path.join(packRoot, 'Keil', 'NUCLEO-F756ZG_BSP', '2.0.0');
    fs.mkdirSync(path.join(dfp, 'Documentation'), { recursive: true });
    fs.mkdirSync(path.join(dfp, 'CMSIS', 'SVD'), { recursive: true });
    fs.mkdirSync(path.join(bsp, 'Documents'), { recursive: true });
    // The DFP fixture lists web books only; add a local one, an unlisted PDF, and an SVD for the STM32F756ZG device.
    const pdsc = fs.readFileSync(path.join(FIXTURES, 'Keil.STM32F7xx_DFP.pdsc'), 'utf-8')
        .replace('<subFamily DsubFamily="STM32F756">', '<subFamily DsubFamily="STM32F756">\n        <book name="Documentation/test-rm.pdf" title="Test Reference Manual" category="manual"/>')
        .replace('<device Dname="STM32F756ZG">', '<device Dname="STM32F756ZG">\n          <debug svd="CMSIS/SVD/test.svd"/>');
    fs.writeFileSync(path.join(dfp, 'Keil.STM32F7xx_DFP.pdsc'), pdsc);
    fs.copyFileSync(path.join(FIXTURES, 'test.svd'), path.join(dfp, 'CMSIS', 'SVD', 'test.svd'));
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), path.join(dfp, 'Documentation', 'test-rm.pdf'));
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), path.join(dfp, 'Documentation', 'unlisted-errata.pdf'));
    fs.copyFileSync(path.join(FIXTURES, 'Keil.NUCLEO-F756ZG_BSP.pdsc'), path.join(bsp, 'Keil.NUCLEO-F756ZG_BSP.pdsc'));
    fs.writeFileSync(path.join(bsp, 'Documents', 'README.md'), '# guide');

    const workspace = path.join(root, 'ws');
    fs.mkdirSync(path.join(workspace, 'out', 'Blinky', 'STM32F756ZGTx', 'Debug'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'out', 'Blinky', 'STM32F756ZGTx', 'Debug', 'Blinky+STM32F756ZGTx.cbuild-run.yml'), SAMPLE_CBUILD_RUN);
    // Documents the user dropped into the workspace docs folders.
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.agent-artifacts', 'docs'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), path.join(workspace, 'docs', 'board-um.pdf'));
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), path.join(workspace, '.agent-artifacts', 'docs', 'vendor-rm.pdf'));

    const lines: string[] = [];
    const log: PackDocsLog = {
        debug: (m) => lines.push(`D ${m}`), info: (m) => lines.push(`I ${m}`), warn: (m) => lines.push(`W ${m}`),
        error: (m, e) => lines.push(`E ${m} ${e instanceof Error ? e.message : e ?? ''}`),
    };
    // arm.com as the fixtures saw it, plus the Cortex-M7 GUG the DFP links (served with the Armv8-M ARM's JSON, retitled).
    const gug = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'arm', 'ddi0553-latest.json'), 'utf-8'));
    gug.document = 'dui0646'; gug.title = 'Cortex-M7 Devices Generic User Guide'; gug.version = 'a'; gug.versionLabel = 'r1p2';
    gug._links.resources = [{ href: 'https://documentation-service.arm.com/static/000000000000000000000646?token=', name: 'DUI0646C_cortex_m7_dgug.pdf', extension: 'pdf', contentType: 'application/pdf' }];
    const fake = fakeFetch({
        ...ARM_ROUTES,
        'https://documentation-service.arm.com/documentation/dui0646/latest': () => new Response(JSON.stringify(gug), { status: 200, headers: { 'content-type': 'application/json' } }),
        'https://documentation-service.arm.com/static/000000000000000000000646': pdf(fs.readFileSync(path.join(FIXTURES, 'test-rm.pdf')), 'DUI0646C_cortex_m7_dgug.pdf'),
        'https://documentation-service.arm.com/documentation/ddi0000/latest': json('html-only.json'),
    });

    const host: PackDocsHost = {
        packRoot,
        storageDir: path.join(root, 'store'),
        assetsDir: path.join(__dirname, '..', '..', '..', 'assets'),
        settings: () => defaultSettings,
        log,
        userAgent: 'cmsis-pack-docs/test',
        fetchFn: fake.fn,
        workspaceFolders: () => [workspace],
        findCbuildRunFiles: async () => [path.join(workspace, 'out', 'Blinky', 'STM32F756ZGTx', 'Debug', 'Blinky+STM32F756ZGTx.cbuild-run.yml')],
    };
    return { root, packRoot, workspace, host, lines, fetchCalls: fake.calls };
}

suite('PackDocsHandler (end to end)', () => {
    let world: World;
    let handler: PackDocsHandler;
    let havePdftotext = false;

    suiteSetup(async () => {
        world = buildWorld();
        handler = new PackDocsHandler(world.host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace });
        havePdftotext = (await new PdftotextExtractor().available()).ok;
    });

    test('resolveTarget reads the workspace cbuild-run and falls back to installed pack versions', async () => {
        const res = await resolveTarget(world.host, {});
        assert.ok(!('error' in res));
        assert.strictEqual(res.device?.name, 'STM32F756ZGTx');
        assert.strictEqual(res.devicePack?.version, '3.0.0');
        const byPack = await resolveTarget(world.host, { pack: 'Keil::STM32F7xx_DFP', device: 'STM32F756ZGTx' });
        assert.ok(!('error' in byPack));
        assert.match(byPack.notes[0], /using installed 3\.0\.0/);
        const none = await resolveTarget({ ...world.host, findCbuildRunFiles: async () => [] }, {});
        assert.ok('error' in none);
        assert.match(none.error, /No \*\.cbuild-run\.yml found in the workspace/);
        const missing = await resolveTarget(world.host, { target: 'nonexistent' });
        assert.ok('error' in missing && /No cbuild-run context matches target 'nonexistent'/.test(missing.error));
    });

    test('list_target_docs lists device, family, board, unlisted and workspace documents with states', async () => {
        const text = await handler.handleListTargetDocs({});
        assert.match(text, /^Target: device STMicroelectronics::STM32F756ZGTx, device-pack Keil::STM32F7xx_DFP@3\.0\.0, board NUCLEO-F756ZG:Rev\.B, board-pack Keil::NUCLEO-F756ZG_BSP@2\.0\.0 — from out\/Blinky/);
        assert.match(text, /stm32f7xx-dfp\/test-rm · subFamily \[manual\] · Test Reference Manual · 1 kB, not indexed yet/);
        assert.match(text, /stm32f7xx-dfp\/stm32f756bg · subFamily · STM32F756 Data Sheet · web — not fetched \(fetch_doc \{ doc: 'stm32f7xx-dfp\/stm32f756bg' \}\)/);
        assert.match(text, /arm\/dui0646-latest · family · Cortex-M7 Generic User Guide · web — not fetched/);
        assert.match(text, /stm32f7xx-dfp\/unlisted-errata · unlisted · unlisted-errata/);
        assert.match(text, /nucleo-f756zg-bsp\/um1974[^\n]* · board \[manual\] · User Manual · web — not fetched/);
        assert.match(text, /nucleo-f756zg-bsp\/readme · board \[other\] · Guide · not a PDF/);
        assert.match(text, /\nCore: Cortex-M7 r0p1 \(Armv7-M\)\n/);
        assert.match(text, /Arm documents for Cortex-M7 r0p1 \(Armv7-M\) \(id · kind · title · state\)[^\n]*\n  arm\/ddi0403-latest · arch · ARMv7-M Architecture Reference Manual · web — not fetched \(fetch_doc \{ doc: 'arm\/ddi0403-latest' \}\)\n  arm\/ihi0031-latest · adi · /);
        assert.match(text, /\n  arm\/ddi0489-latest · trm · Cortex-M7 Processor Technical Reference Manual · web — not fetched/);
        assert.doesNotMatch(text, /arm\/ddi0553-latest/, 'Armv8-M documents are not offered for a Cortex-M7');
        assert.match(text, /Workspace documents \(ws\/\.agent-artifacts\/docs, ws\/docs\):\n  workspace\/board-um · workspace · board-um · 1 kB, not indexed yet\n  workspace\/vendor-rm · workspace · vendor-rm · 1 kB, not indexed yet/);
        assert.match(text, /4 searchable \(2 in packs, 2 in the workspace; 0 indexed\), \d+ on the web not fetched/);
        assert.ok(world.lines.some(l => /\[list_target_docs #1\] → \{\}/.test(l)), 'call trace');
        assert.ok(world.lines.some(l => /\[list_target_docs #1\] ← \d+ ms, \d+ bytes/.test(l)), 'result trace');
    });

    test('search_target_docs indexes on first use and cites page and section', async function () {
        if (!havePdftotext) { this.skip(); return; }
        const text = await handler.handleSearchTargetDocs({ query: 'GPIOAEN clock enable' });
        assert.match(text, /Indexed now: stm32f7xx-dfp\/test-rm \(2 p, [\d.]+ s\), workspace\/board-um \(2 p, [\d.]+ s\), workspace\/vendor-rm \(2 p, [\d.]+ s\)\n/,
            'the attributed book and the workspace documents are indexed, the unlisted PDF is not');
        assert.match(text, /Searched 3 documents \(6 pages\)/);
        assert.match(text, /#1 (stm32f7xx-dfp\/test-rm|workspace\/[a-z-]+) p\.1 §6\.3\.10 RCC AHB1 peripheral clock enable register \(RCC_AHB1ENR\)/);
        assert.match(text, /«GPIOAEN»/);
        assert.match(text, /Not searched: \d+ web documents/);
        assert.match(text, /Not searched: 1 unlisted PDF in the pack/);
        assert.ok(world.lines.some(l => /extracting test-rm\.pdf/.test(l)), 'extraction trace');

        const withUnlisted = await handler.handleSearchTargetDocs({ query: 'GPIOAEN clock enable', includeUnlisted: true });
        assert.match(withUnlisted, /Indexed now: stm32f7xx-dfp\/unlisted-errata/);
        assert.match(withUnlisted, /Searched 4 documents \(8 pages\)/);
        assert.doesNotMatch(withUnlisted, /unlisted PDF in the pack/);

        const again = await handler.handleSearchTargetDocs({ query: '0x40023800', doc: 'test-rm' });
        assert.doesNotMatch(again, /Indexed now/);
        assert.match(again, /Searched 1 document \(2 pages\)/);
        assert.match(again, /#1 stm32f7xx-dfp\/test-rm p\.2/);

        const ws = await handler.handleSearchTargetDocs({ query: '0x40023800', doc: 'workspace/board-um' });
        assert.match(ws, /Searched 1 document \(2 pages\)/);
        assert.match(ws, /#1 workspace\/board-um p\.2/);

        const listed = await handler.handleListTargetDocs({});
        assert.match(listed, /Test Reference Manual · indexed, 2 p/);
        assert.match(listed, /workspace\/board-um · workspace · board-um · indexed, 2 p/);
        assert.match(listed, /4 searchable \(2 in packs, 2 in the workspace; 4 indexed\)/);
    });

    test('read_doc_pages returns the page text under the budget', async function () {
        if (!havePdftotext) { this.skip(); return; }
        const text = await handler.handleReadDocPages({ doc: 'stm32f7xx-dfp/test-rm', pages: '2' });
        assert.match(text, /^— stm32f7xx-dfp\/test-rm p\.2 §6\.3\.11 RCC AHB2 peripheral clock enable register \(RCC_AHB2ENR\) \(of 2\) —/);
        assert.match(text, /OTGFSEN/);
        const short = await handler.handleReadDocPages({ doc: 'test-rm', pages: '1-2', maxChars: 500 });
        assert.match(short, /p\.1 .*—\n/);
        const bad = await handler.handleReadDocPages({ doc: 'test-rm', pages: '9' });
        assert.match(bad, /beyond the last page \(2\)/);
        const ws = await handler.handleReadDocPages({ doc: 'workspace/vendor-rm', pages: '1' });
        assert.match(ws, /^— workspace\/vendor-rm p\.1 §6\.3\.10 RCC AHB1/);
        const web = await handler.handleReadDocPages({ doc: 'stm32f7xx-dfp/stm32f756bg', pages: '1' });
        assert.match(web, /is not fetched yet — call fetch_doc \{ doc: 'stm32f7xx-dfp\/stm32f756bg' \}/);
    });

    test('fetch_doc downloads an arm.com document through the service API, indexes it, and makes it searchable and citable with its edition', async () => {
        const h = new PackDocsHandler(world.host, {
            timeoutMs: 30_000, workspaceRoot: () => world.workspace,
            extractor: new FakeExtractor(['1 Debug\nDHCSR C_DEBUGEN halting', '2 Reset\nSYSRESETREQ VECTRESET']),
        });
        assert.match(await h.handleFetchDoc({}), /Pass doc .* or url/);
        assert.match(await h.handleFetchDoc({ doc: 'no-such-doc' }), /No document with id 'no-such-doc'/);
        assert.match(await h.handleFetchDoc({ doc: 'stm32f7xx-dfp/test-rm' }), /is a local document/);
        assert.match(await h.handleFetchDoc({ url: 'ftp://x/y.pdf' }), /is not an http\(s\) URL/);

        // The pdsc-linked Cortex-M7 GUG, by its id.
        const fetched = await h.handleFetchDoc({ doc: 'arm/dui0646-latest' });
        assert.match(fetched, /^Fetched arm\/dui0646-latest — Cortex-M7 Devices Generic User Guide, version a \(r1p2\), DUI0646C_cortex_m7_dgug\.pdf, 1 kB → indexed 2 p in [\d.]+ s\.\nFrom https:\/\/developer\.arm\.com\/documentation\/dui0646\/latest \(arm\.com\); cached in the extension storage/);
        assert.match(fetched, /Cite as arm\/dui0646-latest r1p2 p\.<n>\./);
        assert.match(await h.handleFetchDoc({ doc: 'dui0646' }), /^Already fetched arm\/dui0646-latest — Cortex-M7 Devices Generic User Guide, version a \(r1p2\), 1 kB; indexed 2 p/);

        const search = await h.handleSearchTargetDocs({ query: 'C_DEBUGEN', doc: 'dui0646' });
        assert.match(search, /Searched 1 document \(2 pages\)/);
        assert.match(search, /#1 arm\/dui0646-latest \[r1p2\] p\.1 §1 Debug/);
        const all = await h.handleSearchTargetDocs({ query: 'VECTRESET' });
        assert.match(all, /#1 arm\/dui0646-latest \[r1p2\] p\.2/, 'fetched documents are searched by default');
        assert.match(all, /Not searched: \d+ web documents not fetched yet \(stm32f7xx-dfp\/[^)]*\) — fetch_doc \{ doc \} makes one searchable\./);
        const page = await h.handleReadDocPages({ doc: 'arm/dui0646-latest', pages: '2' });
        assert.match(page, /^— arm\/dui0646-latest \[r1p2\] p\.2 §2 Reset \(of 2\) —\n/);
        const listed = await h.handleListTargetDocs({});
        assert.match(listed, /arm\/dui0646-latest · family · Cortex-M7 Devices Generic User Guide · indexed r1p2, 2 p/);

        // An Arm document outside the target's catalogue (Armv8-M for a Cortex-M7), by its bare id and by URL; an HTML-only one; a dead URL.
        const arm = await h.handleFetchDoc({ doc: 'ddi0553' });
        assert.match(arm, /^Fetched arm\/ddi0553-latest — Armv8-M Architecture Reference Manual, version bz \(B\.z\), DDI0553B_z_armv8m_arm\.pdf/);
        assert.match(await h.handleFetchDoc({ url: 'https://developer.arm.com/documentation/ddi0553/latest' }), /^Already fetched arm\/ddi0553-latest/);
        assert.match(await h.handleReadDocPages({ doc: 'arm/ddi0553-latest', pages: '1' }), /^— arm\/ddi0553-latest \[B\.z\] p\.1/);
        // Fetched documents join the target's set from the store, so a new handler (a new session) searches and lists them.
        const h2 = new PackDocsHandler(world.host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        const later = await h2.handleSearchTargetDocs({ query: 'C_DEBUGEN', doc: 'ddi0553' });
        assert.match(later, /#1 arm\/ddi0553-latest \[B\.z\] p\.1 §1 Debug/);
        const relisted = await h2.handleListTargetDocs({});
        assert.match(relisted, /\n  arm\/ddi0553-latest · arch · Armv8-M Architecture Reference Manual · indexed B\.z, 2 p\n/);
        assert.match(relisted, /searchable \(2 in packs, 2 in the workspace, 2 fetched; \d indexed\)/);
        // A bare id takes the catalogue's pinned version; 'latest' can still be asked for explicitly.
        assert.match(await h.handleFetchDoc({ doc: 'ddi0439' }), /^Fetched arm\/ddi0439-b — /);
        const errata = await h.handleFetchDoc({ doc: 'ddi0439-latest' });
        assert.match(errata, /^Fetched arm\/ddi0439-latest — Cortex-M4 Technical Reference Manual - ARM DDI 0439B Errata 01/);
        assert.match(errata, /Note: this edition is an errata document; other editions: b \(r0p0\) — fetch_doc \{ doc: 'arm\/ddi0439-b' \}/);
        const html = await h.handleFetchDoc({ doc: 'ddi0000' });
        assert.match(html, /^Could not fetch arm\/ddi0000-latest: arm\/ddi0000-latest is published as HTML on arm\.com \(HTMLPDF\); this version fetches PDFs only\.\nDocument: Example HTML-only Document, edition r1p2, version f\.\nURL: https:\/\/developer\.arm\.com\/documentation\/ddi0000\/latest\nAlternative: download the PDF yourself into \.agent-artifacts\/docs/);
        const dead = await h.handleFetchDoc({ url: 'https://developer.arm.com/documentation/??' });
        assert.match(dead, /^Could not fetch web\/developer-arm-com\/[0-9a-f]{12}: .*HTTP 404/);
        assert.ok(world.fetchCalls.length >= 6, 'requests were made');
        assert.ok(world.fetchCalls.every(c => (c.init?.headers as Record<string, string>)['User-Agent'] === 'cmsis-pack-docs/test'), 'every request identifies the extension');
    });

    test('a per-call timeout turns into a message instead of a hang', async () => {
        const slowHost: PackDocsHost = { ...world.host, findCbuildRunFiles: () => new Promise(resolve => setTimeout(() => resolve([]), 400)) };
        const h = new PackDocsHandler(slowHost, { timeoutMs: 100 });
        const text = await h.handleListTargetDocs({});
        assert.match(text, /list_target_docs timed out after 100 ms/);
    });
});
