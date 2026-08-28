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
 * The MCP tool surface of the build-info subsystem. Descriptions are
 * deliberately short: after the merge they count against the CMSIS
 * Developer Assistant's 30 kB `tools/list` budget.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PackDocsDispatch } from './packDocsDispatch';

const targetShape = {
    target: z.string().optional().describe('Substring of the cbuild-run context, target-type, image or processor name when there are several'),
    timeoutMs: z.number().int().min(100).max(600_000).optional().describe('Per-call timeout in ms (default from settings)'),
};

const readOnly = { readOnlyHint: true, destructiveHint: false };

function text(result: string) {
    return { content: [{ type: 'text' as const, text: result }] };
}

export function registerBuildInfoTools(mcpServer: McpServer, dispatch: PackDocsDispatch): void {
    mcpServer.registerTool('list_build_artifacts', {
        description: 'List the build output of the current csolution target from out/**/*.cbuild-run.yml: compiler, elf/axf, map, hex, ' +
            'newest build log, sizes and times, and the device memory regions. Says how to build when nothing exists.',
        annotations: readOnly,
        inputSchema: { ...targetShape },
    }, async (args) => text(await dispatch('handleListBuildArtifacts', args)));

    mcpServer.registerTool('get_memory_usage', {
        description: 'Flash/RAM usage per memory region from the ELF and linker map, then the largest symbols and the heaviest objects/libraries.',
        annotations: readOnly,
        inputSchema: {
            top: z.number().int().min(1).max(200).optional().describe('Symbols and objects to list (default 20)'),
            maxChars: z.number().int().min(500).max(60_000).optional().describe('Text budget (default 12000)'),
            ...targetShape,
        },
    }, async (args) => text(await dispatch('handleGetMemoryUsage', args)));

    mcpServer.registerTool('lookup_symbol', {
        description: 'Find a symbol by name (exact, then case-insensitive, then substring) — address, size, type, section, defining object — ' +
            'or the symbol, section and region that contain an address (a fault PC or LR).',
        annotations: readOnly,
        inputSchema: {
            name: z.string().optional().describe('Symbol name or part of it'),
            address: z.string().optional().describe('Hex address, e.g. 0x08001234'),
            ...targetShape,
        },
    }, async (args) => text(await dispatch('handleLookupSymbol', args)));

    mcpServer.registerTool('get_section_layout', {
        description: 'LOAD segments and allocated sections of the image with address, size and region, and per section the largest contributing objects from the map.',
        annotations: readOnly,
        inputSchema: {
            top: z.number().int().min(1).max(10).optional().describe('Objects per section (default 5)'),
            maxChars: z.number().int().min(500).max(60_000).optional().describe('Text budget (default 12000)'),
            ...targetShape,
        },
    }, async (args) => text(await dispatch('handleGetSectionLayout', args)));

    mcpServer.registerTool('get_build_diagnostics', {
        description: 'Errors and warnings of the newest build log (GCC/Clang/armclang/armlink/CMake/ninja/cbuild) with file:line, and the final build status. ' +
            'Logs come from cbuild --log or a tee; pass file for one saved elsewhere.',
        annotations: readOnly,
        inputSchema: {
            file: z.string().optional().describe('Log file to read instead of the newest found'),
            limit: z.number().int().min(1).max(200).optional().describe('Diagnostics to list (default 20)'),
            maxChars: z.number().int().min(500).max(60_000).optional().describe('Text budget (default 12000)'),
            ...targetShape,
        },
    }, async (args) => text(await dispatch('handleGetBuildDiagnostics', args)));
}
