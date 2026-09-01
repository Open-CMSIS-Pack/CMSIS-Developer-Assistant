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
 * The pdf.js side of `PdfjsExtractor`, run on a `worker_threads` worker.
 *
 * pdf.js refuses to start when `Array.prototype` or `Object.prototype`
 * carries an enumerable property — its worker iterates `for...in` over an
 * empty array and throws on anything it finds. VS Code's extension host is
 * one process shared by every extension, and some patch the prototypes
 * (the CMSIS csolution extension assigns `Array.prototype.groupedBy`), so
 * on the host's thread every extraction fails with "The `Array.prototype`
 * contains unexpected enumerable property". A worker thread is a fresh V8
 * realm with pristine prototypes: pdf.js runs here untouched by the host's
 * neighbours. The main thread posts a file path and receives the page
 * texts; a timed-out extraction is terminated with the thread, which a
 * same-thread pdf.js could only notice between pages.
 *
 * esbuild bundles this file as its own entry point (`dist/pdfWorker.js`);
 * tsc emits it beside `pdfExtract.js` for the tests. Both are found by
 * `PdfjsExtractor` next to its own module.
 */

import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { parentPort } from 'worker_threads';
import { itemsToPageText, TextItemLike } from './pdfText';

/** What the main thread asks of the worker. */
export type PdfWorkerCall =
    | { kind: 'version' }
    | { kind: 'extract'; file: string };

/** Main thread → worker: a call with the id its answer will carry. */
export type PdfWorkerRequest = PdfWorkerCall & { id: number };

/** Worker → main thread, one per request. */
export type PdfWorkerResponse =
    | { id: number; ok: true; version: string }
    | { id: number; ok: true; pages: string[] }
    | { id: number; ok: false; error: string };

/** What this worker uses of pdf.js — typed locally, since the library is ESM and this module is CommonJS. */
interface PdfjsLib {
    version: string;
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(params: { data: Uint8Array; disableFontFace?: boolean; useSystemFonts?: boolean; verbosity?: number }): {
        promise: Promise<PdfjsDocument>;
        destroy(): Promise<void>;
    };
}
interface PdfjsDocument {
    numPages: number;
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): void }>;
}

let lib: Promise<PdfjsLib> | undefined;

/** pdf.js (legacy build, pure JavaScript), loaded once per worker through a dynamic import. */
function load(): Promise<PdfjsLib> {
    if (!lib) {
        lib = (import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfjsLib>).then((l) => {
            // pdf.js has no Worker global here and imports its worker module
            // on this thread as a "fake worker" from `workerSrc`. Where it
            // detects Node it presets `workerSrc` to "./pdf.worker.mjs" —
            // right beside pdf.mjs in node_modules, but resolved against
            // dist/pdfWorker.js once esbuild has inlined the library, where
            // no such file exists; in the extension host's main thread it
            // detects Electron instead and leaves `workerSrc` empty. Set it
            // unconditionally to the shipped worker module's absolute URL.
            try {
                l.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')).href;
            } catch {
                // Not resolvable: pdf.js will say so on the first extraction.
            }
            return l;
        });
    }
    return lib;
}

/** One text string per page. Text only: no fonts are rendered, no canvas is needed. */
async function extract(file: string): Promise<string[]> {
    const pdfjs = await load();
    const data = new Uint8Array(await fs.promises.readFile(file));
    const task = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const pages: string[] = [];
    try {
        const doc = await task.promise;
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            pages.push(itemsToPageText(content.items as TextItemLike[]));
            page.cleanup();
        }
    } finally {
        await task.destroy();
    }
    return pages;
}

async function handle(req: PdfWorkerRequest): Promise<PdfWorkerResponse> {
    try {
        if (req.kind === 'version') {
            return { id: req.id, ok: true, version: (await load()).version };
        }
        return { id: req.id, ok: true, pages: await extract(req.file) };
    } catch (e) {
        return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

// Only when started as a worker; requiring the module elsewhere (coverage, a
// type import) must do nothing.
if (parentPort) {
    const port = parentPort;
    // Requests are served in order: the main thread's timeout is per request,
    // and interleaving pages of two documents would gain nothing on one thread.
    let queue: Promise<void> = Promise.resolve();
    port.on('message', (req: PdfWorkerRequest) => {
        queue = queue.then(async () => { port.postMessage(await handle(req)); });
    });
}
