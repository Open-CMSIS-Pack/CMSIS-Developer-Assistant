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
 * PDF → one text string per page.
 *
 * The test version uses poppler's `pdftotext -layout`, spawned like the
 * CMSIS Developer Assistant spawns pyOCD: it is fast (a 3 600-page reference
 * manual in about four seconds), keeps register tables legible, and emits a
 * form feed between pages. A bundled pdfjs extractor is the planned fallback
 * for machines without poppler.
 */

import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { PackDocsLog, PackDocsSettings, silentLog } from './host';

export interface ExtractResult {
    pages: string[];
    extractor: string;
    ms: number;
}

export interface PdfExtractor {
    readonly name: string;
    available(): Promise<{ ok: boolean; detail: string }>;
    extract(file: string, opts?: { timeoutMs?: number; log?: PackDocsLog }): Promise<ExtractResult>;
}

/** Split pdftotext output on form feeds; the trailing feed leaves an empty last segment. */
export function splitPages(output: string): string[] {
    const parts = output.split('\f');
    if (parts.length > 1 && parts[parts.length - 1].trim() === '') { parts.pop(); }
    return parts;
}

export class PdftotextExtractor implements PdfExtractor {
    readonly name = 'pdftotext';
    private availability?: Promise<{ ok: boolean; detail: string }>;

    constructor(private readonly command: string = 'pdftotext') { }

    available(): Promise<{ ok: boolean; detail: string }> {
        if (!this.availability) {
            this.availability = new Promise(resolve => {
                let out = '';
                let child;
                try {
                    child = spawn(this.command, ['-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
                } catch (e) {
                    resolve({ ok: false, detail: `${this.command}: ${e}` });
                    return;
                }
                child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
                child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
                child.on('error', (e) => resolve({ ok: false, detail: `${this.command}: ${e.message}` }));
                child.on('close', () => {
                    const m = out.match(/pdftotext version ([^\s]+)/);
                    resolve(m ? { ok: true, detail: `${this.command} ${m[1]}` } : { ok: false, detail: `${this.command} did not report a version: ${out.trim().slice(0, 200)}` });
                });
            });
        }
        return this.availability;
    }

    extract(file: string, opts: { timeoutMs?: number; log?: PackDocsLog } = {}): Promise<ExtractResult> {
        const log = opts.log ?? silentLog;
        const timeoutMs = opts.timeoutMs ?? 120_000;
        const started = Date.now();
        return new Promise((resolve, reject) => {
            const args = ['-layout', '-enc', 'UTF-8', file, '-'];
            log.debug(`spawn ${this.command} ${args.join(' ')}`);
            const child = spawn(this.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const chunks: Buffer[] = [];
            let stderr = '';
            let done = false;
            const timer = setTimeout(() => {
                if (done) { return; }
                done = true;
                child.kill();
                reject(new Error(`${this.command} timed out after ${timeoutMs} ms on ${file}`));
            }, timeoutMs);
            child.stdout.on('data', (d: Buffer) => chunks.push(d));
            child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            child.on('error', (e) => {
                if (done) { return; }
                done = true;
                clearTimeout(timer);
                reject(new Error(`${this.command} failed to start: ${e.message}`));
            });
            child.on('close', (code) => {
                if (done) { return; }
                done = true;
                clearTimeout(timer);
                const text = Buffer.concat(chunks).toString('utf-8');
                if (code !== 0 && !text) {
                    reject(new Error(`${this.command} exited with ${code}: ${stderr.trim().slice(0, 300)}`));
                    return;
                }
                if (stderr.trim()) { log.debug(`${this.command} stderr: ${stderr.trim().slice(0, 300)}`); }
                const pages = splitPages(text);
                const ms = Date.now() - started;
                log.debug(`${this.command}: ${pages.length} pages, ${(text.length / 1024 / 1024).toFixed(1)} MB text in ${ms} ms`);
                resolve({ pages, extractor: this.name, ms });
            });
        });
    }
}

/** The subset of pdf.js's text item this extractor reads. */
interface TextItemLike {
    str: string;
    transform?: number[];
    width?: number;
    height?: number;
    hasEOL?: boolean;
}

/**
 * Rebuild lines from pdf.js text items — the analogue of `pdftotext -layout`
 * for register tables: items on one baseline (y within `tolerance`) form a
 * line ordered by x, and a horizontal gap wider than ~1.5 em becomes two
 * spaces so table columns stay separable. Exported for the tests.
 */
export function itemsToPageText(items: TextItemLike[], tolerance = 2): string {
    type Placed = { x: number; y: number; w: number; h: number; str: string };
    const placed: Placed[] = [];
    for (const it of items) {
        if (!it.str || !it.transform) { continue; }
        placed.push({ x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: it.height ?? Math.abs(it.transform[3]) ?? 10, str: it.str });
    }
    if (!placed.length) { return ''; }
    // Top of the page first (PDF y grows upwards), then left to right.
    placed.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines: Placed[][] = [];
    for (const p of placed) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last[0].y - p.y) <= Math.max(tolerance, last[0].h * 0.4)) {
            last.push(p);
        } else {
            lines.push([p]);
        }
    }
    const out: string[] = [];
    for (const line of lines) {
        line.sort((a, b) => a.x - b.x);
        let text = '';
        let cursor = line[0].x;
        for (const p of line) {
            const gap = p.x - cursor;
            const em = p.h || 10;
            if (text) {
                if (gap > 1.5 * em) { text += '  '; }
                else if (gap > 0.15 * em && !text.endsWith(' ') && !p.str.startsWith(' ')) { text += ' '; }
            }
            text += p.str;
            cursor = p.x + p.w;
        }
        out.push(text.replace(/[ \t]+$/g, ''));
    }
    return out.join('\n') + '\n';
}

/**
 * The bundled extractor: pdf.js (legacy build, pure JavaScript), so a host
 * without poppler — most Windows machines — indexes documents too. Text
 * only: no fonts are rendered, no canvas is needed. Loaded on first use
 * through a dynamic import, which keeps the 1 MB library out of the
 * activation path.
 */
/** What this extractor uses of pdf.js — typed locally, since the library is ESM and this module is CommonJS. */
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

export class PdfjsExtractor implements PdfExtractor {
    readonly name = 'pdfjs';
    private lib?: Promise<PdfjsLib>;

    private load(): Promise<PdfjsLib> {
        if (!this.lib) {
            this.lib = (import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfjsLib>).then((lib) => {
                // Plain Node runs pdf.js on the main thread with no worker file.
                // VS Code's extension host is Electron, which pdf.js does not
                // take for Node, so it insists on a worker source: point it at
                // the shipped worker module — with no Worker global it is
                // imported as a "fake worker" on this thread, same effect.
                if (!lib.GlobalWorkerOptions.workerSrc) {
                    try {
                        lib.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')).href;
                    } catch {
                        // Not resolvable: pdf.js will say so on the first extraction.
                    }
                }
                return lib;
            });
        }
        return this.lib;
    }

    async available(): Promise<{ ok: boolean; detail: string }> {
        try {
            const lib = await this.load();
            return { ok: true, detail: `pdf.js ${lib.version} (bundled)` };
        } catch (e) {
            return { ok: false, detail: `pdf.js failed to load: ${e instanceof Error ? e.message : e}` };
        }
    }

    async extract(file: string, opts: { timeoutMs?: number; log?: PackDocsLog } = {}): Promise<ExtractResult> {
        const log = opts.log ?? silentLog;
        const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
        const started = Date.now();
        const lib = await this.load();
        const data = new Uint8Array(await fs.promises.readFile(file));
        const task = lib.getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
        const pages: string[] = [];
        try {
            const doc = await task.promise;
            for (let i = 1; i <= doc.numPages; i++) {
                if (Date.now() > deadline) {
                    throw new Error(`pdf.js timed out after ${opts.timeoutMs ?? 120_000} ms on ${file} (page ${i} of ${doc.numPages})`);
                }
                const page = await doc.getPage(i);
                const content = await page.getTextContent();
                pages.push(itemsToPageText(content.items as TextItemLike[]));
                page.cleanup();
            }
        } finally {
            await task.destroy();
        }
        const ms = Date.now() - started;
        log.debug(`pdf.js: ${pages.length} pages in ${ms} ms`);
        return { pages, extractor: this.name, ms };
    }
}

export function selectExtractor(settings: PackDocsSettings): PdfExtractor {
    // pdf.js is bundled and the default; poppler stays available for users
    // who prefer its `-layout` text (see the search benchmark notes).
    if (settings.extractor === 'pdftotext') {
        return new PdftotextExtractor(settings.pdftotextPath || 'pdftotext');
    }
    return new PdfjsExtractor();
}
