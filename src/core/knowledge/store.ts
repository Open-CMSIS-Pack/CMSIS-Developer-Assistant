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
 * Reads a knowledge index: the `knowledge.db` the knowledge-base tooling
 * builds (`build_index.py`), or `cmsis-knowledge` for a pack, one SQLite file
 * with the knowledge units and entities (`nodes`), their relations (`edges`)
 * and an FTS5 index over the units (`nodes_fts`).
 *
 * The file is opened read-only with Node's own `node:sqlite`, so nothing is
 * installed and nothing native ships. The vector table of the index
 * (`nodes_vec`, sqlite-vec) is not read: search here is BM25 and exact
 * symptoms. No `vscode` import.
 */

import * as fs from 'fs';
import type { DatabaseSync } from 'node:sqlite';
import { ToolError } from '../toolResult';
import { compileSymptomPattern, SymptomCompilationBudget, SymptomMatchBudget } from './symptomPattern';
import type { SymptomPattern } from './symptomPattern';

/** The major version of the index layout this reader understands; an index without `schema_version` counts as 1. */
export const KNOWLEDGE_SCHEMA_VERSION = 1;

/** Relation of a pack's unit to that pack: the unit is offered only to a project that uses the pack. */
export const SCOPE_RELATION = 'scoped_to';
/** Relation of a board to a part mounted on it (`<mountedPart>` of the PDSC). */
export const PART_RELATION = 'has_part';
/** Relations along which a unit's validity is inherited: a device's subfamily, family, pack and cores. */
const ANCESTOR_RELATIONS = ['part_of', 'has_core'];
const ANCESTOR_DEPTH = 6;
/**
 * Words of a question that say nothing about the subject. With any word
 * allowed to match, they lift short units that happen to hold many of them.
 * `no` and `not` stay: they carry the meaning of an error message.
 */
const STOP_WORDS = new Set(('a an the and or of to in on for with by my me i is are be it its this that these those how do does what why '
    + 'when where which can could should would from at as into your you we our there their then than so if').split(' '));

/** The words of a question the search matches: its tokens without the function words. */
export function queryWords(query: string): string[] {
    return (query.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((word) => !STOP_WORDS.has(word.toLowerCase()));
}

/** Two words a question writes apart that an identifier writes together: `hard fault` next to `HardFault`. */
function joinedPairs(words: readonly string[]): { first: number; joined: string }[] {
    const pairs: { first: number; joined: string }[] = [];
    for (let i = 0; i + 1 < words.length; i++) {
        if (/^\p{L}+$/u.test(words[i]) && /^\p{L}+$/u.test(words[i + 1])) {
            pairs.push({ first: i, joined: words[i] + words[i + 1] });
        }
    }
    return pairs;
}

/** A how-to unit: a procedure, or a routing unit (`route-*`), which says which procedure fits a task. */
const HOW_TO_WHERE = "(n.type = 'procedure' OR n.id LIKE 'route-%')";

/**
 * Is this pattern supported by the bounded symptom matcher? This is a
 * grammar check, not permission to execute the source with native RegExp:
 * even supported, adjacent quantifiers may make a backtracking engine slow.
 */
export function safeSymptomPattern(source: string): boolean {
    return compileSymptomPattern(source) !== undefined;
}

/** A row of `nodes`: a knowledge unit (`kind` knowledge) or an entity. */
export interface KnowledgeNode {
    id: string;
    kind: string;
    type: string;
    domain?: string;
    title: string;
    summary: string;
    body: string;
    /** The rest of the unit's frontmatter. */
    meta: Record<string, unknown>;
}

/** One relation of a node, seen from that node. */
export interface Neighbour {
    relation: string;
    direction: 'out' | 'in';
    id: string;
    kind?: string;
    type?: string;
    title?: string;
    summary?: string;
}

type SqliteModule = typeof import('node:sqlite');

/** `node:sqlite`, or a failure that says which VS Code has it. */
function sqliteModule(): SqliteModule {
    let loaded: SqliteModule | undefined;
    try {
        loaded = process.getBuiltinModule?.('node:sqlite');
    } catch {
        loaded = undefined;
    }
    if (loaded === undefined) {
        throw new ToolError('TOOL_DISABLED',
            `The knowledge tools need the node:sqlite module, which this VS Code (Node ${process.versions.node}) does not have`,
            'Update VS Code to a version with the node:sqlite module.');
    }
    return loaded;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function parseMeta(value: unknown): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(text(value) || '{}');
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function toNode(row: Record<string, unknown>): KnowledgeNode {
    const domain = text(row.domain);
    return {
        id: text(row.id), kind: text(row.kind), type: text(row.type), ...(domain ? { domain } : {}),
        title: text(row.title), summary: text(row.summary), body: text(row.body), meta: parseMeta(row.meta),
    };
}

/**
 * What search, the tools and the browser read: one index file
 * (`KnowledgeIndex`) or several merged (`KnowledgeSet`).
 */
export interface KnowledgeReader {
    /** The base file: the one `knowledge.indexPath` names. */
    readonly file: string;
    readonly info: Readonly<Record<string, string>>;
    readonly skippedSymptoms: number;
    /** The indexes read, base first, with their labels and unit counts. */
    sources(): IndexSource[];
    /**
     * The reader over the indexes a project may see: the base, the workspace
     * and the packs the context names; without a context, no pack. Search
     * runs on it, so the units of a pack outside the project take no
     * candidate slots and their symptom patterns never run.
     */
    forContext(context: ReadonlySet<string> | undefined): KnowledgeReader;
    /** The label of the index a node came from; undefined for the base index. */
    sourceOf(id: string): string | undefined;
    /** The file of the index a node came from, the base index included. */
    fileOf(id: string): string | undefined;
    close(): void;
    node(id: string): KnowledgeNode | undefined;
    has(id: string): boolean;
    unitCount(): number;
    bm25(query: string, limit: number): string[];
    /**
     * For each how-to unit (a procedure or a routing unit) that names any
     * of `words` in its title, summary or triggers: how many of them it
     * names. Two adjacent words count as named when their join is
     * (`hard fault` finds `HardFault`).
     */
    howToCoverage(words: readonly string[]): Map<string, number>;
    /** Knowledge unit ids that start with `prefix`, in id order, at most `limit`. */
    unitIdsWithPrefix(prefix: string, limit: number): string[];
    exactSymptoms(lines: readonly string[], budget?: SymptomMatchBudget): string[];
    exactSymptomLines(lines: readonly string[], budget?: SymptomMatchBudget): Map<string, number>;
    appliesTo(id: string): string[];
    /** The packs a unit is scoped to; none means it is not scoped. A unit of a pack's index is scoped to that pack at least. */
    scopesOf(id: string): string[];
    refinements(): [specific: string, general: string][];
    ancestors(id: string): Set<string>;
    mountedDevices(board: string): string[];
    mountedParts(board: string): string[];
    componentIds(name: string): string[];
    units(): KnowledgeNode[];
    nodeCounts(): { kind: string; type: string; count: number }[];
    relationCounts(): { relation: string; count: number }[];
    assetCounts(): Map<string, number>;
    assetsOf(id: string): Array<{ id: string; path: string }>;
    neighbours(id: string, relation: string | undefined, limit: number): { neighbours: Neighbour[]; total: number };
}

/** One index file of a set: where it is and what it is called (`base`, `Vendor::Pack@1.0.0`, `workspace`). */
export interface IndexSource {
    label: string;
    file: string;
    units: number;
}

/** One open index. Methods are synchronous; symptom compilation and matching have explicit shared work bounds. */
export class KnowledgeIndex implements KnowledgeReader {
    private readonly db: DatabaseSync;
    /** The `info` table: `embed_model`, and `schema_version` and the build facts once the tooling writes them. */
    readonly info: Readonly<Record<string, string>>;
    /** Symptom patterns accepted by the bounded, non-backtracking matcher. */
    private readonly symptoms: { id: string; pattern: SymptomPattern }[] = [];
    /** How many patterns are malformed, unsupported or oversized; the index build checks Python's syntax only. */
    readonly skippedSymptoms: number;

    constructor(readonly file: string, compilation: SymptomCompilationBudget = new SymptomCompilationBudget()) {
        if (!fs.existsSync(file)) {
            throw new ToolError('INVALID_ARGUMENT', `The knowledge index ${file} does not exist`,
                'Set cmsis-developer-assistant.knowledge.indexPath to a knowledge.db.');
        }
        const { DatabaseSync: Database } = sqliteModule();
        let opened: DatabaseSync | undefined;
        try {
            opened = new Database(file, { readOnly: true });
            this.db = opened;
            const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => text(row.name)));
            const missing = ['nodes', 'edges', 'nodes_fts'].filter((name) => !tables.has(name));
            if (missing.length > 0) {
                throw new Error(`it has no ${missing.join(', ')} table`);
            }
            const info: Record<string, string> = {};
            if (tables.has('info')) {
                for (const row of this.db.prepare('SELECT key, value FROM info').all()) {
                    info[text(row.key)] = text(row.value);
                }
            }
            this.info = info;
        } catch (caught) {
            // Closed here, not left to the collector: on Windows an open handle keeps the file from being replaced or deleted.
            opened?.close();
            throw new ToolError('INVALID_ARGUMENT', `${file} is not a knowledge index: ${caught instanceof Error ? caught.message : String(caught)}`,
                'Set cmsis-developer-assistant.knowledge.indexPath to a knowledge.db built by build_index.py.');
        }
        const major = Number.parseInt(this.info.schema_version ?? String(KNOWLEDGE_SCHEMA_VERSION), 10);
        if (major !== KNOWLEDGE_SCHEMA_VERSION) {
            this.db.close();
            throw new ToolError('INVALID_ARGUMENT',
                `The knowledge index ${file} has schema version ${this.info.schema_version}; this extension reads version ${KNOWLEDGE_SCHEMA_VERSION}`,
                'Use an index built for this version of the extension.');
        }
        let skipped = 0;
        try {
            const patterns = this.db.prepare(
                "SELECT id, json_extract(meta, '$.symptom_regex') AS pattern FROM nodes WHERE type = 'troubleshooting' AND pattern IS NOT NULL").iterate();
            for (const row of patterns) {
                const pattern = compilation.compile(text(row.pattern));
                if (pattern === undefined) {
                    skipped++;
                } else {
                    this.symptoms.push({ id: text(row.id), pattern });
                }
            }
        } catch (caught) {
            this.db.close();
            throw caught;
        }
        this.skippedSymptoms = skipped;
    }

    sources(): IndexSource[] {
        return [{ label: 'base', file: this.file, units: this.unitCount() }];
    }

    forContext(_context: ReadonlySet<string> | undefined): KnowledgeReader {
        return this;
    }

    sourceOf(_id: string): string | undefined {
        return undefined;
    }

    fileOf(id: string): string | undefined {
        return this.has(id) ? this.file : undefined;
    }

    close(): void {
        this.db.close();
    }

    /** The node with this id, unit or entity. */
    node(id: string): KnowledgeNode | undefined {
        const row = this.db.prepare('SELECT id, kind, type, domain, title, summary, body, meta FROM nodes WHERE id = ?').get(id);
        return row === undefined ? undefined : toNode(row);
    }

    has(id: string): boolean {
        return this.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id) !== undefined;
    }

    /** How many knowledge units the index holds. */
    unitCount(): number {
        return Number(this.db.prepare("SELECT count(*) AS n FROM nodes WHERE kind = 'knowledge'").get()?.n ?? 0);
    }

    /**
     * Unit ids by BM25, best first: any word of the query may match, except
     * the English function words of a question; title, summary, symptoms and
     * triggers weigh more than the body.
     */
    bm25(query: string, limit: number): string[] {
        const words = queryWords(query);
        if (words.length === 0) {
            return [];
        }
        const match = words.map((word) => `"${word}"`).join(' OR ');
        return this.db.prepare('SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts, 0, 8, 4, 1, 6, 6) LIMIT ?')
            .all(match, limit).map((row) => text(row.id));
    }

    /**
     * One FTS query per word over the "when to use" text of the how-to
     * units, with the index's own tokenizer, so that `crashes` finds
     * `crash` and `HardFault` finds `HardFaults` the way the ranking does.
     */
    howToCoverage(words: readonly string[]): Map<string, number> {
        if (words.length === 0) {
            return new Map();
        }
        const naming = this.db.prepare(
            `SELECT f.id FROM nodes_fts f JOIN nodes n ON n.id = f.id WHERE nodes_fts MATCH ? AND ${HOW_TO_WHERE}`);
        const unitsNaming = (term: string): string[] => naming.all(`{title summary triggers}: "${term}"`).map((row) => text(row.id));
        const named = words.map((word) => new Set(unitsNaming(word)));
        for (const { first, joined } of joinedPairs(words)) {
            for (const id of unitsNaming(joined)) {
                named[first].add(id);
                named[first + 1].add(id);
            }
        }
        const count = new Map<string, number>();
        for (const units of named) {
            for (const id of units) {
                count.set(id, (count.get(id) ?? 0) + 1);
            }
        }
        return count;
    }

    /** Knowledge unit ids that start with `prefix`, in id order, at most `limit`: an agent that names a unit by the start of its id. */
    unitIdsWithPrefix(prefix: string, limit: number): string[] {
        return this.db.prepare("SELECT id FROM nodes WHERE kind = 'knowledge' AND id LIKE ? ESCAPE '\\' ORDER BY id LIMIT ?")
            .all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`, limit).map((row) => text(row.id));
    }

    /** Troubleshooting units whose symptom pattern matches one of the lines, in the order of the first line each matches. */
    exactSymptoms(lines: readonly string[], budget: SymptomMatchBudget = new SymptomMatchBudget()): string[] {
        return [...this.exactSymptomLines(lines, budget).keys()];
    }

    /** Each troubleshooting unit whose symptom pattern matches one of the lines, with the index of the first such line; ordered by it. */
    exactSymptomLines(lines: readonly string[], budget: SymptomMatchBudget = new SymptomMatchBudget()): Map<string, number> {
        const found: { id: string; line: number }[] = [];
        for (const { id, pattern } of this.symptoms) {
            budget.consume();
            const line = lines.findIndex((candidate) => {
                budget.consume();
                return candidate.length > 0 && pattern.test(candidate, budget);
            });
            if (line >= 0) {
                found.push({ id, line });
            }
        }
        return new Map(found.sort((a, b) => a.line - b.line).map(({ id, line }) => [id, line]));
    }

    /** The entities a unit applies to; none means it holds everywhere. */
    appliesTo(id: string): string[] {
        return this.db.prepare("SELECT dst FROM edges WHERE src = ? AND rel = 'applies_to'").all(id).map((row) => text(row.dst));
    }

    /** The packs a unit is scoped to: every unit a pack ships names that pack. */
    scopesOf(id: string): string[] {
        return this.db.prepare('SELECT dst FROM edges WHERE src = ? AND rel = ?').all(id, SCOPE_RELATION).map((row) => text(row.dst));
    }

    /** Every `refines` relation: the more specific unit, then the general one it replaces. */
    refinements(): [specific: string, general: string][] {
        return this.db.prepare("SELECT src, dst FROM edges WHERE rel = 'refines'").all().map((row) => [text(row.src), text(row.dst)]);
    }

    /** The entity and what it belongs to: subfamily, family, pack and cores of a device. */
    ancestors(id: string): Set<string> {
        const seen = new Set([id]);
        let frontier = [id];
        const step = this.db.prepare(`SELECT dst FROM edges WHERE src = ? AND rel IN (${ANCESTOR_RELATIONS.map(() => '?').join(', ')})`);
        for (let depth = 0; depth < ANCESTOR_DEPTH && frontier.length > 0; depth++) {
            const next: string[] = [];
            for (const from of frontier) {
                for (const row of step.all(from, ...ANCESTOR_RELATIONS)) {
                    const to = text(row.dst);
                    if (!seen.has(to)) {
                        seen.add(to);
                        next.push(to);
                    }
                }
            }
            frontier = next;
        }
        return seen;
    }

    /** The devices mounted on a board. */
    mountedDevices(board: string): string[] {
        return this.db.prepare("SELECT dst FROM edges WHERE src = ? AND rel = 'mounted_on'").all(board).map((row) => text(row.dst));
    }

    /** The parts mounted on a board: sensors, codecs, the interface MCU. */
    mountedParts(board: string): string[] {
        return this.db.prepare('SELECT dst FROM edges WHERE src = ? AND rel = ?').all(board, PART_RELATION).map((row) => text(row.dst));
    }

    /** Component entities by their name without the vendor: `CMSIS:CORE` finds `component:ARM::CMSIS:CORE`. */
    componentIds(name: string): string[] {
        return this.db.prepare("SELECT id FROM nodes WHERE type = 'component' AND (id = ? OR id LIKE ? ESCAPE '\\')")
            .all(`component:${name}`, `component:%::${name.replace(/[\\%_]/g, '\\$&')}`).map((row) => text(row.id));
    }

    /** Every knowledge unit, whole: a few hundred rows, for the knowledge browser. */
    units(): KnowledgeNode[] {
        return this.db.prepare("SELECT id, kind, type, domain, title, summary, body, meta FROM nodes WHERE kind = 'knowledge' ORDER BY type, title, id")
            .all().map(toNode);
    }

    /** How many nodes each kind and type has, the largest first. */
    nodeCounts(): { kind: string; type: string; count: number }[] {
        return this.db.prepare('SELECT kind, type, count(*) AS n FROM nodes GROUP BY kind, type ORDER BY n DESC, type').all()
            .map((row) => ({ kind: text(row.kind), type: text(row.type), count: Number(row.n ?? 0) }));
    }

    /** How many edges each relation has, the largest first. */
    relationCounts(): { relation: string; count: number }[] {
        return this.db.prepare('SELECT rel, count(*) AS n FROM edges GROUP BY rel ORDER BY n DESC, rel').all()
            .map((row) => ({ relation: text(row.rel), count: Number(row.n ?? 0) }));
    }

    /** How many units reference files, by unit id. */
    assetCounts(): Map<string, number> {
        const rows = this.db.prepare(
            "SELECT e.src AS id, count(*) AS n FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.rel = 'references' AND n.type = 'asset' GROUP BY e.src").all();
        return new Map(rows.map((row) => [text(row.id), Number(row.n ?? 0)]));
    }

    /**
     * The files a unit ships with: the `asset` nodes it references, by path.
     * A procedure names them by that path ("copy assets/x.yml"), and the
     * node's body is the file.
     */
    assetsOf(id: string): Array<{ id: string; path: string }> {
        return this.db.prepare(
            `SELECT n.id AS id, n.title AS title FROM edges e JOIN nodes n ON n.id = e.dst
             WHERE e.src = ? AND e.rel = 'references' AND n.type = 'asset' ORDER BY n.title`).all(id)
            .map((row) => ({ id: text(row.id), path: text(row.title) }));
    }

    /**
     * One hop from `id`, knowledge units before entities, at most `limit`
     * of them; `total` counts all.
     */
    neighbours(id: string, relation: string | undefined, limit: number): { neighbours: Neighbour[]; total: number } {
        const where = `(e.src = ?1 OR e.dst = ?1)${relation === undefined ? '' : ' AND e.rel = ?2'}`;
        const args = relation === undefined ? [id] : [id, relation];
        const total = Number(this.db.prepare(`SELECT count(*) AS n FROM edges e WHERE ${where}`).get(...args)?.n ?? 0);
        const rows = this.db.prepare(
            `SELECT e.rel AS rel, e.src AS src, e.dst AS dst, n.kind AS kind, n.type AS type, n.title AS title, n.summary AS summary
             FROM edges e LEFT JOIN nodes n ON n.id = CASE WHEN e.src = ?1 THEN e.dst ELSE e.src END
             WHERE ${where}
             ORDER BY CASE WHEN n.kind = 'knowledge' THEN 0 ELSE 1 END, e.rel, n.id
             LIMIT ${Math.max(1, Math.floor(limit))}`).all(...args);
        const neighbours = rows.map((row): Neighbour => {
            const outgoing = text(row.src) === id;
            return {
                relation: text(row.rel), direction: outgoing ? 'out' : 'in', id: outgoing ? text(row.dst) : text(row.src),
                ...(text(row.kind) ? { kind: text(row.kind) } : {}), ...(text(row.type) ? { type: text(row.type) } : {}),
                ...(text(row.title) ? { title: text(row.title) } : {}), ...(text(row.summary) ? { summary: text(row.summary) } : {}),
            };
        });
        return { neighbours, total };
    }
}

/** Round-robin by rank over several ranked lists, the first list first within a rank, without repeats. */
export function interleaveByRank(lists: readonly (readonly string[])[], limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const longest = Math.max(0, ...lists.map((list) => list.length));
    for (let rank = 0; rank < longest && out.length < limit; rank++) {
        for (const list of lists) {
            const id = list[rank];
            if (id !== undefined && !seen.has(id)) {
                seen.add(id);
                out.push(id);
                if (out.length >= limit) {
                    break;
                }
            }
        }
    }
    return out;
}

/**
 * `pack:Vendor::Pack` for the index a pack ships, from its info table
 * (`pack`, written by cmsis-knowledge) or else from its label
 * (`Vendor::Pack@1.0.0`, `Vendor::Pack@1.0.0 (local)`); undefined for the
 * base index and a workspace index, which are not scoped.
 */
export function packScopeOf(label: string, info: Readonly<Record<string, string>>): string | undefined {
    const match = /^([^\s:@]+)::([^\s@]+)/.exec(info.pack ?? label);
    return match === null ? undefined : `pack:${match[1]}::${match[2]}`;
}

/** One open index of a set, and the pack it is scoped to when it is a pack's. */
interface Member {
    label: string;
    index: KnowledgeIndex;
    scope?: string;
}

/**
 * Several open indexes read as one: the base index of the setting, then
 * the indexes the installed packs and the workspace carry. Ids are looked
 * up in order, so the base wins a clash; ranked lists are merged by rank,
 * since BM25 scores of different files are not comparable; everything
 * else is the union. A view owns no file: `KnowledgeSet` opens and closes
 * them, `forContext` narrows to the members a project may see.
 */
class MemberView implements KnowledgeReader {
    constructor(protected readonly members: readonly Member[]) { }

    get file(): string {
        return this.members[0].index.file;
    }

    get info(): Readonly<Record<string, string>> {
        return { ...this.members[0].index.info, indexes: this.members.map((member) => member.label).join(', ') };
    }

    get skippedSymptoms(): number {
        return this.members.reduce((sum, member) => sum + member.index.skippedSymptoms, 0);
    }

    sources(): IndexSource[] {
        return this.members.map((member) => ({ label: member.label, file: member.index.file, units: member.index.unitCount() }));
    }

    sourceOf(id: string): string | undefined {
        const owner = this.members.find((member) => member.index.has(id));
        return owner === undefined || owner === this.members[0] ? undefined : owner.label;
    }

    fileOf(id: string): string | undefined {
        return this.members.find((member) => member.index.has(id))?.index.file;
    }

    close(): void {
        // A view owns no file.
    }

    forContext(context: ReadonlySet<string> | undefined): KnowledgeReader {
        const active = this.members.filter((member) => member.scope === undefined || (context !== undefined && context.has(member.scope)));
        return active.length === this.members.length ? this : new MemberView(active);
    }

    private each<T>(pick: (index: KnowledgeIndex) => T[]): T[] {
        return this.members.flatMap((member) => pick(member.index));
    }

    node(id: string): KnowledgeNode | undefined {
        for (const member of this.members) {
            const found = member.index.node(id);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    }

    has(id: string): boolean {
        return this.members.some((member) => member.index.has(id));
    }

    unitCount(): number {
        return this.members.reduce((sum, member) => sum + member.index.unitCount(), 0);
    }

    /** Up to `limit` hits of each index, merged by rank: a pack's hits take no slot from the base's. */
    bm25(query: string, limit: number): string[] {
        return interleaveByRank(this.members.map((member) => member.index.bm25(query, limit)), limit * this.members.length);
    }

    howToCoverage(words: readonly string[]): Map<string, number> {
        const count = new Map<string, number>();
        for (const member of this.members) {
            for (const [id, named] of member.index.howToCoverage(words)) {
                if (!count.has(id)) {
                    count.set(id, named);
                }
            }
        }
        return count;
    }

    unitIdsWithPrefix(prefix: string, limit: number): string[] {
        return [...new Set(this.each((index) => index.unitIdsWithPrefix(prefix, limit)))].sort().slice(0, limit);
    }

    exactSymptoms(lines: readonly string[], budget: SymptomMatchBudget = new SymptomMatchBudget()): string[] {
        return [...this.exactSymptomLines(lines, budget).keys()];
    }

    exactSymptomLines(lines: readonly string[], budget: SymptomMatchBudget = new SymptomMatchBudget()): Map<string, number> {
        const found = this.each((index) => {
            budget.consume();
            return [...index.exactSymptomLines(lines, budget)];
        });
        return new Map(found.sort((a, b) => a[1] - b[1]));
    }

    appliesTo(id: string): string[] {
        return [...new Set(this.each((index) => index.appliesTo(id)))];
    }

    scopesOf(id: string): string[] {
        // Scoped by the index the unit is read from: a base unit of the same id is not. A pack's unit
        // without a scoped_to edge (an index built without them) is scoped to its pack, never universal.
        const owner = this.members.find((member) => member.index.has(id));
        if (owner === undefined) {
            return [];
        }
        const scopes = owner.index.scopesOf(id);
        return scopes.length === 0 && owner.scope !== undefined ? [owner.scope] : scopes;
    }

    refinements(): [specific: string, general: string][] {
        return this.each((index) => index.refinements());
    }

    ancestors(id: string): Set<string> {
        const seen = new Set<string>();
        for (const member of this.members) {
            member.index.ancestors(id).forEach((ancestor) => seen.add(ancestor));
        }
        // An entity of one index may continue in another (a pack's family in the base).
        for (const ancestor of [...seen]) {
            if (ancestor !== id) {
                this.members.forEach((member) => member.index.ancestors(ancestor).forEach((more) => seen.add(more)));
            }
        }
        return seen;
    }

    mountedDevices(board: string): string[] {
        return [...new Set(this.each((index) => index.mountedDevices(board)))];
    }

    mountedParts(board: string): string[] {
        return [...new Set(this.each((index) => index.mountedParts(board)))];
    }

    componentIds(name: string): string[] {
        return [...new Set(this.each((index) => index.componentIds(name)))];
    }

    units(): KnowledgeNode[] {
        const seen = new Set<string>();
        return this.each((index) => index.units()).filter((node) => !seen.has(node.id) && seen.add(node.id));
    }

    nodeCounts(): { kind: string; type: string; count: number }[] {
        const sums = new Map<string, { kind: string; type: string; count: number }>();
        for (const entry of this.each((index) => index.nodeCounts())) {
            const key = `${entry.kind}/${entry.type}`;
            sums.set(key, { ...entry, count: (sums.get(key)?.count ?? 0) + entry.count });
        }
        return [...sums.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    }

    relationCounts(): { relation: string; count: number }[] {
        const sums = new Map<string, number>();
        for (const entry of this.each((index) => index.relationCounts())) {
            sums.set(entry.relation, (sums.get(entry.relation) ?? 0) + entry.count);
        }
        return [...sums].map(([relation, count]) => ({ relation, count })).sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation));
    }

    assetCounts(): Map<string, number> {
        const sums = new Map<string, number>();
        for (const [id, count] of this.each((index) => [...index.assetCounts()])) {
            sums.set(id, (sums.get(id) ?? 0) + count);
        }
        return sums;
    }

    assetsOf(id: string): Array<{ id: string; path: string }> {
        return this.each((index) => index.assetsOf(id));
    }

    neighbours(id: string, relation: string | undefined, limit: number): { neighbours: Neighbour[]; total: number } {
        const parts = this.members.map((member) => member.index.neighbours(id, relation, limit));
        const total = parts.reduce((sum, part) => sum + part.total, 0);
        const all = parts.flatMap((part) => part.neighbours);
        const rank = (n: Neighbour): number => (n.kind === 'knowledge' ? 0 : 1);
        const neighbours = all.sort((a, b) => rank(a) - rank(b) || a.relation.localeCompare(b.relation) || a.id.localeCompare(b.id)).slice(0, limit);
        return { neighbours, total };
    }
}

/** The indexes of a window, opened from their files and closed together. */
export class KnowledgeSet extends MemberView {
    /** `files`: base first; a file that cannot be opened fails the whole set, as one bad index would. */
    constructor(files: readonly { label: string; file: string }[]) {
        if (files.length === 0) {
            throw new ToolError('TOOL_DISABLED', 'No knowledge index is set',
                'Ask the user to set cmsis-developer-assistant.knowledge.indexPath to a knowledge.db.');
        }
        const opened: Member[] = [];
        const compilation = new SymptomCompilationBudget();
        try {
            for (const { label, file } of files) {
                const index = new KnowledgeIndex(file, compilation);
                const scope = opened.length === 0 ? undefined : packScopeOf(label, index.info);
                opened.push({ label, index, ...(scope === undefined ? {} : { scope }) });
            }
        } catch (caught) {
            opened.forEach((member) => member.index.close());
            throw caught;
        }
        super(opened);
    }

    close(): void {
        this.members.forEach((member) => member.index.close());
    }
}
