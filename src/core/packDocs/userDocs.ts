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
 * The user documents folder: manuals a pack does not ship — obtained under
 * NDA, from a vendor portal, or written in-house — kept outside any
 * workspace so they are never committed, and attributed to targets by
 * sub-folder:
 *
 *   <root>/<Vendor>/<Pack>/*.pdf     every target whose device or board pack is Vendor::Pack (any version; globs allowed)
 *   <root>/<Vendor>/*.pdf            every target with a pack of that vendor
 *   <root>/devices/<glob>/*.pdf      devices matching the glob (STM32U5*)
 *   <root>/boards/<glob>/*.pdf       boards matching the glob
 *   <root>/cores/<core>/*.pdf        the core (Cortex-M33)
 *   <root>/*.pdf                     every target
 *
 * A `docs.json` next to the PDFs gives title, category and edition:
 *   { "RM0456-nda.pdf": { "title": "STM32U5 reference manual", "category": "manual", "revision": "Rev 2 (NDA)" } }
 *
 * Only the extracted text goes into the extension's cache; the files stay
 * where they are, and tool output names them by title and id only.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PackId } from './cbuildRun';
import { PackDocsLog, silentLog } from './host';
import { BookCategory, DocRef, fileSlug } from './pdscBooks';

export interface UserDocMeta {
    title?: string;
    category?: BookCategory;
    revision?: string;
}

export type UserDocsManifest = Record<string, UserDocMeta>;

export const USER_DOCS_MANIFEST = 'docs.json';

/** What a user document can be attributed to. */
export type UserScope =
    | { kind: 'all' }
    | { kind: 'pack'; vendor: string; name: string }
    | { kind: 'vendor'; vendor: string }
    | { kind: 'device'; pattern: string }
    | { kind: 'board'; pattern: string }
    | { kind: 'core'; core: string };

export interface UserTarget {
    devicePack?: PackId;
    boardPack?: PackId;
    device?: string;
    board?: string;
    cores?: string[];
}

export interface UserDocs {
    docs: DocRef[];
    root: string;
    /** Folders that matched the target, relative to the root. */
    matched: string[];
    notes: string[];
}

const MAX_DEPTH = 3;
const MAX_FILES = 200;

/** The setting, with `~` expanded; empty → `~/.cmsis-pack-docs/user`. */
export function resolveUserDocsDir(setting: string | undefined, home: string = os.homedir()): string {
    const s = (setting ?? '').trim();
    if (!s) { return path.join(home, '.cmsis-pack-docs', 'user'); }
    return path.resolve(s.replace(/^~(?=$|[\\/])/, home));
}

/** `STM32U5*` → /^STM32U5.*$/i; `?` matches one character. Plain names match exactly. */
export function globToRegex(glob: string): RegExp {
    const re = glob.split('').map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp(`^${re}$`, 'i');
}

/** A folder name: path separators and quotes out; `*` and `?` stay because they are the glob (Windows users use exact names). */
function safeName(s: string): string {
    return s.replace(/[\\/:"<>|]+/g, '_').trim() || '_';
}

/** The folder a scope maps to under the root. */
export function userScopeDir(root: string, scope: UserScope): string {
    switch (scope.kind) {
        case 'all': return root;
        case 'pack': return path.join(root, safeName(scope.vendor), safeName(scope.name));
        case 'vendor': return path.join(root, safeName(scope.vendor));
        case 'device': return path.join(root, 'devices', safeName(scope.pattern));
        case 'board': return path.join(root, 'boards', safeName(scope.pattern));
        case 'core': return path.join(root, 'cores', safeName(scope.core));
    }
}

export function readManifest(dir: string): UserDocsManifest {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, USER_DOCS_MANIFEST), 'utf-8')) as UserDocsManifest;
        return m && typeof m === 'object' ? m : {};
    } catch {
        return {};
    }
}

function writeManifest(dir: string, manifest: UserDocsManifest): void {
    fs.writeFileSync(path.join(dir, USER_DOCS_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}

function listDirs(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
    } catch {
        return [];
    }
}

/** PDFs in `dir` (and sub-folders up to MAX_DEPTH), with their manifest entries. */
function pdfsIn(dir: string, root: string, out: DocRef[], seen: Set<string>, depth = 0, recurse = true): void {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) { return; }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    const manifest = readManifest(dir);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
        if (out.length >= MAX_FILES) { return; }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (recurse && !e.name.startsWith('.')) { pdfsIn(full, root, out, seen, depth + 1, true); }
            continue;
        }
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.pdf') || seen.has(full)) { continue; }
        seen.add(full);
        const meta = manifest[e.name] ?? {};
        let size: number | undefined;
        try { size = fs.statSync(full).size; } catch { size = undefined; }
        out.push({
            id: `user/${fileSlug(e.name)}`,
            title: meta.title?.trim() || e.name.replace(/\.pdf$/i, ''),
            ...(meta.category ? { category: meta.category } : {}),
            ...(meta.revision ? { revision: meta.revision } : {}),
            scope: 'user',
            source: 'user',
            path: full,
            sizeBytes: size,
            cached: false,
            indexed: false,
        });
    }
}

/** The user documents that apply to a target. */
export function collectUserDocs(root: string, target: UserTarget, log: PackDocsLog = silentLog): UserDocs {
    const docs: DocRef[] = [];
    const matched: string[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();
    if (!fs.existsSync(root)) { return { docs, root, matched, notes }; }
    const packs = [target.devicePack, target.boardPack].filter((p): p is PackId => !!p);
    const cores = (target.cores ?? []).map(c => c.toLowerCase());

    // Root-level PDFs apply to everything.
    pdfsIn(root, root, docs, seen, 0, false);
    if (docs.length) { matched.push('.'); }

    for (const top of listDirs(root)) {
        const topDir = path.join(root, top);
        const lower = top.toLowerCase();
        const before = docs.length;
        if (lower === 'devices' || lower === 'boards' || lower === 'cores') {
            for (const sub of listDirs(topDir)) {
                const re = globToRegex(sub);
                const hit = lower === 'devices' ? !!target.device && re.test(target.device)
                    : lower === 'boards' ? !!target.board && re.test(target.board)
                        : cores.some(c => re.test(c));
                if (!hit) { continue; }
                pdfsIn(path.join(topDir, sub), root, docs, seen);
                matched.push(`${top}/${sub}`);
            }
            continue;
        }
        // <Vendor>[/<Pack>]
        const vendorPacks = packs.filter(p => globToRegex(top).test(p.vendor));
        if (!vendorPacks.length) { continue; }
        pdfsIn(topDir, root, docs, seen, 0, false);
        if (docs.length > before) { matched.push(top); }
        for (const sub of listDirs(topDir)) {
            if (!vendorPacks.some(p => globToRegex(sub).test(p.name))) { continue; }
            pdfsIn(path.join(topDir, sub), root, docs, seen);
            matched.push(`${top}/${sub}`);
        }
    }
    if (docs.length >= MAX_FILES) { notes.push(`user docs: only the first ${MAX_FILES} PDFs are listed`); }
    if (docs.length) { log.debug(`user docs: ${docs.length} PDFs from ${root} (${matched.join(', ')})`); }
    return { docs, root, matched, notes };
}

export interface ImportResult {
    dest: string;
    dir: string;
    id: string;
    replaced: boolean;
}

/** Copy a PDF into the folder of a scope and record its metadata in the manifest. */
export function importUserDoc(root: string, scope: UserScope, file: string, meta: UserDocMeta = {}): ImportResult {
    const dir = userScopeDir(root, scope);
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(file);
    const dest = path.join(dir, name);
    const replaced = fs.existsSync(dest);
    if (path.resolve(dest) !== path.resolve(file)) { fs.copyFileSync(file, dest); }
    const manifest = readManifest(dir);
    const clean: UserDocMeta = {
        ...(meta.title?.trim() ? { title: meta.title.trim() } : {}),
        ...(meta.category ? { category: meta.category } : {}),
        ...(meta.revision?.trim() ? { revision: meta.revision.trim() } : {}),
    };
    if (Object.keys(clean).length) { manifest[name] = { ...(manifest[name] ?? {}), ...clean }; }
    if (Object.keys(manifest).length) { writeManifest(dir, manifest); }
    return { dest, dir, id: `user/${fileSlug(name)}`, replaced };
}
