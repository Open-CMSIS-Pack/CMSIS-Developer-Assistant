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
 *
 * Two fields per page: the body and the heading. A register page's body
 * rarely spells the words its heading uses ("RCC source control register"
 * vs. bit descriptions), so the heading is indexed on its own and weighted
 * — a heading-only match is a candidate, not an afterthought. Measured on
 * RM0455 with queries from the SVD descriptions: R@1 25 % → 68 %
 * (Open-CMSIS-Pack/CMSIS-Developer-Assistant #29).
 */

import { tokenize } from './tokenizer';

export const INDEX_VERSION = 2;

export interface IndexablePage {
    text: string;
    heading: string;
}

export interface DocIndex {
    /** 1: body only (0.x); 2: adds `headingPostings`. Older files are rebuilt from the page text. */
    version: 1 | 2;
    docId: string;
    pageCount: number;
    /** Body tokens per page. */
    lengths: number[];
    postings: Record<string, number[]>;
    /** Heading tokens, same layout; absent in version 1. */
    headingPostings?: Record<string, number[]>;
}

function addPostings(postings: Record<string, number[]>, page: number, tokens: string[]): void {
    const tf = new Map<string, number>();
    for (const t of tokens) { tf.set(t, (tf.get(t) ?? 0) + 1); }
    for (const [t, c] of tf) {
        const list = postings[t] ?? (postings[t] = []);
        list.push(page, c);
    }
}

export function buildIndex(docId: string, pages: IndexablePage[]): DocIndex {
    const postings: Record<string, number[]> = Object.create(null);
    const headingPostings: Record<string, number[]> = Object.create(null);
    const lengths: number[] = new Array(pages.length);
    for (let p = 0; p < pages.length; p++) {
        const tokens = tokenize(pages[p].text);
        lengths[p] = tokens.length;
        addPostings(postings, p, tokens);
        if (pages[p].heading) {
            addPostings(headingPostings, p, tokenize(pages[p].heading));
        }
    }
    return { version: INDEX_VERSION, docId, pageCount: pages.length, lengths, postings, headingPostings };
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
    /**
     * Weight of a term found in the page heading, on top of the body score.
     * 0 restores body-only ranking (version-1 behaviour); default 5 — the
     * best MRR on RM0455 in `scripts/search-benchmark.ts` (3 is within a point).
     */
    headingWeight?: number;
    /** Per-term weight (query expansions are worth less than the words the user typed); default 1. */
    termWeights?: Record<string, number>;
    /** Candidates to return. */
    limit?: number;
}

/** BM25 over the pages of several documents; IDF and average length are computed over the whole set. */
export function scorePages(indexes: DocIndex[], terms: string[], opts: Bm25Options = {}): ScoredPage[] {
    const k1 = opts.k1 ?? 1.2;
    const b = opts.b ?? 0.75;
    const allBoost = opts.allTermsBoost ?? 1.5;
    const headingWeight = opts.headingWeight ?? 5;
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
    const bump = (d: number, p: number, term: string, s: number) => {
        const key = `${d}:${p}`;
        const entry = scores.get(key) ?? { doc: d, page: p + 1, score: 0, matched: new Set<string>() };
        entry.score += s;
        entry.matched.add(term);
        scores.set(key, entry);
    };
    for (const term of terms) {
        const weight = opts.termWeights?.[term] ?? 1;
        // Document frequency over the body; a heading term is rarer still, so
        // the body IDF is a conservative choice for both fields.
        let df = 0;
        for (const ix of indexes) { df += (ix.postings[term]?.length ?? 0) / 2; }
        if (headingWeight > 0) {
            for (const ix of indexes) { if (!ix.postings[term]) { df += (ix.headingPostings?.[term]?.length ?? 0) / 2; } }
        }
        if (!df) { continue; }
        const idf = Math.log(1 + (totalPages - df + 0.5) / (df + 0.5));
        indexes.forEach((ix, d) => {
            const list = ix.postings[term];
            if (list) {
                for (let i = 0; i < list.length; i += 2) {
                    const p = list[i], tf = list[i + 1];
                    const dl = ix.lengths[p] || 1;
                    bump(d, p, term, weight * idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl)));
                }
            }
            const heads = headingWeight > 0 ? ix.headingPostings?.[term] : undefined;
            if (heads) {
                // Headings are one line: tf saturation without length normalisation.
                for (let i = 0; i < heads.length; i += 2) {
                    const p = heads[i], tf = heads[i + 1];
                    bump(d, p, term, weight * headingWeight * idf * (tf * (k1 + 1)) / (tf + k1));
                }
            }
        });
    }

    // The all-terms boost is about the words the user typed; expansions
    // (weight < 1) are optional extras and do not withhold it.
    const primary = terms.filter(t => (opts.termWeights?.[t] ?? 1) >= 1);
    const out: ScoredPage[] = [];
    for (const e of scores.values()) {
        const allPrimary = primary.length > 1 && primary.every(t => e.matched.has(t));
        const score = allPrimary ? e.score * allBoost : e.score;
        out.push({ doc: e.doc, page: e.page, score, matched: [...e.matched] });
    }
    out.sort((x, y) => y.score - x.score || x.doc - y.doc || x.page - y.page);
    return out.slice(0, limit);
}
