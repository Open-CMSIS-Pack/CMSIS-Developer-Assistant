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
 * What the hints after a failed CMSIS Load or Erase, or a failed debug
 * launch, know about the program that failed.
 *
 * `failedTaskProgram` names the kind of a failed task's program from its
 * command line, which the job tracker keeps, and for a J-Link task that
 * failed at once looks the program up on the PATH of the CMSIS tasks
 * (`src/core/programLookup.ts`): a J-Link that is not installed, or not on
 * that PATH, then reads as such instead of as a probe problem.
 * `gdbServerMissingHint` answers a launch whose GDB server the debug
 * adapter could not start (`GDB_SERVER_NOT_FOUND` in the call's records):
 * whether the server is on VS Code's own PATH, which the adapter uses, and
 * on the PATH of the CMSIS tasks — a folder added only to the terminal
 * setting fixes CMSIS Load but not the launch.
 *
 * It reads the solution's `.cmsis/tools-environment.yml`, and through the
 * host's `toolEnvironment()` the terminal setting, this process's
 * environment and the file tests. Nothing is written, nothing is run.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CmsisJobTracker } from '../cmsisJobTracker';
import { readToolsEnvironment } from '../core/buildFailure';
import { currentCallContext } from '../core/callContext';
import { JobExecution, runtimeOf } from '../core/cmsisTasks';
import {
    FAILED_AT_ONCE_MS,
    findProgram,
    installedIn,
    LookupFacts,
    placesOf,
    PROBE_SOFTWARE_STEPS,
    processPathFolders,
    ProgramFacts,
    RESTART_VS_CODE,
    taskPathFolders,
    taskProgram,
    VSCODE_PATH_PLACE,
} from '../core/programLookup';
import type { ProblemJournal } from '../core/problemJournal';
import type { HandlerHost } from './host';

/**
 * What the lookup reads, from the host's tool environment (`VSCODE_HOST`
 * has every member): PATH is its `pathEnv`; a member a test's host leaves
 * out finds nothing.
 */
function lookupFacts(host: HandlerHost): LookupFacts & { terminalEnv: Readonly<Record<string, unknown>> | undefined } {
    const environment = host.toolEnvironment();
    let terminalEnv: Readonly<Record<string, unknown>> | undefined;
    try {
        terminalEnv = environment.terminalEnv?.();
    } catch {
        // An unreadable setting adds nothing to the PATH.
    }
    return {
        platform: environment.platform,
        env: (name) => (name.toUpperCase() === 'PATH' ? environment.pathEnv : environment.env?.(name)),
        isFile: (file) => environment.isFile?.(file) ?? false,
        listDir: (folder) => environment.listDir?.(folder) ?? [],
        terminalEnv,
    };
}

/**
 * The directories `.cmsis/tools-environment.yml` puts in front of the PATH
 * of the CMSIS tasks: the file next to the solution, else in the first
 * workspace folder; undefined when there is none or it cannot be read.
 */
function toolsEnvironmentPath(host: HandlerHost, solutionPath: string | undefined): string[] | undefined {
    const places = [solutionPath ? path.dirname(solutionPath) : undefined, host.workspaceFolders()[0]?.uri.fsPath]
        .filter((place): place is string => place !== undefined);
    for (const place of places) {
        let text: string;
        try {
            text = fs.readFileSync(path.join(place, '.cmsis', 'tools-environment.yml'), 'utf8');
        } catch {
            continue;
        }
        try {
            return readToolsEnvironment(text).path;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * What the hint after a failed Load or Erase knows about the task's
 * program, for `ResultContext.program`: its kind from the command line the
 * tracker kept, and for a J-Link task that exited non-zero within
 * `FAILED_AT_ONCE_MS` whether the PATH of the CMSIS tasks has the program,
 * where it was searched, and the SEGGER folder that holds it when no PATH
 * does. Looks only when asked, which is on a failure.
 */
export function failedTaskProgram(host: HandlerHost, tracker: CmsisJobTracker, solutionPath?: string): (execution: JobExecution) => ProgramFacts {
    return (execution) => {
        const program = taskProgram(tracker.commandOf(execution.key));
        const failedAtOnce = execution.exitCode !== undefined && execution.exitCode !== 0
            && runtimeOf(execution, host.now()) <= FAILED_AT_ONCE_MS;
        if (program.kind !== 'jlink' || program.program === undefined || !failedAtOnce || /[\\/]/.test(program.program)) {
            return program;
        }
        const facts = lookupFacts(host);
        const folders = taskPathFolders(toolsEnvironmentPath(host, solutionPath), facts.terminalEnv, facts);
        const found = findProgram(program.program, folders, facts);
        const elsewhere = found ? undefined : installedIn(program.program, facts);
        return { ...program, lookup: { found, searched: placesOf(folders), ...(elsewhere ? { installedIn: elsewhere } : {}) } };
    };
}

/** The program cdt-gdb-adapter could not spawn, from its line (`gdbserver has hit error Error: spawn JLinkGDBServerCL.exe ENOENT`). */
const SPAWNED = /spawn (\S+) ENOENT/i;

/** What the hint says first: the record's static hint says the rest of it, this one which PATH lacks the server. */
const NOT_STARTED = 'The debug adapter could not start the GDB server: ';

/**
 * The hint for a launch whose GDB server the debug adapter could not start,
 * when this call's records since `sinceSeq` hold a `GDB_SERVER_NOT_FOUND`:
 * the server program (the launch configuration's `target.server`, or the
 * name in the record) looked up on VS Code's own PATH, which the adapter
 * starts it with, and on the PATH of the CMSIS tasks; the SEGGER folder
 * that holds a J-Link server on neither. Undefined without such a record,
 * or for a server named with a folder.
 */
export function gdbServerMissingHint(
    host: HandlerHost,
    journal: ProblemJournal,
    sinceSeq: number,
    servers: readonly string[],
    solutionPath?: string,
): string | undefined {
    const callId = currentCallContext()?.callId;
    const record = journal.query({ sinceSeq, minSeverity: 'error' }).records
        .filter((candidate) => candidate.code === 'GDB_SERVER_NOT_FOUND' && (candidate.toolCallId === undefined || candidate.toolCallId === callId))
        .pop();
    if (!record) {
        return undefined;
    }
    const spawned = SPAWNED.exec(record.message)?.[1];
    const configured = spawned !== undefined
        ? servers.find((server) => path.basename(server.replace(/\\/g, '/')).toLowerCase() === path.basename(spawned.replace(/\\/g, '/')).toLowerCase())
        : servers[0];
    const program = configured ?? spawned;
    if (program === undefined || /[\\/]/.test(program)) {
        return undefined;
    }
    const facts = lookupFacts(host);
    const onVsCode = findProgram(program, processPathFolders(facts), facts);
    if (onVsCode) {
        return `${NOT_STARTED}${program} is on the PATH VS Code was started with (${onVsCode.file}), so a missing working directory is the likelier `
            + 'cause (Node reports it with the same ENOENT): check that the launch configuration\'s cwd exists, then cmsis_action load_and_debug again.';
    }
    const folders = taskPathFolders(toolsEnvironmentPath(host, solutionPath), facts.terminalEnv, facts).filter((entry) => entry.place !== VSCODE_PATH_PLACE);
    const onTasks = findProgram(program, folders, facts);
    if (onTasks) {
        return `${NOT_STARTED}${program} is on the PATH of the CMSIS tasks (${onTasks.folder}, from ${onTasks.place}) but not on the PATH VS Code was `
            + `started with, which the debug adapter uses. Ask the user to add ${onTasks.folder} to the system or user PATH, ${RESTART_VS_CODE}; `
            + PROBE_SOFTWARE_STEPS;
    }
    const searched = [VSCODE_PATH_PLACE, ...placesOf(folders)].join(', ');
    const jlink = taskProgram([program]).kind === 'jlink';
    const elsewhere = jlink ? installedIn(program, facts) : undefined;
    const missing = `${NOT_STARTED}${program} is on neither the PATH VS Code was started with nor the PATH of the CMSIS tasks (searched: ${searched})`;
    if (elsewhere) {
        return `${missing}, but ${elsewhere} holds it. Ask the user to add that folder to the system or user PATH, ${RESTART_VS_CODE}; `
            + PROBE_SOFTWARE_STEPS;
    }
    return `${missing}. Ask the user to install ${jlink ? 'the SEGGER J-Link Software' : 'the GDB server'} or add its folder to the system or user `
        + `PATH, ${RESTART_VS_CODE}; ${PROBE_SOFTWARE_STEPS}`;
}
