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
import * as path from 'path';
import { TOPICS, listTopics, parseTopics, sliceTopic } from '../core/instructionTopics';

/**
 * get_debug_instructions serves the guide by topic so a Copilot-Chat-style
 * harness pays for one section instead of the whole file. The slicer is pure;
 * these tests pin the marker grammar on a synthetic document and the shape
 * of the shipped guide.
 */
suite('Instruction topics', () => {

    const synthetic = [
        '# Guide',
        '',
        'Intro paragraph.',
        '',
        '<!-- topic: session | The session states -->',
        '## Session',
        '',
        'Gate first.',
        '<!-- /topic -->',
        '',
        '<!-- topic: faults | Decode a fault -->',
        '## Faults',
        '',
        'CFSR first.',
        '<!-- /topic -->',
        '',
    ].join('\n');

    test('parses the overview and the fenced sections in order', () => {
        const { preamble, sections } = parseTopics(synthetic);
        assert.strictEqual(preamble, '# Guide\n\nIntro paragraph.');
        assert.deepStrictEqual(sections.map((s) => s.name), ['session', 'faults']);
        assert.strictEqual(sections[0].blurb, 'The session states');
        assert.strictEqual(sections[1].body, '## Faults\n\nCFSR first.');
        assert.deepStrictEqual(listTopics(synthetic), [
            { name: 'session', blurb: 'The session states' },
            { name: 'faults', blurb: 'Decode a fault' },
        ]);
    });

    test('the overview is the preamble plus the topic list, and is the default', () => {
        const overview = sliceTopic(synthetic);
        assert.ok(overview.startsWith('# Guide\n\nIntro paragraph.\n\n## Topics'));
        assert.ok(overview.includes('- `session` — The session states'));
        assert.ok(overview.includes('- `faults` — Decode a fault'));
        assert.ok(!overview.includes('CFSR first'), 'overview must not carry section bodies');
        assert.strictEqual(sliceTopic(synthetic, 'overview'), overview);
    });

    test('a named topic returns its body with a footer naming the others', () => {
        const faults = sliceTopic(synthetic, 'faults');
        assert.ok(faults.startsWith('## Faults\n\nCFSR first.'));
        assert.ok(faults.includes('Other topics: `overview`, `session`.'));
        assert.ok(!faults.includes('Gate first'));
    });

    test('an unknown topic steers to the overview instead of failing', () => {
        const out = sliceTopic(synthetic, 'nonsense');
        assert.ok(out.startsWith("Unknown topic 'nonsense'. Showing the overview."));
        assert.ok(out.includes('## Topics'));
    });

    test('an unclosed marker is an authoring error', () => {
        assert.throws(() => parseTopics('# G\n<!-- topic: x | y -->\nbody'), /not closed/);
    });

    suite('the shipped guide', () => {
        const repoRoot = path.resolve(__dirname, '..', '..', '..');
        const doc = fs.readFileSync(path.join(repoRoot, 'docs', 'agent-resources', 'debug_instructions.md'), 'utf8');

        test('fences exactly the documented topics, once each, in the documented order', () => {
            const names = listTopics(doc).map((t) => t.name);
            assert.deepStrictEqual(names, TOPICS.filter((t) => t !== 'overview'));
        });

        test('every topic has a one-line blurb and a heading', () => {
            for (const s of parseTopics(doc).sections) {
                assert.ok(s.blurb.length > 10 && !s.blurb.includes('\n'), `blurb of ${s.name}`);
                assert.match(s.body, /^## /, `${s.name} starts with a heading`);
            }
        });

        test('the overview stays small and keeps the debugger-first rule', () => {
            const overview = sliceTopic(doc);
            assert.ok(Buffer.byteLength(overview) <= 3200, `overview is ${Buffer.byteLength(overview)} bytes`);
            assert.match(overview, /^## .*DEBUGGER FIRST/m);
            assert.match(overview, /printf/);
            assert.ok(Buffer.byteLength(overview) < Buffer.byteLength(doc) / 4, 'overview must be a fraction of the guide');
        });

        test('the topics carry the sections an agent asks for', () => {
            assert.match(sliceTopic(doc, 'session'), /no-session/);
            assert.match(sliceTopic(doc, 'build'), /cbuild-run\.yml/);
            assert.match(sliceTopic(doc, 'build'), /cmsis_action/);
            assert.match(sliceTopic(doc, 'breakpoints'), /FPB/);
            assert.match(sliceTopic(doc, 'inspection'), /wait_for_stop/);
            assert.match(sliceTopic(doc, 'faults'), /CFSR/);
            assert.match(sliceTopic(doc, 'faults'), /EXC_RETURN/);
            assert.match(sliceTopic(doc, 'troubleshooting'), /ROOT CAUSE/i);
        });
    });
});
