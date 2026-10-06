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

/** MCP registration and input schema for board/device catalog discovery. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DiscoveryRequest } from './core/deviceDiscovery';
import type { ToolText } from './core/toolResult';
import { toCallToolResult } from './core/measuredMcpServer';

const LOOK_ONLY = { readOnlyHint: true, destructiveHint: false };
const IDENTITY = z.string().trim().min(1).max(256);

/** Register the read-only catalog adapter with its actual production schema. */
export function registerDiscoveryTool(mcp: McpServer, dispatch: (args: DiscoveryRequest) => Promise<ToolText>): void {
    mcp.registerTool('discover_board_or_device', {
        description: 'Find CMSIS board/device IDs and BSP/DFP packs. Catalog evidence, not hardware verification. ' +
            'Completeness unknown; no match does not prove no support. Literal names. ' +
            'Unknown optional fields: omit or use null; never guess.',
        annotations: LOOK_ONLY,
        inputSchema: {
            kind: z.enum(['board', 'device']),
            name: IDENTITY.describe('Literal name, optionally Vendor::Name'),
            vendor: IDENTITY.nullish(),
            revision: IDENTITY.nullish().describe('Exact board revision'),
            match: z.enum(['exact', 'contains']).nullish(),
            device: IDENTITY.nullish().describe('Verified fitted device'),
            processor: IDENTITY.nullish().describe('Selected processor name, not core type'),
            limit: z.number().int().min(1).max(25).nullish(),
            timeoutMs: z.number().int().min(100).max(60_000).nullish(),
        },
    }, (args) => dispatch({
        kind: args.kind,
        name: args.name,
        vendor: args.vendor ?? undefined,
        revision: args.revision ?? undefined,
        match: args.match ?? undefined,
        device: args.device ?? undefined,
        processor: args.processor ?? undefined,
        limit: args.limit ?? undefined,
        timeoutMs: args.timeoutMs ?? undefined,
    }).then(toCallToolResult));
}
