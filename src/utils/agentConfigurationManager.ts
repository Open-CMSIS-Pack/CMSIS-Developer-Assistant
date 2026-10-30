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
 * Onboarding of AI agents onto the CMSIS Developer Assistant.
 *
 * - Registers this extension's MCP server in the home-directory configuration
 *   files of nine agents (eight JSON files and Codex's TOML file), and
 *   migrates the entries earlier releases wrote there.
 * - Runs the two-step setup: which agents to register (the CMSIS skills are
 *   installed into the personal skills directories at the same time), and
 *   which of the agents' rule files get the tool rules, each change shown as
 *   a diff and written only when confirmed.
 * - Installs the skill catalog into the personal skills directories at
 *   activation and after the setup; there is no selection.
 * - Keeps the tool rules it wrote into rule files current at activation.
 *
 * The files written here belong to other programs, so their locations, entry
 * shapes and layout are a contract. Every write is atomic (`atomicFile.ts`);
 * a JSON file that exists is re-read right before the write and everything
 * else in it is kept (`jsonFileRewrite.ts`). What to install and where comes
 * from the pure skill modules (`skillCatalog.ts`, `skillInstaller.ts`);
 * which rule file each agent reads and what changes in it,
 * from `core/agentRules.ts` and `agentRuleFiles.ts`.
 *
 * Loading this module calls no `vscode` API: the transport tests load it
 * under a minimal stub.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AGENT_RULES_SETTING,
    RULE_AGENT_NAMES,
    RULE_FILES_STATE_KEY,
    RuleAgentId,
    RuleFileTarget,
    isRuleAgent,
    parseRuleRecords,
    ruleFileTargets,
    withRecordedTargets,
} from '../core/agentRules';
import { TOOL_CONTRACT_DOC, parseToolContract } from '../core/toolContract';
import {
    NODE_RULE_FILES,
    NODE_RULE_PROBE,
    RuleChange,
    RuleChoice,
    RuleLog,
    RuleRecordStore,
    RuleRefreshUi,
    RuleStepDeps,
    RuleStepReport,
    RuleStepUi,
    refreshRecordedRules,
    runRuleStep,
} from './agentRuleFiles';
import { LONG_LIMIT_CAP_MS } from '../handler/fence';
import { writeFileAtomic } from './atomicFile';
import { rewriteJsonFile } from './jsonFileRewrite';
import { logger } from './logger';
import { notifyError } from './notify';
import { SkillCatalog, installSet, loadSkillCatalog } from './skillCatalog';
import {
    SkillInstallRoots,
    SkillInstaller,
    SkillSyncReport,
    getProjectSkillInstallRoots,
    getSkillInstallRoots,
    summarizeSkillSync,
    withoutInstallRoots,
} from './skillInstaller';

/** Name of this server's entry in every agent configuration. */
export const SERVER_KEY = 'cmsis-developer-assistant';

/** The name used before the 2.1.0 rename; entries under it are moved to `SERVER_KEY` on activation. */
export const LEGACY_SERVER_KEY = 'cmsis-debugmcp';

/** Fields every supported agent has. `name` is the same as `id`. */
export interface BaseAgentInfo { id: string; name: string; displayName: string; configPath: string; configFormat: 'json' | 'toml' }

/** An agent whose servers are an object under `mcpServerFieldName` of a JSON file. */
export interface JsonAgentInfo extends BaseAgentInfo { configFormat: 'json'; mcpServerFieldName: string }

/** Codex: one `[mcp_servers.<key>]` table per server in a TOML file. */
export interface TomlAgentInfo extends BaseAgentInfo { configFormat: 'toml' }

export type AgentInfo =
    | JsonAgentInfo
    | TomlAgentInfo;

/** Every field any of the JSON entry shapes uses; each agent gets a subset (see `ENTRY_SHAPES`). */
export interface MCPServerConfig {
    type?: string;
    /** Kimi Code's name for `type`; an entry with `url` and without it is Streamable HTTP. */
    transport?: string;
    url?: string;
    command?: string;
    args?: string[];
    autoApprove?: string[];
    disabled?: boolean;
    timeout?: number;
    /** Kimi Code: how long one tool call may take, in ms. */
    toolTimeoutMs?: number;
    tools?: string[];
}

// ---------------------------------------------------------------------------
// Settings, state and visible text
// ---------------------------------------------------------------------------

const SETTINGS_SECTION = 'cmsis-developer-assistant';

/**
 * globalState: the first-run setup has been answered (accepted or dismissed).
 * The suffix goes up when the flow changes, so everyone sees it once more
 * (v4: the tool rules step; v5: the skills step gone, the catalog installed
 * with the agents).
 */
const SETUP_ANSWERED_KEY = 'cmsis-developer-assistant.popupShown.v5';
/** globalState of releases before 2.5.15: when the monthly skills prompt was last shown. Cleared, never read. */
const LEGACY_SKILLS_PROMPT_KEY = 'cmsis-developer-assistant.skillsPrompt.lastShownAt';
/** globalState: the digest of the rules whose update activation last offered, so that each version is offered once. */
const RULES_UPDATE_OFFERED_KEY = 'cmsis-developer-assistant.agentRules.updateOffered';

const PRODUCT = 'CMSIS Developer Assistant';
const SETUP_TITLE = `${PRODUCT} Setup`;
const AGENT_ITEM_NOTE = 'Write the MCP server entry into this agent\'s configuration';
const OPEN_FILE_BUTTON = 'View File';
/** The URI scheme of the texts the rules preview shows in the diff editor. */
const RULES_PREVIEW_SCHEME = 'cmsis-developer-assistant-rules';
const WRITE_BUTTON = 'Write';
const REMOVE_BUTTON = 'Remove';
const REVIEW_BUTTON = 'Review';
const NOT_NOW_BUTTON = 'Not Now';
/** Every rule-file message goes to the output channel. */
const RULE_LOG: RuleLog = {
    info: (message) => logger.info(message),
    warn: (message, detail) => logger.warn(message, detail),
};

// ---------------------------------------------------------------------------
// The supported agents
// ---------------------------------------------------------------------------

/** `rel`, written with forward slashes, below `root`. */
function below(root: string, rel: string): string {
    return path.join(root, ...rel.split('/'));
}

/**
 * Where per-user application data lives on this platform: `%APPDATA%`,
 * `~/Library/Application Support` or `$XDG_CONFIG_HOME`. An empty variable
 * counts as unset; an unknown platform is treated like Windows.
 */
function applicationDataDir(homeRoot: string): string {
    const system = os.platform();
    const known = system === 'darwin' || system === 'linux' || system === 'win32';
    if (!known) {
        logger.warn(`Unrecognised platform "${system}": agent configuration paths follow the Windows layout`);
    }
    const dataDir = system === 'darwin' ? below(homeRoot, 'Library/Application Support')
        : system === 'linux' ? process.env.XDG_CONFIG_HOME || below(homeRoot, '.config')
            : process.env.APPDATA || below(homeRoot, 'AppData/Roaming');
    logger.info(`Agent configuration base directory on ${system}: ${dataDir}`);
    return dataDir;
}

/**
 * Where releases before 2.5.1 wrote Cursor's entry. Cursor does not read this
 * file: it takes its user-level servers from `~/.cursor/mcp.json` on every
 * platform ("Create ~/.cursor/mcp.json in your home directory for tools
 * available everywhere", https://cursor.com/docs/context/mcp, checked
 * 2026-09-24). Activation moves an entry found here (`moveCursorEntry()`).
 */
function oldCursorConfigPath(homeRoot: string): string {
    return below(applicationDataDir(homeRoot), 'Cursor/User/globalStorage/cursor.mcp/settings/mcp_settings.json');
}

/** The agents in picker order, with their configuration files as the environment says right now. */
function supportedAgents(): AgentInfo[] {
    const homeRoot = os.homedir();
    const appData = applicationDataDir(homeRoot);
    const vsCodeStorage = below(appData, 'Code/User/globalStorage');
    const viaJson = (id: string, displayName: string, configPath: string): JsonAgentInfo =>
        ({ id, name: id, displayName, configPath, configFormat: 'json', mcpServerFieldName: 'mcpServers' });
    const codex: TomlAgentInfo = {
        id: 'codex', name: 'codex', displayName: 'Codex', configFormat: 'toml',
        configPath: path.join(process.env.CODEX_HOME || below(homeRoot, '.codex'), 'config.toml'),
    };
    return [
        viaJson('roo', 'Roo Code', below(vsCodeStorage, 'rooveterinaryinc.roo-cline/settings/mcp_settings.json')),
        viaJson('antigravity', 'Antigravity', below(homeRoot, '.gemini/antigravity/mcp_config.json')),
        viaJson('cline', 'Cline', below(vsCodeStorage, 'saoudrizwan.claude-dev/settings/cline_mcp_settings.json')),
        viaJson('copilot-cli', 'GitHub Copilot CLI', path.join(process.env.COPILOT_HOME || below(homeRoot, '.copilot'), 'mcp-config.json')),
        viaJson('cursor', 'Cursor', below(homeRoot, '.cursor/mcp.json')),
        codex,
        viaJson('kimi-code', 'Kimi Code', path.join(process.env.KIMI_CODE_HOME || below(homeRoot, '.kimi-code'), 'mcp.json')),
        viaJson('claude-code', 'Claude Code', path.join(homeRoot, '.claude.json')),
        viaJson('claude-desktop', 'Claude Desktop', below(appData, 'Claude/claude_desktop_config.json')),
    ];
}

/** The agents whose configuration file exists, in roster order. */
function agentsWithFiles(): AgentInfo[] {
    return supportedAgents().filter((candidate) => fs.existsSync(candidate.configPath));
}

/**
 * Kimi Code ends a tool call after 60 s unless the entry says otherwise
 * (`toolTimeoutMs`, https://moonshotai.github.io/kimi-code/en/customization/mcp,
 * checked 2026-10-25). `cmsis_action` and `flash` may wait 600 s, and their
 * reply needs a moment after that.
 */
export const KIMI_TOOL_TIMEOUT_MS = LONG_LIMIT_CAP_MS + 30_000;

/**
 * Entry shapes of the JSON agents that do not take the default one. The key
 * order is part of the bytes written.
 */
const ENTRY_SHAPES: Readonly<Record<string, (url: string) => MCPServerConfig>> = {
    'copilot-cli': (url) => ({ type: 'http', url, tools: ['*'] }),
    // Cursor documents a remote server as `url` (with optional `headers` and `auth`);
    // the fields of the default shape are not in its schema (https://cursor.com/docs/context/mcp).
    'cursor': (url) => ({ url }),
    'claude-code': (url) => ({ type: 'http', url }),
    // Kimi Code reads an entry with `url` and no `transport` as Streamable HTTP. One entry
    // its schema rejects disables every server of the file, so nothing else goes in.
    'kimi-code': (url) => ({ url, toolTimeoutMs: KIMI_TOOL_TIMEOUT_MS }),
    // Claude Desktop starts stdio servers only; mcp-remote bridges to the HTTP endpoint.
    'claude-desktop': (url) => ({ command: 'npx', args: ['-y', 'mcp-remote', url] }),
};

/** The entry a JSON agent gets under `mcpServers.<SERVER_KEY>`: Roo Code, Antigravity and Cline share the default. */
function entryFor(agentId: string, url: string, timeout: number): MCPServerConfig {
    const shape = ENTRY_SHAPES[agentId];
    return shape ? shape(url) : { autoApprove: [], disabled: false, timeout, type: 'streamableHttp', url };
}

/**
 * Put `entry` under `<field>.<SERVER_KEY>`, replacing whatever was there; a
 * missing or null field becomes `{}` first. Any other non-object value is
 * not guarded: a string makes the assignment throw, an array loses the entry
 * when it is written back.
 */
function placeEntry(tree: Record<string, unknown>, field: string, entry: MCPServerConfig): boolean {
    if (tree[field] === null || tree[field] === undefined) {
        tree[field] = {};
    }
    (tree[field] as Record<string, unknown>)[SERVER_KEY] = entry;
    return true;
}

/** Antigravity and Gemini manage the MCP servers themselves; the setup and the prompt stay out of their way. */
function isHostManaged(): boolean {
    return process.env.ANTIGRAVITY_ENV === 'true' || Boolean(process.env.GEMINI_HOME);
}

/** Create the directory a file goes into, and its parents, when it is missing. */
async function ensureParentDir(file: string): Promise<void> {
    const parent = path.dirname(file);
    if (!fs.existsSync(parent)) {
        await fs.promises.mkdir(parent, { recursive: true });
    }
}

// ---------------------------------------------------------------------------
// Codex TOML (pure text operations; no TOML parser)
// ---------------------------------------------------------------------------

const LINE_BREAK = /\r?\n/;
const LF = '\n';
/** Any table or array-of-tables header, optionally indented and followed by a comment. */
const TABLE_HEADER = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
/** Our table exactly: no spaces inside the brackets, no quoted key. */
const SERVER_TABLE = /^\s*\[mcp_servers\.cmsis-developer-assistant\]\s*(?:#.*)?$/;
const LEGACY_TABLE = /^\s*\[mcp_servers\.cmsis-debugmcp\]\s*(?:#.*)?$/;
/** A `url` assignment; `urls =` and a commented-out line do not count. */
const URL_ASSIGNMENT = /^(\s*)url\s*=/;
/** A `url` assignment ending in `/sse`, optionally quoted and commented (a comment ending in `/sse` counts too). */
const SSE_URL_ASSIGNMENT = /^\s*url\s*=.*\/sse["']?\s*(?:#.*)?$/;

/** Index of the line that ends the table starting at `header`: the next header of any kind, or the end. */
function tableEnd(lines: readonly string[], header: number): number {
    const next = lines.findIndex((line, at) => at > header && TABLE_HEADER.test(line));
    return next < 0 ? lines.length : next;
}

/** A TOML basic string: only `\` and `"` are escaped. */
function tomlQuoted(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Point our Codex table at `serverUrl`, adding the table when it is missing.
 * The result has LF line breaks. Only the `url` line of our table is written;
 * every other line is kept as it was.
 */
export function upsertCodexDebugMCPConfig(toml: string, serverUrl: string): string {
    const urlLine = `url = ${tomlQuoted(serverUrl)}`;
    const lines = toml.split(LINE_BREAK);
    const header = lines.findIndex((line) => SERVER_TABLE.test(line));
    if (header < 0) {
        const text = lines.join(LF);
        const gap = text.length === 0 ? '' : text.endsWith(LF) ? LF : LF + LF;
        return `${text}${gap}[mcp_servers.${SERVER_KEY}]${LF}${urlLine}${LF}`;
    }
    const end = tableEnd(lines, header);
    const urlAt = lines.findIndex((line, at) => at > header && at < end && URL_ASSIGNMENT.test(line));
    if (urlAt < 0) {
        lines.splice(header + 1, 0, urlLine);
    } else {
        // The indentation stays; a trailing comment on the old line does not.
        const indent = URL_ASSIGNMENT.exec(lines[urlAt])?.[1] ?? '';
        lines[urlAt] = indent + urlLine;
    }
    return lines.join(LF);
}

/**
 * Remove the first pre-rename table and its body. Without one the input
 * comes back untouched (line breaks included); with one the result has LF
 * line breaks. A legacy sub-table starts a table of its own and stays.
 */
export function stripLegacyCodexSection(toml: string): { content: string; removed: boolean } {
    const lines = toml.split(LINE_BREAK);
    const header = lines.findIndex((line) => LEGACY_TABLE.test(line));
    if (header < 0) {
        return { content: toml, removed: false };
    }
    lines.splice(header, tableEnd(lines, header) - header);
    return { content: lines.join(LF), removed: true };
}

/** Our table's `url` still points at the retired SSE endpoint. */
function codexUrlIsSse(toml: string): boolean {
    const lines = toml.split(LINE_BREAK);
    const header = lines.findIndex((line) => SERVER_TABLE.test(line));
    return header >= 0 && lines.slice(header + 1, tableEnd(lines, header)).some((line) => SSE_URL_ASSIGNMENT.test(line));
}

/**
 * Whether an agent's configuration text registers this server under the
 * current key; the legacy key alone does not count. JSON is parsed
 * strictly, so comments or an empty file read as "no". Never throws.
 */
export function agentConfigHasServer(agent: AgentInfo, content: string): boolean {
    if (agent.configFormat !== 'json') {
        return content.split(LINE_BREAK).some((line) => SERVER_TABLE.test(line));
    }
    let tree: unknown;
    try {
        tree = JSON.parse(content);
    } catch {
        return false;
    }
    if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
        return false;
    }
    const servers = (tree as Record<string, unknown>)[agent.mcpServerFieldName];
    return servers !== null && typeof servers === 'object' && SERVER_KEY in servers;
}

// ---------------------------------------------------------------------------
// Migration of earlier entries
// ---------------------------------------------------------------------------

interface EntryMigration {
    /** Something in the object was changed. */
    changed: boolean;
    /** The change is one the user is told about; a pure endpoint refresh is not. */
    reported: boolean;
    /** Keys of other entries for this server that were removed (`dropDuplicates`). */
    duplicates: string[];
}

/**
 * Bring one servers object up to date, in place. The pre-rename key moves to
 * ours (an entry already under ours wins). An entry on the SSE transport, on
 * another transport than `wanted`, or at another endpoint is replaced by a
 * copy of `wanted` that keeps only its `autoApprove` list. An entry that is
 * current but lacks the `toolTimeoutMs` of `wanted` gets it, and keeps the
 * rest: without it, Kimi Code ends every call after 60 s. Other entries for
 * this server next to ours are removed (`dropDuplicates`). Recomputed from
 * the parsed file on every attempt, so it has no effect outside `servers`.
 */
function migrateServers(servers: unknown, wanted: MCPServerConfig): EntryMigration {
    const table = servers as Record<string, unknown> | null | undefined;
    let renamed = false;
    if (table && table[LEGACY_SERVER_KEY]) {
        if (!table[SERVER_KEY]) {
            table[SERVER_KEY] = table[LEGACY_SERVER_KEY];
        }
        delete table[LEGACY_SERVER_KEY];
        renamed = true;
    }
    const present = (table ? table[SERVER_KEY] : undefined) as MCPServerConfig | undefined;
    if (!table || !present) {
        return { changed: renamed, reported: renamed, duplicates: [] };
    }
    const duplicates = dropDuplicates(table, wanted);
    const onSse = present.type === 'sse' || present.transport === 'sse' || (typeof present.url === 'string' && present.url.endsWith('/sse'));
    const otherTransport = wanted.type !== undefined && present.type !== undefined && wanted.type !== present.type;
    const movedUrl = typeof present.url === 'string' && wanted.url !== undefined && present.url !== wanted.url;
    const movedArgs = Array.isArray(present.args) && wanted.args !== undefined
        && JSON.stringify(present.args) !== JSON.stringify(wanted.args);
    const replace = onSse || otherTransport || movedUrl || movedArgs;
    if (replace) {
        const fresh: MCPServerConfig = { ...wanted };
        if (Array.isArray(present.autoApprove)) {
            fresh.autoApprove = present.autoApprove;
        }
        table[SERVER_KEY] = fresh;
    }
    const noToolTimeout = !replace && wanted.toolTimeoutMs !== undefined && isJsonObject(present) && present.toolTimeoutMs === undefined;
    if (noToolTimeout) {
        present.toolTimeoutMs = wanted.toolTimeoutMs;
    }
    const deduplicated = duplicates.length > 0;
    return {
        changed: replace || renamed || noToolTimeout || deduplicated,
        reported: onSse || otherTransport || renamed || noToolTimeout || deduplicated,
        duplicates,
    };
}

/** A JSON object, not an array or null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The host names an entry may use for this machine's loopback address. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The routes of this server: `/mcp`, and `/sse` of releases before 2.1. */
const SERVER_ROUTES: ReadonlySet<string> = new Set(['/mcp', '/sse']);

/** The URL an entry reaches its server by: `url`, or the URL argument of a bridge such as mcp-remote. */
function entryUrl(entry: Record<string, unknown>): string | undefined {
    if (typeof entry.url === 'string') {
        return entry.url;
    }
    if (Array.isArray(entry.args)) {
        return entry.args.find((arg): arg is string => typeof arg === 'string' && /^https?:\/\//i.test(arg));
    }
    return undefined;
}

/** The port of a loopback URL on one of this server's routes; undefined for any other URL. */
function serverPortOf(url: string | undefined): string | undefined {
    if (url === undefined) {
        return undefined;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname) || !SERVER_ROUTES.has(parsed.pathname.replace(/\/+$/, ''))) {
        return undefined;
    }
    return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
}

/**
 * Remove, in place, every entry other than ours that reaches this server: a
 * loopback URL on the port of `wanted`, at `/mcp` or `/sse`. An entry the
 * user wrote by hand under a name of its own ("CMSIS Developer Assistant")
 * next to ours made Kimi Code list every tool twice, and its model called
 * the hand-written one, which lacked `toolTimeoutMs`. An entry on another
 * port is another server and stays. Where `wanted` has an `autoApprove`
 * list, a removed entry's list is merged into ours. Returns the removed keys.
 */
function dropDuplicates(table: Record<string, unknown>, wanted: MCPServerConfig): string[] {
    const port = serverPortOf(entryUrl(wanted as Record<string, unknown>));
    const ours = table[SERVER_KEY];
    if (port === undefined || !isJsonObject(ours)) {
        return [];
    }
    const removed: string[] = [];
    for (const key of Object.keys(table)) {
        const other = table[key];
        if (key === SERVER_KEY || !isJsonObject(other) || serverPortOf(entryUrl(other)) !== port) {
            continue;
        }
        if (wanted.autoApprove !== undefined && Array.isArray(other.autoApprove)) {
            const merged = new Set([...(Array.isArray(ours.autoApprove) ? ours.autoApprove : []), ...other.autoApprove]);
            ours.autoApprove = [...merged];
        }
        delete table[key];
        removed.push(key);
    }
    return removed;
}

/** "the entry 'A'", "the entries 'A' and 'B'": the keys `dropDuplicates` removed, for a message. */
function duplicatePhrase(keys: readonly string[]): string {
    const quoted = keys.map((key) => `'${key}'`);
    return quoted.length === 1
        ? `the entry ${quoted[0]}`
        : `the entries ${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * Move the entry that releases before 2.5.1 wrote to Cursor's old, unread
 * location (`oldCursorConfigPath()`) to `cursor.configPath`, where Cursor
 * reads it: the user asked for Cursor to be set up then, so the file is
 * created when missing. An entry already there is kept. The old file loses
 * our keys; when nothing else is left in it, it is deleted together with the
 * `cursor.mcp/settings` directories that only this extension ever created.
 * True when the old file changed; one that cannot be parsed is left alone.
 */
async function moveCursorEntry(cursor: JsonAgentInfo, oldPath: string, entry: MCPServerConfig): Promise<boolean> {
    let tree: unknown;
    try {
        tree = JSON.parse(await fs.promises.readFile(oldPath, 'utf8'));
    } catch {
        return false;
    }
    const servers = isJsonObject(tree) ? tree.mcpServers : undefined;
    if (!isJsonObject(tree) || !isJsonObject(servers) || !(servers[SERVER_KEY] || servers[LEGACY_SERVER_KEY])) {
        return false;
    }
    const field = cursor.mcpServerFieldName;
    if (!fs.existsSync(cursor.configPath)) {
        await ensureParentDir(cursor.configPath);
        await writeFileAtomic(cursor.configPath, JSON.stringify({ [field]: { [SERVER_KEY]: entry } }, null, 2));
    } else {
        const added = await rewriteJsonFile(cursor.configPath, (config) => {
            const present = config[field];
            return isJsonObject(present) && present[SERVER_KEY] ? false : placeEntry(config, field, entry);
        });
        if (added === 'unparseable') {
            logger.warn(`Left the Cursor entry in ${oldPath}: ${cursor.configPath} is not a JSON object`);
            return false;
        }
    }
    delete servers[SERVER_KEY];
    delete servers[LEGACY_SERVER_KEY];
    const othersLeft = Object.keys(servers).length > 0 || Object.keys(tree).some((key) => key !== 'mcpServers');
    if (othersLeft) {
        await writeFileAtomic(oldPath, JSON.stringify(tree, null, 2));
    } else {
        await fs.promises.unlink(oldPath);
        // settings/, then cursor.mcp/; rmdir refuses a directory that is not empty.
        for (const dir of [path.dirname(oldPath), path.dirname(path.dirname(oldPath))]) {
            await fs.promises.rmdir(dir).catch(() => undefined);
        }
    }
    logger.info(`Moved the Cursor MCP server entry from ${oldPath}, which Cursor does not read, to ${cursor.configPath}`);
    return true;
}

/**
 * Migrate one JSON agent file. `reported` when it was written with a change
 * worth reporting; `duplicates`, the keys of the other entries for this
 * server it lost.
 */
async function migrateJsonAgent(agent: JsonAgentInfo, wanted: MCPServerConfig): Promise<{ reported: boolean; duplicates: string[] }> {
    let step: EntryMigration = { changed: false, reported: false, duplicates: [] };
    const outcome = await rewriteJsonFile(agent.configPath, (tree) => {
        step = migrateServers(tree[agent.mcpServerFieldName], wanted);
        return step.changed;
    });
    const written = outcome === 'written';
    return { reported: written && step.reported, duplicates: written ? step.duplicates : [] };
}

/**
 * Migrate Codex's file: drop the pre-rename table and point ours at the
 * current endpoint when that table existed or ours still uses SSE. A
 * stale port on a non-SSE URL is left as it is. True when the file changed.
 */
async function migrateCodexAgent(agent: TomlAgentInfo, url: string): Promise<boolean> {
    const original = await fs.promises.readFile(agent.configPath, 'utf8');
    const stripped = stripLegacyCodexSection(original);
    const updated = stripped.removed || codexUrlIsSse(stripped.content)
        ? upsertCodexDebugMCPConfig(stripped.content, url)
        : stripped.content;
    if (updated === original) {
        return false;
    }
    await writeFileAtomic(agent.configPath, updated);
    return true;
}

// ---------------------------------------------------------------------------
// Skill directories
// ---------------------------------------------------------------------------

/** The open workspace folders on the local file system. */
function localFolders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}

/**
 * Where the skills go: the personal directories of every agent on this
 * machine. Releases 2.5.x could also install a selection into a workspace
 * folder (`<folder>/.agents/skills`, `<folder>/.claude/skills`); those roots
 * are swept for marker-guarded leftovers, never written.
 */
function skillRoots(): SkillInstallRoots {
    const personal = getSkillInstallRoots();
    const sweepOnly = [...personal.sweepOnly];
    for (const folder of localFolders()) {
        const project = getProjectSkillInstallRoots(folder.uri.fsPath);
        sweepOnly.push(...project.install, ...project.sweepOnly);
    }
    // A workspace folder that is the home directory names the personal roots a
    // second time; they are written, never swept, or every skill would go again.
    return { install: personal.install, sweepOnly: withoutInstallRoots(sweepOnly, personal.install) };
}

/** A directory for display, with the home directory as `~` (a plain prefix test). */
function shortenHome(dir: string): string {
    const homePrefix = os.homedir();
    return dir.startsWith(homePrefix) ? `~${dir.slice(homePrefix.length)}` : dir;
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export class AgentConfigurationManager {
    private mcpPort: number;
    private readonly installer: SkillInstaller;
    /** `undefined` until first needed; `null` once loading failed, which is not retried. */
    private catalogCache: SkillCatalog | null | undefined;
    /** End of the `syncSkills` queue. It never rejects, so one failed run does not block the next. */
    private syncQueue: Promise<unknown> = Promise.resolve();
    /** The rules section of the tool contract: `undefined` until first needed; `null` once reading failed. */
    private rulesCache: string | null | undefined;
    /** Texts the diff editor shows for the rules preview, by URI path; the provider is registered on first use. */
    private previewTexts: Map<string, string> | undefined;
    private previewCount = 0;

    constructor(
        private readonly ctx: vscode.ExtensionContext,
        private readonly entryTimeoutSeconds: number,
        serverPort: number,
    ) {
        this.mcpPort = serverPort;
        const manifest = ctx.extension?.packageJSON as { version?: string } | undefined;
        this.installer = new SkillInstaller(ctx.extensionPath, manifest?.version ?? 'unknown');
    }

    /** Use another server port for every later write. Nothing is rewritten now. */
    updatePort(nextPort: number): void {
        this.mcpPort = nextPort;
    }

    /** The first-run setup is due: not answered yet, and not in an environment that manages MCP servers itself. */
    shouldShowPopup(): Promise<boolean> {
        const due = !isHostManaged() && this.ctx.globalState.get<boolean>(SETUP_ANSWERED_KEY) !== true;
        return Promise.resolve(due);
    }

    /**
     * The first-run setup: the agent picker (accepting it also installs the
     * skills), then the tool rules for the agents' rule files unless
     * `agentRules.install` is `never` (the second step follows whether the
     * first was accepted or dismissed). Counts as answered afterwards,
     * whatever happened.
     */
    runSetupFlow(): Promise<void> {
        return this.walkThroughSetup();
    }

    /**
     * At activation: offer, once per version of the rules, to update every
     * recorded rules block whose text is not the current tool contract's,
     * and update each one the user confirms after its preview. Never creates
     * a block or a file; does nothing while `agentRules.install` is `never`.
     * Resolves only once the user has answered; activation does not await it.
     */
    async refreshAgentRules(): Promise<void> {
        const recorded = this.ruleRecords().read().length;
        if (recorded === 0) {
            return;
        }
        if (!this.rulesEnabled()) {
            logger.info(`Tool rules: agentRules.install is "never"; the ${recorded} rule file(s) written earlier are left as they are`);
            return;
        }
        const rules = this.toolRules();
        if (rules === undefined) {
            return;
        }
        const ui: RuleRefreshUi = {
            offer: (changes) => this.offerRuleUpdate(changes, rules),
            confirm: (change) => this.previewRuleChange(change),
        };
        const report = await refreshRecordedRules(rules, ui, this.ruleDeps());
        if (report.updated.length > 0 || report.postponed.length > 0 || report.forgotten.length > 0) {
            logger.info(`Tool rules at activation: ${report.updated.length} file(s) updated, `
                + `${report.postponed.length} left outdated, ${report.forgotten.length} forgotten`);
        }
        this.reportRuleStep({ dismissed: false, applied: report.updated.map((file) => ({ file, kind: 'update' })), declined: [], failed: [] });
    }

    /** Make the first-run setup due again, and the offer of the current rules update. */
    async resetPopupState(): Promise<void> {
        await this.ctx.globalState.update(SETUP_ANSWERED_KEY, false);
        await this.ctx.globalState.update(LEGACY_SKILLS_PROMPT_KEY, undefined);
        await this.ctx.globalState.update(RULES_UPDATE_OFFERED_KEY, undefined);
    }

    /**
     * Update the entries of agents whose configuration file exists: rename
     * the pre-rename key, move SSE and wrong-transport entries to the current
     * shape, refresh a stale endpoint. No file is created, except Cursor's
     * when an entry is moved there from the location earlier releases used.
     * One agent failing does not stop the others.
     */
    migrateExistingConfigurations(): Promise<void> {
        return this.migrateAgentFiles();
    }

    /**
     * Install the skill catalog into the personal skills directories and
     * remove what this extension installed there earlier and no longer ships.
     * Runs one at a time, in call order; resolves `null` when the catalog
     * cannot be loaded.
     */
    syncSkills(reason: string): Promise<SkillSyncReport | null> {
        const run = this.syncQueue.then(() => this.installCatalog(reason));
        this.syncQueue = run.catch(() => undefined);
        return run;
    }

    // --- setup and agents --------------------------------------------------

    private endpointUrl(): string {
        return `http://localhost:${this.mcpPort}/mcp`;
    }

    /** `agentRules.install` is not `never`: the setup offers the rule files and activation keeps them current. */
    private rulesEnabled(): boolean {
        return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string>(AGENT_RULES_SETTING, 'ask') !== 'never';
    }

    private async walkThroughSetup(): Promise<void> {
        try {
            const roster = supportedAgents();
            const steps: Array<'agents' | 'rules'> = ['agents'];
            if (this.rulesEnabled()) {
                steps.push('rules');
            } else {
                logger.info('agentRules.install is "never": the setup skips the tool rules step');
            }
            const mark = (step: 'agents' | 'rules'): string =>
                (steps.length > 1 ? ` (${steps.indexOf(step) + 1}/${steps.length})` : '');
            const chosen = await this.pickAndConfigureAgents(roster, mark('agents'));
            if (chosen.length > 0) {
                await this.installForAgents();
            }
            if (steps.includes('rules')) {
                await this.offerAgentRules(chosen, mark('rules'));
            }
        } catch (failure) {
            logger.error('The setup flow failed', failure);
            void notifyError(`Failed to show the ${PRODUCT} setup: ${String(failure)}`);
        } finally {
            await this.ctx.globalState.update(SETUP_ANSWERED_KEY, true);
        }
    }

    /**
     * Step 1: the agent picker. Accepting configures the chosen agents one
     * after the other and resolves them once all are done; closing it
     * resolves no agent.
     */
    private pickAndConfigureAgents(roster: AgentInfo[], stepMark: string): Promise<AgentInfo[]> {
        return new Promise<AgentInfo[]>((settle, fail) => {
            const agentList = vscode.window.createQuickPick<vscode.QuickPickItem>();
            agentList.title = `${SETUP_TITLE}${stepMark} - Connect AI Agents to the MCP Server`;
            agentList.placeholder = `Select the AI agents to register the ${PRODUCT} MCP server with (Esc to skip)`;
            agentList.canSelectMany = true;
            agentList.ignoreFocusOut = true;
            // The detail is the display name; it maps a chosen item back to its agent.
            agentList.items = roster.map(({ displayName }) =>
                ({ label: `$(add) Set up ${displayName}`, description: AGENT_ITEM_NOTE, detail: displayName, picked: false }));
            let accepted = false;
            agentList.onDidAccept(() => {
                accepted = true;
                const chosenNames = agentList.selectedItems.map((item) => item.detail);
                const chosen = chosenNames.flatMap((name) => roster.filter((agent) => agent.displayName === name));
                agentList.hide();
                this.configureAgents(chosen).then(() => settle(chosen), fail);
            });
            agentList.onDidHide(() => {
                agentList.dispose();
                if (!accepted) {
                    settle([]);
                }
            });
            agentList.show();
        });
    }

    /** Configure agents in turn; each success toast is answered before the next agent starts. */
    private async configureAgents(queue: AgentInfo[]): Promise<void> {
        for (const agent of queue) {
            try {
                const registered = await this.registerServer(agent);
                if (registered === false) {
                    continue;
                }
                const configured = `✅ Registered the ${PRODUCT} MCP server with ${agent.displayName}.${registered}`;
                if (await vscode.window.showInformationMessage(configured, OPEN_FILE_BUTTON) === OPEN_FILE_BUTTON) {
                    const written = vscode.Uri.file(agent.configPath);
                    await vscode.commands.executeCommand('vscode.open', written);
                }
            } catch (failure) {
                logger.error(`Setting up ${agent.displayName} failed`, failure);
                void notifyError(`Could not set up ${agent.displayName}: ${String(failure)}`);
            }
        }
    }

    /**
     * Write this server's entry into one agent's file, creating the file and
     * its directory when needed. An existing entry is replaced whole, and
     * other entries for this server are removed (`dropDuplicates`). The
     * sentence the success toast adds about removed entries ('' when there
     * were none); false when it did not work out, and the user has been told why.
     */
    private async registerServer(agent: AgentInfo): Promise<string | false> {
        const file = agent.configPath;
        const url = this.endpointUrl();
        let duplicates: string[] = [];
        try {
            await ensureParentDir(file);
            const fileExists = fs.existsSync(file);
            if (agent.configFormat !== 'json') {
                const toml = fileExists ? await fs.promises.readFile(file, 'utf8') : '';
                await writeFileAtomic(file, upsertCodexDebugMCPConfig(toml, url));
            } else {
                const field = agent.mcpServerFieldName;
                const entry = entryFor(agent.id, url, this.entryTimeoutSeconds);
                if (!fileExists) {
                    // Nothing to keep: 2-space JSON without a final newline, like the rewrite below.
                    await writeFileAtomic(file, JSON.stringify({ [field]: { [SERVER_KEY]: entry } }, null, 2));
                } else if (await rewriteJsonFile(file, (tree) => {
                    placeEntry(tree, field, entry);
                    duplicates = dropDuplicates(tree[field] as Record<string, unknown>, entry);
                    return true;
                }) === 'unparseable') {
                    logger.warn(`Left ${file} alone: it is not a JSON object`);
                    void notifyError(
                        `Cannot configure ${agent.displayName}: ${file} exists but is not valid JSON. Please fix or remove the file and try again.`);
                    return false;
                }
            }
            logger.info(`Registered the MCP server with ${agent.displayName} in ${file}`);
            if (duplicates.length > 0) {
                logger.info(`Removed ${duplicatePhrase(duplicates)} from ${file}: ${duplicates.length === 1 ? 'it points' : 'they point'} at this server`);
                return ` Removed ${duplicatePhrase(duplicates)}, which pointed at the same server, so that ${agent.displayName} lists each tool once.`;
            }
            return '';
        } catch (failure) {
            logger.error(`Could not register the MCP server with ${agent.displayName}`, failure);
            void notifyError(`The ${PRODUCT} MCP server could not be added to ${agent.displayName}: ${String(failure)}`);
            return false;
        }
    }

    private async migrateAgentFiles(): Promise<void> {
        const url = this.endpointUrl();
        let reported = 0;
        const cursor = supportedAgents().find((agent): agent is JsonAgentInfo => agent.id === 'cursor' && agent.configFormat === 'json');
        if (cursor) {
            const oldPath = oldCursorConfigPath(os.homedir());
            try {
                if (await moveCursorEntry(cursor, oldPath, entryFor(cursor.id, url, this.entryTimeoutSeconds))) {
                    reported++;
                }
            } catch (failure) {
                logger.warn(`Could not move the Cursor entry from ${oldPath} to ${cursor.configPath}`, failure);
            }
        }
        const deduplicated: string[] = [];
        for (const agent of agentsWithFiles()) {
            try {
                let counted: boolean;
                if (agent.configFormat === 'json') {
                    const step = await migrateJsonAgent(agent, entryFor(agent.id, url, this.entryTimeoutSeconds));
                    counted = step.reported;
                    if (step.duplicates.length > 0) {
                        deduplicated.push(`${agent.displayName}: ${duplicatePhrase(step.duplicates)}`);
                        logger.info(`Removed ${duplicatePhrase(step.duplicates)} from ${agent.configPath}: `
                            + `${step.duplicates.length === 1 ? 'it points' : 'they point'} at this server, which '${SERVER_KEY}' registers`);
                    }
                } else {
                    counted = await migrateCodexAgent(agent, url);
                }
                if (counted) {
                    reported++;
                    logger.info(`Migrated the ${agent.displayName} configuration at ${agent.configPath}`);
                }
            } catch (failure) {
                logger.warn(`Could not migrate the ${agent.displayName} configuration at ${agent.configPath}`, failure);
            }
        }
        if (deduplicated.length > 0) {
            void vscode.window.showInformationMessage(`${PRODUCT}: removed second entries for this MCP server, so that agents `
                + `list each tool once (${deduplicated.join('; ')}).`);
        } else if (reported > 0) {
            void vscode.window.showInformationMessage(`${PRODUCT}: brought the MCP server entry up to date in ${reported} agent configuration(s).`);
        }
    }

    // --- skills ------------------------------------------------------------

    /** The shipped skill catalog, loaded on first use. */
    private catalog(): SkillCatalog | null {
        if (this.catalogCache === undefined) {
            try {
                this.catalogCache = loadSkillCatalog(this.ctx.extensionPath);
            } catch (failure) {
                logger.error('Could not load the bundled skill catalog', failure);
                this.catalogCache = null;
            }
        }
        return this.catalogCache;
    }

    /** One `syncSkills` run: the whole catalog into the personal directories, the project roots of 2.5.x swept. */
    private async installCatalog(reason: string): Promise<SkillSyncReport | null> {
        const catalog = this.catalog();
        if (!catalog) {
            return null;
        }
        // The catalog marks the one skill installed (cmsis-help); every other procedure is a unit of the knowledge
        // index. The installer's sweep removes what an earlier version installed.
        const wanted = installSet(catalog);
        const roots = skillRoots();
        const report = await this.installer.sync(roots, catalog, wanted.visible, wanted.hidden);
        logger.info(`Skill install (${reason}) into `
            + `${roots.install.map(shortenHome).join(', ')}: ${summarizeSkillSync(report)}; `
            + `visible [${wanted.visible.join(', ')}], hidden [${wanted.hidden.join(', ')}]`);
        for (const failed of report.failed) {
            logger.warn(`Skill ${failed.name ?? '(root)'} in ${failed.root} failed: ${failed.error}`);
        }
        for (const foreign of report.skippedForeign) {
            logger.info(`Left ${foreign.name} in ${foreign.root} untouched: it was not installed by this extension`);
        }
        return report;
    }

    /** After the agents step: install the skills and say where they went. */
    private async installForAgents(): Promise<void> {
        const catalog = this.catalog();
        if (!catalog) {
            void notifyError(`${PRODUCT}: the bundled skill catalog could not be loaded, so no skills were installed.`);
            return;
        }
        const report = await this.syncSkills('setup');
        if (!report) {
            return;
        }
        const into = [...new Set(report.installed.map((record) => shortenHome(record.root)))];
        const visible = new Set(report.installed.filter((record) => !record.hidden).map((record) => record.name)).size;
        const hidden = new Set(report.installed.filter((record) => record.hidden).map((record) => record.name)).size;
        let text = into.length > 0
            ? `${PRODUCT}: ${visible} CMSIS skills (+${hidden} hidden member skills) installed into ${into.join(', ')}.`
            : `${PRODUCT}: no CMSIS skills were installed.`;
        if (report.failed.length > 0) {
            text += ` ${report.failed.length} failed — see the output log.`;
        }
        void vscode.window.showInformationMessage(text);
    }

    // --- tool rules ----------------------------------------------------------

    /** The rules section of the shipped tool contract, read once; undefined, logged, when it cannot be read. */
    private toolRules(): string | undefined {
        if (this.rulesCache === undefined) {
            const file = path.join(this.ctx.extensionPath, 'docs', ...TOOL_CONTRACT_DOC.split('/'));
            try {
                this.rulesCache = parseToolContract(fs.readFileSync(file, 'utf8')).rules;
            } catch (failure) {
                logger.warn(`The tool rules are unavailable: ${file} cannot be read`, failure);
                this.rulesCache = null;
            }
        }
        return this.rulesCache ?? undefined;
    }

    /** The rule files written so far, kept in globalState. */
    private ruleRecords(): RuleRecordStore {
        return {
            read: () => parseRuleRecords(this.ctx.globalState.get<unknown>(RULE_FILES_STATE_KEY)),
            write: async (records) => {
                await this.ctx.globalState.update(RULE_FILES_STATE_KEY, records);
            },
        };
    }

    private ruleDeps(): RuleStepDeps {
        return { fs: NODE_RULE_FILES, store: this.ruleRecords(), log: RULE_LOG };
    }

    /**
     * The agents whose rule files step 2 offers: the ones picked in step 1,
     * the ones whose configuration registers the server already, and VS Code
     * Copilot Chat, which reaches the server through the definition provider.
     */
    private async ruleAgents(chosen: readonly AgentInfo[]): Promise<RuleAgentId[]> {
        const ids = new Set<RuleAgentId>(['copilot-chat']);
        for (const agent of chosen) {
            if (isRuleAgent(agent.id)) {
                ids.add(agent.id);
            }
        }
        for (const agent of agentsWithFiles()) {
            if (!isRuleAgent(agent.id) || ids.has(agent.id)) {
                continue;
            }
            try {
                if (agentConfigHasServer(agent, await fs.promises.readFile(agent.configPath, 'utf8'))) {
                    ids.add(agent.id);
                }
            } catch (failure) {
                logger.warn(`Could not read ${agent.configPath} to look for the MCP server`, failure);
            }
        }
        return [...ids];
    }

    /**
     * Step 3: offer the agents' rule files for the tool rules, then add,
     * update or take out the rules file by file, each change shown as a diff
     * and made only when the user confirms it.
     */
    private async offerAgentRules(chosen: readonly AgentInfo[], stepMark: string): Promise<void> {
        const rules = this.toolRules();
        if (rules === undefined) {
            logger.warn('The setup skips the tool rules step: the tool contract cannot be read');
            return;
        }
        const folders = localFolders().map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
        const offered = ruleFileTargets(await this.ruleAgents(chosen), {
            home: os.homedir(),
            env: process.env,
            folders,
            probe: NODE_RULE_PROBE,
            copilotChatReadsAgentsMd: vscode.workspace.getConfiguration('chat').get<boolean>('useAgentsMdFile', true) !== false,
        });
        const targets = withRecordedTargets(offered, this.ruleRecords().read(), folders);
        const ui: RuleStepUi = {
            choose: (choices) => this.chooseRuleFiles(choices, stepMark),
            confirm: (change) => this.previewRuleChange(change),
        };
        this.reportRuleStep(await runRuleStep(targets, rules, ui, this.ruleDeps()));
    }

    /** The rule-file picker: the files that are to carry the rules; undefined when closed. */
    private chooseRuleFiles(choices: readonly RuleChoice[], stepMark: string): Promise<ReadonlySet<string> | undefined> {
        const items = ruleFileItems(choices);
        return new Promise<ReadonlySet<string> | undefined>((settle) => {
            const fileList = vscode.window.createQuickPick<RuleFileItem>();
            fileList.title = `${SETUP_TITLE}${stepMark} - Add the Tool Rules to Your Agents' Rule Files`;
            fileList.placeholder = 'Check the files that get the CMSIS Developer Assistant tool rules; '
                + 'each change is shown as a diff and written only when you confirm it (Esc to skip)';
            fileList.canSelectMany = true;
            fileList.ignoreFocusOut = true;
            fileList.items = items;
            fileList.selectedItems = items.filter((item) => item.picked);
            let accepted = false;
            fileList.onDidAccept(() => {
                accepted = true;
                const files = new Set(fileList.selectedItems.flatMap((item) => (item.choice ? [item.choice.target.file] : [])));
                fileList.hide();
                settle(files);
            });
            fileList.onDidHide(() => {
                fileList.dispose();
                if (!accepted) {
                    settle(undefined);
                }
            });
            fileList.show();
        });
    }

    /**
     * Ask whether to review the update of outdated rules blocks: once per
     * version of the rules, so that every window and every activation does
     * not ask again, and not while the setup is due, whose rules step offers
     * the update itself. True when the user chose Review.
     */
    private async offerRuleUpdate(changes: readonly RuleChange[], rules: string): Promise<boolean> {
        if (await this.shouldShowPopup()) {
            logger.info('Tool rules: the setup is due and offers the update of the outdated rule files');
            return false;
        }
        const digest = crypto.createHash('sha256').update(rules).digest('hex');
        if (this.ctx.globalState.get<string>(RULES_UPDATE_OFFERED_KEY) === digest) {
            logger.info('Tool rules: the update of these rules was offered before');
            return false;
        }
        await this.ctx.globalState.update(RULES_UPDATE_OFFERED_KEY, digest);
        const where = changes.length === 1 ? ruleFileLabel(changes[0].target) : `${changes.length} rule files`;
        const answer = await vscode.window.showInformationMessage(
            `${PRODUCT}: this release changes the tool rules it wrote to ${where}. Review the update? `
            + 'Configure Agent offers it later too.',
            REVIEW_BUTTON, NOT_NOW_BUTTON);
        return answer === REVIEW_BUTTON;
    }

    /** Where the preview texts come from; the provider is registered on first use. */
    private previewDocuments(): Map<string, string> {
        if (!this.previewTexts) {
            const texts = new Map<string, string>();
            this.ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(RULES_PREVIEW_SCHEME, {
                provideTextDocumentContent: (uri: vscode.Uri): string => texts.get(uri.path) ?? '',
            }));
            this.previewTexts = texts;
        }
        return this.previewTexts;
    }

    /**
     * Show one change as a diff — the file as it is (or an empty document for
     * a new file) against the text proposed — and ask for it in a modal
     * dialog. True only when the user chose Write or Remove; a preview that
     * cannot be shown counts as declined.
     */
    private async previewRuleChange(change: RuleChange): Promise<boolean> {
        const texts = this.previewDocuments();
        const name = path.basename(change.target.file);
        const serial = ++this.previewCount;
        const proposedPath = `/${serial}/${name}`;
        const emptyPath = `/${serial}/empty/${name}`;
        texts.set(proposedPath, change.after ?? '');
        texts.set(emptyPath, '');
        const current = change.before === undefined
            ? vscode.Uri.parse(`${RULES_PREVIEW_SCHEME}:${emptyPath}`)
            : vscode.Uri.file(change.target.file);
        const proposed = vscode.Uri.parse(`${RULES_PREVIEW_SCHEME}:${proposedPath}`);
        const removing = change.kind === 'remove';
        try {
            try {
                await vscode.commands.executeCommand('vscode.diff', current, proposed,
                    `${name}: now ↔ ${removing ? 'without' : 'with'} the tool rules`, { preview: true });
            } catch (failure) {
                logger.warn(`The preview of ${change.target.file} could not be shown; the file is not changed`, failure);
                return false;
            }
            const button = removing ? REMOVE_BUTTON : WRITE_BUTTON;
            const agents = change.target.agents.map((id) => RULE_AGENT_NAMES[id]).join(', ');
            const deletes = removing && change.after === undefined ? ' The file holds nothing else and is deleted.' : '';
            const detail = `Read by ${agents}. The diff editor shows the change; nothing is written unless you choose ${button}.${deletes}`;
            const answer = await vscode.window.showInformationMessage(ruleChangeQuestion(change), { modal: true, detail }, button);
            return answer === button;
        } finally {
            await this.closeRulePreviews();
            texts.delete(proposedPath);
            texts.delete(emptyPath);
        }
    }

    /** Close the diff editors the preview opened. The window API may be missing (the test stubs have none). */
    private async closeRulePreviews(): Promise<void> {
        const groups = vscode.window.tabGroups as vscode.TabGroups | undefined;
        if (!groups || typeof vscode.TabInputTextDiff !== 'function') {
            return;
        }
        const ours = groups.all.flatMap((group) => group.tabs)
            .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === RULES_PREVIEW_SCHEME);
        if (ours.length > 0) {
            await Promise.resolve(groups.close(ours)).catch((failure: unknown) => logger.debug('Could not close the rules preview', failure));
        }
    }

    /** One toast for what the step changed, and one per file that failed. */
    private reportRuleStep(report: RuleStepReport): void {
        const written = report.applied.filter((change) => change.kind !== 'remove').length;
        const takenOut = report.applied.length - written;
        const parts = [
            ...(written > 0 ? [`written to ${written} file(s)`] : []),
            ...(takenOut > 0 ? [`taken out of ${takenOut} file(s)`] : []),
        ];
        if (parts.length > 0) {
            void vscode.window.showInformationMessage(`${PRODUCT}: the tool rules were ${parts.join(' and ')}.`);
        }
        for (const failed of report.failed) {
            void notifyError(`${PRODUCT}: could not change the tool rules in ${failed.file}: ${failed.error}`);
        }
    }
}

// ---------------------------------------------------------------------------
// The rule-file picker
// ---------------------------------------------------------------------------

interface RuleFileItem extends vscode.QuickPickItem {
    /** Absent on the separators. */
    choice?: RuleChoice;
}

/** A rule file for display: `~/…` for a user file, `<folder>/…` for a workspace one. */
function ruleFileLabel(target: RuleFileTarget): string {
    if (target.scope === 'workspace' && target.folder) {
        return `${target.folder.name}/${path.relative(target.folder.path, target.file).split(path.sep).join('/')}`;
    }
    return shortenHome(target.file);
}

/** What checking the item means for the file as it is now. */
function ruleFileState(choice: RuleChoice): string {
    if (choice.state === 'current') {
        return 'Has the current tool rules. Uncheck to take them out.';
    }
    if (choice.state === 'outdated') {
        return 'Has an older version of the tool rules, which is updated. Uncheck to take them out.';
    }
    if (choice.text === undefined) {
        return choice.target.form === 'own' ? 'New file of its own, holding the rules only.' : 'New file.';
    }
    return 'The rules go at the end; the rest of the file stays as it is.';
}

/** The picker items: the user files, then each workspace folder's files, under a heading each. */
function ruleFileItems(choices: readonly RuleChoice[]): RuleFileItem[] {
    const items: RuleFileItem[] = [];
    const group = (heading: string, members: readonly RuleChoice[]): void => {
        if (members.length === 0) {
            return;
        }
        items.push({ label: heading, kind: vscode.QuickPickItemKind.Separator });
        for (const choice of members) {
            items.push({
                label: ruleFileLabel(choice.target),
                description: choice.target.agents.map((id) => RULE_AGENT_NAMES[id]).join(', '),
                detail: ruleFileState(choice),
                picked: choice.checked,
                choice,
            });
        }
    };
    group('This user: read in every project', choices.filter((choice) => choice.target.scope === 'user'));
    const folders = [...new Map(choices.flatMap((choice) => (choice.target.folder ? [[choice.target.folder.path, choice.target.folder]] as const : []))).values()];
    for (const folder of folders) {
        group(`Workspace folder ${folder.name}`, choices.filter((choice) => choice.target.folder?.path === folder.path));
    }
    return items;
}

/** The question of the confirmation dialog. */
function ruleChangeQuestion(change: RuleChange): string {
    const where = ruleFileLabel(change.target);
    switch (change.kind) {
        case 'create':
            return `Create ${where} with the ${PRODUCT} tool rules?`;
        case 'add':
            return `Add the ${PRODUCT} tool rules to ${where}?`;
        case 'update':
            return `Update the ${PRODUCT} tool rules in ${where}?`;
        default:
            return change.after === undefined
                ? `Take the ${PRODUCT} tool rules out of ${where} and delete the file?`
                : `Take the ${PRODUCT} tool rules out of ${where}?`;
    }
}
