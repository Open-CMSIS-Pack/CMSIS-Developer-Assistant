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

/**
 * The bundled Agent Skill names every tool it is allowed to call. That list is
 * hand-written, so it drifts silently: a renamed tool leaves the skill telling
 * agents to call something that no longer exists, and a new tool never gets
 * mentioned. Both fail at runtime, in someone else's harness, with no error
 * that points back here.
 */
suite('Bundled agent skill', () => {

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const skillDir = path.join(repoRoot, 'skills', 'cmsis-debug-live');
    const skillMd = path.join(skillDir, 'SKILL.md');

    const readSkill = () => fs.readFileSync(skillMd, 'utf8');

    /**
     * Tool names the MCP server actually registers: the core surface in
     * debugMCPServer.ts plus the gated documentation / build-artefact groups
     * registered from their own files.
     */
    const registeredTools = (): string[] => {
        const files = ['debugMCPServer.ts', 'packDocsTools.ts', 'buildInfoTools.ts'];
        return files.flatMap((file) => {
            const source = fs.readFileSync(path.join(repoRoot, 'src', file), 'utf8');
            return [...source.matchAll(/registerTool\('([a-z0-9_]+)'/g)].map(m => m[1]);
        });
    };

    /** The `allowed-tools:` block of the YAML frontmatter. */
    const allowedTools = (): string[] => {
        const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readSkill());
        assert.ok(frontmatter, 'SKILL.md must open with YAML frontmatter');
        const block = /allowed-tools:\n([\s\S]*?)(?:\n[a-z-]+:|$)/.exec(frontmatter[1]);
        assert.ok(block, 'frontmatter must contain an allowed-tools list');
        return [...block[1].matchAll(/^\s*-\s*([a-z0-9_]+)\s*$/gm)].map(m => m[1]);
    };

    test('the skill ships alongside the extension', () => {
        assert.ok(fs.existsSync(skillMd), `missing ${skillMd}`);
        assert.ok(fs.existsSync(path.join(skillDir, 'README.md')));
    });

    test('its reference material is present', () => {
        const refs = path.join(skillDir, 'references');
        assert.ok(fs.existsSync(path.join(refs, 'cmsis-embedded-guide.md')));
        assert.ok(fs.existsSync(path.join(refs, 'troubleshooting', 'embedded.md')));
    });

    test('the frontmatter declares the expected skill name', () => {
        assert.match(readSkill(), /^---\nname: cmsis-debug-live\n/,
            'the directory name and the declared name have to agree');
    });

    test('every allowed tool is one the server registers', () => {
        const registered = new Set(registeredTools());
        const unknown = allowedTools().filter(t => !registered.has(t));
        assert.deepStrictEqual(unknown, [],
            'the skill names tools that do not exist — agents will call them and fail');
    });

    test('every registered tool is offered to the skill', () => {
        const allowed = new Set(allowedTools());
        const missing = registeredTools().filter(t => !allowed.has(t));
        assert.deepStrictEqual(missing, [],
            'a tool was added without being made available to the skill');
    });

    test('the tool surface it documents is embedded-specific', () => {
        const allowed = new Set(allowedTools());
        for (const tool of ['cmsis_action', 'read_memory', 'get_fault_info', 'read_peripheral_register']) {
            assert.ok(allowed.has(tool), `${tool} is core to Cortex-M debugging and must be listed`);
        }
    });

    test('it does not carry upstream\'s non-embedded troubleshooting files', () => {
        const refs = path.join(skillDir, 'references', 'troubleshooting');
        for (const irrelevant of ['python.md', 'java.md', 'go.md', 'javascript.md', 'csharp.md']) {
            assert.ok(!fs.existsSync(path.join(refs, irrelevant)),
                `${irrelevant} does not apply to a Cortex-M target`);
        }
    });
});
