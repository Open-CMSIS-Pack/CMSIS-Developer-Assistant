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
 * Search-quality benchmark for `search_target_docs` — opt-in, never part of
 * `npm test` (it needs a real reference manual).
 *
 *   npm run bench:search -- --pages <doc.pages.jsonl> --svd <device.svd> \
 *       [--heading-weight 0 --heading-weight 3] [--post-boost 1 --post-boost 1.5] [--limit 10]
 *
 * Gold: the manual pages whose heading names a register in parentheses —
 * `8.7.2 RCC HSI calibration register (RCC_HSICFGR)` — for a register the
 * SVD declares (contents pages excluded). Queries come from the SVD, not
 * from the manual's headings:
 *
 *   (a) the register's SVD <description> alone, when it does not contain the
 *       register name — the hard set;
 *   (b) description + register name.
 *
 * Reports R@1, R@3 and MRR (over the top `limit` hits) per configuration,
 * as a Markdown table. Issue Open-CMSIS-Pack/CMSIS-Developer-Assistant #29
 * carries the numbers that motivated the heading field.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildIndex } from '../src/core/packDocs/bm25Index';
import { LoadedDoc, PageRecord } from '../src/core/packDocs/pageStore';
import { DocRef } from '../src/core/packDocs/pdscBooks';
import { isTocLike, searchLoaded } from '../src/core/packDocs/search';
import { loadSvd, registersOf } from '../src/core/packDocs/svdLite';

interface Args {
    pages: string;
    svd: string;
    headingWeights: number[];
    postBoosts: number[];
    limit: number;
    verbose: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { pages: '', svd: '', headingWeights: [], postBoosts: [], limit: 10, verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--pages') { args.pages = next(); }
        else if (a === '--svd') { args.svd = next(); }
        else if (a === '--heading-weight') { args.headingWeights.push(Number(next())); }
        else if (a === '--post-boost') { args.postBoosts.push(Number(next())); }
        else if (a === '--limit') { args.limit = Number(next()); }
        else if (a === '--verbose') { args.verbose = true; }
        else { throw new Error(`unknown argument ${a}`); }
    }
    if (!args.pages || !args.svd) { throw new Error('usage: --pages <doc.pages.jsonl> --svd <device.svd> [--heading-weight n]* [--post-boost n]*'); }
    if (!args.headingWeights.length) { args.headingWeights = [0, 3]; }
    if (!args.postBoosts.length) { args.postBoosts = [1.5]; }
    return args;
}

interface Query { name: string; text: string; gold: Set<number> }

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const pages = fs.readFileSync(args.pages, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as PageRecord);
    const svd = loadSvd(args.svd);

    // Gold pages per register full name.
    const byName = new Map<string, Set<number>>();
    const headingReg = /\(([A-Za-z][A-Za-z0-9_]*)\)\s*$/;
    for (const page of pages) {
        const m = headingReg.exec(page.heading);
        if (!m || isTocLike(page.text)) { continue; }
        const set = byName.get(m[1]) ?? new Set<number>();
        set.add(page.p);
        byName.set(m[1], set);
    }

    const setA: Query[] = [];
    const setB: Query[] = [];
    const seen = new Set<string>();
    for (const peripheral of svd.peripherals) {
        for (const reg of registersOf(svd, peripheral)) {
            const bare = reg.name.replace(/\..*$/, '');
            const full = bare.startsWith(`${peripheral.name}_`) ? bare : `${peripheral.name}_${bare}`;
            const gold = byName.get(full) ?? byName.get(bare);
            if (!gold || seen.has(full)) { continue; }
            seen.add(full);
            const description = (reg.description ?? '').replace(/\s+/g, ' ').trim();
            if (!description) { continue; }
            const mentionsName = description.toLowerCase().includes(bare.toLowerCase()) || description.toLowerCase().includes(full.toLowerCase());
            if (!mentionsName) { setA.push({ name: full, text: description, gold }); }
            setB.push({ name: full, text: `${description} ${full}`, gold });
        }
    }

    const ref: DocRef = {
        id: 'bench/rm', title: path.basename(args.pages), category: 'manual', scope: 'device', pack: 'Bench::RM@1.0.0',
        packId: { vendor: 'Bench', name: 'RM', version: '1.0.0' }, source: 'pack', path: args.pages, cached: true, indexed: true, pages: pages.length,
    };
    const t0 = Date.now();
    const loaded: LoadedDoc = {
        doc: ref,
        meta: { version: 2, docId: ref.id, file: args.pages, size: 0, mtimeMs: 0, sha256: '', pageCount: pages.length, extractor: 'bench', extractMs: 0, createdAt: '' },
        index: buildIndex(ref.id, pages),
        pages: () => pages,
    };
    console.log(`${pages.length} pages, ${byName.size} register headings, ${svd.peripherals.length} SVD peripherals; ` +
        `set (a) ${setA.length} description-only queries, set (b) ${setB.length} description+name queries; index built in ${Date.now() - t0} ms\n`);

    const evaluate = (queries: Query[], headingWeight: number, headingPostBoost: number) => {
        let r1 = 0, r3 = 0, mrr = 0;
        const misses: string[] = [];
        for (const q of queries) {
            const hits = searchLoaded([loaded], q.text, args.limit, undefined, { headingWeight, headingPostBoost }).hits;
            const rank = hits.findIndex(h => q.gold.has(h.page));
            if (rank === 0) { r1++; }
            if (rank >= 0 && rank < 3) { r3++; }
            if (rank >= 0) { mrr += 1 / (rank + 1); } else { misses.push(q.name); }
        }
        const n = queries.length || 1;
        return { r1: r1 / n, r3: r3 / n, mrr: mrr / n, misses };
    };
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

    for (const [label, queries] of [['(a) SVD description only', setA], ['(b) description + register name', setB]] as const) {
        console.log(`### ${label} — ${queries.length} queries\n`);
        console.log('| heading weight | post boost | R@1 | R@3 | MRR |');
        console.log('|---|---|---|---|---|');
        for (const hw of args.headingWeights) {
            for (const pb of args.postBoosts) {
                const t1 = Date.now();
                const r = evaluate(queries, hw, pb);
                console.log(`| ${hw} | ${pb} | ${pct(r.r1)} | ${pct(r.r3)} | ${r.mrr.toFixed(3)} |${args.verbose ? ` ${Date.now() - t1} ms, misses: ${r.misses.slice(0, 8).join(', ')}` : ''}`);
            }
        }
        console.log();
    }
}

main();
