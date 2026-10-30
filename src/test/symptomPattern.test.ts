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

/** Restricted symptom syntax, catalogue compatibility and resource-bound regression tests. */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { knownMessages } from '../core/knowledge/search';
import { KnowledgeIndex, KnowledgeSet } from '../core/knowledge/store';
import { compileSymptomPattern, SymptomCompilationBudget, SymptomMatchBudget } from '../core/knowledge/symptomPattern';
import { ToolError } from '../core/toolResult';

/** A minimal read-only index fixture with one short, nonmatching symptom. */
function writeSymptomIndex(file: string, patterns: readonly string[]): void {
    const db = new DatabaseSync(file);
    try {
        db.exec(`
            CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT, type TEXT, domain TEXT, title TEXT, summary TEXT, body TEXT, meta JSON);
            CREATE TABLE edges(src TEXT, rel TEXT, dst TEXT, qual JSON);
            CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, title, summary, body, symptoms, triggers);
            BEGIN;
        `);
        const insert = db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)');
        patterns.forEach((pattern, at) => insert.run(`symptom-${at}`, 'knowledge', 'troubleshooting', 'error-catalog', '', '', '',
            JSON.stringify({ symptom_regex: pattern })));
        db.exec('COMMIT');
    } finally {
        db.close();
    }
}

suite('bounded symptom patterns', () => {
    test('the supported grammar agrees with native matching for short inputs', () => {
        const sources = [
            '', '^$', '^a$', 'a|aa', '^(?:a|bc)d?$', '(a+)b+', 'a*a*b$', 'a+?b??', 'a{0,3}b{2}c{1,}',
            '[a-cA-F0-9_]+', '[^a-c]+', '[]', '[^]', '[(+]+', '\\(a+\\)+', '\\bword\\b', '\\Bword\\B',
            '\\d+\\s\\w+\\S\\D\\W', '\\t?\\r?\\n', '\\x61\\u0062\\0', '[\\b\\t\\x41-\\x5a]+', '.', '^.$',
            "^board mounted device '?.+?'? not found$", "^mlops: (?:no default unnamed target set for '.+?'|target set '.+?' not found)$",
        ];
        const lines = [
            '', 'a', 'A', 'ab', 'abc', 'aaab', 'aaaabbb', 'aabc', 'bbcc', 'bc', 'bcd', '1 A!A ', 'abc_19', '((+++',
            '(aaaa))', 'word', ' word!', 'swords', 'WORD', 'a\n', '\r\n', '\t\r\n', '\b\tAZ', 'ab\0', 'é', '\u2028',
            "board mounted device 'STM32U5' not found", "BOARD MOUNTED DEVICE STM32U5 NOT FOUND", "mlops: target set 'debug' not found",
        ];
        for (const source of sources) {
            const pattern = compileSymptomPattern(source);
            assert.ok(pattern, source);
            const reference = new RegExp(source, 'i');
            for (const line of lines) {
                assert.strictEqual(pattern.test(line), reference.test(line), `${source} on ${JSON.stringify(line)}`);
            }
        }
    });

    test('unsupported syntax is refused rather than executed by a fallback engine', () => {
        for (const source of [
            '(a|aa)+$', '(a+)+$', '(?:foo|bar)+', '(a{1,3})*', '(?:x+){2,5}', '(a)\\1', '(?<name>a)\\k<name>',
            '(?=a)a', '(?!a)b', '(?<=a)b', '(?<!a)b', '(?i)a', '\\p{L}', '\\cA', '\\08', '\\12', '\\q',
            'a++', 'a???', '^*', '\\b+', '(unclosed', 'unopened)', '[abc', '[z-a]', 'a{3,1}', 'a{,3}', '\\', '\\x1', '\\u123',
        ]) {
            assert.strictEqual(compileSymptomPattern(source), undefined, source);
        }
    });

    test('merged paths preserve optional and repeated atoms, alternatives and anchors', () => {
        let lines = [''];
        let frontier = [''];
        for (let length = 1; length <= 4; length++) {
            frontier = frontier.flatMap((prefix) => ['a', 'b', '\n'].map((letter) => prefix + letter));
            lines = lines.concat(frontier);
        }
        const atoms = ['a', 'a?', 'a*', 'a+', 'a{0,2}', 'a{2,}', '[ab]?', '.*?', '(?:a|ab)', '(?:|a)'];
        for (const first of atoms) {
            for (const second of atoms) {
                for (const source of [first + second, `^${first}${second}$`, `(?:${first}|${second})b$`]) {
                    const pattern = compileSymptomPattern(source);
                    assert.ok(pattern, source);
                    const reference = new RegExp(source, 'i');
                    for (const line of lines) {
                        assert.strictEqual(pattern.test(line), reference.test(line), `${source} on ${JSON.stringify(line)}`);
                    }
                }
            }
        }
    });

    test('source, nesting, expanded repetition and input size have fixed bounds', () => {
        for (const source of ['a'.repeat(501), '('.repeat(33) + 'a' + ')'.repeat(33), 'a{101}', 'a{1,1000000000}', 'a{100}'.repeat(11)]) {
            assert.strictEqual(compileSymptomPattern(source), undefined, source);
        }
        assert.ok(compileSymptomPattern('('.repeat(32) + 'a' + ')'.repeat(32)));
        assert.ok(compileSymptomPattern('a{100}'));
        const pattern = compileSymptomPattern('!$');
        assert.ok(pattern);
        assert.strictEqual(pattern.test('a'.repeat(1_999) + '!'), true);
        assert.strictEqual(pattern.test('a'.repeat(2_000) + '!'), false);
    });

    test('overlapping quantifiers cannot stall a match; the stress test itself has an enforceable worker deadline', async () => {
        const worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            const { compileSymptomPattern, SymptomMatchBudget } = require(workerData);
            const candidates = ['^a+a+a+a+a+$', '^' + 'a?'.repeat(240) + 'b$', '^' + 'a*'.repeat(240) + 'b$'];
            const matches = candidates.map(source => compileSymptomPattern(source)?.test('a'.repeat(1_999) + '!'));
            let aggregate;
            try {
                const budget = new SymptomMatchBudget();
                const pattern = compileSymptomPattern(candidates[2]);
                for (let i = 0; i < 100; i++) { pattern.test('a'.repeat(1_999) + '!', budget); }
            } catch (caught) {
                aggregate = { code: caught.code, message: caught.message };
            }
            parentPort.postMessage({ matches, aggregate });
        `, { eval: true, workerData: require.resolve('../core/knowledge/symptomPattern') });
        try {
            const results = await new Promise<unknown>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Symptom matching exceeded the worker deadline'));
                    void worker.terminate();
                }, 2_000);
                worker.once('message', (value: unknown) => { clearTimeout(timeout); resolve(value); });
                worker.once('error', (error: Error) => { clearTimeout(timeout); reject(error); });
                worker.once('exit', (code: number) => {
                    clearTimeout(timeout);
                    reject(new Error(`Symptom worker exited before a result (${code})`));
                });
            });
            assert.deepStrictEqual(results, {
                matches: [false, false, false],
                aggregate: { code: 'TIMEOUT', message: 'Knowledge symptom matching reached its safety work limit; the search is incomplete.' },
            });
        } finally {
            await worker.terminate();
        }
    });

    test('one work budget covers all patterns, lines, indexes and messages, and never returns a partial answer', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-symptom-budget-'));
        const first = path.join(dir, 'first.db');
        const second = path.join(dir, 'second.db');
        const repeated = path.join(dir, 'repeated.db');
        writeSymptomIndex(first, ['^z$']);
        writeSymptomIndex(second, ['^z$']);
        writeSymptomIndex(repeated, ['a', '^z$']);
        const index = new KnowledgeIndex(first);
        const multi = new KnowledgeIndex(repeated);
        const set = new KnowledgeSet([{ file: first, label: 'base' }, { file: second, label: 'workspace' }]);
        const incomplete = (caught: unknown): boolean => caught instanceof ToolError && caught.code === 'TIMEOUT' && /incomplete/.test(caught.message);
        try {
            assert.deepStrictEqual(index.exactSymptoms(['a'], new SymptomMatchBudget(6)), []);
            assert.throws(() => index.exactSymptoms(['a', 'a'], new SymptomMatchBudget(9)), incomplete);
            assert.throws(() => index.exactSymptoms(['', '', ''], new SymptomMatchBudget(3)), incomplete, 'empty lines cost work too');
            assert.throws(() => multi.exactSymptoms(['a'], new SymptomMatchBudget(6)), incomplete, 'an earlier hit is not returned as a complete answer');
            assert.throws(() => set.exactSymptoms(['a'], new SymptomMatchBudget(13)), incomplete, 'members must not reset the budget');
            assert.throws(() => knownMessages(index, ['a', 'a'], undefined, new SymptomMatchBudget(10)), incomplete, 'messages must not reset the budget');
        } finally {
            index.close();
            multi.close();
            set.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('opening an index set caps compilation attempts and retained states; failure releases every file', () => {
        const count = new SymptomCompilationBudget();
        for (let i = 0; i < 4_096; i++) {
            assert.strictEqual(count.compile('(unclosed'), undefined);
        }
        assert.throws(() => count.compile('a'), (caught: unknown) => caught instanceof ToolError && caught.code === 'INVALID_ARGUMENT'
            && /pattern count/.test(caught.message));
        const states = new SymptomCompilationBudget();
        for (let i = 0; i < 499; i++) {
            assert.ok(states.compile('a'.repeat(500)));
        }
        assert.throws(() => states.compile('a'.repeat(500)), /compiled state count/);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-symptom-compilation-'));
        const first = path.join(dir, 'first.db');
        const second = path.join(dir, 'second.db');
        try {
            writeSymptomIndex(first, Array.from({ length: 2_049 }, () => 'a'));
            writeSymptomIndex(second, Array.from({ length: 2_049 }, () => 'a'));
            assert.throws(() => new KnowledgeSet([{ file: first, label: 'base' }, { file: second, label: 'workspace' }]), /pattern count/);
            // Windows refuses deletion while SQLite holds a file open.
            fs.unlinkSync(first);
            fs.unlinkSync(second);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('every pinned core symptom pattern remains usable', function () {
        const file = path.resolve(__dirname, '../../../resources/knowledge/core.db');
        if (!fs.existsSync(file)) {
            this.skip();
        }
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            const rows = db.prepare("SELECT id, json_extract(meta, '$.symptom_regex') pattern FROM nodes WHERE type = 'troubleshooting' AND pattern IS NOT NULL").all();
            assert.ok(rows.length > 0);
            for (const row of rows) {
                assert.ok(typeof row.pattern === 'string' && compileSymptomPattern(row.pattern) !== undefined, String(row.id));
            }
        } finally {
            db.close();
        }
    });
});
