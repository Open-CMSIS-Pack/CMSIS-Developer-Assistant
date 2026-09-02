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
import * as path from 'path';
import { collectBooks, dedupeIds, loadPdsc, slug, sortDocs } from '../core/packDocs/pdscBooks';

// Trimmed copies of real pdsc files: the STM32F756 subFamily of Keil.STM32F7xx_DFP 3.0.0
// (web books only), the XMC4700 subFamily of Infineon.XMC4000_DFP 2.14.0 (local books)
// and the whole Keil.NUCLEO-F756ZG_BSP 2.1.0 (board books).
const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

suite('pdscBooks', () => {
    test('a device variant inherits the books of its device, subFamily and family (STM32F756ZGTx)', () => {
        const pdsc = loadPdsc(path.join(FIXTURES, 'Keil.STM32F7xx_DFP.pdsc'), { vendor: 'Keil', name: 'STM32F7xx_DFP', version: '3.0.0' });
        const { docs, notes } = collectBooks(pdsc, { deviceName: 'STM32F756ZGTx' });
        assert.deepStrictEqual(notes, []);
        const byTitle = Object.fromEntries(docs.map(d => [d.title, d]));
        assert.ok(byTitle['STM32F74xx/5xx Reference Manual'], 'subFamily-level reference manual');
        assert.strictEqual(byTitle['STM32F74xx/5xx Reference Manual'].scope, 'subFamily');
        assert.strictEqual(byTitle['STM32F74xx/5xx Reference Manual'].source, 'web');
        assert.ok(byTitle['STM32F756 Data Sheet'], 'subFamily-level data sheet');
        assert.strictEqual(byTitle['STM32F756 Data Sheet'].scope, 'subFamily');
        assert.strictEqual(byTitle['STM32F756 Data Sheet'].id, 'stm32f7xx-dfp/stm32f756bg');
        assert.strictEqual(byTitle['STM32F7xx HAL Drivers'].scope, 'family');
        assert.strictEqual(byTitle['Cortex-M7 Generic User Guide'].scope, 'family');
        // Arm documents get their arm.com identity, whichever pack links them.
        assert.strictEqual(byTitle['Cortex-M7 Generic User Guide'].id, 'arm/dui0646-latest');
        assert.deepStrictEqual(byTitle['Cortex-M7 Generic User Guide'].arm, { docId: 'dui0646', version: 'latest' });
        assert.strictEqual(docs.length, 4);
        assert.ok(docs.every(d => d.pack === 'Keil::STM32F7xx_DFP@3.0.0'));
    });

    test('an unknown device falls back to family-level books with a note', () => {
        const pdsc = loadPdsc(path.join(FIXTURES, 'Keil.STM32F7xx_DFP.pdsc'), { vendor: 'Keil', name: 'STM32F7xx_DFP', version: '3.0.0' });
        const { docs, notes } = collectBooks(pdsc, { deviceName: 'STM32F999XX' });
        assert.strictEqual(notes.length, 1);
        assert.match(notes[0], /STM32F999XX is not in Keil.STM32F7xx_DFP.pdsc/);
        assert.ok(docs.length >= 1);
        assert.ok(docs.every(d => d.scope === 'family'));
    });

    test('local books resolve against the pack directory and report missing files (XMC4700)', () => {
        const pdsc = loadPdsc(path.join(FIXTURES, 'Infineon.XMC4000_DFP.pdsc'), { vendor: 'Infineon', name: 'XMC4000_DFP', version: '2.14.0' });
        const { docs } = collectBooks(pdsc, { deviceName: 'XMC4700-F144x2048' });
        const rm = docs.find(d => d.title === 'XMC4700 Series Reference Manual');
        assert.ok(rm);
        assert.strictEqual(rm.source, 'pack');
        assert.strictEqual(rm.path, path.join(FIXTURES, 'Documents', 'Infineon-ReferenceManual_XMC4700_XMC4800-UM-v01_03-EN.pdf'));
        assert.strictEqual(rm.missing, true, 'fixture directory has no Documents/');
        assert.strictEqual(rm.id, 'xmc4000-dfp/infineon-referencemanual-xmc4700-xmc4800-um-v01-03-en');
        const chm = docs.find(d => d.title === 'XMC4 Peripheral Library');
        assert.ok(chm);
        assert.strictEqual(chm.unsupported, true);
        // The device and subFamily both list the reference manual; it is kept once, at the device scope.
        assert.strictEqual(docs.filter(d => d.title === 'XMC4700 Series Reference Manual').length, 1);
        assert.strictEqual(rm.scope, 'device');
    });

    test('board books come with their category (NUCLEO-F756ZG)', () => {
        const pdsc = loadPdsc(path.join(FIXTURES, 'Keil.NUCLEO-F756ZG_BSP.pdsc'), { vendor: 'Keil', name: 'NUCLEO-F756ZG_BSP', version: '2.1.0' });
        const { docs, notes } = collectBooks(pdsc, { boardName: 'nucleo-f756zg' });
        assert.deepStrictEqual(notes, []);
        assert.strictEqual(docs.length, 5);
        assert.ok(docs.every(d => d.scope === 'board'));
        const manual = docs.find(d => d.category === 'manual');
        assert.ok(manual);
        assert.strictEqual(manual.title, 'User Manual');
        assert.strictEqual(manual.id, 'nucleo-f756zg-bsp/um1974-stm32-nucleo144-boards-mb1137-stmicroelectronics');
        const guide = docs.find(d => d.title === 'Guide');
        assert.ok(guide);
        assert.strictEqual(guide.source, 'pack');
        assert.strictEqual(guide.unsupported, true);
    });

    test('an unknown board is reported and yields no board books', () => {
        const pdsc = loadPdsc(path.join(FIXTURES, 'Keil.NUCLEO-F756ZG_BSP.pdsc'), { vendor: 'Keil', name: 'NUCLEO-F756ZG_BSP', version: '2.1.0' });
        const { docs, notes } = collectBooks(pdsc, { boardName: 'NUCLEO-XYZ' });
        assert.strictEqual(docs.length, 0);
        assert.match(notes[0], /board NUCLEO-XYZ is not in .* \(has: NUCLEO-F756ZG\)/);
    });

    test('sorting puts device manuals first and dedupeIds suffixes clashes', () => {
        const mk = (id: string, scope: 'device' | 'family' | 'board', category?: 'manual' | 'schematic') => ({
            id, title: id, scope, category, pack: 'V::P@1', packId: { vendor: 'V', name: 'P', version: '1' }, source: 'web' as const, cached: false, indexed: false,
        });
        const sorted = sortDocs([mk('c', 'board', 'schematic'), mk('b', 'family', 'manual'), mk('a', 'device'), mk('a', 'device', 'manual')]);
        assert.deepStrictEqual(sorted.map(d => `${d.scope}:${d.category ?? '-'}`), ['device:manual', 'device:-', 'family:manual', 'board:schematic']);
        assert.deepStrictEqual(dedupeIds(sorted).map(d => d.id), ['a', 'a-2', 'b', 'c']);
        assert.strictEqual(slug('Infineon-ReferenceManual_XMC4700 (v1).pdf'), 'infineon-referencemanual-xmc4700-v1-pdf');
    });
});
