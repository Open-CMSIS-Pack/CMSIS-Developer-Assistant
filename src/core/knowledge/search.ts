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
 * Search over a knowledge index, after `kb_lib.py` of the knowledge-base
 * prototype:
 *
 *   1. The project (device, cores, compiler, components, tools) becomes a set
 *      of entity ids, with what the index knows above them.
 *   2. The reader is narrowed to the indexes the project may see
 *      (`forContext`): the base, the workspace, the packs the context names.
 *      Candidates come from BM25, `CANDIDATES` of each index; a unit whose
 *      symptom pattern matches a line of the query stands first. A question of a few words is a task
 *      name, and the procedure or routing unit whose "when to use" text
 *      holds that name is lifted to the top (`HOW_TO_BONUS`): BM25 alone
 *      ranks a short reference unit that carries the word in its title above
 *      a procedure that names it once in a long description. A query that
 *      names a unit by its id puts that unit first (`ID_BONUS`), and one
 *      that is the start of a few ids puts those units first (`ID_PREFIX_BONUS`):
 *      BM25 splits `proc-cmsis-debug-live` into four common words.
 *   3. A unit a pack ships is scoped to that pack (`scoped_to`, or the pack
 *      of its index): only a project that uses the pack sees it, and
 *      without a project nobody.
 *      A unit without `applies_to` holds everywhere. Otherwise each
 *      dimension it names (core, toolchain, tool, …) must have one target in
 *      the project; a dimension the project says nothing about leaves the
 *      unit in, marked `unverified` (the tool dimension unmarked: it
 *      belongs to the question, and only `tools` filters by it). A more specific unit (`refines`)
 *      replaces the general one.
 *   4. The answer holds summaries up to a token budget; the full text is
 *      `knowledge_get`.
 *
 * Pure: the index is passed in.
 */

import { queryWords } from './store';
import type { KnowledgeNode, KnowledgeReader } from './store';
import { SymptomMatchBudget } from './symptomPattern';

/** Reciprocal rank fusion, as in the prototype, so scores stay comparable with it. */
const RANK_FUSION_K = 60;
/**
 * What a procedure gets on top of its rank score: about five places. Next to
 * reference text converted from the documentation, a task question should
 * lead to the procedure that does the task when one matches at all well; an
 * API question still leads to the API. Routing units get none: they name
 * every procedure of their domain, so they match nearly any task question,
 * and the agent reads them by id. Tuned on the golden set of the knowledge
 * base (tests/golden.json).
 */
const HOW_TO_PRIOR = 0.001;
/**
 * The most content words a question may have to count as a task name
 * (`HardFault`, `create a new project`). A longer question carries
 * specifics — an API, an option, a message — that the reference text
 * answers better, and the bonus on it cost the golden set.
 */
const HOW_TO_QUERY_WORDS = 3;
/**
 * What a how-to unit gets whose title, summary or triggers name the task:
 * all of the words of a one- or two-word question, all but one of a
 * three-word one, scaled by the share named. Above the whole spread of the
 * rank scores (1/61 to 1/121), so that the unit stands at the top from
 * anywhere among the candidates, and also when BM25 left it out. Tuned
 * with the golden set, which it leaves unchanged.
 */
const HOW_TO_BONUS = 0.010;
/**
 * What an exact message on the first line of a query gets more than one on
 * the last. In tool output the first error is the cause and later ones, such
 * as "processing context failed", follow from it. Above the spread of the
 * rank scores, so that among exact matches the order of the lines decides.
 */
const FIRST_LINE_BONUS = 0.05;
/**
 * What a unit gets whose id the query names, as the whole query or as one
 * of its words: above an exact symptom (1 + `FIRST_LINE_BONUS`), since an
 * agent that names an id wants that unit and no other.
 */
const ID_BONUS = 2;
/**
 * What a unit gets whose id starts with the query, when the query is one
 * word that names no unit and starts at most `ID_PREFIX_UNITS` ids (an id
 * cut short, `proc-cmsis-debug`): above the rank scores and the how-to
 * bonus, below an exact symptom.
 */
const ID_PREFIX_BONUS = 0.5;
const ID_PREFIX_UNITS = 10;
/** A word that can be a unit id: lower-case letters, digits, dots and dashes, with a dash after the type prefix. */
const ID_SHAPE = /^[a-z0-9][a-z0-9._]*-[a-z0-9._-]*$/;
const CANDIDATES = 60;
export const DEFAULT_RESULTS = 8;
export const DEFAULT_BUDGET_TOKENS = 800;

/** What is known about the project a search runs for; every field is optional. */
export interface ProjectFacts {
    /** `STM32U585AIIx`, also with `Vendor::` in front or `:pname` behind. */
    device?: string;
    /** `B-U585I-IOT02A`, also with `Vendor::` in front or a revision behind. */
    board?: string;
    /** `AC6`, `GCC@>=14.2`. */
    compiler?: string;
    /** `Dcore` of the device's processors: `Cortex-M33`. */
    cores?: readonly string[];
    /** `Vendor::Name` of the packs the project uses: the device and board packs and those its build lists. */
    packs?: readonly string[];
    /** `ARM::CMSIS:CORE@6.1.0`. */
    components?: readonly string[];
    /** The tools the question is about: `csolution`, `packchk`, `svdconv`. */
    tools?: readonly string[];
}

export interface SearchOptions {
    domain?: string;
    types?: readonly string[];
    /** The project's entities; undefined searches without a filter. */
    context?: ReadonlySet<string>;
    /** Results at most. */
    k?: number;
    budgetTokens?: number;
    /** Also return units whose text is still a placeholder. */
    includeIncomplete?: boolean;
}

export interface SearchHit {
    id: string;
    type: string;
    title: string;
    summary: string;
    /** `draft` or `reviewed`. */
    status: string;
    score: number;
    /** The query holds this unit's error message. */
    exactSymptom: boolean;
    /** Size of the full unit, in tokens. */
    fullTokens: number;
    /** The unit targets something the project context does not cover. */
    applies?: 'unverified';
    /** The unit has no cause or text yet. */
    incomplete?: true;
    /** The index the unit came from, when not the base index: a pack or the workspace. */
    source?: string;
}

export interface SearchResult {
    results: SearchHit[];
    budgetUsed: number;
    /** Units that matched and apply, before the budget and `k`. */
    matched: number;
    /** Matching units left out because their text is a placeholder. */
    incompleteHidden: number;
    /** Of those, the units the query's message matched exactly: the index knows the message and nothing more. */
    incompleteExact: string[];
    contextFilter: boolean;
}

/** A rough token count, enough for a budget: four characters a token. */
export function tokensOf(value: string): number {
    return Math.floor(value.length / 4) + 1;
}

/** The lines of tool output without the `error csolution:` or `file - warning csolution:` in front. */
export function messageLines(query: string): string[] {
    return query.split(/\r?\n/).map((line) => line.replace(/^.*?\b(?:error|warning|info)\s+[\w.-]+:\s*/, '').trim());
}

/** The text of a `## heading` section of a unit body, trimmed; undefined without that section. */
export function sectionOf(body: string, heading: string): string | undefined {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
    if (start < 0) {
        return undefined;
    }
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^##? /.test(line));
    return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** A text that is one italic line: the prototype's "to be written" marker, in whatever language. */
function isPlaceholder(value: string): boolean {
    return /^_[^_\n]+_$/.test(value.trim());
}

/**
 * True for a unit that has nothing to say yet: `cause: missing` in its
 * frontmatter, a troubleshooting unit whose Cause is a placeholder, or a
 * body that is one.
 */
export function isIncomplete(node: KnowledgeNode): boolean {
    if (node.kind !== 'knowledge') {
        return false;
    }
    if (node.meta.cause === 'missing' || isPlaceholder(node.body)) {
        return true;
    }
    const cause = node.type === 'troubleshooting' ? sectionOf(node.body, 'Cause') : undefined;
    return cause !== undefined && (cause.length === 0 || isPlaceholder(cause));
}

/** What a search shows of a unit that has no summary: the symptom, or the first forty words. */
function fallbackSummary(node: KnowledgeNode): string {
    const symptoms = Array.isArray(node.meta.symptoms) ? node.meta.symptoms.filter((s): s is string => typeof s === 'string') : [];
    if (node.type === 'troubleshooting' && symptoms.length > 0) {
        return `[${typeof node.meta.tool === 'string' ? node.meta.tool : ''}] ${symptoms[symptoms.length - 1]}`;
    }
    return node.body.replace(/^#+ .*$|[`*_]/gm, '').split(/\s+/).filter((word) => word.length > 0).slice(0, 40).join(' ');
}

function withoutVersion(value: string): string {
    return value.replace(/@.*$/, '').trim();
}

/** `infineon` for `component:Infineon::Device:Startup`; empty for an id without a vendor. */
function componentVendor(id: string): string {
    const rest = id.replace(/^component:/, '');
    return rest.includes('::') ? rest.slice(0, rest.indexOf('::')).trim().toLowerCase() : '';
}

/**
 * The entity ids of a project: the ids its facts name, and for a device or
 * board the index knows, what stands above it there. A component with its
 * vendor is that vendor's alone.
 */
export function contextEntities(index: KnowledgeReader, facts: ProjectFacts): Set<string> {
    const entities = new Set<string>();
    const addWithAncestors = (id: string): void => {
        for (const ancestor of index.ancestors(id)) {
            entities.add(ancestor);
        }
    };
    if (facts.device) {
        const name = facts.device.split('::').pop()!.split(':')[0].trim();
        addWithAncestors(`device:${name}`);
    }
    if (facts.board) {
        const [vendor, rest] = facts.board.includes('::') ? facts.board.split('::', 2) : [undefined, facts.board];
        const name = withoutVersion(rest).split(':')[0].trim();
        for (const id of [`board:${name}`, ...(vendor ? [`board:${vendor.trim()}::${name}`] : [])]) {
            addWithAncestors(id);
            for (const device of index.mountedDevices(id)) {
                addWithAncestors(device);
            }
            for (const part of index.mountedParts(id)) {
                entities.add(part);
            }
        }
    }
    for (const core of facts.cores ?? []) {
        entities.add(`core:${core}`);
    }
    for (const pack of facts.packs ?? []) {
        entities.add(`pack:${withoutVersion(pack)}`);
    }
    for (const given of facts.components ?? []) {
        // `Vendor::Class&Bundle:Group&Variant@1.0.0` is the entity `component:Vendor::Class:Group`.
        const component = withoutVersion(given).replace(/&[^:]*/g, '');
        const separator = component.indexOf('::');
        const vendor = separator >= 0 ? component.slice(0, separator).trim() : undefined;
        if (vendor !== undefined) {
            entities.add(`component:${component}`);
        }
        // By the name alone, which finds the vendor of `CMSIS:CORE`; a component that names its vendor keeps to
        // it: `Device:Startup` is the name of some 40 vendors' components, and their units are not this project's.
        for (const id of index.componentIds(separator >= 0 ? component.slice(separator + 2) : component)) {
            if (vendor === undefined || componentVendor(id) === vendor.toLowerCase()) {
                entities.add(id);
            }
        }
    }
    if (facts.compiler) {
        entities.add(`toolchain:${withoutVersion(facts.compiler).toUpperCase()}`);
    }
    for (const tool of facts.tools ?? []) {
        entities.add(`tool:${tool.trim().toLowerCase()}`);
    }
    return entities;
}

/**
 * May a project see a unit? A unit scoped to packs only when the project
 * uses one of them; without a context, never.
 */
export function inScope(scopes: readonly string[], context: ReadonlySet<string> | undefined): boolean {
    return scopes.length === 0 || (context !== undefined && scopes.some((scope) => context.has(scope)));
}

/**
 * Does a unit apply in a context? AND across the dimensions it targets, OR
 * within one. A dimension the context does not mention at all does not
 * exclude the unit; it marks it `unverified`.
 */
export function appliesIn(targets: readonly string[], context: ReadonlySet<string> | undefined): { applies: boolean; unverified: boolean } {
    if (targets.length === 0 || context === undefined) {
        return { applies: true, unverified: false };
    }
    const dimensionOf = (id: string): string => id.split(':', 1)[0];
    const contextDimensions = new Set([...context].map(dimensionOf));
    const byDimension = new Map<string, string[]>();
    for (const target of targets) {
        byDimension.set(dimensionOf(target), [...(byDimension.get(dimensionOf(target)) ?? []), target]);
    }
    let unverified = false;
    for (const [dimension, wanted] of byDimension) {
        if (wanted.some((target) => context.has(target))) {
            continue;
        }
        if (!contextDimensions.has(dimension)) {
            // A project has no tool: only a caller that names tools filters by them.
            unverified = unverified || dimension !== 'tool';
            continue;
        }
        return { applies: false, unverified: false };
    }
    return { applies: true, unverified };
}

/**
 * The units the query names by id, each with its bonus: every word of the
 * query that is a unit's id, or, for a query of one word that is none, the
 * units whose id starts with it when there are few. Quotes and brackets
 * around a word do not count.
 */
export function unitsNamed(index: KnowledgeReader, query: string): Map<string, number> {
    const words = query.split(/[\s,;`'"()[\]{}<>]+/).map((word) => word.replace(/[.:]+$/, '').toLowerCase()).filter((word) => ID_SHAPE.test(word));
    const named = new Map<string, number>();
    for (const word of words) {
        if (index.node(word)?.kind === 'knowledge') {
            named.set(word, ID_BONUS);
        }
    }
    if (named.size === 0 && words.length === 1 && query.trim().split(/\s+/).length === 1) {
        const starting = index.unitIdsWithPrefix(words[0], ID_PREFIX_UNITS + 1);
        if (starting.length <= ID_PREFIX_UNITS) {
            starting.forEach((id) => named.set(id, ID_PREFIX_BONUS));
        }
    }
    return named;
}

/** Search the index; see the head of this file for the steps. */
export function searchKnowledge(reader: KnowledgeReader, query: string, options: SearchOptions = {}): SearchResult {
    const index = reader.forContext(options.context);
    const k = options.k ?? DEFAULT_RESULTS;
    const budget = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
    const lines = messageLines(query);
    const exactAt = index.exactSymptomLines(lines);
    const exact = new Set(exactAt.keys());
    const score = new Map<string, number>();
    index.bm25(query, CANDIDATES).forEach((id, rank) => score.set(id, 1 / (RANK_FUSION_K + rank + 1)));
    for (const [id, line] of exactAt) {
        score.set(id, (score.get(id) ?? 0) + 1 + FIRST_LINE_BONUS * (1 - line / lines.length));
    }
    for (const [id, value] of score) {
        const type = index.node(id)?.type;
        if (type === 'procedure' && !id.startsWith('route-')) {
            score.set(id, value + HOW_TO_PRIOR);
        }
    }
    for (const [id, bonus] of unitsNamed(index, query)) {
        score.set(id, (score.get(id) ?? 0) + bonus);
    }
    const words = queryWords(query).filter((word) => word.length > 1);
    if (words.length > 0 && words.length <= HOW_TO_QUERY_WORDS) {
        const needed = words.length <= 2 ? words.length : words.length - 1;
        const unlisted = 1 / (RANK_FUSION_K + CANDIDATES + 1);
        for (const [id, named] of index.howToCoverage(words)) {
            if (named >= needed) {
                score.set(id, (score.get(id) ?? unlisted) + HOW_TO_BONUS * named / words.length);
            }
        }
    }

    interface Candidate { node: KnowledgeNode; score: number; unverified: boolean }
    const candidates: Candidate[] = [];
    let incompleteHidden = 0;
    const incompleteExact: string[] = [];
    for (const [id, value] of [...score].sort((a, b) => b[1] - a[1])) {
        const node = index.node(id);
        if (node === undefined || node.kind !== 'knowledge'
            || (options.domain !== undefined && node.domain !== options.domain)
            || (options.types !== undefined && options.types.length > 0 && !options.types.includes(node.type))) {
            continue;
        }
        if (!inScope(index.scopesOf(id), options.context)) {
            continue;
        }
        const { applies, unverified } = appliesIn(index.appliesTo(id), options.context);
        if (!applies) {
            continue;
        }
        if (options.includeIncomplete !== true && isIncomplete(node)) {
            incompleteHidden++;
            if (exact.has(id)) {
                incompleteExact.push(id);
            }
            continue;
        }
        candidates.push({ node, score: value, unverified });
    }

    // Only a unit that certainly applies replaces the general one it refines.
    const certain = new Set(candidates.filter((c) => !c.unverified).map((c) => c.node.id));
    const replaced = new Set(index.refinements().filter(([specific]) => certain.has(specific)).map(([, general]) => general));
    const kept = candidates.filter((c) => !replaced.has(c.node.id));

    const results: SearchHit[] = [];
    let used = 0;
    for (const { node, score: value, unverified } of kept) {
        const hit: SearchHit = {
            id: node.id, type: node.type, title: node.title, summary: node.summary || fallbackSummary(node),
            status: typeof node.meta.status === 'string' ? node.meta.status : 'draft',
            score: Math.round(value * 10_000) / 10_000, exactSymptom: exact.has(node.id), fullTokens: tokensOf(node.body),
            ...(unverified ? { applies: 'unverified' as const } : {}),
            ...(isIncomplete(node) ? { incomplete: true as const } : {}),
            ...(index.sourceOf(node.id) !== undefined ? { source: index.sourceOf(node.id) } : {}),
        };
        const cost = tokensOf(JSON.stringify(hit));
        if (results.length > 0 && used + cost > budget) {
            break;
        }
        results.push(hit);
        used += cost;
        if (results.length >= k) {
            break;
        }
    }
    return { results, budgetUsed: used, matched: kept.length, incompleteHidden, incompleteExact, contextFilter: options.context !== undefined };
}

/** A unit a failed build's error message points to; `summary` when the message only sums up the errors before it. */
export interface KnownMessage {
    message: string;
    id: string;
    summary?: true;
}

/**
 * True for a unit whose message only sums up the errors printed before it
 * (`role: summary`, such as csolution's `processing context '…' failed`):
 * it has no cause of its own to tell.
 */
function isSummary(node: KnowledgeNode): boolean {
    return node.meta.role === 'summary';
}

/**
 * The complete unit behind each message that the index knows by its exact
 * symptom: what a failed build's error lines can point to, in the order of
 * the messages. A pack's unit only when `context`, the project's entities,
 * has the pack. A summary unit comes after all others, and is left out when
 * another unit was found for an earlier message (or the same one): that
 * unit is what the agent needs.
 */
export function knownMessages(
    reader: KnowledgeReader,
    messages: readonly string[],
    context?: ReadonlySet<string>,
    budget: SymptomMatchBudget = new SymptomMatchBudget(),
): KnownMessage[] {
    const index = reader.forContext(context);
    const found: { message: string; id: string; at: number; summary: boolean }[] = [];
    messages.forEach((message, at) => {
        budget.consume();
        for (const id of index.exactSymptoms(messageLines(message), budget)) {
            const node = index.node(id);
            if (node !== undefined && !isIncomplete(node) && inScope(index.scopesOf(id), context) && !found.some((f) => f.id === id)) {
                found.push({ message, id, at, summary: isSummary(node) });
            }
        }
    });
    const causes = found.filter((f) => !f.summary);
    const summaries = found.filter((f) => f.summary && !causes.some((cause) => cause.at <= f.at));
    return [...causes, ...summaries].map(({ message, id, summary }) => ({ message, id, ...(summary ? { summary: true as const } : {}) }));
}
