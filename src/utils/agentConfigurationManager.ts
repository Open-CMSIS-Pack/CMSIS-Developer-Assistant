// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './logger';
import {
    AI_SKILLS_ENABLED_SETTING,
    AI_SKILLS_PROMPT_SETTING,
    DEFAULT_INSTALLED_SKILLS,
    INSTALLED_SKILLS_SETTING,
    SKILL_CATEGORY_LABELS,
    SkillCatalog,
    SkillCatalogEntry,
    bundledSkillNames,
    groupByCategory,
    hasPackSkillSelected,
    isBundledSkill,
    loadSkillCatalog,
    resolveDesiredSkills,
} from './skillCatalog';
import { SkillInstaller, SkillSyncReport, getSkillInstallRoots, summarizeSkillSync } from './skillInstaller';
import { SKILLS_PROMPT_SHOWN_KEY, SKILL_PROMPT_BUTTONS, decideSkillPrompt, skillPromptMessage } from './skillPrompt';

export interface BaseAgentInfo {
    id: string;
    name: string;
    displayName: string;
    configPath: string;
    configFormat: 'json' | 'toml';
}

export interface JsonAgentInfo extends BaseAgentInfo {
    configFormat: 'json';
    mcpServerFieldName: string;
}

export interface TomlAgentInfo extends BaseAgentInfo {
    configFormat: 'toml';
}

export type AgentInfo = JsonAgentInfo | TomlAgentInfo;

export interface MCPServerConfig {
    type?: string;
    url?: string;
    // stdio-bridge shape (Claude Desktop has no native HTTP transport)
    command?: string;
    args?: string[];
    autoApprove?: string[];
    disabled?: boolean;
    timeout?: number;
    tools?: string[];
}

/**
 * MCP server key written into external agent config files — the JSON map key
 * under `mcpServers`, and the Codex TOML `[mcp_servers.<key>]` section name.
 * Renamed from `cmsis-debugmcp` when the product became "CMSIS Developer
 * Assistant".
 */
export const SERVER_KEY = 'cmsis-developer-assistant';

/**
 * The pre-rename key. Existing user configs written by earlier versions are
 * migrated from this to SERVER_KEY on activation; afterwards it is only used
 * for detection of a stale entry.
 */
export const LEGACY_SERVER_KEY = 'cmsis-debugmcp';

/**
 * Insert or update the `[mcp_servers.<SERVER_KEY>]` block in a Codex
 * `config.toml`, preserving the rest of the file. Codex configs are TOML,
 * not JSON, so they cannot go through the generic JSON path.
 */
export function upsertCodexDebugMCPConfig(configContent: string, mcpServerUrl: string): string {
    const normalizedConfigContent = configContent.replace(/\r\n/g, '\n');
    const lines = normalizedConfigContent.split('\n');
    const escapedUrl = escapeTomlString(mcpServerUrl);
    const debugMCPSectionIndex = lines.findIndex(line => isCodexServerSectionHeader(line, SERVER_KEY));

    if (debugMCPSectionIndex === -1) {
        const separator = normalizedConfigContent.length === 0
            ? ''
            : normalizedConfigContent.endsWith('\n') ? '\n' : '\n\n';
        return `${normalizedConfigContent}${separator}[mcp_servers.${SERVER_KEY}]\nurl = "${escapedUrl}"\n`;
    }

    const nextSectionIndex = findNextTomlSectionIndex(lines, debugMCPSectionIndex + 1);
    const debugMCPSectionEndIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;

    for (let index = debugMCPSectionIndex + 1; index < debugMCPSectionEndIndex; index++) {
        const urlMatch = lines[index].match(/^(\s*)url\s*=.*$/);
        if (urlMatch) {
            lines[index] = `${urlMatch[1]}url = "${escapedUrl}"`;
            return lines.join('\n');
        }
    }

    lines.splice(debugMCPSectionIndex + 1, 0, `url = "${escapedUrl}"`);
    return lines.join('\n');
}

/**
 * Remove a legacy `[mcp_servers.cmsis-debugmcp]` section from a Codex
 * config.toml if present, bounded by the next TOML section so adjacent
 * `[mcp_servers.*]` blocks survive. Returns the stripped content and whether
 * anything was removed.
 */
export function stripLegacyCodexSection(configContent: string): { content: string; removed: boolean } {
    const normalized = configContent.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const idx = lines.findIndex(line => isCodexServerSectionHeader(line, LEGACY_SERVER_KEY));
    if (idx === -1) {
        return { content: configContent, removed: false };
    }
    const nextIdx = findNextTomlSectionIndex(lines, idx + 1);
    const end = nextIdx === -1 ? lines.length : nextIdx;
    lines.splice(idx, end - idx);
    return { content: lines.join('\n'), removed: true };
}

function escapeTomlString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findNextTomlSectionIndex(lines: string[], startIndex: number): number {
    for (let index = startIndex; index < lines.length; index++) {
        if (isTomlSectionHeader(lines[index])) {
            return index;
        }
    }
    return -1;
}

function isTomlSectionHeader(line: string): boolean {
    return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line);
}

function isCodexServerSectionHeader(line: string, key: string): boolean {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*\\[mcp_servers\\.${escaped}\\]\\s*(?:#.*)?$`).test(line);
}

/**
 * Whether an agent's config file text registers this extension's MCP server:
 * a `<mcpServerFieldName>.cmsis-developer-assistant` entry in the JSON
 * formats, a `[mcp_servers.cmsis-developer-assistant]` section in Codex's
 * TOML. The legacy `cmsis-debugmcp` key alone does not count — migration
 * renames it on activation, before this is asked. Unparseable content reads
 * as "not registered". Pure, so the install prompt's detection is testable.
 */
export function agentConfigHasServer(agent: AgentInfo, content: string): boolean {
    if (agent.configFormat === 'toml') {
        return content.split(/\r?\n/).some(line => isCodexServerSectionHeader(line, SERVER_KEY));
    }
    try {
        const config = JSON.parse(content) as unknown;
        if (typeof config !== 'object' || config === null || Array.isArray(config)) {
            return false;
        }
        const servers = (config as Record<string, unknown>)[agent.mcpServerFieldName];
        return typeof servers === 'object' && servers !== null && SERVER_KEY in (servers as Record<string, unknown>);
    } catch {
        return false;
    }
}

/** Longest `detail` line the skill picker shows per entry. */
const PICKER_DETAIL_LENGTH = 140;

export class AgentConfigurationManager {
    private context: vscode.ExtensionContext;
    // Versioned so the first-run setup re-appears once when it gains a step
    // (v2: Claude Code + Claude Desktop agents; v3: the agent-skills step).
    private readonly POPUP_SHOWN_KEY = 'cmsis-developer-assistant.popupShown.v3';
    private readonly timeoutInSeconds: number;
    private serverPort: number;
    private catalog: SkillCatalog | null | undefined;
    private readonly skillInstaller: SkillInstaller;
    // Overlapping syncs (activation, a setting change, the picker) are
    // serialised so two of them never stage into the same directory at once.
    private skillSyncChain: Promise<unknown> = Promise.resolve();

    constructor(context: vscode.ExtensionContext, timeoutInSeconds: number, serverPort: number) {
        this.context = context;
        this.timeoutInSeconds = timeoutInSeconds;
        this.serverPort = serverPort;
        const version = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
        this.skillInstaller = new SkillInstaller(context.extensionPath, version, getSkillInstallRoots());
    }

    /**
     * Set the port written into agent configurations.
     *
     * Always the well-known router port, in every window. It used to be
     * whichever port this window's own server managed to bind, so the last
     * window to start overwrote the shared agent config and pointed the agent
     * at an arbitrary window. Now one window serves that port and forwards
     * each call to the window that owns the target, so every window writing
     * the same value is correct and idempotent.
     */
    public updatePort(port: number): void {
        this.serverPort = port;
    }

    /**
     * Check if we should show the post-install popup
     */
    public async shouldShowPopup(): Promise<boolean> {
        if (this.isHostManagedEnvironment()) {
            return false;
        }
        // Check if popup has already been shown
        const popupShown = this.context.globalState.get<boolean>(this.POPUP_SHOWN_KEY, false);
        return !popupShown;
    }

    /**
     * Antigravity / Gemini configure MCP servers themselves, so the setup
     * prompts are noise there — they offer a choice the host has already made.
     */
    private isHostManagedEnvironment(): boolean {
        return process.env.ANTIGRAVITY_ENV === 'true' || Boolean(process.env.GEMINI_HOME);
    }

    private getSettings(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('cmsis-developer-assistant');
    }

    /** `aiSkills.enabled`: whether the cmsis-agent pack and its routers are installed at all. */
    private isSkillsPackEnabled(): boolean {
        return this.getSettings().get<boolean>(AI_SKILLS_ENABLED_SETTING, true);
    }

    /** `aiSkills.promptOnDetect`: whether registered agents' users get the monthly install nudge. */
    private isSkillPromptEnabled(): boolean {
        return this.getSettings().get<boolean>(AI_SKILLS_PROMPT_SETTING, true);
    }

    /**
     * The setup flow: step 1 picks the agents to register the MCP server
     * with, step 2 picks the agent skills to install. Shown once on first
     * run and on demand from the *Configure Agents and Skills* command.
     *
     * Dismissing either step counts as an answer — without that the
     * first-run prompt came back on every activation until the user picked
     * something. Both steps stay reachable from the command palette.
     */
    public async runSetupFlow(): Promise<void> {
        try {
            const agents = await this.getSupportedAgents();
            const withSkillsStep = this.isSkillsPackEnabled();
            await this.showAgentSelectionDialog(agents, withSkillsStep ? ' (1/2)' : '');
            if (withSkillsStep) {
                await this.showSkillSelectionDialog();
            } else {
                logger.info(`AI Skills Pack disabled (${AI_SKILLS_ENABLED_SETTING}); skipping the skills step of the setup`);
            }
        } catch (error) {
            console.error('Error running the setup flow:', error);
            vscode.window.showErrorMessage(`Failed to show the CMSIS Developer Assistant setup: ${error}`);
        } finally {
            await this.context.globalState.update(this.POPUP_SHOWN_KEY, true);
        }
    }

    /**
     * Reset popup state (for testing/debugging)
     */
    public async resetPopupState(): Promise<void> {
        await this.context.globalState.update(this.POPUP_SHOWN_KEY, false);
        await this.context.globalState.update(SKILLS_PROMPT_SHOWN_KEY, undefined);
    }

    /**
     * Get cross-platform configuration base path
     */
    private getConfigBasePath(): string {
        const platform = os.platform();
        const userHome = os.homedir();
        
        switch (platform) {
            case 'win32': // Windows
                return process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
            case 'darwin': // MacOS
                return path.join(userHome, 'Library', 'Application Support');
            case 'linux': // Linux
                return process.env.XDG_CONFIG_HOME || path.join(userHome, '.config');
            default:
                // Fallback to Windows-style for unknown platforms
                console.warn(`Unknown platform: ${platform}, using Windows config path`);
                return process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
        }
    }

    private getCodexConfigPath(): string {
        const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        return path.join(codexHome, 'config.toml');
    }

    private getCopilotCliConfigPath(): string {
        const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
        return path.join(copilotHome, 'mcp-config.json');
    }

    /**
     * Claude Code stores user-scoped MCP servers in a top-level `mcpServers`
     * key of ~/.claude.json. The file also holds session history and other
     * state, so it must only ever be merged into, never recreated.
     */
    private getClaudeCodeConfigPath(): string {
        return path.join(os.homedir(), '.claude.json');
    }

    private getClaudeDesktopConfigPath(): string {
        return path.join(this.getConfigBasePath(), 'Claude', 'claude_desktop_config.json');
    }

    /**
     * Get list of supported agents
     */
    private async getSupportedAgents(): Promise<AgentInfo[]> {
        const configBasePath = this.getConfigBasePath();
        const platform = os.platform();

        console.log(`Detected platform: ${platform}, using config base path: ${configBasePath}`);

        const agents: AgentInfo[] = [
            {
                id: 'roo',
                name: 'roo',
                displayName: 'Roo Code',
                configPath: path.join(configBasePath, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'antigravity',
                name: 'antigravity',
                displayName: 'Antigravity',
                configPath: path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'cline',
                name: 'cline',
                displayName: 'Cline',
                configPath: path.join(configBasePath, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            // The GitHub Copilot *extension* in VS Code no longer needs a static
            // mcp.json entry — the extension registers an McpServerDefinitionProvider
            // at activation, which handles dynamic port assignment. The Copilot
            // *CLI* is separate and does still need a static config file.
            {
                id: 'copilot-cli',
                name: 'copilot-cli',
                displayName: 'GitHub Copilot CLI',
                configPath: this.getCopilotCliConfigPath(),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'cursor',
                name: 'cursor',
                displayName: 'Cursor',
                configPath: path.join(configBasePath, 'Cursor', 'User', 'globalStorage', 'cursor.mcp', 'settings', 'mcp_settings.json'),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'codex',
                name: 'codex',
                displayName: 'Codex',
                configPath: this.getCodexConfigPath(),
                configFormat: 'toml'
            },
            {
                id: 'claude-code',
                name: 'claude-code',
                displayName: 'Claude Code',
                configPath: this.getClaudeCodeConfigPath(),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'claude-desktop',
                name: 'claude-desktop',
                displayName: 'Claude Desktop',
                configPath: this.getClaudeDesktopConfigPath(),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            }
        ];

        return agents;
    }

    private getMCPServerUrl(): string {
        return `http://localhost:${this.serverPort}/mcp`;
    }

    /**
     * Write via a temp file + rename so a crash mid-write can never leave a
     * half-written config behind (some of these files, e.g. ~/.claude.json,
     * hold state well beyond MCP entries).
     */
    private async writeFileAtomic(filePath: string, content: string): Promise<void> {
        const tmpPath = `${filePath}.cmsis-developer-assistant.tmp`;
        await fs.promises.writeFile(tmpPath, content, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
    }

    /**
     * Get CMSIS Developer Assistant server configuration with current port and timeout settings.
     * The Copilot CLI expects a `type: 'http'` entry with a `tools` allowlist.
     * Claude Code takes a plain `type: 'http'` entry; Claude Desktop only
     * supports stdio servers, so it gets an `mcp-remote` bridge.
     */
    private getDebugMCPConfig(agent?: AgentInfo): MCPServerConfig {
        if (agent?.id === 'copilot-cli') {
            return {
                type: 'http',
                url: this.getMCPServerUrl(),
                tools: ['*'],
            };
        }

        if (agent?.id === 'claude-code') {
            return {
                type: 'http',
                url: this.getMCPServerUrl(),
            };
        }

        if (agent?.id === 'claude-desktop') {
            return {
                command: 'npx',
                args: ['-y', 'mcp-remote', this.getMCPServerUrl()],
            };
        }

        return {
            autoApprove: [],
            disabled: false,
            timeout: this.timeoutInSeconds,
            type: 'streamableHttp',
            url: this.getMCPServerUrl(),
        };
    }

    /**
     * Migrate existing SSE configurations to streamableHttp
     * This should be called on extension activation to ensure backward compatibility
     */
    public async migrateExistingConfigurations(): Promise<void> {
        const agents = await this.getSupportedAgents();
        let migrationCount = 0;

        for (const agent of agents) {
            try {
                if (!fs.existsSync(agent.configPath)) {
                    continue;
                }

                const configContent = await fs.promises.readFile(agent.configPath, 'utf8');

                if (agent.configFormat === 'toml') {
                    // Rename a legacy [mcp_servers.cmsis-debugmcp] section to the
                    // new key, then refresh a stale /sse endpoint on the new key.
                    const legacy = stripLegacyCodexSection(configContent);
                    let tomlContent = legacy.content;
                    let tomlChanged = legacy.removed;
                    if (legacy.removed || this.shouldMigrateCodexConfig(tomlContent)) {
                        tomlContent = upsertCodexDebugMCPConfig(tomlContent, this.getMCPServerUrl());
                        tomlChanged = true;
                    }
                    if (tomlChanged) {
                        await fs.promises.writeFile(agent.configPath, tomlContent, 'utf8');
                        migrationCount++;
                        console.log(`Successfully migrated ${agent.displayName} configuration`);
                    }
                    continue;
                }

                let config: any;

                try {
                    config = JSON.parse(configContent);
                } catch {
                    continue; // Skip if config can't be parsed
                }

                const fieldName = agent.mcpServerFieldName;
                const servers = config[fieldName];

                // Rename a legacy `cmsis-debugmcp` entry to the new key,
                // carrying its settings, then operate on the new key. This is
                // what stops the rename from orphaning a dead duplicate server
                // in the user's home-directory agent config.
                let renamed = false;
                if (servers && servers[LEGACY_SERVER_KEY]) {
                    if (!servers[SERVER_KEY]) {
                        servers[SERVER_KEY] = servers[LEGACY_SERVER_KEY];
                    }
                    delete servers[LEGACY_SERVER_KEY];
                    renamed = true;
                }

                const debugmcpConfig = servers?.[SERVER_KEY];

                if (!debugmcpConfig) {
                    if (renamed) {
                        await this.writeFileAtomic(agent.configPath, JSON.stringify(config, null, 2));
                        migrationCount++;
                    }
                    continue; // server not configured for this agent
                }

                // Migrate only when the existing entry doesn't match the
                // transport this agent should use: legacy /sse endpoints, or
                // a transport type that differs from the desired one. For
                // agents whose correct type IS 'http' (Copilot CLI, Claude
                // Code) an 'http' entry is current, not legacy.
                const desiredConfig = this.getDebugMCPConfig(agent);
                const isLegacySse =
                    debugmcpConfig.type === 'sse' ||
                    (typeof debugmcpConfig.url === 'string' && debugmcpConfig.url.endsWith('/sse'));
                const isWrongTransport =
                    desiredConfig.type !== undefined &&
                    debugmcpConfig.type !== undefined &&
                    debugmcpConfig.type !== desiredConfig.type;
                // A stale endpoint (e.g. the server fell back to an
                // OS-assigned port) is refreshed silently — the entry would
                // otherwise point at a dead port.
                const isStaleEndpoint =
                    (typeof debugmcpConfig.url === 'string' &&
                        desiredConfig.url !== undefined &&
                        debugmcpConfig.url !== desiredConfig.url) ||
                    (Array.isArray(debugmcpConfig.args) &&
                        desiredConfig.args !== undefined &&
                        JSON.stringify(debugmcpConfig.args) !== JSON.stringify(desiredConfig.args));
                const needsMigration = isLegacySse || isWrongTransport || isStaleEndpoint;

                if (needsMigration || renamed) {
                    if (needsMigration) {
                        console.log(`Migrating server configuration for ${agent.displayName} to the ${desiredConfig.type ?? 'stdio-bridge'} transport`);

                        // Update to new configuration
                        config[fieldName][SERVER_KEY] = desiredConfig;

                        // Preserve any custom autoApprove settings
                        if (debugmcpConfig.autoApprove && Array.isArray(debugmcpConfig.autoApprove)) {
                            config[fieldName][SERVER_KEY].autoApprove = debugmcpConfig.autoApprove;
                        }
                    }

                    // Write the migrated config
                    await this.writeFileAtomic(
                        agent.configPath,
                        JSON.stringify(config, null, 2)
                    );

                    // Count legacy-transport migrations and key renames toward
                    // the user-facing toast; silent endpoint refreshes don't.
                    if (isLegacySse || isWrongTransport || renamed) {
                        migrationCount++;
                    }
                    console.log(`Successfully migrated ${agent.displayName} configuration`);
                }
            } catch (error) {
                console.error(`Error migrating config for ${agent.name}:`, error);
                // Continue with other agents even if one fails
            }
        }

        if (migrationCount > 0) {
            vscode.window.showInformationMessage(
                `CMSIS Developer Assistant: Migrated ${migrationCount} agent configuration(s).`
            );
        }
    }

    /**
     * Whether a Codex config.toml has a stale `cmsis-debugmcp` section still
     * pointing at the deprecated `/sse` endpoint and needs rewriting.
     */
    private shouldMigrateCodexConfig(configContent: string): boolean {
        const normalizedConfigContent = configContent.replace(/\r\n/g, '\n');
        const lines = normalizedConfigContent.split('\n');
        const debugMCPSectionIndex = lines.findIndex(line => isCodexServerSectionHeader(line, SERVER_KEY));

        if (debugMCPSectionIndex === -1) {
            return false;
        }

        const nextSectionIndex = findNextTomlSectionIndex(lines, debugMCPSectionIndex + 1);
        const debugMCPSectionEndIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;

        for (let index = debugMCPSectionIndex + 1; index < debugMCPSectionEndIndex; index++) {
            if (/^\s*url\s*=.*\/sse["']?\s*(?:#.*)?$/.test(lines[index])) {
                return true;
            }
        }

        return false;
    }

    /**
     * Add CMSIS Developer Assistant server configuration to the specified agent's config
     */
    private async addDebugMCPToAgent(agent: AgentInfo): Promise<boolean> {
        try {
            // Ensure the config directory exists
            const configDir = path.dirname(agent.configPath);
            if (!fs.existsSync(configDir)) {
                await fs.promises.mkdir(configDir, { recursive: true });
            }

            // Codex configs are TOML — handled by a dedicated upsert that
            // preserves the rest of the file.
            if (agent.configFormat === 'toml') {
                const existing = fs.existsSync(agent.configPath)
                    ? await fs.promises.readFile(agent.configPath, 'utf8')
                    : '';
                await fs.promises.writeFile(
                    agent.configPath,
                    upsertCodexDebugMCPConfig(existing, this.getMCPServerUrl()),
                    'utf8'
                );
                console.log(`Successfully added CMSIS Developer Assistant configuration to ${agent.name}`);
                return true;
            }

            let config: any = {};

            // Read existing config if it exists
            if (fs.existsSync(agent.configPath)) {
                const configContent = await fs.promises.readFile(agent.configPath, 'utf8');
                try {
                    config = JSON.parse(configContent);
                } catch (parseError) {
                    // Never recreate an unparseable config — files like
                    // ~/.claude.json hold far more than MCP entries, and
                    // replacing them with a fresh object would destroy the
                    // user's state. Bail out and let the user fix the file.
                    console.error(`Existing config for ${agent.name} is not valid JSON — refusing to overwrite it`);
                    vscode.window.showErrorMessage(
                        `Cannot configure ${agent.displayName}: ${agent.configPath} exists but is not valid JSON. ` +
                        'Please fix or remove the file and try again.'
                    );
                    return false;
                }
            }

            // Ensure the correct MCP servers object exists for this agent
            const fieldName = agent.mcpServerFieldName;
            if (!config[fieldName]) {
                config[fieldName] = {};
            }

            // Add or update the server configuration with current settings
            config[fieldName][SERVER_KEY] = this.getDebugMCPConfig(agent);

            // Write the updated config back to file
            await this.writeFileAtomic(
                agent.configPath,
                JSON.stringify(config, null, 2)
            );

            console.log(`Successfully added CMSIS Developer Assistant configuration to ${agent.name}`);
            return true;
        } catch (error) {
            console.error(`Error adding CMSIS Developer Assistant to ${agent.name}:`, error);
            vscode.window.showErrorMessage(`Failed to configure CMSIS Developer Assistant for ${agent.displayName}: ${error}`);
            return false;
        }
    }

    /**
     * Step 1: the agent selection dialog. Resolves once the picker is gone,
     * with `true` when the user accepted a selection (even an empty one).
     */
    private showAgentSelectionDialog(agents: AgentInfo[], stepLabel = ' (1/2)'): Promise<boolean> {
        const items: vscode.QuickPickItem[] = agents.map(agent => ({
            label: `$(add) Configure ${agent.displayName}`,
            description: 'Add CMSIS Developer Assistant server to this agent',
            detail: agent.displayName,
            picked: false,
        }));

        return new Promise<boolean>(resolve => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.title = `CMSIS Developer Assistant Setup${stepLabel} - Choose AI Agents to Configure`;
            quickPick.placeholder = 'Select the AI agents to register the CMSIS Developer Assistant MCP server with (Esc to skip)';
            quickPick.items = items;
            quickPick.canSelectMany = true;
            quickPick.ignoreFocusOut = true;

            let accepted = false;

            quickPick.onDidAccept(async () => {
                accepted = true;
                const selectedItems = quickPick.selectedItems;
                quickPick.hide();

                for (const selectedItem of selectedItems) {
                    const agent = agents.find(a => a.displayName === selectedItem.detail);
                    if (agent) {
                        await this.configureAgent(agent);
                    }
                }
                resolve(true);
            });

            quickPick.onDidHide(() => {
                quickPick.dispose();
                if (!accepted) {
                    resolve(false);
                }
            });
            quickPick.show();
        });
    }

    // ------------------------------------------------------------------
    // Agent skills
    // ------------------------------------------------------------------

    /** The catalog shipped in the VSIX; `null` when it cannot be read. */
    private getCatalog(): SkillCatalog | null {
        if (this.catalog === undefined) {
            try {
                this.catalog = loadSkillCatalog(this.context.extensionPath);
            } catch (error) {
                logger.error('Could not load the bundled skill catalog', error);
                this.catalog = null;
            }
        }
        return this.catalog;
    }

    private getConfiguredSkills(): string[] {
        const configured = this.getSettings().get<string[]>(INSTALLED_SKILLS_SETTING, [...DEFAULT_INSTALLED_SKILLS]);
        return Array.isArray(configured) ? configured.filter((name): name is string => typeof name === 'string') : [];
    }

    /**
     * Bring the personal skills directories in line with the
     * `installedSkills` setting: install the picks (visible) and their
     * dependency closure (hidden from the slash menu), remove what this
     * extension installed earlier and is no longer wanted. Best-effort — a
     * failure is logged, never thrown.
     */
    public syncSkills(reason: string): Promise<SkillSyncReport | null> {
        const run = async (): Promise<SkillSyncReport | null> => {
            const catalog = this.getCatalog();
            if (!catalog) {
                return null;
            }
            const packEnabled = this.isSkillsPackEnabled();
            const desired = resolveDesiredSkills(catalog, this.getConfiguredSkills(), { packEnabled });
            if (desired.unknown.length > 0) {
                logger.warn(`Ignoring unknown skills in the ${INSTALLED_SKILLS_SETTING} setting: ${desired.unknown.join(', ')}`);
            }
            if (desired.suppressed.length > 0) {
                logger.info(`AI Skills Pack disabled (${AI_SKILLS_ENABLED_SETTING}); not installing the selected [${desired.suppressed.join(', ')}]`);
            }
            const report = await this.skillInstaller.sync(catalog, desired.explicit, desired.implied);
            logger.info(`Agent skills synced (${reason}, pack ${packEnabled ? 'enabled' : 'disabled'}): ${summarizeSkillSync(report)}; ` +
                `visible [${desired.explicit.join(', ')}], hidden [${desired.implied.join(', ')}]`);
            for (const failure of report.failed) {
                logger.warn(`Skill ${failure.name ?? '(root)'} at ${failure.root}: ${failure.error}`);
            }
            for (const foreign of report.skippedForeign) {
                logger.warn(`Skill ${foreign.name} at ${foreign.root} was not installed by this extension; left untouched`);
            }
            return report;
        };
        const next = this.skillSyncChain.then(run, run);
        this.skillSyncChain = next.catch(() => undefined);
        return next;
    }

    /**
     * Step 2: the skill picker. Entries are grouped by category with the
     * category's router skill first — picking the router gives the agent one
     * slash command for the whole category and installs the members hidden.
     * The bundled skills are always installed and are not offered as choices.
     * Resolves with `true` when the user accepted.
     */
    public async showSkillSelectionDialog(): Promise<boolean> {
        const catalog = this.getCatalog();
        if (!catalog) {
            vscode.window.showErrorMessage('CMSIS Developer Assistant: the bundled skill catalog could not be loaded.');
            return false;
        }
        if (!this.isSkillsPackEnabled()) {
            const enable = 'Enable and Select';
            const choice = await vscode.window.showInformationMessage(
                `CMSIS Developer Assistant: the AI Skills Pack is disabled (setting cmsis-developer-assistant.${AI_SKILLS_ENABLED_SETTING}); ` +
                'only the extension\'s own skills are installed.',
                enable);
            if (choice !== enable) {
                return false;
            }
            await this.getSettings().update(AI_SKILLS_ENABLED_SETTING, true, vscode.ConfigurationTarget.Global);
        }

        type SkillItem = vscode.QuickPickItem & { entry?: SkillCatalogEntry };
        const byName = new Map(catalog.skills.map(entry => [entry.name, entry]));
        const current = new Set(resolveDesiredSkills(catalog, this.getConfiguredSkills()).explicit);
        const items: SkillItem[] = [];

        for (const [category, entries] of groupByCategory(catalog)) {
            const offered = entries.filter(entry => !isBundledSkill(entry));
            if (offered.length === 0) {
                continue;
            }
            items.push({ label: SKILL_CATEGORY_LABELS[category], kind: vscode.QuickPickItemKind.Separator });
            for (const entry of offered) {
                const dependencies = entry.dependsOn.filter(name => byName.has(name));
                const isRouter = entry.kind === 'router';
                const summary = truncate(entry.shortDescription ?? entry.description, PICKER_DETAIL_LENGTH);
                items.push({
                    label: `${isRouter ? '$(list-tree) ' : ''}${entry.displayName ?? entry.name}`,
                    description: isRouter
                        ? `/${entry.name} — one command for the whole category, ${dependencies.length} member skills installed hidden`
                        : `/${entry.name}`,
                    detail: dependencies.length > 0 && !isRouter
                        ? `${summary}  ·  also installs (hidden): ${dependencies.join(', ')}`
                        : summary,
                    picked: current.has(entry.name),
                    entry,
                });
            }
        }

        return new Promise<boolean>(resolve => {
            const quickPick = vscode.window.createQuickPick<SkillItem>();
            quickPick.title = 'CMSIS Developer Assistant Setup (2/2) - Choose Agent Skills to Install';
            quickPick.placeholder = 'Select the AI Skills Pack skills to install into your personal skills directories ' +
                `(always installed: ${bundledSkillNames(catalog).join(', ')}; Esc keeps the current selection)`;
            quickPick.items = items;
            quickPick.selectedItems = items.filter(item => item.picked);
            quickPick.canSelectMany = true;
            quickPick.ignoreFocusOut = true;
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;

            let accepted = false;

            quickPick.onDidAccept(async () => {
                accepted = true;
                const explicit = quickPick.selectedItems
                    .map(item => item.entry?.name)
                    .filter((name): name is string => typeof name === 'string');
                quickPick.hide();

                try {
                    await this.getSettings().update(INSTALLED_SKILLS_SETTING, explicit, vscode.ConfigurationTarget.Global);
                    // The configuration-change listener syncs too; running it
                    // here as well makes the toast below reflect the result.
                    const report = await this.syncSkills('selection');
                    const desired = resolveDesiredSkills(catalog, explicit);
                    if (report) {
                        const roots = [...new Set(report.installed.map(record => record.root))];
                        const where = roots.length > 0 ? ` into ${roots.map(shortenHome).join(', ')}` : '';
                        vscode.window.showInformationMessage(
                            `CMSIS Developer Assistant: ${desired.explicit.length} skill(s)` +
                            (desired.implied.length > 0 ? ` (+${desired.implied.length} required, hidden)` : '') +
                            ` installed${where}; ${report.removed.length} removed.` +
                            (report.failed.length > 0 ? ` ${report.failed.length} failed — see the output log.` : ''));
                    }
                } catch (error) {
                    logger.error('Error saving the skill selection', error);
                    vscode.window.showErrorMessage(`Failed to save the skill selection: ${error}`);
                }
                resolve(true);
            });

            quickPick.onDidHide(() => {
                quickPick.dispose();
                if (!accepted) {
                    resolve(false);
                }
            });
            quickPick.show();
        });
    }

    /**
     * The monthly nudge: when an agent has the MCP server registered but no
     * pack skill was ever picked, offer the skill picker — at most once per
     * 30 days, never while the first-run flow is still pending (it asks the
     * same question), never with the pack disabled. The decision itself is
     * pure and tested (`decideSkillPrompt`); this gathers its inputs and
     * shows the toast.
     */
    public async maybePromptForSkills(now: number = Date.now()): Promise<void> {
        const catalog = this.getCatalog();
        if (!catalog) {
            return;
        }
        const agents = await this.getAgentsWithServer();
        const agentNames = agents.map(agent => agent.displayName);
        const decision = decideSkillPrompt({
            promptEnabled: this.isSkillPromptEnabled(),
            packEnabled: this.isSkillsPackEnabled(),
            firstRunPending: !this.context.globalState.get<boolean>(this.POPUP_SHOWN_KEY, false),
            hostManaged: this.isHostManagedEnvironment(),
            agentsWithServer: agentNames,
            packSkillSelected: hasPackSkillSelected(catalog, this.getConfiguredSkills()),
            lastShownAt: this.context.globalState.get<number>(SKILLS_PROMPT_SHOWN_KEY),
            now,
        });
        if (!decision.show) {
            logger.info(`Skill install prompt not shown: ${decision.reason}`);
            return;
        }

        // Recorded before the toast, so a dismissal — or a second window
        // racing this one — counts as shown.
        await this.context.globalState.update(SKILLS_PROMPT_SHOWN_KEY, now);
        const choice = await vscode.window.showInformationMessage(
            skillPromptMessage(agentNames),
            SKILL_PROMPT_BUTTONS.select,
            SKILL_PROMPT_BUTTONS.later,
            SKILL_PROMPT_BUTTONS.never,
        );
        if (choice === SKILL_PROMPT_BUTTONS.select) {
            await this.showSkillSelectionDialog();
        } else if (choice === SKILL_PROMPT_BUTTONS.never) {
            await this.getSettings().update(AI_SKILLS_PROMPT_SETTING, false, vscode.ConfigurationTarget.Global);
        }
    }

    /**
     * The supported agents whose config file currently registers this
     * server. Read-only; a missing or unreadable file just means "no".
     */
    private async getAgentsWithServer(): Promise<AgentInfo[]> {
        const found: AgentInfo[] = [];
        for (const agent of await this.getSupportedAgents()) {
            try {
                if (!fs.existsSync(agent.configPath)) {
                    continue;
                }
                const content = await fs.promises.readFile(agent.configPath, 'utf8');
                if (agentConfigHasServer(agent, content)) {
                    found.push(agent);
                }
            } catch (error) {
                logger.warn(`Could not read the ${agent.displayName} configuration at ${agent.configPath}: ${String(error)}`);
            }
        }
        return found;
    }

    /**
     * Configure a specific agent with CMSIS Developer Assistant
     */
    private async configureAgent(agent: AgentInfo): Promise<void> {
        try {
            const success = await this.addDebugMCPToAgent(agent);

            if (success) {
                const openConfigButton = 'Open Config';
                const result = await vscode.window.showInformationMessage(
                    `✅ CMSIS Developer Assistant successfully configured for ${agent.displayName}`,
                    openConfigButton
                );

                if (result === openConfigButton) {
                    // Open the config file in VSCode
                    const configUri = vscode.Uri.file(agent.configPath);
                    await vscode.commands.executeCommand('vscode.open', configUri);
                }
            }
        } catch (error) {
            console.error(`Error configuring ${agent.name}:`, error);
            vscode.window.showErrorMessage(`Failed to configure ${agent.displayName}: ${error}`);
        }
    }

}

function truncate(text: string, length: number): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length <= length ? oneLine : `${oneLine.slice(0, length - 1).trimEnd()}…`;
}

function shortenHome(directory: string): string {
    const home = os.homedir();
    return directory.startsWith(home) ? `~${directory.slice(home.length)}` : directory;
}
