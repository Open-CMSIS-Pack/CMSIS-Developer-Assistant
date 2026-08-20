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
 * The Agent Skill catalog shipped in the VSIX (`skills/catalog.json`).
 *
 * Pure module: no `vscode` import, so `scripts/sync-skills.ts` (which writes
 * the catalog) and the unit tests (which read it) can share the types and
 * the frontmatter/reference parsing with the extension runtime.
 */

import * as fs from 'fs';
import * as path from 'path';

export type SkillCategory = 'project' | 'bring-up' | 'debug' | 'pack' | 'devops';

/** Display order in the picker and in the generated catalog. */
export const SKILL_CATEGORY_ORDER: readonly SkillCategory[] = ['project', 'bring-up', 'debug', 'pack', 'devops'];

/** Picker group headings. */
export const SKILL_CATEGORY_LABELS: Readonly<Record<SkillCategory, string>> = {
    'project': 'Project setup',
    'bring-up': 'Device debug and trace knowledge',
    'debug': 'Live debugging',
    'pack': 'CMSIS-Pack debug authoring',
    'devops': 'DevOps',
};

export type SkillSource = 'cmsis-agent' | 'bundled' | 'generated';

export interface SkillCatalogEntry {
    /** Equals the directory name and the frontmatter `name`. */
    name: string;
    /** Frontmatter `description`, verbatim. */
    description: string;
    category: SkillCategory;
    /** Routers are the per-category entry points; skills are the workers. */
    kind: 'skill' | 'router';
    source: SkillSource;
    /** Directory relative to the extension root, e.g. `skills/cmsis-agent/debug-knowledge`. */
    path: string;
    /** From `agents/openai.yaml` `interface.display_name`, when present. */
    displayName?: string;
    /** From `agents/openai.yaml` `interface.short_description`, when present. */
    shortDescription?: string;
    /** Other catalog skills this one refers to with the `$name` sigil; for routers, every member. */
    dependsOn: string[];
}

export interface SkillCatalog {
    schemaVersion: 1;
    source: {
        repository: string;
        sha: string;
        sourcePath: string;
    };
    skills: SkillCatalogEntry[];
}

export const SKILL_CATALOG_FILE = path.join('skills', 'catalog.json');

/** Setting key under `cmsis-developer-assistant.` holding the user's explicit picks. */
export const INSTALLED_SKILLS_SETTING = 'installedSkills';

/** What a fresh install gets — the extension's own debugging skill and nothing else. */
export const DEFAULT_INSTALLED_SKILLS: readonly string[] = ['cmsis-debug-live'];

export function parseSkillCatalog(json: string): SkillCatalog {
    const parsed = JSON.parse(json) as Partial<SkillCatalog>;
    if (parsed.schemaVersion !== 1) {
        throw new Error(`Unsupported skill catalog schemaVersion ${String(parsed.schemaVersion)}`);
    }
    if (!parsed.source || typeof parsed.source.sha !== 'string' || !Array.isArray(parsed.skills)) {
        throw new Error('Malformed skill catalog: missing source or skills');
    }
    return parsed as SkillCatalog;
}

export function loadSkillCatalog(extensionPath: string): SkillCatalog {
    return parseSkillCatalog(fs.readFileSync(path.join(extensionPath, SKILL_CATALOG_FILE), 'utf8'));
}

export interface DesiredSkills {
    /** Names the user picked, in catalog order. Installed visible. */
    explicit: string[];
    /** Transitive `dependsOn` closure of the explicit picks, minus the picks. Installed hidden. */
    implied: string[];
    /** Configured names the catalog does not know (e.g. synced from another version). Ignored. */
    unknown: string[];
}

/**
 * Turn the configured picks into the set to install. The setting stores only
 * explicit picks; the closure is recomputed here every time, so a dependency
 * added upstream reaches existing users on the next sync.
 */
export function resolveDesiredSkills(catalog: SkillCatalog, configured: readonly string[]): DesiredSkills {
    const byName = new Map(catalog.skills.map(entry => [entry.name, entry]));
    const order = new Map(catalog.skills.map((entry, index) => [entry.name, index]));
    const sortCatalogOrder = (names: Iterable<string>): string[] =>
        [...new Set(names)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

    const explicitSet = new Set<string>();
    const unknown: string[] = [];
    for (const name of configured) {
        if (byName.has(name)) {
            explicitSet.add(name);
        } else if (!unknown.includes(name)) {
            unknown.push(name);
        }
    }

    const closure = new Set<string>();
    const queue = [...explicitSet];
    while (queue.length > 0) {
        const name = queue.pop() as string;
        for (const dependency of byName.get(name)?.dependsOn ?? []) {
            if (!explicitSet.has(dependency) && !closure.has(dependency) && byName.has(dependency)) {
                closure.add(dependency);
                queue.push(dependency);
            }
        }
    }

    return {
        explicit: sortCatalogOrder(explicitSet),
        implied: sortCatalogOrder(closure),
        unknown,
    };
}

/** Entries grouped by category, categories in display order, the router first within each group. */
export function groupByCategory(catalog: SkillCatalog): Map<SkillCategory, SkillCatalogEntry[]> {
    const groups = new Map<SkillCategory, SkillCatalogEntry[]>();
    for (const category of SKILL_CATEGORY_ORDER) {
        const entries = catalog.skills.filter(entry => entry.category === category);
        if (entries.length === 0) {
            continue;
        }
        entries.sort((a, b) => {
            if (a.kind !== b.kind) {
                return a.kind === 'router' ? -1 : 1;
            }
            return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
        groups.set(category, entries);
    }
    return groups;
}

export interface SkillFrontmatter {
    name: string;
    description: string;
    /** The raw frontmatter block between the `---` fences. */
    raw: string;
}

/**
 * Read `name` and `description` from SKILL.md frontmatter. Deliberately not
 * a YAML parser: the Agent Skills frontmatter in the wild is flat
 * `key: value` lines, and a YAML dependency would have to ship in the VSIX
 * for the sake of two fields.
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter | null {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
    if (!match) {
        return null;
    }
    const raw = match[1];
    const name = readScalar(raw, 'name');
    const description = readScalar(raw, 'description');
    if (name === undefined || description === undefined) {
        return null;
    }
    return { name, description, raw };
}

function readScalar(frontmatter: string, key: string): string | undefined {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
    if (!line) {
        return undefined;
    }
    let value = line[1].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.length >= 2 && value.startsWith('\'') && value.endsWith('\'')) {
        value = value.slice(1, -1).replace(/''/g, '\'');
    }
    return value;
}

/**
 * Skill names referenced with the `$name` sigil cmsis-agent uses for
 * cross-skill hand-over (also Codex's invocation syntax). Returns every
 * lowercase-hyphenated token; the caller decides which ones are known.
 */
export function extractSkillReferences(markdown: string): string[] {
    const tokens = new Set<string>();
    for (const match of markdown.matchAll(/\$([a-z0-9][a-z0-9-]*[a-z0-9])/g)) {
        tokens.add(match[1]);
    }
    return [...tokens].sort();
}
