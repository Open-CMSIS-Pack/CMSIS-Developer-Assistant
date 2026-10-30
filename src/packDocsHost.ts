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
 * The VS Code side of the documentation and build-artefact tools: settings
 * under `cmsis-developer-assistant.packDocs.*` / `.buildInfo.*`, the host
 * objects the pure cores see (`PackDocsHost`, `BuildInfoHost`), and the two
 * handlers every window owns, with the experimental knowledge handler
 * (`knowledge.*`) beside them. Nothing under `core/packDocs` or
 * `core/buildInfo` imports `vscode`; this file is where that ends.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { BuildInfoHost, BuildInfoSettings, defaultBuildInfoSettings } from './core/buildInfo/host';
import { PackDocsHost, PackDocsSettings, defaultSettings } from './core/packDocs/host';
import { defaultPackRoot, resolveUserDocsDir } from './core/packDocs';
import { effectivePackRoot } from './core/packDocs/host';
import { ActiveContextHint, formatPackId } from './core/packDocs/cbuildRun';
import { namedPackFolders } from './core/packDocs/targetDocs';
import { solutionNameOf, targetTypeOf } from './core/solutionAnswers';
import { withTimeout } from './utils/timeout';
import { toolchainPackRoot } from './utils/toolchainPackRoot';
import { activeCbuildRunFile, activePackFolders } from './utils/solutionQueries';
import { PackDocsHandler } from './packDocsHandler';
import { BuildInfoHandler } from './buildInfoHandler';
import { projectFacts } from './core/knowledge/projectFacts';
import { setKnownMessageLookup } from './core/knowledge/knownMessageLookup';
import { KnowledgeHandler, KnowledgeHost } from './knowledgeHandler';
import { PackDocsHandlers } from './packDocsDispatch';
import { SERVER_VERSION } from './debuggingExecutor';
import { logger } from './utils/logger';

const CONFIG = 'cmsis-developer-assistant';

/** The two per-instance gates, read once at activation like `serial.enabled`. */
export function readPackDocsGates(): { packDocsEnabled: boolean; buildInfoEnabled: boolean } {
    const c = vscode.workspace.getConfiguration(CONFIG);
    return {
        packDocsEnabled: c.get<boolean>('packDocs.enabled', true),
        buildInfoEnabled: c.get<boolean>('buildInfo.enabled', true),
    };
}

/** The core knowledge index the extension ships, under its root. */
export function bundledKnowledgeIndex(extensionPath: string): string {
    return path.join(extensionPath, 'resources', 'knowledge', 'core.db');
}

/**
 * `knowledge.indexPath` as an absolute path: `~` is the home directory, a
 * relative path is under the first workspace folder. Empty means the core
 * index the extension ships, which is what the knowledge tools read.
 */
export function readKnowledgeIndexPath(bundledIndex: string): string | undefined {
    const setting = vscode.workspace.getConfiguration(CONFIG).get<string>('knowledge.indexPath', '').trim();
    if (setting.length === 0) {
        return bundledIndex;
    }
    const expanded = setting === '~' || setting.startsWith('~/') || setting.startsWith('~\\') ? path.join(os.homedir(), setting.slice(1)) : setting;
    if (path.isAbsolute(expanded)) {
        return expanded;
    }
    const root = workspaceRoot();
    return root ? path.join(root, expanded) : undefined;
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
        const solution = solutionNameOf(file);
        const targetType = targetTypeOf(set);
        return solution || targetType ? { solution, targetType } : undefined;
    } catch {
        return undefined;
    }
}

export function makePackDocsHost(context: vscode.ExtensionContext): PackDocsHost {
    // `$CMSIS_PACK_ROOT` or the platform default until the CMSIS Solution
    // extension answers; from then on its pack root, so both extensions
    // agree on where the packs are (the panel's and the tools' "not
    // installed" notes name the same directory). `resolveTarget` asks the
    // hook before every resolution and records the answer on the
    // resolution, so consumers do not depend on this getter.
    let packRoot = defaultPackRoot();
    const packRootFromToolchain = async (): Promise<string | undefined> => {
        const fromToolchain = await toolchainPackRoot();
        if (fromToolchain) { packRoot = fromToolchain; }
        return fromToolchain;
    };
    return {
        get packRoot() { return packRoot; },
        packRootFromToolchain,
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
        activeCbuildRunFile: () => activeCbuildRunFile(),
        activePackFolders: () => activePackFolders(),
    };
}

/** The knowledge handler's window: the two settings read per call, the project from the other two hosts. */
export function makeKnowledgeHost(docs: PackDocsHost, build: BuildInfoHost, bundledIndex: string): KnowledgeHost {
    return {
        indexPath: () => readKnowledgeIndexPath(bundledIndex),
        includeIncomplete: () => vscode.workspace.getConfiguration(CONFIG).get<boolean>('knowledge.includeIncomplete', false),
        packRoot: () => effectivePackRoot(docs),
        workspaceFolders,
        projectFacts: () => projectFacts(docs, build),
        packFolders: async () => (await namedPackFolders(docs)).map(({ pack, dir }) => ({ pack: formatPackId(pack), dir })),
        log: logger,
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
    context.subscriptions.push({ dispose: () => docs.dispose() });
    const buildHost = makeBuildInfoHost();
    const build = new BuildInfoHandler(buildHost, { timeoutMs, workspaceRoot });
    const knowledge = new KnowledgeHandler(makeKnowledgeHost(host, buildHost, bundledKnowledgeIndex(context.extensionPath)), { timeoutMs });
    // A failed build's result names the unit of a message the index knows.
    setKnownMessageLookup((messages) => knowledge.knownMessageLines(messages));

    const s = readPackDocsSettings();
    logger.info(`Pack docs: default pack root ${host.packRoot}${process.env.CMSIS_PACK_ROOT ? ' (CMSIS_PACK_ROOT)' : ' (platform default)'}, ` +
        `page store ${host.storageDir}, extractor ${s.extractor} (${s.pdftotextPath}), maxPdfMb ${s.maxPdfMb}, ` +
        `workspaceDocDirs ${s.workspaceDocDirs.join(', ')}, userDocsDir ${resolveUserDocsDir(s.userDocsDir)}`);
    void host.packRootFromToolchain?.();
    void docs.getExtractor().available().then((a) => {
        if (a.ok) {
            logger.info(`Pack docs extractor: ${a.detail}`);
        } else {
            logger.warn(`Pack docs extractor unavailable — ${a.detail}. Documents are listed but cannot be searched: ` +
                `set ${CONFIG}.packDocs.extractor to pdfjs (bundled), or install poppler / set ${CONFIG}.packDocs.pdftotextPath.`);
        }
    });
    return { docs, build, knowledge };
}
