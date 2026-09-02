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
 * Tool-result text. Compact, line-oriented, and always telling the agent
 * what to call next — the same shape as the CMSIS Developer Assistant's SVD
 * lookups.
 */

import { DocRef, isReadable } from './pdscBooks';
import { LoadedDoc, PageRecord } from './pageStore';
import { SearchHit } from './search';
import { clipValue, formatBytes, truncateList } from './textBudget';
import { FetchOutcome } from './webFetch';

function unitLabel(d: DocRef): string {
    return d.unit === 'section' ? '§' : 'p';
}

export function docState(d: DocRef): string {
    if (d.source === 'web' && !d.cached) {
        return d.format === 'html' ? 'web — HTML on arm.com, not fetchable in this version' : `web — not fetched (fetch_doc { doc: '${d.id}' })`;
    }
    if (d.source === 'web' && !d.indexed) { return `fetched${d.revision ? ` ${d.revision}` : ''}, not indexed yet`; }
    if (d.missing) { return 'missing on disk'; }
    if (d.unsupported) { return 'not a PDF'; }
    if (d.indexed) { return `indexed${d.revision ? ` ${d.revision}` : ''}, ${d.pages ?? '?'} ${unitLabel(d)}`; }
    return `${formatBytes(d.sizeBytes)}, not indexed yet`;
}

function docRow(d: DocRef): string {
    const cat = d.category ? ` [${d.category}]` : '';
    return `  ${d.id} · ${d.scope}${cat} · ${d.title} · ${docState(d)}`;
}

export interface DocListInfo {
    /** Workspace docs folders that exist, for the group header. */
    workspaceDirs?: string[];
    /** The user documents folder and the sub-folders that matched. */
    userDir?: string;
    userMatched?: string[];
    /** `Cortex-M33 r0p0 (Armv8-M)` — for the Arm documents group header. */
    processors?: string;
}

function armRow(d: DocRef): string {
    return `  ${d.id} · ${d.kind ?? 'arm'} · ${d.title} · ${docState(d)}`;
}

export function renderDocList(resolution: string, docs: DocRef[], notes: string[], info: DocListInfo = {}): string {
    const lines: string[] = [resolution];
    if (info.processors) { lines.push(`Core: ${info.processors}`); }
    for (const n of notes) { lines.push(`Note: ${n}`); }
    if (!docs.length) {
        lines.push('No documents: the packs declare no <book> elements and contain no PDFs' +
            (info.workspaceDirs?.length ? `, and ${info.workspaceDirs.join(', ')} holds none.` : '.'));
        return lines.join('\n');
    }
    const packDocs = docs.filter(d => d.scope !== 'workspace' && d.scope !== 'arm' && d.scope !== 'user');
    const armDocs = docs.filter(d => d.scope === 'arm');
    const userDocs = docs.filter(d => d.scope === 'user');
    const wsDocs = docs.filter(d => d.scope === 'workspace');
    lines.push(`${docs.length} documents (id · scope · title · state):`);
    const { shown, hidden } = truncateList(packDocs, 60);
    for (const d of shown) { lines.push(docRow(d)); }
    if (hidden) { lines.push(`  … ${hidden} more`); }
    if (armDocs.length) {
        lines.push(`Arm documents${info.processors ? ` for ${info.processors}` : ''} (id · kind · title · state) — architecture, debug interface, CoreSight, trace, core TRM, NPU; fetch_doc { doc } downloads one:`);
        const arm = truncateList(armDocs, 40);
        for (const d of arm.shown) { lines.push(armRow(d)); }
        if (arm.hidden) { lines.push(`  … ${arm.hidden} more`); }
    }
    if (userDocs.length) {
        lines.push(`User documents (${info.userDir ?? 'user documents folder'}${info.userMatched?.length ? `: ${info.userMatched.join(', ')}` : ''}):`);
        const u = truncateList(userDocs, 30);
        for (const d of u.shown) { lines.push(docRow(d)); }
        if (u.hidden) { lines.push(`  … ${u.hidden} more`); }
    }
    if (wsDocs.length) {
        lines.push(`Workspace documents (${(info.workspaceDirs ?? []).join(', ') || 'workspace docs folders'}):`);
        const ws = truncateList(wsDocs, 30);
        for (const d of ws.shown) { lines.push(docRow(d)); }
        if (ws.hidden) { lines.push(`  … ${ws.hidden} more`); }
    }
    const readable = docs.filter(isReadable);
    const inPacks = readable.filter(d => d.source === 'pack').length;
    const inWorkspace = readable.filter(d => d.source === 'workspace').length;
    const inUser = readable.filter(d => d.source === 'user').length;
    const fetched = readable.filter(d => d.source === 'web').length;
    const web = docs.filter(d => d.source === 'web' && !isReadable(d));
    lines.push(`${readable.length} searchable (${inPacks} in packs${inUser ? `, ${inUser} user` : ''}${inWorkspace ? `, ${inWorkspace} in the workspace` : ''}${fetched ? `, ${fetched} fetched` : ''}; ` +
        `${readable.filter(d => d.indexed).length} indexed)` +
        `${web.length ? `, ${web.length} on the web not fetched (fetch_doc { doc })` : ''}.`);
    lines.push('Next: search_target_docs { query } searches the documents; read_doc_pages { doc, pages } reads pages.');
    return lines.join('\n');
}

export interface SearchInfo {
    resolution: string;
    indexedNow: { doc: DocRef; ms: number }[];
    skipped: { doc: DocRef; reason: string }[];
    searched: DocRef[];
    web: DocRef[];
    /** Unlisted pack PDFs left out of this search. */
    unlistedSkipped?: DocRef[];
    /** Identifiers expanded from the SVD, one note each (`USART1 (peripheral): universal …`). */
    expandedWith?: string[];
    ms: number;
}

export function renderSearch(query: string, hits: SearchHit[], info: SearchInfo): string {
    const lines: string[] = [info.resolution];
    if (info.indexedNow.length) {
        lines.push(`Indexed now: ${info.indexedNow.map(x => `${x.doc.id} (${x.doc.pages ?? '?'} p, ${(x.ms / 1000).toFixed(1)} s)`).join(', ')}`);
    }
    for (const s of info.skipped) { lines.push(`Skipped ${s.doc.id}: ${s.reason}`); }
    if (!info.searched.length) {
        lines.push(`Nothing to search for "${query}": no indexed documents.` +
            (info.web.length ? ` ${info.web.length} web documents are listed by list_target_docs.` : ''));
        return lines.join('\n');
    }
    lines.push(`Searched ${info.searched.length} document${info.searched.length === 1 ? '' : 's'} ` +
        `(${info.searched.reduce((n, d) => n + (d.pages ?? 0), 0)} pages) for "${query}" in ${info.ms} ms — ${hits.length} hit${hits.length === 1 ? '' : 's'}:`);
    if (info.expandedWith?.length) {
        lines.push(`Expanded from the SVD (lower weight): ${info.expandedWith.join('; ')}`);
    }
    hits.forEach((h, i) => {
        const rev = h.doc.revision ? ` [${h.doc.revision}]` : '';
        lines.push(`#${i + 1} ${h.doc.id}${rev} ${unitLabel(h.doc)}.${h.page}${h.heading ? ` §${h.heading}` : ''}  (score ${h.score.toFixed(1)})`);
        lines.push(`   ${h.snippet}`);
    });
    if (!hits.length) {
        lines.push('No page contains the query terms. Try the register or peripheral name as written in the manual, or fewer words.');
    } else {
        const top = hits[0];
        lines.push(`Next: read_doc_pages { doc: '${top.doc.id}', pages: '${top.page}' } for the full page; add a doc argument to narrow the search.`);
    }
    if (info.web.length) {
        lines.push(`Not searched: ${info.web.length} web document${info.web.length === 1 ? '' : 's'} not fetched yet ` +
            `(${info.web.slice(0, 3).map(d => d.id).join(', ')}${info.web.length > 3 ? ', …' : ''}) — fetch_doc { doc } makes one searchable.`);
    }
    const unlisted = info.unlistedSkipped ?? [];
    if (unlisted.length) {
        lines.push(`Not searched: ${unlisted.length} unlisted PDF${unlisted.length === 1 ? '' : 's'} in the pack not attributed to this device/board ` +
            `(includeUnlisted: true or a doc filter searches them).`);
    }
    return lines.join('\n');
}

function citeHint(doc: DocRef): string {
    return `Cite as ${doc.id}${doc.revision ? ` ${doc.revision}` : ''} ${unitLabel(doc)}.<n>.`;
}

/** The result of a successful fetch_doc: what was fetched, which edition, and what to call next. */
export function renderFetch(doc: DocRef, outcome: FetchOutcome | undefined, loaded: LoadedDoc, ms: number): string {
    const lines: string[] = [];
    const edition = doc.arm?.resolvedVersion
        ? `version ${doc.arm.resolvedVersion}${doc.revision ? ` (${doc.revision})` : ''}`
        : (doc.revision ? `edition ${doc.revision}` : undefined);
    const size = formatBytes(doc.sizeBytes);
    if (outcome?.ok) {
        const what = [doc.title, edition, outcome.record.filename, size].filter(Boolean).join(', ');
        lines.push(`Fetched ${doc.id} — ${what} → indexed ${loaded.meta.pageCount} ${unitLabel(doc)} in ${(ms / 1000).toFixed(1)} s.`);
        lines.push(`From ${doc.url} (${outcome.resolver}); cached in the extension storage, not in the workspace.`);
    } else {
        lines.push(`Already fetched ${doc.id} — ${[doc.title, edition, size].filter(Boolean).join(', ')}; indexed ${loaded.meta.pageCount} ${unitLabel(doc)}. Pass refresh: true to download again.`);
    }
    const alternatives = outcome?.ok ? outcome.resolved.alternatives : undefined;
    if (alternatives?.length) {
        lines.push(`Note: this edition is an errata document; other editions: ${alternatives.map(a => `${a.version} (${a.versionLabel})`).join(', ')}` +
            (doc.arm ? ` — fetch_doc { doc: 'arm/${doc.arm.docId}-${alternatives[0].version}' }.` : '.'));
    }
    lines.push(`Next: search_target_docs { query, doc: '${doc.id}' } or read_doc_pages { doc: '${doc.id}', pages }. ${citeHint(doc)}`);
    return lines.join('\n');
}

/** A failed fetch_doc: the reason, what is known about the document, and the manual way out. */
export function renderFetchFailure(doc: DocRef, outcome: Extract<FetchOutcome, { ok: false }>, dropFolder: string | undefined): string {
    const lines: string[] = [`Could not fetch ${doc.id}: ${outcome.error}.`];
    const r = outcome.resolved;
    if (r) {
        const known = [r.title, r.versionLabel ? `edition ${r.versionLabel}` : undefined, r.version ? `version ${r.version}` : undefined].filter(Boolean).join(', ');
        if (known) { lines.push(`Document: ${known}.`); }
    }
    if (doc.url) { lines.push(`URL: ${doc.url}`); }
    if (dropFolder) { lines.push(`Alternative: download the PDF yourself into ${dropFolder} in the workspace; list_target_docs then lists it as a workspace document.`); }
    return lines.join('\n');
}

/** "519", "519-521", "519,523" → 1-based page numbers within [1, max]. */
export function parsePageRange(spec: string, max: number): { pages: number[] } | { error: string } {
    const pages: number[] = [];
    for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!m) { return { error: `pages '${spec}' is not a page number, range (519-521) or list (519,523)` }; }
        const a = parseInt(m[1], 10);
        const b = m[2] ? parseInt(m[2], 10) : a;
        if (a < 1 || b < a) { return { error: `pages '${part}': invalid range` }; }
        for (let p = a; p <= b && pages.length < 50; p++) { pages.push(p); }
    }
    if (!pages.length) { return { error: 'pages is empty' }; }
    const outside = pages.filter(p => p > max);
    if (outside.length === pages.length) { return { error: `page ${pages[0]} is beyond the last page (${max})` }; }
    return { pages: pages.filter(p => p <= max) };
}

export function renderPages(doc: DocRef, records: PageRecord[], maxChars: number): string {
    const lines: string[] = [];
    let budget = maxChars;
    for (const r of records) {
        const rev = doc.revision ? ` [${doc.revision}]` : '';
        const header = `— ${doc.id}${rev} ${unitLabel(doc)}.${r.p}${r.heading ? ` §${r.heading}` : ''} (of ${doc.pages ?? '?'}) —`;
        if (budget <= 0) {
            lines.push(`${header} omitted: maxChars reached (pass a smaller range or a larger maxChars)`);
            continue;
        }
        const text = r.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        const body = clipValue(text, budget);
        budget -= Math.min(text.length, budget);
        lines.push(header, body, '');
    }
    return lines.join('\n').trimEnd();
}
