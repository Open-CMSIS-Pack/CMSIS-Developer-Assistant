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
 * Vendor the Agent Skills of Open-CMSIS-Pack/cmsis-agent into `skills/` and
 * regenerate `skills/catalog.json` plus the per-category router skills.
 *
 *   npm run skills:sync              # re-vendor at the SHA pinned in skills/cmsis-agent.lock.json
 *   npm run skills:sync -- --update  # resolve the lock's `ref` (main) to its current SHA first
 *
 * Upstream publishes no tags or releases, so the pin is a commit SHA. The
 * fetch is a shallow git fetch of that one commit — no extra dependencies,
 * and CI never runs this; the vendored result is committed.
 *
 * Idempotent: running twice at the same SHA produces no diff (nothing
 * timestamped lands in generated files except the lock's `fetchedAt`, which
 * only changes when the SHA does).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
    SKILL_CATEGORY_ORDER,
    SkillCatalog,
    SkillCatalogEntry,
    SkillCategory,
    extractSkillReferences,
    parseSkillFrontmatter,
} from '../src/utils/skillCatalog.js';
import {
    HELP_SKILL_NAME,
    HelpSkillConfig,
    helpCatalogEntry,
    readPackageContributions,
    renderHelpOpenAiYaml,
    renderHelpSkillMarkdown,
} from '../src/utils/skillHelp.js';
import { hashTree } from '../src/utils/treeHash.js';

interface SkillLock {
    repository: string;
    ref: string;
    sha: string;
    sourcePath: string;
    fetchedAt: string;
    contentHash: string;
}

interface CategoryConfig {
    id: SkillCategory;
    label: string;
    router: string;
    displayName: string;
    shortDescription: string;
    description: string;
    workflow: string[];
}

interface SkillsConfig {
    /** `generated: true` marks a bundled skill this script writes itself (the help skill). */
    bundled: { name: string; category: SkillCategory; generated?: boolean }[];
    help: HelpSkillConfig;
    categories: CategoryConfig[];
}

interface UpstreamSkill {
    name: string;
    category: SkillCategory;
    description: string;
    displayName?: string;
    shortDescription?: string;
    sourceDir: string;
    markdown: string;
}

const MAX_DESCRIPTION_LENGTH = 1024;
const SETTING_ID = 'cmsis-developer-assistant.installedSkills';
const COMMAND_TITLE = 'CMSIS Developer Assistant: Select Agent Skills';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const skillsDir = path.join(repoRoot, 'skills');
const vendorDir = path.join(skillsDir, 'cmsis-agent');
const lockPath = path.join(skillsDir, 'cmsis-agent.lock.json');
const catalogPath = path.join(skillsDir, 'catalog.json');
const configPath = path.join(scriptDir, 'skills.config.json');

const update = process.argv.includes('--update');

function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

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

function fetchUpstream(lock: SkillLock, sha: string): string {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-agent-sync-'));
    console.log(`Fetching ${lock.repository} @ ${sha.slice(0, 12)} ...`);
    git(['init', '-q'], scratch);
    git(['remote', 'add', 'origin', lock.repository], scratch);
    git(['fetch', '-q', '--depth', '1', 'origin', sha], scratch);
    git(['checkout', '-q', 'FETCH_HEAD'], scratch);
    return scratch;
}

function collectUpstreamSkills(sourceRoot: string): UpstreamSkill[] {
    if (!fs.existsSync(sourceRoot)) {
        fail(`source path ${sourceRoot} does not exist in the fetched tree`);
    }
    const skills: UpstreamSkill[] = [];
    for (const categoryEntry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
        if (!categoryEntry.isDirectory()) {
            continue;
        }
        const category = categoryEntry.name as SkillCategory;
        if (!SKILL_CATEGORY_ORDER.includes(category)) {
            fail(`upstream category "${category}" is not one of ${SKILL_CATEGORY_ORDER.join(', ')} — extend SkillCategory first`);
        }
        const categoryDir = path.join(sourceRoot, category);
        for (const skillEntry of fs.readdirSync(categoryDir, { withFileTypes: true })) {
            if (!skillEntry.isDirectory()) {
                continue;
            }
            const sourceDir = path.join(categoryDir, skillEntry.name);
            const skillFile = path.join(sourceDir, 'SKILL.md');
            if (!fs.existsSync(skillFile)) {
                console.warn(`  skipping ${category}/${skillEntry.name}: no SKILL.md`);
                continue;
            }
            const markdown = fs.readFileSync(skillFile, 'utf8');
            const frontmatter = parseSkillFrontmatter(markdown);
            if (!frontmatter) {
                fail(`${category}/${skillEntry.name}/SKILL.md has no parseable name/description frontmatter`);
            }
            if (frontmatter.name !== skillEntry.name) {
                fail(`${category}/${skillEntry.name}: frontmatter name "${frontmatter.name}" differs from the directory name`);
            }
            skills.push({
                name: frontmatter.name,
                category,
                description: frontmatter.description,
                sourceDir,
                markdown,
                ...readOpenAiMetadata(sourceDir),
            });
        }
    }
    return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function routerMarkdown(category: CategoryConfig, members: UpstreamSkill[], allDescriptions: Map<string, string>): string {
    const rows = members.map(member => {
        const what = member.shortDescription ?? firstSentence(member.description);
        return `| ${what.replace(/\|/g, '\\|')} | \`$${member.name}\` |`;
    });
    const workflow = category.workflow.map((line, index) => `${index + 1}. ${line}`);
    const memberLines = members.map(member => `- \`$${member.name}\` — ${firstSentence(allDescriptions.get(member.name) ?? member.description)}`);

    return [
        '---',
        `name: ${category.router}`,
        // Double-quoted so a ": " inside the prose cannot be read as a mapping.
        `description: ${JSON.stringify(category.description)}`,
        '---',
        '',
        `# ${category.label} (entry point)`,
        '',
        'This skill does no work of its own. It selects one of the member skills below and hands',
        'over to it. Every `$name` is a skill installed next to this one — `../<name>/SKILL.md`',
        'relative to this file — and the member skills are the source of truth for their own',
        'prerequisites, steps and guardrails.',
        '',
        '## Pick the skill',
        '',
        '| If the user wants to… | Hand over to |',
        '|---|---|',
        ...rows,
        '',
        '## Typical workflow',
        '',
        ...workflow,
        '',
        '## How to hand over',
        '',
        '- Invoke the chosen skill through your harness\'s skill mechanism (a Skill tool, `$name`,',
        '  `/name`). If it is not offered, read `../<name>/SKILL.md` and follow it verbatim.',
        '- Honour its *Prerequisites* — if it names another `$skill`, run that one first — and apply',
        '  its *Guardrails*. Do not merge, reorder or paraphrase steps across member skills.',
        '- If `../<name>/SKILL.md` is missing, say so instead of improvising: the skill was not',
        `  installed. The user can add it with **${COMMAND_TITLE}** in VS Code or by editing the`,
        `  \`${SETTING_ID}\` setting.`,
        '',
        '## Member skills',
        '',
        ...memberLines,
        '',
        'Need the full list of CMSIS slash commands, VS Code commands, MCP tools and settings?',
        `Invoke \`/${HELP_SKILL_NAME}\`.`,
        '',
        `_Generated by \`npm run skills:sync\` from the category "${category.id}" of`,
        'Open-CMSIS-Pack/cmsis-agent; edit `scripts/skills.config.json`, not this file._',
        '',
    ].join('\n');
}

function routerOpenAiYaml(category: CategoryConfig): string {
    return [
        'interface:',
        `  display_name: "${category.displayName}"`,
        `  short_description: "${category.shortDescription}"`,
        `  default_prompt: "Use $${category.router} to ${category.shortDescription.charAt(0).toLowerCase()}${category.shortDescription.slice(1)}."`,
        '',
    ].join('\n');
}

function firstSentence(text: string): string {
    const match = /^(.*?[.!?])(?:\s|$)/.exec(text);
    return (match ? match[1] : text).trim();
}

function main(): void {
    const lock = readJson<SkillLock>(lockPath);
    const config = readJson<SkillsConfig>(configPath);

    let sha = lock.sha;
    if (update || !sha) {
        if (!update) {
            fail('the lock file has no sha yet — run with --update to pin one');
        }
        const resolved = git(['ls-remote', lock.repository, lock.ref], repoRoot).split(/\s+/)[0];
        if (!/^[0-9a-f]{40}$/.test(resolved)) {
            fail(`could not resolve ${lock.ref} at ${lock.repository}`);
        }
        sha = resolved;
        console.log(`Resolved ${lock.ref} -> ${sha}`);
    }

    const scratch = fetchUpstream(lock, sha);
    try {
        const sourceRoot = path.join(scratch, lock.sourcePath);
        const upstream = collectUpstreamSkills(sourceRoot);
        if (upstream.length === 0) {
            fail('no upstream skills found');
        }

        // --- validate names ---------------------------------------------------
        const reserved = new Set<string>([
            ...config.bundled.map(b => b.name),
            ...config.categories.map(c => c.router),
        ]);
        const seen = new Set<string>();
        for (const skill of upstream) {
            if (seen.has(skill.name)) {
                fail(`duplicate upstream skill name "${skill.name}" — install directories are flat`);
            }
            if (reserved.has(skill.name)) {
                fail(`upstream skill "${skill.name}" collides with a bundled or router skill name`);
            }
            seen.add(skill.name);
        }
        for (const category of config.categories) {
            if (category.description.length > MAX_DESCRIPTION_LENGTH) {
                fail(`router ${category.router} description is ${category.description.length} chars; the Agent Skills limit is ${MAX_DESCRIPTION_LENGTH}`);
            }
        }
        if (config.help.description.length > MAX_DESCRIPTION_LENGTH) {
            fail(`${HELP_SKILL_NAME} description is ${config.help.description.length} chars; the Agent Skills limit is ${MAX_DESCRIPTION_LENGTH}`);
        }
        if (!config.bundled.some(bundled => bundled.name === HELP_SKILL_NAME && bundled.generated)) {
            fail(`scripts/skills.config.json must list ${HELP_SKILL_NAME} under "bundled" with "generated": true`);
        }

        // --- vendor --------------------------------------------------------------
        fs.rmSync(vendorDir, { recursive: true, force: true });
        fs.mkdirSync(vendorDir, { recursive: true });
        for (const skill of upstream) {
            fs.cpSync(skill.sourceDir, path.join(vendorDir, skill.name), { recursive: true });
        }
        const licenseSource = path.join(scratch, 'LICENSE');
        if (fs.existsSync(licenseSource)) {
            fs.copyFileSync(licenseSource, path.join(vendorDir, 'LICENSE'));
        } else {
            console.warn('  upstream has no LICENSE file at the repository root');
        }
        console.log(`Vendored ${upstream.length} skills into ${path.relative(repoRoot, vendorDir)}`);

        // --- references -------------------------------------------------------
        const knownNames = new Set<string>([...seen, ...reserved]);
        const dependsOn = new Map<string, string[]>();
        const unresolved = new Map<string, string[]>();
        for (const skill of upstream) {
            const refs = extractSkillReferences(skill.markdown).filter(ref => ref !== skill.name);
            dependsOn.set(skill.name, refs.filter(ref => knownNames.has(ref)));
            const missing = refs.filter(ref => !knownNames.has(ref) && /^[a-z]+(?:-[a-z0-9]+)+$/.test(ref));
            if (missing.length > 0) {
                unresolved.set(skill.name, missing);
            }
        }
        if (unresolved.size > 0) {
            for (const [name, refs] of unresolved) {
                console.error(`  ${name} refers to unknown skill(s): ${refs.join(', ')}`);
            }
            fail('unresolved $skill references — upstream renamed or removed a skill; check the lines above');
        }

        // --- routers ------------------------------------------------------------
        const allDescriptions = new Map(upstream.map(skill => [skill.name, skill.description]));
        const routerEntries: SkillCatalogEntry[] = [];
        for (const category of config.categories) {
            const members = upstream.filter(skill => skill.category === category.id);
            const routerDir = path.join(skillsDir, category.router);
            if (members.length === 0) {
                fs.rmSync(routerDir, { recursive: true, force: true });
                console.warn(`  category ${category.id} has no upstream skills; router ${category.router} not generated`);
                continue;
            }
            fs.rmSync(routerDir, { recursive: true, force: true });
            fs.mkdirSync(path.join(routerDir, 'agents'), { recursive: true });
            fs.writeFileSync(path.join(routerDir, 'SKILL.md'), routerMarkdown(category, members, allDescriptions), 'utf8');
            fs.writeFileSync(path.join(routerDir, 'agents', 'openai.yaml'), routerOpenAiYaml(category), 'utf8');
            routerEntries.push({
                name: category.router,
                description: category.description,
                category: category.id,
                kind: 'router',
                source: 'generated',
                path: `skills/${category.router}`,
                displayName: category.displayName,
                shortDescription: category.shortDescription,
                dependsOn: members.map(member => member.name),
            });
        }

        // --- bundled -----------------------------------------------------------
        const bundledEntries: SkillCatalogEntry[] = config.bundled.map(bundled => {
            if (bundled.generated) {
                // Written below from the finished catalog; its description is the config's.
                return helpCatalogEntry(config.help);
            }
            const skillFile = path.join(skillsDir, bundled.name, 'SKILL.md');
            const frontmatter = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8'));
            if (!frontmatter || frontmatter.name !== bundled.name) {
                fail(`bundled skill ${bundled.name} has no valid frontmatter`);
            }
            return {
                name: bundled.name,
                description: frontmatter.description,
                category: bundled.category,
                kind: 'skill',
                source: 'bundled',
                path: `skills/${bundled.name}`,
                dependsOn: [],
            };
        });

        // --- catalog -----------------------------------------------------------
        const upstreamEntries: SkillCatalogEntry[] = upstream.map(skill => ({
            name: skill.name,
            description: skill.description,
            category: skill.category,
            kind: 'skill',
            source: 'cmsis-agent',
            path: `skills/cmsis-agent/${skill.name}`,
            ...(skill.displayName ? { displayName: skill.displayName } : {}),
            ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
            dependsOn: dependsOn.get(skill.name) ?? [],
        }));

        const all = [...routerEntries, ...bundledEntries, ...upstreamEntries];
        all.sort((a, b) => {
            const categoryDelta = SKILL_CATEGORY_ORDER.indexOf(a.category) - SKILL_CATEGORY_ORDER.indexOf(b.category);
            if (categoryDelta !== 0) {
                return categoryDelta;
            }
            if (a.kind !== b.kind) {
                return a.kind === 'router' ? -1 : 1;
            }
            return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });

        const catalog: SkillCatalog = {
            schemaVersion: 1,
            source: { repository: lock.repository, sha, sourcePath: lock.sourcePath },
            skills: all,
        };

        // --- help skill ----------------------------------------------------------
        // Rendered from the finished catalog plus package.json, so the list of
        // slash commands, VS Code commands and settings cannot drift from what
        // ships; src/test/skillCatalog.test.ts re-renders it and compares.
        const helpDir = path.join(skillsDir, HELP_SKILL_NAME);
        const contributions = readPackageContributions(readJson<unknown>(path.join(repoRoot, 'package.json')));
        fs.rmSync(helpDir, { recursive: true, force: true });
        fs.mkdirSync(path.join(helpDir, 'agents'), { recursive: true });
        fs.writeFileSync(path.join(helpDir, 'SKILL.md'), renderHelpSkillMarkdown(catalog, contributions, config.help), 'utf8');
        fs.writeFileSync(path.join(helpDir, 'agents', 'openai.yaml'), renderHelpOpenAiYaml(config.help), 'utf8');

        writeJson(catalogPath, catalog);

        // --- lock ---------------------------------------------------------------
        const contentHash = hashTree(vendorDir);
        const newLock: SkillLock = {
            repository: lock.repository,
            ref: lock.ref,
            sha,
            sourcePath: lock.sourcePath,
            fetchedAt: sha === lock.sha && lock.fetchedAt ? lock.fetchedAt : new Date().toISOString(),
            contentHash,
        };
        writeJson(lockPath, newLock);

        console.log(`Catalog: ${routerEntries.length} routers, ${bundledEntries.length} bundled (incl. ${HELP_SKILL_NAME}), ${upstreamEntries.length} upstream skills`);
        console.log(`Lock: sha ${sha.slice(0, 12)}, contentHash ${contentHash.slice(0, 12)}`);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

main();
