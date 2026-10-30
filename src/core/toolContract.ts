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

/**
 * The tool contract (#50): the rules that keep agents on the MCP tools rather
 * than pyocd, gdb, cbuild or a serial terminal in the shell, and the table of
 * shell commands with the tool that replaces each.
 *
 * docs/agent-resources/tool-contract.md is the only place the text is
 * written. Its two sections sit between marker pairs (src/utils/markerBlock.ts);
 * the MCP server leads its instructions with the rules, and
 * `npm run skills:sync` copies the blocks into every file of
 * `CONTRACT_COPIES` including the authored cmsis-help skill, where
 * src/test/toolContract.test.ts compares them with the source. Pure: no I/O,
 * no vscode.
 */

import { BlockPlacement, afterBlock, extractBlock, renderBlock, upsertBlock } from '../utils/markerBlock';

/** The contract, relative to the docs/ folder the extension ships. */
export const TOOL_CONTRACT_DOC = 'agent-resources/tool-contract.md';

/** Block id of the rules. */
export const RULES_BLOCK = 'rules';
/** Block id of the shell-to-tool table. */
export const TABLE_BLOCK = 'shell-to-tool';
export type ContractBlockId = typeof RULES_BLOCK | typeof TABLE_BLOCK;

/** The first line of the rules, and so of the server instructions. */
export const RULES_HEADING = '## CMSIS Developer Assistant tool rules';

/** The two sections of the contract, each with `\n` line endings and no surrounding blank lines. */
export interface ToolContract {
    rules: string;
    table: string;
}

/** One file that carries copies of the contract, and where each block goes the first time. */
export interface ContractCopy {
    /** Relative to the repository root. */
    file: string;
    blocks: ReadonlyArray<{ id: ContractBlockId; placement: BlockPlacement }>;
}

/** Below the H1, which is the first `# ` line after the YAML frontmatter, if there is one. */
export const AFTER_HEADING_1: BlockPlacement = (lines) => {
    let from = 0;
    if (lines[0]?.trim() === '---') {
        const fence = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
        from = fence < 0 ? lines.length : fence + 1;
    }
    const heading = lines.findIndex((line, index) => index >= from && /^# /.test(line));
    return heading < 0 ? -1 : heading + 1;
};

/** Just above the closing marker of topic `name` in the agent guide (see instructionTopics.ts). */
export function endOfTopic(name: string): BlockPlacement {
    const opening = new RegExp(`^<!--\\s*topic:\\s*${name}\\s*\\|`);
    return (lines) => {
        const open = lines.findIndex((line) => opening.test(line));
        return open < 0 ? -1 : lines.findIndex((line, index) => index > open && line.trim() === '<!-- /topic -->');
    };
}

/**
 * The shipped help skill and debugging guide carry the contract. Knowledge procedure
 * sources live in cmsis-knowledge-base and contain no generated copies of these rules.
 */
export const CONTRACT_COPIES: readonly ContractCopy[] = [
    {
        file: 'skills/cmsis-help/SKILL.md',
        blocks: [
            { id: RULES_BLOCK, placement: AFTER_HEADING_1 },
            { id: TABLE_BLOCK, placement: afterBlock(RULES_BLOCK) },
        ],
    },
    {
        file: 'docs/agent-resources/debug_instructions.md',
        blocks: [
            { id: RULES_BLOCK, placement: AFTER_HEADING_1 },
            { id: TABLE_BLOCK, placement: endOfTopic('flash') },
        ],
    },
];

/** The rules and the table of the contract document; a missing or empty section is an error. */
export function parseToolContract(markdown: string): ToolContract {
    const section = (id: ContractBlockId): string => {
        const body = extractBlock(markdown, id)?.trim();
        if (!body) {
            throw new Error(`The tool contract has no "${id}" block`);
        }
        return body;
    };
    const rules = section(RULES_BLOCK);
    if (!rules.startsWith(RULES_HEADING)) {
        throw new Error(`The rules of the tool contract must start with "${RULES_HEADING}"`);
    }
    return { rules, table: section(TABLE_BLOCK) };
}

/** Block `id` of the contract as every copy carries it, markers included. */
export function renderContractBlock(id: ContractBlockId, contract: ToolContract): string {
    return renderBlock(id, id === RULES_BLOCK ? contract.rules : contract.table);
}

/** `text` (the file of `copy`) with each of its blocks set to the contract's. */
export function applyToolContract(text: string, copy: ContractCopy, contract: ToolContract): string {
    let result = text;
    for (const block of copy.blocks) {
        try {
            result = upsertBlock(result, block.id, block.id === RULES_BLOCK ? contract.rules : contract.table, block.placement);
        } catch (problem) {
            throw new Error(`${copy.file}: ${problem instanceof Error ? problem.message : String(problem)}`);
        }
    }
    return result;
}
