#!npx tsx

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
 * Regenerate `skills/catalog.json` from the extension's own skills that
 * `scripts/skills.config.json` lists, and copy the tool contract
 * (docs/agent-resources/tool-contract.md) into the files that carry it.
 *
 *   npm run skills:sync
 *
 * Procedure sources and routing definitions live in cmsis-knowledge-base/sources/cda-procedures.
 * This script owns only the installed help skill, its catalog and the local tool-contract copies.
 * A `$name` hand-over must resolve to cmsis-help or a procedure of the pinned core index.
 *
 * Idempotent: running twice produces no diff.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';

import { CONTRACT_COPIES, TOOL_CONTRACT_DOC, ToolContract, applyToolContract, parseToolContract } from '../src/core/toolContract.js';
import {
    SKILL_CATEGORY_ORDER,
    SkillCatalog,
    SkillCatalogEntry,
    SkillCategory,
    extractSkillReferences,
    parseSkillFrontmatter,
} from '../src/utils/skillCatalog.js';

/** The one skill the extension installs: the health check and the entry point to the knowledge (see skills/cmsis-help). */
const HELP_SKILL_NAME = 'cmsis-help';

interface SkillsConfig {
    /** Skills installed from this extension; knowledge sources live in the knowledge-base repository. */
    bundled: { name: string; category: SkillCategory; hidden?: boolean }[];
    /** The skills the extension installs. */
    installed: string[];
}

const MAX_DESCRIPTION_LENGTH = 1024;
/** What `extractSkillReferences` returns that looks like a skill name; `$HOME` and the like do not. */
const SKILL_NAME = /^[a-z]+(?:-[a-z0-9]+)+$/;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const skillsDir = path.join(repoRoot, 'skills');
const catalogPath = path.join(skillsDir, 'catalog.json');
const configPath = path.join(scriptDir, 'skills.config.json');
const coreIndexPath = path.join(repoRoot, 'resources', 'knowledge', 'core.db');

function readJson<T>(file: string): T {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function writeJson(file: string, value: unknown): void {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function fail(message: string): never {
    console.error(`sync-skills: ${message}`);
    process.exit(1);
}

/** `interface.display_name` / `interface.short_description` from a skill's agents/openai.yaml. */
function readOpenAiMetadata(skillDir: string): { displayName?: string; shortDescription?: string } {
    const file = path.join(skillDir, 'agents', 'openai.yaml');
    if (!fs.existsSync(file)) {
        return {};
    }
    const yaml = fs.readFileSync(file, 'utf8');
    const read = (key: string): string | undefined => {
        const match = new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm').exec(yaml);
        if (!match) {
            return undefined;
        }
        const value = match[1].trim();
        return value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    };
    return { displayName: read('display_name'), shortDescription: read('short_description') };
}

function validateConfig(config: SkillsConfig): void {
    const names = config.bundled.map(bundled => bundled.name);
    if (new Set(names).size !== names.length) {
        fail('scripts/skills.config.json lists a skill twice under "bundled"');
    }
    if (names.length !== 1 || names[0] !== HELP_SKILL_NAME || config.installed.length !== 1 || config.installed[0] !== HELP_SKILL_NAME) {
        fail(`scripts/skills.config.json must list and install only ${HELP_SKILL_NAME}`);
    }
}

/** The names `proc-<name>` of the procedures in the pinned core index. */
function indexProcedures(): Set<string> {
    if (!fs.existsSync(coreIndexPath)) {
        fail(`${path.relative(repoRoot, coreIndexPath)} is missing: run \`npm run knowledge:fetch\` first; the hand-overs are checked against it`);
    }
    const db = new DatabaseSync(coreIndexPath, { readOnly: true });
    try {
        const rows = db.prepare("SELECT id FROM nodes WHERE type = 'procedure' AND id LIKE 'proc-%'").all();
        return new Set(rows.map(row => String(row.id).slice('proc-'.length)));
    } finally {
        db.close();
    }
}

function readToolContract(): ToolContract {
    const file = path.join(repoRoot, 'docs', TOOL_CONTRACT_DOC);
    try {
        return parseToolContract(fs.readFileSync(file, 'utf8'));
    } catch (problem) {
        fail(`${path.relative(repoRoot, file)}: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
}

/** The catalog entry of one of the extension's skills, its hand-overs checked. */
function bundledEntry(bundled: SkillsConfig['bundled'][number], config: SkillsConfig, reachable: ReadonlySet<string>): SkillCatalogEntry {
    const skillDir = path.join(skillsDir, bundled.name);
    const markdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const frontmatter = parseSkillFrontmatter(markdown);
    if (!frontmatter || frontmatter.name !== bundled.name) {
        fail(`skill ${bundled.name} has no valid frontmatter`);
    }
    // The Agent Skills limit binds what a harness loads: the installed skills. The others are unit sources.
    if (config.installed.includes(bundled.name) && frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
        fail(`skill ${bundled.name} description is ${frontmatter.description.length} chars; the Agent Skills limit is ${MAX_DESCRIPTION_LENGTH}`);
    }
    const references = extractSkillReferences(markdown).filter(ref => ref !== bundled.name && SKILL_NAME.test(ref));
    // A hand-over to a procedure the index does not have is a dead end for the agent (2.5.15 shipped two).
    const unknown = references.filter(ref => !reachable.has(ref));
    if (unknown.length > 0) {
        fail(`skill ${bundled.name} hands over to procedure(s) the core index does not have: ${unknown.join(', ')}`);
    }
    const ownNames = new Set(config.bundled.map(b => b.name));
    const metadata = readOpenAiMetadata(skillDir);
    return {
        name: bundled.name,
        description: frontmatter.description,
        category: bundled.category,
        kind: 'skill',
        source: bundled.hidden ? 'extension' : 'bundled',
        path: `skills/${bundled.name}`,
        ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
        ...(metadata.shortDescription ? { shortDescription: metadata.shortDescription } : {}),
        dependsOn: references.filter(ref => ownNames.has(ref)),
        installed: config.installed.includes(bundled.name),
        invocable: !bundled.hidden,
    };
}

function main(): void {
    if (process.argv.includes('--update')) {
        fail('nothing is vendored any more: the knowledge base fetches Open-CMSIS-Pack/cmsis-skills itself');
    }
    // `--offline` is accepted and changes nothing: the script never fetches.
    const config = readJson<SkillsConfig>(configPath);
    validateConfig(config);
    const contract = readToolContract();
    const procedures = indexProcedures();
    const reachable = new Set([...config.bundled.map(b => b.name), ...procedures]);

    const skills = config.bundled.map(bundled => bundledEntry(bundled, config, reachable));
    skills.sort((a, b) => {
        const categoryDelta = SKILL_CATEGORY_ORDER.indexOf(a.category) - SKILL_CATEGORY_ORDER.indexOf(b.category);
        if (categoryDelta !== 0) {
            return categoryDelta;
        }
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    const catalog: SkillCatalog = { schemaVersion: 1, skills };
    writeJson(catalogPath, catalog);

    // The blocks between the markers are replaced; the rest of each file is
    // hand-written and stays as it is. src/test/toolContract.test.ts compares.
    for (const copy of CONTRACT_COPIES) {
        const file = path.join(repoRoot, copy.file);
        const before = fs.readFileSync(file, 'utf8');
        let after: string;
        try {
            after = applyToolContract(before, copy, contract);
        } catch (problem) {
            fail(problem instanceof Error ? problem.message : String(problem));
        }
        if (after !== before) {
            fs.writeFileSync(file, after, 'utf8');
            console.log(`Tool contract written into ${copy.file}`);
        }
    }

    const installed = skills.filter(entry => entry.installed).map(entry => entry.name);
    console.log(`Catalog: ${skills.length} skills of the extension, installed: ${installed.join(', ')}; `
        + `hand-overs checked against the ${procedures.size} procedures of the core index`);
}

main();
