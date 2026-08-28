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
import { collectUserDocs, globToRegex, importUserDoc, readManifest, resolveUserDocsDir, userScopeDir } from '../core/packDocs/userDocs';
import { PackDocsHandler } from '../packDocsHandler';
import { FakeExtractor, buildWorld } from './packDocsHandler.test';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

function touch(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
}

const TARGET = {
    devicePack: { vendor: 'Keil', name: 'STM32U5xx_DFP', version: '2.1.0' },
    boardPack: { vendor: 'Keil', name: 'B-U585I-IOT02A_BSP', version: '1.0.0' },
    device: 'STM32U585AIIx',
    board: 'B-U585I-IOT02A',
    cores: ['Cortex-M33'],
};

suite('userDocs', () => {
    test('folders attribute documents to packs, vendors, devices, boards, cores or everything; docs.json supplies title, category, edition', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-user-'));
        touch(path.join(root, 'everyone.pdf'));
        touch(path.join(root, 'Keil', 'STM32U5xx_DFP', 'RM0456-nda.pdf'));
        touch(path.join(root, 'Keil', 'STM32U5xx_DFP', 'sub', 'AN-deep.pdf'));
        touch(path.join(root, 'Keil', 'vendor-wide.pdf'));
        touch(path.join(root, 'Keil', 'STM32F7xx_DFP', 'other-pack.pdf'));
        touch(path.join(root, 'Infineon', 'XMC4000_DFP', 'other-vendor.pdf'));
        touch(path.join(root, 'devices', 'STM32U5*', 'errata-prelim.pdf'));
        touch(path.join(root, 'devices', 'STM32H7*', 'wrong-family.pdf'));
        touch(path.join(root, 'boards', 'B-U585I-IOT02A', 'schematic.pdf'));
        touch(path.join(root, 'cores', 'cortex-m33', 'trm-notes.pdf'));
        touch(path.join(root, 'cores', 'Cortex-M7', 'not-mine.pdf'));
        touch(path.join(root, '.hidden', 'ignored.pdf'));
        fs.writeFileSync(path.join(root, 'Keil', 'STM32U5xx_DFP', 'docs.json'), JSON.stringify({
            'RM0456-nda.pdf': { title: 'STM32U5 reference manual', category: 'manual', revision: 'Rev 2 (NDA)' },
        }));

        const r = collectUserDocs(root, TARGET);
        assert.deepStrictEqual(r.docs.map(d => d.id).sort(), [
            'user/an-deep', 'user/errata-prelim', 'user/everyone', 'user/rm0456-nda', 'user/schematic', 'user/trm-notes', 'user/vendor-wide',
        ]);
        assert.deepStrictEqual(r.matched, ['.', 'Keil', 'Keil/STM32U5xx_DFP', 'boards/B-U585I-IOT02A', 'cores/cortex-m33', 'devices/STM32U5*']);
        const rm = r.docs.find(d => d.id === 'user/rm0456-nda')!;
        assert.strictEqual(rm.title, 'STM32U5 reference manual');
        assert.strictEqual(rm.category, 'manual');
        assert.strictEqual(rm.revision, 'Rev 2 (NDA)');
        assert.strictEqual(rm.scope, 'user');
        assert.strictEqual(rm.source, 'user');
        assert.strictEqual(rm.path, path.join(root, 'Keil', 'STM32U5xx_DFP', 'RM0456-nda.pdf'));
        assert.strictEqual(r.docs.find(d => d.id === 'user/everyone')!.title, 'everyone');
        assert.deepStrictEqual(r.notes, []);

        const other = collectUserDocs(root, { devicePack: { vendor: 'NXP', name: 'MCXN947_DFP' }, device: 'MCXN947', cores: ['Cortex-M33'] });
        assert.deepStrictEqual(other.docs.map(d => d.id).sort(), ['user/everyone', 'user/trm-notes']);
        assert.deepStrictEqual(collectUserDocs(path.join(root, 'missing'), TARGET).docs, []);
    });

    test('globs, scope folders and the default directory', () => {
        assert.ok(globToRegex('STM32U5*').test('STM32U585AIIx'));
        assert.ok(!globToRegex('STM32U5*').test('STM32H743'));
        assert.ok(globToRegex('stm32u585aiix').test('STM32U585AIIx'), 'case-insensitive');
        assert.ok(globToRegex('B-U585I-IOT02?').test('B-U585I-IOT02A'));
        assert.ok(!globToRegex('STM32U5').test('STM32U585'), 'plain names match exactly');
        const root = '/r';
        assert.strictEqual(userScopeDir(root, { kind: 'all' }), root);
        assert.strictEqual(userScopeDir(root, { kind: 'pack', vendor: 'Keil', name: 'STM32U5xx_DFP' }), path.join(root, 'Keil', 'STM32U5xx_DFP'));
        assert.strictEqual(userScopeDir(root, { kind: 'device', pattern: 'STM32U5*' }), path.join(root, 'devices', 'STM32U5*'));
        assert.strictEqual(userScopeDir(root, { kind: 'board', pattern: 'a/b' }), path.join(root, 'boards', 'a_b'), 'path separators are neutralised');
        assert.strictEqual(userScopeDir(root, { kind: 'core', core: 'Cortex-M33' }), path.join(root, 'cores', 'Cortex-M33'));
        assert.strictEqual(resolveUserDocsDir('', '/home/x'), path.join('/home/x', '.cmsis-pack-docs', 'user'));
        assert.strictEqual(resolveUserDocsDir('~/docs', '/home/x'), path.join('/home/x', 'docs'));
        assert.strictEqual(resolveUserDocsDir('/abs/dir', '/home/x'), '/abs/dir');
    });

    test('importUserDoc copies into the scope folder, records the manifest, and the document is then listed for the target', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-user-'));
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-src-'));
        const file = path.join(src, 'RM0456 (NDA).pdf');
        touch(file);
        const r = importUserDoc(root, { kind: 'pack', vendor: 'Keil', name: 'STM32U5xx_DFP' }, file, { title: 'STM32U5 RM', category: 'manual', revision: ' Rev 2 ' });
        assert.strictEqual(r.dest, path.join(root, 'Keil', 'STM32U5xx_DFP', 'RM0456 (NDA).pdf'));
        assert.strictEqual(r.id, 'user/rm0456-nda');
        assert.strictEqual(r.replaced, false);
        assert.ok(fs.existsSync(r.dest));
        assert.deepStrictEqual(readManifest(r.dir), { 'RM0456 (NDA).pdf': { title: 'STM32U5 RM', category: 'manual', revision: 'Rev 2' } });
        const again = importUserDoc(root, { kind: 'pack', vendor: 'Keil', name: 'STM32U5xx_DFP' }, file, { revision: 'Rev 3' });
        assert.strictEqual(again.replaced, true);
        assert.deepStrictEqual(readManifest(r.dir)['RM0456 (NDA).pdf'], { title: 'STM32U5 RM', category: 'manual', revision: 'Rev 3' }, 'metadata merges');
        const listed = collectUserDocs(root, TARGET);
        assert.deepStrictEqual(listed.docs.map(d => `${d.id}:${d.title}:${d.revision}`), ['user/rm0456-nda:STM32U5 RM:Rev 3']);
        importUserDoc(root, { kind: 'all' }, file);
        assert.ok(fs.existsSync(path.join(root, 'RM0456 (NDA).pdf')));
        assert.ok(!fs.existsSync(path.join(root, 'docs.json')), 'no manifest without metadata');
    });

    test('user documents join the target set: listed in their own group, searched by default, cited with their edition', async () => {
        const world = buildWorld();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-user-'));
        touch(path.join(root, 'Keil', 'STM32F7xx_DFP', 'nda-manual.pdf'));
        fs.writeFileSync(path.join(root, 'Keil', 'STM32F7xx_DFP', 'docs.json'), JSON.stringify({ 'nda-manual.pdf': { title: 'NDA manual', category: 'manual', revision: 'Rev 1' } }));
        const host = { ...world.host, settings: () => ({ ...world.host.settings(), userDocsDir: root }) };
        const h = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['1 Secret\nUSART_CR1 UE bit', '2 More']) });
        const list = await h.handleListTargetDocs({});
        assert.match(list, new RegExp(`User documents \\(${root.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}: Keil\\/STM32F7xx_DFP\\):\\n  user\\/nda-manual · user \\[manual\\] · NDA manual · 1 kB, not indexed yet\\n`));
        const search = await h.handleSearchTargetDocs({ query: 'USART_CR1', doc: 'nda-manual' });
        assert.match(search, /#1 user\/nda-manual \[Rev 1\] p\.1 §1 Secret/);
        const listed = await h.handleListTargetDocs({});
        assert.match(listed, /user\/nda-manual · user \[manual\] · NDA manual · indexed Rev 1, 2 p/);
        assert.match(listed, /searchable \(2 in packs, 1 user, 2 in the workspace; /);
        const inspect = await h.inspectTarget({});
        assert.strictEqual(inspect.userDir, root);
        assert.deepStrictEqual(inspect.userMatched, ['Keil/STM32F7xx_DFP']);
        assert.deepStrictEqual(inspect.cores, ['Cortex-M7']);
    });
});
