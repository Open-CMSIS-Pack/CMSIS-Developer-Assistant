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

/**
 * The categories of the knowledge index's procedures: the upstream category
 * directories of Open-CMSIS-Pack/cmsis-skills (`generic-mcu-skills/skills/<category>/`)
 * plus the extension's own help.
 */
export type SkillCategory = 'project' | 'bring-up' | 'debug' | 'pack' | 'ethos-u' | 'devops' | 'help';

/** Display order in the generated catalog and in the help skill. */
export const SKILL_CATEGORY_ORDER: readonly SkillCategory[] = ['project', 'bring-up', 'debug', 'pack', 'ethos-u', 'devops', 'help'];

/** Category headings of the help skill. */
export const SKILL_CATEGORY_LABELS: Readonly<Record<SkillCategory, string>> = {
    'project': 'Project setup',
    'bring-up': 'Device debug and trace knowledge',
    'debug': 'Live debugging',
    'pack': 'CMSIS-Pack debug authoring',
    'ethos-u': 'Ethos-U NPU',
    'devops': 'DevOps',
    'help': 'Help',
};

/**
 * Where a skill comes from. `bundled`: the extension's own entry points.
 * `extension`: the extension's own skills reached through a hand-over
 * (`$name`). The shipped catalog holds only these two; the installer also
 * understands `cmsis-skills` (vendored upstream) and `generated` (a category
 * router), which catalogs of 2.5 carried.
 */
export type SkillSource = 'cmsis-skills' | 'bundled' | 'generated' | 'extension';

export interface SkillCatalogEntry {
    /** Equals the directory name and the frontmatter `name`. */
    name: string;
    /** Frontmatter `description`, verbatim. */
    description: string;
    category: SkillCategory;
    /** Routers are the per-category entry points; skills are the workers. */
    kind: 'skill' | 'router';
    source: SkillSource;
    /** Directory relative to the extension root, e.g. `skills/cmsis-help`. */
    path: string;
    /** From `agents/openai.yaml` `interface.display_name`, when present. */
    displayName?: string;
    /** From `agents/openai.yaml` `interface.short_description`, when present. */
    shortDescription?: string;
    /** Other catalog skills this one refers to with the `$name` sigil; for routers, every member. */
    dependsOn: string[];
    /**
     * Installed by the extension (the `installed` list of the config; today
     * `cmsis-help` alone). `false`: a unit of the knowledge index only.
     */
    installed: boolean;
    /**
     * Installed visible, as a slash command: the extension's own skills, the
     * routers, and a skill of a category without a router. The members of a
     * router are installed with `user-invocable: false` (`false` here): the
     * model still invokes them by description or through the router, but
     * they stay out of the `/` menu.
     */
    invocable: boolean;
}

export interface SkillCatalog {
    schemaVersion: 1;
    /** The upstream commit of vendored `cmsis-skills` entries; absent since 2.7.0, which vendors none. */
    source?: {
        repository: string;
        sha: string;
        sourcePath: string;
    };
    skills: SkillCatalogEntry[];
}

export const SKILL_CATALOG_FILE = path.join('skills', 'catalog.json');

/** The extension's own skills, authored in this repository. */
export function isBundledSkill(entry: SkillCatalogEntry): boolean {
    return entry.source === 'bundled';
}

export function bundledSkillNames(catalog: SkillCatalog): string[] {
    return catalog.skills.filter(isBundledSkill).map(entry => entry.name);
}

export function parseSkillCatalog(json: string): SkillCatalog {
    const parsed = JSON.parse(json) as Partial<SkillCatalog>;
    if (parsed.schemaVersion !== 1) {
        throw new Error(`Unsupported skill catalog schemaVersion ${String(parsed.schemaVersion)}`);
    }
    if (!Array.isArray(parsed.skills) || (parsed.source !== undefined && typeof parsed.source.sha !== 'string')) {
        throw new Error('Malformed skill catalog: missing skills, or a source without a sha');
    }
    return parsed as SkillCatalog;
}

export function loadSkillCatalog(extensionPath: string): SkillCatalog {
    return parseSkillCatalog(fs.readFileSync(path.join(extensionPath, SKILL_CATALOG_FILE), 'utf8'));
}

/** What the installer puts into the personal skills directories: the whole catalog, split by visibility. */
export interface InstallSet {
    /** Installed as they are, in catalog order: slash commands. */
    visible: string[];
    /** Installed with `user-invocable: false`, in catalog order: the members of the routers. */
    hidden: string[];
}

/**
 * The installed entries of the catalog; `invocable` decides whether one shows
 * up in the `/` menu. There is no selection: the catalog decides, and the next
 * sync after an upgrade brings existing installations in line with it.
 * Whatever else an earlier version installed is removed by the sweep.
 */
export function installSet(catalog: SkillCatalog): InstallSet {
    const installed = catalog.skills.filter(entry => entry.installed);
    return {
        visible: installed.filter(entry => entry.invocable).map(entry => entry.name),
        hidden: installed.filter(entry => !entry.invocable).map(entry => entry.name),
    };
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
 * Skill names referenced with the `$name` sigil cmsis-skills uses for
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
