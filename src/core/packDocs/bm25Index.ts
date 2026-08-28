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
 * A page-level inverted index per document and BM25 scoring across the
 * documents of one target. Postings are flat `[page, tf, page, tf, …]`
 * arrays (0-based page index) so the JSON on disk stays small.
 */

import { tokenize } from './tokenizer';

export interface DocIndex {
    version: 1;
    docId: string;
    pageCount: number;
    /** Tokens per page. */
    lengths: number[];
    postings: Record<string, number[]>;
}

export function buildIndex(docId: string, pages: string[]): DocIndex {
    const postings: Record<string, number[]> = Object.create(null);
    const lengths: number[] = new Array(pages.length);
    for (let p = 0; p < pages.length; p++) {
        const tokens = tokenize(pages[p]);
        lengths[p] = tokens.length;
        const tf = new Map<string, number>();
        for (const t of tokens) { tf.set(t, (tf.get(t) ?? 0) + 1); }
        for (const [t, c] of tf) {
            const list = postings[t] ?? (postings[t] = []);
            list.push(p, c);
        }
    }
    return { version: 1, docId, pageCount: pages.length, lengths, postings };
}

export interface ScoredPage {
    /** Index into the `indexes` array given to `scorePages`. */
    doc: number;
    /** 1-based page number. */
    page: number;
    score: number;
    matched: string[];
}

export interface Bm25Options {
    k1?: number;
    b?: number;
    /** Multiplier when every query term occurs on the page (only with ≥ 2 terms). */
    allTermsBoost?: number;
    /** Candidates to return. */
    limit?: number;
}

/** BM25 over the pages of several documents; IDF and average length are computed over the whole set. */
export function scorePages(indexes: DocIndex[], terms: string[], opts: Bm25Options = {}): ScoredPage[] {
    const k1 = opts.k1 ?? 1.2;
    const b = opts.b ?? 0.75;
    const allBoost = opts.allTermsBoost ?? 1.5;
    const limit = opts.limit ?? 40;
    if (!terms.length || !indexes.length) { return []; }

    let totalPages = 0;
    let totalTokens = 0;
    for (const ix of indexes) {
        totalPages += ix.pageCount;
        for (const l of ix.lengths) { totalTokens += l; }
    }
    if (!totalPages) { return []; }
    const avgdl = totalTokens / totalPages || 1;

    const scores = new Map<string, { doc: number; page: number; score: number; matched: Set<string> }>();
    for (const term of terms) {
        let df = 0;
        for (const ix of indexes) { df += (ix.postings[term]?.length ?? 0) / 2; }
        if (!df) { continue; }
        const idf = Math.log(1 + (totalPages - df + 0.5) / (df + 0.5));
        indexes.forEach((ix, d) => {
            const list = ix.postings[term];
            if (!list) { return; }
            for (let i = 0; i < list.length; i += 2) {
                const p = list[i], tf = list[i + 1];
                const dl = ix.lengths[p] || 1;
                const s = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
                const key = `${d}:${p}`;
                const entry = scores.get(key) ?? { doc: d, page: p + 1, score: 0, matched: new Set<string>() };
                entry.score += s;
                entry.matched.add(term);
                scores.set(key, entry);
            }
        });
    }

    const out: ScoredPage[] = [];
    for (const e of scores.values()) {
        const score = terms.length > 1 && e.matched.size === terms.length ? e.score * allBoost : e.score;
        out.push({ doc: e.doc, page: e.page, score, matched: [...e.matched] });
    }
    out.sort((x, y) => y.score - x.score || x.doc - y.doc || x.page - y.page);
    return out.slice(0, limit);
}
