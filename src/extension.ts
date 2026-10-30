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
 * The VS Code entry point (`main` in package.json, bundled by esbuild.js).
 *
 * `activate` wires the modules together in a fixed order: settings read once
 * for this activation, the problem journal's output mirror, error sink and
 * copy command (#48), the debug-session and CMSIS task trackers, the extension
 * context for the Serial Monitor bridge (its `getApi` requires one), the agent and skill
 * manager, the documentation handlers and their commands, this window's
 * `WindowCoordinator` (the MCP router or a worker), the MCP server definition
 * for in-editor Copilot, agent-configuration migration, the update of the tool
 * rules recorded in agents' rule files, the settings listener, the agent
 * commands, Select Target Window, the serial port's status-bar item and
 * Release Serial Port (#49), and the first-run setup two seconds later.
 * `deactivate` shuts the coordinator down so
 * the window leaves the shared registry before the host exits.
 *
 * Under the extension test runner (`npm test`) the suites exercise the modules
 * themselves, and activation leaves the developer's machine alone: no skills
 * written into their home directory, no agent configuration or rule file
 * rewritten, no prompt, and no router or worker beside their own VS Code
 * windows.
 *
 * Only imports and the two references below exist at load time; no `vscode`
 * API is called before `activate` (test/transport/packaged-vsix.js loads the
 * bundle under a minimal stub).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { registerCmsisJobTracker } from './cmsisJobTracker';
import { serialController } from './core/serialController';
import { serialMonitorBridge } from './core/serialMonitorBridge';
import { clearSvdCache } from './core/svdParser';
import { SERVER_VERSION } from './debuggingExecutor';
import { registerPackDocsCommands } from './packDocsCommands';
import type { PackDocsHandlers } from './packDocsDispatch';
import { createPackDocsHandlers, readPackDocsGates } from './packDocsHost';
import { registerSerialHandle } from './serialStatus';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { logger } from './utils/logger';
import { notifyError, notifyWarning } from './utils/notify';
import { registerSessionStateTracker } from './utils/sessionStateTracker';
import { registerToolchainPackRootInvalidation } from './utils/toolchainPackRoot';
import { WindowCoordinator } from './windowCoordinator';
import { SELECT_TARGET_WINDOW_COMMAND } from './windowStatus';
import { registerProblemJournal } from './windowProblems';

const SECTION = 'cmsis-developer-assistant';
const PRODUCT = 'CMSIS Developer Assistant';
/** The MCP server definition provider id contributed in package.json. */
const MCP_PROVIDER_ID = 'cmsis-developer-assistant';
/** Delay before the first-run setup, so it does not compete with startup. */
const SETUP_DELAY_MS = 2000;
const RELOAD_BUTTON = 'Reload Window';
const PORT_RELOAD_NOTICE = `${PRODUCT}: the server port setting changed. Reload the window to restart the MCP server on the new port.`;
const GATES_RELOAD_NOTICE = `${PRODUCT}: the documentation / build-artefact tool setting changed. Reload the window so the next agent connection sees the new tool list.`;
const DUPLICATE_PACK_DOCS_NOTICE = `${PRODUCT}: the experimental "CMSIS Pack Docs" extension is also installed. `
    + 'Its tools are now built into this extension (settings cmsis-developer-assistant.packDocs.enabled / buildInfo.enabled); '
    + 'uninstall it so agents do not see the same tool names twice.';

/** Kept from `activate` to `deactivate`. */
let windowCoordinator: WindowCoordinator | null = null;
let agentManager: AgentConfigurationManager | null = null;

/** The settings this activation runs with; changing any of them takes a window reload. */
interface ActivationSettings {
    timeoutInSeconds: number;
    serverPort: number;
    dapRequestMs: number;
    memoryReadMs: number;
    telemetryJsonlPath: string | undefined;
    serialEnabled: boolean;
    packDocsEnabled: boolean;
    buildInfoEnabled: boolean;
}

/**
 * The telemetry file from the trimmed setting: empty means off, an absolute
 * path is used as it is, a relative one is resolved against the first
 * workspace folder (off, with a warning, when no folder is open).
 */
function telemetryFile(setting: string): string | undefined {
    const trimmed = setting.trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    if (path.isAbsolute(trimmed)) {
        return trimmed;
    }
    const firstFolder = vscode.workspace.workspaceFolders?.[0];
    if (!firstFolder) {
        logger.warn(`Telemetry off: "${trimmed}" is a relative path and no workspace folder is open to resolve it against`);
        return undefined;
    }
    return path.join(firstFolder.uri.fsPath, trimmed);
}

function readActivationSettings(): ActivationSettings {
    const gates = readPackDocsGates();
    const settings = vscode.workspace.getConfiguration(SECTION);
    return {
        // The fallbacks apply only if a contributed default is missing (timeoutInSeconds contributes 180).
        timeoutInSeconds: settings.get<number>('timeoutInSeconds', 60),
        serverPort: settings.get<number>('serverPort', 3001),
        dapRequestMs: settings.get<number>('dapRequestTimeoutMs', 10000),
        memoryReadMs: settings.get<number>('memoryReadTimeoutMs', 30000),
        telemetryJsonlPath: telemetryFile(settings.get<string>('telemetry.jsonlPath', '')),
        serialEnabled: settings.get<boolean>('serial.enabled', true),
        packDocsEnabled: gates.packDocsEnabled,
        buildInfoEnabled: gates.buildInfoEnabled,
    };
}

function logActivationSettings(active: ActivationSettings): void {
    logger.info(`Operation timeout: ${active.timeoutInSeconds} s`);
    logger.info(`MCP server port: ${active.serverPort}`);
    logger.info(`DAP request timeout: ${active.dapRequestMs} ms`);
    logger.info(`Memory read timeout: ${active.memoryReadMs} ms`);
    if (active.telemetryJsonlPath) {
        logger.info(`Tool-call telemetry file: ${active.telemetryJsonlPath}`);
    }
    if (!active.serialEnabled) {
        logger.info('Serial tools are switched off (serial.enabled)');
    }
    logger.info(`Documentation tools ${active.packDocsEnabled ? 'on' : 'off'}, build-artefact tools ${active.buildInfoEnabled ? 'on' : 'off'}`);
}

/** The standalone "CMSIS Pack Docs" extension would offer the same tool names a second time. */
function warnIfStandalonePackDocsInstalled(): void {
    if (vscode.extensions.getExtension('arm.cmsis-pack-docs') !== undefined) {
        logger.warn(DUPLICATE_PACK_DOCS_NOTICE);
        void notifyWarning(DUPLICATE_PACK_DOCS_NOTICE);
    }
}

/**
 * Start this window's coordinator and, when that works, offer the router's
 * MCP endpoint to in-editor Copilot. A failure is reported and not retried;
 * the coordinator stays referenced so that `deactivate` still disposes it.
 */
async function startCoordinator(
    extensionContext: vscode.ExtensionContext,
    active: ActivationSettings,
    packDocs: PackDocsHandlers,
    manager: AgentConfigurationManager,
): Promise<void> {
    try {
        logger.info('Starting the window coordinator');
        const started = new WindowCoordinator({
            port: active.serverPort,
            timeoutInSeconds: active.timeoutInSeconds,
            hardwareTimeouts: { dapRequestMs: active.dapRequestMs, memoryReadMs: active.memoryReadMs },
            serverOptions: {
                serialEnabled: active.serialEnabled,
                packDocsEnabled: active.packDocsEnabled,
                buildInfoEnabled: active.buildInfoEnabled,
                telemetry: { jsonlPath: active.telemetryJsonlPath },
            },
            packDocs,
        });
        windowCoordinator = started;
        await started.start(extensionContext);

        // The router's URL in every window: workers send in-editor Copilot through the router too.
        const endpoint = started.getEndpoint();
        manager.updatePort(active.serverPort);
        const router = started.isRouter();
        logger.info(`Window role: ${router ? 'router' : 'worker'}; MCP endpoint ${endpoint}`);
        if (router) {
            void vscode.window.showInformationMessage(`${PRODUCT}: MCP server listening at ${endpoint}`);
        }

        const mcpUri = vscode.Uri.parse(`${endpoint}/mcp`);
        const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
            provideMcpServerDefinitions: () => [new vscode.McpHttpServerDefinition(PRODUCT, mcpUri, undefined, SERVER_VERSION)],
        };
        extensionContext.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider));
        logger.info(`MCP server definition for ${mcpUri.toString()} offered to VS Code`);
    } catch (failure) {
        logger.error('The MCP server could not be started', failure);
        void notifyError(`${PRODUCT} could not start its MCP server: ${String(failure)}`);
    }
}

/** True while the extension test runner hosts this extension: see the module comment. */
function hostedByTestRunner(extensionContext: vscode.ExtensionContext): boolean {
    return extensionContext.extensionMode === vscode.ExtensionMode.Test;
}

/** A settings change: the documentation settings apply at once, the port and the tool-group switches need a window reload. */
async function onSettingsChanged(
    change: vscode.ConfigurationChangeEvent,
    packDocs: PackDocsHandlers,
): Promise<void> {
    const touches = (key: string): boolean => change.affectsConfiguration(`${SECTION}.${key}`);
    if (touches('packDocs')) {
        packDocs.docs.refreshSettings();
    }
    const portChanged = touches('serverPort');
    const gateChanged = touches('packDocs.enabled') || touches('buildInfo.enabled');
    if (!portChanged && !gateChanged) {
        return;
    }
    const answer = await vscode.window.showInformationMessage(portChanged ? PORT_RELOAD_NOTICE : GATES_RELOAD_NOTICE, RELOAD_BUTTON);
    if (answer === RELOAD_BUTTON) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/** The two agent commands; each does nothing without a manager. */
function registerAgentCommands(extensionContext: vscode.ExtensionContext): void {
    extensionContext.subscriptions.push(
        vscode.commands.registerCommand(`${SECTION}.configure`, async () => {
            await agentManager?.runSetupFlow();
        }),
        vscode.commands.registerCommand(`${SECTION}.resetPopupState`, async () => {
            if (!agentManager) {
                return;
            }
            await agentManager.resetPopupState();
            void vscode.window.showInformationMessage(`${PRODUCT}: the setup prompt has been reset.`);
        }),
    );
}

/**
 * Select Target Window (#16), also the click of the window's status-bar item.
 * Registered in every window; without a coordinator — under the test runner,
 * or when it could not be created — it says there is nothing to choose.
 */
function registerWindowCommand(extensionContext: vscode.ExtensionContext): void {
    extensionContext.subscriptions.push(
        vscode.commands.registerCommand(SELECT_TARGET_WINDOW_COMMAND, async () => {
            if (!windowCoordinator) {
                void vscode.window.showInformationMessage(`${PRODUCT}: no MCP server runs in this window, so there is no target window to choose.`);
                return;
            }
            await windowCoordinator.selectTargetWindow();
        }),
    );
}

/** Two seconds after activation: the first-run setup, when it is due. */
async function setupWhenDue(manager: AgentConfigurationManager): Promise<void> {
    try {
        if (await manager.shouldShowPopup()) {
            await manager.runSetupFlow();
        }
    } catch (failure) {
        logger.error('The first-run setup failed', failure);
    }
}

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
    logger.info(`${PRODUCT} is activating`);
    logger.logSystemInfo();

    const active = readActivationSettings();
    logActivationSettings(active);

    registerProblemJournal(extensionContext);
    registerSessionStateTracker(extensionContext);
    registerCmsisJobTracker(extensionContext);
    registerToolchainPackRootInvalidation(extensionContext);
    // A new session may use another device, so the parsed SVD files are dropped when one ends,
    // and a serial port opened with releaseOn 'debug-session-end' is released (#49).
    extensionContext.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => {
        clearSvdCache();
        serialController.debugSessionEnded();
    }));
    // Before the coordinator serves the serial tools: the Serial Monitor hands its API only to a caller with a context.
    serialMonitorBridge.attach(extensionContext);

    const hostsTests = hostedByTestRunner(extensionContext);
    const manager = new AgentConfigurationManager(extensionContext, active.timeoutInSeconds, active.serverPort);
    agentManager = manager;

    // Every window gets the documentation handlers and commands, router or worker.
    const packDocs = createPackDocsHandlers(extensionContext, active.timeoutInSeconds);
    registerPackDocsCommands(extensionContext, packDocs);
    warnIfStandalonePackDocsInstalled();

    if (hostsTests) {
        logger.info('Running under the extension test runner: no skill installation, agent configuration, rule file, prompt or MCP server');
    } else {
        // The endpoint before anything that touches the file system: an agent that connects to its MCP
        // servers once, at its own activation, and never retries (Kimi Code's VS Code extension) must
        // find the port bound. The skill install alone took 0.7–1.7 s in the field, and that lost the race.
        await startCoordinator(extensionContext, active, packDocs, manager);
        try {
            await manager.syncSkills('activation');
        } catch (failure) {
            logger.error('Installing the agent skills at activation failed', failure);
        }
        try {
            await manager.migrateExistingConfigurations();
        } catch (failure) {
            logger.error('Migrating the agent configurations failed', failure);
        }
        // Not awaited: an outdated rules block waits for the user's answer to a toast.
        void manager.refreshAgentRules().catch((failure: unknown) => {
            logger.error('Updating the tool rules in the agents\' rule files failed', failure);
        });
    }

    extensionContext.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((change) => onSettingsChanged(change, packDocs)),
    );
    registerAgentCommands(extensionContext);
    registerWindowCommand(extensionContext);
    registerSerialHandle(extensionContext);

    if (!hostsTests) {
        setTimeout(() => setupWhenDue(manager), SETUP_DELAY_MS);
    }
    logger.info(`${PRODUCT} activated`);
}

export async function deactivate(): Promise<void> {
    logger.info(`${PRODUCT} is deactivating`);
    const leaving = windowCoordinator;
    if (leaving) {
        try {
            await leaving.dispose();
        } catch (failure) {
            logger.error('Disposing the window coordinator failed', failure);
        }
        windowCoordinator = null;
    }
    logger.info(`${PRODUCT} deactivated`);
}
