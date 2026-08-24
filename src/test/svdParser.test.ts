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
import {
    decodeFields, expandDimIndex, findPeripheral, findRegister, parseSvdXml, resolveSvdPath, selectSvdEntry,
    svdEntriesFromCbuildRun, SvdRegister,
} from '../core/svdParser';

/**
 * Test suite for SVD field decoding — in particular the bit-mask math, which
 * must survive JS's 32-bit bitwise semantics (`1 << 32 === 1`, `1 << 31` goes
 * negative). A full-word field [31:0] previously decoded to 0 for any value.
 */
suite('svdParser decodeFields', () => {

    /** Build a minimal register holding a single field [high:low]. */
    function regWith(bitLow: number, bitHigh: number): SvdRegister {
        return {
            name: 'TEST',
            addressOffset: 0,
            size: 32,
            fields: [{ name: 'F', bitLow, bitHigh }],
        };
    }

    function decode(bitLow: number, bitHigh: number, value: number): number {
        const fields = decodeFields(regWith(bitLow, bitHigh), value);
        assert.strictEqual(fields.length, 1);
        return fields[0].value;
    }

    test('single-bit field', () => {
        assert.strictEqual(decode(5, 5, 0b101000), 1);
        assert.strictEqual(decode(5, 5, 0), 0);
    });

    test('byte field with offset', () => {
        assert.strictEqual(decode(8, 11, 0xABC), 0xA);
    });

    test('width-31 field decodes fully', () => {
        // Regression: (1 << 31) - 1 is negative in JS, corrupting the mask.
        assert.strictEqual(decode(0, 30, 0xFFFFFFFF), 0x7FFFFFFF);
    });

    test('full-word field [31:0] round-trips the register value', () => {
        // The original bug: 1 << 32 === 1 → mask 0 → always decoded to 0.
        assert.strictEqual(decode(0, 31, 0xDEADBEEF), 0xDEADBEEF);
        assert.strictEqual(decode(0, 31, 0), 0);
        assert.strictEqual(decode(0, 31, 0xFFFFFFFF), 0xFFFFFFFF);
    });

    test('fields touching bit 31 never decode negative', () => {
        assert.strictEqual(decode(31, 31, 0x80000000), 1);
        assert.strictEqual(decode(28, 31, 0xF0000000), 15);
    });

    test('negative input is normalized as unsigned 32-bit', () => {
        // Values arriving via GDB evaluate paths can be two's-complement
        // negative numbers; they must decode identically to their unsigned
        // bit pattern.
        assert.deepStrictEqual(
            decodeFields(regWith(0, 31), -1),
            decodeFields(regWith(0, 31), 0xFFFFFFFF),
        );
    });
});

suite('svdParser on the fixture device', () => {
    const fixturePath = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'test-device.svd');
    const device = () => parseSvdXml(fs.readFileSync(fixturePath, 'utf8'));

    test('parses peripherals, address blocks and register-level attributes', () => {
        const dev = device();
        assert.strictEqual(dev.name, 'TESTDEVICE');
        assert.deepStrictEqual(dev.peripherals.map((p) => p.name), ['RCC', 'GPIOA', 'GPIOB', 'TIM2', 'I2C1']);
        const rcc = dev.peripherals[0];
        assert.deepStrictEqual(rcc.addressBlocks, [{ offset: 0, size: 0x400, usage: 'registers' }]);
        const cr = rcc.registers[0];
        assert.strictEqual(cr.description, 'Clock control register');
        assert.strictEqual(cr.access, 'read-write', 'register access comes from the register, not its first field');
        assert.strictEqual(cr.resetValue, 0x83);
        const apb1 = rcc.registers[1];
        assert.strictEqual(apb1.access, undefined, 'a field access must not leak into a register without one');
    });

    test('parses both field notations and enumerated values', () => {
        const cr = device().peripherals[0].registers[0];
        const byName = Object.fromEntries(cr.fields.map((f) => [f.name, f]));
        assert.deepStrictEqual([byName.HSION.bitLow, byName.HSION.bitHigh], [0, 0]);
        assert.deepStrictEqual([byName.HSIRDY.bitLow, byName.HSIRDY.bitHigh], [1, 1]);
        assert.deepStrictEqual([byName.PLLON.bitLow, byName.PLLON.bitHigh], [24, 24]);
        assert.deepStrictEqual(byName.HSION.enumeratedValues, [
            { name: 'Off', value: 0, description: 'Clock off' },
            { name: 'On', value: 1, description: 'Clock on' },
        ]);
        assert.strictEqual(byName.HSIRDY.enumeratedValues, undefined);
    });

    test('expands dim arrays by index and by dimIndex list', () => {
        const gpioa = device().peripherals[1];
        const names = gpioa.registers.map((r) => `${r.name}@${r.addressOffset.toString(16)}`);
        assert.deepStrictEqual(names, ['MODER@0', 'ODR@14', 'AFR0@20', 'AFR1@24', 'AFR2@28', 'AFR3@2c', 'BSRRL@30', 'BSRRH@34']);
        assert.strictEqual(gpioa.registers[7].description, 'Bit set/reset register, H half');
    });

    test('a derivedFrom peripheral inherits registers and address blocks', () => {
        const dev = device();
        const gpiob = dev.peripherals[2];
        assert.strictEqual(gpiob.derivedFrom, 'GPIOA');
        assert.strictEqual(dev.peripherals[1].derivedFrom, undefined);
        assert.strictEqual(gpiob.baseAddress, 0x40020400);
        assert.strictEqual(gpiob.registers.length, 8);
        assert.deepStrictEqual(gpiob.addressBlocks, dev.peripherals[1].addressBlocks);
    });

    test('exact lookups stay case-insensitive', () => {
        const dev = device();
        const p = findPeripheral(dev, 'gpioa');
        assert.strictEqual(p?.name, 'GPIOA');
        assert.strictEqual(findRegister(p!, 'odr')?.addressOffset, 0x14);
    });
});

suite('SVD path resolution', () => {
    let dir: string;
    setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-resolve-')); });
    teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const touch = (rel: string, content = '<device><name>X</name></device>') => {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        return p;
    };
    const none = async () => [] as string[];
    const base = { workspaceCbuildRunFiles: none, workspaceSvdFiles: none };

    test('an explicit path wins when it exists, and is reported when it does not', async () => {
        const svd = touch('dev.svd');
        assert.strictEqual((await resolveSvdPath({ ...base, svdFile: svd })).path, svd);
        const missing = await resolveSvdPath({ ...base, svdFile: path.join(dir, 'missing.svd') });
        assert.strictEqual(missing.path, null);
        assert.match(missing.tried[0], /missing\.svd \(not found\)/);
    });

    test('a cbuild-run file yields the SVD whose pname matches, else the session, else the first', async () => {
        const hp = touch('packs/hp.svd');
        const he = touch('packs/he.svd');
        const run = touch('out/app.cbuild-run.yml', [
            'system-descriptions:',
            `  - file: ${hp}`,
            '    type: svd',
            '    pname: M55_HP',
            `  - file: ${he}`,
            '    type: svd',
            '    pname: M55_HE',
            '',
        ].join('\n'));
        assert.strictEqual((await resolveSvdPath({ ...base, cbuildRunFile: run, sessionName: 'M55_HE CMSIS-DAP@pyOCD (launch)' })).path, he);
        assert.strictEqual((await resolveSvdPath({ ...base, cbuildRunFile: run })).path, hp);
        assert.strictEqual((await resolveSvdPath({ ...base, cbuildRunFile: run, pname: 'M55_HE', sessionName: 'M55_HP' })).path, he, 'an explicit pname wins over the session name');
        assert.strictEqual((await resolveSvdPath({ ...base, cwd: dir, sessionName: 'M55_HE' })).path, he, 'cwd/out is scanned');
        assert.strictEqual((await resolveSvdPath({ workspaceCbuildRunFiles: async () => [run], workspaceSvdFiles: none })).path, hp, 'workspace scan works without a session');
    });

    test('a single workspace SVD is used, several are not guessed between', async () => {
        const one = touch('a.svd');
        assert.strictEqual((await resolveSvdPath({ workspaceCbuildRunFiles: none, workspaceSvdFiles: async () => [one] })).path, one);
        const two = touch('b.svd');
        const ambiguous = await resolveSvdPath({ workspaceCbuildRunFiles: none, workspaceSvdFiles: async () => [one, two] });
        assert.strictEqual(ambiguous.path, null);
        assert.match(ambiguous.tried.at(-1) ?? '', /2 files — pass svdFile/);
        assert.deepStrictEqual(await resolveSvdPath(base), { path: null, tried: ['workspace *.svd (none)'] });
    });
});

suite('svdParser parseSvdXml', () => {

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const fixture = path.join(repoRoot, 'src', 'test', 'fixtures', 'test-device.svd');
    const device = parseSvdXml(fs.readFileSync(fixture, 'utf8'));

    test('reads the device and its peripherals in order', () => {
        assert.strictEqual(device.name, 'TESTDEVICE');
        assert.deepStrictEqual(device.peripherals.map(p => p.name), ['RCC', 'GPIOA', 'GPIOB', 'TIM2', 'I2C1']);
        assert.strictEqual(device.peripherals[0].baseAddress, 0x40023800);
        assert.strictEqual(device.peripherals[0].description, 'Reset and clock control');
    });

    test('address blocks are parsed and inherited through derivedFrom', () => {
        assert.deepStrictEqual(device.peripherals[0].addressBlocks, [{ offset: 0, size: 0x400, usage: 'registers' }]);
        const gpiob = device.peripherals[2];
        assert.strictEqual(gpiob.baseAddress, 0x40020400);
        assert.strictEqual(gpiob.registers, device.peripherals[1].registers, 'registers are shared with the parent');
        assert.deepStrictEqual(gpiob.addressBlocks, device.peripherals[1].addressBlocks);
        assert.strictEqual(gpiob.description, 'General-purpose I/Os');
        assert.deepStrictEqual(device.peripherals[3].addressBlocks, []);
    });

    test('register-level tags are not confused with a field\'s', () => {
        const cr = device.peripherals[0].registers[0];
        assert.strictEqual(cr.access, 'read-write');
        assert.strictEqual(cr.resetValue, 0x83);
        assert.strictEqual(cr.description, 'Clock control register');
        assert.deepStrictEqual(cr.fields.map(f => [f.name, f.bitLow, f.bitHigh, f.access]),
            [['HSION', 0, 0, undefined], ['HSIRDY', 1, 1, 'read-only'], ['PLLON', 24, 24, undefined]]);
        const apb1 = device.peripherals[0].registers[1];
        assert.strictEqual(apb1.access, undefined, 'no register-level access, and none borrowed from a field');
    });

    test('enumerated values are attached to their field', () => {
        const tim2en = device.peripherals[0].registers[1].fields[0];
        assert.strictEqual(tim2en.name, 'TIM2EN');
        assert.deepStrictEqual(tim2en.enumeratedValues, [
            { name: 'Disabled', value: 0, description: 'Clock gated' },
            { name: 'Enabled', value: 1, description: 'Clock running' },
        ]);
        assert.strictEqual(device.peripherals[0].registers[1].fields[1].enumeratedValues, undefined);
    });

    test('dim arrays expand into one register per element', () => {
        const tim2 = device.peripherals[3];
        assert.deepStrictEqual(tim2.registers.map(r => r.name), ['CNT', 'CCR1', 'CCR2', 'CCR3', 'CCR4']);
        const ccr3 = tim2.registers[3];
        assert.strictEqual(ccr3.addressOffset, 0x3c);
        assert.strictEqual(ccr3.description, 'Capture/compare register 3');
        assert.strictEqual(ccr3.fields[0].name, 'CCR');
    });

    test('expandDimIndex handles ranges, lists and absence', () => {
        assert.deepStrictEqual(expandDimIndex('1-4', 4), ['1', '2', '3', '4']);
        assert.deepStrictEqual(expandDimIndex('A,B,C', 3), ['A', 'B', 'C']);
        assert.deepStrictEqual(expandDimIndex(null, 2), ['0', '1']);
    });

    test('cbuild-run SVD entries are read and selected by pname, session name, or first', () => {
        const yaml = [
            'output:',
            '  - file: ./out/app.elf',
            '    type: elf',
            '  - file: ${CMSIS_PACK_ROOT}/Vendor/DFP/1.0.0/SVD/HE.svd',
            '    type: svd',
            '    pname: M55_HE',
            '  - file: ${CMSIS_PACK_ROOT}/Vendor/DFP/1.0.0/SVD/HP.svd',
            '    type: svd',
            '    pname: M55_HP',
            '',
        ].join('\n');
        const entries = svdEntriesFromCbuildRun(yaml);
        assert.deepStrictEqual(entries.map(e => e.pname), ['M55_HE', 'M55_HP']);
        assert.strictEqual(selectSvdEntry(entries, 'M55_HP')?.pname, 'M55_HP');
        assert.strictEqual(selectSvdEntry(entries, 'hp')?.pname, 'M55_HP', 'a partial pname still selects');
        assert.strictEqual(selectSvdEntry(entries, undefined, 'M55_HP CMSIS_DAP@pyOCD (launch)')?.pname, 'M55_HP');
        assert.strictEqual(selectSvdEntry(entries, undefined, 'Debug')?.pname, 'M55_HE', 'falls back to the first entry');
    });

    test('resolveSvdPath tries explicit, cbuild-run, workspace cbuild-run, then a single workspace svd', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-resolve-'));
        try {
            const svd = path.join(dir, 'dev.svd');
            fs.copyFileSync(fixture, svd);
            const cbuildRun = path.join(dir, 'app.cbuild-run.yml');
            fs.writeFileSync(cbuildRun, `output:\n  - file: ${svd}\n    type: svd\n    pname: CM4\n`);
            const none = async () => [] as string[];

            const explicit = await resolveSvdPath({ svdFile: svd, workspaceCbuildRunFiles: none, workspaceSvdFiles: none });
            assert.strictEqual(explicit.path, svd);

            const missing = await resolveSvdPath({ svdFile: path.join(dir, 'nope.svd'), cbuildRunFile: cbuildRun, workspaceCbuildRunFiles: none, workspaceSvdFiles: none });
            assert.strictEqual(missing.path, svd, 'a missing explicit file falls through to the cbuild-run');
            assert.match(missing.tried[0], /nope\.svd \(not found\)/);

            const viaWorkspace = await resolveSvdPath({ workspaceCbuildRunFiles: async () => [cbuildRun], workspaceSvdFiles: none });
            assert.strictEqual(viaWorkspace.path, svd);

            const single = await resolveSvdPath({ workspaceCbuildRunFiles: none, workspaceSvdFiles: async () => [svd] });
            assert.strictEqual(single.path, svd);

            const ambiguous = await resolveSvdPath({ workspaceCbuildRunFiles: none, workspaceSvdFiles: async () => [svd, svd] });
            assert.strictEqual(ambiguous.path, null);
            assert.match(ambiguous.tried.at(-1) ?? '', /2 files — pass svdFile/);

            const command = await resolveSvdPath({ cbuildRunFile: '${command:cmsis.getCbuildRun}', workspaceCbuildRunFiles: none, workspaceSvdFiles: none });
            assert.strictEqual(command.path, null);
            assert.deepStrictEqual(command.tried, ['workspace *.svd (none)']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
