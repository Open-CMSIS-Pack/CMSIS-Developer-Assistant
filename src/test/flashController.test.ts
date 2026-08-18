// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { parsePyocdLoadOutput } from '../core/flashController';

/**
 * Test suite for pyOCD flash-output parsing. Strings mirror
 * pyocd/flash/loader.py completion and failure output.
 */
suite('flashController parsePyocdLoadOutput', () => {

    test('sector-erase completion yields bytes and rate', () => {
        const stdout = [
            '0001234 I Erasing sectors [0x00000000-0x00040000] [eraser]',
            '0002345 I Erased 262144 bytes (128 sectors), programmed 196608 bytes (48 pages), identical 0 bytes (0 pages) at 85.31 kB/s [loader]',
        ].join('\n');
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.programmedBytes, 196608);
        assert.strictEqual(parsed.kbps, 85.31);
        assert.strictEqual(parsed.errorLines.length, 0);
    });

    test('chip-erase completion yields bytes', () => {
        const stdout = '0001987 I Erased chip, programmed 524288 bytes (128 pages) at 120.05 kB/s [loader]';
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.programmedBytes, 524288);
        assert.strictEqual(parsed.kbps, 120.05);
    });

    test('empty output yields nulls, not zeros', () => {
        const parsed = parsePyocdLoadOutput('', '');
        assert.strictEqual(parsed.programmedBytes, null);
        assert.strictEqual(parsed.kbps, null);
        assert.deepStrictEqual(parsed.errorLines, []);
        assert.deepStrictEqual(parsed.tail, []);
    });

    test('traceback on stderr lands in errorLines', () => {
        const stderr = [
            'Traceback (most recent call last):',
            '  File "pyocd/probe/pydapaccess.py", line 100, in open',
            'pyocd.core.exceptions.ProbeError: No probe connected',
        ].join('\n');
        const parsed = parsePyocdLoadOutput('', stderr);
        assert.ok(parsed.errorLines.length >= 2, `expected error lines, got ${JSON.stringify(parsed.errorLines)}`);
        assert.ok(parsed.errorLines.some(l => /Traceback/.test(l)));
        assert.ok(parsed.errorLines.some(l => /No probe connected/i.test(l)));
        assert.strictEqual(parsed.programmedBytes, null);
    });

    test('errorLines keeps only the last 8 matches', () => {
        const stderr = Array.from({ length: 20 }, (_, i) => `error number ${i}`).join('\n');
        const parsed = parsePyocdLoadOutput('', stderr);
        assert.strictEqual(parsed.errorLines.length, 8);
        assert.strictEqual(parsed.errorLines[7], 'error number 19');
    });

    test('tail keeps the last 12 non-empty lines', () => {
        const stdout = Array.from({ length: 30 }, (_, i) => `line ${i}\n\n`).join('\n');
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.tail.length, 12);
        assert.strictEqual(parsed.tail[11], 'line 29');
        assert.strictEqual(parsed.tail[0], 'line 18');
    });
});
