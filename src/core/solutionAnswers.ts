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
 * What the answers of the CMSIS Solution extension's getter commands mean.
 * The commands are string resolvers for `${command:…}` variables, so "none"
 * comes back as a value, not as an error: `""` or `undefined` when no
 * solution is loaded, the sentinel `"<not found>"` from `getDfpPath` and
 * `getBspPath` when the active target names no such pack. Every caller that
 * asks one of them interprets the answer here; how long it waits and what it
 * does without an answer stays with the caller.
 *
 * Read from CMSIS Solution 1.72.0 (`dist/extension.js`):
 * - `getSolutionFile`: the path of the active csolution, or undefined;
 * - `getActiveTargetSet`: `<target-type>@<set>`, `<target-type>`, or `""`;
 * - `getCbuildRunFile`: `cbuildRunYml.fileName` of the loaded solution, the
 *   `cbuild-run:` entry of the `<solution>.cbuild-idx.yml` beside the
 *   csolution, `path.resolve`d against that file's folder (so absolute, in
 *   the platform's spelling) whether or not the file exists; `""` without a
 *   loaded solution, that index or that entry. Update Debug Tasks reads the
 *   same file;
 * - `getDfpPath`, `getBspPath`: the `path:` the active context's cbuild.yml
 *   gives the target's device or board pack, with `${CMSIS_PACK_ROOT}`
 *   replaced, else `"<not found>"`. A pack the csolution names with `path:`
 *   keeps the path the cbuild.yml writes, which may be relative to that file.
 *
 * Pure: no `vscode`, no file access.
 */

import * as path from 'path';

/** The answer of `getDfpPath` and `getBspPath` when the active target has no such pack. */
export const PACK_NOT_FOUND = '<not found>';

/** What `getSolutionFile` says about the window. */
export interface SolutionFileAnswer {
    /** The extension has a solution loaded. */
    active: boolean;
    /** Its csolution file, when the answer names one. */
    file?: string;
}

/** The folders the extension names for the active target's packs, as answered. */
export interface ActivePackFolders {
    /** `getDfpPath`: the device family pack. */
    dfp?: string;
    /** `getBspPath`: the board support pack. */
    bsp?: string;
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * An answer of `cmsis-csolution.getSolutionFile`: a path, or an object that
 * names one (`solutionFile`, `fsPath`, `uri.fsPath`, `path`, `uri.path`, in
 * that order). `""`, `undefined`, `null` and `false` mean no solution; any
 * other answer means one is loaded, with its path unknown when none is named.
 */
export function solutionAnswerOf(answer: unknown): SolutionFileAnswer {
    if (typeof answer === 'string') {
        const file = nonEmpty(answer);
        return file ? { active: true, file } : { active: false };
    }
    if (!answer) {
        return { active: false };
    }
    if (typeof answer === 'object') {
        const fields = answer as { solutionFile?: unknown; fsPath?: unknown; path?: unknown; uri?: { fsPath?: unknown; path?: unknown } | null };
        const file = nonEmpty(fields.solutionFile) ?? nonEmpty(fields.fsPath) ?? nonEmpty(fields.uri?.fsPath)
            ?? nonEmpty(fields.path) ?? nonEmpty(fields.uri?.path);
        return file ? { active: true, file } : { active: true };
    }
    return { active: true };
}

/**
 * The csolution file in an answer of `cmsis-csolution.getSolutionFile`.
 * Undefined for `""` (no solution loaded) and for an answer that names no path.
 */
export function solutionFileOf(answer: unknown): string | undefined {
    return solutionAnswerOf(answer).file;
}

/** `getSolutionFile` as the name of the solution: the file's basename without `.csolution.yml`. */
export function solutionNameOf(answer: unknown): string | undefined {
    const file = solutionFileOf(answer);
    return file ? nonEmpty(path.basename(file).replace(/\.csolution\.ya?ml$/i, '')) : undefined;
}

/** An answer of `cmsis-csolution.getActiveTargetSet`, trimmed; undefined when empty or not a string. */
export function activeTargetSetOf(answer: unknown): string | undefined {
    return nonEmpty(answer);
}

/** The target-type of an answer of `getActiveTargetSet` (`HW@Debug` → `HW`). */
export function targetTypeOf(answer: unknown): string | undefined {
    const set = activeTargetSetOf(answer);
    return set ? nonEmpty(set.split('@')[0]) : undefined;
}

/**
 * An answer of `cmsis-csolution.getCbuildRunFile`, for `flash`, `cmsis_action`
 * and the documentation tools alike. The extension resolves the entry of
 * `cbuild-idx.yml` to an absolute path; a relative answer has no known base,
 * so it counts as none, like `""`. Whether the file exists is the caller's
 * check.
 */
export function cbuildRunFileOf(answer: unknown): string | undefined {
    const file = nonEmpty(answer);
    return file && path.isAbsolute(file) ? file : undefined;
}

/** An answer of `getDfpPath` or `getBspPath`; undefined for `""` and `"<not found>"`. */
export function packFolderOf(answer: unknown): string | undefined {
    const folder = nonEmpty(answer);
    return folder && folder !== PACK_NOT_FOUND ? folder : undefined;
}

/**
 * Where a pack folder the extension named may be: the folder itself when it
 * is absolute, else the folder resolved against each of `bases` (the
 * folders a cbuild.yml of the target lies in), without repeats. Which of
 * them holds the pack is for the caller to check against its PDSC.
 */
export function packFolderCandidates(folder: string, bases: readonly string[]): string[] {
    if (path.isAbsolute(folder)) {
        return [path.normalize(folder)];
    }
    return [...new Set(bases.map((base) => path.resolve(base, folder)))];
}
