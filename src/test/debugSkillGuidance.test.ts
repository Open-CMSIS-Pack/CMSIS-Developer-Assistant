// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The skill's frontmatter description and the MCP `instructions` block are
 * what decide whether an agent reaches for the debugger at all, or starts by
 * sprinkling printf over the firmware. Both are prose, so they drift without
 * anything failing. These tests pin the trigger vocabulary and the
 * debugger-first wording so a later edit that softens or drops them is caught
 * here rather than in someone's Copilot session.
 */
suite('Debug skill guidance', () => {

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const skill = fs.readFileSync(path.join(repoRoot, 'skills', 'cmsis-debug-live', 'SKILL.md'), 'utf8');
    const serverSource = fs.readFileSync(path.join(repoRoot, 'src', 'debugMCPServer.ts'), 'utf8');
    const instructionsDoc = fs.readFileSync(
        path.join(repoRoot, 'docs', 'agent-resources', 'debug_instructions.md'), 'utf8');
    const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? '';

    /** assert.match, but without dumping a 60 kB source file into the failure message. */
    const matches = (text: string, re: RegExp, what: string) =>
        assert.ok(re.test(text), `${what} does not match ${re}`);
    const doesNotMatch = (text: string, re: RegExp, what: string) =>
        assert.ok(!re.test(text), `${what} unexpectedly matches ${re}`);

    test('skill metadata covers the common runtime investigation triggers', () => {
        for (const trigger of [
            'runtime bugs',
            'faults',
            'crashes',
            'hangs',
            'failing tests',
            'wrong/null values',
            'unexpected output',
        ]) {
            assert.ok(description.includes(trigger), `Missing skill trigger: ${trigger}`);
        }
    });

    test('skill metadata prefers live inspection over temporary firmware logging', () => {
        matches(description, /whenever live inspection is practical/i, 'description');
        matches(description, /instead of adding temporary printf\/UART logging, LED toggles, or console output/i, 'description');
        doesNotMatch(description, /\bMUST use first\b/, 'description');
    });

    test('the skill body carries the debugger-first rule', () => {
        matches(skill, /^## Debugger first/m, 'skill');
        matches(skill, /add_logpoint.*still stops the core/s, 'skill');
    });

    test('MCP instructions say to invoke the skill first and explain why', () => {
        matches(serverSource, /invoke the "cmsis-debug-live" Agent Skill first/i, 'serverSource');
        matches(serverSource, /breakpoint strategy/i, 'serverSource');
        matches(serverSource, /step-and-inspect/i, 'serverSource');
        matches(serverSource, /root-cause guidance/i, 'serverSource');
    });

    test('MCP instructions keep a path for harnesses without skills', () => {
        // Copilot Chat reads MCP tools, not ~/.agents/skills — see
        // CHANGES-VS-UPSTREAM.md §9 for why get_debug_instructions is kept.
        matches(serverSource, /get_debug_instructions instead/, 'serverSource');
    });

    test('start_debugging points agents to the skill', () => {
        matches(serverSource, /Invoke the "cmsis-debug-live" skill first\./, 'serverSource');
    });

    test('the get_debug_instructions document carries the same debugger-first rule', () => {
        // The skill and the tool-served guide overlap on purpose and must stay
        // consistent (skills/cmsis-debug-live/README.md).
        matches(instructionsDoc, /^## .*DEBUGGER FIRST/m, 'instructionsDoc');
        matches(instructionsDoc, /printf/, 'instructionsDoc');
    });
});
