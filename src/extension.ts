// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as vscode from 'vscode';
import * as path from 'path';
import { SERVER_VERSION } from './debuggingExecutor';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { clearSvdCache } from './core/svdParser';
import { logger } from './utils/logger';
import { registerSessionStateTracker } from './utils/sessionStateTracker';
import { WindowCoordinator } from './windowCoordinator';
import { createPackDocsHandlers, readPackDocsGates } from './packDocsHost';
import { registerPackDocsCommands } from './packDocsCommands';

let coordinator: WindowCoordinator | null = null;
let agentConfigManager: AgentConfigurationManager | null = null;

/**
 * Where the tool-telemetry JSONL goes: empty means off, an absolute path is
 * used as given, a relative one lives in the first workspace folder (and is
 * off when there is none — a bare relative path in an empty window would land
 * wherever the extension host happens to run).
 */
function resolveTelemetryPath(setting: string): string | undefined {
    const trimmed = setting.trim();
    if (!trimmed) { return undefined; }
    if (path.isAbsolute(trimmed)) { return trimmed; }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        logger.warn(`telemetry.jsonlPath "${trimmed}" is relative and no workspace folder is open; telemetry file is off`);
        return undefined;
    }
    return path.join(root, trimmed);
}

export async function activate(context: vscode.ExtensionContext) {
    // Initialize logging first
    logger.info('CMSIS Developer Assistant extension is now active!');
    logger.logSystemInfo();

    const config = vscode.workspace.getConfiguration('cmsis-developer-assistant');
    const timeoutInSeconds = config.get<number>('timeoutInSeconds', 60);
    const serverPort = config.get<number>('serverPort', 3001);
    const dapRequestTimeoutMs = config.get<number>('dapRequestTimeoutMs', 10000);
    const memoryReadTimeoutMs = config.get<number>('memoryReadTimeoutMs', 30000);
    const telemetryJsonlPath = resolveTelemetryPath(config.get<string>('telemetry.jsonlPath', ''));
    const serialEnabled = config.get<boolean>('serial.enabled', true);
    const { packDocsEnabled, buildInfoEnabled } = readPackDocsGates();

    logger.info(`Using timeoutInSeconds: ${timeoutInSeconds} seconds`);
    logger.info(`Using serverPort: ${serverPort}`);
    logger.info(`Using dapRequestTimeoutMs: ${dapRequestTimeoutMs} ms`);
    logger.info(`Using memoryReadTimeoutMs: ${memoryReadTimeoutMs} ms`);
    if (telemetryJsonlPath) {
        logger.info(`Tool telemetry JSONL: ${telemetryJsonlPath}`);
    }
    if (!serialEnabled) {
        logger.info('Serial tools are disabled (cmsis-developer-assistant.serial.enabled)');
    }
    logger.info(`Documentation tools ${packDocsEnabled ? 'enabled' : 'disabled'} (cmsis-developer-assistant.packDocs.enabled), ` +
        `build-artefact tools ${buildInfoEnabled ? 'enabled' : 'disabled'} (cmsis-developer-assistant.buildInfo.enabled)`);

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

    // Put the selected agent skills where skills-aware harnesses look for
    // them. Done on every activation, not only from the setup dialog: the
    // selection lives in a setting, so it has to be applied on a machine that
    // received it via Settings Sync and after an upgrade that changed the
    // bundled content — neither of which reopens the dialog.
    try {
        await agentConfigManager.syncSkills('activation');
    } catch (error) {
        logger.error('Error installing agent skills', error);
    }

    // Start this window's coordinator: it always runs a control server and
    // publishes the window to the shared registry, then tries to claim the
    // well-known port. Exactly one window wins and serves MCP; the rest execute
    // work forwarded to them.
    //
    // The documentation / build-artefact handlers exist in every window (the
    // commands use them, and a forwarded op must find them on the worker);
    // the two gates only decide whether the router offers the tools.
    const packDocs = createPackDocsHandlers(context, timeoutInSeconds);
    registerPackDocsCommands(context, packDocs);
    if (vscode.extensions.getExtension('arm.cmsis-pack-docs')) {
        const message = 'CMSIS Developer Assistant: the experimental "CMSIS Pack Docs" extension is also installed. Its ' +
            'tools are now built into this extension (settings cmsis-developer-assistant.packDocs.enabled / ' +
            'buildInfo.enabled); uninstall it so agents do not see the same tool names twice.';
        logger.warn(message);
        void vscode.window.showWarningMessage(message);
    }

    try {
        logger.info('Starting CMSIS Developer Assistant window coordinator...');

        coordinator = new WindowCoordinator({
            port: serverPort,
            timeoutInSeconds,
            hardwareTimeouts: {
                dapRequestMs: dapRequestTimeoutMs,
                memoryReadMs: memoryReadTimeoutMs,
            },
            serverOptions: {
                serialEnabled,
                packDocsEnabled,
                buildInfoEnabled,
                telemetry: { jsonlPath: telemetryJsonlPath },
            },
            packDocs,
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
            // The skill selection is applied live — whether it changed in the
            // picker, in settings.json, or arrived through Settings Sync.
            // Toggling the pack re-syncs too: off removes the pack skills this
            // extension installed, on brings the kept selection back.
            if ((event.affectsConfiguration('cmsis-developer-assistant.installedSkills') ||
                event.affectsConfiguration('cmsis-developer-assistant.aiSkills.enabled')) && agentConfigManager) {
                await agentConfigManager.syncSkills('setting changed');
            }
            // Documentation settings are re-read per call; only the handler's
            // cached extractor selection needs a nudge.
            if (event.affectsConfiguration('cmsis-developer-assistant.packDocs')) {
                packDocs.docs.refreshSettings();
            }
            const portChanged = event.affectsConfiguration('cmsis-developer-assistant.serverPort');
            const gateChanged = event.affectsConfiguration('cmsis-developer-assistant.packDocs.enabled') ||
                event.affectsConfiguration('cmsis-developer-assistant.buildInfo.enabled');
            if (!portChanged && !gateChanged) {
                return;
            }
            const reload = 'Reload Window';
            const choice = await vscode.window.showInformationMessage(
                portChanged
                    ? 'CMSIS Developer Assistant: the server port setting changed. Reload the window to restart the MCP server on the new port.'
                    : 'CMSIS Developer Assistant: the documentation / build-artefact tool setting changed. Reload the window so the next agent connection sees the new tool list.',
                reload,
            );
            if (choice === reload) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
    );

    // Register commands
    registerCommands(context);

    // Show the first-run setup if needed (with slight delay to allow VS Code
    // to fully load). Once that has been answered, the monthly nudge takes its
    // place: agents that have the server registered but no pack skill picked.
    setTimeout(async () => {
        try {
            if (!agentConfigManager) {
                return;
            }
            if (await agentConfigManager.shouldShowPopup()) {
                await agentConfigManager.runSetupFlow();
            } else {
                await agentConfigManager.maybePromptForSkills();
            }
        } catch (error) {
            logger.error('Error showing the setup or skill prompt', error);
        }
    }, 2000);

    logger.info('CMSIS Developer Assistant extension activated successfully');
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // The two-step setup: agents to register the MCP server with, then the
    // agent skills to install. Same flow as the first-run prompt.
    const configureCommand = vscode.commands.registerCommand(
        'cmsis-developer-assistant.configure',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.runSetupFlow();
            }
        }
    );

    // Just the skills step.
    const selectSkillsCommand = vscode.commands.registerCommand(
        'cmsis-developer-assistant.selectSkills',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showSkillSelectionDialog();
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
        configureCommand,
        selectSkillsCommand,
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
