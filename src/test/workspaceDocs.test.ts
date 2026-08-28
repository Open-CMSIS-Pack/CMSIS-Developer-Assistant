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

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PackDocsHost, defaultSettings, silentLog } from '../core/packDocs/host';
import { sortDocs } from '../core/packDocs/pdscBooks';
import { collectWorkspaceDocs } from '../core/packDocs/workspaceDocs';

function hostFor(folders: string[], dirs = defaultSettings.workspaceDocDirs): PackDocsHost {
    return {
        packRoot: '/nowhere',
        storageDir: '/nowhere/store',
        settings: () => ({ ...defaultSettings, workspaceDocDirs: dirs }),
        log: silentLog,
        userAgent: 'cmsis-pack-docs/test',
        workspaceFolders: () => folders,
        findCbuildRunFiles: async () => [],
    };
}

function touch(file: string, content = '%PDF-1.4\n'): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

suite('workspaceDocs', () => {
    test('PDFs in the configured folders become workspace documents; other files and dot-dirs are ignored', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-ws-'));
        touch(path.join(ws, 'docs', 'Board User Manual.pdf'));
        touch(path.join(ws, 'docs', 'sub', 'deeper', 'errata.PDF'));
        touch(path.join(ws, 'docs', 'notes.md'), '# not a pdf');
        touch(path.join(ws, 'docs', '.hidden', 'secret.pdf'));
        touch(path.join(ws, '.agent-artifacts', 'docs', 'rm.pdf'));
        touch(path.join(ws, 'elsewhere', 'ignored.pdf'));

        const { docs, dirs, notes } = collectWorkspaceDocs(hostFor([ws]));
        assert.deepStrictEqual(notes, []);
        assert.deepStrictEqual(dirs, [`${path.basename(ws)}/.agent-artifacts/docs`, `${path.basename(ws)}/docs`]);
        assert.deepStrictEqual(docs.map(d => d.id).sort(), ['workspace/board-user-manual', 'workspace/errata', 'workspace/rm']);
        const um = docs.find(d => d.id === 'workspace/board-user-manual')!;
        assert.strictEqual(um.title, 'Board User Manual');
        assert.strictEqual(um.scope, 'workspace');
        assert.strictEqual(um.source, 'workspace');
        assert.strictEqual(um.path, path.join(ws, 'docs', 'Board User Manual.pdf'));
        assert.strictEqual(um.sizeBytes, 9);
        assert.strictEqual(um.pack, undefined);
    });

    test('missing folders, no workspace and an empty setting yield nothing', () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-ws-'));
        assert.deepStrictEqual(collectWorkspaceDocs(hostFor([ws])), { docs: [], dirs: [], notes: [] });
        assert.deepStrictEqual(collectWorkspaceDocs(hostFor([])), { docs: [], dirs: [], notes: [] });
        touch(path.join(ws, 'docs', 'a.pdf'));
        assert.deepStrictEqual(collectWorkspaceDocs(hostFor([ws], [])).docs, []);
        // A file where a folder is expected is skipped, not an error.
        assert.deepStrictEqual(collectWorkspaceDocs(hostFor([ws], ['docs/a.pdf'])).docs, []);
    });

    test('a second workspace folder contributes its own documents; workspace docs sort after pack docs', () => {
        const a = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-wsa-'));
        const b = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-wsb-'));
        touch(path.join(a, 'docs', 'same.pdf'));
        touch(path.join(b, 'docs', 'same.pdf'));
        const { docs } = collectWorkspaceDocs(hostFor([a, b], ['docs']));
        assert.strictEqual(docs.length, 2);
        assert.deepStrictEqual(docs.map(d => d.id), ['workspace/same', 'workspace/same'], 'dedupeIds suffixes these later');
        const sorted = sortDocs([
            docs[0],
            { id: 'p/x', title: 'x', scope: 'unlisted', source: 'pack', cached: false, indexed: false },
            { id: 'p/y', title: 'y', scope: 'device', source: 'pack', cached: false, indexed: false },
        ]);
        assert.deepStrictEqual(sorted.map(d => d.scope), ['device', 'unlisted', 'workspace']);
    });
});
