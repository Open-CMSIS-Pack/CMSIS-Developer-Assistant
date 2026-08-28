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

export function selectExtractor(settings: PackDocsSettings): PdfExtractor {
    // `auto` and `pdftotext` are the same in the test version; the bundled
    // fallback arrives with the pdfjs work package.
    return new PdftotextExtractor(settings.pdftotextPath || 'pdftotext');
}
