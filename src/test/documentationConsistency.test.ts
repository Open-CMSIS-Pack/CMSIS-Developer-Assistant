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
import { DatabaseSync } from 'node:sqlite';
import { sliceTopic } from '../core/instructionTopics';

/**
 * The debugging guide, the live-debugging procedure, the troubleshooting notes
 * and the bootstrap procedure each say what to do in a fault, an unresponsive
 * session, a serial monitor, the Cortex-M budget and a clean-up. Procedures
 * come from the pinned knowledge index; their sources live in the knowledge
 * base. Each check pins one of those facts in every source that states it:
 * the same next action, and no stale wording left behind.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
/** One line of text, so a sentence that a Markdown wrap split still matches. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const GUIDE = read('docs', 'agent-resources', 'debug_instructions.md');
const EMBEDDED = read('docs', 'agent-resources', 'troubleshooting', 'embedded.md');
const coreIndex = path.join(REPO_ROOT, 'resources', 'knowledge', 'core.db');
const procedures = new Map<string, string>();

/** The procedure text that agents actually receive from the pinned index. */
function procedure(name: string): string {
    const body = procedures.get(name);
    assert.ok(body, `Missing knowledge procedure proc-${name}`);
    return body;
}

let live = '';
let bootstrap = '';

suite('Documentation consistency across the guide, the live procedure and the notes', () => {
    suiteSetup(function () {
        if (!fs.existsSync(coreIndex)) {
            this.skip(); // Fetch the pinned index to run this integration check.
        }
        const db = new DatabaseSync(coreIndex, { readOnly: true });
        try {
            for (const name of ['cmsis-debug-live', 'cmsis-bootstrap', 'fvp-debug-setup', 'debugger-troubleshooting']) {
                const row = db.prepare('SELECT body FROM nodes WHERE id = ?').get(`proc-${name}`);
                assert.ok(row && typeof row.body === 'string' && row.body.length > 0, `Missing knowledge procedure proc-${name}`);
                procedures.set(name, row.body);
            }
        } finally {
            db.close();
        }
        live = procedure('cmsis-debug-live');
        bootstrap = procedure('cmsis-bootstrap');
    });

    test('the Cortex-M comparator counts agree in every source, and none groups M4 with M7', () => {
        assert.match(sliceTopic(GUIDE, 'breakpoints'), /\|\s*Cortex-M7\s*\|\s*8\s*\|/, 'the guide table gives M7 eight comparators');
        assert.ok(flat(EMBEDDED).includes('M3/M4: 6, M7/M33/M55/M85: 8'), 'the troubleshooting notes give the same counts');
        assert.ok(flat(live).includes('**6** on M3/M4, **8** on M7/M33/M55/M85'), 'the live procedure gives the same counts');
        for (const [name, text] of [['the guide', GUIDE], ['the live procedure', live], ['the troubleshooting notes', EMBEDDED]]) {
            assert.ok(!/M4\/M7/.test(text), `${name} still groups M4 with M7`);
        }
    });

    test('a fault is read with diagnose_fault first, in the overview, the faults topic and the live procedure', () => {
        assert.ok(!/get_fault_info`? first/.test(GUIDE), 'the guide still puts get_fault_info first');
        assert.ok(sliceTopic(GUIDE, 'overview').includes('`diagnose_fault` once stopped (topic `faults`)'),
            'the served overview names diagnose_fault for a fault');
        assert.ok(flat(sliceTopic(GUIDE, 'faults')).includes('`diagnose_fault` is the first pass'),
            'the faults topic makes diagnose_fault the first pass');
        assert.ok(!/then `get_fault_info`/.test(EMBEDDED), 'the troubleshooting notes still send a fault to get_fault_info first');
        assert.ok(EMBEDDED.includes('`diagnose_fault` — did the target crash?'), 'the first-line sweep uses diagnose_fault');
        assert.ok(flat(live).includes('`diagnose_fault` does the whole first pass in one call'), 'the live procedure names diagnose_fault first');
    });

    test('an unresponsive session keeps the fault state before any restart, and says what a restart loses', () => {
        const session = flat(sliceTopic(GUIDE, 'session'));
        const preserve = session.indexOf('Reconnect without a reset first');
        const restart = session.indexOf('`restart_debugging` and `cmsis_action load_and_debug` re-flash and reset');
        assert.ok(preserve >= 0 && restart > preserve, 'the guide table reconnects without a reset before it restarts');
        assert.ok(session.includes('lose that state'), 'the guide table says that a restart loses the fault state');
        const faults = flat(sliceTopic(GUIDE, 'faults'));
        assert.ok(faults.includes('The fault state survives.'), 'the faults topic says which reconnects keep the fault state');
        assert.ok(faults.includes('clears the fault status'), 'the faults topic says that a reset clears the fault status');
        assert.ok(flat(live).includes('keeping the fault state for as long as you can'), 'the live procedure keeps the fault state');
        assert.ok(flat(live).includes('clears the fault status'), 'the live procedure says that a reset clears the fault status');
        assert.ok(flat(EMBEDDED).includes('which clears the fault status: record the fault first'),
            'the troubleshooting notes say to record the fault before a reset');
    });

    test('an attach session reconnects to a GDB server that lives as long as its CMSIS Run task, in every source', () => {
        for (const [name, text] of [['the faults topic', flat(sliceTopic(GUIDE, 'faults'))], ['the live procedure', flat(live)], ['the troubleshooting notes', flat(EMBEDDED)]]) {
            assert.ok(text.includes('lives as long as its CMSIS Run task'), `${name} says how long the attach session's GDB server lives`);
            assert.ok(text.includes('could not connect'), `${name} says what a failed attach means`);
            assert.ok(!text.includes('GDB server that keeps running'), `${name} still says the server keeps running`);
        }
    });

    test('an Arm FVP is stopped by a breakpoint, never by a pause, in the guide and the procedures that say how to halt', () => {
        assert.ok(flat(sliceTopic(GUIDE, 'inspection')).includes('An Arm FVP ignores the pause while the model runs'), 'the guide');
        assert.ok(flat(live).includes('An Arm FVP ignores the pause'), 'the live procedure');
        assert.ok(flat(procedure('fvp-debug-setup')).includes('The running model ignores `pause_execution`'), 'the FVP set-up');
        assert.ok(flat(procedure('debugger-troubleshooting')).includes('on an Arm FVP, which ignores `pause_execution`'),
            'the troubleshooting procedure');
    });

    test('the clean-up contract names the same four parts in the guide and in the live procedure', () => {
        for (const [name, text] of [['the guide', flat(sliceTopic(GUIDE, 'session'))], ['the live procedure', flat(live)]]) {
            assert.ok(text.includes('**Target:** running when you finish'), `${name} names the target state at the end`);
            assert.ok(text.includes('**Breakpoints:**'), `${name} names the breakpoint state at the end`);
            assert.ok(text.includes('**Debug session:**') || text.includes('**Session:**') || text.includes('**Probe:**'),
                `${name} names the session and probe state`);
            assert.ok(text.includes('Read-only checks (`get_session_status`,'), `${name} keeps health checks out of the clean-up`);
            assert.ok(!text.includes('`stop_debugging` when done'), `${name} still stops the session unconditionally`);
            assert.ok(!text.includes('call `clear_all_breakpoints` before concluding'), `${name} still clears every breakpoint unconditionally`);
        }
    });

    test('between phases a source removes the breakpoints the investigation set, never every breakpoint of the window', () => {
        for (const [name, text] of [['the guide', GUIDE], ['the live procedure', live], ['the troubleshooting notes', EMBEDDED]]) {
            assert.ok(!/`clear_all_breakpoints` (between|to free|when you change)/.test(flat(text)),
                `${name} still recommends clear_all_breakpoints between phases, which deletes the user's breakpoints too`);
            assert.ok(flat(text).includes('`remove_breakpoint`'), `${name} names remove_breakpoint for the breakpoints the investigation set`);
        }
    });

    test('serial subscription is capability-dependent in the guide and the live procedure, and no document says it taps the monitor', () => {
        assert.ok(flat(sliceTopic(GUIDE, 'inspection')).includes('capability-dependent: API version 0 has none'),
            'the guide says subscription depends on the monitor API');
        assert.ok(flat(live).includes('capability-dependent: API version 0 has none'), 'the live procedure says the same');
        assert.ok(!/\btaps\b/.test(GUIDE) && !/\btaps\b/.test(live), 'a source still says that subscription taps the monitor');
    });

    test('the bootstrap procedure hands over by knowledge procedure, not by an installed skill', () => {
        assert.ok(!bootstrap.includes('installed next to this one'), 'the bootstrap skill still says its siblings are installed');
        assert.ok(!bootstrap.includes('Configure Agent'), 'the bootstrap skill still asks the user to reinstall skills');
        assert.ok(flat(bootstrap).includes('`proc-<name>` of the knowledge index'), 'the bootstrap skill names the knowledge procedures');
        assert.ok(!sliceTopic(GUIDE, 'bootstrap').includes('the skill `cmsis-bootstrap`'), 'the guide still names the cmsis-bootstrap skill');
        assert.ok(sliceTopic(GUIDE, 'bootstrap').includes('`proc-cmsis-bootstrap`'), 'the guide names the bootstrap procedure by its ID');
    });
});
