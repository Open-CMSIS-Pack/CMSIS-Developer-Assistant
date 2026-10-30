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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { IDebuggingHandler } from '..';
import { sliceTopic } from '../core/instructionTopics';
import { KNOWLEDGE_REMINDER, TOOL_RULES_REMINDER, buildServerInstructions, composeInstructions } from '../core/serverInstructions';
import {
    AFTER_HEADING_1,
    CONTRACT_COPIES,
    RULES_BLOCK,
    RULES_HEADING,
    TABLE_BLOCK,
    TOOL_CONTRACT_DOC,
    ToolContract,
    applyToolContract,
    parseToolContract,
    renderContractBlock,
} from '../core/toolContract';
import { ToolMetrics } from '../core/toolMetrics';
import { ShippedDocs, buildSessionServer, loadToolRules } from '../debugTools';
import { beginMarker, endMarker, extractBlock } from '../utils/markerBlock';
import { cmsisActions, registeredTools } from './registeredTools';

/**
 * The tool contract (#50) keeps agents on the MCP tools instead of pyocd,
 * gdb, cbuild or a serial terminal. It is written once, in
 * docs/agent-resources/tool-contract.md, and reaches agents through the
 * server instructions, the first get_session_status of a session, the
 * bundled skills and the agent guide. These tests hold every copy to the
 * source, the rules to their size, and every tool the contract names to the
 * tools that exist.
 */
suite('Tool contract', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    const contract: ToolContract = parseToolContract(read(path.join('docs', TOOL_CONTRACT_DOC)));
    const bodyOf = (id: string): string => (id === RULES_BLOCK ? contract.rules : contract.table);

    test('the rules open with their heading and stay at ten lines and under 1 600 bytes', () => {
        const [heading, ...rest] = contract.rules.split('\n');
        assert.strictEqual(heading, RULES_HEADING);
        const lines = rest.filter((line) => line.trim() !== '');
        assert.ok(lines.length <= 10, `${lines.length} lines after the heading`);
        assert.ok(Buffer.byteLength(contract.rules) < 1600, `the rules are ${Buffer.byteLength(contract.rules)} bytes`);
    });

    test('the rules keep the lines agents are held to', () => {
        for (const phrase of [
            'These rules cover Arm Cortex-M targets of the CMSIS Debugger',
            'A host program or a board of another toolchain is not covered: use your usual tools there.',
            'only the user lifts a rule, by asking for the specific command',
            'against it from a shell, and never install pyOCD',
            'with `cmsis_action`; program with `flash`',
            'a procedure from `knowledge_get` or a CMSIS skill names it',
            '`serial_*` tools',
            'never read a PDF into your context',
            'Firmware symbol, section, memory-usage and build-log questions through the build-artefact tools',
            'When a call fails twice the same way',
            'follow the hints of `get_session_status` and `get_recent_problems`, never a shell command',
            'a value GDB cannot read is an answer, not a failure',
            'Leave the target running when you finish, and ask the user only for what no tool can do',
        ]) {
            assert.ok(contract.rules.includes(phrase), `the rules lost "${phrase}"`);
        }
    });

    test('what left the rules is said in the server instructions, where it applies', () => {
        const everywhere = ['never call or read them', 'list_debug_windows', 'select_debug_window', 'call pause_execution first'];
        for (const [options, phrases] of [
            [{ packDocsEnabled: true, buildInfoEnabled: true }, everywhere],
            [{ packDocsEnabled: false, buildInfoEnabled: false }, [...everywhere, 'cmsis-developer-assistant.packDocs.enabled', 'cmsis-developer-assistant.buildInfo.enabled']],
        ] as const) {
            const text = composeInstructions(options);
            for (const phrase of phrases) {
                assert.ok(text.includes(phrase), `the instructions with ${JSON.stringify(options)} lack "${phrase}"`);
            }
        }
        const on = composeInstructions({ packDocsEnabled: true, buildInfoEnabled: true });
        assert.ok(!on.includes('.enabled;'), 'with every group on, no setting is suggested');
    });

    test('every tool the contract names is registered; a name after cmsis_action is one of its actions', () => {
        const tools = new Set(registeredTools(repoRoot));
        const actions = new Set(cmsisActions(repoRoot));
        const text = `${contract.rules}\n${contract.table}`;
        const unknown: string[] = [];
        for (const match of text.matchAll(/(cmsis_action\s+)?\b([a-z][a-z0-9]*(?:_(?:[a-z0-9]+|\*))+)/g)) {
            const name = match[2];
            if (match[1] !== undefined) {
                if (!actions.has(name)) {
                    unknown.push(`cmsis_action ${name}`);
                }
            } else if (name.endsWith('_*')) {
                const prefix = name.slice(0, -1);
                if (![...tools].some((tool) => tool.startsWith(prefix))) {
                    unknown.push(name);
                }
            } else if (!tools.has(name)) {
                unknown.push(name);
            }
        }
        assert.deepStrictEqual(unknown, [], 'the contract names tools or actions that do not exist');
    });

    test('every row of the table names a registered tool to use', () => {
        const tools = new Set(registeredTools(repoRoot));
        const rows = contract.table.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Instead of'));
        assert.ok(rows.length >= 10, `${rows.length} rows`);
        for (const row of rows) {
            const use = row.split(' | ')[1] ?? '';
            const named = [...use.matchAll(/`([a-z0-9_]+)/g)].map((match) => match[1]);
            assert.ok(named.some((name) => tools.has(name)), `no tool in the "Use" cell of: ${row}`);
        }
    });

    for (const copy of CONTRACT_COPIES) {
        test(`${copy.file} carries its blocks exactly as the contract renders them`, () => {
            const text = read(copy.file);
            for (const { id } of copy.blocks) {
                assert.strictEqual(extractBlock(text, id), bodyOf(id), `${copy.file}: block "${id}" is stale — run \`npm run skills:sync\``);
                assert.ok(text.includes(renderContractBlock(id, contract)), `${copy.file}: block "${id}" differs from the rendering`);
            }
            for (const id of [RULES_BLOCK, TABLE_BLOCK].filter((block) => !copy.blocks.some((listed) => listed.id === block))) {
                assert.strictEqual(extractBlock(text, id), undefined, `${copy.file} carries block "${id}", which it is not listed for`);
            }
            assert.strictEqual(applyToolContract(text, copy, contract), text, 'a sync would change the file');
        });
    }

    test('cmsis-help carries the rules first, the table after them, and the health check after both', () => {
        const help = read('skills/cmsis-help/SKILL.md');
        const rules = help.indexOf(renderContractBlock(RULES_BLOCK, contract));
        const table = help.indexOf(renderContractBlock(TABLE_BLOCK, contract));
        assert.ok(rules >= 0 && table >= 0, 'cmsis-help lacks a block — run `npm run skills:sync`');
        assert.ok(rules < table && table < help.indexOf('\n## Health check (read-only)\n'), 'the rules, then the table, then the health check');
    });

    test('in the skills and the guide the rules follow the H1 directly, and the table follows the rules in the debugging skill', () => {
        for (const copy of CONTRACT_COPIES) {
            const lines = read(copy.file).split('\n');
            const below = AFTER_HEADING_1(lines);
            assert.deepStrictEqual(lines.slice(below, below + 2), ['', beginMarker(RULES_BLOCK)], `${copy.file}: the rules are not right below the H1`);
        }
        const skill = read('skills/cmsis-help/SKILL.md');
        assert.ok(skill.includes(`${endMarker(RULES_BLOCK)}\n\n${beginMarker(TABLE_BLOCK)}\n`), 'the table does not follow the rules');
    });

    test('the guide\'s overview starts with the rules and its flash topic carries the table', () => {
        const guide = read('docs/agent-resources/debug_instructions.md');
        const overview = sliceTopic(guide);
        const [title] = guide.split('\n');
        assert.ok(overview.startsWith(`${title}\n\n${renderContractBlock(RULES_BLOCK, contract)}\n\n## Work through these steps in order\n`),
            overview.slice(0, 200));
        assert.ok(sliceTopic(guide, 'flash').includes(renderContractBlock(TABLE_BLOCK, contract)), 'the flash topic lacks the table');
        for (const topic of ['bootstrap', 'session', 'target', 'cmsis-action', 'breakpoints', 'inspection', 'faults', 'troubleshooting']) {
            assert.ok(!sliceTopic(guide, topic).includes(beginMarker(TABLE_BLOCK)), `the ${topic} topic carries the table`);
        }
        assert.ok(!overview.includes(beginMarker(TABLE_BLOCK)), 'the overview carries the table');
    });

    test('the server instructions start with the rules; without them the text is what it was', () => {
        for (const options of [{}, { packDocsEnabled: true, buildInfoEnabled: true }]) {
            const composed = buildServerInstructions(contract.rules, options);
            assert.strictEqual(composed, `${contract.rules}\n\n${composeInstructions(options)}`);
            assert.ok(composed.startsWith(`${RULES_HEADING}\n`));
            assert.strictEqual(buildServerInstructions(undefined, options), composeInstructions(options));
        }
    });

    test('the server reads the rules from the shipped contract, and does without them when the file is missing', () => {
        assert.strictEqual(loadToolRules(new ShippedDocs()), contract.rules);
        const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-contract-'));
        try {
            assert.strictEqual(loadToolRules(new ShippedDocs(path.join(nowhere, 'dist', 'bundle'))), undefined);
        } finally {
            fs.rmSync(nowhere, { recursive: true, force: true });
        }
    });

    suite('in a session', () => {
        /** A session whose only working tool is get_session_status, and a client connected to it. */
        async function connect(toolRules: string | undefined, clientName = 'tool-contract-check'): Promise<{ client: Client; close: () => Promise<void> }> {
            const debug = { handleGetSessionStatus: async () => 'State: no-session' } as unknown as IDebuggingHandler;
            const server = buildSessionServer({
                options: {},
                handlers: () => ({ debug, serial: async () => '' }),
                ring: new ToolMetrics(),
                serverTotals: new ToolMetrics(),
                docs: new ShippedDocs(),
                toolRules,
            });
            const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
            await server.connect(serverEnd);
            const client = new Client({ name: clientName, version: '1.0.0' });
            await client.connect(clientEnd);
            return { client, close: async () => { await client.close(); await server.close(); } };
        }

        const statusText = async (client: Client): Promise<string> => {
            const result = await client.callTool({ name: 'get_session_status', arguments: {} });
            const content = result.content as Array<{ type: string; text?: string }>;
            return content.map((item) => item.text ?? '').join('\n');
        };

        test('the instructions lead with the rules, and only the first status repeats them', async () => {
            const { client, close } = await connect(contract.rules);
            try {
                assert.ok(client.getInstructions()?.startsWith(`${RULES_HEADING}\n`));
                const first = await statusText(client);
                assert.ok(first.startsWith(`State: no-session\n\n${TOOL_RULES_REMINDER} ${KNOWLEDGE_REMINDER}\n\nTool stats (this session):`), first);
                const second = await statusText(client);
                assert.ok(!second.includes(TOOL_RULES_REMINDER), second);
                assert.ok(second.startsWith('State: no-session\n\nTool stats (this session):'), second);
            } finally {
                await close();
            }
        });

        test('a client that drops the instructions (Kimi Code) gets the whole rules in the first status, once', async () => {
            const { client, close } = await connect(contract.rules, 'kimi-code');
            try {
                const first = await statusText(client);
                assert.ok(first.startsWith(`State: no-session\n\n${contract.rules}\n\n${KNOWLEDGE_REMINDER}\n\nTool stats (this session):`), first);
                assert.ok(!first.includes('see the server instructions'), 'no pointer to instructions the model never sees');
                const second = await statusText(client);
                assert.ok(second.startsWith('State: no-session\n\nTool stats (this session):'), second);
            } finally {
                await close();
            }
        });

        test('a session without the rules has neither them nor the reminder', async () => {
            const { client, close } = await connect(undefined);
            try {
                assert.strictEqual(client.getInstructions(), composeInstructions({}));
                assert.ok(!(await statusText(client)).includes(TOOL_RULES_REMINDER));
            } finally {
                await close();
            }
        });

        test('no tool description carries the contract: tools/list does not grow', async () => {
            const { client, close } = await connect(contract.rules);
            try {
                const { tools } = await client.listTools();
                for (const tool of tools) {
                    const description = tool.description ?? '';
                    assert.ok(!description.includes('Instead of') && !description.includes('tool rules'), tool.name);
                    assert.ok(!/pip3? install|\bon (?:the )?PATH\b/.test(description), `${tool.name} sends agents to the shell`);
                }
            } finally {
                await close();
            }
        });
    });

    test('no shipped text sends agents to the shell outside the table and the prohibitions', () => {
        const roots = ['docs/agent-resources', 'skills/cmsis-help'];
        const files = roots.flatMap((root) => markdownFiles(path.join(repoRoot, root)));
        assert.ok(files.length >= 7, `${files.length} files`);
        const offenders: string[] = [];
        for (const file of files) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            let inTable = false;
            lines.forEach((line, index) => {
                if (line.trim() === beginMarker(TABLE_BLOCK)) {
                    inTable = true;
                } else if (line.trim() === endMarker(TABLE_BLOCK)) {
                    inTable = false;
                }
                const where = `${path.relative(repoRoot, file)}:${index + 1}`;
                if (/\bon (?:the )?PATH\b/.test(line)) {
                    offenders.push(`${where} on PATH`);
                }
                if (!inTable && /pip3? install|pipx install/.test(line)) {
                    offenders.push(`${where} pip install`);
                }
                if (!inTable && /pyocd list|JLinkExe/.test(line) && !/\b(?:[Dd]o not|[Nn]ever)\b/.test(line)) {
                    offenders.push(`${where} probe check in the shell`);
                }
            });
        }
        assert.deepStrictEqual(offenders, []);
    });
});

/** Every .md file below `dir`. */
function markdownFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return markdownFiles(full);
        }
        return entry.name.endsWith('.md') ? [full] : [];
    });
}
