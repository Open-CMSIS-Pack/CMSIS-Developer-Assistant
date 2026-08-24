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
 * Shared by scripts/test-skill-trigger.ts and scripts/eval-scenario.ts: run a
 * command, find the Copilot CLI, parse its `--output-format json` stream.
 */

import * as childProcess from 'node:child_process';

export function run(command: string, args: string[], options: childProcess.SpawnSyncOptions = {}): string {
    const result = childProcess.spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed with exit code ${result.status}\n` +
            `${result.stderr || result.stdout}`
        );
    }
    return String(result.stdout);
}

/** The CLI as an invocation; on Windows through PowerShell, which owns the shim. */
export function getCopilotInvocation(): { command: string; args: string[] } {
    if (process.platform !== 'win32') {
        return { command: 'copilot', args: [] };
    }
    const copilotPath = run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command copilot -ErrorAction Stop).Source']
    ).trim();
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', copilotPath] };
}

/** One JSON object per line; anything else (banners, blank lines) is dropped. */
export function parseEvents<T = unknown>(output: string): T[] {
    return output
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap(line => {
            try {
                return [JSON.parse(line) as T];
            } catch {
                return [];
            }
        });
}

/** The arguments every scripted, non-interactive Copilot run uses. */
export function copilotBatchArgs(workDir: string, prompt: string, extra: string[] = []): string[] {
    return [
        '-C', workDir,
        '-p', prompt,
        '--output-format', 'json',
        '--allow-all-tools',
        '--no-custom-instructions',
        '--no-remote',
        '--no-remote-export',
        '--log-level', 'none',
        ...extra,
    ];
}
