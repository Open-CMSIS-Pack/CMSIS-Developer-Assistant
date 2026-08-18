// SPDX-License-Identifier: Apache-2.0 OR MIT
// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as assert from 'assert';
import {
    REDACTION_PLACEHOLDER,
    isSensitiveName,
    looksLikeSecretValue,
    redactExpressionResult,
    redactVariableValue
} from '../utils/secretRedaction';

suite('Secret redaction', () => {

    suite('isSensitiveName', () => {
        test('flags credential-bearing names', () => {
            for (const name of [
                'apiKey', 'API_KEY', 'api-key', 'openai_api_key', 'secret', 'clientSecret',
                'password', 'passwd', 'pwd', 'passphrase', 'accessToken', 'refresh_token',
                'credentials', 'privateKey', 'AUTHORIZATION', 'connectionString', 'connStr',
                'cookie', 'sessionKey', 'encryptionKey', 'sasToken', 'otp', 'bearerToken'
            ]) {
                assert.strictEqual(isSensitiveName(name), true, `expected ${name} to be sensitive`);
            }
        });

        test('does not flag ordinary names', () => {
            for (const name of ['author', 'count', 'userName', 'result', 'items', 'index', 'config']) {
                assert.strictEqual(isSensitiveName(name), false, `expected ${name} to be benign`);
            }
        });

        test('matches exactly, so names merely containing a credential word stay readable', () => {
            for (const name of [
                'tokenCount', 'cookieCount', 'tokenIndex', 'secretCount',
                'hasToken', 'passwordLength', 'tokenizer', 'subtokens'
            ]) {
                assert.strictEqual(isSensitiveName(name), false, `expected ${name} to be benign`);
            }
        });

        test('ignores case and separator style', () => {
            for (const name of ['API_KEY', 'api-key', 'apiKey', 'ApiKey', 'api key']) {
                assert.strictEqual(isSensitiveName(name), true, `expected ${name} to be sensitive`);
            }
        });

        test('keeps a benign counter debuggable end to end', () => {
            const result = redactVariableValue('tokenCount', '42');
            assert.strictEqual(result.redacted, false);
            assert.strictEqual(result.value, '42');
        });
    });

    suite('looksLikeSecretValue', () => {
        test('recognizes well-known credential shapes', () => {
            const secrets = [
                'AKIAIOSFODNN7EXAMPLE',
                'ghp_1234567890abcdefghijklmnopqrstuv',
                'github_pat_11ABCDEFG0abcdefghijklmnop',
                'xoxb-123456789012-abcdefghijkl',
                'AIzaSyA1234567890abcdefghijklmnopqrstuv',
                'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
                'sk_live_abcdefghijklmnop',
                'npm_abcdefghijklmnopqrstuvwxyz0123456789',
                'glpat-abcdefghijklmnopqrst',
                'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef123456',
                '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----',
                'Bearer abcdef0123456789ABCDEF'
            ];
            for (const secret of secrets) {
                assert.strictEqual(looksLikeSecretValue(secret), true, `expected secret detection for ${secret}`);
            }
        });

        test('does not flag ordinary values', () => {
            for (const value of ['42', 'hello world', '/usr/local/bin', 'None', 'user@example.com']) {
                assert.strictEqual(looksLikeSecretValue(value), false, `expected ${value} to be benign`);
            }
        });
    });

    suite('redactVariableValue', () => {
        test('redacts values of sensitive variable names', () => {
            const result = redactVariableValue('api_key', "'sk-proj-abcdefghijklmnop'");
            assert.strictEqual(result.redacted, true);
            assert.strictEqual(result.value, REDACTION_PLACEHOLDER);
        });

        test('redacts secret-shaped values under an innocuous name', () => {
            const result = redactVariableValue('x', 'ghp_1234567890abcdefghijklmnopqrstuv');
            assert.strictEqual(result.redacted, true);
            assert.strictEqual(result.value, REDACTION_PLACEHOLDER);
        });

        test('keeps null-ish values visible so missing-credential bugs stay debuggable', () => {
            for (const value of ['None', 'null', 'undefined', '', "''", '0', 'False']) {
                const result = redactVariableValue('api_key', value);
                assert.strictEqual(result.redacted, false, `expected ${value} to be kept`);
                assert.strictEqual(result.value, value);
            }
        });

        test('leaves ordinary variables untouched', () => {
            const result = redactVariableValue('userCount', '42');
            assert.strictEqual(result.redacted, false);
            assert.strictEqual(result.value, '42');
        });

        test('returns a struct intact when the variable itself is not sensitive', () => {
            const value = '{ "host": "db.example.com", "password": "hunter2-super-secret" }';
            const result = redactVariableValue('config', value);
            assert.strictEqual(result.redacted, false, 'inner fields must not trigger redaction');
            assert.strictEqual(result.value, value);
        });

        test('redacts a struct whose own name is sensitive', () => {
            const value = '{ "host": "db.example.com", "user": "admin" }';
            const result = redactVariableValue('credentials', value);
            assert.strictEqual(result.redacted, true);
            assert.strictEqual(result.value, REDACTION_PLACEHOLDER);
        });

        test('redacts a container whose own rendering carries a recognizable secret', () => {
            const value = "environ({'PATH': '/usr/bin', 'GITHUB_TOKEN': 'ghp_1234567890abcdefghijklmnopqrstuv'})";
            const result = redactVariableValue('environ', value);
            assert.strictEqual(result.redacted, true);
            assert.strictEqual(result.value, REDACTION_PLACEHOLDER);
        });

        test('is idempotent - re-redacting the placeholder is a no-op', () => {
            const once = redactVariableValue('api_key', 'ghp_1234567890abcdefghijklmnopqrstuv');
            const twice = redactVariableValue('api_key', once.value);
            assert.strictEqual(twice.value, once.value);
            assert.strictEqual((twice.value.match(/possible secret/g) || []).length, 1);
        });
    });

    suite('performance guards', () => {
        test('does not backtrack catastrophically on adversarial input', () => {
            const evil = `{'api_key': "${'\\'.repeat(50000)}`;
            const start = Date.now();
            redactVariableValue('blob', evil);
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 1000, `redaction took ${elapsed}ms - patterns are backtracking`);
        });

        test('stays fast on a long identifier run that matches nothing', () => {
            const start = Date.now();
            redactVariableValue('blob', 'a_'.repeat(40000) + '=x');
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 1000, `redaction took ${elapsed}ms`);
        });
    });

    suite('redactExpressionResult', () => {
        test('blocks the evaluate_expression bypass for sensitive expressions', () => {
            const result = redactExpressionResult('os.environ["OPENAI_API_KEY"]', "'sk-abcdefghijklmnopqrst'");
            assert.strictEqual(result.redacted, true);
            assert.strictEqual(result.value, REDACTION_PLACEHOLDER);
        });

        test('blocks dumping the whole environment via evaluate_expression', () => {
            const result = redactExpressionResult('dict(os.environ)', "{'HOME': '/home/u', 'GITHUB_TOKEN': 'ghp_1234567890abcdefghijklmnopqrstuv'}");
            assert.strictEqual(result.redacted, true);
            assert.ok(!result.value.includes('ghp_1234567890abcdefghijklmnopqrstuv'));
        });

        test('leaves ordinary evaluations untouched', () => {
            const result = redactExpressionResult('len(items)', '3');
            assert.strictEqual(result.redacted, false);
            assert.strictEqual(result.value, '3');
        });
    });

    /**
     * Fork-specific. Upstream decides from the variable's name alone, which is
     * right for a host process where `auth` holds a bearer token. In firmware
     * those names are overwhelmingly scalars — a pairing state, a parser tag, a
     * ring-buffer token — and withholding them breaks the debugging they exist
     * for while protecting nothing.
     */
    suite('embedded carve-out: numeric scalars stay readable', () => {

        test('a credential-named integer flag is not withheld', () => {
            for (const [name, value] of [
                ['auth', '1'],
                ['token', '42'],
                ['secret', '0'],
                ['pass', '3'],
                ['sessionKey', '7'],
                ['apiKey', '255'],
            ] as const) {
                const result = redactVariableValue(name, value);
                assert.strictEqual(result.redacted, false, `${name}=${value} should stay readable`);
                assert.strictEqual(result.value, value);
            }
        });

        test('hex and binary register-style values are not withheld', () => {
            for (const value of ['0x20000000', '0xDEADBEEF', '0b10110001', '-1', '3.14', '1e-6']) {
                const result = redactVariableValue('privateKey', value);
                assert.strictEqual(result.redacted, false, `${value} should stay readable`);
            }
        });

        test('a GDB pointer with a symbol annotation is not withheld', () => {
            const result = redactVariableValue('token', '0x8000414 <main+8>');
            assert.strictEqual(result.redacted, false);
        });

        test('a C char rendering is not withheld', () => {
            const result = redactVariableValue('password', "12 '\\f'");
            assert.strictEqual(result.redacted, false);
        });

        test('an integer-suffixed literal is not withheld', () => {
            const result = redactVariableValue('apiToken', '4294967295u');
            assert.strictEqual(result.redacted, false);
        });

        test('a real string credential is still withheld under the same name', () => {
            const result = redactVariableValue('apiKey', '"sk-abcdefghijklmnopqrst"');
            assert.strictEqual(result.redacted, true);
            assert.strictEqual(result.value, REDACTION_PLACEHOLDER);
        });

        test('a char buffer holding a token is still withheld', () => {
            const result = redactVariableValue('auth', '"ghp_1234567890abcdefghijklmnopqrstuv"');
            assert.strictEqual(result.redacted, true);
        });

        test('SVD register names are not credential names', () => {
            // Real registers on shipping parts: IWDG key register, flash and
            // RCC unlock keys. These reach agents via read_peripheral_register,
            // which bypasses redaction entirely, but the name check must not
            // flag them either.
            for (const name of ['KEY', 'KR', 'UNLOCK', 'KEYR', 'OPTKEYR', 'PRIVCFGR']) {
                assert.strictEqual(isSensitiveName(name), false, `${name} is a register, not a credential`);
            }
        });
    });
});
