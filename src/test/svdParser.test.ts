// SPDX-License-Identifier: Apache-2.0 OR MIT
// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as assert from 'assert';
import { decodeFields, SvdRegister } from '../core/svdParser';

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
