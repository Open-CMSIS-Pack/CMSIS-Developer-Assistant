// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
 * Insert or update the `[mcp_servers.cmsis-debugmcp]` block in a Codex
 * `config.toml`, preserving the rest of the file. Codex configs are TOML,
 * not JSON, so they cannot go through the generic JSON path.
 */
export function upsertCodexDebugMCPConfig(configContent: string, mcpServerUrl: string): string {
    const normalizedConfigContent = configContent.replace(/\r\n/g, '\n');
    const lines = normalizedConfigContent.split('\n');
    const escapedUrl = escapeTomlString(mcpServerUrl);
    const debugMCPSectionIndex = lines.findIndex(line => isCodexDebugMCPSectionHeader(line));

    if (debugMCPSectionIndex === -1) {
        const separator = normalizedConfigContent.length === 0
            ? ''
            : normalizedConfigContent.endsWith('\n') ? '\n' : '\n\n';
        return `${normalizedConfigContent}${separator}[mcp_servers.cmsis-debugmcp]\nurl = "${escapedUrl}"\n`;
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

function isCodexDebugMCPSectionHeader(line: string): boolean {
    return /^\s*\[mcp_servers\.cmsis-debugmcp\]\s*(?:#.*)?$/.test(line);
}

/**
 * Directory name of the bundled Agent Skill, under `skills/` in the extension
 * and under the personal skills directories once installed.
 *
 * Not upstream's `debug-live`: both extensions can be installed at once, and
 * they would otherwise fight over the same directory — leaving whichever
 * registered last in place, with a workflow written for the wrong kind of
 * target. For the same reason no legacy-name cleanup is done here; removing a
 * `debug-live` directory would delete upstream's skill.
 */
const SKILL_NAME = 'cmsis-debug-live';

export class AgentConfigurationManager {
    private context: vscode.ExtensionContext;
    // Versioned so the popup re-appears once when new agents are added to
    // the roster (v2: Claude Code + Claude Desktop).
    private readonly POPUP_SHOWN_KEY = 'cmsis-debugmcp.popupShown.v2';
    private readonly timeoutInSeconds: number;
    private serverPort: number;
    

    constructor(context: vscode.ExtensionContext, timeoutInSeconds: number, serverPort: number) {
        this.context = context;
        this.timeoutInSeconds = timeoutInSeconds;
        this.serverPort = serverPort;
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
        // Antigravity / Gemini configure MCP servers themselves, so the
        // selection popup is noise there — it offers a choice the host has
        // already made.
        if (process.env.ANTIGRAVITY_ENV === 'true' || process.env.GEMINI_HOME) {
            return false;
        }
        // Check if popup has already been shown
        const popupShown = this.context.globalState.get<boolean>(this.POPUP_SHOWN_KEY, false);
        return !popupShown;
    }

    /**
     * Show the agent selection popup
     */
    public async showAgentSelectionPopup(): Promise<void> {
        try {
            const agents = await this.getSupportedAgents();

            // Show selection popup for all agents
            await this.showAgentSelectionDialog(agents);
            
        } catch (error) {
            console.error('Error showing agent selection popup:', error);
            vscode.window.showErrorMessage(`Failed to show agent selection popup: ${error}`);
        }
    }

    /**
     * Reset popup state (for testing/debugging)
     */
    public async resetPopupState(): Promise<void> {
        await this.context.globalState.update(this.POPUP_SHOWN_KEY, false);
    }

    /**
     * Show manual configuration options via command palette
     */
    public async showManualConfiguration(): Promise<void> {
        const agents = await this.getSupportedAgents();

        const items: vscode.QuickPickItem[] = agents.map(agent => ({
            label: agent.displayName,
            description: 'Configure CMSIS-DebugMCP for this agent',
            detail: `Add CMSIS-DebugMCP server configuration to ${agent.displayName}`
        }));

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Configure CMSIS-DebugMCP for AI Agent',
            placeHolder: 'Select an AI agent to configure with CMSIS-DebugMCP'
        });

        if (selected) {
            const agent = agents.find(a => a.displayName === selected.label);
            if (agent) {
                await this.configureAgent(agent);
            }
        }
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
        const tmpPath = `${filePath}.cmsis-debugmcp.tmp`;
        await fs.promises.writeFile(tmpPath, content, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
    }

    /**
     * Get CMSIS-DebugMCP server configuration with current port and timeout settings.
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
                    if (this.shouldMigrateCodexConfig(configContent)) {
                        await fs.promises.writeFile(
                            agent.configPath,
                            upsertCodexDebugMCPConfig(configContent, this.getMCPServerUrl()),
                            'utf8'
                        );
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
                const debugmcpConfig = config[fieldName]?.['cmsis-debugmcp'];

                if (!debugmcpConfig) {
                    continue; // CMSIS-DebugMCP not configured for this agent
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

                if (needsMigration) {
                    console.log(`Migrating CMSIS-DebugMCP configuration for ${agent.displayName} to the ${desiredConfig.type ?? 'stdio-bridge'} transport`);

                    // Update to new configuration
                    config[fieldName]['cmsis-debugmcp'] = desiredConfig;

                    // Preserve any custom autoApprove settings
                    if (debugmcpConfig.autoApprove && Array.isArray(debugmcpConfig.autoApprove)) {
                        config[fieldName]['cmsis-debugmcp'].autoApprove = debugmcpConfig.autoApprove;
                    }
                    
                    // Write the migrated config
                    await this.writeFileAtomic(
                        agent.configPath,
                        JSON.stringify(config, null, 2)
                    );
                    
                    // Only legacy-transport migrations get counted toward the
                    // user-facing toast; silent endpoint refreshes don't.
                    if (isLegacySse || isWrongTransport) {
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
                `CMSIS-DebugMCP: Migrated ${migrationCount} agent configuration(s) to use the new transport protocol.`
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
        const debugMCPSectionIndex = lines.findIndex(line => isCodexDebugMCPSectionHeader(line));

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
     * Add CMSIS-DebugMCP server configuration to the specified agent's config
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
                console.log(`Successfully added CMSIS-DebugMCP configuration to ${agent.name}`);
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

            // Add or update CMSIS-DebugMCP configuration with current settings
            config[fieldName]['cmsis-debugmcp'] = this.getDebugMCPConfig(agent);

            // Write the updated config back to file
            await this.writeFileAtomic(
                agent.configPath,
                JSON.stringify(config, null, 2)
            );

            console.log(`Successfully added CMSIS-DebugMCP configuration to ${agent.name}`);
            return true;
        } catch (error) {
            console.error(`Error adding CMSIS-DebugMCP to ${agent.name}:`, error);
            vscode.window.showErrorMessage(`Failed to configure CMSIS-DebugMCP for ${agent.displayName}: ${error}`);
            return false;
        }
    }

    /** Show the actual agent selection dialog */
    private async showAgentSelectionDialog(agents: AgentInfo[]): Promise<void> {
        const items: vscode.QuickPickItem[] = [];

        // Add all agents as selectable items
        agents.forEach(agent => {
            items.push({
                label: `$(add) Configure ${agent.displayName}`,
                description: 'Add CMSIS-DebugMCP server to this agent',
                detail: agent.displayName,
                picked: false
            });
        });


        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'CMSIS-DebugMCP Setup - Choose AI Agent to Configure';
        quickPick.placeholder = 'Select an AI agent to configure with CMSIS-DebugMCP';
        quickPick.items = items;
        quickPick.canSelectMany = true;
        quickPick.ignoreFocusOut = true;

        quickPick.onDidAccept(async () => {
            const selectedItems = quickPick.selectedItems;
            quickPick.hide();

            // Configure all selected agents
            for (const selectedItem of selectedItems) {
                if (selectedItem && selectedItem.label.includes('Configure')) {
                    // User selected an agent to configure
                    const agentDisplayName = selectedItem.detail;
                    const agent = agents.find(a => a.displayName === agentDisplayName);
                    
                    if (agent) {
                        await this.configureAgent(agent);
                    }
                }
            }
            
            // Mark popup as shown after user interacts with it
            await this.context.globalState.update(this.POPUP_SHOWN_KEY, true);
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
    }

    /**
     * Configure a specific agent with CMSIS-DebugMCP
     */
    private async configureAgent(agent: AgentInfo): Promise<void> {
        try {
            const success = await this.addDebugMCPToAgent(agent);

            if (success) {
                // The skill is agent-independent — one shared location per the
                // Agent Skills standard — but registering an agent is the point
                // at which the user has said they want to use this, so it is
                // also the right moment to put the skill where that agent will
                // find it. Best-effort: a skill that fails to install must not
                // fail the registration.
                const skillPath = await this.installCmsisDebugSkill();

                const openConfigButton = 'Open Config';
                const result = await vscode.window.showInformationMessage(
                    `✅ CMSIS-DebugMCP successfully configured for ${agent.displayName}` +
                    (skillPath ? ' (skill /cmsis-debug-live installed)' : ''),
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

    /**
     * Where the bundled skill gets installed, per the Agent Skills open
     * standard (agentskills.io). `~/.agents/skills/` is the cross-agent
     * location skills-compatible harnesses honour; `~/.copilot/skills/` is
     * added when a Copilot home exists.
     */
    private getSkillInstallTargets(): string[] {
        const home = os.homedir();
        const targets = [path.join(home, '.agents', 'skills', SKILL_NAME)];
        const copilotHome = process.env.COPILOT_HOME || path.join(home, '.copilot');
        if (fs.existsSync(copilotHome)) {
            targets.push(path.join(copilotHome, 'skills', SKILL_NAME));
        }
        return targets;
    }

    /** The skill directory shipped inside the extension. */
    private getBundledSkillPath(): string {
        return path.join(this.context.extensionPath, 'skills', SKILL_NAME);
    }

    /**
     * Copy the bundled skill into the standard personal skills directories.
     *
     * Called on every activation, not just on agent registration. The skill is
     * agent-independent — it lives in one shared location per the Agent Skills
     * standard — so gating it on "the user picked an agent from the popup"
     * meant an existing user upgrading the extension never received it: they
     * already registered their agents releases ago and never open that dialog
     * again.
     *
     * Overwrites unconditionally so the skill tracks the installed extension
     * version rather than drifting behind it. It is five files, ~24 KB.
     *
     * Returns the primary destination, or null when nothing was installed.
     * Every failure is logged and skipped: not being able to write a skill file
     * must never take activation (or an agent registration) down with it.
     */
    public async installCmsisDebugSkill(): Promise<string | null> {
        const bundledSkillPath = this.getBundledSkillPath();

        if (!fs.existsSync(bundledSkillPath)) {
            console.warn(`Bundled skill not found at ${bundledSkillPath}; skipping skill install`);
            return null;
        }

        let primaryDestination: string | null = null;
        for (const destination of this.getSkillInstallTargets()) {
            const skillsDir = path.dirname(destination);
            try {
                await fs.promises.mkdir(skillsDir, { recursive: true });
                await fs.promises.cp(bundledSkillPath, destination, { recursive: true, force: true });
                console.log(`Installed ${SKILL_NAME} skill at ${destination}`);
                if (!primaryDestination) {
                    primaryDestination = destination;
                }
            } catch (error) {
                console.warn(`Failed to install ${SKILL_NAME} skill at ${destination}:`, error);
            }
        }

        return primaryDestination;
    }
}
