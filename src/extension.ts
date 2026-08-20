// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as vscode from 'vscode';
import { SERVER_VERSION } from './debuggingExecutor';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { clearSvdCache } from './core/svdParser';
import { logger } from './utils/logger';
import { registerSessionStateTracker } from './utils/sessionStateTracker';
import { WindowCoordinator } from './windowCoordinator';

let coordinator: WindowCoordinator | null = null;
let agentConfigManager: AgentConfigurationManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize logging first
    logger.info('CMSIS Developer Assistant extension is now active!');
    logger.logSystemInfo();

    const config = vscode.workspace.getConfiguration('cmsis-developer-assistant');
    const timeoutInSeconds = config.get<number>('timeoutInSeconds', 60);
    const serverPort = config.get<number>('serverPort', 3001);
    const dapRequestTimeoutMs = config.get<number>('dapRequestTimeoutMs', 10000);
    const memoryReadTimeoutMs = config.get<number>('memoryReadTimeoutMs', 30000);

    logger.info(`Using timeoutInSeconds: ${timeoutInSeconds} seconds`);
    logger.info(`Using serverPort: ${serverPort}`);
    logger.info(`Using dapRequestTimeoutMs: ${dapRequestTimeoutMs} ms`);
    logger.info(`Using memoryReadTimeoutMs: ${memoryReadTimeoutMs} ms`);

    // Track DAP stopped/continued events so we can answer "is the target
    // currently paused?" reliably, regardless of what activeStackItem says.
    registerSessionStateTracker(context);

    // Drop the parsed-SVD cache when a debug session ends — the next session
    // may target a different device, and the module-level cache in svdParser
    // has no other invalidation path.
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession(() => clearSvdCache()),
    );

    // Initialize Agent Configuration Manager
    agentConfigManager = new AgentConfigurationManager(context, timeoutInSeconds, serverPort);

    // Put the bundled agent skill where skills-aware harnesses look for it.
    // Done here rather than only on agent registration: the skill is
    // agent-independent, and a user who registered their agents in an earlier
    // release never opens that dialog again — so gating it there meant every
    // upgrading user silently got no skill.
    try {
        const skillPath = await agentConfigManager.installCmsisDebugSkill();
        logger.info(skillPath
            ? `Installed the cmsis-debug-live agent skill at ${skillPath}`
            : 'No agent skill was installed (bundle missing or skills dir unwritable)');
    } catch (error) {
        logger.error('Error installing the agent skill', error);
    }

    // Start this window's coordinator: it always runs a control server and
    // publishes the window to the shared registry, then tries to claim the
    // well-known port. Exactly one window wins and serves MCP; the rest execute
    // work forwarded to them.
    try {
        logger.info('Starting CMSIS Developer Assistant window coordinator...');

        coordinator = new WindowCoordinator({
            port: serverPort,
            timeoutInSeconds,
            hardwareTimeouts: {
                dapRequestMs: dapRequestTimeoutMs,
                memoryReadMs: memoryReadTimeoutMs,
            },
        });
        await coordinator.start(context);

        // Every window advertises the *router's* endpoint, never its own
        // control port. That is the whole point: agents get one stable URL,
        // and the router forwards each call to the window that owns the
        // target. Writing a per-window port here is what used to send an
        // agent to a window that did not have the board.
        const endpoint = coordinator.getEndpoint();
        agentConfigManager.updatePort(serverPort);

        const role = coordinator.isRouter() ? 'router' : 'worker';
        logger.info(`CMSIS Developer Assistant is up as ${role}; agents should use ${endpoint}`);
        if (coordinator.isRouter()) {
            vscode.window.showInformationMessage(`CMSIS Developer Assistant server running on ${endpoint}`);
        }

        // Register as a VS Code MCP server definition provider so Copilot
        // discovers this server without a static mcp.json entry (which
        // causes race conditions on startup). Workers point at the router too,
        // so in-window Copilot routes exactly like an external agent.
        const mcpUri = vscode.Uri.parse(`${endpoint}/mcp`);
        context.subscriptions.push(
            vscode.lm.registerMcpServerDefinitionProvider('cmsis-developer-assistant', {
                provideMcpServerDefinitions() {
                    return [
                        new vscode.McpHttpServerDefinition(
                            'CMSIS Developer Assistant',
                            mcpUri,
                            undefined,
                            SERVER_VERSION,
                        ),
                    ];
                },
            }),
        );
        logger.info('Registered MCP server definition provider for VS Code');
    } catch (error) {
        logger.error('Failed to initialize MCP server', error);
        vscode.window.showErrorMessage(`Failed to initialize MCP server: ${error}`);
    }

    // Migrate existing SSE configurations to streamableHttp (for backward compatibility)
    // This only applies to third-party agents (Cline, Cursor) — Copilot uses
    // the native McpServerDefinitionProvider registered above.
    try {
        await agentConfigManager.migrateExistingConfigurations();
    } catch (error) {
        logger.error('Error migrating existing configurations', error);
    }

    // Changing the port has no effect until the server is rebuilt, and the
    // agent configs still point at the old one. Tell the user rather than
    // leaving them with a setting that silently does nothing.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (!event.affectsConfiguration('cmsis-developer-assistant.serverPort')) {
                return;
            }
            const reload = 'Reload Window';
            const choice = await vscode.window.showInformationMessage(
                'CMSIS Developer Assistant: the server port setting changed. Reload the window to restart the MCP server on the new port.',
                reload,
            );
            if (choice === reload) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
    );

    // Register commands
    registerCommands(context);

    // Show post-install popup if needed (with slight delay to allow VS Code to fully load)
    setTimeout(async () => {
        try {
            if (agentConfigManager && await agentConfigManager.shouldShowPopup()) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        } catch (error) {
            logger.error('Error showing post-install popup', error);
        }
    }, 2000);

    logger.info('CMSIS Developer Assistant extension activated successfully');
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Command to manually configure CMSIS Developer Assistant for agents
    const configureAgentsCommand = vscode.commands.registerCommand(
        'cmsis-developer-assistant.configureAgents',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showManualConfiguration();
            }
        }
    );

    // Command to show agent selection popup again
    const showPopupCommand = vscode.commands.registerCommand(
        'cmsis-developer-assistant.showAgentSelectionPopup',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        }
    );

    // Command to reset popup state (for development/testing)
    const resetPopupCommand = vscode.commands.registerCommand(
        'cmsis-developer-assistant.resetPopupState',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.resetPopupState();
                vscode.window.showInformationMessage('CMSIS Developer Assistant popup state has been reset.');
            }
        }
    );

    context.subscriptions.push(
        configureAgentsCommand,
        showPopupCommand,
        resetPopupCommand
        );
}

export async function deactivate() {
    logger.info('CMSIS Developer Assistant extension deactivating...');

    // Awaited, unlike before: the coordinator has to remove this window from
    // the shared registry before the host goes away, or other windows keep
    // forwarding to a dead control port until the entry goes stale.
    if (coordinator) {
        await coordinator.dispose().catch(error => {
            logger.error('Error stopping CMSIS Developer Assistant window coordinator', error);
        });
        coordinator = null;
    }

    logger.info('CMSIS Developer Assistant extension deactivated');
}
