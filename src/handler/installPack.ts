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
 * `cmsis_action install_pack`: install one pack at one version through the
 * CMSIS Solution extension, so that its knowledge can be read before the
 * project that needs it exists. Like `open_solution` it needs no active
 * solution.
 *
 * The command is `cmsis-csolution.installPack(vendor, name, version)`,
 * hidden from the palette: it runs `cpackget add -a` in the extension's tool
 * queue and answers the pack's folder, or nothing, with the reason only in
 * its output channel. So the call checks first what it can name: the pack
 * id, the extension, its command (after activating the extension, which a
 * window without a csolution has not done), and the licence. A pack whose
 * PDSC in the pack root's `.Web/` declares one is installed only after the
 * user chose Install in a modal; without a PDSC there the result says that
 * the licence was not checked. A pack whose folder is there already is not
 * installed again. After the command the folder is checked, and the result
 * names the knowledge units the pack ships.
 *
 * One install of a pack runs at a time in a window, question included: a
 * repeated call for the same pack waits for the one in flight instead of
 * asking or installing twice. The call answers by its deadline — `running`
 * while cpackget runs, a refusal while the question is unanswered — and the
 * flight goes on; a failure nobody waits for is still journaled.
 *
 * Everything that touches VS Code is behind `PackInstallHost`, which unit
 * tests replace.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { missingSolutionExtensionRefusal, SOLUTION_EXTENSION_ID } from '../core/bootstrapState';
import {
    checkLicence,
    formatPackRequest,
    INSTALL_PACK_COMMAND,
    INSTALL_PACK_SINCE,
    installFailure,
    knowledgeLine,
    LicenceCheck,
    licenceLine,
    licenceQuestion,
    missingFolderFailure,
    PackRequest,
    packFolder,
    parsePackRequest,
} from '../core/packInstall';
import { problemJournal, type ProblemInput } from '../core/problemJournal';
import { JsonObject, ToolError, ToolText } from '../core/toolResult';
import { logger } from '../utils/logger';
import { HardwareTimeoutError, withTimeout } from '../utils/timeout';
import { effectiveToolchainPackRoot } from '../utils/toolchainPackRoot';
import { failureText } from './fence';
import type { HandlerHost } from './host';
import { formatDuration } from './jobText';

/** What `install_pack` needs from VS Code and the CMSIS Solution extension. */
export interface PackInstallHost {
    /** Activate the CMSIS Solution extension unless it is active, then list VS Code's commands (`getCommands(true)`). */
    solutionCommands(): Promise<readonly string[]>;
    /** `cmsis-csolution.installPack(vendor, name, version)`: the pack's folder, or undefined. */
    installPack(vendor: string, name: string, version: string): Thenable<unknown>;
    /** The pack root: the CMSIS Solution extension's, else `$CMSIS_PACK_ROOT` or the platform default. */
    packRoot(): Promise<string>;
    /** The licence question as a modal with Install and Cancel; true for Install. */
    confirmLicence(message: string, detail: string): Thenable<boolean>;
    /** Append a problem to the window's journal. */
    report(problem: ProblemInput): void;
}

const INSTALL_BUTTON = 'Install';

/** The real thing: the CMSIS Solution extension, VS Code's modal, the window's journal. */
export const VSCODE_PACK_INSTALL_HOST: PackInstallHost = {
    solutionCommands: async () => {
        // A window without a csolution has not activated the extension, and its commands are registered only then.
        const extension = vscode.extensions.getExtension(SOLUTION_EXTENSION_ID);
        if (extension !== undefined && !extension.isActive) {
            await extension.activate();
        }
        return vscode.commands.getCommands(true);
    },
    installPack: (vendor, name, version) => vscode.commands.executeCommand<unknown>(INSTALL_PACK_COMMAND, vendor, name, version),
    packRoot: () => effectiveToolchainPackRoot(),
    confirmLicence: async (message, detail) =>
        (await vscode.window.showWarningMessage(message, { modal: true, detail }, INSTALL_BUTTON)) === INSTALL_BUTTON,
    report: (problem) => {
        problemJournal().append(problem);
    },
};

const WHAT = 'CMSIS \'install_pack\'';
/** Kept back from the call's deadline so its own answer beats the fence. */
const DEADLINE_MARGIN_MS = 1_500;
/** How long the CMSIS Solution extension may take to activate. */
const ACTIVATION_MS = 10_000;

/** One install of a pack in this window, from the licence question to the checked folder. */
interface Flight {
    readonly id: string;
    readonly folder: string;
    readonly startedAt: number;
    phase: 'asking' | 'installing';
    phaseSince: number;
    outcome: Promise<ToolText>;
}

/** The installs in flight, by pack id in lower case. */
const flights = new Map<string, Flight>();

/** The failure, journaled as the CMSIS Solution extension's, and logged. */
function reported(installer: PackInstallHost, failure: ToolError): ToolError {
    installer.report({ source: 'extension', origin: SOLUTION_EXTENSION_ID, severity: 'error', code: failure.code, message: failure.message,
        hint: failure.hint });
    logger.info(`install_pack: ${failure.message}`);
    return failure;
}

/** Whether `folder` is a directory with the pack's PDSC in it: the pack is installed there. */
function holdsPack(folder: string, pack: PackRequest): boolean {
    try {
        return fs.statSync(folder).isDirectory() && fs.existsSync(path.join(folder, `${pack.vendor}.${pack.name}.pdsc`));
    } catch {
        return false;
    }
}

function isDirectory(folder: string): boolean {
    try {
        return fs.statSync(folder).isDirectory();
    } catch {
        return false;
    }
}

/** The result of an installed pack: where, the licence, the knowledge. */
function installedResult(pack: PackRequest, folder: string, head: string, licence: LicenceCheck | undefined): ToolText {
    const knowledge = knowledgeLine(folder, pack);
    const licenceNote = licence === undefined ? undefined : licenceLine(licence);
    const lines = [head, ...(licenceNote ? [licenceNote] : []), ...(knowledge ? [knowledge.line] : [])];
    const data: JsonObject = { pack: formatPackRequest(pack), folder };
    if (licence !== undefined) {
        data.licence = licence.kind === 'declared' ? 'accepted' : licence.kind;
    }
    if (knowledge?.units !== undefined) {
        data.knowledgeUnits = knowledge.units;
    }
    return { text: lines.join('\n'), status: 'ok', data };
}

/** Run the command and check what it left; a failure is journaled. */
async function install(installer: PackInstallHost, pack: PackRequest, expected: string, licence: LicenceCheck): Promise<ToolText> {
    const id = formatPackRequest(pack);
    const leftover = (): string | undefined => (isDirectory(expected) ? expected : undefined);
    logger.info(`install_pack: ${INSTALL_PACK_COMMAND} ${id}`);
    let answer: unknown;
    try {
        answer = await installer.installPack(pack.vendor, pack.name, pack.version);
    } catch (caught) {
        throw reported(installer, installFailure(pack, `${INSTALL_PACK_COMMAND} failed: ${failureText(caught)}`, leftover()));
    }
    if (typeof answer !== 'string' || answer.trim().length === 0) {
        throw reported(installer, installFailure(pack, `${INSTALL_PACK_COMMAND} returned no folder`, leftover()));
    }
    const folder = answer.trim();
    if (!isDirectory(folder)) {
        throw reported(installer, missingFolderFailure(pack, folder));
    }
    return installedResult(pack, folder, `${id} installed in ${folder}.`, licence);
}

/** Start the install of `pack`: the licence question when the PDSC declares one, then the command. */
function startFlight(host: HandlerHost, installer: PackInstallHost, pack: PackRequest, folder: string, licence: LicenceCheck): Flight {
    const id = formatPackRequest(pack);
    const key = id.toLowerCase();
    const now = host.now();
    const flight: Flight = { id, folder, startedAt: now, phase: licence.kind === 'declared' ? 'asking' : 'installing', phaseSince: now,
        outcome: Promise.resolve('') };
    const run = async (): Promise<ToolText> => {
        if (licence.kind === 'declared') {
            const question = licenceQuestion(pack, licence.file, folder);
            let accepted: boolean;
            try {
                accepted = await installer.confirmLicence(question.message, question.detail);
            } catch (caught) {
                throw new ToolError('TASK_FAILED', `${WHAT} not attempted: the licence question for ${id} could not be shown (${failureText(caught)}).`,
                    'Ask the user to install the pack in the CMSIS Solution extension, or call install_pack again.');
            }
            if (!accepted) {
                logger.info(`install_pack: the user declined the licence of ${id}`);
                throw new ToolError('TASK_FAILED',
                    `${WHAT} not attempted: the user declined the licence of ${id} (${licence.file}) in the VS Code window.`,
                    'Do not install the pack another way. Ask the user whether to install it with that licence; if so, call install_pack again.');
            }
            flight.phase = 'installing';
            flight.phaseSince = host.now();
        }
        return install(installer, pack, folder, licence);
    };
    flight.outcome = run().finally(() => {
        if (flights.get(key) === flight) {
            flights.delete(key);
        }
    });
    // A call that ran out of time no longer waits; the flight's failure is journaled in it.
    flight.outcome.catch(() => undefined);
    flights.set(key, flight);
    return flight;
}

/** Wait for the flight until the call's deadline; what is still open then is answered by its phase. */
async function awaitFlight(host: HandlerHost, flight: Flight, deadline: number, preface: string): Promise<ToolText> {
    const waitMs = Math.max(0, deadline - DEADLINE_MARGIN_MS - host.now());
    let cancel: () => void = () => undefined;
    const late = new Promise<undefined>((settle) => {
        cancel = host.startTimer(waitMs, () => settle(undefined));
    });
    let outcome: ToolText | undefined;
    try {
        outcome = await Promise.race([flight.outcome, late]);
    } finally {
        cancel();
    }
    if (outcome !== undefined) {
        if (!preface) {
            return outcome;
        }
        return typeof outcome === 'string' ? `${preface}${outcome}` : { ...outcome, text: `${preface}${outcome.text}` };
    }
    const since = formatDuration(host.now() - flight.phaseSince);
    if (flight.phase === 'asking') {
        throw new ToolError('TASK_FAILED',
            `${WHAT} not attempted: nobody answered the licence question for ${flight.id} in the VS Code window (asked ${since} ago).`,
            'The dialog stays open. Ask the user to answer it, then call install_pack with the same pack again: it waits for that answer '
                + 'instead of asking twice, and timeoutMs (up to 600000) gives the user longer.');
    }
    return {
        text: `${preface}${flight.id} is still being installed by the CMSIS Solution extension (cpackget add, ${since} so far). `
            + 'Call install_pack with the same pack again to wait for it; it is not started twice.',
        status: 'running',
        data: { pack: flight.id, folder: flight.folder },
    };
}

/**
 * `install_pack` inside the handler's fence. `given` is the `pack`
 * argument, `deadline` when the call answers at the latest, on the host's
 * clock.
 */
export async function runInstallPack(host: HandlerHost, given: unknown, deadline: number): Promise<ToolText> {
    const pack = parsePackRequest(given);
    const id = formatPackRequest(pack);
    const attach = (flying: Flight): Promise<ToolText> => awaitFlight(host, flying, deadline,
        `Attached to the install of ${flying.id} started ${formatDuration(host.now() - flying.startedAt)} ago (not started again). `);
    const flying = flights.get(id.toLowerCase());
    if (flying !== undefined) {
        return attach(flying);
    }
    const extension = host.toolEnvironment().extension(SOLUTION_EXTENSION_ID);
    if (!extension) {
        throw missingSolutionExtensionRefusal(WHAT);
    }
    const installer = host.packInstall();
    const packRoot = await installer.packRoot();
    const folder = packFolder(packRoot, pack);
    if (holdsPack(folder, pack)) {
        return installedResult(pack, folder, `${id} is already installed in ${folder}; nothing was installed.`, undefined);
    }

    let commands: readonly string[];
    const budgetMs = Math.max(1, Math.min(ACTIVATION_MS, deadline - DEADLINE_MARGIN_MS - host.now()));
    try {
        commands = await withTimeout('CMSIS Solution activation', budgetMs, () => installer.solutionCommands());
    } catch (caught) {
        const why = caught instanceof HardwareTimeoutError ? `no answer within ${formatDuration(budgetMs)}` : failureText(caught);
        throw new ToolError('TASK_FAILED', `${WHAT} not attempted: the CMSIS Solution extension did not activate (${why}).`,
            'Ask the user to reload the VS Code window, then call install_pack again; get_recent_problems shows what the extension reported.');
    }
    if (!commands.includes(INSTALL_PACK_COMMAND)) {
        throw new ToolError('TOOL_DISABLED',
            `${WHAT} not attempted: the CMSIS Solution extension${extension.version ? ` ${extension.version}` : ''} has no command `
                + `${INSTALL_PACK_COMMAND}; CMSIS Solution ${INSTALL_PACK_SINCE} has it.`,
            `Ask the user to update the CMSIS Solution extension (${SOLUTION_EXTENSION_ID}) and to reload the window. Do not run cpackget yourself.`);
    }
    // Another call for the same pack may have started its flight while this one waited for the extension.
    const started = flights.get(id.toLowerCase());
    if (started !== undefined) {
        return attach(started);
    }
    return awaitFlight(host, startFlight(host, installer, pack, folder, checkLicence(packRoot, pack)), deadline, '');
}
