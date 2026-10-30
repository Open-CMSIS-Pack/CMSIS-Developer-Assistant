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
import * as fs from 'fs';
import * as path from 'path';
import { DEBUG_OPS, PACKDOCS_OPS, SERIAL_OPS } from '../core/opTable';
import {
    AUTOMATIC_CHOICE,
    WindowStatusState,
    durationText,
    renderWindowStatus,
    targetChoices,
    toolNameOf,
} from '../core/windowStatus';
import type { WindowRegistration } from '../utils/workspaceRegistry';
import { registeredTools } from './registeredTools';

const OWN_PID = 4711;
const OTHER_PID = 4712;
const NOW = 1_700_000_000_000;
const ENDPOINT = 'http://localhost:3001/mcp';

/** A router window at rest: no default target, no call yet, no session. */
function state(overrides: Partial<WindowStatusState> = {}): WindowStatusState {
    return { role: 'router', pid: OWN_PID, endpoint: ENDPOINT, running: [], sessions: [], now: NOW, ...overrides };
}

const tooltipLines = (overrides: Partial<WindowStatusState>): string[] => renderWindowStatus(state(overrides)).tooltip.split('\n');

/**
 * The status-bar item and the Select Target Window entries (#16), as pure
 * functions of a window's state.
 */
suite('Window status', () => {

    suite('the status-bar item', () => {

        test('the robot icon names a shipped font and a CSS-escaped character', () => {
            const repoRoot = path.resolve(__dirname, '..', '..', '..');
            const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
                contributes: { icons: Record<string, { default: { fontPath: string; fontCharacter: string } }> };
            };
            const icon = manifest.contributes.icons['cda-robot'];
            assert.deepStrictEqual(icon.default, {
                fontPath: './assets/icons/cda-icons.woff',
                fontCharacter: '\\E001',
            });
            const font = fs.readFileSync(path.resolve(repoRoot, icon.default.fontPath));
            assert.strictEqual(font.toString('ascii', 0, 4), 'wOFF');
        });

        test('a router at rest: its role, the endpoint, no default, no call yet, no session, and what a click does', () => {
            const view = renderWindowStatus(state());
            assert.strictEqual(view.text, '$(cda-robot) R');
            assert.deepStrictEqual(view.tooltip.split('\n'), [
                'CMSIS Developer Assistant',
                'Router window: serves MCP, forwards agent calls.',
                `MCP endpoint: ${ENDPOINT}`,
                'Default target windows: none, agents choose automatically',
                'Last agent call here: none yet',
                'Agent sessions: none open',
                '',
                'Click to choose the target window.',
            ]);
        });

        test('a worker names its role and lists no sessions', () => {
            const view = renderWindowStatus(state({ role: 'worker', sessions: undefined }));
            assert.strictEqual(view.text, '$(cda-robot) W');
            assert.deepStrictEqual(view.tooltip.split('\n').slice(0, 2), ['CMSIS Developer Assistant', 'Worker window: runs the calls the router forwards.']);
            assert.ok(!view.tooltip.includes('Agent sessions'), view.tooltip);
        });

        test('the default target: this window is marked in the text, another by name and pid, a closed one as not open', () => {
            const here = renderWindowStatus(state({ role: 'worker', defaultTarget: { name: 'blinky', pid: OWN_PID } }));
            assert.strictEqual(here.text, '$(cda-robot) W · default');
            assert.ok(here.tooltip.includes('\nDefault target windows: this window\n'), here.tooltip);
            const elsewhere = renderWindowStatus(state({ defaultTarget: { name: 'CDA-Testdrive', pid: OTHER_PID } }));
            assert.strictEqual(elsewhere.text, '$(cda-robot) R');
            assert.ok(elsewhere.tooltip.includes(`\nDefault target windows: CDA-Testdrive (pid ${OTHER_PID})\n`), elsewhere.tooltip);
            assert.ok(tooltipLines({ defaultTarget: { name: 'CDA-Testdrive' } }).includes('Default target windows: CDA-Testdrive (not open)'));
        });

        test('while agent calls run here the item spins and the tooltip names them; the last one ended is timed', () => {
            const view = renderWindowStatus(state({
                defaultTarget: { name: 'blinky', pid: OWN_PID },
                running: [{ tool: 'cmsis_action', since: NOW - 12_000 }, { tool: 'read_memory', since: NOW - 400 }],
                lastCall: { tool: 'get_session_status', at: NOW - 4_000 },
            }));
            assert.strictEqual(view.text, '$(cda-robot) R · default $(sync~spin)');
            const lines = view.tooltip.split('\n');
            assert.ok(lines.includes('Running here: cmsis_action for 12 s, read_memory for 0 s'), view.tooltip);
            assert.ok(lines.includes('Last agent call here: get_session_status 4 s ago'), view.tooltip);
            assert.ok(tooltipLines({ lastCall: { tool: 'flash', at: NOW - 3 * 60_000 } }).includes('Last agent call here: flash 3 min ago'));
            assert.strictEqual(view.warning, false);
        });

        test('a call past its fence asks for the warning background and says why in the tooltip (#14)', () => {
            const view = renderWindowStatus(state({
                role: 'worker',
                sessions: undefined,
                running: [
                    { tool: 'start_debugging', since: NOW - 200_000, fenced: true, waitsForUser: true },
                    { tool: 'continue_execution', since: NOW - 11_000, fenced: true, waitsForUser: false },
                    { tool: 'read_memory', since: NOW - 400 },
                ],
            }));
            assert.strictEqual(view.warning, true);
            assert.strictEqual(view.text, '$(cda-robot) W $(sync~spin)');
            // A picker or dialog only for the call that can open one.
            assert.ok(view.tooltip.split('\n').includes('Running here: start_debugging for 3 min (the agent was told it timed out; '
                + 'a picker or dialog here may be waiting for you), continue_execution for 11 s (the agent was told it timed out), '
                + 'read_memory for 0 s'), view.tooltip);
            assert.strictEqual(renderWindowStatus(state({ running: [{ tool: 'read_memory', since: NOW }] })).warning, false);
        });

        test('the router lists every session with the window it drives and why', () => {
            const lines = tooltipLines({
                sessions: [
                    { id: '3f2a91c0-1111-4000-8000-000000000000', client: 'claude-code', target: { pid: OWN_PID, name: 'alpha', reason: 'default' } },
                    { id: '88b1e0aa-2222-4000-8000-000000000000', client: 'codex', target: { pid: OTHER_PID, name: 'beta', reason: 'window-arg' } },
                    { id: '5c5c5c5c-3333-4000-8000-000000000000', target: { pid: OTHER_PID, name: 'beta', reason: 'pinned' } },
                    { id: '0d0d0d0d-4444-4000-8000-000000000000', client: 'cursor' },
                ],
            });
            const at = lines.indexOf('Agent sessions:');
            assert.deepStrictEqual(lines.slice(at, at + 5), [
                'Agent sessions:',
                '  • claude-code (3f2a91c0) → this window, default target',
                `  • codex (88b1e0aa) → beta (pid ${OTHER_PID}), named by a call`,
                `  • 5c5c5c5c → beta (pid ${OTHER_PID}), pinned`,
                '  • cursor (0d0d0d0d) → no window yet',
            ]);
            assert.strictEqual(lines[lines.length - 1], 'Click to choose the target window.');
        });

        test('the router lists the ten newest sessions and counts the earlier ones', () => {
            const sessions = Array.from({ length: 12 }, (_, n) => ({ id: `session-${String(n).padStart(2, '0')}` }));
            const lines = tooltipLines({ sessions });
            const at = lines.indexOf('Agent sessions:');
            assert.strictEqual(lines[at + 1], '  … and 2 earlier');
            assert.strictEqual(lines[at + 2], '  • session- → no window yet');
            assert.strictEqual(lines.filter((line) => line.startsWith('  • ')).length, 10);
        });

        test('durations read in seconds, then whole minutes, then whole hours', () => {
            assert.deepStrictEqual([0, 4_400, 59_000, 60_000, 3_599_000, 7_200_000, -5].map(durationText),
                ['0 s', '4 s', '59 s', '1 min', '59 min', '2 h', '0 s']);
        });
    });

    suite('tool names of ops', () => {

        test('every op of the table names a tool the server registers', () => {
            const repoRoot = path.resolve(__dirname, '..', '..', '..');
            const registered = new Set(registeredTools(repoRoot));
            const unnamed = [...DEBUG_OPS, ...SERIAL_OPS, ...PACKDOCS_OPS].filter((op) => !registered.has(toolNameOf(op)));
            assert.deepStrictEqual(unnamed, []);
        });

        test('regular names follow from the op, serial ones get their prefix, the rest come from the table', () => {
            assert.strictEqual(toolNameOf('handleReadMemory'), 'read_memory');
            assert.strictEqual(toolNameOf('handleListPorts'), 'serial_list_ports');
            assert.strictEqual(toolNameOf('handleCmsisCommand'), 'cmsis_action');
            assert.strictEqual(toolNameOf('handleOpenInUi'), 'serial_open_monitor');
        });
    });

    suite('the Select Target Window entries', () => {
        const window = (pid: number, name: string, overrides: Partial<WindowRegistration> = {}): WindowRegistration => ({
            pid, name, controlPort: 1, controlToken: 'never-shown', workspaceFolders: [`/work/${name}`], updatedAt: 0, ...overrides,
        });
        const windows = [
            window(OWN_PID, 'alpha', { role: 'router', hasActiveSession: true, activeConfigurationName: 'CMSIS Debug', cmsisProject: '/work/alpha/Blinky.csolution.yml' }),
            window(OTHER_PID, 'beta', { role: 'worker', workspaceFolders: ['/work/beta', '/work/shared'] }),
            window(4713, 'old', { workspaceFolders: [] }),
        ];

        test('every window with its folders and details, then Automatic, which is checked while no default is set', () => {
            const choices = targetChoices(windows, undefined, OWN_PID);
            assert.deepStrictEqual(choices.map(({ label, description, detail }) => ({ label, description, detail })), [
                { label: 'alpha', description: '/work/alpha', detail: `this window · router · debugging: CMSIS Debug · cmsis=Blinky.csolution.yml · pid ${OWN_PID}` },
                { label: 'beta', description: '/work/beta, /work/shared', detail: `worker · pid ${OTHER_PID}` },
                { label: 'old', description: '(no folder open)', detail: 'pid 4713' },
                { label: `$(check) ${AUTOMATIC_CHOICE}`, description: 'a file path, a pin or the one debugging window decides', detail: undefined },
            ]);
            assert.deepStrictEqual(choices.map((choice) => choice.window?.pid), [OWN_PID, OTHER_PID, 4713, undefined]);
        });

        test('the chosen window carries the check mark; a chosen window that is closed leaves every entry unchecked', () => {
            const checked = (choices: { label: string }[]): string[] => choices.filter((c) => c.label.startsWith('$(check) ')).map((c) => c.label);
            assert.deepStrictEqual(checked(targetChoices(windows, { name: 'beta', pid: OTHER_PID }, OWN_PID)), ['$(check) beta']);
            assert.deepStrictEqual(checked(targetChoices(windows, { name: 'gone' }, OWN_PID)), []);
        });
    });
});
