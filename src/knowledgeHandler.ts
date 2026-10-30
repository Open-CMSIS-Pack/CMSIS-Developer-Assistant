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
 * One method per knowledge tool, each returning the text the agent sees and
 * the same content as data: `knowledge_search` (summaries, filtered by the
 * active project), `knowledge_get` (one unit, whole) and `knowledge_expand`
 * (one hop in the graph). Experimental: the core index ships with the
 * extension (`resources/knowledge/core.db`, pinned by `core.lock.json`),
 * `knowledge.indexPath` replaces it, packs and the workspace add their own;
 * see docs/architecture/knowledge.md and docs/proposals/knowledge-base.md.
 *
 * The shape of `BuildInfoHandler`: no `vscode` import, the host is
 * injected, every call runs under the fence and trace of `core/toolRun.ts`.
 */

import * as fs from 'fs';
import { describeFacts, ProjectFactsResult } from './core/knowledge/projectFacts';
import {
    contextEntities, DEFAULT_RESULTS, isIncomplete, knownMessages, ProjectFacts, searchKnowledge, SearchHit, tokensOf,
} from './core/knowledge/search';
import { discoverIndexes, PackFolder } from './core/knowledge/packIndexes';
import { KnowledgeNode, KnowledgeReader, KnowledgeSet, Neighbour } from './core/knowledge/store';
import type { PackDocsLog } from './core/packDocs/host';
import { JsonObject, JsonValue, ToolError, ToolText } from './core/toolResult';
import { runTool } from './core/toolRun';

/** What the handler needs from its window. */
export interface KnowledgeHost {
    /** `knowledge.indexPath` as an absolute path; undefined when it is not set. */
    indexPath(): string | undefined;
    /** `knowledge.includeIncomplete`: also show units whose text is a placeholder. */
    includeIncomplete(): boolean;
    /** The pack root whose installed packs may carry an index; undefined when unknown. */
    packRoot(): Promise<string | undefined>;
    /** The open workspace folders, which may carry `.cmsis/knowledge.db`. */
    workspaceFolders(): string[];
    /**
     * The folders of the active target's packs, when the host knows them
     * outside the pack root (the CMSIS Solution extension's DFP and BSP
     * folders); their `.knowledge/knowledge.db` is read like an installed pack's.
     */
    packFolders?(): Promise<readonly PackFolder[]>;
    /** The facts of the window's active target. */
    projectFacts(): Promise<ProjectFactsResult>;
    log: PackDocsLog;
}

export interface KnowledgeHandlerOptions {
    /** Default per-call timeout. */
    timeoutMs: number;
}

export interface KnowledgeSearchArgs {
    query?: string;
    /** The tools the question is about: `packchk`, `svdconv`, `csolution`. */
    tools?: string[];
    types?: string[];
    domain?: string;
    k?: number;
}

export interface KnowledgeGetArgs {
    id?: string;
}

export interface KnowledgeExpandArgs {
    id?: string;
    relation?: string;
}

const TIMEOUT_NOTE = 'Call again.';
/** Neighbours one `knowledge_expand` lists; a pack entity has thousands. */
const MAX_NEIGHBOURS = 40;
/** Hits a search of the knowledge browser returns at most. */
const BROWSE_RESULTS = 80;
/** Frontmatter fields `knowledge_get` shows above the body, in this order. */
const SHOWN_META = ['tool', 'code', 'severity', 'applies_to', 'requires', 'refines', 'constrains', 'produces', 'consumes',
    'references', 'triggers', 'preconditions', 'verification', 'stop_conditions', 'source', 'doc_source', 'license'];

function asJson(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function metaLine(key: string, value: unknown): string {
    if (Array.isArray(value)) {
        return `${key}: ${value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('; ')}`;
    }
    return `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
}

function hitLines(hit: SearchHit, position: number): string[] {
    const marks = [hit.type, hit.status, ...(hit.exactSymptom ? ['exact symptom'] : []), ...(hit.applies ? ['applies: unverified'] : []),
        ...(hit.incomplete ? ['no cause recorded'] : []), ...(hit.source ? [`from ${hit.source}`] : []), `full text about ${hit.fullTokens} tokens`];
    return [`${position}. ${hit.id} · ${marks.join(' · ')}`, `   ${hit.title}`, ...(hit.summary && hit.summary !== hit.title ? [`   ${hit.summary}`] : [])];
}

function neighbourLine(neighbour: Neighbour): string {
    const arrow = neighbour.direction === 'out' ? `${neighbour.relation} →` : `← ${neighbour.relation}`;
    const what = [neighbour.type, neighbour.title].filter((part) => part && part !== neighbour.id).join(' · ');
    return `  ${arrow} ${neighbour.id}${what ? ` · ${what}` : ''}${neighbour.summary ? `\n      ${neighbour.summary}` : ''}`;
}

export class KnowledgeHandler {
    private callCounter = 0;
    private open?: { key: string; index: KnowledgeReader };

    constructor(private readonly host: KnowledgeHost, private readonly options: KnowledgeHandlerOptions) { }

    // ------------------------------------------------------------------ tools

    public handleKnowledgeSearch(args: KnowledgeSearchArgs): Promise<ToolText> {
        return this.run('knowledge_search', args, async () => {
            const query = args.query?.trim();
            if (!query) {
                throw new ToolError('INVALID_ARGUMENT', 'knowledge_search needs a query', 'Pass the exact error text, or the question in a few words.');
            }
            const index = await this.index();
            const project = await this.host.projectFacts();
            const tools = (args.tools ?? []).map((tool) => tool.trim()).filter((tool) => tool.length > 0);
            const facts: ProjectFacts | undefined = project.facts || tools.length > 0 ? { ...project.facts, tools } : undefined;
            const context = facts ? contextEntities(index, facts) : undefined;
            const result = searchKnowledge(index, query, {
                domain: args.domain?.trim() || undefined, types: args.types, context, k: args.k ?? DEFAULT_RESULTS,
                includeIncomplete: this.host.includeIncomplete(),
            });

            const projectText = project.facts ? `${describeFacts(project.facts)} (active target)` : '';
            const contextText = [projectText, tools.length > 0 ? `tools ${tools.join(', ')}` : ''].filter((part) => part.length > 0).join('; ');
            const lines = [`Knowledge search: ${result.results.length} of ${result.matched} matching units, about ${result.budgetUsed} tokens.`];
            lines.push(contextText ? `Context: ${contextText}.` : `No project context: ${project.note ?? 'none'}.`);
            const extra = index.sources().slice(1);
            if (extra.length > 0) {
                // A pack's index outside the project is open but not searched: say so, or its units seem lost.
                const active = new Set(index.forContext(context).sources().map((source) => source.label));
                lines.push(`Indexes: base and ${extra.map((source) =>
                    `${source.label} (${source.units} units${active.has(source.label) ? '' : '; its pack is not in the project'})`).join(', ')}.`);
            }
            for (const id of result.incompleteExact) {
                lines.push(`The index knows this message as ${id}, but no cause or fix is recorded for it yet; the units below are related at best.`);
            }
            if (project.facts && project.note) {
                lines.push(`Note: ${project.note}; units for one core are marked unverified.`);
            }
            result.results.forEach((hit, i) => lines.push(...hitLines(hit, i + 1)));
            if (result.incompleteHidden > 0) {
                lines.push(`${result.incompleteHidden} matching unit${result.incompleteHidden === 1 ? ' has' : 's have'} no cause or text yet and ${result.incompleteHidden === 1 ? 'is' : 'are'} left out.`);
            }
            lines.push(result.results.length > 0
                ? 'Next: knowledge_get { id } for the full unit before acting on it; knowledge_expand { id } for what it requires.'
                : 'Nothing matched. Try the exact error text, fewer words, or tools: ["csolution"] for a message of one tool.');
            return {
                text: lines.join('\n'), status: 'ok',
                data: {
                    results: asJson(result.results), budgetUsed: result.budgetUsed, matched: result.matched,
                    incompleteHidden: result.incompleteHidden, incompleteExact: result.incompleteExact, contextFilter: result.contextFilter,
                    indexes: index.sources().map((source) => ({ label: source.label, units: source.units })),
                    // The count, not the ids: the list cost about 1.7 KB in every reply and nothing reads it.
                    ...(context ? { contextEntities: context.size } : {}),
                    ...(project.note ? { contextNote: project.note } : {}),
                },
            };
        });
    }

    public handleKnowledgeGet(args: KnowledgeGetArgs): Promise<ToolText> {
        return this.run('knowledge_get', args, async () => {
            const node = await this.nodeOf('knowledge_get', args.id);
            const status = typeof node.meta.status === 'string' ? node.meta.status : undefined;
            const source = (await this.index()).sourceOf(node.id);
            const head = [node.id, node.type, status, node.domain, ...(source ? [`from ${source}`] : [])].filter((part) => part).join(' · ');
            const lines = [head, node.title];
            if (node.kind === 'knowledge' && isIncomplete(node)) {
                lines.push('This unit has no cause or text yet: it names the message, not what to do about it.');
            }
            if (node.summary) {
                lines.push(`summary: ${node.summary}`);
            }
            const shown = node.kind === 'knowledge' ? SHOWN_META : Object.keys(node.meta);
            for (const key of shown) {
                const value = node.meta[key];
                if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
                    lines.push(metaLine(key, value));
                }
            }
            // The files the unit names by path, such as a template to copy: each is a node of its own.
            const files = node.kind === 'knowledge' ? (await this.index()).assetsOf(node.id) : [];
            if (files.length > 0) {
                lines.push('files (the text names them by path; knowledge_get with the id returns the file):',
                    ...files.map((file) => `  ${file.path} → ${file.id}`));
            }
            // The body follows whole: a procedure is never clipped.
            const text = node.body ? `${lines.join('\n')}\n\n${node.body}` : lines.join('\n');
            const data: JsonObject = {
                id: node.id, kind: node.kind, type: node.type, title: node.title, summary: node.summary,
                ...(node.domain ? { domain: node.domain } : {}), meta: asJson(node.meta), tokens: tokensOf(node.body),
                ...(files.length > 0 ? { files: asJson(files) } : {}),
            };
            return { text, status: 'ok', data };
        });
    }

    public handleKnowledgeExpand(args: KnowledgeExpandArgs): Promise<ToolText> {
        return this.run('knowledge_expand', args, async () => {
            const node = await this.nodeOf('knowledge_expand', args.id);
            const relation = args.relation?.trim() || undefined;
            const { neighbours, total } = (await this.index()).neighbours(node.id, relation, MAX_NEIGHBOURS);
            const lines = [`${node.id} · ${node.type} · ${node.title}`];
            if (total === 0) {
                lines.push(relation ? `No ${relation} relation.` : 'No relations.');
            } else {
                lines.push(`${total} relation${total === 1 ? '' : 's'}${relation ? ` of kind ${relation}` : ''}${total > neighbours.length ? `, the first ${neighbours.length} shown, knowledge units first` : ''}:`);
                lines.push(...neighbours.map(neighbourLine));
                if (total > neighbours.length) {
                    lines.push(`${total - neighbours.length} more are not shown; pass relation to narrow.`);
                }
            }
            return { text: lines.join('\n'), status: 'ok', data: { id: node.id, total, neighbours: asJson(neighbours) } };
        });
    }

    // -------------------------------------------------------- for the window

    /**
     * The complete units behind the error messages of a failed build, as
     * lines for its result. Never throws: without an index, or with one that
     * cannot be read, there are no lines.
     */
    // ------------------------------------------------------------- the browser

    /** The open index, for the knowledge browser; throws the typed failure of a missing or unreadable one. */
    public browseIndex(): Promise<KnowledgeReader> {
        return this.index();
    }

    /** `knowledge.indexPath` as the host resolves it. */
    public indexFile(): string | undefined {
        return this.host.indexPath();
    }

    /**
     * A search for the knowledge browser: every match in rank order, without
     * a token budget and with the incomplete units, optionally filtered by
     * the active project like `knowledge_search`.
     */
    public async browseSearch(query: string, useContext: boolean): Promise<{
        ids: string[]; exact: string[]; unverified: string[]; matched: number; context?: string; note?: string;
    }> {
        const index = await this.index();
        const project = useContext ? await this.host.projectFacts() : undefined;
        const context = project?.facts ? contextEntities(index, project.facts) : undefined;
        const result = searchKnowledge(index, query, { context, k: BROWSE_RESULTS, budgetTokens: Number.MAX_SAFE_INTEGER, includeIncomplete: true });
        return {
            ids: result.results.map((hit) => hit.id),
            exact: result.results.filter((hit) => hit.exactSymptom).map((hit) => hit.id),
            unverified: result.results.filter((hit) => hit.applies === 'unverified').map((hit) => hit.id),
            matched: result.matched,
            ...(project?.facts ? { context: describeFacts(project.facts) } : {}),
            ...(useContext && !project?.facts ? { note: project?.note ?? 'no active project' } : {}),
        };
    }

    /**
     * The `Known message:` lines of a failed build's error messages, in the
     * order of `knownMessages`; a summary unit's line promises no cause.
     * None without an index or on any failure.
     */
    public async knownMessageLines(messages: readonly string[]): Promise<string[]> {
        try {
            if (this.host.indexPath() === undefined) {
                return [];
            }
            // The context of the build that failed: the active target now, not the project of the last search.
            const index = await this.index();
            const project = await this.host.projectFacts();
            const context = project.facts ? contextEntities(index, project.facts) : undefined;
            return knownMessages(index, messages, context).map(({ id, summary }) => (summary
                ? `Known message: knowledge_get { id: "${id}" } — the error line it matches only sums up the errors before it; fix the first of those.`
                : `Known message: knowledge_get { id: "${id}" } has its cause and fix.`));
        } catch (caught) {
            this.host.log.debug(`knowledge: no known-message lines: ${caught instanceof Error ? caught.message : String(caught)}`);
            return [];
        }
    }

    /** Close the index file. */
    public dispose(): void {
        this.open?.index.close();
        this.open = undefined;
    }

    // ---------------------------------------------------------------- helpers

    /**
     * The index of the setting with every index the installed packs and the
     * workspace carry, reopened when any file was rebuilt, added or removed.
     */
    private async index(): Promise<KnowledgeReader> {
        return this.openSet(await this.host.packRoot(), await this.packFolders());
    }

    /** The host's pack folders; none when it has no answer. Never throws. */
    private async packFolders(): Promise<readonly PackFolder[]> {
        try {
            return (await this.host.packFolders?.()) ?? [];
        } catch (caught) {
            this.host.log.debug(`knowledge: no pack folders: ${caught instanceof Error ? caught.message : String(caught)}`);
            return [];
        }
    }

    /** The set for a pack root and the active target's pack folders, reused while no file changed. */
    private openSet(packRoot: string | undefined, packFolders: readonly PackFolder[]): KnowledgeReader {
        const file = this.host.indexPath();
        if (file === undefined) {
            throw new ToolError('TOOL_DISABLED', 'No knowledge index is set',
                'Ask the user to set cmsis-developer-assistant.knowledge.indexPath to a knowledge.db.');
        }
        const files = [{ label: 'base', file }, ...discoverIndexes(packRoot, this.host.workspaceFolders(), packFolders)
            .filter((found) => found.file !== file)];
        const key = files.map(({ label, file: each }) => {
            try {
                const stat = fs.statSync(each);
                return `${label}|${each}|${stat.size}|${stat.mtimeMs}`;
            } catch {
                return `${label}|${each}|missing`; // opening it below says so
            }
        }).join('\n');
        if (this.open?.key !== key) {
            this.dispose();
            const index = new KnowledgeSet(files);
            this.host.log.info(`knowledge: opened ${index.sources().map((source) => `${source.label} ${source.file} (${source.units} units)`).join(', ')}`
                + `${index.skippedSymptoms > 0 ? `; ${index.skippedSymptoms} symptom patterns not usable` : ''}`);
            this.open = { key, index };
        }
        return this.open.index;
    }

    private async nodeOf(tool: string, id: string | undefined): Promise<KnowledgeNode> {
        const wanted = id?.trim();
        if (!wanted) {
            throw new ToolError('INVALID_ARGUMENT', `${tool} needs an id`, 'Take the id from a knowledge_search result.');
        }
        const node = (await this.index()).node(wanted);
        if (node === undefined) {
            throw new ToolError('INVALID_ARGUMENT', `The knowledge index has no "${wanted}"`, 'Take the id from a knowledge_search result.');
        }
        return node;
    }

    private run(tool: string, args: object, body: () => Promise<ToolText>): Promise<ToolText> {
        return runTool(tool, ++this.callCounter, args, this.host.log,
            { defaultTimeoutMs: this.options.timeoutMs, timeoutNote: TIMEOUT_NOTE }, () => body());
    }
}
