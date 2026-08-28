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
 * The palette commands of the documentation tools: list and index the current
 * target's documents into the output channel, import PDFs the packs do not
 * ship into the user documents folder (attributed to a pack, device, board or
 * core), open that folder, and open the Pack Docs panel. Available whether or
 * not the MCP tools are enabled — the handlers exist in every window.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BookCategory, DocRef, UserScope, fileSlug, importUserDoc, resolveUserDocsDir } from './core/packDocs';
import { PackDocsHandlers } from './packDocsDispatch';
import { readPackDocsSettings } from './packDocsHost';
import { PackDocsPanel } from './packDocsPanel';
import { logger } from './utils/logger';

const CONFIG = 'cmsis-developer-assistant';

/** A multi-line tool result under one heading in the output channel. */
function logBlock(title: string, body: string, maxLines: number): void {
    const lines = body.split('\n');
    const shown = lines.slice(0, maxLines);
    logger.info(`${title}:\n  ${shown.join('\n  ')}${lines.length > maxLines ? `\n  … ${lines.length - maxLines} more lines` : ''}`);
}

export function registerPackDocsCommands(context: vscode.ExtensionContext, handlers: PackDocsHandlers): void {
    const { docs } = handlers;
    context.subscriptions.push(
        vscode.commands.registerCommand(`${CONFIG}.listTargetDocs`, async () => {
            logger.show();
            logBlock('list_target_docs (command)', await docs.handleListTargetDocs({}), 200);
        }),

        vscode.commands.registerCommand(`${CONFIG}.indexTargetDocs`, async () => {
            logger.show();
            const summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'CMSIS Developer Assistant: indexing target documentation', cancellable: false },
                (progress) => docs.indexTarget({}, (message) => progress.report({ message })),
            );
            logBlock('index (command)', summary, 100);
            vscode.window.showInformationMessage(summary.split('\n').slice(-1)[0]);
        }),

        vscode.commands.registerCommand(`${CONFIG}.openUserDocsFolder`, async () => {
            const dir = resolveUserDocsDir(readPackDocsSettings().userDocsDir);
            fs.mkdirSync(dir, { recursive: true });
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        }),

        vscode.commands.registerCommand(`${CONFIG}.importUserDoc`, () => importUserDocuments(handlers)),

        vscode.commands.registerCommand(`${CONFIG}.openPackDocsPanel`, () => {
            PackDocsPanel.show(context, handlers.docs, handlers.build, logger);
        }),
    );
}

/**
 * Import PDFs the packs do not ship (NDA manuals, portal downloads) into the
 * user documents folder, attributed to the current target's pack, device,
 * board or core, and index them right away.
 */
async function importUserDocuments(handlers: PackDocsHandlers): Promise<void> {
    const { docs } = handlers;
    const root = resolveUserDocsDir(readPackDocsSettings().userDocsDir);
    const files = await vscode.window.showOpenDialog({
        canSelectMany: true, canSelectFolders: false, filters: { 'PDF documents': ['pdf'] }, openLabel: 'Import',
        title: 'Import documents into the user documents folder',
    });
    if (!files?.length) { return; }

    const t = await docs.inspectTarget({});
    const scopes: (vscode.QuickPickItem & { scope: UserScope })[] = [];
    if (t.devicePack) {
        const [vendor, rest] = t.devicePack.split('::');
        scopes.push({ label: `$(package) Pack ${vendor}::${rest.split('@')[0]}`, description: 'every target using this device pack, any version', scope: { kind: 'pack', vendor, name: rest.split('@')[0] } });
    }
    if (t.device) {
        scopes.push({ label: `$(chip) Device ${t.device}`, description: 'this device only', scope: { kind: 'device', pattern: t.device } });
        const family = t.device.replace(/[A-Z0-9]{2,}$/i, '').replace(/[^A-Za-z0-9]+$/, '');
        if (family.length >= 5 && family !== t.device) {
            scopes.push({ label: `$(chip) Devices ${family}*`, description: 'the device family (glob)', scope: { kind: 'device', pattern: `${family}*` } });
        }
    }
    if (t.boardPack) {
        const [vendor, rest] = t.boardPack.split('::');
        scopes.push({ label: `$(circuit-board) Board pack ${vendor}::${rest.split('@')[0]}`, description: 'every target using this board pack', scope: { kind: 'pack', vendor, name: rest.split('@')[0] } });
    }
    if (t.board) { scopes.push({ label: `$(circuit-board) Board ${t.board}`, description: 'this board only', scope: { kind: 'board', pattern: t.board } }); }
    for (const core of new Set(t.cores)) { scopes.push({ label: `$(cpu) Core ${core}`, description: 'every target with this core', scope: { kind: 'core', core } }); }
    scopes.push({ label: '$(globe) All targets', description: 'listed for every target', scope: { kind: 'all' } });
    scopes.push({ label: '$(edit) Device pattern…', description: 'a glob such as STM32U5*', scope: { kind: 'device', pattern: '' } });
    const picked = await vscode.window.showQuickPick(scopes, {
        title: t.error ? 'No target resolved in this workspace — attribute the document by hand' : `Attribute to … (target: ${t.device ?? '?'}, ${t.devicePack ?? '?'})`,
        placeHolder: 'Which targets should see this document?',
    });
    if (!picked) { return; }
    let scope = picked.scope;
    if (scope.kind === 'device' && !scope.pattern) {
        const pattern = await vscode.window.showInputBox({ title: 'Device pattern', prompt: 'Device name or glob, e.g. STM32U585AIIx or STM32U5*', value: t.device ?? '' });
        if (!pattern?.trim()) { return; }
        scope = { kind: 'device', pattern: pattern.trim() };
    }
    const categories: (vscode.QuickPickItem & { category?: BookCategory })[] = [
        { label: 'manual', description: 'reference manual, user manual, TRM — ranked first in search', category: 'manual' },
        { label: 'overview', description: 'datasheet, product brief', category: 'overview' },
        { label: 'schematic', category: 'schematic' },
        { label: 'setup', description: 'getting started, board setup', category: 'setup' },
        { label: 'other', category: 'other' },
    ];

    const imported: { doc: DocRef; dest: string; replaced: boolean }[] = [];
    for (const uri of files) {
        const name = path.basename(uri.fsPath);
        const title = await vscode.window.showInputBox({ title: `Title for ${name}`, value: name.replace(/\.pdf$/i, ''), prompt: 'Shown in listings and citations' });
        if (title === undefined) { return; }
        const category = await vscode.window.showQuickPick(categories, { title: `Category for ${name}`, placeHolder: 'manual' });
        if (!category) { return; }
        const revision = await vscode.window.showInputBox({ title: `Edition of ${name} (optional)`, prompt: 'e.g. Rev 2, printed with every citation', value: '' });
        if (revision === undefined) { return; }
        const r = importUserDoc(root, scope, uri.fsPath, { title, category: category.category, revision });
        const doc: DocRef = {
            id: `user/${fileSlug(name)}`, title: title.trim() || name, ...(category.category ? { category: category.category } : {}), ...(revision.trim() ? { revision: revision.trim() } : {}),
            scope: 'user', source: 'user', path: r.dest, sizeBytes: fs.statSync(r.dest).size, cached: false, indexed: false,
        };
        imported.push({ doc, dest: r.dest, replaced: r.replaced });
        logger.info(`imported ${uri.fsPath} → ${r.dest} (${JSON.stringify(scope)})`);
    }

    const summary = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CMSIS Developer Assistant: indexing imported documents', cancellable: false },
        async (progress) => {
            const lines: string[] = [];
            for (const { doc, dest, replaced } of imported) {
                progress.report({ message: doc.id });
                try {
                    const loaded = await docs.indexDocument(doc);
                    lines.push(`${doc.id}: ${loaded.meta.pageCount} pages${replaced ? ' (replaced)' : ''} — ${dest}`);
                } catch (e) {
                    lines.push(`${doc.id}: copied to ${dest}, indexing failed — ${e instanceof Error ? e.message : e}`);
                }
            }
            return lines;
        },
    );
    logBlock('import (command)', summary.join('\n'), 50);
    const open = 'Open folder';
    const choice = await vscode.window.showInformationMessage(`Imported ${imported.length} document${imported.length === 1 ? '' : 's'}: ${summary.join('; ')}`, open);
    if (choice === open) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(imported[0].dest)); }
}
