#!npx tsx
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
 * Does the cmsis-help skill trigger? A live check against a real
 * GitHub Copilot CLI:
 *
 *   npm run test:skill-trigger-agent
 *   npm run test:skill-trigger-agent -- "The UART stops transmitting after the first DMA transfer"
 *
 * A scratch git worktree of HEAD gets the skill from the working tree
 * (uncommitted edits included) as a project skill. One non-interactive
 * Copilot session then runs there with a "it does not work on the board"
 * prompt, and the check passes when the agent's very first tool call loads
 * the skill. The worktree and its temporary directory are removed however
 * the run ends; a failure is thrown and ends the process non-zero.
 *
 * Not part of `npm test`: it needs an authenticated Copilot CLI, costs AI
 * credits, and a model's first move is not deterministic. The wording the
 * trigger depends on is pinned by src/test/debugSkillGuidance.test.ts.
 */

import * as assert from 'node:assert';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copilotBatchArgs, getCopilotInvocation, parseEvents, run } from './lib/copilotCli.js';

/** The part of a Copilot CLI event this check reads. */
interface ToolEvent {
    type?: string;
    data?: { toolName?: string; arguments?: { skill?: string } };
}

const SKILL = 'cmsis-help';
const DEFAULT_PROMPT = 'The firmware HardFaults a few seconds after boot. adc_buffer[0] reads 0 on the board but has the right value on the FVP. Find out why.';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliWords = process.argv.slice(2);
const prompt = cliWords.length > 0 ? cliWords.join(' ') : DEFAULT_PROMPT;

// Made before anything can fail, so the cleanup below always has a directory to remove.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-skill-eval-'));
const worktree = path.join(scratch, 'worktree');

try {
    run('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: repository });

    const installedSkill = path.join(worktree, '.agents', 'skills', SKILL);
    fs.mkdirSync(path.dirname(installedSkill), { recursive: true });
    fs.cpSync(path.join(repository, 'skills', SKILL), installedSkill, { recursive: true });

    const copilot = getCopilotInvocation();
    const stdout = run(copilot.command, [...copilot.args, ...copilotBatchArgs(worktree, prompt)], { cwd: worktree });
    const toolCalls = parseEvents<ToolEvent>(stdout)
        .filter((event) => event.type === 'tool.execution_start')
        .map((event) => event.data);

    const [opening, following] = toolCalls;
    assert.ok(opening, 'Copilot finished without calling any tool');
    assert.strictEqual(opening.toolName, 'skill',
        `the opening tool call should load a skill, but it was ${opening.toolName}`);
    assert.strictEqual(opening.arguments?.skill, SKILL,
        `the skill tool loaded something other than ${SKILL}: ${JSON.stringify(opening.arguments)}`);

    console.log(`prompt used: ${prompt}`);
    console.log(`PASS - the ${SKILL} skill was Copilot's opening tool call`);
    console.log(`tool called after it: ${following?.toolName ?? '<none>'}`);
} finally {
    // Best effort, results ignored: the worktree may not even exist when `git worktree add` failed.
    childProcess.spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repository });
    childProcess.spawnSync('git', ['worktree', 'prune'], { cwd: repository });
    fs.rmSync(scratch, { recursive: true, force: true });
}
