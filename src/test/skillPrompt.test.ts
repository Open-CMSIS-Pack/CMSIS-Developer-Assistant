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

import * as assert from 'assert';
import { AgentInfo, agentConfigHasServer } from '../utils/agentConfigurationManager';
import {
    SKILLS_PROMPT_INTERVAL_MS,
    SkillPromptContext,
    SkillPromptSuppressedReason,
    decideSkillPrompt,
    joinNames,
    skillPromptMessage,
} from '../utils/skillPrompt';

/**
 * The install prompt is a notification that interrupts the user, so when it
 * fires matters as much as what it says. The decision is pure; these tests
 * pin every reason it stays quiet, the order those reasons win in, and the
 * monthly snooze boundary.
 */
suite('Skill install prompt', () => {

    const now = 1_700_000_000_000;
    const base: SkillPromptContext = {
        promptEnabled: true,
        packEnabled: true,
        firstRunPending: false,
        hostManaged: false,
        agentsWithServer: ['Claude Code'],
        packSkillSelected: false,
        lastShownAt: undefined,
        now,
    };

    test('shows when an agent is registered, no pack skill is selected, and it was never shown', () => {
        assert.deepStrictEqual(decideSkillPrompt(base), { show: true });
    });

    test('every reason to stay quiet, in priority order', () => {
        const cases: [Partial<SkillPromptContext>, SkillPromptSuppressedReason][] = [
            [{ promptEnabled: false }, 'disabled'],
            [{ packEnabled: false }, 'pack-disabled'],
            [{ firstRunPending: true }, 'first-run-pending'],
            [{ hostManaged: true }, 'host-managed'],
            [{ agentsWithServer: [] }, 'no-agent'],
            [{ packSkillSelected: true }, 'already-selected'],
            [{ lastShownAt: now - 1 }, 'snoozed'],
        ];
        for (const [override, reason] of cases) {
            assert.deepStrictEqual(decideSkillPrompt({ ...base, ...override }), { show: false, reason }, reason);
        }
        // The most fundamental blocker is the one reported.
        assert.deepStrictEqual(
            decideSkillPrompt({ ...base, promptEnabled: false, packEnabled: false, agentsWithServer: [], lastShownAt: now }),
            { show: false, reason: 'disabled' });
        assert.deepStrictEqual(
            decideSkillPrompt({ ...base, agentsWithServer: [], packSkillSelected: true }),
            { show: false, reason: 'no-agent' });
    });

    test('monthly: exactly 30 days after the last prompt it shows again, a millisecond earlier it does not', () => {
        assert.deepStrictEqual(decideSkillPrompt({ ...base, lastShownAt: now - SKILLS_PROMPT_INTERVAL_MS }), { show: true });
        assert.deepStrictEqual(
            decideSkillPrompt({ ...base, lastShownAt: now - SKILLS_PROMPT_INTERVAL_MS + 1 }),
            { show: false, reason: 'snoozed' });
        assert.strictEqual(SKILLS_PROMPT_INTERVAL_MS, 30 * 24 * 60 * 60 * 1000);
    });

    test('names the agents the skills would be installed for', () => {
        assert.strictEqual(joinNames([]), '');
        assert.strictEqual(joinNames(['Codex']), 'Codex');
        assert.strictEqual(joinNames(['Claude Code', 'Codex']), 'Claude Code and Codex');
        assert.strictEqual(joinNames(['Cline', 'Claude Code', 'Codex']), 'Cline, Claude Code and Codex');
        const message = skillPromptMessage(['Claude Code', 'Codex']);
        assert.match(message, /^CMSIS Developer Assistant: install the CMSIS AI Skills for Claude Code and Codex\?/);
        assert.match(message, /slash commands/);
    });

    suite('agentConfigHasServer', () => {
        const json: AgentInfo = {
            id: 'claude-code', name: 'claude-code', displayName: 'Claude Code',
            configPath: '/x/.claude.json', configFormat: 'json', mcpServerFieldName: 'mcpServers',
        };
        const toml: AgentInfo = {
            id: 'codex', name: 'codex', displayName: 'Codex',
            configPath: '/x/config.toml', configFormat: 'toml',
        };

        test('JSON: the current server key under the agent\'s field counts, the legacy key alone does not', () => {
            assert.strictEqual(agentConfigHasServer(json, '{"mcpServers":{"cmsis-developer-assistant":{"url":"http://localhost:3001/mcp"}},"other":1}'), true);
            assert.strictEqual(agentConfigHasServer(json, '{"mcpServers":{"cmsis-debugmcp":{"url":"http://localhost:3001/mcp"}}}'), false);
            assert.strictEqual(agentConfigHasServer(json, '{"mcpServers":{}}'), false);
            assert.strictEqual(agentConfigHasServer(json, '{"servers":{"cmsis-developer-assistant":{}}}'), false, 'wrong field');
        });

        test('JSON: unparseable or non-object content reads as not registered', () => {
            assert.strictEqual(agentConfigHasServer(json, '{ not json'), false);
            assert.strictEqual(agentConfigHasServer(json, ''), false);
            assert.strictEqual(agentConfigHasServer(json, 'null'), false);
            assert.strictEqual(agentConfigHasServer(json, '[1,2]'), false);
        });

        test('TOML: the [mcp_servers.<key>] section header counts, the legacy section alone does not', () => {
            assert.strictEqual(agentConfigHasServer(toml, 'model = "x"\n\n[mcp_servers.cmsis-developer-assistant]\nurl = "http://localhost:3001/mcp"\n'), true);
            assert.strictEqual(agentConfigHasServer(toml, '  [mcp_servers.cmsis-developer-assistant]  # ours\r\nurl = "u"\r\n'), true);
            assert.strictEqual(agentConfigHasServer(toml, '[mcp_servers.cmsis-debugmcp]\nurl = "u"\n'), false);
            assert.strictEqual(agentConfigHasServer(toml, '[mcp_servers.cmsis-developer-assistant-other]\nurl = "u"\n'), false);
            assert.strictEqual(agentConfigHasServer(toml, ''), false);
        });
    });
});
