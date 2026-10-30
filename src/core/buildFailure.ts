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
 * Why a CMSIS build failed, in lines an agent can act on (#15).
 *
 * The CMSIS Solution extension (1.70.1) runs cbuild in a pseudoterminal no
 * other extension can read, keeps no log and contributes no problem
 * matchers. The error lines therefore come from two sources, read here and
 * put together by `src/cmsisBuildDiagnosis.ts`:
 *
 *   - stage A, the `messages` csolution records in `<solution>.cbuild-idx.yml`
 *     (missing packs and components, schema errors): `idxMessages`;
 *   - stage B, a diagnostic re-run of cbuild with `--log`: the failed task's
 *     arguments without the steps that download packs, rewrite RTE files or
 *     wipe outputs (`cbuildDiagnosticArgs`), in the environment the extension
 *     recorded in `.cmsis/tools-environment.yml` (`readToolsEnvironment`,
 *     `diagnosticEnvironment`); its log is parsed by `parseBuildLog`.
 *
 * The same stages check a build whose task exited 0, which CMSIS Solution
 * reports for failed builds too; `idxBuildFiles` and `primaryOutputs` name
 * the images whose age shows whether it rebuilt.
 *
 * Both YAML files are read with js-yaml (`parseCmsisYaml`): scalars stay
 * strings, as the CMSIS tools write them, and a value left empty is null.
 *
 * Stage B is interim: it goes once CMSIS Solution offers a log of its own
 * build, as a task-definition property or a "last build output" command
 * (requested through #21).
 *
 * Pure: no `vscode`, no processes, no file access.
 */

import * as path from 'path';
import { FAILSAFE_SCHEMA, load, nullCoreTag } from 'js-yaml';
import type { BuildLogSummary, Diagnostic } from './buildInfo/buildLog';
import { BuildMessage, MAX_BUILD_MESSAGES } from './cmsisTasks';

/** Where the diagnostic re-run writes its log, under the solution directory; git-ignored with `out/`. */
export const DIAGNOSTIC_LOG_PATH = 'out/cmsis-developer-assistant/build-diagnostic.log';
/** The diagnostic re-run is killed after this long. */
export const DIAGNOSTIC_RERUN_CAP_MS = 120_000;
/**
 * A cbuild-idx.yml or an image modified up to this long before the job
 * started still counts as written by it: file systems with a coarse
 * modification time round it down.
 */
export const IDX_FRESHNESS_SLACK_MS = 2_000;

// ── The YAML the CMSIS tools write ──────────────────────────────────────────

/** What the reader returns: scalars stay strings. */
export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };

/**
 * Every scalar a string, except an empty value, `~` and `null`: the CMSIS
 * tools write versions, ports and flags that must not turn into numbers.
 */
const CMSIS_YAML_SCHEMA = FAILSAFE_SCHEMA.withTags(nullCoreTag);

/**
 * A CMSIS YAML document as nested maps, lists and string scalars (#102):
 * comments after a key, flow collections and block scalars read as YAML
 * defines them. Null for an empty document and for one that is not YAML,
 * so a damaged file yields no messages instead of an exception.
 */
export function parseCmsisYaml(text: string): YamlValue {
    if (text.trim() === '') {
        return null;
    }
    try {
        return load(text, { schema: CMSIS_YAML_SCHEMA, maxDepth: 64, maxAliases: 100 }) as YamlValue;
    } catch {
        return null;
    }
}

function asMap(value: YamlValue | undefined): { [key: string]: YamlValue } | undefined {
    return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function asList(value: YamlValue | undefined): YamlValue[] {
    return Array.isArray(value) ? value : [];
}

function asText(value: YamlValue | undefined): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

// ── Stage A: what csolution recorded ────────────────────────────────────────

/** The errors and warnings csolution recorded in a cbuild-idx.yml; `info` entries are left out. */
export interface IdxMessages {
    errors: BuildMessage[];
    warnings: BuildMessage[];
}

/**
 * The `messages` of a `<solution>.cbuild-idx.yml`: those of the index
 * itself and of each context under `cbuilds`, which carry the context's
 * `configuration` (`.Debug+MPS3`). A message repeated for several contexts
 * is kept once.
 */
export function idxMessages(text: string): IdxMessages {
    const index = asMap(asMap(parseCmsisYaml(text))?.['build-idx']);
    const found: IdxMessages = { errors: [], warnings: [] };
    const seen = new Set<string>();
    const take = (messages: YamlValue | undefined, context: string | undefined): void => {
        const block = asMap(messages);
        for (const severity of ['error', 'warning'] as const) {
            for (const entry of asList(block?.[severity === 'error' ? 'errors' : 'warnings'])) {
                const message = asText(entry)?.trim();
                if (!message || seen.has(`${severity}|${message}`)) {
                    continue;
                }
                seen.add(`${severity}|${message}`);
                (severity === 'error' ? found.errors : found.warnings).push({ severity, message, ...(context ? { context } : {}) });
            }
        }
    };
    take(index?.messages, undefined);
    for (const entry of asList(index?.cbuilds)) {
        const cbuild = asMap(entry);
        take(cbuild?.messages, asText(cbuild?.configuration) ?? asText(cbuild?.project));
    }
    return found;
}

/** What a cbuild-idx.yml names, as written there (relative to the index): each context's cbuild.yml and the cbuild-run.yml. */
export interface IdxBuildFiles {
    cbuilds: string[];
    cbuildRun?: string;
}

/** The cbuild.yml of each context and the cbuild-run.yml a `<solution>.cbuild-idx.yml` names. */
export function idxBuildFiles(text: string): IdxBuildFiles {
    const index = asMap(asMap(parseCmsisYaml(text))?.['build-idx']);
    const cbuilds: string[] = [];
    for (const entry of asList(index?.cbuilds)) {
        const file = asText(asMap(entry)?.cbuild)?.trim();
        if (file) {
            cbuilds.push(file);
        }
    }
    const cbuildRun = asText(index?.['cbuild-run'])?.trim();
    return { cbuilds, ...(cbuildRun ? { cbuildRun } : {}) };
}

/** Output types that show whether a context was rebuilt, in the order they are looked for. */
const PRIMARY_OUTPUT_TYPES: readonly (readonly string[])[] = [['elf'], ['lib'], ['hex', 'bin']];

/**
 * The outputs of a context that show whether it was rebuilt: its ELF image,
 * else its library, else its hex or bin file. Maps, compile databases and
 * the like are left out: a build writes them whether it links or not.
 */
export function primaryOutputs(outputs: readonly { file: string; type: string }[]): string[] {
    for (const types of PRIMARY_OUTPUT_TYPES) {
        const found = outputs.filter((output) => types.includes(output.type)).map((output) => output.file);
        if (found.length > 0) {
            return found;
        }
    }
    return [];
}

/** The index file csolution writes for `solution`: `Blinky.csolution.yml` → `Blinky.cbuild-idx.yml`. */
export function idxFileName(solution: string): string {
    return `${path.basename(solution).replace(/\.csolution\.ya?ml$/i, '')}.cbuild-idx.yml`;
}

// ── Stage B: the re-run's tools, arguments and environment ──────────────────

/** One entry under `tools:` of a tools-environment.yml. */
export interface ToolEntry {
    name: string;
    version?: string;
    directory?: string;
}

/** What `.cmsis/tools-environment.yml` records about the environment the CMSIS tasks run in. */
export interface ToolsEnvironment {
    /** `environment.path`: directories put in front of PATH, in order. */
    path: string[];
    /** `environment.variables`, PATH excluded. */
    variables: Record<string, string>;
    tools: ToolEntry[];
}

/**
 * The environment CMSIS Solution (1.70.1 and later) writes next to the
 * solution for its tasks: the directories of the CMSIS-Toolbox, the
 * compilers, CMake, Ninja, pyOCD and GDB, variables such as
 * `GCC_TOOLCHAIN_14_3_1`, and each tool with its directory. Paths use
 * forward slashes on every platform. `CMSIS_PACK_ROOT` is usually not in it.
 */
export function readToolsEnvironment(text: string): ToolsEnvironment {
    const root = asMap(asMap(parseCmsisYaml(text))?.['cmsis-tools-environment']);
    const environment = asMap(root?.environment);
    const variables: Record<string, string> = {};
    for (const [name, value] of Object.entries(asMap(environment?.variables) ?? {})) {
        if (typeof value === 'string' && name.toUpperCase() !== 'PATH') {
            variables[name] = value;
        }
    }
    const directories: string[] = [];
    for (const entry of asList(environment?.path)) {
        const directory = asText(entry)?.trim();
        if (directory) {
            directories.push(directory);
        }
    }
    const tools: ToolEntry[] = [];
    for (const entry of asList(root?.tools)) {
        const tool = asMap(entry);
        const name = asText(tool?.name);
        if (name) {
            tools.push({ name, version: asText(tool?.version), directory: asText(tool?.directory) });
        }
    }
    return { path: directories, variables, tools };
}

/** A path from the file as the platform writes it: forward slashes become backslashes on Windows. */
function nativePath(recorded: string, platform: NodeJS.Platform): string {
    return platform === 'win32' ? recorded.replace(/\//g, '\\') : recorded;
}

/** cbuild in the directory of the `CMSIS-Toolbox` tool entry; undefined when the file names none. */
export function cbuildExecutable(environment: ToolsEnvironment, platform: NodeJS.Platform): string | undefined {
    const toolbox = environment.tools.find((tool) => tool.name.toLowerCase() === 'cmsis-toolbox');
    if (!toolbox?.directory) {
        return undefined;
    }
    const paths = platform === 'win32' ? path.win32 : path.posix;
    return paths.join(nativePath(toolbox.directory, platform), platform === 'win32' ? 'cbuild.exe' : 'cbuild');
}

/**
 * The environment of the re-run: `base` (this process's), the file's
 * variables, `CMSIS_PACK_ROOT` as the extension resolves it, and the file's
 * directories in front of PATH. On Windows a variable replaces one that
 * differs only in case (`Path`).
 */
export function diagnosticEnvironment(
    base: Readonly<Record<string, string | undefined>>,
    tools: ToolsEnvironment,
    packRoot: string | undefined,
    platform: NodeJS.Platform,
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(base)) {
        if (typeof value === 'string') {
            env[name] = value;
        }
    }
    const keyFor = (name: string): string => (platform === 'win32'
        ? Object.keys(env).find((existing) => existing.toUpperCase() === name.toUpperCase()) ?? name
        : name);
    for (const [name, value] of Object.entries(tools.variables)) {
        env[keyFor(name)] = value;
    }
    if (packRoot) {
        env[keyFor('CMSIS_PACK_ROOT')] = packRoot;
    }
    const pathKey = keyFor('PATH');
    const entries = tools.path.map((directory) => nativePath(directory, platform));
    const inherited = env[pathKey];
    env[pathKey] = [...entries, ...(inherited ? [inherited] : [])].join(platform === 'win32' ? ';' : ':');
    return env;
}

/** How the re-run is shaped beyond the task definition. */
export interface DiagnosticRunOptions {
    /** The solution file; the definition may name it through a variable. */
    solution: string;
    /** The context set, `--active`; the definition may name it through a variable. */
    active: string;
    /** `--output`: CMSIS Solution's `outputDirectory` setting under the solution directory. */
    output?: string;
    logFile: string;
    /** csolution converted for the failed build already: leave that step out. */
    skipConvert: boolean;
}

/** The verbosities that go on the re-run's command line; `quiet` would hide the warnings. */
const VERBOSITY_FLAGS: ReadonlyMap<string, string> = new Map([['verbose', '--verbose'], ['debug', '--debug']]);
/** Definition fields that pass a value to cbuild, in the order CMSIS Solution 1.70.1 writes them. */
const VALUE_FLAGS: ReadonlyArray<readonly [string, string]> = [
    ['generator', '--generator'], ['intermediateDirectory', '--intdir'], ['outputDirectory', '--outdir'], ['cmakeTarget', '--target'],
];

/**
 * cbuild's arguments for the diagnostic re-run of a `cmsis-csolution.build`
 * task, in the order of CMSIS Solution 1.70.1's `cbuildArgsFromTaskDefinition`,
 * without what downloads, rewrites or wipes: no `setup`, `--clean`,
 * `--rebuild`, `--packs` or `--update-rte`. `--quiet` is left out too, so
 * that warnings reach the log. `--log` is added, and `--skip-convert` when
 * csolution already converted for the failed build, so the csolution YAMLs
 * are not written again.
 */
export function cbuildDiagnosticArgs(definition: Readonly<Record<string, unknown>>, options: DiagnosticRunOptions): string[] {
    const text = (key: string): string | undefined => {
        const value = definition[key];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    const args = [options.solution];
    const verbosity = VERBOSITY_FLAGS.get(text('buildOutputVerbosity') ?? 'normal');
    if (verbosity) {
        args.push(verbosity);
    }
    for (const [key, flag] of VALUE_FLAGS) {
        const value = text(key);
        if (value) {
            args.push(flag, value);
        }
    }
    args.push('--active', options.active);
    if (definition.schemaCheck !== false) {
        args.push('--schema');
    }
    const toolchain = text('toolchain');
    if (toolchain) {
        args.push('--toolchain', toolchain);
    }
    if (typeof definition.jobs === 'number') {
        args.push('--jobs', String(definition.jobs));
    }
    if (options.output) {
        args.push('--output', options.output);
    }
    args.push('--log', options.logFile);
    if (options.skipConvert) {
        args.push('--skip-convert');
    }
    return args;
}

// ── From a parsed log to messages ───────────────────────────────────────────

function asMessage(diagnostic: Diagnostic): BuildMessage {
    return {
        severity: diagnostic.severity === 'error' ? 'error' : 'warning',
        ...(diagnostic.file ? { file: diagnostic.file } : {}),
        ...(diagnostic.line ? { line: diagnostic.line } : {}),
        ...(diagnostic.col ? { column: diagnostic.col } : {}),
        ...(diagnostic.code ? { code: diagnostic.code } : {}),
        message: diagnostic.message,
    };
}

/** The errors and warnings of a parsed log, errors first as they appeared, each list capped; notes are left out. */
export function messagesFromLog(summary: BuildLogSummary): { errors: BuildMessage[]; warnings: BuildMessage[] } {
    const pick = (severity: Diagnostic['severity']): BuildMessage[] => summary.diagnostics
        .filter((diagnostic) => diagnostic.severity === severity)
        .slice(0, MAX_BUILD_MESSAGES)
        .map(asMessage);
    return { errors: pick('error'), warnings: pick('warning') };
}

// ── The report ──────────────────────────────────────────────────────────────

/** How the diagnostic re-run ended. */
export interface RerunOutcome {
    /** cbuild's exit code; null when it was killed. */
    exitCode: number | null;
    /** Killed at `DIAGNOSTIC_RERUN_CAP_MS`. */
    stoppedAtCap: boolean;
    /** The log's last status line (`Build summary: …`, `ninja: build stopped: …`). */
    status?: string;
}

/** Everything `renderBuildFailure` shows about a failed build. */
export interface BuildFailureReport {
    /** Where the lines come from: csolution's index, the diagnostic re-run, or neither. */
    source: 'csolution' | 'rerun' | 'none';
    errors: BuildMessage[];
    warnings: BuildMessage[];
    /** The full counts; a re-run's warnings are only those of the files it recompiled. */
    errorCount: number;
    warningCount: number;
    /** ninja targets that failed in the re-run. */
    failedSteps: string[];
    /** csolution's warnings from a fresh index, when the lines come from elsewhere. */
    csolutionWarnings: BuildMessage[];
    /** The index the csolution messages come from. */
    idxFile?: string;
    /** The re-run's log. */
    logFile?: string;
    rerun?: RerunOutcome;
    /** Why cbuild was not re-run, or why the re-run has no lines. */
    skipped?: string;
}

/** Why a failed build is not re-run, in the words of the result. */
export type RerunSkip =
    | { kind: 'setting-off' }
    | { kind: 'no-environment'; file: string }
    | { kind: 'no-cbuild'; directory?: string }
    | { kind: 'no-solution' }
    | { kind: 'clean' }
    | { kind: 'unresolved'; field: string }
    | { kind: 'build-running'; name: string }
    | { kind: 'superseded' }
    | { kind: 'spawn-failed'; error: string };

/** The sentence a skipped re-run adds to the result. */
export function rerunSkipText(skip: RerunSkip): string {
    switch (skip.kind) {
        case 'setting-off':
            return 'the diagnostic re-run of cbuild is off (setting cmsis-developer-assistant.build.diagnosticRerun)';
        case 'no-environment':
            return `${skip.file} is missing (CMSIS Solution 1.70.1 and later write it), so cbuild was not re-run`;
        case 'no-cbuild':
            return skip.directory
                ? `cbuild was not found in the CMSIS-Toolbox directory .cmsis/tools-environment.yml names (${skip.directory}), so it was not re-run`
                : '.cmsis/tools-environment.yml names no CMSIS-Toolbox directory, so cbuild was not re-run';
        case 'no-solution':
            return 'the solution file of the build is not known, so cbuild was not re-run';
        case 'clean':
            return 'a failed clean is not re-run';
        case 'unresolved':
            return `the task definition's '${skip.field}' uses a variable the re-run cannot resolve, so cbuild was not re-run`;
        case 'build-running':
            return `'${skip.name}' is running, so cbuild was not re-run beside it`;
        case 'superseded':
            return 'the diagnostic re-run of cbuild was stopped because another build started; that build\'s result replaces this one';
        case 'spawn-failed':
            return `the diagnostic re-run of cbuild could not start (${skip.error})`;
    }
}
