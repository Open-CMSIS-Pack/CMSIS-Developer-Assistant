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
import { registeredTools } from './registeredTools';

/** The installed health-check skill may invoke only tools the extension actually registers. */
suite('Installed agent skill', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const skillFile = path.join(repoRoot, 'skills', 'cmsis-help', 'SKILL.md');

    test('the only authored skill directory is cmsis-help', () => {
        const directories = fs.readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
            .filter(entry => entry.isDirectory()).map(entry => entry.name);
        assert.deepStrictEqual(directories, ['cmsis-help']);
        assert.match(fs.readFileSync(skillFile, 'utf8'), /^---\nname: cmsis-help\n/);
    });

    test('the health check names only registered tools, including knowledge tools', () => {
        const markdown = fs.readFileSync(skillFile, 'utf8');
        const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown);
        assert.ok(frontmatter);
        const allowed = [...frontmatter[1].matchAll(/^\s*-\s*([a-z0-9_]+)\s*$/gm)].map(match => match[1]);
        assert.ok(allowed.length > 0);
        const registered = new Set(registeredTools(repoRoot));
        assert.deepStrictEqual(allowed.filter(name => !registered.has(name)), []);
        for (const name of ['get_session_status', 'knowledge_search', 'knowledge_get']) {
            assert.ok(allowed.includes(name), name);
        }
    });
});
