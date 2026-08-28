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
 * Query → ranked pages with snippets, over the loaded documents of one
 * target. BM25 picks the candidates; the page text of the top candidates
 * then applies the heading, phrase and category boosts and yields the
 * snippet.
 */

import { scorePages } from './bm25Index';
import { PackDocsLog, silentLog } from './host';
import { DocRef } from './pdscBooks';
import { LoadedDoc, PageRecord } from './pageStore';
import { parseQuery, tokenize } from './tokenizer';

export interface SearchHit {
    doc: DocRef;
    page: number;
    heading: string;
    score: number;
    snippet: string;
    matched: string[];
}

export interface SearchOutcome {
    hits: SearchHit[];
    terms: string[];
    phrases: string[];
    candidates: number;
    ms: number;
}

/** A heading match is the strongest signal that this page *describes* the thing rather than lists it. */
const HEADING_BOOST = 3.0;
const PHRASE_BOOST = 2.0;
const MANUAL_BOOST = 1.1;
/** Table-of-contents and index pages mention everything once and explain nothing. */
const TOC_PENALTY = 0.3;

/** Dotted leaders (`. . . . 552` / `........ 552`) four or more times → a contents or index page. */
export function isTocLike(text: string): boolean {
    const leaders = text.match(/(?:\.\s){4,}|\.{5,}/g);
    return !!leaders && leaders.length >= 4;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A regex matching any of the query words or phrases, case-insensitively. */
export function matchRegex(words: string[], phrases: string[]): RegExp | undefined {
    const alts = [...phrases, ...words].filter(w => w.length >= 2).map(escapeRe);
    if (!alts.length) { return undefined; }
    // Longest first so a phrase wins over one of its words.
    alts.sort((a, b) => b.length - a.length);
    return new RegExp(alts.join('|'), 'gi');
}

/** ~`width` characters around the densest cluster of matches, whitespace collapsed, matches marked «». */
export function makeSnippet(text: string, re: RegExp | undefined, width = 400): string {
    const collapsed = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
    if (!collapsed) { return ''; }
    if (!re) { return collapsed.slice(0, width); }
    const positions: { start: number; word: string }[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(collapsed)) !== null && positions.length < 200) {
        positions.push({ start: m.index, word: m[0].toLowerCase() });
        if (m[0].length === 0) { re.lastIndex++; }
    }
    let bestStart = 0;
    if (positions.length) {
        let best = -1;
        for (const p of positions) {
            const start = Math.max(0, p.start - Math.floor(width / 3));
            const end = start + width;
            const distinct = new Set(positions.filter(q => q.start >= start && q.start < end).map(q => q.word)).size;
            const count = positions.filter(q => q.start >= start && q.start < end).length;
            const score = distinct * 10 + count;
            if (score > best) { best = score; bestStart = start; }
        }
    }
    // Snap to a word boundary.
    if (bestStart > 0) {
        const sp = collapsed.lastIndexOf(' ', bestStart + 20);
        if (sp > bestStart - 40 && sp >= 0) { bestStart = sp + 1; }
    }
    let window = collapsed.slice(bestStart, bestStart + width);
    if (bestStart + width < collapsed.length) {
        const cut = window.lastIndexOf(' ');
        if (cut > width * 0.7) { window = window.slice(0, cut); }
    }
    re.lastIndex = 0;
    const marked = window.replace(re, (w) => `«${w}»`);
    return `${bestStart > 0 ? '…' : ''}${marked}${bestStart + width < collapsed.length ? '…' : ''}`;
}

export function searchLoaded(docs: LoadedDoc[], query: string, limit: number, log: PackDocsLog = silentLog): SearchOutcome {
    const started = Date.now();
    const parsed = parseQuery(query);
    if (!parsed.terms.length || !docs.length) {
        return { hits: [], terms: parsed.terms, phrases: parsed.phrases, candidates: 0, ms: Date.now() - started };
    }
    const candidates = scorePages(docs.map(d => d.index), parsed.terms, { limit: Math.max(limit * 5, 30) });
    log.debug(`query terms [${parsed.terms.join(', ')}]${parsed.phrases.length ? ` phrases [${parsed.phrases.map(p => `"${p}"`).join(', ')}]` : ''} → ${candidates.length} candidate pages in ${Date.now() - started} ms`);

    const re = matchRegex(parsed.words, parsed.phrases);
    const pageCache = new Map<number, PageRecord[]>();
    const pagesOf = (d: number) => {
        let pages = pageCache.get(d);
        if (!pages) { pages = docs[d].pages(); pageCache.set(d, pages); }
        return pages;
    };

    const scored: SearchHit[] = candidates.map(c => {
        const loaded = docs[c.doc];
        const page = pagesOf(c.doc)[c.page - 1];
        const text = page?.text ?? '';
        const heading = page?.heading ?? '';
        let score = c.score;
        if (heading) {
            const headingTokens = new Set(tokenize(heading));
            if (parsed.terms.some(t => headingTokens.has(t))) { score *= HEADING_BOOST; }
        }
        if (parsed.phrases.length) {
            const lower = text.replace(/\s+/g, ' ').toLowerCase();
            if (parsed.phrases.some(p => lower.includes(p))) { score *= PHRASE_BOOST; }
        }
        if (loaded.doc.category === 'manual') { score *= MANUAL_BOOST; }
        if (isTocLike(text)) { score *= TOC_PENALTY; }
        return { doc: loaded.doc, page: c.page, heading, score, snippet: '', matched: c.matched };
    });
    scored.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id) || a.page - b.page);
    const hits = scored.slice(0, limit);
    for (const h of hits) {
        const d = docs.findIndex(x => x.doc === h.doc);
        h.snippet = makeSnippet(pagesOf(d)[h.page - 1]?.text ?? '', re);
    }
    const ms = Date.now() - started;
    log.debug(`top ${hits.length}: ${hits.map(h => `${h.doc.id}#${h.page} (${h.score.toFixed(1)})`).join(', ')} — ${ms} ms`);
    return { hits, terms: parsed.terms, phrases: parsed.phrases, candidates: candidates.length, ms };
}
