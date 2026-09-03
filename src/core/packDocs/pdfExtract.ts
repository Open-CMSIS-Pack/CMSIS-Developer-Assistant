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
 * `PdfjsExtractor` is the bundled default: pdf.js on a worker thread of its
 * own (`pdfWorker.ts`), nothing to install. `PdftotextExtractor` spawns
 * poppler's `pdftotext -layout` like the CMSIS Developer Assistant spawns
 * pyOCD: fast (a 3 600-page reference manual in about four seconds), with
 * legible register tables and a form feed between pages, for users who have
 * it and prefer its text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import { PackDocsLog, PackDocsSettings, silentLog } from './host';
import type { PdfWorkerCall, PdfWorkerRequest, PdfWorkerResponse } from './pdfWorker';

export { itemsToPageText } from './pdfText';
export type { TextItemLike } from './pdfText';

export interface ExtractResult {
    pages: string[];
    extractor: string;
    ms: number;
}

export interface PdfExtractor {
    readonly name: string;
    available(): Promise<{ ok: boolean; detail: string }>;
    extract(file: string, opts?: { timeoutMs?: number; log?: PackDocsLog }): Promise<ExtractResult>;
    /** Release what the extractor holds (a worker thread); a later call starts it again. */
    dispose?(): void;
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

/**
 * Locate the worker entry beside this module: `dist/pdfWorker.js` in the
 * bundle, `out/src/core/packDocs/pdfWorker.js` from tsc, `pdfWorker.ts` when a
 * script runs the sources through tsx.
 */
function workerEntry(): string {
    for (const name of ['pdfWorker.js', 'pdfWorker.ts']) {
        const candidate = path.join(__dirname, name);
        if (fs.existsSync(candidate)) { return candidate; }
    }
    throw new Error(`pdf.js worker not found beside ${__dirname}`);
}

type Pending = { resolve: (r: PdfWorkerResponse) => void; reject: (e: Error) => void };

/**
 * The bundled extractor: pdf.js (legacy build, pure JavaScript), so a host
 * without poppler — most Windows machines — indexes documents too. The
 * library runs on a `worker_threads` worker (`pdfWorker.ts`): a realm of its
 * own, out of reach of the extension host's other extensions and their
 * prototype patches, which pdf.js refuses to start on. The thread is started
 * on the first request, kept for the next document, and terminated after a
 * minute idle — or at once when an extraction times out, which is the only
 * way to stop pdf.js mid-document.
 */
export class PdfjsExtractor implements PdfExtractor {
    readonly name = 'pdfjs';
    private worker?: Worker;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private idleTimer?: NodeJS.Timeout;
    private availability?: { ok: boolean; detail: string };

    constructor(private readonly idleMs = 60_000) { }

    private spawn(): Worker {
        if (this.worker) { return this.worker; }
        const worker = new Worker(workerEntry());
        worker.on('message', (msg: PdfWorkerResponse) => {
            const p = this.pending.get(msg.id);
            if (!p) { return; }
            this.pending.delete(msg.id);
            p.resolve(msg);
            this.settle();
        });
        worker.on('error', (e: Error) => this.drop(worker, new Error(`pdf.js worker failed: ${e.message}`)));
        worker.on('exit', (code) => this.drop(worker, new Error(`pdf.js worker exited with code ${code}`)));
        // Idle, the thread must not keep a script's process alive; ref'd while a request is out.
        worker.unref();
        this.worker = worker;
        return worker;
    }

    /** Forget a worker that is gone (or going) and fail what it still owed. */
    private drop(worker: Worker, reason: Error): void {
        if (this.worker !== worker) { return; }
        this.worker = undefined;
        clearTimeout(this.idleTimer);
        const owed = [...this.pending.values()];
        this.pending.clear();
        for (const p of owed) { p.reject(reason); }
    }

    /** Nothing pending: let the process exit without us, and retire the thread after a while. */
    private settle(): void {
        if (this.pending.size || !this.worker) { return; }
        this.worker.unref();
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.dispose(), this.idleMs);
        this.idleTimer.unref();
    }

    private request(call: PdfWorkerCall, timeoutMs: number, timeoutMessage: string): Promise<PdfWorkerResponse> {
        const id = this.nextId++;
        const worker = this.spawn();
        clearTimeout(this.idleTimer);
        worker.ref();
        return new Promise((resolve, reject) => {
            const timedOut = () => {
                if (!this.pending.delete(id)) { return; }
                reject(new Error(timeoutMessage));
                // Terminating the thread is what stops pdf.js; anything else it
                // owed fails with it and the next request starts a fresh one.
                this.drop(worker, new Error(`pdf.js worker terminated: ${timeoutMessage}`));
                void worker.terminate();
            };
            // A zero timer still races the worker's reply (a warm thread answers
            // within one Windows scheduler tick), so a non-positive timeout is
            // decided here rather than on the event loop.
            const timer = timeoutMs > 0 ? setTimeout(timedOut, timeoutMs) : undefined;
            this.pending.set(id, {
                resolve: (r) => { clearTimeout(timer); resolve(r); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            const request: PdfWorkerRequest = { id, ...call };
            worker.postMessage(request);
            if (!timer) { timedOut(); }
        });
    }

    async available(): Promise<{ ok: boolean; detail: string }> {
        if (this.availability) { return this.availability; }
        let result: { ok: boolean; detail: string };
        try {
            const r = await this.request({ kind: 'version' }, 30_000, 'pdf.js worker did not load within 30 s');
            result = !r.ok ? { ok: false, detail: `pdf.js failed to load: ${r.error}` }
                : 'version' in r ? { ok: true, detail: `pdf.js ${r.version} (bundled, worker thread)` }
                    : { ok: false, detail: 'pdf.js worker answered without a version' };
        } catch (e) {
            result = { ok: false, detail: `pdf.js worker failed to start: ${e instanceof Error ? e.message : e}` };
        }
        // Only a working library is remembered; a failure is retried on the next call.
        if (result.ok) { this.availability = result; }
        return result;
    }

    async extract(file: string, opts: { timeoutMs?: number; log?: PackDocsLog } = {}): Promise<ExtractResult> {
        const log = opts.log ?? silentLog;
        const timeoutMs = opts.timeoutMs ?? 120_000;
        const started = Date.now();
        const r = await this.request({ kind: 'extract', file }, timeoutMs, `pdf.js timed out after ${timeoutMs} ms on ${file}`);
        if (!r.ok) { throw new Error(`pdf.js: ${r.error}`); }
        if (!('pages' in r)) { throw new Error('pdf.js worker answered without pages'); }
        const ms = Date.now() - started;
        log.debug(`pdf.js: ${r.pages.length} pages in ${ms} ms`);
        return { pages: r.pages, extractor: this.name, ms };
    }

    /** Stop the worker thread; the next request starts a new one. */
    dispose(): void {
        clearTimeout(this.idleTimer);
        const worker = this.worker;
        if (!worker) { return; }
        this.drop(worker, new Error('pdf.js extractor disposed'));
        void worker.terminate();
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
