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
 * The generated `cmsis-help` Agent Skill — one page an agent can answer
 * "what can the CMSIS Developer Assistant do, and which part fits my task?"
 * from: the CMSIS slash commands and the member skills behind each, the VS
 * Code commands, the MCP tool groups and the settings.
 *
 * Pure module, imported by `scripts/sync-skills.ts` (which writes the skill)
 * and by the tests (which re-render it and compare byte for byte) — never by
 * the extension runtime. Everything in the output derives from the catalog,
 * package.json and scripts/skills.config.json, and nothing is timestamped, so
 * a re-sync at the same inputs is a no-op and a forgotten re-sync fails the
 * test instead of shipping a stale list.
 */

import { SKILL_CATEGORY_LABELS, SKILL_CATEGORY_ORDER, SkillCatalog, SkillCatalogEntry } from './skillCatalog';

export const HELP_SKILL_NAME = 'cmsis-help';

/** Settings prefix, also the MCP server key and the command namespace. */
export const SETTINGS_PREFIX = 'cmsis-developer-assistant';

export interface HelpToolGroup {
    name: string;
    /** Hand-authored: the generator must not import the MCP server to list tools. */
    summary: string;
}

/** The `help` block of scripts/skills.config.json. */
export interface HelpSkillConfig {
    displayName: string;
    shortDescription: string;
    description: string;
    /** One line per palette command id — every visible command needs one, and every key must exist. */
    commands: Record<string, string>;
    toolGroups: HelpToolGroup[];
    /** One line per setting id (without the prefix); each must exist in package.json. */
    settings: Record<string, string>;
}

export interface PackageCommand {
    command: string;
    title: string;
    category?: string;
}

export interface PackageSetting {
    default?: unknown;
    description?: string;
    markdownDescription?: string;
}

export interface PackageContributions {
    /** Palette-visible commands, in package.json order. */
    commands: PackageCommand[];
    /** Commands hidden from the palette (`menus.commandPalette` with `when: "false"`). */
    hiddenCommands: string[];
    settings: Record<string, PackageSetting>;
}

interface PackageJsonShape {
    contributes?: {
        commands?: PackageCommand[];
        menus?: { commandPalette?: { command: string; when?: string }[] };
        configuration?: { properties?: Record<string, PackageSetting> };
    };
}

export function readPackageContributions(packageJson: unknown): PackageContributions {
    const contributes = (packageJson as PackageJsonShape).contributes ?? {};
    const hidden = new Set((contributes.menus?.commandPalette ?? [])
        .filter(entry => entry.when === 'false')
        .map(entry => entry.command));
    return {
        commands: (contributes.commands ?? []).filter(command => !hidden.has(command.command)),
        hiddenCommands: [...hidden],
        settings: contributes.configuration?.properties ?? {},
    };
}

/** The catalog entry for the help skill — bundled, always installed, no dependencies. */
export function helpCatalogEntry(config: HelpSkillConfig): SkillCatalogEntry {
    return {
        name: HELP_SKILL_NAME,
        description: config.description,
        category: 'help',
        kind: 'skill',
        source: 'bundled',
        path: `skills/${HELP_SKILL_NAME}`,
        displayName: config.displayName,
        shortDescription: config.shortDescription,
        dependsOn: [],
    };
}

export function renderHelpOpenAiYaml(config: HelpSkillConfig): string {
    return [
        'interface:',
        `  display_name: "${config.displayName}"`,
        `  short_description: "${config.shortDescription}"`,
        `  default_prompt: "Use $${HELP_SKILL_NAME} to ${lowerFirst(config.shortDescription)}."`,
        '',
    ].join('\n');
}

export function renderHelpSkillMarkdown(catalog: SkillCatalog, contributions: PackageContributions, config: HelpSkillConfig): string {
    const byName = new Map(catalog.skills.map(entry => [entry.name, entry]));
    const routers = catalog.skills.filter(entry => entry.kind === 'router');
    const bundled = catalog.skills.filter(entry => entry.source === 'bundled');
    const oneLiner = (entry: SkillCatalogEntry): string => cell(entry.shortDescription ?? firstSentence(entry.description));

    // --- slash commands ------------------------------------------------------
    const commandRows = [
        ...routers.map(router =>
            `| \`/${router.name}\` | ${oneLiner(router)} — one command for the whole category; its ${router.dependsOn.length} member skills are listed below |`),
        ...bundled.map(entry =>
            `| \`/${entry.name}\` | ${entry.name === HELP_SKILL_NAME ? 'This list.' : oneLiner(entry)} |`),
    ];

    // --- member skills by category ------------------------------------------
    const memberSections: string[] = [];
    for (const category of SKILL_CATEGORY_ORDER) {
        const router = routers.find(entry => entry.category === category);
        if (!router) {
            continue;
        }
        memberSections.push(
            `### ${SKILL_CATEGORY_LABELS[category]} (\`/${router.name}\`)`,
            '',
            ...router.dependsOn.map(name => {
                const member = byName.get(name);
                return `- \`$${name}\` — ${member ? oneLiner(member) : '(not in the catalog)'}`;
            }),
            '',
        );
    }

    // --- VS Code commands ----------------------------------------------------
    const visibleIds = new Set(contributions.commands.map(command => command.command));
    for (const id of Object.keys(config.commands)) {
        if (!visibleIds.has(id)) {
            throw new Error(`cmsis-help: help.commands names "${id}", which is not a palette command in package.json`);
        }
    }
    const commandLines = contributions.commands.map(command => {
        const summary = config.commands[command.command];
        if (!summary) {
            throw new Error(`cmsis-help: no one-liner for command "${command.command}" in scripts/skills.config.json (help.commands)`);
        }
        const title = command.category ? `${command.category}: ${command.title}` : command.title;
        return `- **${title}** (\`${command.command}\`) — ${summary}`;
    });

    // --- settings ------------------------------------------------------------
    const settingRows = Object.entries(config.settings).map(([id, summary]) => {
        const key = `${SETTINGS_PREFIX}.${id}`;
        const setting = contributions.settings[key];
        if (!setting) {
            throw new Error(`cmsis-help: help.settings names "${key}", which package.json does not contribute`);
        }
        return `| \`${key}\` | \`${JSON.stringify(setting.default)}\` | ${cell(summary)} |`;
    });

    return [
        '---',
        `name: ${HELP_SKILL_NAME}`,
        // Double-quoted so a ": " inside the prose cannot be read as a mapping.
        `description: ${JSON.stringify(config.description)}`,
        '---',
        '',
        '# CMSIS Developer Assistant — what you can ask for',
        '',
        'Answer the user from the lists below: which CMSIS slash commands, VS Code commands,',
        'MCP tools and settings exist, and which one fits the task at hand. This skill does no',
        'work of its own and runs no tools — it points at the skill or tool that does. A',
        '`/name` whose `../<name>/SKILL.md` is missing next to this file is not installed; the',
        'user adds it with **CMSIS Developer Assistant: Select Agent Skills** in VS Code or by',
        `editing the \`${SETTINGS_PREFIX}.installedSkills\` setting.`,
        '',
        '## Slash commands',
        '',
        '| Command | What it does |',
        '|---|---|',
        ...commandRows,
        '',
        '## Member skills by category',
        '',
        'Selecting a category entry point installs its members with `user-invocable: false`:',
        'they stay out of the `/` menu, the model invokes them by description or through the',
        'entry point, and the user can also select them individually to make them visible.',
        '',
        ...memberSections,
        '## VS Code commands',
        '',
        'Open the command palette (Ctrl/Cmd+Shift+P) and type the title.',
        '',
        ...commandLines,
        '',
        '## MCP tools',
        '',
        'The CMSIS Developer Assistant MCP server (`http://localhost:3001/mcp`, registered with',
        'the agents the user selected in the setup) exposes these tool groups:',
        '',
        ...config.toolGroups.map(group => `- **${group.name}** — ${group.summary}`),
        '',
        'For the debugging workflow call `get_debug_instructions` (or read the',
        `\`${SETTINGS_PREFIX}://docs/debug_instructions\` resource); for a live target investigation`,
        'invoke `/cmsis-debug-live` first. The *Agent Tools* section of the extension README lists',
        'every tool and parameter.',
        '',
        '## Settings',
        '',
        `VS Code settings under \`${SETTINGS_PREFIX}.*\` (Settings → Extensions → CMSIS Developer Assistant):`,
        '',
        '| Setting | Default | What it does |',
        '|---|---|---|',
        ...settingRows,
        '',
        '_Generated by `npm run skills:sync` from skills/catalog.json, package.json and',
        'scripts/skills.config.json; edit those, not this file._',
        '',
    ].join('\n');
}

function firstSentence(text: string): string {
    const match = /^(.*?[.!?])(?:\s|$)/.exec(text);
    return (match ? match[1] : text).trim();
}

/** One table cell: pipes escaped, whitespace collapsed. */
function cell(text: string): string {
    return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function lowerFirst(text: string): string {
    return text.charAt(0).toLowerCase() + text.slice(1);
}
