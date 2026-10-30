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
 * Where knowledge indexes come from besides the setting: every installed
 * pack that carries one, and the workspace. A pack ships its knowledge in
 * the folder `.knowledge` next to its PDSC: the units as Markdown in
 * `.knowledge/units/` and the index `.knowledge/knowledge.db`, built by
 * `cmsis-knowledge` (cmsis-developer-assistant-tools). A project keeps its
 * own index as `.cmsis/knowledge.db`. All of them are opened whatever the
 * active target; the units of a pack are scoped to it (`scoped_to`), so a
 * search offers them only to a project that uses the pack.
 *
 * Found by reading the pack root (`<root>/<Vendor>/<Pack>/<version>/`), the
 * local repository index cpackget keeps (`.Local/local_repository.pidx`,
 * packs registered from a folder), and the folders the caller names for the
 * active target's packs (the DFP and BSP folders the CMSIS Solution
 * extension reports, which a csolution `packs:` entry with `path:` puts
 * outside the pack root). No `vscode` import.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The index of a pack, relative to the folder of its PDSC. */
export const PACK_INDEX = path.join('.knowledge', 'knowledge.db');
/** The index of a workspace folder, relative to it. */
export const WORKSPACE_INDEX = path.join('.cmsis', 'knowledge.db');

export interface FoundIndex {
    /** `Vendor::Pack@version` for a pack, `workspace` or `workspace:<name>` for a folder. */
    label: string;
    file: string;
}

/** A pack of the active target and the folder its PDSC is in. */
export interface PackFolder {
    /** `Vendor::Pack@version`. */
    pack: string;
    dir: string;
}

function indexIn(dir: string, name: string): string | undefined {
    const candidate = path.join(dir, name);
    try {
        return fs.statSync(candidate).isFile() ? candidate : undefined;
    } catch {
        return undefined; // not there
    }
}

function subdirs(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name).sort();
    } catch {
        return [];
    }
}

/** The packs of the pack root that carry an index: `<root>/<Vendor>/<Pack>/<version>/`. */
export function installedPackIndexes(packRoot: string): FoundIndex[] {
    const found: FoundIndex[] = [];
    for (const vendor of subdirs(packRoot)) {
        for (const pack of subdirs(path.join(packRoot, vendor))) {
            for (const version of subdirs(path.join(packRoot, vendor, pack))) {
                const file = indexIn(path.join(packRoot, vendor, pack, version), PACK_INDEX);
                if (file !== undefined) {
                    found.push({ label: `${vendor}::${pack}@${version}`, file });
                }
            }
        }
    }
    return found;
}

/**
 * The packs of `.Local/local_repository.pidx` that carry an index. Each
 * `<pdsc url="file:///dir/" vendor="V" name="N" version="x"/>` names the
 * folder the pack lives in.
 */
export function localRepositoryIndexes(packRoot: string): FoundIndex[] {
    const pidx = path.join(packRoot, '.Local', 'local_repository.pidx');
    let text: string;
    try {
        text = fs.readFileSync(pidx, 'utf-8');
    } catch {
        return [];
    }
    const found: FoundIndex[] = [];
    for (const match of text.matchAll(/<pdsc\b([^>]*)\/?>/g)) {
        const attribute = (name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(match[1])?.[1];
        const url = attribute('url');
        if (url === undefined) {
            continue;
        }
        let dir = url.replace(/^file:\/\//, '');
        try {
            dir = decodeURIComponent(dir);
        } catch {
            // keep as is
        }
        if (/^\/[A-Za-z]:/.test(dir)) {
            dir = dir.slice(1); // file:///C:/… on Windows
        }
        const file = indexIn(dir, PACK_INDEX);
        if (file !== undefined) {
            const version = attribute('version');
            found.push({ label: `${attribute('vendor') ?? '?'}::${attribute('name') ?? '?'}${version ? `@${version}` : ''} (local)`, file });
        }
    }
    return found;
}

/** The indexes in the folders of the active target's packs, labelled like the packs of the local repository. */
export function packFolderIndexes(packFolders: readonly PackFolder[]): FoundIndex[] {
    const found: FoundIndex[] = [];
    for (const { pack, dir } of packFolders) {
        const file = indexIn(dir, PACK_INDEX);
        if (file !== undefined) {
            found.push({ label: `${pack} (local)`, file });
        }
    }
    return found;
}

/** The index a workspace folder carries under `.cmsis/`. */
export function workspaceIndexes(folders: readonly string[]): FoundIndex[] {
    const found: FoundIndex[] = [];
    for (const folder of folders) {
        const file = indexIn(folder, WORKSPACE_INDEX);
        if (file !== undefined) {
            found.push({ label: folders.length === 1 ? 'workspace' : `workspace:${path.basename(folder)}`, file });
        }
    }
    return found;
}

/** One key for every spelling of a file: the pack root and the CMSIS Solution extension may name it through different links. */
function sameFileKey(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return path.resolve(file);
    }
}

/**
 * Every index besides the base one, packs first, without a file twice: a
 * pack folder that lies in the pack root keeps the label of the installed
 * pack.
 */
export function discoverIndexes(packRoot: string | undefined, folders: readonly string[], packFolders: readonly PackFolder[] = []): FoundIndex[] {
    const all = [
        ...(packRoot ? installedPackIndexes(packRoot) : []),
        ...(packRoot ? localRepositoryIndexes(packRoot) : []),
        ...packFolderIndexes(packFolders),
        ...workspaceIndexes(folders),
    ];
    const seen = new Set<string>();
    return all.filter((entry) => {
        const key = sameFileKey(entry.file);
        return !seen.has(key) && seen.add(key);
    });
}
