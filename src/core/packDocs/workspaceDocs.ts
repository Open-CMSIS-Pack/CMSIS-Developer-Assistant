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
 * PDFs the user put into the workspace. The cmsis-skills bring-up skills
 * end with a "Documents requiring user download" table that asks for a
 * copy at a "Requested workspace path"; the folders named in
 * `workspaceDocDirs` (default `.agent-artifacts/docs` and `docs`) are
 * scanned so such a copy is listed and searched without further steps.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PackDocsHost } from './host';
import { DocRef, fileSlug } from './pdscBooks';

const MAX_DEPTH = 3;
const MAX_FILES = 100;

export interface WorkspaceDocs {
    docs: DocRef[];
    /** The docs folders that exist, as `<workspace folder name>/<dir>`. */
    dirs: string[];
    notes: string[];
}

export function collectWorkspaceDocs(host: PackDocsHost): WorkspaceDocs {
    const log = host.log;
    const docs: DocRef[] = [];
    const dirs: string[] = [];
    const notes: string[] = [];
    const folders = host.workspaceFolders();
    const relDirs = host.settings().workspaceDocDirs ?? [];
    for (const folder of folders) {
        for (const rel of relDirs) {
            const dir = path.resolve(folder, rel);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(dir);
            } catch {
                continue;
            }
            if (!stat.isDirectory()) { continue; }
            dirs.push(`${path.basename(folder)}/${rel.replace(/\\/g, '/')}`);
            const before = docs.length;
            walk(dir, 0, docs);
            log.debug(`workspace docs: ${docs.length - before} PDFs in ${dir}`);
            if (docs.length >= MAX_FILES) {
                notes.push(`workspace docs: only the first ${MAX_FILES} PDFs are listed`);
                return { docs, dirs, notes };
            }
        }
    }
    return { docs, dirs, notes };
}

function walk(dir: string, depth: number, out: DocRef[]): void {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) { return; }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
        if (out.length >= MAX_FILES) { return; }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name.startsWith('.') || e.name === 'node_modules') { continue; }
            walk(full, depth + 1, out);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
            let size: number | undefined;
            try { size = fs.statSync(full).size; } catch { size = undefined; }
            out.push({
                id: `workspace/${fileSlug(e.name)}`,
                title: e.name.replace(/\.pdf$/i, ''),
                scope: 'workspace',
                source: 'workspace',
                path: full,
                sizeBytes: size,
                cached: false,
                indexed: false,
            });
        }
    }
}
