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
import { ARM_DOCS, archOf, armDocUrl, armDocsFor, catalogueVersion, knownNpuOf, lookupArmDoc, normalizeCore, normalizeNpu, parseArmDocUrl } from '../core/packDocs/armDocs';
import { armDocRef, collectNpus, collectProcessors, loadPdsc } from '../core/packDocs/pdscBooks';
import { describeProcessors } from '../core/packDocs/targetDocs';
import { parseXml } from '../core/packDocs/xmlLite';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

suite('armDocs catalogue', () => {
    test('cores map to their architecture in every spelling the pack cache uses', () => {
        assert.strictEqual(normalizeCore('Cortex-M0+'), 'Cortex-M0+');
        assert.strictEqual(normalizeCore('Cortex-M0plus'), 'Cortex-M0+');
        assert.strictEqual(normalizeCore('cortex-m33'), 'Cortex-M33');
        assert.strictEqual(normalizeCore('Cortex-M35P'), 'Cortex-M35P');
        assert.strictEqual(normalizeCore('ARMV8MML'), 'ARMV8MML');
        assert.strictEqual(archOf('Cortex-M0'), 'Armv6-M');
        assert.strictEqual(archOf('Cortex-M0+'), 'Armv6-M');
        assert.strictEqual(archOf('Cortex-M3'), 'Armv7-M');
        assert.strictEqual(archOf('Cortex-M4'), 'Armv7-M');
        assert.strictEqual(archOf('Cortex-M7'), 'Armv7-M');
        assert.strictEqual(archOf('SC300'), 'Armv7-M');
        assert.strictEqual(archOf('Cortex-M23'), 'Armv8-M');
        assert.strictEqual(archOf('Cortex-M33'), 'Armv8-M');
        assert.strictEqual(archOf('ARMV8MBL'), 'Armv8-M');
        assert.strictEqual(archOf('ARMV8MML'), 'Armv8-M');
        assert.strictEqual(archOf('Star-MC1'), 'Armv8-M');
        assert.strictEqual(archOf('Cortex-M55'), 'Armv8.1-M');
        assert.strictEqual(archOf('Cortex-M85'), 'Armv8.1-M');
        assert.strictEqual(archOf('ARMV81MML'), 'Armv8.1-M');
        assert.strictEqual(archOf('Star-MC3'), 'Armv8.1-M');
        assert.strictEqual(archOf('Cortex-M1'), 'Armv6-M');
        assert.strictEqual(archOf('SC000'), 'Armv6-M');
        assert.strictEqual(archOf('Cortex-A53'), undefined);
    });

    test('armDocsFor picks architecture, ADI, CoreSight, ETM and TRM documents for the core — never GUGs', () => {
        const m33 = armDocsFor(['Cortex-M33']).map(e => e.docId);
        assert.deepStrictEqual(m33, ['ddi0553', 'ihi0031', 'ihi0074', 'ihi0029', 'ddi0314', 'ddi0480', '100806', 'ihi0064', '100232', '100230']);
        const m7 = armDocsFor(['Cortex-M7']).map(e => e.docId);
        assert.ok(m7.includes('ddi0403') && m7.includes('ihi0064') && m7.includes('ddi0494') && m7.includes('ddi0489'));
        assert.ok(!m7.includes('ddi0553') && !m7.includes('dui0646') && !m7.includes('ihi0014'));
        const m4 = armDocsFor(['Cortex-M4']).map(e => e.docId);
        assert.ok(m4.includes('ihi0014') && m4.includes('ddi0440') && m4.includes('ddi0439') && !m4.includes('ihi0064'));
        const m0p = armDocsFor(['Cortex-M0+']).map(e => e.docId);
        assert.ok(m0p.includes('ddi0419') && m0p.includes('ddi0486') && m0p.includes('ddi0484'));
        const dual = armDocsFor(['Cortex-M33', 'Cortex-M0+']).map(e => e.docId);
        assert.ok(dual.includes('ddi0553') && dual.includes('ddi0419'));
        assert.strictEqual(new Set(dual).size, dual.length, 'no duplicates');
        const pseudo = armDocsFor(['ARMV81MML']).map(e => e.docId);
        assert.ok(pseudo.includes('ddi0553') && pseudo.includes('ihi0064') && !pseudo.some(id => ARM_DOCS.find(e => e.docId === id)!.kind === 'trm'));
        assert.deepStrictEqual(armDocsFor([]), []);
        // NPUs add their TRMs and never the other NPU's.
        const m85u85 = armDocsFor(['Cortex-M85'], ['Ethos-U85']).map(e => e.docId);
        assert.ok(m85u85.includes('101924') && m85u85.includes('102685') && m85u85.includes('102684'));
        assert.ok(!m85u85.includes('102420') && !m85u85.includes('102023'));
        assert.deepStrictEqual(armDocsFor(['Cortex-M55'], ['Ethos-U55', 'ethos u85']).filter(e => e.kind === 'npu').map(e => e.docId), ['102420', '102685', '102684']);
        assert.deepStrictEqual(armDocsFor([], ['Ethos-U65']).map(e => e.docId), ['102023'], 'an NPU alone yields only its documents');
        assert.strictEqual(normalizeNpu('Neural Processing Unit (NPU) Ethos-U55 HP'), 'Ethos-U55');
        assert.strictEqual(normalizeNpu('Cortex-M55'), undefined);
        assert.strictEqual(knownNpuOf('SSE-320-FVP'), 'Ethos-U85');
        assert.strictEqual(knownNpuOf('SSE-315-FVP'), 'Ethos-U65');
        assert.strictEqual(knownNpuOf('SSE-300-MPS3'), 'Ethos-U55');
        assert.strictEqual(knownNpuOf('SSE-310-MPS3_FVP'), 'Ethos-U55');
        assert.strictEqual(knownNpuOf('STM32U585AIIx'), undefined);
        assert.deepStrictEqual(armDocsFor(['Cortex-A53']).map(e => e.docId), ['ihi0031', 'ihi0074', 'ihi0029', 'ddi0314', 'ddi0480', '100806']);
    });

    test('every catalogue entry has a unique id, a parsable URL and a verified date; errata editions are pinned', () => {
        assert.strictEqual(new Set(ARM_DOCS.map(e => e.docId)).size, ARM_DOCS.length);
        for (const e of ARM_DOCS) {
            const ref = { docId: e.docId, version: e.version };
            assert.deepStrictEqual(parseArmDocUrl(armDocUrl(ref)), ref, e.docId);
            assert.match(e.verified, /^\d{4}-\d{2}-\d{2}$/);
            const doc = armDocRef(e);
            assert.strictEqual(doc.id, `arm/${e.docId}-${e.version}`);
            assert.strictEqual(doc.scope, 'arm');
            assert.strictEqual(doc.kind, e.kind);
        }
        assert.strictEqual(catalogueVersion('ddi0439'), 'b');
        assert.strictEqual(catalogueVersion('DDI0553'), 'latest');
        assert.strictEqual(catalogueVersion('ddi9999'), 'latest');
        assert.strictEqual(lookupArmDoc('ihi0031')!.title, 'Arm Debug Interface Architecture Specification ADIv5.0 to ADIv5.2');
        assert.strictEqual(lookupArmDoc('arm/ddi0553-latest')!.kind, 'arch');
        assert.strictEqual(lookupArmDoc('https://developer.arm.com/documentation/dui0646/latest')!.kind, 'gug');
        assert.strictEqual(lookupArmDoc('rm0456'), undefined);
    });

    test('collectProcessors merges the processor chain of the fixtures and of a multi-core device', () => {
        const stm = loadPdsc(path.join(FIXTURES, 'Keil.STM32F7xx_DFP.pdsc'), { vendor: 'Keil', name: 'STM32F7xx_DFP', version: '3.0.0' });
        assert.deepStrictEqual(collectProcessors(stm, 'STM32F756ZGTx'), [{ core: 'Cortex-M7', coreVersion: 'r0p1' }]);
        assert.deepStrictEqual(collectProcessors(stm, 'nonexistent'), [{ core: 'Cortex-M7', coreVersion: 'r0p1' }], 'family-level fallback');
        const xmc = loadPdsc(path.join(FIXTURES, 'Infineon.XMC4000_DFP.pdsc'), { vendor: 'Infineon', name: 'XMC4000_DFP', version: '2.14.0' });
        assert.deepStrictEqual(collectProcessors(xmc, 'XMC4700-F144x2048'), [{ core: 'Cortex-M4', coreVersion: 'r0p1' }]);
        assert.strictEqual(describeProcessors(collectProcessors(xmc, 'XMC4700-F144x2048')), 'Cortex-M4 r0p1 (Armv7-M)');

        const dual = parseXml(`<package><devices><family Dfamily="F" Dvendor="V:1">
            <processor Pname="cm33_core0" Dcore="Cortex-M33" DcoreVersion="r1p0"/>
            <processor Pname="cm33_core1" Dcore="Cortex-M33"/>
            <device Dname="D1"><processor Pname="cm33_core1" DcoreVersion="r0p4" Dclock="150000000"/></device>
        </family></devices></package>`);
        const info = { path: '/x.pdsc', packDir: '/x', packId: { vendor: 'V', name: 'P', version: '1' }, root: dual };
        assert.deepStrictEqual(collectProcessors(info, 'D1'), [
            { pname: 'cm33_core0', core: 'Cortex-M33', coreVersion: 'r1p0' },
            { pname: 'cm33_core1', core: 'Cortex-M33', coreVersion: 'r0p4' },
        ]);
        assert.strictEqual(describeProcessors(collectProcessors(info, 'D1')), 'cm33_core0: Cortex-M33 r1p0 (Armv8-M), cm33_core1: Cortex-M33 r0p4 (Armv8-M)');
    });

    test('collectNpus reads NPU features in both pdsc styles and falls back to the Corstone configuration', () => {
        const alif = parseXml(`<package><devices><family Dfamily="F" Dvendor="V:1">
            <feature type="CoreOther" n="1" name="Neural Processing Unit (NPU) Ethos-U55 HP"/>
            <device Dname="E8"><feature type="NPU" n="Ethos-U55" m="128MACs" Pname="M55_HE"/><feature type="NPU" n="Ethos-U85" m="256MACs"/><feature type="ADC" n="3"/></device>
            <device Dname="E3"><feature type="CoreOther" n="1" name="Neural Processing Unit (NPU) Ethos-U55 HE"/></device>
            <device Dname="E1"/>
        </family></devices></package>`);
        const info = { path: '/x.pdsc', packDir: '/x', packId: { vendor: 'V', name: 'P', version: '1' }, root: alif };
        assert.deepStrictEqual(collectNpus(info, 'E8'), ['Ethos-U55', 'Ethos-U85']);
        assert.deepStrictEqual(collectNpus(info, 'E3'), ['Ethos-U55']);
        assert.deepStrictEqual(collectNpus(info, 'E1'), ['Ethos-U55'], 'inherited from the family');
        const corstone = parseXml(`<package><devices><family Dfamily="ARM Cortex M85" Dvendor="ARM:82">
            <device Dname="SSE-320-FVP"><processor Dcore="Cortex-M85"/></device>
        </family></devices></package>`);
        const sse = { ...info, root: corstone };
        assert.deepStrictEqual(collectNpus(sse, 'SSE-320-FVP'), ['Ethos-U85'], 'the pack declares none; the Corstone-320 configuration is known');
        assert.deepStrictEqual(collectNpus(sse, 'nonexistent'), []);
        assert.strictEqual(describeProcessors(collectProcessors(sse, 'SSE-320-FVP'), collectNpus(sse, 'SSE-320-FVP')), 'Cortex-M85 (Armv8.1-M) · NPU Ethos-U85');
    });
});
