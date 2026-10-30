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
import { RETIRED_TOPICS, TOPICS, TOPIC_NAMES, listTopics, parseTopics, sliceTopic } from '../core/instructionTopics';
import { RULES_BLOCK } from '../core/toolContract';
import { removeBlock } from '../utils/markerBlock';

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

    test('a retired name the document does not fence steers to the overview like any unknown one', () => {
        assert.ok(sliceTopic(synthetic, 'build').startsWith("Unknown topic 'build'. Showing the overview."));
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
            // The tool rules lead the overview; toolContract.test.ts holds them under 1 600 bytes.
            const ownText = removeBlock(overview, RULES_BLOCK);
            // 3 200 bytes until 2.5.9, which added the `bootstrap` topic and its line in the list;
            // 3 300 until 2.7.0, which split `build` into three topics, two more lines in the list.
            assert.ok(Buffer.byteLength(ownText) <= 3700, `overview without the tool rules is ${Buffer.byteLength(ownText)} bytes`);
            assert.match(overview, /^## .*DEBUGGER FIRST/m);
            assert.match(overview, /printf/);
            assert.ok(Buffer.byteLength(overview) < Buffer.byteLength(doc) / 4, 'overview must be a fraction of the guide');
        });

        test('the topics carry the sections an agent asks for', () => {
            assert.match(sliceTopic(doc, 'bootstrap'), /NO_WORKSPACE/);
            assert.match(sliceTopic(doc, 'bootstrap'), /open_solution/);
            assert.match(sliceTopic(doc, 'session'), /no-session/);
            assert.match(sliceTopic(doc, 'target'), /cbuild-run\.yml/);
            assert.match(sliceTopic(doc, 'target'), /list_target_docs/);
            assert.match(sliceTopic(doc, 'cmsis-action'), /load_and_debug/);
            assert.match(sliceTopic(doc, 'cmsis-action'), /Build errors/);
            assert.match(sliceTopic(doc, 'flash'), /PROBE_BUSY/);
            assert.match(sliceTopic(doc, 'flash'), /start_debugging/);
            assert.match(sliceTopic(doc, 'breakpoints'), /FPB/);
            assert.match(sliceTopic(doc, 'inspection'), /wait_for_stop/);
            assert.match(sliceTopic(doc, 'faults'), /CFSR/);
            assert.match(sliceTopic(doc, 'faults'), /EXC_RETURN/);
            assert.match(sliceTopic(doc, 'troubleshooting'), /ROOT CAUSE/i);
        });

        test('every name the tool takes serves well under the 8 KB a Copilot agent takes inline', () => {
            // GitHub Copilot's agent writes a result over about 8 KB to a file. In 2.7.0 `build` (17 106 bytes)
            // became three topics, and bootstrap (8 417), session (8 205) and inspection (8 773) were tightened.
            for (const topic of TOPIC_NAMES) {
                const bytes = Buffer.byteLength(sliceTopic(doc, topic));
                assert.ok(bytes <= 7000, `topic ${topic} is ${bytes} bytes`);
            }
        });

        test('a retired name serves its successor topic, the line naming the others first', () => {
            assert.deepStrictEqual(TOPIC_NAMES, [...TOPICS, ...RETIRED_TOPICS]);
            const build = sliceTopic(doc, 'build');
            const [pointer] = build.split('\n');
            assert.ok(pointer.startsWith('_Topic `build` is split in three:'), pointer);
            for (const topic of ['`target`', '`cmsis-action`', '`flash`']) {
                assert.ok(pointer.includes(topic), `the pointer does not name ${topic}`);
            }
            assert.ok(build.endsWith(sliceTopic(doc, 'cmsis-action')), 'build does not serve the cmsis-action topic');
        });
    });
});
