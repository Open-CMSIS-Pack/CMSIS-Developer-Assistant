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
 * The tool names the MCP server can register, for the tests that hold
 * hand-written text (the skill's `allowed-tools`, the tool contract) to them.
 * Read from the sources rather than from a running server, so the gated
 * groups count although a default session leaves them out.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The files whose `registerTool('…'` calls make up the tool surface. */
const REGISTERING_SOURCES = ['debugMCPServer.ts', 'debugTools.ts', 'packDocsTools.ts', 'buildInfoTools.ts', 'knowledgeTools.ts'];

/** Every tool name registered by the sources under `<repoRoot>/src`, in source order. */
export function registeredTools(repoRoot: string): string[] {
    return REGISTERING_SOURCES.flatMap((file) => {
        const source = fs.readFileSync(path.join(repoRoot, 'src', file), 'utf8');
        return [...source.matchAll(/registerTool\('([a-z0-9_]+)'/g)].map((match) => match[1]);
    });
}

/** The values `cmsis_action` takes for `action`, from its input schema. */
export function cmsisActions(repoRoot: string): string[] {
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'debugTools.ts'), 'utf8');
    const schema = /action: z\.enum\(\[([^\]]*)\]\)/.exec(source);
    if (!schema) {
        throw new Error('the action enum of cmsis_action was not found in src/debugTools.ts');
    }
    return [...schema[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}
