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
 * What the knowledge browser shows of an index: the list of units, the
 * figures of the overview, one node in full with its text as HTML, and the
 * neighbourhood of a node as a small graph. The panel in
 * `src/knowledgePanel.ts` only draws what these functions return.
 *
 * The text of a unit comes from Markdown files that anyone may have written,
 * so `renderMarkdown` escapes everything first and adds its own tags after;
 * no tag or attribute of the source reaches the page.
 *
 * Pure: no vscode, no file access beyond the open index.
 */

import { isIncomplete, tokensOf } from './search';
import type { KnowledgeNode, KnowledgeReader, Neighbour } from './store';

/** One unit in the browser's list. */
export interface UnitRow {
    id: string;
    type: string;
    domain?: string;
    /** Where the unit came from: the source collection of the knowledge base (`zephyr`, `issues-pyocd`, …). */
    collection: string;
    title: string;
    summary: string;
    /** `draft` or `reviewed`. */
    status: string;
    /** The tool of a troubleshooting unit, and its message code. */
    tool?: string;
    code?: string;
    tokens: number;
    /** The unit has no cause or text yet. */
    incomplete: boolean;
    /** How many files it ships. */
    files: number;
}

export interface Tally {
    name: string;
    count: number;
}

export interface Overview {
    units: number;
    incomplete: number;
    byType: Tally[];
    byDomain: Tally[];
    byCollection: Tally[];
    byTool: Tally[];
    byStatus: Tally[];
    entities: Tally[];
    relations: Tally[];
    /** The `info` table of the index. */
    info: Record<string, string>;
    /** The routing units: where to start. */
    routes: { id: string; title: string; summary: string }[];
}

/** One relation of a node, for the browser's table. */
export interface RelationRow extends Neighbour {
    /** Whether the other end is a node the browser can open. */
    known: boolean;
}

export interface NodeDetail {
    id: string;
    kind: string;
    type: string;
    domain?: string;
    title: string;
    summary: string;
    status?: string;
    incomplete: boolean;
    tokens: number;
    /** The frontmatter, as key and text, without the fields shown elsewhere. */
    meta: { key: string; value: string }[];
    /** The body as HTML: rendered Markdown for a unit, a code block for a file. */
    html: string;
    files: { id: string; path: string }[];
    relations: RelationRow[];
    /** All relations of the node; `relations` holds at most `RELATIONS_SHOWN`. */
    relationTotal: number;
    /** The Markdown file the unit was built from, when the index names one. */
    sourcePath?: string;
}

export interface GraphNode {
    id: string;
    kind: string;
    type: string;
    title: string;
    /** 0 for the centre, 1 for its neighbours, 2 for theirs. */
    ring: number;
    /** The ring-1 node a ring-2 node hangs on. */
    parent?: string;
}

export interface GraphEdge {
    from: string;
    to: string;
    relation: string;
}

export interface Graph {
    centre: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** Relations of the centre that are not drawn. */
    hidden: number;
}

/** Relations the detail lists, and neighbours the graph draws around the centre and around each of those. */
export const RELATIONS_SHOWN = 80;
const GRAPH_RING1 = 28;
const GRAPH_RING2_EACH = 5;
const GRAPH_NODES = 70;
/** Frontmatter the detail shows in its own places, not in the table. */
const META_ELSEWHERE = new Set(['status', 'sections', 'path', 'id', 'type', 'domain', 'title', 'summary']);
/** The order of the types wherever they are listed. */
export const TYPE_ORDER = ['procedure', 'concept', 'pattern', 'rule', 'troubleshooting'];

function textOfMeta(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('; ');
    }
    return JSON.stringify(value);
}

function stringMeta(node: KnowledgeNode, key: string): string | undefined {
    const value = node.meta[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The collection a unit belongs to. Documentation and issue units name it; the units the knowledge base
 * builds from skills, the error catalog and the routing table do not, and are grouped by their kind.
 */
export function collectionOf(node: KnowledgeNode): string {
    const named = stringMeta(node, 'collection');
    if (named) {
        return named;
    }
    if (node.id.startsWith('ts-')) {
        return 'error-catalog';
    }
    if (node.id.startsWith('route-')) {
        return 'routing';
    }
    return node.id.startsWith('x-') ? 'extracted' : 'skills';
}

function rowOf(node: KnowledgeNode, files: number): UnitRow {
    const tool = stringMeta(node, 'tool');
    const code = stringMeta(node, 'code');
    return {
        id: node.id, type: node.type, ...(node.domain ? { domain: node.domain } : {}), collection: collectionOf(node), title: node.title, summary: node.summary,
        status: stringMeta(node, 'status') ?? 'draft', ...(tool ? { tool } : {}), ...(code ? { code } : {}),
        tokens: tokensOf(node.body), incomplete: isIncomplete(node), files,
    };
}

/** Every unit of the index, by type in `TYPE_ORDER`, then by title. */
export function unitRows(index: KnowledgeReader): UnitRow[] {
    const files = index.assetCounts();
    const rank = (type: string): number => {
        const at = TYPE_ORDER.indexOf(type);
        return at < 0 ? TYPE_ORDER.length : at;
    };
    return index.units().map((node) => rowOf(node, files.get(node.id) ?? 0))
        .sort((a, b) => rank(a.type) - rank(b.type) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function tally(values: Iterable<string | undefined>, order: readonly string[] = []): Tally[] {
    const counts = new Map<string, number>();
    for (const value of values) {
        if (value !== undefined && value.length > 0) {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
    }
    const rank = (name: string): number => {
        const at = order.indexOf(name);
        return at < 0 ? order.length : at;
    };
    return [...counts].map(([name, count]) => ({ name, count }))
        .sort((a, b) => rank(a.name) - rank(b.name) || b.count - a.count || a.name.localeCompare(b.name));
}

/** The figures of the overview, from the rows the list shows. */
export function overviewOf(index: KnowledgeReader, rows: readonly UnitRow[]): Overview {
    return {
        units: rows.length,
        incomplete: rows.filter((row) => row.incomplete).length,
        byType: tally(rows.map((row) => row.type), TYPE_ORDER),
        byDomain: tally(rows.map((row) => row.domain)),
        byCollection: tally(rows.map((row) => row.collection)),
        byTool: tally(rows.map((row) => row.tool)),
        byStatus: tally(rows.map((row) => row.status)),
        entities: index.nodeCounts().filter((entry) => entry.kind === 'entity').map((entry) => ({ name: entry.type, count: entry.count })),
        relations: index.relationCounts().map((entry) => ({ name: entry.relation, count: entry.count })),
        info: { ...index.info },
        routes: rows.filter((row) => row.id.startsWith('route-')).map((row) => ({ id: row.id, title: row.title, summary: row.summary })),
    };
}

// ── Markdown ────────────────────────────────────────────────────────────────

/** `&`, `<`, `>`, `"` and `'` escaped for an HTML text node or attribute. */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

/** What a reference in the text points to: the id of a node the browser can open, or nothing. */
export type Resolve = (reference: string) => string | undefined;

function refLink(id: string, inner: string): string {
    return `<a class="ref" data-id="${escapeHtml(id)}">${inner}</a>`;
}

/** The text between code spans: links, bold, and `$name` of a skill. Escapes first. */
function inlineText(raw: string, resolve: Resolve): string {
    let html = escapeHtml(raw);
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_whole, label: string, target: string) => {
        if (/^https?:\/\//.test(target)) {
            return `<a class="ext" data-url="${target}" title="${target}">${label}</a>`;
        }
        const id = resolve(target.replace(/&amp;/g, '&'));
        return id !== undefined ? refLink(id, label) : `${label} <span class="muted">(${target})</span>`;
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[\s(])\$([a-z][a-z0-9-]+)/g, (whole, lead: string, name: string) => {
        const id = resolve(name);
        return id !== undefined ? `${lead}${refLink(id, `$${name}`)}` : whole;
    });
    return html;
}

/** One line of text with its code spans; a span that names a node is a link to it. */
function inline(raw: string, resolve: Resolve): string {
    return raw.split(/(`[^`]+`)/).map((part) => {
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
            const code = part.slice(1, -1);
            const id = resolve(code) ?? resolve(code.replace(/^[$/]/, ''));
            const shown = `<code>${escapeHtml(code)}</code>`;
            return id !== undefined ? refLink(id, shown) : shown;
        }
        return inlineText(part, resolve);
    }).join('');
}

function tableCells(line: string): string[] {
    return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * Markdown as HTML for the browser: headings, paragraphs, lists by their
 * indent, tables, fenced code, quotes and rules; code spans, bold and links
 * inside a line. Everything else is text. Nothing of the source is trusted:
 * it is escaped before a tag is added.
 */
export function renderMarkdown(markdown: string, resolve: Resolve = () => undefined): string {
    const lines = markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
    const out: string[] = [];
    let paragraph: string[] = [];
    const flush = (): void => {
        if (paragraph.length > 0) {
            out.push(`<p>${inline(paragraph.join(' '), resolve)}</p>`);
            paragraph = [];
        }
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
        if (fence) {
            flush();
            const code: string[] = [];
            for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) {
                code.push(lines[i]);
            }
            out.push(`<pre${fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : ''}><code>${escapeHtml(code.join('\n'))}</code></pre>`);
            continue;
        }
        if (line.trim() === '') {
            flush();
            continue;
        }
        const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
        if (heading) {
            flush();
            const level = Math.min(heading[1].length + 1, 6);
            out.push(`<h${level}>${inline(heading[2], resolve)}</h${level}>`);
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            flush();
            out.push('<hr>');
            continue;
        }
        if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
            flush();
            const head = tableCells(line);
            const rows: string[][] = [];
            for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim() !== ''; i++) {
                rows.push(tableCells(lines[i]));
            }
            i--;
            out.push(`<table class="md"><thead><tr>${head.map((cell) => `<th>${inline(cell, resolve)}</th>`).join('')}</tr></thead><tbody>`
                + rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, resolve)}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
            continue;
        }
        const item = LIST_ITEM.exec(line);
        if (item) {
            flush();
            const text: string[] = [item[3]];
            // Lines that continue the item: indented text that is no item of its own, up to a blank line.
            while (i + 1 < lines.length && lines[i + 1].trim() !== '' && /^\s+/.test(lines[i + 1]) && !LIST_ITEM.test(lines[i + 1])
                && !/^\s*(```|~~~)/.test(lines[i + 1])) {
                text.push(lines[++i].trim());
            }
            const depth = Math.min(Math.floor(item[1].replace(/\t/g, '    ').length / 2), 6);
            const mark = /^\d/.test(item[2]) ? escapeHtml(item[2].replace(')', '.')) : '•';
            out.push(`<div class="li d${depth}"><span class="mark">${mark}</span><span>${inline(text.join(' '), resolve)}</span></div>`);
            continue;
        }
        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            flush();
            const text: string[] = [quote[1]];
            while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) {
                text.push(lines[++i].replace(/^\s*>\s?/, ''));
            }
            out.push(`<blockquote>${inline(text.join(' '), resolve)}</blockquote>`);
            continue;
        }
        paragraph.push(line.trim());
    }
    flush();
    return out.join('\n');
}

// ── One node ────────────────────────────────────────────────────────────────

/** The node `id` in full, or undefined when the index has none. */
export function detailOf(index: KnowledgeReader, id: string): NodeDetail | undefined {
    const node = index.node(id);
    if (node === undefined) {
        return undefined;
    }
    const files = node.kind === 'knowledge' ? index.assetsOf(node.id) : [];
    const byPath = new Map(files.map((file) => [file.path, file.id]));
    const resolve: Resolve = (reference) => {
        const wanted = reference.trim();
        if (wanted.length === 0 || wanted.length > 200) {
            return undefined;
        }
        if (byPath.has(wanted)) {
            return byPath.get(wanted);
        }
        if (wanted !== node.id && index.has(wanted)) {
            return wanted;
        }
        return /^[a-z][a-z0-9-]+$/.test(wanted) && `proc-${wanted}` !== node.id && index.has(`proc-${wanted}`) ? `proc-${wanted}` : undefined;
    };
    const { neighbours, total } = index.neighbours(node.id, undefined, RELATIONS_SHOWN);
    const status = stringMeta(node, 'status');
    const sourcePath = node.kind === 'knowledge' ? stringMeta(node, 'path') : undefined;
    const html = node.body.length === 0 ? ''
        : node.type === 'asset' ? `<pre class="file"><code>${escapeHtml(node.body)}</code></pre>`
            : renderMarkdown(node.body, resolve);
    return {
        id: node.id, kind: node.kind, type: node.type, ...(node.domain ? { domain: node.domain } : {}),
        title: node.title, summary: node.summary, ...(status ? { status } : {}),
        incomplete: isIncomplete(node), tokens: tokensOf(node.body),
        meta: Object.entries(node.meta)
            .filter(([key, value]) => !META_ELSEWHERE.has(key) && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0))
            .map(([key, value]) => ({ key, value: textOfMeta(value) })),
        html, files,
        relations: neighbours.map((neighbour) => ({ ...neighbour, known: neighbour.kind !== undefined })),
        relationTotal: total,
        ...(sourcePath ? { sourcePath } : {}),
    };
}

// ── The neighbourhood ───────────────────────────────────────────────────────

/**
 * The node `id`, what it is related to and, with `depth` 2, what the units
 * among those are related to: at most `GRAPH_NODES` nodes. An edge is kept
 * in the direction the index holds it.
 */
export function graphAround(index: KnowledgeReader, id: string, depth: number): Graph | undefined {
    const centre = index.node(id);
    if (centre === undefined) {
        return undefined;
    }
    const nodes = new Map<string, GraphNode>([[centre.id, { id: centre.id, kind: centre.kind, type: centre.type, title: centre.title, ring: 0 }]]);
    const edges = new Map<string, GraphEdge>();
    const link = (from: string, neighbour: Neighbour): void => {
        const edge: GraphEdge = neighbour.direction === 'out'
            ? { from, to: neighbour.id, relation: neighbour.relation } : { from: neighbour.id, to: from, relation: neighbour.relation };
        edges.set(`${edge.from}|${edge.relation}|${edge.to}`, edge);
    };
    const add = (neighbour: Neighbour, ring: number, parent?: string): boolean => {
        if (nodes.has(neighbour.id)) {
            return true;
        }
        if (neighbour.kind === undefined || nodes.size >= GRAPH_NODES) {
            return false;
        }
        nodes.set(neighbour.id, {
            id: neighbour.id, kind: neighbour.kind, type: neighbour.type ?? '', title: neighbour.title ?? neighbour.id, ring,
            ...(parent ? { parent } : {}),
        });
        return true;
    };
    const first = index.neighbours(centre.id, undefined, GRAPH_RING1);
    for (const neighbour of first.neighbours) {
        if (add(neighbour, 1)) {
            link(centre.id, neighbour);
        }
    }
    if (depth >= 2) {
        for (const inner of [...nodes.values()].filter((node) => node.ring === 1 && node.kind === 'knowledge')) {
            for (const neighbour of index.neighbours(inner.id, undefined, GRAPH_RING2_EACH + 1).neighbours) {
                if (neighbour.id !== centre.id && add(neighbour, 2, inner.id)) {
                    link(inner.id, neighbour);
                }
            }
        }
    }
    const drawn = [...edges.values()].filter((edge) => edge.from === centre.id || edge.to === centre.id).length;
    return { centre: centre.id, nodes: [...nodes.values()], edges: [...edges.values()], hidden: Math.max(0, first.total - drawn) };
}
