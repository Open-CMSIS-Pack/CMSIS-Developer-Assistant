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
 * The MCP tool surface of the experimental knowledge tools. Descriptions are
 * short: `tools/list` rides along on every turn. The project context is
 * resolved by the window, so the tools take no device, compiler or path.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toCallToolResult } from './core/measuredMcpServer';
import type { ToolText } from './core/toolResult';
import type { PackDocsDispatch } from './packDocsDispatch';

const readOnly = { readOnlyHint: true, destructiveHint: false };

/** The MCP result of a dispatched op's outcome, built by the one mapping in `MeasuredMcpServer`. */
function reply(result: ToolText): CallToolResult {
    return toCallToolResult(result);
}

export function registerKnowledgeTools(mcpServer: McpServer, dispatch: PackDocsDispatch): void {
    mcpServer.registerTool('knowledge_search', {
        description: 'Search the CMSIS knowledge base (procedures, rules, concepts, causes and fixes of tool messages). Paste an exact error ' +
            'text to hit its troubleshooting unit. Filtered by the active target; returns ids and summaries only.',
        annotations: readOnly,
        inputSchema: {
            query: z.string().describe('Error text or question'),
            tools: z.array(z.string()).optional().describe('Tools the message is from, e.g. ["packchk"]; message codes repeat across tools'),
            types: z.array(z.enum(['procedure', 'rule', 'concept', 'pattern', 'troubleshooting'])).optional(),
            domain: z.string().optional(),
            k: z.number().int().min(1).max(20).optional().describe('Results at most (default 8)'),
        },
    }, async (args) => reply(await dispatch('handleKnowledgeSearch', args)));

    mcpServer.registerTool('knowledge_get', {
        description: 'The full knowledge unit of an id from knowledge_search, never clipped. Read it before acting; follow a procedure with its stop conditions.',
        annotations: readOnly,
        inputSchema: { id: z.string() },
    }, async (args) => reply(await dispatch('handleKnowledgeGet', args)));

    mcpServer.registerTool('knowledge_expand', {
        description: 'One hop from a knowledge unit or entity: what it requires, refines, constrains, produces, consumes, references or applies to.',
        annotations: readOnly,
        inputSchema: {
            id: z.string(),
            relation: z.string().optional().describe('One relation only, e.g. requires'),
        },
    }, async (args) => reply(await dispatch('handleKnowledgeExpand', args)));
}
