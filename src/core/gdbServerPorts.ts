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
 * Where a CMSIS attach would connect, and whether the window's CMSIS Run
 * task can be what serves it there.
 *
 * An attach configuration of the CMSIS Debugger (`gdbtarget`, `request:
 * attach`) starts no GDB server; GDB's `target remote` connects to
 * `target.host:target.port`. When nothing listens there, GDB retries for its
 * connect timeout (15 s) and the session ends with "could not connect".
 *
 * Nothing here connects to such a port to find out: a GDB server takes every
 * connection as a client. pyOCD halts the target when a client connects and
 * resumes it when the client leaves, and without `--persist` it shuts down
 * then; the J-Link GDB server started with `-singlerun` closes with its last
 * client. What is known without a connection is the command line of the
 * window's CMSIS Run task: the FVP adapter's Run is the model without its
 * GDBServer plugin, which belongs to the launch configuration, so while it
 * runs nothing the window started serves an attach.
 *
 * Load & Debug and Attach need a launch configuration CMSIS Solution wrote;
 * `cmsisLaunchConfigurations` lists them, with the pre-launch task of each,
 * and `activeLaunchConfigurations` keeps those of the active target.
 * `isFvpSession` tells from a session's configuration whether its GDB server
 * is an Arm FVP's, which ignores GDB's interrupt while the model runs.
 *
 * Which local port a GDB server will listen on is read the same way, from
 * the command line and the configuration: `configurationGdbPort` for a
 * launch configuration or a live session, `runTaskGdbPorts` for a CMSIS Run
 * task. Each window publishes the ports its live sessions and CMSIS Run
 * tasks use (`windowGdbPorts`, as `GdbPortClaim`s in its registry entry), so
 * that a launch in another window on the same port is refused before GDB
 * connects to the wrong server (`src/core/gdbPortGuard.ts`).
 *
 * No `vscode`: the launch.json text and the task come in.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

/** One attach configuration's GDB server address. */
export interface AttachEndpoint {
    name: string;
    host: string;
    port: number;
}

/**
 * What a CMSIS Run task's command line says about the attach: it loads a GDB
 * server, it is an FVP model without one, or it does not tell (no command
 * line, or a program that is neither, such as a model shim).
 */
export type RunCommandKind = 'gdbServer' | 'bareModel' | 'unknown';

/** The cbuild-run.yml debugger of the FVP adapter, whose CMSIS Run is the model without the GDBServer plugin. */
const FVP_DEBUGGER = 'Arm-FVP';

/**
 * A word of a GDB server's command line: pyOCD's `gdbserver` subcommand, the
 * J-Link `JLinkGDBServerCL`, the FVP's `GDBServer.so` / `GDBServer.dll`
 * plugin and its `GDBServer.port` parameter.
 */
const GDB_SERVER_WORD = /gdbserver/i;
/** The executable of an Arm FVP model (`FVP_Corstone_SSE-300`, `FVP_MPS2_Cortex-M3.exe`; `VHT_…` for the older AVH models). */
const FVP_MODEL = /^(?:FVP|VHT)_/;
/** The FVP's GDB server plugin as a launch configuration loads it (`--plugin …/GDBServer.so`, `.dll` on Windows). */
const FVP_GDB_SERVER_PLUGIN = /(?:^|[\\/])GDBServer\.(?:so|dll)$/i;
/** The plugin's port parameter in a launch configuration's `serverParameters` (`-C GDBServer.port=3333`). */
const FVP_GDB_SERVER_PORT = /^GDBServer\.port=/i;
/** The launch configurations CMSIS Solution writes for the FVP adapter: `Arm-FVP@GDB (launch)`, `Arm-FVP@GDB (attach)`. */
const FVP_CONFIGURATION_NAME = /^Arm-FVP@/i;
/** A word of a command line: double-quoted, single-quoted or bare. */
const COMMAND_LINE_WORD = /"([^"]*)"|'([^']*)'|(\S+)/g;

/**
 * A TCP port given as a number or as digits, the digits also in quotes: an
 * adapter template may render `"port": "\"<%= ports.get(pname) %>\""`, as a
 * custom debug setup's own template can (`"\"45343\""`). Anything else is none.
 */
function portOf(value: unknown): number | undefined {
    const digits = typeof value === 'string' ? /^\s*(["']?)(\d+)\1\s*$/.exec(value)?.[2] : undefined;
    const port = typeof value === 'number' ? value : digits !== undefined ? Number(digits) : NaN;
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/**
 * The GDB server addresses of the `gdbtarget` attach configurations in a
 * launch.json text (comments and trailing commas allowed). Configurations
 * without a numeric `target.port` are left out; the host defaults to
 * localhost, as the adapter's does.
 */
export function attachEndpoints(launchJson: string): AttachEndpoint[] {
    const parsed: unknown = parseJsonc(launchJson, [], { allowTrailingComma: true });
    const configurations = (parsed as { configurations?: unknown } | undefined)?.configurations;
    if (!Array.isArray(configurations)) {
        return [];
    }
    const endpoints: AttachEndpoint[] = [];
    for (const entry of configurations) {
        const config = entry as { type?: unknown; request?: unknown; name?: unknown; target?: { host?: unknown; port?: unknown } };
        if (config?.type !== 'gdbtarget' || config.request !== 'attach') {
            continue;
        }
        const port = portOf(config.target?.port);
        if (port === undefined) {
            continue;
        }
        const host = typeof config.target?.host === 'string' && config.target.host.trim() !== '' ? config.target.host.trim() : 'localhost';
        endpoints.push({ name: typeof config.name === 'string' ? config.name : 'attach', host, port });
    }
    return endpoints;
}

/** The attach endpoints of `folder/.vscode/launch.json`; none when the file cannot be read. Reads the file only. */
export async function launchAttachEndpoints(folder: string): Promise<AttachEndpoint[]> {
    try {
        return attachEndpoints(await fs.promises.readFile(path.join(folder, '.vscode', 'launch.json'), 'utf8'));
    } catch {
        return [];
    }
}

/** A launch configuration CMSIS Solution wrote: every one of its templates carries a `cmsis` node. */
export interface CmsisLaunchConfiguration {
    name: string;
    request: 'launch' | 'attach';
    /** The task VS Code runs first: `CMSIS Load` for the pyOCD and J-Link launches, none for FVP and Arm Debugger. */
    preLaunchTask?: string;
    /** `target.server`: the GDB server program the debug adapter starts for a launch (`pyocd`, `JLinkGDBServerCL.exe`). */
    server?: string;
    /** The local port the GDB server of a launch will listen on, when the configuration fixes one (`configurationGdbPort`). */
    gdbPort?: number;
    /** That GDB server, when its command line names one. */
    gdbServer?: GdbServerKind;
    /** True for a configuration of an Arm FVP (`isFvpSession`), which CMSIS Solution writes for the debugger `Arm-FVP`. */
    fvp: boolean;
    /** For a pyOCD launch without a fixed port, the cbuild-run file its server reads the port from (`launchCbuildRun`). */
    cbuildRun?: string;
}

/** The `configurations` array of a launch.json text, comments and trailing commas allowed; none when it has no such array. */
function launchConfigurationsOf(launchJson: string): unknown[] {
    const parsed: unknown = parseJsonc(launchJson, [], { allowTrailingComma: true });
    const configurations = (parsed as { configurations?: unknown } | undefined)?.configurations;
    return Array.isArray(configurations) ? configurations : [];
}

/**
 * The configurations of a launch.json text that CMSIS Solution's Load & Debug
 * and Attach can start: request `launch` or `attach`, with a `cmsis` node;
 * with the pre-launch task and the GDB server program of each, and for a
 * launch the GDB port its server will use.
 */
export function cmsisLaunchConfigurations(launchJson: string): CmsisLaunchConfiguration[] {
    const found: CmsisLaunchConfiguration[] = [];
    for (const entry of launchConfigurationsOf(launchJson)) {
        const config = entry as { name?: unknown; request?: unknown; cmsis?: unknown; preLaunchTask?: unknown; target?: { server?: unknown } };
        if ((config?.request !== 'launch' && config?.request !== 'attach') || typeof config.cmsis !== 'object' || config.cmsis === null) {
            continue;
        }
        const listens = config.request === 'launch' ? configurationGdbPort(config) : undefined;
        const cbuildRun = listens ? undefined : launchCbuildRun(config);
        found.push({
            name: typeof config.name === 'string' ? config.name : config.request,
            request: config.request,
            ...(typeof config.preLaunchTask === 'string' ? { preLaunchTask: config.preLaunchTask } : {}),
            ...(typeof config.target?.server === 'string' && config.target.server.trim() !== '' ? { server: config.target.server.trim() } : {}),
            ...(listens ? { gdbPort: listens.port } : {}),
            ...(listens?.server ? { gdbServer: listens.server } : {}),
            fvp: isFvpSession(config),
            ...(cbuildRun !== undefined ? { cbuildRun } : {}),
        });
    }
    return found;
}

/**
 * The launch configurations Load & Debug can start for the active target.
 * CMSIS Solution starts one configuration, the one it writes for the
 * debugger of the active target's cbuild-run.yml, with the GDB ports of that
 * file's `gdbserver:` list. A launch.json also keeps configurations it does
 * not rewrite (`updateConfiguration: manual`, an Arm FVP set up by hand
 * beside a board's): those of the other kind (FVP or not, by
 * `debuggerName`) and those on a port `ports` does not list are left out.
 * A filter that would leave nothing is skipped, and so is one without its
 * fact (no debugger, no ports). A pyOCD launch that reads its port from the
 * active target's file (`cbuildRun` through CMSIS Solution's command) gets
 * that port when the file lists exactly one.
 */
export function activeLaunchConfigurations(
    launches: readonly CmsisLaunchConfiguration[],
    debuggerName: string | undefined,
    ports: readonly number[],
): CmsisLaunchConfiguration[] {
    const resolved = launches.map((config) => (config.gdbPort === undefined && config.cbuildRun?.includes('${') && ports.length === 1
        ? { ...config, gdbPort: ports[0], gdbServer: 'pyOCD' as const } : config));
    const ofKind = debuggerName === undefined ? [] : resolved.filter((config) => config.fvp === isFvpDebugger(debuggerName));
    const candidates = ofKind.length > 0 ? ofKind : resolved;
    const onPorts = candidates.filter((config) => config.gdbPort !== undefined && ports.includes(config.gdbPort));
    return onPorts.length > 0 ? onPorts : candidates;
}

/** The configuration of a launch.json text with this `name`; undefined when there is none. */
export function launchConfigurationNamed(launchJson: string, name: string): unknown {
    return launchConfigurationsOf(launchJson).find((entry) => (entry as { name?: unknown } | undefined)?.name === name);
}

/** The configuration named `name` in `folder/.vscode/launch.json`; undefined when there is none or the file cannot be read. Reads the file only. */
export async function folderLaunchConfiguration(folder: string, name: string): Promise<unknown> {
    try {
        return launchConfigurationNamed(await fs.promises.readFile(path.join(folder, '.vscode', 'launch.json'), 'utf8'), name);
    } catch {
        return undefined;
    }
}

/** The CMSIS launch configurations of `folder/.vscode/launch.json`; none when the file cannot be read. Reads the file only. */
export async function folderCmsisLaunchConfigurations(folder: string): Promise<CmsisLaunchConfiguration[]> {
    try {
        return cmsisLaunchConfigurations(await fs.promises.readFile(path.join(folder, '.vscode', 'launch.json'), 'utf8'));
    } catch {
        return [];
    }
}

/** The text of a `string` or a `ShellQuotedString` (`{ value }`). */
function wordOf(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    const quoted = (value as { value?: unknown } | undefined)?.value;
    return typeof quoted === 'string' ? quoted : undefined;
}

/**
 * The program and arguments a task runs: its `ShellExecution` (`command` and
 * `args`, or one `commandLine`) or `ProcessExecution` (`process` and `args`),
 * as `vscode.Task.execution` holds them for a tasks.json task. Undefined for
 * anything else (no execution, a `CustomExecution`).
 */
export function taskCommandWords(task: unknown): string[] | undefined {
    const execution = (task as { execution?: unknown } | undefined)?.execution as
        { commandLine?: unknown; command?: unknown; process?: unknown; args?: unknown } | undefined;
    if (typeof execution?.commandLine === 'string') {
        const words = [...execution.commandLine.matchAll(COMMAND_LINE_WORD)].map((match) => match[1] ?? match[2] ?? match[3]);
        return words.length > 0 ? words : undefined;
    }
    const program = wordOf(execution?.command) ?? wordOf(execution?.process);
    if (program === undefined || program.trim() === '') {
        return undefined;
    }
    const args = Array.isArray(execution?.args) ? execution.args.map(wordOf).filter((word): word is string => word !== undefined) : [];
    return [program, ...args];
}

/**
 * What a CMSIS Run task's command line says: any word that names a GDB server
 * makes it `gdbServer`; otherwise an FVP model executable is the bare model
 * (the FVP adapter's Run: the model, its configuration file and the images);
 * anything else is `unknown`.
 */
export function runCommandKind(words: readonly string[] | undefined): RunCommandKind {
    if (!words || words.length === 0) {
        return 'unknown';
    }
    if (words.some((word) => GDB_SERVER_WORD.test(word))) {
        return 'gdbServer';
    }
    const program = words[0].split(/[\\/]/).pop() ?? words[0];
    return FVP_MODEL.test(program) ? 'bareModel' : 'unknown';
}

/** True for the FVP adapter's debugger name as a cbuild-run.yml writes it (`Arm-FVP`), in any case. */
export function isFvpDebugger(name: string | undefined): boolean {
    return name !== undefined && name.trim().toLowerCase() === FVP_DEBUGGER.toLowerCase();
}

/**
 * True for a CMSIS Debugger session (`gdbtarget`) on an Arm FVP: its
 * configuration is named as CMSIS Solution names the FVP adapter's
 * (`Arm-FVP@…`), its GDB server is a model executable, or its server
 * parameters load the model's GDBServer plugin or set its port. The model's
 * GDB server does not stop on GDB's interrupt while the simulation runs;
 * only a breakpoint stops it.
 */
export function isFvpSession(configuration: unknown): boolean {
    const config = configuration as { type?: unknown; name?: unknown; target?: { server?: unknown; serverParameters?: unknown } } | undefined;
    if (config?.type !== 'gdbtarget') {
        return false;
    }
    if (typeof config.name === 'string' && FVP_CONFIGURATION_NAME.test(config.name.trim())) {
        return true;
    }
    const server = wordOf(config.target?.server);
    if (server !== undefined && FVP_MODEL.test(server.split(/[\\/]/).pop() ?? server)) {
        return true;
    }
    const parameters: unknown[] = Array.isArray(config.target?.serverParameters) ? config.target.serverParameters : [];
    return parameters.some((parameter) => {
        const word = wordOf(parameter)?.trim();
        return word !== undefined && (FVP_GDB_SERVER_PLUGIN.test(word) || FVP_GDB_SERVER_PORT.test(word));
    });
}

// ── The GDB port a server will listen on ────────────────────────────────────

/** A GDB server whose command line the port logic reads. */
export type GdbServerKind = 'pyOCD' | 'J-Link' | 'Arm FVP';

/**
 * A local GDB port a window's live debug session or CMSIS Run task uses, as
 * the window's registry entry publishes it (`gdbPorts`). Windows of earlier
 * versions publish none, and readers take only what `gdbPortClaimsOf` admits.
 */
export interface GdbPortClaim {
    port: number;
    /** What uses it: a debug session (its GDB server, or the one it attached to) or the CMSIS Run task. */
    source: 'session' | 'cmsis-run';
    /** The session's configuration name or the task's label: `STLink@pyOCD (launch)`, `CMSIS Run`. */
    label: string;
    /** The GDB server, when its command line names one. */
    server?: GdbServerKind;
}

/** A live debug session, as the window's claims read it. */
export interface SessionPortFacts {
    name: string;
    configuration: unknown;
}

/** A live CMSIS Run task, as the window's claims read it. */
export interface RunPortFacts {
    name: string;
    /** Its program and arguments (`taskCommandWords`); undefined when it has none. */
    words: readonly string[] | undefined;
}

/** pyOCD's executable; its `gdbserver` subcommand hosts the GDB server. */
const PYOCD_PROGRAM = /^pyocd(?:\.exe)?$/i;
/** The J-Link GDB server: `JLinkGDBServer`, `JLinkGDBServerCL`, `JLinkGDBServerCLExe`, `JLinkGDBServerCL.exe`. */
const JLINK_GDB_SERVER = /^JLinkGDBServer/i;
/** The FVP plugin's port parameter, alone or glued to `-C`: `GDBServer.port=3333`, `-CGDBServer.port=3333`. */
const FVP_PORT_PARAMETER = /^(?:-C)?GDBServer\.port=(\S*)$/i;
/** The port pyOCD's `gdbserver` listens on when neither its command line nor the cbuild-run file names one. */
const PYOCD_DEFAULT_PORT = 3333;
/** The port of the J-Link GDB server without `-port`. */
const JLINK_DEFAULT_PORT = 2331;
/** Hosts a GDB on this machine reaches as itself; a server on any other host holds no local port. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);
/** The label of the task CMSIS Solution writes for its Run button. */
const RUN_TASK_LABEL = 'CMSIS Run';

/** The file name of a program word, without its folders. */
function programName(word: string): string {
    return word.split(/[\\/]/).pop() ?? word;
}

/**
 * Which GDB server a command line runs: an FVP (the model, or a shim that
 * loads its GDBServer plugin), pyOCD or J-Link. A custom debug setup may
 * start pyOCD's `gdbserver` through Python or a wrapper script; it counts
 * as pyOCD when that subcommand passes `--cbuild-run`, an option only
 * pyOCD's has. The name of a wrapper proves nothing and is not read: a
 * setup this does not know has no inferred port, and its server's own
 * bind failure tells.
 */
export function gdbServerKind(words: readonly string[] | undefined): GdbServerKind | undefined {
    if (!words || words.length === 0) {
        return undefined;
    }
    const program = programName(words[0]);
    if (FVP_MODEL.test(program) || words.some((word) => FVP_GDB_SERVER_PLUGIN.test(word) || FVP_PORT_PARAMETER.test(word))) {
        return 'Arm FVP';
    }
    const subcommand = words.indexOf('gdbserver');
    if (PYOCD_PROGRAM.test(program) || (subcommand > 0 && words.includes('--cbuild-run'))) {
        return 'pyOCD';
    }
    return JLINK_GDB_SERVER.test(program) ? 'J-Link' : undefined;
}

/**
 * The port a GDB server's command line sets: `-C GDBServer.port=<n>` (Arm
 * FVP), `--port <n>`, `--port=<n>` or, for pyOCD, `-p <n>`, and `-port <n>`
 * (J-Link). Undefined when it sets none, or not as a number.
 */
export function commandLinePort(words: readonly string[]): number | undefined {
    const pyocd = gdbServerKind(words) === 'pyOCD';
    for (let index = 1; index < words.length; index++) {
        const word = words[index].trim();
        const fixed = FVP_PORT_PARAMETER.exec(word) ?? /^--port=(\S*)$/.exec(word);
        if (fixed) {
            return portOf(fixed[1]);
        }
        if (word === '--port' || /^-port$/i.test(word) || (pyocd && word === '-p')) {
            return portOf(words[index + 1]);
        }
    }
    return undefined;
}

/** The GDB server program and its parameters of a configuration's `target`; the adapter's default server when it names none. */
function serverWords(target: { server?: unknown; serverParameters?: unknown } | undefined): string[] {
    const server = wordOf(target?.server)?.trim();
    const parameters: unknown[] = Array.isArray(target?.serverParameters) ? target.serverParameters : [];
    return [server !== undefined && server !== '' ? server : 'gdbserver',
        ...parameters.map(wordOf).filter((word): word is string => word !== undefined)];
}

/**
 * The local GDB port of a CMSIS Debugger configuration (`gdbtarget`), as a
 * launch.json holds it or a live session carries it: `target.port`, else for
 * a launch the port its GDB server's parameters set (an FVP's
 * `GDBServer.port`, with `target.port` left empty for the port detection).
 * Undefined for another debug type, a server on another host, and a launch
 * whose port is not fixed.
 */
export function configurationGdbPort(configuration: unknown): { port: number; server?: GdbServerKind } | undefined {
    const config = configuration as { type?: unknown; request?: unknown; target?: { host?: unknown; port?: unknown; server?: unknown; serverParameters?: unknown } } | undefined;
    if (config?.type !== 'gdbtarget') {
        return undefined;
    }
    const host = typeof config.target?.host === 'string' ? config.target.host.trim().toLowerCase() : '';
    if (!LOOPBACK_HOSTS.has(host)) {
        return undefined;
    }
    const launch = config.request === 'launch';
    const words = serverWords(config.target);
    const port = portOf(config.target?.port) ?? (launch ? commandLinePort(words) : undefined);
    if (port === undefined) {
        return undefined;
    }
    const server = launch ? gdbServerKind(words) : undefined;
    return server ? { port, server } : { port };
}

/**
 * The cbuild-run file a pyOCD CMSIS Run reads its GDB ports from: the
 * argument of `--cbuild-run` when the command line sets no port itself.
 * Undefined for any other command line.
 */
export function runTaskCbuildRun(words: readonly string[] | undefined): string | undefined {
    if (!words || gdbServerKind(words) !== 'pyOCD' || !words.includes('gdbserver') || commandLinePort(words) !== undefined) {
        return undefined;
    }
    const at = words.indexOf('--cbuild-run');
    return at >= 0 && at + 1 < words.length ? words[at + 1] : undefined;
}

/**
 * The cbuild-run file a pyOCD launch's GDB server reads its port from: the
 * argument of `--cbuild-run` when neither `target.port` nor the command line
 * fixes the port. In launch.json it is `${command:cmsis-csolution.getCbuildRunFile}`,
 * the active target's file; a live session carries the absolute path it was
 * resolved to. Undefined for any other configuration.
 */
export function launchCbuildRun(configuration: unknown): string | undefined {
    const config = configuration as { type?: unknown; request?: unknown; target?: { host?: unknown; port?: unknown; server?: unknown; serverParameters?: unknown } } | undefined;
    if (config?.type !== 'gdbtarget' || config.request !== 'launch' || portOf(config.target?.port) !== undefined) {
        return undefined;
    }
    const host = typeof config.target?.host === 'string' ? config.target.host.trim().toLowerCase() : '';
    return LOOPBACK_HOSTS.has(host) ? runTaskCbuildRun(serverWords(config.target)) : undefined;
}

/**
 * The GDB ports a CMSIS Run task serves: the port its command line sets;
 * else for pyOCD's `gdbserver` the ports of the cbuild-run file it reads
 * (`cbuildRunPorts`, one per core) or pyOCD's 3333, and for the J-Link GDB
 * server its 2331. None for a task that hosts no GDB server, such as the FVP
 * adapter's Run, which is the model without its plugin.
 */
export function runTaskGdbPorts(words: readonly string[] | undefined, cbuildRunPorts: readonly number[] = []): number[] {
    if (!words || runCommandKind(words) !== 'gdbServer') {
        return [];
    }
    const fixed = commandLinePort(words);
    if (fixed !== undefined) {
        return [fixed];
    }
    switch (gdbServerKind(words)) {
        case 'pyOCD':
            return words.includes('gdbserver') ? (cbuildRunPorts.length > 0 ? [...cbuildRunPorts] : [PYOCD_DEFAULT_PORT]) : [];
        case 'J-Link':
            return [JLINK_DEFAULT_PORT];
        default:
            return [];
    }
}

/**
 * The program and arguments of the `CMSIS Run` task in a tasks.json text, as
 * CMSIS Solution writes it (`command` and `args`); undefined when there is no
 * such task or it names no command.
 */
export function cmsisRunCommand(tasksJson: string): string[] | undefined {
    const parsed: unknown = parseJsonc(tasksJson, [], { allowTrailingComma: true });
    const tasks = (parsed as { tasks?: unknown } | undefined)?.tasks;
    if (!Array.isArray(tasks)) {
        return undefined;
    }
    const run = tasks.find((task) => (task as { label?: unknown } | undefined)?.label === RUN_TASK_LABEL) as { command?: unknown; args?: unknown } | undefined;
    return run ? taskCommandWords({ execution: { command: run.command, args: run.args } }) : undefined;
}

/** The `CMSIS Run` command of `folder/.vscode/tasks.json`; undefined when there is none or the file cannot be read. Reads the file only. */
export async function folderCmsisRunCommand(folder: string): Promise<string[] | undefined> {
    try {
        return cmsisRunCommand(await fs.promises.readFile(path.join(folder, '.vscode', 'tasks.json'), 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * The local GDB ports a debug session uses: its fixed port
 * (`configurationGdbPort`), else, for a pyOCD launch that reads them from a
 * cbuild-run file (`launchCbuildRun`), the ports that file lists, one per
 * core. None when neither tells.
 */
export async function sessionGdbPorts(
    configuration: unknown,
    cbuildRunPorts: (file: string) => Promise<readonly number[]>,
): Promise<Array<{ port: number; server?: GdbServerKind }>> {
    const listens = configurationGdbPort(configuration);
    if (listens) {
        return [listens];
    }
    const file = launchCbuildRun(configuration);
    return file === undefined ? [] : (await cbuildRunPorts(file)).map((port) => ({ port, server: 'pyOCD' as const }));
}

/**
 * The GDB ports a window uses, as its registry entry publishes them: its
 * CMSIS Run tasks first (each one hosts its server), then its debug
 * sessions; one claim per port. `cbuildRunPorts` reads the ports of the
 * cbuild-run file a pyOCD Run or launch names (`runTaskCbuildRun`,
 * `launchCbuildRun`).
 */
export async function windowGdbPorts(
    sessions: readonly SessionPortFacts[],
    runs: readonly RunPortFacts[],
    cbuildRunPorts: (file: string) => Promise<readonly number[]>,
): Promise<GdbPortClaim[]> {
    const claims: GdbPortClaim[] = [];
    const add = (claim: GdbPortClaim): void => {
        if (!claims.some((known) => known.port === claim.port)) {
            claims.push(claim);
        }
    };
    for (const run of runs) {
        const file = runTaskCbuildRun(run.words);
        const fromFile = file !== undefined ? await cbuildRunPorts(file) : [];
        const server = gdbServerKind(run.words);
        for (const port of runTaskGdbPorts(run.words, fromFile)) {
            add({ port, source: 'cmsis-run', label: run.name, ...(server ? { server } : {}) });
        }
    }
    for (const session of sessions) {
        for (const listens of await sessionGdbPorts(session.configuration, cbuildRunPorts)) {
            add({ port: listens.port, source: 'session', label: session.name, ...(listens.server ? { server: listens.server } : {}) });
        }
    }
    return claims;
}

const GDB_SERVER_KINDS: ReadonlySet<unknown> = new Set<GdbServerKind>(['pyOCD', 'J-Link', 'Arm FVP']);

/**
 * The claims a registry entry's `gdbPorts` holds, each field checked: an
 * entry of an earlier version has none, and one of a later version may carry
 * what this one does not know, which is left out.
 */
export function gdbPortClaimsOf(value: unknown): GdbPortClaim[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const claims: GdbPortClaim[] = [];
    for (const item of value) {
        const { port, source, label, server } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
        const valid = portOf(port);
        if (valid === undefined || (source !== 'session' && source !== 'cmsis-run') || typeof label !== 'string') {
            continue;
        }
        claims.push({ port: valid, source, label, ...(GDB_SERVER_KINDS.has(server) ? { server: server as GdbServerKind } : {}) });
    }
    return claims;
}
