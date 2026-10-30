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
 * The pack each web example of a board comes from, asked of Arm's web
 * catalog, the service CMSIS Solution lists its web examples from.
 *
 * The catalog keeps one example per pack release that ships it: the XMC4700
 * Relax Kit has `snmp_agent_demo` from Oryx-Embedded::Middleware 2.6.6 and
 * from 2.4.4, with the same name and description. CMSIS Solution's API
 * passes on only the id, name, description and format of a web example, so
 * `cmsis_query` lists the two alike. This module asks the catalog for the
 * one field that tells them apart, the example's origin, by the same two
 * GraphQL queries the extension makes (the board by its CMSIS id, then the
 * board's projects), and only for a listing that has such twins.
 *
 * Pure: the fetch function and the clock come from the caller, and a
 * failure of any kind is an answer of nothing, never a throw.
 */

import { settleWithin } from './solutionApi';
import type { Clock } from './solutionApi';

/** The GraphQL endpoint CMSIS Solution reads its web examples from. */
export const WEB_CATALOG_URL = 'https://solar-search.api.keil.arm.com/';
/** Projects one request asks for; CMSIS Solution asks for as many. */
const PAGE_SIZE = 1000;

/** `fetch`, as far as it is used here. */
export type CatalogFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A board as CMSIS names it: what the catalog finds it by. */
export interface CatalogBoardId {
    vendor: string;
    name: string;
    revision?: string;
}

const BOARD_QUERY = 'query getBoard($name: String!, $vendor: String!, $revision: String!) { '
    + 'search_boards(has_example_projects: true, cmsis_board_id: {name: $name, vendor: $vendor, revision: $revision}) '
    + '{ results { id example_projects_count } } }';
const ORIGINS_QUERY = 'query getBoardProjectOrigins($boardId: String!, $offset: Int!, $limit: Int!) { '
    + 'search_projects(board_id: $boardId, offset: $offset, limit: $limit) { results { id origin { type url } } } }';

/** A JSON object's field, when the value is an object. */
function field(value: unknown, name: string): unknown {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

/**
 * `Oryx-Embedded::Middleware@2.6.6` for the origin URL
 * `https://pack-content.cmsis.io/packs/Oryx-Embedded.Middleware.2.6.6.pack`;
 * undefined for anything else. Pack vendors and names carry no dots.
 */
export function packOfOriginUrl(url: unknown): string | undefined {
    if (typeof url !== 'string') {
        return undefined;
    }
    const match = /([^/\\.]+)\.([^/\\.]+)\.(\d+\.\d+\.\d+[^/\\]*)\.pack$/i.exec(url.trim());
    return match ? `${match[1]}::${match[2]}@${match[3]}` : undefined;
}

/** One GraphQL request; its `data`, or a throw. */
async function ask(fetchFn: CatalogFetch, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const response = await fetchFn(WEB_CATALOG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const answer: unknown = await response.json();
    const data = field(answer, 'data');
    if (data === undefined || data === null) {
        throw new Error('no data in the answer');
    }
    return data;
}

/** The board's examples by id with the pack each came from; examples of another origin are left out. */
async function lookUp(fetchFn: CatalogFetch, board: CatalogBoardId, signal: AbortSignal): Promise<Map<string, string>> {
    const boards = field(field(await ask(fetchFn, BOARD_QUERY, { name: board.name, vendor: board.vendor, revision: board.revision ?? '' }, signal),
        'search_boards'), 'results');
    const first: unknown = Array.isArray(boards) ? boards[0] : undefined;
    const boardId = field(first, 'id');
    const count = field(first, 'example_projects_count');
    const origins = new Map<string, string>();
    if (typeof boardId !== 'string' || typeof count !== 'number' || count <= 0) {
        return origins;
    }
    for (let offset = 0; offset < count; offset += PAGE_SIZE) {
        const projects = field(field(await ask(fetchFn, ORIGINS_QUERY, { boardId, offset, limit: PAGE_SIZE }, signal), 'search_projects'), 'results');
        if (!Array.isArray(projects) || projects.length === 0) {
            break;
        }
        for (const project of projects) {
            const id = field(project, 'id');
            const pack = packOfOriginUrl(field(field(project, 'origin'), 'url'));
            if (typeof id === 'string' && pack !== undefined) {
                origins.set(id, pack);
            }
        }
    }
    return origins;
}

/**
 * The pack each web example of `board` comes from, by the example's id, as
 * Arm's web catalog says within `ms`; undefined when it did not answer in
 * time, the request failed, or the answer had another shape. A request
 * still open at `ms` is aborted.
 */
export async function webExampleOrigins(fetchFn: CatalogFetch, board: CatalogBoardId, ms: number,
    clock: Pick<Clock, 'startTimer'>): Promise<Map<string, string> | undefined> {
    const abort = new AbortController();
    try {
        const answer = await settleWithin(lookUp(fetchFn, board, abort.signal), ms, clock);
        if (answer === undefined) {
            abort.abort();
        }
        return answer?.value;
    } catch {
        abort.abort();
        return undefined;
    }
}
