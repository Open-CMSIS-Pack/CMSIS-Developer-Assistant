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
 * `cmsis_query`: what the CMSIS Solution extension answers, as data. This
 * is the first slice of #41's tool: the catalog of boards, devices and the
 * examples and templates of a board or device, read through the extension's
 * API version 2 (`solutionApi.ts`). #41's `what: 'context'` and
 * `'toolchain'` join `QUERY_KINDS` later, with their own runner.
 *
 * The filters are case-insensitive regular expressions applied here, not by
 * the API, whose name filter is case-sensitive and whose vendor filter wants
 * the exact spelling. A name filter is tried against the entry's name and
 * its id, and also as text without separators (`matcherOf`): `micro:bit`,
 * the user's spelling, finds the board `microbit-v2`. Every answer is a
 * compact text and the same content as
 * `data` (`structuredContent`): the entries, how many matched, how many the
 * cap of `limit` left out, the source of each draft (web or installed pack),
 * and what is known about the web catalog: unreachable, or nothing said.
 * The pack, the devices and the cores of an entry can cost the web catalog a
 * request each; they are read for the listed entries only, in parallel, and
 * left out when they do not arrive in time. Web examples of a board that
 * share their name (one per pack release that ships the example) are told
 * apart by the pack each comes from, which only Arm's web catalog knows
 * (`WebOrigins`, `webCatalog.ts`). CMSIS Solution lists a pack's own
 * examples only once the pack is installed, so the examples of a board whose
 * pack is not installed say so (`PackInstalled`), with the call that
 * installs it.
 *
 * The first list request of a window fills the extension's catalog from
 * Arm's web service, which can outlast the call. That is not a failure: the
 * answer is a `running` reply that says to repeat the same call, and the
 * extension goes on loading (its API object is kept, `acquireSolutionApi`),
 * so the repeat finds the catalog, or waits for less of it.
 *
 * Pure: no `vscode`; the API and the clock come from the caller.
 */

import {
    ApiBoard,
    ApiDevice,
    ApiDeviceId,
    ApiDraft,
    ApiPackId,
    CatalogErrors,
    catalogErrorsOf,
    Clock,
    findBoard,
    findDevice,
    keyOf,
    matcherOf,
    packText,
    settleWithin,
    SolutionApiV2,
    textField,
} from './solutionApi';
import { clipValue } from './textBudget';
import { JsonObject, ToolError, ToolReply } from './toolResult';
import type { CatalogBoardId } from './webCatalog';
import { secondsText } from './windowHealth';

/** What `cmsis_query` answers today; #41 adds `context` and `toolchain`. */
export const QUERY_KINDS = ['boards', 'devices', 'examples'] as const;
export type QueryKind = typeof QUERY_KINDS[number];

/** The arguments of `cmsis_query`. */
export interface CatalogQuery {
    what: QueryKind;
    /** boards, devices: a pattern for the vendor. */
    vendor?: string;
    /** boards, devices, examples: a pattern for the name. */
    name?: string;
    /** boards: a second pattern for the board's name; examples: the id of the board. */
    board?: string;
    /** boards: a pattern for a device the board carries; devices: a second pattern for the name; examples: the id of the device. */
    device?: string;
    /** Entries listed at most; default 20, at most 100. */
    limit?: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/** How long the pack, the devices and the cores of the listed entries may take, together. */
export const DETAIL_MS = 10_000;
/** How much of a draft's description the text shows; `data` carries up to `DESCRIPTION_DATA_CHARS`. */
const DESCRIPTION_TEXT_CHARS = 80;
const DESCRIPTION_DATA_CHARS = 400;
/** Devices of a board that `data` names at most. */
const BOARD_DEVICES_LISTED = 8;
/** How long Arm's web catalog may take to say which pack each of two web examples alike comes from. */
export const WEB_ORIGINS_MS = 5_000;
/**
 * Arm's web catalog asked for the pack each web example of a board comes
 * from, by the example's id (`webExampleOrigins` with a fetch function);
 * undefined when it did not answer within `ms`.
 */
export type WebOrigins = (board: CatalogBoardId, ms: number) => Promise<ReadonlyMap<string, string> | undefined>;
/** What a call answers while the extension's first list request still loads the catalog. */
export const CATALOG_LOADING = 'the CMSIS Solution catalog is still loading (first request fetches Arm\'s web catalog); repeat the same cmsis_query call.';

/** A list request still open at the call's deadline: the catalog is loading. `queryCatalog` answers it as `running`. */
class CatalogLoading extends Error {
    constructor(label: string) {
        super(`the ${label} did not arrive in time`);
    }
}

/** The `running` reply for a catalog that is still loading; `what` is the query's kind. */
function catalogLoadingReply(what: string): ToolReply {
    return { text: `cmsis_query {what:'${what}'}: ${CATALOG_LOADING}`, status: 'running', data: { what, loading: true } };
}

/** One listed entry: its line in the text and its object in `data`. */
interface Entry {
    line: string;
    data: JsonObject;
}

/** Entries matched, the listed ones, the notes under them. */
interface Listing {
    header: string;
    total: number;
    entries: Entry[];
    notes: string[];
    next: string;
    data: JsonObject;
}

/** The time left until `deadline`, never negative. */
function left(clock: Clock, deadline: number): number {
    return Math.max(0, deadline - clock.now());
}

/** The cap of a query: `limit` within 1 … 100, else 20. */
export function limitOf(limit: number | undefined): number {
    return typeof limit === 'number' && Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), MAX_LIMIT) : DEFAULT_LIMIT;
}

/**
 * One list request of the API within the call's deadline: the entries, an
 * empty list for a non-array, `CatalogLoading` when it does not answer in
 * time (the catalog is still being filled), `TASK_FAILED` when it rejects.
 */
async function listed<T>(request: () => PromiseLike<T[]>, label: string, clock: Clock, deadline: number): Promise<T[]> {
    let answer: { value: T[] } | undefined;
    try {
        answer = await settleWithin(request(), left(clock, deadline), clock);
    } catch (caught) {
        throw new ToolError('TASK_FAILED', `cmsis_query: CMSIS Solution could not list the ${label}: ${caught instanceof Error ? caught.message : String(caught)}`,
            'get_recent_problems and the CMSIS Solution output channel show more.');
    }
    if (answer === undefined) {
        throw new CatalogLoading(label);
    }
    return Array.isArray(answer.value) ? answer.value : [];
}

/** A promise of another extension's data, read within `ms`; undefined when it rejects or is late. */
async function detail<T>(pending: PromiseLike<T> | undefined, ms: number, clock: Clock): Promise<{ value: T } | undefined> {
    if (pending === undefined || pending === null || typeof (pending as { then?: unknown }).then !== 'function') {
        return undefined;
    }
    try {
        return await settleWithin(pending, ms, clock);
    } catch {
        return undefined;
    }
}

/** `vendor 'st', name 'h735'`: the filters a query gave, for the header. */
function filterText(parts: ReadonlyArray<readonly [string, string | undefined]>): string {
    const given = parts.filter((part): part is readonly [string, string] => typeof part[1] === 'string' && part[1].trim().length > 0);
    return given.length > 0 ? ` matching ${given.map(([label, value]) => `${label} '${value.trim()}'`).join(', ')}` : '';
}

/**
 * Whether an entry's name or id matches a pattern; no pattern matches all.
 * `board` for boards and `device` for devices are such a pattern as well:
 * an agent that names the board or device it means is not answered with
 * the whole catalog.
 */
function nameMatches(pattern: ((value: string | undefined) => boolean) | undefined, entry: { name?: unknown; id?: { key?: unknown } }): boolean {
    return !pattern || pattern(textField(entry?.name)) || pattern(keyOf(entry));
}

/** Compare by id, ignoring case, for a stable listing. */
function byKey(a: { id?: { key?: unknown } }, b: { id?: { key?: unknown } }): number {
    return keyOf(a).toLowerCase().localeCompare(keyOf(b).toLowerCase());
}

/** The device keys of a board's device list, as far as they are strings. */
function deviceKeys(devices: readonly ApiDeviceId[] | undefined): string[] {
    return Array.isArray(devices) ? devices.map((device) => textField(device?.key)).filter((key): key is string => key !== undefined) : [];
}

/** The note for entries whose details did not arrive within `waitedMs`; nothing when all did. */
function lateNote(late: number, what: string, waitedMs: number): string[] {
    if (late === 0) {
        return [];
    }
    return [`The ${what} of ${late} ${late === 1 ? 'entry' : 'entries'} did not arrive within ${secondsText(waitedMs)} `
        + `and ${late === 1 ? 'is' : 'are'} left out.`];
}

/** `boards`: filter, sort, cap, then the mounted device and pack of each listed board. */
async function listBoards(api: SolutionApiV2, query: CatalogQuery, clock: Clock, deadline: number): Promise<Listing> {
    const vendor = matcherOf(query.vendor);
    const name = matcherOf(query.name);
    const boardName = matcherOf(query.board);
    const device = matcherOf(query.device);
    // A mountedDevice filter makes the API fetch the boards with their devices; the empty one keeps
    // every board that has a device, and the case-insensitive match is made here.
    const boards = await listed(() => api.getBoards(device ? { mountedDevice: {} } : undefined), 'boards', clock, deadline);
    const named = boards.filter((board) => (!vendor || vendor(textField(board?.vendor))) && nameMatches(name, board) && nameMatches(boardName, board));
    let matching = named;
    if (device) {
        // The API's own filter has read every board's devices already; one wait covers them all.
        const all = Promise.all(named.map((board) => Promise.resolve(board.devices).then((ids) => ids, () => [] as ApiDeviceId[])));
        const devicesOf = await settleWithin(all, left(clock, deadline), clock);
        if (devicesOf === undefined) {
            throw new ToolError('TIMEOUT', 'cmsis_query: CMSIS Solution did not give the devices of the boards in time.',
                'Repeat the call in a minute, or leave out device and filter by name.');
        }
        // The id and the name alone, so that `^STM32H7` matches as well as `STMicroelectronics::STM32H7`.
        const onBoard = (key: string): boolean => device(key) || device(key.includes('::') ? key.slice(key.indexOf('::') + 2) : key);
        matching = named.filter((_, index) => deviceKeys(devicesOf.value[index]).some(onBoard));
    }
    matching.sort(byKey);
    const shown = matching.slice(0, limitOf(query.limit));
    const detailMs = Math.min(DETAIL_MS, left(clock, deadline));
    let late = 0;
    const entries = await Promise.all(shown.map(async (board): Promise<Entry> => {
        const [devices, pack] = await Promise.all([detail(board.devices, detailMs, clock), detail(board.pack, detailMs, clock)]);
        if (devices === undefined || pack === undefined) {
            late++;
        }
        const keys = deviceKeys(devices?.value);
        const bsp = packText(pack?.value);
        const parts: string[] = [];
        if (keys.length > 0) {
            parts.push(`device ${keys[0]}${keys.length > 1 ? ` (+${keys.length - 1} more)` : ''}`);
        }
        if (bsp !== undefined) {
            parts.push(`pack ${bsp}`);
        }
        const data: JsonObject = { id: keyOf(board), vendor: textField(board.vendor) ?? '', name: textField(board.name) ?? '' };
        const revision = textField(board.revision);
        if (revision !== undefined) {
            data.revision = revision;
        }
        if (keys.length > 0) {
            data.devices = keys.slice(0, BOARD_DEVICES_LISTED);
        }
        if (bsp !== undefined) {
            data.pack = bsp;
        }
        return { line: `- ${keyOf(board)}${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}`, data };
    }));
    return {
        header: `Boards${filterText([['vendor', query.vendor], ['name', query.name], ['board', query.board], ['device', query.device]])}`,
        total: matching.length,
        entries,
        notes: lateNote(late, 'device or pack', detailMs),
        next: 'Next: cmsis_query {what:\'examples\', board:\'<id>\'} lists the examples and templates of a board.',
        data: {},
    };
}

/** `Cortex-M7`, or `Cortex-M33 (cm33_core0), Cortex-M33 (cm33_core1)` when there are several. */
function coreText(processors: readonly { name?: unknown; core?: unknown }[]): string | undefined {
    const cores = processors.map((processor) => ({ core: textField(processor?.core), name: textField(processor?.name) }))
        .filter((processor): processor is { core: string; name: string | undefined } => processor.core !== undefined);
    if (cores.length === 0) {
        return undefined;
    }
    if (cores.length === 1) {
        return cores[0].core;
    }
    return cores.map((processor) => (processor.name ? `${processor.core} (${processor.name})` : processor.core)).join(', ');
}

/** `devices`: filter, sort, cap, then the pack and cores of each listed device. */
async function listDevices(api: SolutionApiV2, query: CatalogQuery, clock: Clock, deadline: number): Promise<Listing> {
    const vendor = matcherOf(query.vendor);
    const name = matcherOf(query.name);
    const deviceName = matcherOf(query.device);
    const devices = await listed(() => api.getDevices(), 'devices', clock, deadline);
    const matching = devices.filter((device) => (!vendor || vendor(textField(device?.vendor))) && nameMatches(name, device) && nameMatches(deviceName, device));
    matching.sort(byKey);
    const shown = matching.slice(0, limitOf(query.limit));
    const detailMs = Math.min(DETAIL_MS, left(clock, deadline));
    let late = 0;
    const entries = await Promise.all(shown.map(async (device): Promise<Entry> => {
        const [pack, processors] = await Promise.all([detail(device.pack, detailMs, clock), detail(device.processors, detailMs, clock)]);
        if (pack === undefined || processors === undefined) {
            late++;
        }
        const dfp = packText(pack?.value);
        const cores = Array.isArray(processors?.value) ? coreText(processors.value) : undefined;
        const family = [textField(device.family), textField(device.subfamily)].filter((part) => part !== undefined).join(' / ');
        const parts = [family ? `family ${family}` : undefined, cores, dfp ? `pack ${dfp}` : undefined].filter((part) => part !== undefined);
        const data: JsonObject = { id: keyOf(device), vendor: textField(device.vendor) ?? '', name: textField(device.name) ?? '' };
        if (family) {
            data.family = family;
        }
        if (cores !== undefined) {
            data.cores = cores;
        }
        if (dfp !== undefined) {
            data.pack = dfp;
        }
        return { line: `- ${keyOf(device)}${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}`, data };
    }));
    return {
        header: `Devices${filterText([['vendor', query.vendor], ['name', query.name], ['device', query.device]])}`,
        total: matching.length,
        entries,
        notes: lateNote(late, 'pack or cores', detailMs),
        next: 'Next: cmsis_query {what:\'boards\', device:\'<name>\'} finds the boards that carry a device; '
            + '{what:\'examples\', device:\'<id>\'} lists the templates of its installed packs.',
        data: {},
    };
}

/** `web`, `installed`, or nothing for a source the API does not name. */
function sourceOf(draft: ApiDraft): string | undefined {
    switch (textField(draft.draftSource)) {
        case 'Web': return 'web';
        case 'Local': return 'installed';
        default: return undefined;
    }
}

/** What the text says about a draft that is not a csolution project. */
function formatNote(format: string | undefined): string | undefined {
    switch (format) {
        case undefined:
        case 'Csolution': return undefined;
        case 'uVision': return 'µVision project, converted on creation';
        default: return `format ${format}, which CMSIS Solution cannot create from`;
    }
}

/**
 * The note on the web catalog for examples: what CMSIS Solution reported,
 * or, when nothing can be read, that no draft came from the web.
 */
function examplesWebNote(errors: CatalogErrors | undefined, fromWeb: number, board: boolean): string[] {
    if (!board) {
        return ['Without a board only the installed packs answer: Arm\'s web catalog lists examples per board.'];
    }
    if (fromWeb > 0 || errors?.webUnreachable === true) {
        return [];
    }
    return errors === undefined
        ? ['None came from Arm\'s web catalog: the board has no examples there, the catalog is switched off (setting cmsis-csolution.useWebServices), '
            + 'or it could not be reached; CMSIS Solution does not say which.']
        : ['None came from Arm\'s web catalog: the board has no examples there, or the catalog is switched off (setting cmsis-csolution.useWebServices).'];
}

/**
 * The web examples among `drafts` that share their name with another listed
 * one, by id: Arm's web catalog keeps one example per pack release that
 * ships it, and CMSIS Solution passes on nothing that tells them apart.
 */
function webTwins(drafts: readonly ApiDraft[]): ApiDraft[] {
    const web = drafts.filter((draft) => sourceOf(draft) === 'web');
    const named = (draft: ApiDraft): string => (textField(draft.name) ?? '').toLowerCase();
    return web.filter((draft) => web.some((other) => other !== draft && named(other) === named(draft)));
}

/**
 * For listed web examples alike: the pack each comes from, from Arm's web
 * catalog (`web`), and the note when it could not tell. Nothing to ask
 * without twins, without a board, or without `web`.
 */
async function twinOrigins(twins: readonly ApiDraft[], board: ApiBoard | undefined, web: WebOrigins | undefined,
    clock: Clock, deadline: number): Promise<{ origins: ReadonlyMap<string, string>; notes: string[] }> {
    if (twins.length === 0 || board === undefined || web === undefined) {
        return { origins: new Map(), notes: [] };
    }
    const ms = Math.min(WEB_ORIGINS_MS, left(clock, deadline));
    const id = board.id;
    const answer = await web({ vendor: textField(id?.vendor) ?? textField(board.vendor) ?? '', name: textField(id?.name) ?? textField(board.name) ?? '',
        revision: textField(id?.revision) ?? textField(board.revision) }, ms);
    const origins = new Map<string, string>();
    for (const draft of twins) {
        const pack = answer?.get(keyOf(draft)) ?? answer?.get(keyOf(draft).toLowerCase());
        if (pack !== undefined) {
            origins.set(keyOf(draft), pack);
        }
    }
    if (twins.every((draft) => origins.has(keyOf(draft)))) {
        return { origins, notes: [] };
    }
    const names = [...new Set(twins.filter((draft) => !origins.has(keyOf(draft))).map((draft) => textField(draft.name) ?? keyOf(draft)))];
    return {
        origins,
        notes: [`${names.join(', ')}: listed more than once by Arm's web catalog, one per pack release that ships the example; CMSIS Solution does not `
            + `say which is which, and the web catalog did not tell ${answer === undefined ? `within ${secondsText(ms)}` : 'for these'}.`],
    };
}

/**
 * Whether any version of a pack is installed: true, false, or undefined
 * when that cannot be told. The caller reads the pack root; this module
 * touches no file.
 */
export type PackInstalled = (pack: ApiPackId) => PromiseLike<boolean | undefined> | boolean | undefined;

/** The same pack, any version: vendor and name compared without regard to case. */
function samePack(a: ApiPackId | undefined, b: ApiPackId): boolean {
    const lower = (value: unknown): string | undefined => textField(value)?.toLowerCase();
    return a !== undefined && a !== null && lower(a.vendor) === lower(b.vendor) && lower(a.name) === lower(b.name);
}

/**
 * The board's own pack as `Vendor::Name@version` when it is not installed
 * and no example comes from an installed copy of it; undefined otherwise,
 * and whenever the pack or the answer does not arrive in time.
 */
async function boardPackMissing(board: ApiBoard, drafts: readonly ApiDraft[], installed: PackInstalled, clock: Clock, deadline: number): Promise<string | undefined> {
    const pack = (await detail(board.pack, Math.min(DETAIL_MS, left(clock, deadline)), clock))?.value;
    const id = packText(pack);
    if (pack === undefined || pack === null || id === undefined || drafts.some((draft) => sourceOf(draft) === 'installed' && samePack(draft.pack, pack))) {
        return undefined;
    }
    let answer: { value: boolean | undefined } | undefined;
    try {
        answer = await settleWithin(Promise.resolve(installed(pack)), left(clock, deadline), clock);
    } catch {
        return undefined;
    }
    return answer?.value === false ? id : undefined;
}

/** `examples`: the board and device by id, then their drafts, filtered by name, in the API's order. */
async function listExamples(api: SolutionApiV2, query: CatalogQuery, clock: Clock, deadline: number, web?: WebOrigins,
    installed?: PackInstalled): Promise<Listing> {
    const what = 'cmsis_query {what:\'examples\'}';
    const boardWanted = textField(query.board);
    const deviceWanted = textField(query.device);
    if (boardWanted === undefined && deviceWanted === undefined) {
        throw new ToolError('INVALID_ARGUMENT', `${what} not attempted: pass board or device, the id of the target the examples are for.`,
            'cmsis_query {what:\'boards\', name} lists boards with their ids.');
    }
    const board: ApiBoard | undefined = boardWanted === undefined ? undefined
        : findBoard(await listed(() => api.getBoards(), 'boards', clock, deadline), boardWanted, what);
    const device: ApiDevice | undefined = deviceWanted === undefined ? undefined
        : findDevice(await listed(() => api.getDevices(), 'devices', clock, deadline), deviceWanted, what);
    const drafts = await listed(() => api.getDraftProjects(board?.id, device?.id), 'examples and templates', clock, deadline);
    const errors = catalogErrorsOf(api);
    const name = matcherOf(query.name);
    const matching = drafts.filter((draft) => nameMatches(name, draft));
    const shown = matching.slice(0, limitOf(query.limit));
    const twins = await twinOrigins(webTwins(shown), board, web, clock, deadline);
    const entries = shown.map((draft): Entry => {
        const source = sourceOf(draft);
        const pack = packText(draft.pack) ?? twins.origins.get(keyOf(draft));
        const type = textField(draft.draftType);
        const format = textField(draft.format);
        const description = textField(draft.description);
        const origin = source === 'installed' && pack ? `installed ${pack}` : source === 'web' && pack ? `web from ${pack}` : source;
        const parts = [textField(draft.name), type, origin, formatNote(format)].filter((part) => part !== undefined);
        const data: JsonObject = { id: keyOf(draft), name: textField(draft.name) ?? '' };
        if (type !== undefined) {
            data.type = type;
        }
        if (source !== undefined) {
            data.source = source;
        }
        if (format !== undefined) {
            data.format = format;
        }
        if (pack !== undefined) {
            data.pack = pack;
        }
        if (description !== undefined) {
            data.description = clipValue(description, DESCRIPTION_DATA_CHARS);
        }
        const said = description !== undefined ? `: ${clipValue(description.replace(/\s+/g, ' '), DESCRIPTION_TEXT_CHARS)}` : '';
        return { line: `- ${keyOf(draft)} — ${parts.join(', ')}${said}`, data };
    });
    const owner = [board ? `board '${keyOf(board)}'` : undefined, device ? `device '${keyOf(device)}'` : undefined].filter((part) => part !== undefined);
    const target = owner.join(' and ');
    const ownerArgs = [board ? `board:'${keyOf(board)}'` : undefined, device ? `device:'${keyOf(device)}'` : undefined]
        .filter((part) => part !== undefined).join(', ');
    const data: JsonObject = {};
    if (board) {
        data.board = keyOf(board);
    }
    if (device) {
        data.device = keyOf(device);
    }
    const missing = board && installed ? await boardPackMissing(board, drafts, installed, clock, deadline) : undefined;
    const packNote: string[] = [];
    if (missing !== undefined) {
        data.boardPackNotInstalled = missing;
        packNote.push(`The board's pack ${missing} is not installed; its own examples appear after cmsis_action {action:'install_pack', pack:'${missing}'}.`);
    }
    return {
        header: `Examples and templates for ${target}${filterText([['name', query.name]])}`,
        total: matching.length,
        entries,
        notes: [...twins.notes, ...examplesWebNote(errors, drafts.filter((draft) => sourceOf(draft) === 'web').length, board !== undefined), ...packNote],
        next: `Create a project from one: cmsis_action {action:'create_solution', ${ownerArgs}, draft:'<id>', path:'<new project folder>'}.`,
        data,
    };
}

/** The notes on what CMSIS Solution reported for the request: the web catalog unreachable, and every other failure. */
function errorNotes(errors: CatalogErrors | undefined): string[] {
    if (errors === undefined) {
        return [];
    }
    const notes: string[] = [];
    if (errors.webUnreachable) {
        notes.push('Arm\'s web catalog could not be reached ("Web service could not be reached"): only the installed packs answered.');
    }
    const others = errors.messages.filter((message) => !/web service could not be reached/i.test(message));
    if (others.length > 0) {
        notes.push(`CMSIS Solution also reported: ${others.map((message) => clipValue(message, 200)).join('; ')}`);
    }
    return notes;
}

/**
 * Answer `cmsis_query` for the catalog kinds from CMSIS Solution's API.
 * `deadline` is on `clock`; a list request still open then is answered as
 * `running`: the catalog is loading, the same call again finds it.
 * `installed` tells whether a board's pack is installed, for the examples.
 */
export async function queryCatalog(api: SolutionApiV2, query: CatalogQuery, clock: Clock, deadline: number, web?: WebOrigins,
    installed?: PackInstalled): Promise<ToolReply> {
    let listing: Listing;
    try {
        switch (query.what) {
            case 'boards':
                listing = await listBoards(api, query, clock, deadline);
                break;
            case 'devices':
                listing = await listDevices(api, query, clock, deadline);
                break;
            case 'examples':
                listing = await listExamples(api, query, clock, deadline, web, installed);
                break;
            default:
                throw new ToolError('INVALID_ARGUMENT', `cmsis_query not attempted: what must be one of ${QUERY_KINDS.join(', ')}.`);
        }
    } catch (caught) {
        if (caught instanceof CatalogLoading) {
            return catalogLoadingReply(query.what);
        }
        throw caught;
    }
    const errors = catalogErrorsOf(api);
    const listedCount = listing.entries.length;
    const omitted = listing.total - listedCount;
    const count = listing.total === 0 ? 'none'
        : listedCount < listing.total ? `${listing.total}, the first ${listedCount} listed` : String(listing.total);
    const lines = [`${listing.header}: ${count}.`, ...listing.entries.map((entry) => entry.line)];
    if (omitted > 0) {
        lines.push(`${omitted} more not listed: narrow the filters, or raise limit (at most ${MAX_LIMIT}).`);
    }
    lines.push(...errorNotes(errors), ...listing.notes);
    if (listedCount > 0) {
        lines.push(listing.next);
    }
    const data: JsonObject = {
        what: query.what,
        ...listing.data,
        total: listing.total,
        listed: listedCount,
        omitted,
        entries: listing.entries.map((entry) => entry.data),
    };
    if (errors?.webUnreachable === true) {
        data.webUnreachable = true;
    }
    if (errors !== undefined && errors.messages.length > 0) {
        data.errors = errors.messages.map((message) => clipValue(message, 200));
    }
    return { text: lines.join('\n'), status: 'ok', data };
}
