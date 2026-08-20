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

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Content hash of a directory tree, used to detect hand edits to vendored
 * files. Shared by `scripts/sync-skills.ts` (writes the hash into the lock
 * file) and `src/test/skillCatalog.test.ts` (recomputes it) so both sides
 * use exactly one definition.
 *
 * Hashes over raw bytes — a checkout with `core.autocrlf=true` on Windows
 * will not match a lock written on a LF checkout. CI runs with autocrlf off.
 */
export function listFilesRecursive(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                files.push(full);
            }
        }
    };
    walk(root);
    return files;
}

export function hashTree(root: string): string {
    const hash = createHash('sha256');
    const files = listFilesRecursive(root)
        .map(full => ({ full, rel: path.relative(root, full).split(path.sep).join('/') }))
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    for (const { full, rel } of files) {
        hash.update(rel);
        hash.update('\0');
        hash.update(fs.readFileSync(full));
        hash.update('\0');
    }
    return hash.digest('hex');
}
