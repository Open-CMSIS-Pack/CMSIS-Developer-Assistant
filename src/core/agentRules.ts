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
 * The tool rules in agents' own rule files (#50 part 2, #45): which file each
 * agent reads, what the extension writes into it, and how a file's text
 * changes when the rules are added, brought up to date or taken out again.
 *
 * The rules travel as the `rules` block of the tool contract (toolContract.ts)
 * between its marker comments (markerBlock.ts), led by one comment line that
 * says who manages the block. Everything outside the block stays as it was.
 *
 * Pure: the few file-system questions the map asks go through the
 * `RuleFileProbe` the caller passes in. No vscode, no I/O.
 */

import * as path from 'path';
import { extractBlock, removeBlock, renderBlock, upsertBlock } from '../utils/markerBlock';
import { RULES_BLOCK } from './toolContract';

/** The setting that decides whether the setup offers the rule files at all. */
export const AGENT_RULES_SETTING = 'agentRules.install';
/** Its values: the setup asks (default), or never touches a rule file. */
export type AgentRulesInstall = 'ask' | 'never';

/** globalState: the rule files this extension wrote the rules into (`RuleFileRecord[]`). */
export const RULE_FILES_STATE_KEY = 'cmsis-developer-assistant.agentRules.files';

/** The agents with a rule file. Claude Desktop has none and relies on the server instructions. */
export type RuleAgentId = 'claude-code' | 'codex' | 'copilot-cli' | 'antigravity' | 'kimi-code' | 'copilot-chat' | 'cursor' | 'cline' | 'roo';

/** In the order the picker names them. */
export const RULE_AGENTS: readonly RuleAgentId[] = ['claude-code', 'codex', 'copilot-cli', 'antigravity', 'kimi-code', 'copilot-chat', 'cursor', 'cline', 'roo'];

export const RULE_AGENT_NAMES: Readonly<Record<RuleAgentId, string>> = {
    'claude-code': 'Claude Code',
    'codex': 'Codex',
    'copilot-cli': 'GitHub Copilot CLI',
    'antigravity': 'Antigravity',
    'kimi-code': 'Kimi Code',
    'copilot-chat': 'VS Code Copilot Chat',
    'cursor': 'Cursor',
    'cline': 'Cline',
    'roo': 'Roo Code',
};

/** Whether an agent id of the MCP roster (or `copilot-chat`) has a rule file. */
export function isRuleAgent(id: string): id is RuleAgentId {
    return (RULE_AGENTS as readonly string[]).includes(id);
}

/**
 * How a file holds the rules. `block`: a marker block in a file that may hold
 * anything else, such as a shared AGENTS.md. `own`: a file named after this
 * extension that holds nothing but the block (and, for Cursor, its
 * frontmatter); taking the rules out deletes it.
 */
export type RuleFileForm = 'block' | 'own';

/** One file the rules can go into, and the agents that read it. */
export interface RuleFileTarget {
    /** Absolute path. */
    file: string;
    /** `user`: read in every project; `workspace`: read in the one folder. */
    scope: 'user' | 'workspace';
    /** The workspace folder of a `workspace` file. */
    folder?: { name: string; path: string };
    form: RuleFileForm;
    /** The agents that read this file, in `RULE_AGENTS` order where the map decides it. */
    agents: RuleAgentId[];
    /** Checked when the picker opens, although the file has no rules yet. */
    preselect: boolean;
}

/** What the map needs to know about the disk. */
export interface RuleFileProbe {
    /** What is at the path: a file, a directory, or nothing. */
    kind(target: string): 'file' | 'directory' | undefined;
    /** A regular file with more than white space in it. */
    hasText(file: string): boolean;
    /** A directory with at least one entry. */
    hasEntries(dir: string): boolean;
}

/** Everything `ruleFileTargets` reads; the extension passes the real values, the tests their own. */
export interface RuleTargetContext {
    home: string;
    env: Readonly<Record<string, string | undefined>>;
    /** The local workspace folders. */
    folders: ReadonlyArray<{ name: string; path: string }>;
    probe: RuleFileProbe;
    /** VS Code's `chat.useAgentsMdFile` (default true): Copilot Chat reads the workspace AGENTS.md. */
    copilotChatReadsAgentsMd: boolean;
}

/** The base name of the files that are the extension's own (`own` form). */
const OWN_FILE_STEM = 'cmsis-developer-assistant';

/*
 * Where each agent reads always-on instructions, checked against the vendors'
 * documentation on 2026-09-24:
 *
 * - Claude Code: user file `$CLAUDE_CONFIG_DIR/CLAUDE.md`, default
 *   `~/.claude/CLAUDE.md` ("The user memory file (CLAUDE.md) ... move with
 *   it", https://code.claude.com/docs/en/env-vars). In a project it reads
 *   `./CLAUDE.md` or `./.claude/CLAUDE.md`, and reads `AGENTS.md` instead only
 *   while none of `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`
 *   exists (v2.1.277 and later, https://code.claude.com/docs/en/memory).
 * - Codex: `$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md`, and per
 *   directory from the git root down; in each place a non-empty
 *   `AGENTS.override.md` is read instead of `AGENTS.md`
 *   (https://learn.chatgpt.com/docs/agent-configuration/agents-md, where
 *   developers.openai.com/codex/guides/agents-md redirects).
 * - GitHub Copilot CLI: `$COPILOT_HOME/copilot-instructions.md`, default
 *   `~/.copilot/copilot-instructions.md`; in a repository `AGENTS.md`,
 *   `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md`
 *   (https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions).
 * - Antigravity: `~/.gemini/AGENTS.md` or `~/.gemini/GEMINI.md` for every
 *   project, `AGENTS.md` or `GEMINI.md` per directory, always on
 *   (https://antigravity.google/docs/rules). Unverified: which of the two
 *   user files wins when both exist; `~/.gemini/AGENTS.md` is not read by
 *   Gemini CLI, which shares `~/.gemini`, so the rules stay with Antigravity.
 * - Kimi Code (checked 2026-10-25): `$KIMI_CODE_HOME/AGENTS.md`, default
 *   `~/.kimi-code/AGENTS.md`, then `~/.agents/AGENTS.md`; per directory from
 *   the git root down `.kimi-code/AGENTS.md` and `AGENTS.md`; not `CLAUDE.md`
 *   (https://moonshotai.github.io/kimi-code/en/customization/agents). It
 *   passes no MCP server instructions to the model, so these files are the
 *   rules' only way into its system prompt.
 * - VS Code Copilot Chat: the workspace `AGENTS.md` (`chat.useAgentsMdFile`,
 *   default true) and `.github/copilot-instructions.md`
 *   (`github.copilot.chat.codeGeneration.useInstructionFiles`, default true)
 *   (https://code.visualstudio.com/docs/copilot/customization/custom-instructions,
 *   https://code.visualstudio.com/docs/copilot/reference/copilot-settings).
 * - Cursor: `.cursor/rules/*.mdc`; `alwaysApply: true` in the frontmatter
 *   includes a rule in every chat, and a plain `.md` there is ignored.
 *   Cursor also reads `AGENTS.md`; its User Rules are a setting, not a file
 *   (https://cursor.com/docs/context/rules).
 * - Cline: every file in `.clinerules/` or `.cline/rules/`; it also detects
 *   `AGENTS.md`, behind a toggle whose default the documentation does not
 *   state (unverified) (https://docs.cline.bot/features/cline-rules).
 * - Roo Code: every file in `.roo/rules/`, recursively; a single `.roorules`
 *   only while `.roo/rules/` is missing or empty; `AGENTS.md` by default
 *   (`roo-cline.useAgentRules`)
 *   (https://roocodeinc.github.io/Roo-Code/features/custom-instructions,
 *   where docs.roocode.com redirects).
 *
 * Offered here, as proposal 50 decided: the user file of Claude Code, Codex
 * and Copilot CLI, preselected, because their MCP registration is per user
 * too; the same for Antigravity, whose user file the proposal could not name
 * yet, and for Kimi Code. Copilot Chat, Cursor, Cline and Roo Code get their
 * workspace file only.
 */

/** The file an agent reads in every project, when the rules go there; undefined for workspace-only agents. */
function userRuleFile(agent: RuleAgentId, context: RuleTargetContext): string | undefined {
    const { home, env, probe } = context;
    switch (agent) {
        case 'claude-code':
            return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'CLAUDE.md');
        case 'codex':
            return codexFile(env.CODEX_HOME || path.join(home, '.codex'), probe);
        case 'copilot-cli':
            return path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'copilot-instructions.md');
        case 'antigravity':
            return path.join(home, '.gemini', 'AGENTS.md');
        case 'kimi-code':
            return path.join(env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'AGENTS.md');
        default:
            return undefined;
    }
}

/** Codex reads a non-empty AGENTS.override.md in place of AGENTS.md; writing AGENTS.md then would have no effect. */
function codexFile(dir: string, probe: RuleFileProbe): string {
    const override = path.join(dir, 'AGENTS.override.md');
    return probe.hasText(override) ? override : path.join(dir, 'AGENTS.md');
}

/**
 * Claude Code's file in a project: its own CLAUDE.md where the project has
 * one. Otherwise the shared AGENTS.md, which Claude Code reads while no
 * CLAUDE.md exists — a new CLAUDE.md would hide the project's AGENTS.md from
 * it — unless a CLAUDE.local.md already hides AGENTS.md.
 */
function claudeProjectFile(folder: string, probe: RuleFileProbe): string {
    const root = path.join(folder, 'CLAUDE.md');
    const nested = path.join(folder, '.claude', 'CLAUDE.md');
    if (probe.kind(root) === 'file') {
        return root;
    }
    if (probe.kind(nested) === 'file') {
        return nested;
    }
    return probe.kind(path.join(folder, 'CLAUDE.local.md')) === 'file' ? root : path.join(folder, 'AGENTS.md');
}

/** An agent's file in one workspace folder, and whether it is shared or the extension's own. */
function workspaceRuleFile(agent: RuleAgentId, folder: string, context: RuleTargetContext): { file: string; form: RuleFileForm } {
    const { probe } = context;
    const shared = (rel: string): { file: string; form: RuleFileForm } => ({ file: path.join(folder, ...rel.split('/')), form: 'block' });
    const own = (rel: string): { file: string; form: RuleFileForm } => ({ file: path.join(folder, ...rel.split('/')), form: 'own' });
    switch (agent) {
        case 'claude-code':
            return { file: claudeProjectFile(folder, probe), form: 'block' };
        case 'codex':
            return { file: codexFile(folder, probe), form: 'block' };
        case 'copilot-chat':
            return shared(context.copilotChatReadsAgentsMd ? 'AGENTS.md' : '.github/copilot-instructions.md');
        case 'cursor':
            return own(`.cursor/rules/${OWN_FILE_STEM}.mdc`);
        case 'cline': {
            // `.clinerules` taken by a file (the old single-file form) leaves `.cline/rules/`, the other documented folder.
            const useClineDir = probe.kind(path.join(folder, '.clinerules')) === 'file'
                || (probe.kind(path.join(folder, '.clinerules')) === undefined && probe.kind(path.join(folder, '.cline', 'rules')) === 'directory');
            return own(`${useClineDir ? '.cline/rules' : '.clinerules'}/${OWN_FILE_STEM}.md`);
        }
        case 'roo':
            // A file in .roo/rules/ would switch off a .roorules the project uses: then the block goes into .roorules.
            return probe.hasText(path.join(folder, '.roorules')) && !probe.hasEntries(path.join(folder, '.roo', 'rules'))
                ? shared('.roorules')
                : own(`.roo/rules/${OWN_FILE_STEM}.md`);
        default:
            return shared('AGENTS.md');
    }
}

/**
 * The files to offer for `agents`: each agent's user file (preselected), then
 * per workspace folder each agent's workspace file. A file several agents
 * read — a workspace AGENTS.md above all — is offered once, naming them all.
 */
export function ruleFileTargets(agents: Iterable<RuleAgentId>, context: RuleTargetContext): RuleFileTarget[] {
    const wanted = new Set(agents);
    const inOrder = RULE_AGENTS.filter((agent) => wanted.has(agent));
    const byFile = new Map<string, RuleFileTarget>();
    const offer = (agent: RuleAgentId, fresh: Omit<RuleFileTarget, 'agents'>): void => {
        const known = byFile.get(fresh.file);
        if (!known) {
            byFile.set(fresh.file, { ...fresh, agents: [agent] });
            return;
        }
        if (!known.agents.includes(agent)) {
            known.agents.push(agent);
        }
        known.preselect ||= fresh.preselect;
    };
    for (const agent of inOrder) {
        const file = userRuleFile(agent, context);
        if (file !== undefined) {
            offer(agent, { file: path.resolve(file), scope: 'user', form: 'block', preselect: true });
        }
    }
    for (const folder of context.folders) {
        for (const agent of inOrder) {
            const { file, form } = workspaceRuleFile(agent, folder.path, context);
            offer(agent, { file: path.resolve(file), scope: 'workspace', folder, form, preselect: false });
        }
    }
    return [...byFile.values()];
}

/** A rule file the extension wrote, as globalState keeps it. */
export interface RuleFileRecord {
    file: string;
    scope: 'user' | 'workspace';
    form: RuleFileForm;
    agents: RuleAgentId[];
    /** There was no file before the rules: taking them out deletes it when nothing else was added. */
    created: boolean;
    /** Directories made for the file, outermost first; removed again when they are empty. */
    createdDirs: string[];
}

/** The records in a globalState value; anything malformed is dropped. */
export function parseRuleRecords(value: unknown): RuleFileRecord[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const records: RuleFileRecord[] = [];
    for (const item of value) {
        const raw = (item ?? {}) as Record<string, unknown>;
        if (typeof raw.file !== 'string' || raw.file.length === 0) {
            continue;
        }
        records.push({
            file: raw.file,
            scope: raw.scope === 'workspace' ? 'workspace' : 'user',
            form: raw.form === 'own' ? 'own' : 'block',
            agents: Array.isArray(raw.agents) ? raw.agents.filter((id): id is RuleAgentId => typeof id === 'string' && isRuleAgent(id)) : [],
            created: raw.created === true,
            createdDirs: Array.isArray(raw.createdDirs) ? raw.createdDirs.filter((dir): dir is string => typeof dir === 'string') : [],
        });
    }
    return records;
}

/**
 * The targets plus the recorded files they do not name, so that the picker
 * shows every file that has the rules — also one whose agent is no longer
 * registered — and unchecking it takes them out. A recorded workspace file
 * is listed only while its folder is open.
 */
export function withRecordedTargets(
    targets: readonly RuleFileTarget[],
    records: readonly RuleFileRecord[],
    folders: ReadonlyArray<{ name: string; path: string }>,
): RuleFileTarget[] {
    const listed = new Set(targets.map((target) => target.file));
    const extra: RuleFileTarget[] = [];
    for (const record of records) {
        if (listed.has(record.file)) {
            continue;
        }
        const folder = folders.find((candidate) => isInside(record.file, candidate.path));
        if (record.scope === 'workspace' && !folder) {
            continue;
        }
        listed.add(record.file);
        extra.push({
            file: record.file,
            scope: record.scope,
            ...(record.scope === 'workspace' ? { folder } : {}),
            form: record.form,
            agents: [...record.agents],
            preselect: false,
        });
    }
    const users = [...targets, ...extra].filter((target) => target.scope === 'user');
    const workspace = [...targets, ...extra].filter((target) => target.scope === 'workspace');
    return [...users, ...workspace];
}

function isInside(file: string, dir: string): boolean {
    const relative = path.relative(dir, file);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The first line of every rules block: who manages it, and how to take it out. */
export const RULES_PROVENANCE = '<!-- Managed by the CMSIS Developer Assistant extension; edits between these markers are replaced. '
    + 'To take the rules out, uncheck this file in "CMSIS Developer Assistant: Configure Agent", '
    + 'or delete the block with its markers. -->';

/** What goes between the markers: the provenance line, then the rules section of the tool contract. */
export function rulesBlockBody(rules: string): string {
    return `${RULES_PROVENANCE}\n${rules.trim()}`;
}

/**
 * The frontmatter of the Cursor rule file: `alwaysApply: true` puts the rule
 * into every chat, whatever the description says (https://cursor.com/docs/context/rules).
 */
const CURSOR_FRONTMATTER = ['---', 'description: CMSIS Developer Assistant tool rules', 'alwaysApply: true', '---'];

function isCursorRuleFile(file: string): boolean {
    return path.extname(file) === '.mdc';
}

/** Whether a text has the rules, has them as `rules` says, or has an older version. Throws on broken markers. */
export type RulesState = 'absent' | 'current' | 'outdated';

export function rulesState(text: string | undefined, rules: string): RulesState {
    const body = extractBlock(text, RULES_BLOCK);
    if (body === undefined) {
        return 'absent';
    }
    return body === rulesBlockBody(rules) ? 'current' : 'outdated';
}

/**
 * The text of `file` with the current rules: an existing block is replaced, a
 * new one goes at the end, one blank line apart. A new Cursor rule file
 * starts with its frontmatter. `text` undefined stands for a missing file.
 */
export function withRules(text: string | undefined, file: string, rules: string): string {
    const body = rulesBlockBody(rules);
    if ((text === undefined || text.trim().length === 0) && isCursorRuleFile(file)) {
        return [...CURSOR_FRONTMATTER, '', renderBlock(RULES_BLOCK, body), ''].join('\n');
    }
    return upsertBlock(text, RULES_BLOCK, body);
}

/**
 * The text without the rules block, and whether nothing is left that anyone
 * wrote — for a file of the extension's own, a frontmatter does not count.
 */
export function withoutRules(text: string, form: RuleFileForm): { text: string; empty: boolean } {
    const rest = removeBlock(text, RULES_BLOCK);
    const meaningful = form === 'own' ? rest.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '') : rest;
    return { text: rest, empty: meaningful.trim().length === 0 };
}
