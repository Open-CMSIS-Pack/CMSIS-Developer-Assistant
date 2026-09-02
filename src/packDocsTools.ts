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
 * The MCP tool surface. Descriptions are deliberately short: after the
 * merge they count against the CMSIS Developer Assistant's 30 kB
 * `tools/list` budget.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PackDocsDispatch } from './packDocsDispatch';

const TIMEOUT_DESC = 'Per-call timeout in ms (default from settings).';

const targetShape = {
    target: z.string().optional().describe('Substring of the cbuild-run context or target-type when the workspace has several'),
    pack: z.string().optional().describe('Vendor::Name@version to bypass the cbuild-run lookup, e.g. Keil::STM32F7xx_DFP@3.0.0'),
    device: z.string().optional().describe('Device name, e.g. STM32F756ZGTx (with pack, or to override the cbuild-run)'),
    board: z.string().optional().describe('Board name, e.g. NUCLEO-F756ZG'),
    timeoutMs: z.number().int().min(100).max(600_000).optional().describe(TIMEOUT_DESC),
};

function text(result: string) {
    return { content: [{ type: 'text' as const, text: result }] };
}

export function registerPackDocsTools(mcpServer: McpServer, dispatch: PackDocsDispatch): void {
    mcpServer.registerTool('list_target_docs', {
        description: 'List the documentation of the current csolution target: the reference manuals, datasheets, errata ' +
            'and board manuals its DFP/BSP ship or link, plus the datasheets of third-party parts (sensors, ADCs) the ' +
            'user added — call it first for any part number. Ids for search_target_docs and read_doc_pages. Resolves ' +
            'the target from *.cbuild-run.yml; pass pack + device when there is no build.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
            ...targetShape,
            includeUnlisted: z.boolean().optional().describe('Also list PDFs in the pack that no <book> references (default from settings)'),
        },
    }, async (args) => text(await dispatch('handleListTargetDocs', args)));

    mcpServer.registerTool('search_target_docs', {
        description: 'Search the target\'s pack, fetched, user and workspace documents page by page (register names, bit fields, ' +
            'addresses, part numbers, quoted phrases) and get ranked pages with section and snippet. Extracts and indexes on first use.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
            query: z.string().min(1).describe('Words, identifiers (RCC_AHB1ENR, GPIOAEN, 0x40023800) or "quoted phrases"'),
            doc: z.string().optional().describe('Restrict to one document: an id or part of it / its title'),
            limit: z.number().int().min(1).max(25).optional().describe('Hits to return (default 8)'),
            includeUnlisted: z.boolean().optional().describe('Also search pack PDFs not attributed to this device/board (default false)'),
            ...targetShape,
        },
    }, async (args) => text(await dispatch('handleSearchTargetDocs', args)));

    mcpServer.registerTool('fetch_doc', {
        description: 'Download a web-linked document (an arm.com book or Arm document id such as ddi0553, or a direct PDF URL ' +
            'found on the web — a sensor or ADC datasheet) into the local cache and index it for search_target_docs and ' +
            'read_doc_pages instead of reading the PDF. Only this call downloads anything.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: {
            doc: z.string().optional().describe('Document id from list_target_docs (arm/ddi0553-latest) or an Arm document id (ddi0553)'),
            url: z.string().optional().describe('Alternatively a developer.arm.com/documentation/<id> or direct PDF URL'),
            refresh: z.boolean().optional().describe('Download again even if cached'),
            ...targetShape,
        },
    }, async (args) => text(await dispatch('handleFetchDoc', args)));

    mcpServer.registerTool('get_peripheral_docs', {
        description: 'Documentation dossier for one peripheral instance of the target (USART1, TIM2, GPIOA) from the SVD and the ' +
            'indexed manuals: base address and registers, the chapters that cover it with page ranges, the manual page of each ' +
            'register, the RCC clock-enable/reset bits with their page, interrupt vectors, errata mentions. Deterministic and ' +
            'page-cited; follow with read_doc_pages.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
            peripheral: z.string().min(1).describe('Instance name from the SVD, e.g. USART1, TIM2, GPIOA (a type like UART lists the instances)'),
            aspects: z.array(z.enum(['chapters', 'registers', 'clock', 'irq', 'errata'])).optional().describe('Subset to include (default all)'),
            doc: z.string().optional().describe('Restrict to one document (id or title substring)'),
            pname: z.string().optional().describe('Processor name on multi-core devices'),
            maxRegisters: z.number().int().min(1).max(200).optional().describe('Registers to map to pages (default 40)'),
            maxChars: z.number().int().min(500).max(60_000).optional().describe('Output budget (default 8000)'),
            ...targetShape,
        },
    }, async (args) => text(await dispatch('handleGetPeripheralDocs', args)));

    mcpServer.registerTool('read_doc_pages', {
        description: 'Read pages of a target document by id: "519", "519-521" or "519,523". Cite as <id> <edition> p.<n>.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {
            doc: z.string().min(1).describe('Document id from list_target_docs / search_target_docs'),
            pages: z.string().min(1).describe('Page number, range or list (1-based)'),
            maxChars: z.number().int().min(500).max(60_000).optional().describe('Total text budget (default 12000)'),
            ...targetShape,
        },
    }, async (args) => text(await dispatch('handleReadDocPages', args)));
}
