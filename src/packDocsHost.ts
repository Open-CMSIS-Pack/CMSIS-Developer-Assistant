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
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either produced or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The VS Code side of the documentation and build-artefact tools: settings
 * under `cmsis-developer-assistant.packDocs.*` / `.buildInfo.*`, the host
 * objects the pure cores see (`PackDocsHost`, `BuildInfoHost`), and the two
 * handlers every window owns. Nothing under `core/packDocs` or
 * `core/buildInfo` imports `vscode`; this file is where that ends.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { BuildInfoHost, BuildInfoSettings, defaultBuildInfoSettings } from './core/buildInfo/host';
import { PackDocsHost, PackDocsSettings, defaultSettings } from './core/packDocs/host';
import { defaultPackRoot, resolveUserDocsDir } from './core/packDocs';
import { ActiveContextHint } from './core/packDocs/cbuildRun';
import { withTimeout } from './utils/timeout';
import { PackDocsHandler } from './packDocsHandler';
import { BuildInfoHandler } from './buildInfoHandler';
import { PackDocsHandlers } from './packDocsDispatch';
import { SERVER_VERSION } from './debuggingExecutor';
import { logger } from './utils/logger';

const CONFIG = 'cmsis-developer-assistant';

/** The two per-instance gates, read once at activation like `serial.enabled`. */
export function readPackDocsGates(): { packDocsEnabled: boolean; buildInfoEnabled: boolean } {
    const c = vscode.workspace.getConfiguration(CONFIG);
    return {
        packDocsEnabled: c.get<boolean>('packDocs.enabled', false),
        buildInfoEnabled: c.get<boolean>('buildInfo.enabled', false),
    };
}

/** Re-read on every call through `host.settings()`, so edits apply live. */
export function readPackDocsSettings(): PackDocsSettings {
    const c = vscode.workspace.getConfiguration(`${CONFIG}.packDocs`);
    return {
        extractor: c.get<'auto' | 'pdftotext' | 'pdfjs'>('extractor', defaultSettings.extractor),
        pdftotextPath: c.get<string>('pdftotextPath', defaultSettings.pdftotextPath) || defaultSettings.pdftotextPath,
        maxPdfMb: c.get<number>('maxPdfMb', defaultSettings.maxPdfMb),
        includeUnlisted: c.get<boolean>('includeUnlisted', defaultSettings.includeUnlisted),
        workspaceDocDirs: c.get<string[]>('workspaceDocDirs', defaultSettings.workspaceDocDirs),
        userDocsDir: c.get<string>('userDocsDir', defaultSettings.userDocsDir),
    };
}

export function readBuildInfoSettings(): BuildInfoSettings {
    const c = vscode.workspace.getConfiguration(`${CONFIG}.buildInfo`);
    const globs = c.get<string[]>('logGlobs', defaultBuildInfoSettings.logGlobs).filter(g => !!g.trim());
    return {
        maxSymbols: c.get<number>('maxSymbols', defaultBuildInfoSettings.maxSymbols),
        logGlobs: globs.length ? globs : defaultBuildInfoSettings.logGlobs,
    };
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function workspaceFolders(): string[] {
    return vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
}

async function findFiles(glob: string, max: number): Promise<string[]> {
    const t0 = Date.now();
    const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', max);
    const files = uris.map(u => u.fsPath).sort();
    logger.debug(`findFiles(${glob}): ${files.length} in ${Date.now() - t0} ms`);
    return files;
}

/**
 * What the CMSIS Solution panel has active — csolution name and target-type —
 * so a workspace with several solutions resolves without `target`. Asks the
 * CMSIS Solution extension (`getSolutionFile`, `getActiveTargetSet`); absent
 * extension, no solution or a slow answer all yield undefined, never throw.
 */
async function activeContext(): Promise<ActiveContextHint | undefined> {
    try {
        const [file, set] = await Promise.all([
            withTimeout('cmsis getSolutionFile', 3_000, Promise.resolve(vscode.commands.executeCommand('cmsis-csolution.getSolutionFile'))),
            withTimeout('cmsis getActiveTargetSet', 3_000, Promise.resolve(vscode.commands.executeCommand('cmsis-csolution.getActiveTargetSet'))),
        ]);
        const record = file as Record<string, any> | undefined;
        const solutionPath = typeof file === 'string' ? file : record?.solutionFile ?? record?.fsPath ?? record?.path ?? record?.uri?.fsPath;
        const solution = typeof solutionPath === 'string' && solutionPath
            ? path.basename(solutionPath).replace(/\.csolution\.ya?ml$/i, '') : undefined;
        const targetType = typeof set === 'string' && set.trim() ? set.trim().split('@')[0] : undefined;
        return solution || targetType ? { solution, targetType } : undefined;
    } catch {
        return undefined;
    }
}

export function makePackDocsHost(context: vscode.ExtensionContext): PackDocsHost {
    return {
        packRoot: defaultPackRoot(),
        // Page text, metadata and indexes live in this extension's global
        // storage; a user coming from the standalone CMSIS Pack Docs
        // extension re-extracts once.
        storageDir: path.join(context.globalStorageUri.fsPath, 'packdocs'),
        assetsDir: path.join(context.extensionPath, 'assets'),
        settings: () => readPackDocsSettings(),
        log: logger,
        userAgent: `cmsis-developer-assistant/${SERVER_VERSION}`,
        workspaceFolders,
        // csolution writes <solution>+<target>.cbuild-run.yml next to the
        // csolution file (CMSIS-Toolbox 2.8) or under out/ (older layouts).
        findCbuildRunFiles: () => findFiles('**/*.cbuild-run.yml', 50),
        activeContext,
    };
}

export function makeBuildInfoHost(): BuildInfoHost {
    return {
        workspaceFolders,
        findFiles: (glob) => findFiles(glob, 200),
        settings: () => readBuildInfoSettings(),
        log: logger,
        activeContext,
    };
}

/**
 * Build this window's documentation and build-artefact handlers. They do no
 * work until a tool or command calls them, so every window gets a pair
 * regardless of the enable gates — the gates only decide whether the router
 * offers the tools.
 */
export function createPackDocsHandlers(context: vscode.ExtensionContext, timeoutInSeconds: number): PackDocsHandlers {
    const host = makePackDocsHost(context);
    const timeoutMs = timeoutInSeconds * 1000;
    const docs = new PackDocsHandler(host, { timeoutMs, workspaceRoot });
    const build = new BuildInfoHandler(makeBuildInfoHost(), { timeoutMs, workspaceRoot });

    const s = readPackDocsSettings();
    logger.info(`Pack docs: pack root ${host.packRoot}${process.env.CMSIS_PACK_ROOT ? ' (CMSIS_PACK_ROOT)' : ''}, ` +
        `page store ${host.storageDir}, extractor ${s.extractor} (${s.pdftotextPath}), maxPdfMb ${s.maxPdfMb}, ` +
        `workspaceDocDirs ${s.workspaceDocDirs.join(', ')}, userDocsDir ${resolveUserDocsDir(s.userDocsDir)}`);
    void docs.getExtractor().available().then((a) => {
        if (a.ok) {
            logger.info(`Pack docs extractor: ${a.detail}`);
        } else {
            logger.warn(`Pack docs extractor unavailable — ${a.detail}. Documents are listed but cannot be searched: ` +
                `set ${CONFIG}.packDocs.extractor to pdfjs (bundled), or install poppler / set ${CONFIG}.packDocs.pdftotextPath.`);
        }
    });
    return { docs, build };
}
