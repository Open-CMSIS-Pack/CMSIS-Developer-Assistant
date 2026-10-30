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
 * Driving a real Kimi Code CLI session from a script (scripts/eval-scenario.ts
 * with `--agent kimi`): where `kimi` is, the arguments of a one-prompt run, the
 * run itself, and the session log a run leaves behind. Nothing under
 * `npm test` imports it.
 *
 * A `kimi -p` run needs no approval: print mode runs under Kimi's `auto`
 * permission policy. Project-level MCP servers (`.kimi-code/mcp.json` in the
 * work directory) are read only in a trusted workspace; a headless run cannot
 * show the trust prompt, so `KIMI_CODE_TRUST_WORKSPACE=1` trusts it for the
 * one process (https://moonshotai.github.io/kimi-code/en/customization/mcp).
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Output kept from one run; beyond it the spawn fails with ENOBUFS. */
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024;

/** Kimi Code's data directory: `$KIMI_CODE_HOME`, by default `~/.kimi-code`. */
export function kimiHome(): string {
    return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

/**
 * The `kimi` to run: `$KIMI_BIN`, else the one the installer puts into the
 * data directory when it is there, else `kimi` on PATH.
 */
export function getKimiInvocation(): string {
    if (process.env.KIMI_BIN) {
        return process.env.KIMI_BIN;
    }
    const installed = path.join(kimiHome(), 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
    return fs.existsSync(installed) ? installed : 'kimi';
}

/** How a scripted run differs from the default. */
export interface KimiRunOptions {
    /** Load skills from this directory only, instead of the user's and the project's. */
    skillsDir?: string;
    /** A model alias of `config.toml`, instead of its `default_model`. */
    model?: string;
}

/** The arguments of a one-prompt run whose stdout is JSON lines. */
export function kimiBatchArgs(prompt: string, options: KimiRunOptions = {}): string[] {
    return [
        '-p', prompt, '--output-format', 'stream-json',
        ...(options.skillsDir ? ['--skills-dir', options.skillsDir] : []),
        ...(options.model ? ['-m', options.model] : []),
    ];
}

/** What a run left: its stdout (the JSON lines), stderr and exit status. */
export interface KimiRun {
    stdout: string;
    stderr: string;
    status: number | null;
}

/**
 * Run `kimi` in `workDir`, trusting that workspace for this process so that
 * its `.kimi-code/mcp.json` is read. A failed run still returns what it
 * printed; only a process that could not start throws.
 */
export function runKimi(command: string, args: string[], workDir: string): KimiRun {
    const finished = childProcess.spawnSync(command, args, {
        cwd: workDir,
        encoding: 'utf8',
        maxBuffer: OUTPUT_CAP_BYTES,
        env: { ...process.env, KIMI_CODE_TRUST_WORKSPACE: '1' },
    });
    if (finished.error) {
        throw finished.error;
    }
    return { stdout: finished.stdout, stderr: finished.stderr, status: finished.status };
}

/**
 * The log files of a session, one `wire.jsonl` per agent (the main agent and
 * each sub-agent), found by the session id a run's resume hint names under
 * `<kimiHome>/sessions/<workspace>/`. Empty when the session is not there.
 */
export function kimiSessionLogs(sessionId: string): string[] {
    const sessions = path.join(kimiHome(), 'sessions');
    const dirName = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
    const logs: string[] = [];
    for (const workspace of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
        const agents = path.join(sessions, workspace, dirName, 'agents');
        for (const agent of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
            const wire = path.join(agents, agent, 'wire.jsonl');
            if (fs.existsSync(wire)) {
                logs.push(wire);
            }
        }
    }
    return logs;
}

/**
 * The user-level instruction files Kimi Code reads in every project
 * (`$KIMI_CODE_HOME/AGENTS.md`, `~/.agents/AGENTS.md`) that exist: a run
 * without `--rules` is not free of rules while one of them carries them.
 */
export function kimiUserInstructionFiles(): string[] {
    const candidates = [path.join(kimiHome(), 'AGENTS.md'), path.join(os.homedir(), '.agents', 'AGENTS.md'), path.join(os.homedir(), '.agents', 'agents.md')];
    // On a file system that ignores case the last two are one file.
    return [...new Set(candidates.filter((file) => fs.existsSync(file)).map((file) => fs.realpathSync.native(file)))];
}
