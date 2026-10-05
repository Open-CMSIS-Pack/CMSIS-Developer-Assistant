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

/** Catalog behavior against deterministic v2-shaped getters; no editor or board. */
import * as assert from 'assert';
import { discoverDevice, literalCatalogPattern } from '../core/deviceDiscovery';
import type { DiscoveryApi } from '../core/deviceDiscovery';
import { DISCOVERY_FIXTURES, fixtureCatalog } from './deviceDiscoveryFixtures';

suite('Device discovery', () => {
    for (const fixture of DISCOVERY_FIXTURES) {
        test(fixture.name, async () => {
            const catalog = fixtureCatalog(fixture, 250);
            const report = await discoverDevice(catalog.api, fixture.request);
            assert.strictEqual(report.status, fixture.expected);
            if (fixture.selected) { assert.strictEqual(report.device?.id, fixture.selected); }
            assert.strictEqual(report.evidence, 'catalog');
            assert.ok(!Object.hasOwn(report, 'coverage'));
            assert.ok(report.candidates.length <= (fixture.request.limit ?? 10));
            assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 16_000);
            assert.ok(catalog.calls.length <= 2, 'no speculative catalog retries');
            assert.strictEqual(catalog.details.length, new Set(catalog.details).size, 'each required property is read once');
            assert.ok(catalog.details.every(d => !d.startsWith('Unrelated')), 'irrelevant details stay lazy');
            if (report.status === 'resolved') { assert.ok(report.dfp); }
        });
    }

    test('all regex punctuation is literal and exact searches are anchored', () => {
        const name = 'A.[B](C)+?*^$|\\{D}';
        const exact = new RegExp(literalCatalogPattern(name));
        assert.ok(exact.test(name));
        assert.ok(!exact.test(`${name}-extra`));
        assert.ok(!exact.test(`prefix-${name}`));
        assert.ok(new RegExp(literalCatalogPattern(name, 'contains')).test(`prefix-${name}`));
    });

    test('separate and combined pack identities are retained without duplicates', async () => {
        for (const name of ['exact-separate-packs', 'combined-pack']) {
            const fixture = DISCOVERY_FIXTURES.find(f => f.name === name)!;
            const report = await discoverDevice(fixtureCatalog(fixture).api, fixture.request);
            assert.ok(report.bsp && report.dfp);
            assert.strictEqual(report.packs.length, name === 'combined-pack' ? 1 : 2);
            assert.ok(report.packs.every(p => p.endsWith('@1.0.0')));
        }
    });

    test('missing Pname is preserved; core type does not become a processor identifier', async () => {
        const fixture = DISCOVERY_FIXTURES.find(f => f.name === 'missing-processor-name')!;
        const report = await discoverDevice(fixtureCatalog(fixture).api, fixture.request);
        assert.strictEqual(report.processor, undefined);
        assert.deepStrictEqual(report.processors, [{ name: null, core: 'Cortex-M33' }]);
        const required = DISCOVERY_FIXTURES.find(f => f.name === 'required-missing-processor')!;
        const requiredReport = await discoverDevice(fixtureCatalog(required).api, required.request);
        assert.strictEqual(requiredReport.status, 'unresolved');
        assert.strictEqual(requiredReport.processor, undefined);
    });

    test('identity fields ignore boundary whitespace and reject normalized blanks', async () => {
        const fixture = DISCOVERY_FIXTURES.find(f => f.name === 'explicit-revision')!;
        const catalog = fixtureCatalog(fixture);
        const report = await discoverDevice(catalog.api, {
            kind: 'board', name: ' Acme::Eval ', vendor: ' Acme ', revision: ' B ', device: ' Acme::Chip1 ', processor: ' cpu0 ',
        });
        assert.strictEqual(report.status, 'resolved');
        assert.strictEqual(report.processor, 'cpu0');
        assert.strictEqual(report.board?.revision, 'B');

        const blank = await discoverDevice(catalog.api, { kind: 'board', name: 'Eval', revision: '   ' });
        assert.strictEqual(blank.status, 'unresolved');
        assert.match(blank.reason, /Revision/);
    });

    test('ambiguous and fuzzy board lists never hydrate device or pack details', async () => {
        for (const name of ['ambiguous-revisions', 'fuzzy-single-candidate']) {
            const fixture = DISCOVERY_FIXTURES.find(f => f.name === name)!;
            const catalog = fixtureCatalog(fixture);
            await discoverDevice(catalog.api, fixture.request);
            assert.deepStrictEqual(catalog.details, []);
            assert.strictEqual(catalog.calls.length, 1);
        }
    });

    test('truncation does not make the first candidate unique', async () => {
        const fixture = DISCOVERY_FIXTURES.find(f => f.name === 'bounded-fuzzy-list')!;
        const report = await discoverDevice(fixtureCatalog(fixture).api, fixture.request);
        assert.strictEqual(report.totalCandidates, 2);
        assert.strictEqual(report.candidates.length, 1);
        assert.strictEqual(report.truncated, true);
        assert.strictEqual(report.device, undefined);
    });

    test('identical device names from different vendors remain ambiguous', async () => {
        const fixture = { ...DISCOVERY_FIXTURES[4], devices: [{ name: 'Chip1', vendor: 'A' }, { name: 'Chip1', vendor: 'B' }] };
        const report = await discoverDevice(fixtureCatalog(fixture).api, fixture.request);
        assert.strictEqual(report.status, 'ambiguous');
        assert.deepStrictEqual(report.candidates.map(c => c.id), ['A::Chip1', 'B::Chip1']);
    });

    test('deduplicates identical identifiers without losing distinct revisions', async () => {
        const original = DISCOVERY_FIXTURES[0];
        const fixture = { ...original, boards: [...original.boards, ...original.boards] };
        const report = await discoverDevice(fixtureCatalog(fixture).api, fixture.request);
        assert.strictEqual(report.status, 'resolved');
    });

    test('a rejected DFP does not discard an already known BSP', async () => {
        const fixture = { ...DISCOVERY_FIXTURES[0], devices: [{ name: 'Chip1', fail: true }] };
        const report = await discoverDevice(fixtureCatalog(fixture).api, fixture.request);
        assert.strictEqual(report.status, 'unresolved');
        assert.strictEqual(report.bsp, 'Acme::Boards@1.0.0');
        assert.strictEqual(report.dfp, undefined);
        assert.ok(report.issues.some(i => i.includes('Device pack')));
    });

    test('activation failure and never-settling lists end without querying details', async () => {
        const unavailable = await discoverDevice(async () => { throw new Error('v2 unavailable'); }, { kind: 'device', name: 'Chip1' });
        assert.strictEqual(unavailable.status, 'unavailable');
        let queries = 0;
        const api: DiscoveryApi = {
            getBoards: async () => { queries++; return new Promise(() => {}); },
            getDevices: async () => { queries++; throw new Error('must not run'); },
        };
        const result = await discoverDevice(api, { kind: 'board', name: 'Eval', timeoutMs: 10 });
        assert.strictEqual(result.status, 'unavailable');
        assert.match(result.reason, /timed out/);
        assert.strictEqual(queries, 1);
    });

    test('a timed-out board detail starts no later device query, even after it settles', async () => {
        const catalog = fixtureCatalog(DISCOVERY_FIXTURES[0]);
        const [board] = await catalog.api.getBoards();
        let resolveDevices!: (value: never[]) => void;
        const hanging = new Promise<never[]>(resolve => { resolveDevices = resolve; });
        const api: DiscoveryApi = {
            getBoards: async () => [{ ...board, devices: hanging }],
            getDevices: async () => { throw new Error('must not start a later query'); },
        };
        const report = await discoverDevice(api, { kind: 'board', name: 'Eval', timeoutMs: 10 });
        assert.strictEqual(report.status, 'unresolved');
        assert.ok(report.issues.some(i => i.includes('timed out')));
        resolveDevices([]);
    });

    test('response byte limit refuses enormous identifiers without silently shortening them', async () => {
        const fixture = { ...DISCOVERY_FIXTURES[4], devices: [{ name: 'X'.repeat(20_000) }] };
        const report = await discoverDevice(fixtureCatalog(fixture).api, { kind: 'device', name: 'X', match: 'contains' });
        assert.strictEqual(report.status, 'unresolved');
        assert.strictEqual(report.truncated, true);
        assert.deepStrictEqual(report.candidates, []);
    });

    test('conflicting qualified vendor input is not misreported as a catalog outage', async () => {
        const catalog = fixtureCatalog(DISCOVERY_FIXTURES[4]);
        const report = await discoverDevice(catalog.api, { kind: 'device', name: 'Acme::Chip1', vendor: 'Other' });
        assert.strictEqual(report.status, 'unresolved');
        assert.match(report.reason, /Conflicting/);
        assert.deepStrictEqual(catalog.calls, []);
    });
});
