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
 * `cmsis_action create_solution`: a new CMSIS solution from an example,
 * reference application or template of CMSIS Solution's catalog, created by
 * that extension's API version 2 (`createNewSolution`). The board, the
 * device and the draft are looked up by the ids `cmsis_query` lists; the
 * minimal project without a draft stays the work of the project skill.
 *
 * What CMSIS Solution 1.72.0 does, read from its bundle: it copies the draft
 * into the folder (a web example is downloaded first), and for a template
 * or reference application it sets the board and device in the csolution's
 * target type and adds their packs. `createNewSolution` resolves then. After
 * that, without waiting and without asking, it runs `git init` when asked,
 * adds a `vcpkg-configuration.json` through the Arm Tools Environment
 * Manager when the draft brings none, writes `.vscode/cmsis.json`, and opens
 * the folder in the window that created it (`vscode.openFolder`, same
 * window). A window that has exactly that folder open stays; any other
 * window is reloaded into it.
 *
 * So the call runs only where that is harmless: in the window that has the
 * folder open, which the router prefers, or in a window without any folder
 * for a client that survives a reload (`clientHosting.ts`). A window with
 * another folder would lose it, and a chat inside the window would end; both
 * are refused, with the way to open the folder first.
 *
 * In the window that stays, CMSIS Solution does not make the new csolution
 * its active solution. The call does that itself, with the activation of
 * `cmsis_action open_solution` (`activateHere` in `cmsisAction.ts`, handed
 * in as the `SolutionActivator`), within the time the call has left, and
 * reports the solution as active, or why it is not; the folder stays a
 * success either way.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSolutionFile, liesInside, samePath } from '../core/bootstrapState';
import { survivesWindowReload } from '../core/clientHosting';
import {
    acquireSolutionApi,
    ApiBoard,
    ApiDevice,
    ApiDraft,
    findBoard,
    findDevice,
    findDraft,
    keyOf,
    packText,
    settleWithin,
    SolutionApiV2,
    textField,
} from '../core/solutionApi';
import { isToolReply, JsonObject, ToolError, ToolText } from '../core/toolResult';
import { findSolutionFiles } from '../utils/solutionFiles';
import type { HandlerHost } from './host';

/** The arguments of `cmsis_action` that `create_solution` reads. */
export interface CreateRequest {
    /** The folder of the new project, absolute. */
    path?: string;
    /** The board id, as `cmsis_query` lists it. */
    board?: string;
    /** The device id; the board's own device when omitted. */
    device?: string;
    /** The id of the example, reference application or template. */
    draft?: string;
    /** `git init` in the new folder; off by default. */
    git?: boolean;
    /** The MCP client's `initialize` name. */
    client?: string;
}

/**
 * `open_solution`'s activation of a csolution in the window that has its
 * folder open: `ok` with `data.solution` as the extension reports the path,
 * `running` while the extension has not reported it yet, a `ToolError` when
 * it refused or failed. `deadline` is on the host's clock.
 */
export type SolutionActivator = (solutionFile: string, deadline: number) => Promise<ToolText>;

/** How the new solution stands after the call: what `afterwards()` says and `data.activation` holds. */
interface Activation {
    state: 'active' | 'pending' | 'failed' | 'skipped';
    /** `active`: the csolution as the extension reports it. */
    solution?: string;
    /** `failed`: the failure's text and hint; `skipped`: why. */
    detail?: string;
}

const WHAT = 'CMSIS \'create_solution\'';
/** The least time an activation is started with; below it the call answers and names open_solution. */
const ACTIVATION_MIN_MS = 3_000;
const USAGE = 'Pass path (the absolute path of the new project\'s folder), board or device, and draft: '
    + 'the ids cmsis_query {what:\'examples\', board} lists.';
/** How the agent opens the folder in a window of its own before it creates the project there. */
const OPEN_FIRST = 'create the folder, open it with cmsis_action {action:\'open_solution\', path:\'<folder>\'} '
    + '(a new window, which this session follows), then repeat this call: it runs in that window.';

/** A caught value's message. */
function messageOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/** The folder of the new project, checked: absolute, not a file, without a csolution of its own. */
function folderOf(given: string | undefined): string {
    const wanted = typeof given === 'string' ? given.trim() : '';
    if (wanted.length === 0) {
        throw new ToolError('INVALID_ARGUMENT', `${WHAT} not attempted: no path given.`, USAGE);
    }
    if (!path.isAbsolute(wanted)) {
        throw new ToolError('INVALID_ARGUMENT', `${WHAT} not attempted: '${wanted}' is not an absolute path.`, USAGE);
    }
    let entries: string[] | undefined;
    try {
        const stats = fs.statSync(wanted);
        if (!stats.isDirectory()) {
            throw new ToolError('INVALID_ARGUMENT', `${WHAT} not attempted: ${wanted} is a file, not a folder.`, USAGE);
        }
        entries = fs.readdirSync(wanted);
    } catch (caught) {
        if (caught instanceof ToolError) {
            throw caught;
        }
        // A folder that does not exist yet is created by CMSIS Solution.
    }
    const existing = (entries ?? []).filter((entry) => isSolutionFile(entry)).sort();
    if (existing.length > 0) {
        const file = path.join(wanted, existing[0]);
        throw new ToolError('INVALID_ARGUMENT', `${WHAT} not attempted: ${wanted} already holds ${existing.join(', ')}.`,
            `Open it instead: cmsis_action {action:'open_solution', path:'${file}'}; or pass an empty or new folder.`);
    }
    return wanted;
}

/**
 * Refuse a window that CMSIS Solution's opening of the folder would harm:
 * one with another folder open (it would close), and one without a folder
 * when the client is a chat inside the window (the reload ends it). Answers
 * whether the window reloads.
 */
function checkWindow(folder: string, openFolders: readonly string[], client: string | undefined): { reloads: boolean } {
    if (openFolders.length === 1 && samePath(openFolders[0], folder)) {
        return { reloads: false };
    }
    if (openFolders.length > 0) {
        const named = openFolders.join(', ');
        const inside = openFolders.find((open) => liesInside(folder, open));
        const nested = inside !== undefined
            ? ` It lies inside ${inside}, so open_solution would use this window: ask the user to open ${folder} in a new VS Code window `
                + '(File → New Window, then Open Folder) and repeat this call.'
            : '';
        throw new ToolError('INVALID_ARGUMENT',
            `${WHAT} not attempted: CMSIS Solution opens the new project in the window that creates it, and this window has ${named} open, `
                + 'which it would close.',
            `Give the project a window of its own first: ${OPEN_FIRST.replace('<folder>', folder)}${nested}`);
    }
    if (!survivesWindowReload(client)) {
        throw new ToolError('NO_WORKSPACE',
            `${WHAT} not attempted: CMSIS Solution opens the new project in the window that creates it, and for this window, which has no folder, `
                + 'that is a reload, which ends a chat that runs inside it.',
            `Give the project a window of its own first: ${OPEN_FIRST.replace('<folder>', folder)}`);
    }
    return { reloads: true };
}

/** The time left until `deadline`, never negative. */
function left(host: HandlerHost, deadline: number): number {
    return Math.max(0, deadline - host.now());
}

/** One API request within the deadline: `TIMEOUT` when late, `TASK_FAILED` when it rejects. */
async function asked<T>(host: HandlerHost, deadline: number, label: string, request: () => PromiseLike<T>): Promise<T> {
    let answer: { value: T } | undefined;
    try {
        answer = await settleWithin(request(), left(host, deadline), host);
    } catch (caught) {
        throw new ToolError('TASK_FAILED', `${WHAT} failed: CMSIS Solution could not list the ${label}: ${messageOf(caught)}`,
            'get_recent_problems and the CMSIS Solution output channel show more.');
    }
    if (answer === undefined) {
        throw new ToolError('TIMEOUT', `${WHAT} not attempted: CMSIS Solution did not list the ${label} in time.`,
            'Its first request loads Arm\'s web catalog, which can take a while: repeat the call in a minute.');
    }
    return answer.value;
}

/** `the example 'Blinky' from the installed pack Keil::X@1.0.0`, or from Arm's web catalog. */
function draftPhrase(draft: ApiDraft): string {
    const type = (textField(draft.draftType) ?? 'draft').toLowerCase();
    const pack = packText(draft.pack);
    const source = textField(draft.draftSource) === 'Web' ? ' from Arm\'s web catalog' : pack ? ` from the installed pack ${pack}` : '';
    return `the ${type} '${textField(draft.name) ?? keyOf(draft)}'${source}`;
}

/** `cmsis_action {action:'open_solution', path:'…'}`. */
function openSolutionCall(target: string): string {
    return `cmsis_action {action:'open_solution', path:'${target}'}`;
}

/**
 * Make the new csolution the active solution, as `open_solution` does, within
 * the time left. Never throws: a refusal or failure is reported in the
 * reply, since the folder was created.
 */
async function activated(activate: SolutionActivator, file: string, host: HandlerHost, deadline: number): Promise<Activation> {
    if (left(host, deadline) < ACTIVATION_MIN_MS) {
        return { state: 'skipped', detail: 'the call has no time left to activate it' };
    }
    let answer: ToolText;
    try {
        answer = await activate(file, deadline);
    } catch (caught) {
        const hint = caught instanceof ToolError && caught.hint ? ` ${caught.hint}` : '';
        return { state: 'failed', detail: `${messageOf(caught)}${hint}` };
    }
    if (isToolReply(answer) && answer.status !== 'ok') {
        return { state: 'pending' };
    }
    const reported = isToolReply(answer) ? textField(answer.data?.solution) : undefined;
    return { state: 'active', solution: reported ?? file };
}

/** The line of `afterwards()` on the activation, with the agent's next step. */
function activationLine(file: string, activation: Activation): string {
    const build = 'cmsis_action build, which fetches the packs';
    switch (activation.state) {
        case 'active':
            return `Active solution: ${activation.solution}. Next: ${build}.`;
        case 'pending':
            return `CMSIS Solution was asked to activate ${file} but does not report it as active yet. `
                + `Next: get_session_status until it is active (if it stays inactive, ${openSolutionCall(file)} activates it), then ${build}.`;
        case 'failed':
            return `Activating ${file} failed: ${activation.detail} Next: once it is active, ${build}.`;
        case 'skipped':
            return `Not activated: ${activation.detail}. Next: ${openSolutionCall(file)} activates it, then ${build}.`;
    }
}

/**
 * What the reply says CMSIS Solution does after the files are there, and
 * what the agent does next. `activation` is the window's own activation of
 * the csolution `file`, when the window stays and a csolution was found.
 */
function afterwards(folder: string, draft: ApiDraft, git: boolean, reloads: boolean, file?: string, activation?: Activation): string[] {
    const type = textField(draft.draftType);
    const lines: string[] = [];
    if (type === 'Template' || type === 'Reference Application') {
        lines.push('CMSIS Solution set the board and device in the csolution\'s target type and added their packs.');
    }
    lines.push(`CMSIS Solution goes on by itself: it ${git ? 'runs git init, ' : ''}writes .vscode/cmsis.json and, when the project brings no `
        + 'vcpkg-configuration.json, adds one through the Arm Tools Environment Manager (CMSIS-Toolbox, CMake, Ninja, Arm Compiler 6).');
    if (reloads) {
        lines.push('Then it opens the folder in this window without asking: VS Code reloads the window, and the MCP server with it when it runs here. '
            + 'Wait about 10 s, then call get_session_status; connect again if the session is gone.');
        lines.push(`Next: when no window has the folder open by then, ${openSolutionCall(folder)} opens it; then cmsis_action build, which fetches the packs.`);
    } else if (file !== undefined && activation !== undefined) {
        lines.push('Then it opens the folder in this window, which has it open already, so the window stays.');
        lines.push(activationLine(file, activation));
    } else {
        lines.push('Then it opens the folder in this window, which has it open already, so the window stays.');
        lines.push(`Next: get_session_status until the solution is active (if it stays inactive, ${openSolutionCall(folder)} activates it), `
            + 'then cmsis_action build, which fetches the packs.');
    }
    return lines;
}

/** The hint for a `createNewSolution` that failed, by its message. */
function failureHint(message: string, owner: string): string {
    if (/draft project not found/i.test(message)) {
        return `The catalog changed since the lookup: cmsis_query {what:'examples', ${owner}} lists the ids there are now.`;
    }
    if (/already contains/i.test(message)) {
        return 'The folder holds a csolution now: open it with cmsis_action {action:\'open_solution\', path}.';
    }
    return 'get_recent_problems and the CMSIS Solution output channel show what it reported.';
}

/**
 * Create the solution. `deadline` is on the host's clock: a creation still
 * going then (a web download) is answered with status `running`. In a window
 * that stays, `activate` then makes the new csolution the active solution
 * within the time left (`data.activation`, `data.active`).
 */
export async function createSolution(host: HandlerHost, request: CreateRequest, deadline: number, activate: SolutionActivator): Promise<ToolText> {
    const folder = folderOf(request.path);
    const boardWanted = textField(request.board);
    const deviceWanted = textField(request.device);
    const draftWanted = textField(request.draft);
    if (draftWanted === undefined) {
        throw new ToolError('INVALID_ARGUMENT', `${WHAT} not attempted: no draft given, the example or template to start from.`, USAGE);
    }
    if (boardWanted === undefined && deviceWanted === undefined) {
        throw new ToolError('INVALID_ARGUMENT', `${WHAT} not attempted: no board or device given.`, USAGE);
    }
    const { reloads } = checkWindow(folder, host.workspaceFolders().map((open) => open.uri.fsPath), request.client);

    const api: SolutionApiV2 = await acquireSolutionApi(host.solutionExtension(), WHAT, host);
    const board: ApiBoard | undefined = boardWanted === undefined ? undefined
        : findBoard(await asked(host, deadline, 'boards', () => api.getBoards()), boardWanted, WHAT);
    const device: ApiDevice | undefined = deviceWanted === undefined ? undefined
        : findDevice(await asked(host, deadline, 'devices', () => api.getDevices()), deviceWanted, WHAT);
    const owner = [board ? `board:'${keyOf(board)}'` : undefined, device ? `device:'${keyOf(device)}'` : undefined]
        .filter((part) => part !== undefined).join(', ');
    const drafts = await asked(host, deadline, 'examples and templates', () => api.getDraftProjects(board?.id, device?.id));
    const draft = findDraft(Array.isArray(drafts) ? drafts : [], draftWanted, owner, WHAT);
    const format = textField(draft.format);
    if (format !== undefined && format !== 'Csolution' && format !== 'uVision') {
        throw new ToolError('INVALID_ARGUMENT', `${WHAT} not attempted: ${keyOf(draft)} is of format ${format}, which CMSIS Solution cannot create from.`,
            'Pick a csolution or µVision draft from cmsis_query {what:\'examples\'}.');
    }

    const git = request.git === true;
    const data: JsonObject = { created: folder, draft: keyOf(draft), reloads };
    if (board) {
        data.board = keyOf(board);
    }
    if (device) {
        data.device = keyOf(device);
    }
    const target = [board ? `board ${keyOf(board)}` : undefined, device ? `device ${keyOf(device)}` : undefined]
        .filter((part) => part !== undefined).join(', ');
    let done: { value: void } | undefined;
    try {
        done = await settleWithin(api.createNewSolution({ draft, board, device, folder, git }), left(host, deadline), host);
    } catch (caught) {
        const message = messageOf(caught);
        throw new ToolError('TASK_FAILED', `${WHAT} failed: CMSIS Solution did not create the solution in ${folder}: ${message}`,
            failureHint(message, owner));
    }
    if (done === undefined) {
        return {
            text: `CMSIS Solution is still creating the solution in ${folder} from ${draftPhrase(draft)} (a web example downloads first). `
                + `When it is done it opens the folder in this window${reloads ? ', which reloads it' : ''}. `
                + 'Call get_session_status in a minute; do not repeat create_solution for this folder.',
            status: 'running',
            data,
        };
    }
    const solutions = findSolutionFiles(folder);
    if (solutions.length > 0) {
        data.solution = solutions[0];
    }
    const solution = solutions.length > 0 ? ` Solution: ${path.relative(folder, solutions[0]) || path.basename(solutions[0])}.` : '';
    let activation: Activation | undefined;
    if (!reloads && solutions.length > 0) {
        activation = await activated(activate, solutions[0], host, deadline);
        data.activation = activation.state;
        if (activation.solution !== undefined) {
            data.active = activation.solution;
        }
    }
    return {
        text: [`Created a solution in ${folder} from ${draftPhrase(draft)} for ${target}.${solution}`,
            ...afterwards(folder, draft, git, reloads, solutions[0], activation)].join('\n'),
        status: 'ok',
        data,
    };
}
