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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { IDebuggingHandler } from '..';
import { sliceTopic } from '../core/instructionTopics';
import { buildServerInstructions } from '../core/serverInstructions';
import { RULES_HEADING } from '../core/toolContract';
import { ToolMetrics } from '../core/toolMetrics';
import { ShippedDocs, buildSessionServer, loadToolRules } from '../debugTools';

/**
 * An agent halts the core and looks, instead of editing prints into the
 * firmware, only if every place it reads points it at the live debugger
 * first: the skill metadata (which decides whether a harness loads the skill
 * at all), the skill body, the server instructions, the start_debugging
 * description, and the guide that harnesses without skills get from
 * get_debug_instructions. Each check pins that wording where it is made:
 * the instructions as `buildServerInstructions` composes them for a default
 * session, which is also what a session serves.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SKILL_MD = path.join(REPO_ROOT, 'skills', 'cmsis-help', 'SKILL.md');
const GUIDE_MD = path.join(REPO_ROOT, 'docs', 'agent-resources', 'debug_instructions.md');

/** Runtime problem kinds whose presence in the skill description gets the skill picked. */
const TRIGGER_TERMS = ['runtime bugs', 'faults', 'crashes', 'hangs', 'failing tests', 'wrong/null values', 'unexpected output'];
/** Host-application examples that have no place in a Cortex-M guide. */
const FOREIGN_EXAMPLES = ['getUserById', 'processOrder', 'parseFloat', '"def" in python'];

/** The instructions of a session with default options, the shipped tool rules first. */
function defaultInstructions(): string {
    return buildServerInstructions(loadToolRules(new ShippedDocs()), {});
}

/** Frontmatter and body of a SKILL.md. */
function splitSkill(text: string): { description: string; body: string } {
    const fenced = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    assert.ok(fenced, 'SKILL.md opens with YAML frontmatter');
    const description = /^description:\s*(.*)$/m.exec(fenced[1]);
    assert.ok(description, 'the frontmatter has a description line');
    return { description: description[1], body: fenced[2] };
}

/** What a client of a default session is served: the instructions and each tool's description. */
interface ServedText {
    instructions: string;
    descriptions: Map<string, string>;
}

/** Connects a client to a session built by the server's own builder and reads what it serves. */
async function readServedText(): Promise<ServedText> {
    const docs = new ShippedDocs();
    const sessionServer = buildSessionServer({
        options: {},
        // Listing tools never reaches a handler.
        handlers: () => ({ debug: {} as IDebuggingHandler, serial: async () => '' }),
        ring: new ToolMetrics(),
        serverTotals: new ToolMetrics(),
        docs,
        toolRules: loadToolRules(docs),
    });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await sessionServer.connect(serverEnd);
    const client = new Client({ name: 'skill-guidance-check', version: '1.0.0' });
    await client.connect(clientEnd);
    try {
        const listing = await client.listTools();
        return {
            instructions: client.getInstructions() ?? '',
            descriptions: new Map(listing.tools.map((tool) => [tool.name, tool.description ?? ''])),
        };
    } finally {
        await client.close();
        await sessionServer.close();
    }
}

suite('Debugger-first guidance for agents', () => {
    let served: ServedText;
    const instructions = defaultInstructions();

    suiteSetup(async () => {
        served = await readServedText();
    });

    test('the skill description names the runtime problems that should trigger it', () => {
        const { description } = splitSkill(fs.readFileSync(SKILL_MD, 'utf8'));
        const missing = TRIGGER_TERMS.filter((term) => !description.includes(term));
        assert.deepStrictEqual(missing, [], 'trigger terms missing from the skill description');
    });

    test('the skill description prefers live inspection to temporary logging, without shouting', () => {
        const { description } = splitSkill(fs.readFileSync(SKILL_MD, 'utf8'));
        assert.ok(description.includes('whenever live inspection is practical'));
        assert.ok(description.includes('instead of adding temporary printf/UART logging, LED toggles, or console output'));
        assert.ok(!description.includes('MUST use first'), 'an imperative in capitals is not how the skill gets picked');
    });

    test('the debugging guide opens its workflow with the debugger-first rule and warns about logpoints', () => {
        const guide = fs.readFileSync(GUIDE_MD, 'utf8');
        assert.match(guide, /^## .*DEBUGGER FIRST/m);
        const logpoint = guide.indexOf('add_logpoint');
        assert.ok(logpoint >= 0, 'the guide discusses add_logpoint');
        assert.ok(guide.indexOf('still stops the core', logpoint) > logpoint,
            'the guide warns that a logpoint still stops the core');
    });

    test('a session is served the instructions the builder composes, the tool rules first', () => {
        assert.strictEqual(served.instructions, instructions);
        assert.ok(instructions.startsWith(`${RULES_HEADING}\n`), instructions.slice(0, 120));
    });

    test('the server instructions send the agent to the skill before anything else, and say why', () => {
        assert.ok(instructions.includes('Before anything else in such an investigation, invoke the Agent Skill "cmsis-help".'),
            instructions);
        assert.ok(instructions.includes('temporary printf/UART logging in the firmware'), 'the instructions do not say why');
    });

    test('the server instructions keep a way in for harnesses that load no skills', () => {
        assert.ok(instructions.includes('get_debug_instructions instead'), instructions);
    });

    test('start_debugging sends the agent to the skill before it is used', () => {
        const startDebugging = served.descriptions.get('start_debugging') ?? '';
        assert.ok(startDebugging.includes('Before using this tool, invoke the skill "cmsis-help".'), startDebugging);
    });

    test('the guide for harnesses without skills carries the debugger-first rule, whole and in its overview', () => {
        const guide = fs.readFileSync(GUIDE_MD, 'utf8');
        for (const [label, text] of [['guide', guide], ['overview', sliceTopic(guide)]]) {
            assert.match(text, /^## .*DEBUGGER FIRST/m, `${label}: no DEBUGGER FIRST heading`);
            assert.ok(text.includes('printf'), `${label}: does not name printf`);
        }
    });

    test('the instructions, the skill and the session topic of the guide say how to read a result (#11)', () => {
        assert.ok(instructions.includes('A failed call is marked isError and its text starts with an [ERROR_CODE]'), instructions);
        assert.ok(instructions.includes('"timeout" or "running" is not a failure'), instructions);
        const session = sliceTopic(fs.readFileSync(GUIDE_MD, 'utf8'), 'session');
        for (const [label, text] of [['guide', session]]) {
            const lines = text.split('\n');
            const start = lines.findIndex((line) => /^#+ Reading results$/.test(line));
            assert.ok(start >= 0, `${label}: no "Reading results" section`);
            const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line));
            const reading = lines.slice(start, end < 0 ? undefined : end).join('\n');
            for (const term of ['`isError`', '`structuredContent.error_code`', 'hint', '`timeout`', '`running`', '`structuredContent.problems`', '`get_recent_problems`']) {
                assert.ok(reading.includes(term), `${label}: "Reading results" does not name ${term}`);
            }
        }
    });

    test('the skill, the troubleshooting notes and the guide say what to do when the target runs or a reset did not take (#20)', () => {
        const flat = (text: string): string => text.replace(/\s+/g, ' ');
        const guide = flat(fs.readFileSync(GUIDE_MD, 'utf8'));
        assert.ok(guide.includes('A running target rejects every read and step: call `pause_execution` first, then read.'), 'the guide says what a running target rejects');
        assert.ok(guide.includes('`stop_debugging` and `cmsis_action load_and_debug` again; power-cycle only if that fails too.'),
            'the guide names the reset fallback');
        const embedded = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'agent-resources', 'troubleshooting', 'embedded.md'), 'utf8');
        assert.match(embedded, /^### `reset` Says the Target Did NOT Reset$/m);
        assert.ok(embedded.includes('`stop_debugging`, then `cmsis_action load_and_debug` — a fresh connect and reset.'));
        const inspection = sliceTopic(fs.readFileSync(GUIDE_MD, 'utf8'), 'inspection');
        assert.ok(inspection.includes('`cmsis_action load_and_debug` again; power-cycle only if that fails too.'), 'the guide names the fallback order');
    });

    test('the guide speaks Cortex-M rather than host applications', () => {
        const guide = fs.readFileSync(GUIDE_MD, 'utf8');
        const present = FOREIGN_EXAMPLES.filter((example) => guide.includes(example));
        assert.deepStrictEqual(present, [], 'host-application examples in the Cortex-M guide');
        assert.ok(guide.includes('BFAR'), 'the guide explains fault addresses (BFAR)');
    });
});
