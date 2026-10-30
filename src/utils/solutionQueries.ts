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
 * Asking the CMSIS Solution extension what it knows about its active target
 * instead of guessing it: the `cbuild-run.yml` (`getCbuildRunFile`) and the
 * folders of the target's DFP and BSP (`getDfpPath`, `getBspPath`). These
 * commands are hidden from the palette and not part of the extension's
 * public API, so each one is feature-detected (`getCommands(true)`), and it
 * is asked only while the extension is active: running it would activate the
 * extension, which has no solution loaded then anyway. An inactive
 * extension, a missing command, a failed or slow answer (3 s) all come back
 * as no answer, and the callers keep their own lookup as the fallback.
 * The answers are interpreted by `src/core/solutionAnswers.ts`.
 */

import * as vscode from 'vscode';
import { SOLUTION_EXTENSION_ID } from '../core/bootstrapState';
import { ActivePackFolders, cbuildRunFileOf, packFolderOf } from '../core/solutionAnswers';
import { logger } from './logger';
import { withTimeout } from './timeout';

export const GET_CBUILD_RUN_FILE = 'cmsis-csolution.getCbuildRunFile';
export const GET_DFP_PATH = 'cmsis-csolution.getDfpPath';
export const GET_BSP_PATH = 'cmsis-csolution.getBspPath';

/** How long one question may take, the command lookup included. */
export const SOLUTION_QUERY_MS = 3_000;

/** What the questions need from VS Code; the tests hand in their own. */
export interface SolutionCommands {
    /** Whether the CMSIS Solution extension is installed and active. */
    extensionActive(): boolean;
    /** The registered commands, `vscode.commands.getCommands(true)`. */
    commands(): Thenable<readonly string[]>;
    /** `vscode.commands.executeCommand(command)`. */
    execute(command: string): Thenable<unknown>;
    /** The fence of one question; {@link SOLUTION_QUERY_MS} when absent. */
    timeoutMs?: number;
}

/** VS Code itself, looked up per call. */
export const VSCODE_SOLUTION_COMMANDS: SolutionCommands = {
    extensionActive: () => vscode.extensions.getExtension(SOLUTION_EXTENSION_ID)?.isActive === true,
    commands: () => vscode.commands.getCommands(true),
    execute: (command) => vscode.commands.executeCommand<unknown>(command),
};

/**
 * The answer of one getter, or undefined when the extension is not active,
 * does not have the command, fails or does not answer in time. Never throws.
 */
export async function askSolution(command: string, source: SolutionCommands = VSCODE_SOLUTION_COMMANDS): Promise<unknown> {
    try {
        if (!source.extensionActive()) {
            return undefined;
        }
        return await withTimeout(`cmsis ${command}`, source.timeoutMs ?? SOLUTION_QUERY_MS, async () => {
            if (!(await source.commands()).includes(command)) {
                logger.debug(`${command}: not offered by this CMSIS Solution version`);
                return undefined;
            }
            return source.execute(command);
        });
    } catch (caught) {
        logger.debug(`${command}: no answer (${caught instanceof Error ? caught.message : String(caught)})`);
        return undefined;
    }
}

/**
 * The `cbuild-run.yml` of the extension's active target as it answers;
 * whether it exists is the caller's check. The one lookup of it: `flash`,
 * `cmsis_action` and the documentation tools ask here, through their hosts.
 */
export async function activeCbuildRunFile(source: SolutionCommands = VSCODE_SOLUTION_COMMANDS): Promise<string | undefined> {
    return cbuildRunFileOf(await askSolution(GET_CBUILD_RUN_FILE, source));
}

/** The folders the extension names for the active target's DFP and BSP; empty when it names none. */
export async function activePackFolders(source: SolutionCommands = VSCODE_SOLUTION_COMMANDS): Promise<ActivePackFolders> {
    if (!safelyActive(source)) {
        return {};
    }
    const [dfp, bsp] = await Promise.all([askSolution(GET_DFP_PATH, source), askSolution(GET_BSP_PATH, source)]);
    const folders: ActivePackFolders = {};
    const dfpFolder = packFolderOf(dfp);
    const bspFolder = packFolderOf(bsp);
    if (dfpFolder) {
        folders.dfp = dfpFolder;
    }
    if (bspFolder) {
        folders.bsp = bspFolder;
    }
    return folders;
}

function safelyActive(source: SolutionCommands): boolean {
    try {
        return source.extensionActive();
    } catch {
        return false;
    }
}
