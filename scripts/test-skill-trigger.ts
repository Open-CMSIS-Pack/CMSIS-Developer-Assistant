#!npx tsx

// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

/**
 * Opt-in, live evaluation of the cmsis-debug-live skill's *trigger*: launch a
 * real Copilot CLI session in a scratch worktree that carries only the skill,
 * give it an embedded "it does not work on the board" prompt, and assert from
 * the JSON tool events that the first tool call is the skill.
 *
 * Deliberately not part of `npm test`: it needs an authenticated Copilot CLI,
 * spends AI credits, and a model's first move is not deterministic.
 *
 *   npm run test:skill-trigger-agent
 *   npm run test:skill-trigger-agent -- "The UART stops transmitting after the first DMA transfer"
 */

import * as assert from 'node:assert';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copilotBatchArgs, getCopilotInvocation, parseEvents, run as runCommand } from './lib/copilotCli.js';

const SKILL_NAME = 'cmsis-debug-live';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPrompt =
    'The firmware HardFaults a few seconds after boot. adc_buffer[0] reads 0 on the board ' +
    'but has the right value on the FVP. Find out why.';
const prompt = process.argv.slice(2).join(' ') || defaultPrompt;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-skill-eval-'));
const worktreePath = path.join(tempRoot, 'worktree');

interface ToolEvent {
    type?: string;
    data?: { toolName?: string; arguments?: { skill?: string } };
}

const run = (command: string, args: string[], options: childProcess.SpawnSyncOptions = {}) =>
    runCommand(command, args, { cwd: repoRoot, ...options });

try {
    run('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD']);

    const sourceSkillPath = path.join(repoRoot, 'skills', SKILL_NAME);
    const projectSkillPath = path.join(worktreePath, '.agents', 'skills', SKILL_NAME);
    fs.mkdirSync(path.dirname(projectSkillPath), { recursive: true });
    fs.cpSync(sourceSkillPath, projectSkillPath, { recursive: true });

    const copilot = getCopilotInvocation();
    const output = run(copilot.command, [...copilot.args, ...copilotBatchArgs(worktreePath, prompt)], { cwd: worktreePath });

    const toolCalls = parseEvents<ToolEvent>(output)
        .filter(event => event.type === 'tool.execution_start')
        .map(event => event.data);
    const firstToolCall = toolCalls[0];

    assert.ok(firstToolCall, 'Copilot did not execute any tool');
    assert.strictEqual(firstToolCall.toolName, 'skill',
        `Expected the first tool to be skill, got ${firstToolCall.toolName}`);
    assert.strictEqual(firstToolCall.arguments?.skill, SKILL_NAME,
        `Expected ${SKILL_NAME}, got ${JSON.stringify(firstToolCall.arguments)}`);

    console.log(`Prompt: ${prompt}`);
    console.log(`PASS: Copilot invoked ${SKILL_NAME} as its first tool call.`);
    console.log(`Next tool: ${toolCalls[1]?.toolName ?? '<none>'}`);
} finally {
    childProcess.spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, encoding: 'utf8' });
    childProcess.spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' });
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
