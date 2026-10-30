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

// Executor characterization cases (issue #53).
//
// Runs the cases listed in docs/provenance/specs/debuggingExecutor.md against
// out/src/debuggingExecutor.js with scripted fake debug sessions: DAP request
// shapes, fallbacks, timeouts, reset verification and the memory-read ladder.
// Complements dap-scenarios.js, which drives the executor through the handler.
//
//   node test/transport/executor-cases.js
const path = require('path');
const stub = require('./vscode-stub.js');

const factories = [];
stub.debug.registerDebugAdapterTrackerFactory = (_t, f) => { factories.push(f); return { dispose() {} }; };
stub.debug.startDebugging = async () => true;
stub.debug.stopDebugging = async () => {};
const addLog = [];
const removeLog = [];
stub.debug.addBreakpoints = (bps) => { addLog.push(bps); stub.debug.breakpoints = [...stub.debug.breakpoints, ...bps]; };
stub.debug.removeBreakpoints = (bps) => { removeLog.push(bps); stub.debug.breakpoints = stub.debug.breakpoints.filter((b) => !bps.includes(b)); };
const commandLog = [];
stub.commands.executeCommand = async (command, ...args) => { commandLog.push({ command, args }); return stub.commandHandlers[command]?.(...args); };

const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');
const tracker = require(path.join(OUT, 'utils', 'sessionStateTracker.js'));
tracker.registerSessionStateTracker({ subscriptions: [] });
const { DebuggingExecutor, SERVER_VERSION, DEFAULT_HARDWARE_TIMEOUTS } = require(path.join(OUT, 'debuggingExecutor.js'));
const { HardwareTimeoutError } = require(path.join(OUT, 'utils', 'timeout.js'));
const { Budgets } = require(path.join(OUT, 'executor', 'common.js'));
const { unsupportedResetDetail } = require(path.join(OUT, 'core', 'resetAssist.js'));
const pkg = require(path.resolve(__dirname, '..', '..', 'package.json'));

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
    if (cond) { passes++; console.log(`  ok   ${name}`); }
    else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const le = (w) => { const b = Buffer.alloc(4); b.writeUInt32LE(w >>> 0); return b; };
/** What readMemory returned, as plain data: how far after the address its bytes begin, and the bytes. */
const plain = (read) => ({ offset: read?.offset, bytes: read?.bytes ? [...read.bytes] : undefined });

let seq = 0;
const trackers = [];
/** A fake session; `answer(command, args)` returns a promise or value. */
function makeSession(answer, config = { type: 'gdbtarget', name: 'Cfg' }, name = 'S') {
    const calls = [];
    const session = {
        id: `s${++seq}`, name, type: config.type, configuration: config,
        customRequest(command, args) {
            calls.push({ command, json: JSON.stringify(args), args });
            try {
                const r = answer(command, args, calls);
                return r instanceof Promise ? r : Promise.resolve(r);
            } catch (e) { return Promise.reject(e); }
        },
    };
    return { session, calls };
}
function focusOn(session) { stub.debug.activeDebugSession = session; }
function trackerFor(session) {
    const t = factories[0].createDebugAdapterTracker(session);
    trackers.push(t);
    return t;
}
function event(t, ev, body = {}) { t.onDidSendMessage({ type: 'event', event: ev, body }); }
function reset() {
    for (const t of trackers.splice(0)) { t.onWillStopSession(); }
    stub.debug.activeDebugSession = undefined;
    stub.debug.activeStackItem = undefined;
    stub.debug.breakpoints = [];
    addLog.length = 0; removeLog.length = 0; commandLog.length = 0;
    stub.commandHandlers = {};
    stub.workspace.workspaceFolders = [];
    stub.workspace.openTextDocument = async () => { throw new Error('not stubbed'); };
}
async function rejects(p) { try { await p; return undefined; } catch (e) { return e; } }

async function main() {
    console.log(`SERVER_VERSION ${SERVER_VERSION} package ${pkg.version}`);
    check('SERVER_VERSION is package.json\'s version', SERVER_VERSION === pkg.version);
    check('DEFAULT_HARDWARE_TIMEOUTS', eq(DEFAULT_HARDWARE_TIMEOUTS, { dapRequestMs: 10000, memoryReadMs: 30000 }));

    // Budgets
    const bud = new Budgets({ dapRequestMs: 80, memoryReadMs: 30000 });
    check('budget 0/-1/NaN/undefined/null → fallback', [0, -1, NaN, undefined, null, Infinity].every((v) => bud.request(v) === 80));
    const big = new Budgets({ dapRequestMs: 90000, memoryReadMs: 30000 });
    check('fallback not capped, override capped', big.request() === 90000 && big.request(90000) === 60000 && big.request(5) === 5);
    check('probe = min(dap, 3000)', bud.probe() === 80 && big.probe() === 3000);
    check('stopWait default 60000, capped', bud.stopWait() === 60000 && bud.stopWait(70000) === 60000 && bud.stopWait(1234) === 1234);
    check('operation', bud.operation() === 30000 && bud.operation(100) === 100);

    // ── Run control ──
    reset();
    {
        const { session, calls } = makeSession(() => undefined);
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 7, frameId: 70 };
        const ex = new DebuggingExecutor();
        await ex.stepOver();
        check('RC1 stepOver with frame item threadId 7', calls.length === 1 && calls[0].command === 'next' && calls[0].json === '{"threadId":7}' && commandLog.length === 0, calls);
        stub.debug.activeStackItem = undefined;
        calls.length = 0;
        await ex.stepOver();
        check('RC1 no stack item → threadId 1', calls[0].json === '{"threadId":1}');
    }
    reset();
    {
        const pairs = [['stepOver', 'next', 'workbench.action.debug.stepOver'], ['stepInto', 'stepIn', 'workbench.action.debug.stepInto'],
            ['stepOut', 'stepOut', 'workbench.action.debug.stepOut'], ['continue', 'continue', 'workbench.action.debug.continue'],
            ['pause', 'pause', 'workbench.action.debug.pause']];
        for (const [method, dap, ui] of pairs) {
            reset();
            const { session, calls } = makeSession(() => { throw new Error('Cannot execute this command while the target is running'); }, { type: 'python', name: 'Py' });
            focusOn(session);
            const ex = new DebuggingExecutor();
            const r = await rejects(ex[method]());
            check(`RC2 ${method} falls back to ${ui} on other adapters`, r === undefined && calls.length === 1 && calls[0].command === dap
                && commandLog.length === 1 && commandLog[0].command === ui && commandLog[0].args.length === 0, { r: String(r), commandLog });
        }
        for (const [method, dap] of pairs) {
            reset();
            const { session, calls } = makeSession(() => { throw new Error('Cannot execute this command while the target is running.\nUse the "interrupt" command to stop the target\nand then try again.'); });
            focusOn(session);
            const r = await rejects(new DebuggingExecutor()[method]());
            check(`RC2 ${method} on gdbtarget rejects TARGET_RUNNING, no UI command (#13)`, r && r.code === 'TARGET_RUNNING'
                && r.message === `GDB rejected '${dap}': the target is running.` && r.hint === 'pause_execution first, or wait_for_stop if a stop is expected.'
                && calls.length === 1 && commandLog.length === 0, { r: r && `${r.code} ${r.message}`, commandLog });
        }
        reset();
        {
            const { session } = makeSession(() => { throw new Error('Thread 2 does not exist'); });
            focusOn(session);
            const r = await rejects(new DebuggingExecutor().stepInto());
            check('RC2 other GDB refusal on gdbtarget → INTERNAL with the text', r && r.code === 'INTERNAL' && r.message === "GDB rejected 'stepIn': Thread 2 does not exist" && commandLog.length === 0, r && r.message);
        }
        reset();
        const { session } = makeSession(() => { throw new Error('x'); }, { type: 'python', name: 'Py' });
        focusOn(session);
        stub.commandHandlers['workbench.action.debug.stepOver'] = () => { throw new Error('ui boom'); };
        const r = await rejects(new DebuggingExecutor().stepOver());
        check('RC2 UI command rejection propagates unwrapped', r && r.message === 'ui boom', String(r));
    }
    reset();
    {
        const { session } = makeSession(never);
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 80 });
        const e1 = await rejects(ex.stepOver(50));
        check('RC3 stepOver(50) → HardwareTimeoutError 50 DAP next', e1 instanceof HardwareTimeoutError && e1.timeoutMs === 50 && e1.operation === 'DAP next' && commandLog.length === 0, String(e1));
        for (const v of [0, -1, NaN]) {
            const e = await rejects(ex.stepOver(v));
            check(`RC3 stepOver(${v}) → 80`, e instanceof HardwareTimeoutError && e.timeoutMs === 80);
        }
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        let threw = false;
        try { ex.armStopWaiter(1000); } catch { threw = true; }
        check('RC4 armStopWaiter throws synchronously without a session', threw);
        check('RC4 stepOver rejects', (await rejects(ex.stepOver())) instanceof Error);
        check('RC4 waitForStop rejects', (await rejects(ex.waitForStop())) instanceof Error);
        const e = await rejects(ex.getDeviceInfo());
        console.log(`       S1 text: ${e.message}`);
    }
    reset();
    {
        const { session } = makeSession(() => undefined);
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 5 };
        const ex = new DebuggingExecutor();
        check('RC5 already stopped', eq(await ex.waitForStop(), { kind: 'already-stopped', reason: null }));
        const t = trackerFor(session);
        event(t, 'continued', { threadId: 1 });
        const p = ex.waitForStop(2000);
        setTimeout(() => event(t, 'stopped', { reason: 'breakpoint', threadId: 3 }), 20);
        check('RC5 stopped after continued', eq(await p, { kind: 'stopped', reason: 'breakpoint', threadId: 3 }));
    }
    reset();
    {
        check('RC7 focus watch without a session: false at once', (await new DebuggingExecutor().watchFrameFocus().selected(5000)) === false);
        const { session } = makeSession(() => undefined);
        focusOn(session);
        trackerFor(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 5 };
        const ex = new DebuggingExecutor();
        const watch = ex.watchFrameFocus();
        const t0 = Date.now();
        check('RC7 the frame focused when the watch was taken is not the stop\'s', (await watch.selected(60)) === false && Date.now() - t0 >= 50);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 5 };
        check('RC7 a new frame object of the session is', (await watch.selected(60)) === true);
    }
    reset();
    {
        check('RC8 start focus watch without a session: none at once', (await new DebuggingExecutor().watchStartFocus().settled(5000)) === 'none');
        stub.debug.activeStackItem = undefined;
        const ex = new DebuggingExecutor();
        const watch = ex.watchStartFocus();
        const { session } = makeSession(() => undefined);
        focusOn(session);
        const t = trackerFor(session);
        event(t, 'continued', { threadId: 1 });
        check('RC8 a session that runs: running at once', (await watch.settled(5000)) === 'running');
        event(t, 'stopped', { reason: 'breakpoint', threadId: 1 });
        const t0 = Date.now();
        check('RC8 a halted session without a frame: none at the bound', (await watch.settled(60)) === 'none' && Date.now() - t0 >= 50);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 7 };
        check('RC8 a halted session with its frame: selected', (await watch.settled(60)) === 'selected');
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        const how = await ex.restart();
        check('RC6 restart without session', commandLog.length === 1 && commandLog[0].command === 'workbench.action.debug.restart' && commandLog[0].args.length === 0
            && eq(how, { via: 'workbench' }), how);
        stub.commandHandlers['workbench.action.debug.restart'] = () => { throw new Error('nope'); };
        const e = await rejects(ex.restart());
        console.log(`       S6 text: ${e && e.message}`);
    }
    reset();
    {
        const { session } = makeSession(() => undefined, { type: 'python', name: 'Py' });
        focusOn(session);
        await new DebuggingExecutor().restart();
        check('RC6 restart of another adapter: the workbench command', commandLog.length === 1 && commandLog[0].command === 'workbench.action.debug.restart');
    }
    reset();
    {
        // gdbtarget: the root session is stopped and its configuration started again through the API (#13).
        const rootConfig = { type: 'gdbtarget', name: 'CMSIS Debugger: pyOCD', request: 'launch', preLaunchTask: 'CMSIS Load' };
        const root = makeSession(() => undefined, rootConfig, 'Root').session;
        root.workspaceFolder = { uri: stub.Uri.file('/w'), name: 'w', index: 0 };
        const child = makeSession(() => undefined, { type: 'gdbtarget', name: 'core 1' }, 'Child').session;
        child.parentSession = root;
        const rootTracker = trackerFor(root);
        trackerFor(child);
        focusOn(child);
        const api = [];
        const savedStop = stub.debug.stopDebugging;
        const savedStart = stub.debug.startDebugging;
        stub.debug.stopDebugging = async (s) => { api.push(`stop ${s.name}`); setTimeout(() => rootTracker.onWillStopSession(), 20); };
        stub.debug.startDebugging = async (folder, cfg) => { api.push(`start ${folder && folder.uri.fsPath} ${cfg === rootConfig}`); return true; };
        try {
            const how = await new DebuggingExecutor().restart();
            check('RC6 gdbtarget restart: stop the root, wait for its end, start its configuration', eq(api, ['stop Root', 'start /w true']) && commandLog.length === 0
                && eq(how, { via: 'relaunched', configurationName: 'CMSIS Debugger: pyOCD', preLaunchTask: 'CMSIS Load' }), { api, how, commandLog });
            stub.debug.startDebugging = async () => false;
            const again = makeSession(() => undefined, rootConfig, 'Root2').session;
            const againTracker = trackerFor(again);
            focusOn(again);
            stub.debug.stopDebugging = async () => { setTimeout(() => againTracker.onWillStopSession(), 5); };
            const e = await rejects(new DebuggingExecutor().restart());
            check('RC6 a start VS Code refuses comes back as an error', e && e.message === "Restarting the debug session failed: VS Code did not start the launch configuration 'CMSIS Debugger: pyOCD' again.", e && e.message);
        } finally {
            stub.debug.stopDebugging = savedStop;
            stub.debug.startDebugging = savedStart;
        }
    }

    // ── Session and status ──
    reset();
    {
        const started = [];
        stub.debug.startDebugging = async (folder, cfg) => { started.push({ folder: folder?.uri?.fsPath, cfg }); return true; };
        const f = (p) => ({ uri: stub.Uri.file(p), name: p, index: 0 });
        stub.workspace.workspaceFolders = [f('/w/a'), f('/w/b')];
        const ex = new DebuggingExecutor();
        await ex.startDebuggingByName('/w/a/', 'Cfg');
        check('SS1 /w/a/ → /w/a with name', started.length === 1 && started[0].folder === '/w/a' && started[0].cfg === 'Cfg', started);
        started.length = 0;
        await ex.startDebuggingByName('/w', 'Cfg');
        check('SS1 /w → /w/a', started[0]?.folder === '/w/a', started);
        const e = await rejects(ex.startDebuggingByName('/x', 'Cfg'));
        const s4 = "No VS Code workspace folder matches workingDirectory '/x'. Open workspace folders: /w/a, /w/b. launch.json is resolved relative to an open workspace folder — open the project folder (the one containing .vscode/launch.json) in this VS Code window.";
        check('SS1 /x two folders → S3(S4)', e && e.message === `Failed to start debugging with configuration 'Cfg': ${s4}`, e && e.message);
        stub.workspace.workspaceFolders = [];
        const e2 = await rejects(ex.startDebuggingByName('/x', 'Cfg'));
        check('SS1 no folders → (none)', e2 && e2.message.includes('Open workspace folders: (none).'), e2 && e2.message);
        stub.workspace.workspaceFolders = [f('/w/a')];
        started.length = 0;
        await ex.startDebuggingByName('/x', 'Cfg');
        check('SS1 one folder fallback', started[0]?.folder === '/w/a');
        stub.workspace.workspaceFolders = [f('/w/a\\'), f('/w/b')];
        started.length = 0;
        stub.workspace.getWorkspaceFolder = () => undefined;
        await ex.startDebuggingByName('/w/b//', 'Cfg');
        check('SS1 trailing separators stripped', started[0]?.folder === '/w/b', started);
        delete stub.workspace.getWorkspaceFolder;
        stub.workspace.getWorkspaceFolder = function (uri) { return stub.workspace.workspaceFolders.find((fo) => String(uri.fsPath).startsWith(fo.uri.fsPath)); };
        stub.debug.startDebugging = async () => { throw new Error('launch boom'); };
        const e3 = await rejects(ex.startDebugging('/w/a', { name: 'x' }));
        console.log(`       S2 text: ${e3 && e3.message}`);
        stub.debug.startDebugging = async () => true;
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        const st = await ex.getSessionStatus();
        check('SS2 no-session object', eq(st, { state: 'no-session', sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null }) && !('detail' in st), st);
        check('SS2 S28', (await ex.checkTargetConnection()) === 'No active debug session.');
    }
    reset();
    {
        const { session } = makeSession(never, { type: 'gdbtarget', name: 'Cfg' }, 'Sess');
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 200 });
        const st = await ex.getSessionStatus();
        check('SS3 unresponsive', st.state === 'unresponsive' && st.detail === 'DAP threads probe timed out after 200ms — probe/target may be hung.' && st.dapProbeMs === null && st.dapResponsive === false, st);
        const txt = await ex.checkTargetConnection();
        check('SS3 check text', txt === 'Session: Sess (type=gdbtarget)\nConfiguration: Cfg\nDAP probe: TIMEOUT — probe/target unresponsive\nDAP threads probe timed out after 200ms — probe/target may be hung.', txt);
    }
    reset();
    {
        const { session } = makeSession(() => { throw new Error('boom'); }, { type: 'gdbtarget' }, 'Sess');
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 200 });
        const st = await ex.getSessionStatus();
        check('SS3 initializing', st.state === 'initializing' && st.detail === 'DAP threads probe failed: boom', st);
        const txt = await ex.checkTargetConnection();
        check('SS3 check text S32, no config line', txt === 'Session: Sess (type=gdbtarget)\nDAP probe: FAILED — adapter likely still initializing\nDAP threads probe failed: boom', txt);
    }
    reset();
    {
        // The adapter answers DHCSR with a halted core (#3); every other request with an empty thread list.
        const { session, calls } = makeSession((c, a) => (c === 'readMemory' && a.memoryReference === '0xE000EDF0'
            ? { data: le(0x00030003).toString('base64') } : { threads: [] }), { type: 'gdbtarget', name: 'Cfg' }, 'Sess');
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 5 };
        const ex = new DebuggingExecutor();
        const st = await ex.getSessionStatus();
        check('SS4 stopped', st.state === 'stopped' && st.dapResponsive === true && typeof st.dapProbeMs === 'number' && 'detail' in st && st.detail === undefined
            && !('coreSilentForMs' in st), st);
        const txt = await ex.checkTargetConnection();
        check('SS4 text', /^Session: Sess \(type=gdbtarget\)\nConfiguration: Cfg\nDAP probe: OK \(\d+ms\)\nTarget state: stopped — the debug port answers: DHCSR=0x00030003 \(halted\)\.$/.test(txt), txt);
        check('SS4 one DHCSR read', calls.filter((c) => c.command === 'readMemory').map((c) => c.json).join() === '{"memoryReference":"0xE000EDF0","count":4}', calls);
        const t = trackerFor(session);
        event(t, 'stopped', { reason: 'step', threadId: 1 });
        const st2 = await ex.getSessionStatus();
        check('SS4 stopped reason', st2.detail === 'Stopped reason: step', st2);
        event(t, 'continued', {});
        const txt2 = await ex.checkTargetConnection();
        check('SS4 running text', txt2.endsWith('Target state: running — DAP reads (memory/registers/variables) will be rejected until the target stops.'), txt2);
        check('SS4 running: DHCSR not read', calls.filter((c) => c.command === 'readMemory').length === 1, calls.length);
    }
    reset();
    {
        const ex0 = new DebuggingExecutor();
        check('SS5 hasActiveSession no session', (await ex0.hasActiveSession()) === false);
        const { session, calls } = makeSession(never);
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 150 });
        const t0 = Date.now();
        check('SS5 probe timeout → false', (await ex.hasActiveSession()) === false && Date.now() - t0 >= 140 && Date.now() - t0 < 1000, Date.now() - t0);
        check('SS5 one threads {}', calls.length === 1 && calls[0].command === 'threads' && calls[0].json === '{}');
    }
    reset();
    {
        const { session } = makeSession(() => { throw new Error('x'); });
        focusOn(session);
        check('SS5 error → false', (await new DebuggingExecutor().hasActiveSession()) === false);
        reset();
        const s2 = makeSession(() => ({ threads: [] }));
        focusOn(s2.session);
        stub.debug.activeStackItem = { session: s2.session, threadId: 1, frameId: 1 };
        check('SS5 success → stopped', (await new DebuggingExecutor().hasActiveSession()) === true);
        stub.debug.activeStackItem = undefined;
        check('SS5 success → not stopped', (await new DebuggingExecutor().hasActiveSession()) === false);
    }
    reset();
    {
        // cdt-gdb-adapter answers every request with an empty success, no body, while GDB connects and while the session shuts down.
        let reply;
        const { session } = makeSession(() => reply, { type: 'gdbtarget', name: 'Cfg' }, 'Sess');
        focusOn(session);
        event(trackerFor(session), 'stopped', { reason: 'breakpoint', threadId: 1 });
        const ex = new DebuggingExecutor();
        const gated = 'The adapter answered the threads probe without a thread list: it takes no requests until GDB '
            + 'has connected to the target and run the launch configuration\'s commands, nor while the session shuts down.';
        for (const [label, answer] of [['no body', undefined], ['a body without threads', {}]]) {
            reply = answer;
            const st = await ex.getSessionStatus();
            check(`SS7 gdbtarget, ${label} → initializing`, st.state === 'initializing' && st.dapResponsive === true
                && typeof st.dapProbeMs === 'number' && st.detail === gated, st);
            check(`SS7 gdbtarget, ${label} → hasActiveSession false despite the stop`, (await ex.hasActiveSession()) === false);
        }
        reply = undefined;
        const txt = (await ex.checkTargetConnection()).replace(/NOT READY \(\d+ms\)/, 'NOT READY (<n>ms)');
        check('SS7 check text', txt === `Session: Sess (type=gdbtarget)\nConfiguration: Cfg\nDAP probe: NOT READY (<n>ms)\n${gated}`, txt);
        reply = { threads: [{ id: 1, name: 'main' }] };
        const st = await ex.getSessionStatus();
        check('SS7 gdbtarget, thread list → stopped', st.state === 'stopped' && st.detail === 'Stopped reason: breakpoint', st);
        check('SS7 gdbtarget, thread list → hasActiveSession', (await ex.hasActiveSession()) === true);
    }
    reset();
    {
        // A session asked to end: the adapter got a disconnect or terminate and gives the probe no thread list while it shuts down.
        let reply;
        const { session } = makeSession(() => (typeof reply === 'function' ? reply() : reply), { type: 'gdbtarget', name: 'Cfg' }, 'Sess');
        focusOn(session);
        const t = trackerFor(session);
        event(t, 'continued', { threadId: 1 });
        t.onWillReceiveMessage({ type: 'request', seq: 7, command: 'disconnect', arguments: { restart: false } });
        const ex = new DebuggingExecutor({ dapRequestMs: 100 });
        const ending = 'The session was asked to end (disconnect sent 0 s ago); its adapter takes no requests while it shuts down.';
        reply = undefined;
        let st = await ex.getSessionStatus();
        check('SS8 no thread list after a disconnect → initializing, shutting down', st.state === 'initializing' && st.detail === ending
            && typeof st.endRequestedForMs === 'number' && st.endRequestedForMs >= 0 && st.dapResponsive === true, st);
        reply = never;
        st = await ex.getSessionStatus();
        check('SS8 a probe timeout after a disconnect → initializing, not unresponsive', st.state === 'initializing'
            && st.detail === `${ending} The threads probe got no answer within 100ms.` && st.dapResponsive === false && st.dapProbeMs === null, st);
        reply = () => { throw new Error('boom'); };
        st = await ex.getSessionStatus();
        check('SS8 a failed probe after a disconnect → initializing, with the failure', st.state === 'initializing'
            && st.detail === `${ending} The threads probe failed: boom`, st);
        const txt = await ex.checkTargetConnection();
        check('SS8 check text', txt === `Session: Sess (type=gdbtarget)\nConfiguration: Cfg\nDAP probe: FAILED — the session is shutting down\n${ending} The threads probe failed: boom`, txt);
        reply = { threads: [{ id: 1, name: 'main' }] };
        st = await ex.getSessionStatus();
        check('SS8 a thread list still counts as it is', st.state === 'running' && st.endRequestedForMs === undefined, st);
    }
    reset();
    {
        // Other adapters keep their answers: a reply without a body is a session that answers.
        const { session } = makeSession(() => undefined, { type: 'python', name: 'Py' }, 'Py');
        focusOn(session);
        const t = trackerFor(session);
        const ex = new DebuggingExecutor();
        event(t, 'continued', {});
        check('SS7 python, no body → running', (await ex.getSessionStatus()).state === 'running');
        event(t, 'stopped', { reason: 'step', threadId: 1 });
        check('SS7 python, no body → stopped', (await ex.getSessionStatus()).state === 'stopped' && (await ex.hasActiveSession()) === true);
    }
    reset();
    {
        const { session } = makeSession(() => undefined, { type: 'gdbtarget' }, 'Live');
        trackerFor(session);
        const d = new DebuggingExecutor().getDiagnostics();
        check('SS6 diagnostics', d.serverVersion === SERVER_VERSION && d.liveSessionCount === 1 && eq(d.liveSessionNames, ['Live']) && d.hasVscodeActiveSession === false, d);
        focusOn(session);
        check('SS6 active set', new DebuggingExecutor().getDiagnostics().hasVscodeActiveSession === true);
    }

    // ── Breakpoints and GDB ──
    reset();
    {
        const ex = new DebuggingExecutor();
        const uri = stub.Uri.file('/w/src/main.c');
        await ex.addBreakpoint(uri, 12, { condition: 'x > 3' });
        const bp = addLog[0]?.[0];
        check('BP1 add', addLog.length === 1 && bp instanceof stub.SourceBreakpoint && bp.location.range.start.line === 11 && bp.location.range.start.character === 0
            && bp.enabled === true && bp.condition === 'x > 3' && bp.hitCondition === undefined && bp.logMessage === undefined, bp);
        await ex.removeBreakpoint(stub.Uri.file('/w/src/other.c'), 12);
        check('BP1 no remove call when none match', removeLog.length === 0);
        const fb = new stub.FunctionBreakpoint();
        stub.debug.breakpoints = [...stub.debug.breakpoints, fb];
        await ex.addBreakpoint(uri, 13);
        await ex.removeBreakpoint(uri, 12);
        check('BP1 remove exactly one', removeLog.length === 1 && removeLog[0].length === 1 && removeLog[0][0] === bp, removeLog);
        check('BP getBreakpoints is the array itself', ex.getBreakpoints() === stub.debug.breakpoints);
        ex.clearAllBreakpoints();
        check('BP clearAll one call incl function bp', removeLog.length === 2 && removeLog[1].length === 2 && stub.debug.breakpoints.length === 0, removeLog[1]);
        ex.clearAllBreakpoints();
        check('BP clearAll empty → no call', removeLog.length === 2);
    }
    // GDB commands (#56): the prefix of the session's adapter, and where the text comes back.
    reset();
    {
        let reply = (expression) => ({ result: '\r' });
        const { session, calls } = makeSession((c, a) => c === 'stackTrace' ? { stackFrames: [] } : reply(a.expression));
        const t = trackerFor(session);
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 2, frameId: 5 };
        const ex = new DebuggingExecutor();
        reply = (expression) => {
            event(t, 'output', { category: 'stdout', output: 'Deleted breakpoints ' });
            event(t, 'output', { category: 'console', output: 'not this' });
            event(t, 'output', { category: 'stdout', output: '3 4\n' });
            return { result: '\r', variablesReference: 0 };
        };
        const r = await ex.deleteBreakpointsViaGdb([3, 4]);
        check('G1 gdbtarget: `>` prefix in the focused frame, the text from stdout output events', eq(calls.map((c) => c.command + ' ' + c.json), [
            'stackTrace {"threadId":2,"startFrame":0,"levels":50}',
            'evaluate {"expression":">delete 3 4","context":"repl","frameId":5}']) && eq(r, { text: 'Deleted breakpoints 3 4', errored: false }),
        { calls: calls.map((c) => c.json), r });
        stub.debug.activeStackItem = undefined;
        calls.length = 0;
        reply = () => {
            setTimeout(() => event(t, 'output', { category: 'stdout', output: 'late but within the quiet period\n' }), 10);
            return { result: '\r' };
        };
        const late = await ex.setBreakpointConditionViaGdb(3, 'i == 2');
        check('G1 output right after the reply is still collected; no frame, no frameId', eq(calls.map((c) => c.json), ['{"expression":">condition 3 i == 2","context":"repl"}'])
            && late.text === 'late but within the quiet period', { calls: calls.map((c) => c.json), late });
        reply = () => {
            const timer = setInterval(() => event(t, 'output', { category: 'stdout', output: '.' }), 5);
            setTimeout(() => clearInterval(timer), 1000);
            return { result: '\r' };
        };
        const t0 = Date.now();
        await ex.setBreakpointConditionViaGdb(3, 'x');
        const settleMs = Date.now() - t0;
        check('G1 a target that keeps printing does not hold the command beyond the cap', settleMs >= 200 && settleMs < 700, settleMs);
        await sleep(1050);
        reply = () => { throw new Error('No symbol "q" in current context.'); };
        const refused = await ex.setBreakpointConditionViaGdb(3, 'q');
        check('G1 a refusal is an errored reply with GDB\'s text', eq(refused, { text: 'No symbol "q" in current context.', errored: true }), refused);
        reply = () => ({ result: 'Error: could not evaluate expression', variablesReference: 0 });
        const skipped = await ex.setBreakpointConditionViaGdb(3, 'x');
        check('G1 the adapter\'s default answer to a `>` command means it did not run it', skipped.errored
            && skipped.text === 'The debug adapter did not run the command: its session is not ready (it answered "Error: could not evaluate expression").', skipped);
        reply = () => ({ result: JSON.stringify({ bkpt: { number: '7', type: 'dprintf' } }) });
        calls.length = 0;
        const inserted = await ex.insertDprintfViaGdb('src/main.c:12', 'n=%d at \\"%s\\"\\n', ['n', 'a + b', 'say("x")']);
        check('G2 -dprintf-insert: MI c-string arguments, the MI result as the text', eq(calls.map((c) => c.args.expression),
            ['>-dprintf-insert "src/main.c:12" "n=%d at \\"%s\\"\\n" "n" "a + b" "say(\\"x\\")"'])
            && inserted.text === JSON.stringify({ bkpt: { number: '7', type: 'dprintf' } }) && !inserted.errored, { calls: calls.map((c) => c.args.expression), inserted });
        calls.length = 0;
        await ex.listBreakpointsViaGdb();
        const none = await ex.deleteBreakpointsViaGdb([]);
        check('G2 -break-list; no bare delete for an empty list', eq(calls.map((c) => c.args.expression), ['>-break-list']) && eq(none, { text: '', errored: false }),
            calls.map((c) => c.args.expression));
        reply = never;
        const ex2 = new DebuggingExecutor({ dapRequestMs: 60 });
        const e = await rejects(ex2.deleteBreakpointsViaGdb([1]));
        event(t, 'output', { category: 'stdout', output: 'after the timeout\n' });
        reply = () => ({ result: '\r' });
        const next = await ex.deleteBreakpointsViaGdb([2]);
        check('G3 a hang is a HardwareTimeoutError, and its capture is closed', e instanceof HardwareTimeoutError && next.text === '', { e: String(e), next });
    }
    reset();
    {
        const { session, calls } = makeSession(() => ({ result: 'Deleted breakpoint 3 ' }), { type: 'cppdbg', name: 'C++' });
        focusOn(session);
        const r = await new DebuggingExecutor().deleteBreakpointsViaGdb([3]);
        check('G4 cppdbg: `-exec ` prefix, the text in the reply', calls[0].args.expression === '-exec delete 3' && eq(r, { text: 'Deleted breakpoint 3', errored: false }),
            { calls: calls.map((c) => c.json), r });
    }
    reset();
    {
        // An agent's passthrough: translated on gdbtarget, verbatim elsewhere.
        let answer = () => ({ result: '\r' });
        const { session, calls } = makeSession((c, a) => answer(a));
        const t = trackerFor(session);
        focusOn(session);
        const ex = new DebuggingExecutor();
        answer = () => { event(t, 'output', { category: 'stdout', output: 'r0             0x2a                42\n' }); return { result: '\r', variablesReference: 0 }; };
        const translated = await ex.evaluateExpression('-exec info registers', 1000);
        const kept = await ex.evaluateExpression('>info registers', 1000);
        check('E5 gdbtarget: -exec and > both reach GDB as >cmd, with the printed text as the result',
            eq(calls.map((c) => c.json), ['{"expression":">info registers","context":"repl","frameId":1000}', '{"expression":">info registers","context":"repl","frameId":1000}'])
            && eq(translated, { result: 'r0             0x2a                42', variablesReference: 0 }) && eq(kept, translated), { calls: calls.map((c) => c.json), translated });
        answer = () => { throw new Error('Cannot execute this command while the target is running.'); };
        const e = await rejects(ex.evaluateExpression('-exec x/4xw $sp', 1000));
        check('E5 a GDB refusal rejects, classified TARGET_RUNNING', e && e.code === 'TARGET_RUNNING'
            && e.message === 'Evaluating the expression failed: Cannot execute this command while the target is running.', e && `${e.code} ${e.message}`);
        calls.length = 0;
        answer = () => ({ result: '42' });
        await ex.evaluateExpression('-execCount', 1000);
        check('E5 an expression that starts with -exec but is none stays an expression', calls[0].json === '{"expression":"-execCount","frameId":1000,"context":"repl"}', calls[0].json);
        reset();
        const cpp = makeSession(() => ({ result: 'rax 0x1 1' }), { type: 'cppdbg', name: 'C++' });
        focusOn(cpp.session);
        const verbatim = await new DebuggingExecutor().evaluateExpression('-exec info registers', 4);
        check('E5 cppdbg: -exec passes verbatim, the reply is returned unchanged', cpp.calls[0].json === '{"expression":"-exec info registers","frameId":4,"context":"repl"}'
            && eq(verbatim, { result: 'rax 0x1 1' }), cpp.calls[0].json);
    }
    reset();
    {
        // The adapter's binding of a model breakpoint (getDebugProtocolBreakpoint), polled until it answers.
        const ex = new DebuggingExecutor();
        const uri = stub.Uri.file('/w/src/main.c');
        const bp = await ex.addBreakpoint(uri, 12);
        check('BB1 addBreakpoint returns the model breakpoint; no binding without a session', bp === addLog[0][0] && (await ex.breakpointBinding(bp, 500)) === undefined);
        const { session } = makeSession(() => undefined);
        focusOn(session);
        check('BB1 a session without getDebugProtocolBreakpoint reports nothing at once', eq(await ex.breakpointBinding(bp, 5000), { reported: false, verified: false }));
        let asks = 0;
        session.getDebugProtocolBreakpoint = async (asked) => { asks++; return asks < 3 || asked !== bp ? undefined : { id: 2, verified: true, line: 13, message: '' }; };
        const bound = await ex.breakpointBinding(bp, 2000);
        check('BB1 asked again until the adapter answers', asks === 3 && eq(bound, { reported: true, verified: true, message: undefined, line: 13, id: 2 }), { asks, bound });
        session.getDebugProtocolBreakpoint = async () => ({ verified: false, message: 'No line 99 in file "main.c".' });
        check('BB1 unverified with the adapter\'s message', eq(await ex.breakpointBinding(bp, 0), { reported: true, verified: false, message: 'No line 99 in file "main.c".', line: undefined, id: undefined }));
        session.getDebugProtocolBreakpoint = async () => undefined;
        const t0 = Date.now();
        const silent = await ex.breakpointBinding(bp, 150);
        check('BB1 bounded wait', eq(silent, { reported: false, verified: false }) && Date.now() - t0 >= 140 && Date.now() - t0 < 800, Date.now() - t0);
    }
    reset();
    {
        // A removal waits for the adapter's setBreakpoints answer for each file concerned.
        const { session } = makeSession(() => undefined);
        const t = trackerFor(session);
        focusOn(session);
        const uri = stub.Uri.file('/w/src/main.c');
        stub.debug.breakpoints = [new stub.SourceBreakpoint(new stub.Location(uri, new stub.Position(11, 0)), true),
            new stub.SourceBreakpoint(new stub.Location(uri, new stub.Position(12, 0)), true, undefined, undefined, 'n={n}')];
        let seq = 100;
        stub.debug.removeBreakpoints = (bps) => {
            removeLog.push(bps);
            stub.debug.breakpoints = stub.debug.breakpoints.filter((b) => !bps.includes(b));
            const files = [...new Set(bps.map((b) => b.location.uri.fsPath))];
            setTimeout(() => {
                for (const file of files) {
                    const request = { type: 'request', seq: ++seq, command: 'setBreakpoints', arguments: { source: { path: file } } };
                    t.onWillReceiveMessage(request);
                    t.onDidSendMessage({ type: 'response', request_seq: request.seq, command: 'setBreakpoints', success: true, body: { breakpoints: [] } });
                }
            }, 20);
        };
        const ex = new DebuggingExecutor();
        const savedRemove = stub.debug.removeBreakpoints;
        const logOnly = await ex.removeBreakpoint(uri, 12, { logpointsOnly: true });
        check('BR1 logpointsOnly leaves a plain breakpoint alone', eq(logOnly, { removed: 0 }) && removeLog.length === 0 && stub.debug.breakpoints.length === 2, logOnly);
        const logpoint = await ex.removeBreakpoint(uri, 13, { logpointsOnly: true });
        check('BR1 the adapter answered: applied', eq(logpoint, { removed: 1, applied: true }) && stub.debug.breakpoints.length === 1, logpoint);
        const all = await ex.clearAllBreakpoints();
        check('BR1 clear all: applied', eq(all, { removed: 1, applied: true }), all);
        stub.debug.breakpoints = [new stub.SourceBreakpoint(new stub.Location(uri, new stub.Position(11, 0)), true)];
        stub.debug.removeBreakpoints = (bps) => { stub.debug.breakpoints = stub.debug.breakpoints.filter((b) => !bps.includes(b)); };
        const t0 = Date.now();
        const silent = await ex.removeBreakpoint(uri, 12);
        check('BR1 an adapter that never answers: not applied after the 2 s bound', eq(silent, { removed: 1, applied: false }) && Date.now() - t0 >= 1900, { silent, ms: Date.now() - t0 });
        stub.debug.removeBreakpoints = savedRemove;
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        const uri = stub.Uri.file('/w/src/main.c');
        stub.debug.breakpoints = [new stub.SourceBreakpoint(new stub.Location(uri, new stub.Position(11, 0)), true, 'x'), new stub.FunctionBreakpoint()];
        const noSession = await ex.getCurrentDebugState();
        check('BP5 breakpoints without session', eq(noSession.breakpoints, ['main.c:12 [when: x]']) && noSession.sessionActive === false, noSession.breakpoints);
        const { session, calls } = makeSession(() => ({ stackFrames: [{ id: 1000, name: 'main', source: { path: '/w/src/main.c' }, line: 40, column: 0 }, { id: 1001, name: '', source: { name: 'x.c' }, line: 0 }] }), { type: 'gdbtarget', name: 'Cfg' });
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 1000 };
        const st = await ex.getCurrentDebugState();
        check('BP5 frame, location null when open fails', st.frameName === 'main' && st.currentLine === null && st.fileName === null && st.frameId === 1000 && st.threadId === 1
            && st.configurationName === 'Cfg' && eq(st.stackTrace, [{ name: 'main', source: '/w/src/main.c', line: 40 }, { name: 'unknown', source: 'x.c' }]), st);
        check('BP5 stackTrace args', calls[0].json === '{"threadId":1,"startFrame":0,"levels":50}');
        const lines = ['int main(void) {', '', '  a();  ', '', '   b();', 'c();', '}'];
        stub.workspace.openTextDocument = async () => ({ lineCount: lines.length, lineAt: (i) => ({ text: lines[i] }) });
        const st2 = await ex.getCurrentDebugState();
        check('BP5 location', st2.currentLine === 40 && st2.fileName === 'main.c' && st2.fileFullPath === '/w/src/main.c' && st2.currentLineContent === '}' && eq(st2.nextLines, []), st2);
        session.customRequest = (c, a) => { calls.push({ command: c, json: JSON.stringify(a) }); return Promise.resolve({ stackFrames: [{ id: 1, name: 'f', source: { path: 'C:\\w\\m.c' }, line: 1 }] }); };
        const st3 = await ex.getCurrentDebugState(2);
        check('BP5 lookahead 2 skips empty, windows path', st3.currentLineContent === 'int main(void) {' && eq(st3.nextLines, ['a();', 'b();']) && st3.fileName === 'm.c', st3);
    }

    // ── Memory ──
    reset();
    {
        let mem = (c, a) => ({ data: b64([1, 2, 3, 4, 5, 6, 7, 8]) });
        const { session, calls } = makeSession((c, a) => mem(c, a));
        focusOn(session);
        const ex = new DebuggingExecutor();
        const buf = await ex.readMemory('20000000', 8);
        check('M1 readMemory args', calls[0].json === '{"memoryReference":"0x20000000","count":8}' && eq(plain(buf), { offset: 0, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }), calls[0].json);
        mem = () => ({ data: b64([1, 2, 3, 4]) });
        check('M1 short reply returned', eq(plain(await ex.readMemory('0X20000000', 8)), { offset: 0, bytes: [1, 2, 3, 4] }) && calls[1].json === '{"memoryReference":"0X20000000","count":8}');
    }
    reset();
    {
        // The reply's address is that of its first byte (DAP). cdt-gdb-adapter answers with GDB's first
        // readable block, which begins later than asked when the start of the range is in a hole.
        let reply;
        const { session, calls } = makeSession((c, a) => reply(c, a));
        focusOn(session);
        const ex = new DebuggingExecutor();
        const sram = Array.from({ length: 48 }, (_, i) => i + 1);
        reply = () => ({ address: '0x20000000', data: b64(sram) });
        check('M7 a reply that begins later keeps its place: 16 bytes in, 48 bytes', eq(plain(await ex.readMemory('0x1FFFFFF0', 64)), { offset: 16, bytes: sram })
            && eq(calls.map((c) => c.command + ' ' + c.json), ['readMemory {"memoryReference":"0x1FFFFFF0","count":64}']), calls.map((c) => c.json));
        reply = () => ({ address: '0x20017ff0', data: b64([9, 8, 7, 6]), unreadableBytes: 60 });
        check('M7 unreadableBytes counts after the data: nothing moves and nothing is added', eq(plain(await ex.readMemory('0x20017ff0', 64)), { offset: 0, bytes: [9, 8, 7, 6] }));
        reply = () => ({ address: '536870916', data: b64([1, 2, 3, 4]) });
        check('M7 a decimal address', eq(plain(await ex.readMemory('0x20000000', 8)), { offset: 4, bytes: [1, 2, 3, 4] }));
        reply = () => ({ address: '0x1ffffffc', data: b64([0xa, 0xb, 0xc, 0xd, 1, 2, 3, 4, 5, 6, 7, 8, 9]) });
        check('M7 bytes before or after the range are dropped', eq(plain(await ex.readMemory('0x20000000', 8)), { offset: 0, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }));
        let first = { address: '0x20000100', data: b64([1, 2, 3, 4]) };
        let words = { '*(unsigned int*)0x20000000': '0x04030201', '*(unsigned int*)0x20000004': '0x08070605' };
        reply = (c, a) => {
            if (c === 'readMemory') { return a.memoryReference === '0xE000EDF0' ? { data: le(0x00030003).toString('base64') } : first; }
            return { result: words[a.expression] ?? '' };
        };
        calls.length = 0;
        check('M7 a reply that holds none of the range is not used: the GDB ladder reads it', eq(plain(await ex.readMemory('0x20000000', 8)), { offset: 0, bytes: [1, 2, 3, 4, 5, 6, 7, 8] })
            && eq(calls.map((c) => c.command), ['readMemory', 'evaluate', 'evaluate']), calls.map((c) => c.command + ' ' + c.json));
        first = { address: 'soon', data: b64([1, 2, 3, 4]) };
        words = {};
        const e = await rejects(ex.readMemory('0x20000000', 8));
        check('M7 an address that is not a number is a cause, never a place', e && e.code === 'INVALID_ARGUMENT'
            && e.message.includes('DAP readMemory: the reply\'s address \'soon\' is not a number; watch expression: empty result'), e && e.message);
    }
    reset();
    {
        const { session, calls } = makeSession((c, a) => {
            if (c === 'readMemory') { throw new Error('unrecognized request'); }
            if (c === 'evaluate' && a.expression === '*(unsigned int*)0x20000000') { return { result: '0x04030201' }; }
            if (c === 'evaluate' && a.expression === '*(unsigned int*)0x20000004') { return { result: '0x08070605' }; }
            throw new Error('unexpected');
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        const buf = await ex.readMemory('0x20000000', 6);
        check('M2 fallback bytes', eq(plain(buf), { offset: 0, bytes: [1, 2, 3, 4, 5, 6] }), plain(buf));
        check('M2 requests', eq(calls.map((c) => c.command + ' ' + c.json), [
            'readMemory {"memoryReference":"0x20000000","count":6}',
            'evaluate {"expression":"*(unsigned int*)0x20000000","context":"watch"}',
            'evaluate {"expression":"*(unsigned int*)0x20000004","context":"watch"}']), calls.map((c) => c.command + ' ' + c.json));
        calls.length = 0;
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 9 };
        await ex.readMemory('0x20000000', 6);
        check('M2 with frame: one lookup then frameId', eq(calls.map((c) => c.command), ['readMemory', 'stackTrace', 'evaluate', 'evaluate']) && calls[2].args.frameId === 9 && calls[3].args.frameId === 9, calls.map((c) => c.command + ' ' + c.json));
        calls.length = 0;
        const e = await rejects(ex.readMemory('0xZZ', 4));
        check('M2 BigInt SyntaxError', e instanceof SyntaxError, String(e));
        const upper = [];
        session.customRequest = (c, a) => { upper.push(a.memoryReference ?? a.expression); if (c === 'readMemory') { return Promise.reject(new Error('x')); } return Promise.resolve({ result: '1' }); };
        await ex.readMemory('0xE000ED28', 8);
        check('M2 ladder addresses lower-case', eq(upper.filter((x) => typeof x === 'string' && x.startsWith('*')), ['*(unsigned int*)0xe000ed28', '*(unsigned int*)0xe000ed2c']), upper);
    }
    reset();
    {
        let script;
        const { session, calls } = makeSession((c, a) => script(c, a), { type: 'cppdbg', name: 'C++' });
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 3 };
        const ex = new DebuggingExecutor({ dapRequestMs: 100 });
        script = (c, a) => {
            if (c === 'readMemory') { throw new Error('x'); }
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (a.context === 'watch') { return { result: 'garbage' }; }
            if (a.expression.startsWith('-exec x/1xw')) { return { result: '0x20000000:\t0x000000ff' }; }
            throw new Error('?');
        };
        check('M3 x/1xw → 255', (await ex.readMemoryWord('0x20000000')) === 255);
        script = (c, a) => {
            if (c === 'readMemory') { throw new Error('x'); }
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (a.expression.startsWith('-exec print/x')) { return { result: '$1 = 0x10' }; }
            return { result: 'Error: could not evaluate expression' };
        };
        calls.length = 0;
        check('M3 print/x → 16', (await ex.readMemoryWord('0x20000000')) === 16);
        check('M3 ladder requests', eq(calls.map((c) => c.command + ' ' + c.json), [
            'readMemory {"memoryReference":"0x20000000","count":4}',
            'stackTrace {"threadId":1,"startFrame":0,"levels":50}',
            'evaluate {"expression":"*(unsigned int*)0x20000000","context":"watch","frameId":3}',
            'evaluate {"expression":"-exec x/1xw 0x20000000","context":"repl","frameId":3}',
            'evaluate {"expression":"-exec print/x *(unsigned int*)0x20000000","context":"repl","frameId":3}']), calls.map((c) => c.command + ' ' + c.json));
        script = (c) => { if (c === 'stackTrace') { return { stackFrames: [] }; } throw new Error('nope'); };
        calls.length = 0;
        const e = await rejects(ex.readMemoryWord('0x20000000'));
        check('M3 all fail → every strategy\'s cause; no DHCSR read on other adapters (#3)',
            e && e.message === 'Failed to read memory at 0x20000000: DAP readMemory: nope; watch expression: nope; x/1xw: nope; print/x: nope'
            && !calls.some((c) => c.args.memoryReference === '0xE000EDF0'), e && e.message);
        script = (c) => { if (c === 'stackTrace') { return { stackFrames: [] }; } if (c === 'readMemory') { throw new Error('x'); } return never(); };
        calls.length = 0;
        const e2 = await rejects(ex.readMemoryWord('0x20000000'));
        check('M3 strategy-1 timeout → HardwareTimeoutError, no further request', e2 instanceof HardwareTimeoutError && calls.filter((c) => c.command === 'evaluate').length === 1, calls.map((c) => c.command));
        script = (c) => { if (c === 'stackTrace') { return { stackFrames: [] }; } if (c === 'readMemory') { return { data: b64([1, 2]) }; } return { result: '-7 <sym>' }; };
        check('M3 short data → ladder, negative decimal kept', (await ex.readMemoryWord('0x20000000')) === -7);
        script = (c) => { if (c === 'readMemory') { return {}; } if (c === 'stackTrace') { return { stackFrames: [] }; } return { result: ' 42 junk' }; };
        check('M3 no data → ladder decimal 42', (await ex.readMemoryWord('0x20000000')) === 42);
        script = () => never();
        const e3 = await rejects(ex.readMemoryWord('0x20000000'));
        check('M3 readMemory timeout rethrown', e3 instanceof HardwareTimeoutError && e3.operation === 'DAP readMemory');
    }
    reset();
    {
        // gdbtarget: after the watch expression, the MI read whose result comes back in the reply (#56).
        let script;
        const { session, calls } = makeSession((c, a) => script(c, a));
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 3 };
        const ex = new DebuggingExecutor({ dapRequestMs: 100 });
        script = (c, a) => {
            if (c === 'readMemory') { throw new Error('x'); }
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (a.context === 'watch') { return { result: 'Error: could not evaluate expression' }; }
            if (a.expression === '>-data-read-memory-bytes 0x20000000 4') {
                return { result: JSON.stringify({ memory: [{ begin: '0x20000000', offset: '0x00000000', end: '0x20000004', contents: 'ff000000' }], 'cdt-token': '9' }) };
            }
            return { result: 'Error: could not evaluate expression' };
        };
        check('M3g MI read → 255', (await ex.readMemoryWord('0x20000000')) === 255);
        check('M3g ladder requests', eq(calls.map((c) => c.command + ' ' + c.json), [
            'readMemory {"memoryReference":"0x20000000","count":4}',
            'stackTrace {"threadId":1,"startFrame":0,"levels":50}',
            'evaluate {"expression":"*(unsigned int*)0x20000000","context":"watch","frameId":3}',
            'evaluate {"expression":">-data-read-memory-bytes 0x20000000 4","context":"repl","frameId":3}']), calls.map((c) => c.command + ' ' + c.json));
        script = (c) => { if (c === 'stackTrace') { return { stackFrames: [] }; } if (c === 'readMemory') { throw new Error('x'); } return { result: '\r' }; };
        calls.length = 0;
        const e = await rejects(ex.readMemoryWord('0x20000000'));
        check('M3g no -exec forms on gdbtarget; all fail and DHCSR fails too → PROBE_WEDGED with every cause (#3)', e && e.code === 'PROBE_WEDGED'
            && e.message === 'Memory reads fail and the debug port does not answer (DHCSR at 0xE000EDF0 unreadable: x). '
                + 'Reading 0x20000000 — DAP readMemory: x; watch expression: empty result; MI read: empty result'
            && !calls.some((c) => String(c.args && c.args.expression).startsWith('-exec'))
            && calls[calls.length - 1].json === '{"memoryReference":"0xE000EDF0","count":4}', e && e.message);
    }
    reset();
    {
        const { session } = makeSession(never);
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 1000, memoryReadMs: 100 });
        const t0 = Date.now();
        const e = await rejects(ex.readMemory('0x20000000', 16));
        const dt = Date.now() - t0;
        check('M4 fence readMemory ~100ms, then DHCSR within 1 s times out too → PROBE_WEDGED (#3)', e && e.code === 'PROBE_WEDGED'
            && e.message === 'Memory reads time out and the debug port does not answer (DHCSR at 0xE000EDF0 timed out). '
                + 'Reading 0x20000000 — readMemory: timed out after 100 ms'
            && dt >= 1000 && dt < 1600, `${e} ${dt}`);
        const e2 = await rejects(new DebuggingExecutor().readMemory('0x20000000', 16));
        reset();
        const e3 = await rejects(new DebuggingExecutor().readMemory('0x20000000', 16));
        check('M4 no session rejects before fence (plain Error)', e3 && !(e3 instanceof HardwareTimeoutError), String(e3));
        void e2;
    }
    reset();
    {
        const words = new Map();
        let writeFails = false;
        let stick = true;
        const { session, calls } = makeSession((c, a) => {
            if (c === 'writeMemory') { if (writeFails) { throw new Error('no write'); } if (stick) { words.set(a.memoryReference, Buffer.from(a.data, 'base64').readUInt32LE(0)); } return undefined; }
            if (c === 'readMemory') { return { data: le(words.get(a.memoryReference) ?? 0).toString('base64') }; }
            if (c === 'evaluate') { return { result: 'Error: could not evaluate expression' }; }
            return { stackFrames: [] };
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        await ex.writeMemoryWord('0xE000EDFC', 0x01000000);
        check('M5 write + readback', eq(calls.map((c) => c.command + ' ' + c.json), ['writeMemory {"memoryReference":"0xE000EDFC","data":"AAAAAQ=="}', 'readMemory {"memoryReference":"0xE000EDFC","count":4}']), calls.map((c) => c.command + ' ' + c.json));
        writeFails = true;
        calls.length = 0;
        words.set('0xE000EDFC', 0);
        const e = await rejects(ex.writeMemoryWord('0xE000EDFC', 0x01000000));
        check('M5 set fallback (`>` on gdbtarget) then read-back', eq(calls.map((c) => c.command + ' ' + (c.args?.expression ?? c.args?.memoryReference)), ['writeMemory 0xE000EDFC', 'evaluate >set {unsigned int}0xE000EDFC = 16777216', 'readMemory 0xE000EDFC']), calls.map((c) => c.command + ' ' + c.json));
        check('M5 did not stick', e && e.message === 'Write to 0xE000EDFC did not stick (wrote 0x01000000, read back 0x00000000)', e && e.message);
    }
    reset();
    {
        // A Cortex-M4 first. Writes to a `readOnly` address are ignored, as by Armv6-M's DWT_CTRL.
        const words = new Map([['0xE000ED00', 0x410fc241], ['0xE000EDFC', 0], ['0xE0001000', 0], ['0xE0001004', 1234]]);
        const readOnly = new Set();
        const { session, calls } = makeSession((c, a) => {
            if (c === 'writeMemory') { if (!readOnly.has(a.memoryReference)) { words.set(a.memoryReference, Buffer.from(a.data, 'base64').readUInt32LE(0)); } return undefined; }
            if (c === 'readMemory') { return { data: le(words.get(a.memoryReference) ?? 0).toString('base64') }; }
            throw new Error('?');
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        const seqs = () => calls.map((c) => `${c.command} ${c.args.memoryReference}${c.args.data ? ' ' + Buffer.from(c.args.data, 'base64').readUInt32LE(0).toString(16) : ''}`);
        const absent = { present: false, cycles: 0, enabledNow: false };
        const r = await ex.readCycleCounter();
        check('M6 cycle counter enable', r.present === true && r.enabledNow === true && r.cycles === 1234 && eq(seqs(), [
            'readMemory 0xE000ED00',
            'readMemory 0xE000EDFC', 'writeMemory 0xE000EDFC 1000000', 'readMemory 0xE000EDFC',
            'readMemory 0xE0001000', 'writeMemory 0xE0001000 1', 'readMemory 0xE0001000', 'readMemory 0xE0001004']), seqs());
        // NOCYCCNT is bit 25; bit 28 is the lowest bit of NUMCOMP (here 2).
        words.set('0xE0001000', 0x2b000000);
        calls.length = 0;
        const r2 = await ex.readCycleCounter().catch((e) => e.message);
        check('M6 absent by DWT_CTRL.NOCYCCNT: no DWT_CTRL write, no CYCCNT read', eq(r2, absent)
            && eq(seqs(), ['readMemory 0xE000ED00', 'readMemory 0xE000EDFC', 'readMemory 0xE0001000']), [r2, seqs()]);
        words.set('0xE0001000', 0x10000000);
        calls.length = 0;
        const r3 = await ex.readCycleCounter().catch((e) => e.message);
        check('M6 one comparator (NUMCOMP=1) and a cycle counter: enabled', r3.present === true && r3.enabledNow === true && r3.cycles === 1234
            && eq(seqs(), ['readMemory 0xE000ED00', 'readMemory 0xE000EDFC', 'readMemory 0xE0001000', 'writeMemory 0xE0001000 10000001',
                'readMemory 0xE0001000', 'readMemory 0xE0001004']), [r3, seqs()]);
        // Cortex-M0+: a read-only DWT_CTRL with NUMCOMP alone, nothing at CYCCNT.
        words.set('0xE000ED00', 0x410cc601); words.set('0xE000EDFC', 0); words.set('0xE0001000', 0x20000000); words.set('0xE0001004', 0);
        readOnly.add('0xE0001000');
        calls.length = 0;
        const r4 = await ex.readCycleCounter().catch((e) => e.message);
        check('M6 Armv6-M (Cortex-M0+) absent by CPUID, nothing written', eq(r4, absent) && eq(seqs(), ['readMemory 0xE000ED00']), [r4, seqs()]);
        // Cortex-M23: Armv8-M Baseline, NOCYCCNT reads 1 and CYCCNTENA 0.
        words.set('0xE000ED00', 0x411cd200); words.set('0xE000EDFC', 0); words.set('0xE0001000', 0x4b000000);
        calls.length = 0;
        const r5 = await ex.readCycleCounter().catch((e) => e.message);
        check('M6 Armv8-M Baseline (Cortex-M23) absent by CPUID, nothing written', eq(r5, absent) && eq(seqs(), ['readMemory 0xE000ED00']), [r5, seqs()]);
    }

    // ── Registers and faults ──
    reset();
    {
        const pending = [];
        const { session, calls } = makeSession((c, a) => {
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (a.expression === '$r3') { return never(); }
            if (a.expression === '$r5') { throw new Error('bad'); }
            if (a.expression === '$r6') { return undefined; }
            if (a.expression === '$r7') { return {}; }
            return new Promise((res) => pending.push(() => res({ result: `v${a.expression}` })));
        });
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 100 });
        const p = ex.readCoreRegisters();
        await sleep(10);
        const evals = calls.filter((c) => c.command === 'evaluate');
        check('R1 23 requests before any answer, in order', evals.length === 23 && evals.map((c) => c.args.expression).join(' ') === '$r0 $r1 $r2 $r3 $r4 $r5 $r6 $r7 $r8 $r9 $r10 $r11 $r12 $sp $lr $pc $xpsr $msp $psp $control $faultmask $basepri $primask'
            && evals.every((c) => c.args.context === 'watch' && !('frameId' in c.args)), evals.map((c) => c.json));
        pending.forEach((f) => f());
        const regs = await p;
        check('R1 values', regs.r3 === '<timeout>' && regs.r5 === '<unavailable>' && regs.r6 === '<unavailable>' && regs.r7 === undefined && 'r7' in regs && regs.r0 === 'v$r0'
            && Object.keys(regs).join(' ') === 'r0 r1 r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 sp lr pc xpsr msp psp control faultmask basepri primask', regs);
        calls.length = 0;
        const p2 = ex.readCoreRegisters(5000, ['pc', 'lr']);
        await sleep(5);
        pending.forEach((f) => f());
        const regs2 = await p2;
        check('R1 two names', calls.filter((c) => c.command === 'evaluate').length === 2 && eq(Object.keys(regs2), ['pc', 'lr']), calls.map((c) => c.json));
        calls.length = 0;
        const ex2 = new DebuggingExecutor({ dapRequestMs: 1000, memoryReadMs: 50 });
        const e = await rejects(ex2.readCoreRegisters(undefined, ['r3']));
        check('R1 fence', e instanceof HardwareTimeoutError && e.operation === 'readCoreRegisters', String(e));
    }
    reset();
    {
        const { session, calls } = makeSession((c, a) => {
            if (c === 'readMemory') { return { data: b64(Array.from({ length: a.count }, (_, i) => i)) }; }
            throw new Error('?');
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        const regs = await ex.readFaultRegisters();
        // No 24-byte block: the Corstone FVP's GDB server answers SCS reads longer than one word with zeros.
        check('F2 six words from CFSR, one request each', eq(calls.map((c) => c.json), ['0xE000ED28', '0xE000ED2C', '0xE000ED30', '0xE000ED34', '0xE000ED38', '0xE000ED3C'].map((m) => `{"memoryReference":"${m}","count":4}`))
            && regs.CFSR === 0x03020100 && regs.AFSR === 0x03020100, { regs, calls: calls.map((c) => c.json) });
        calls.length = 0;
        const scs = await ex.readMemory('0xE000ED00', 12);
        check('F2 a read_memory in the SCS goes word by word too', eq(calls.map((c) => c.json), ['0xe000ed00', '0xe000ed04', '0xe000ed08'].map((m) => `{"memoryReference":"${m}","count":4}`))
            && scs.bytes.length === 12 && scs.offset === 0, calls.map((c) => c.json));
        calls.length = 0;
        await ex.readExceptionFrame(0x20001000);
        check('F3 exception frame', calls[0].json === '{"memoryReference":"0x20001000","count":32}');
        calls.length = 0;
        await ex.readExceptionFrame(0x30000f00, undefined, 0x28);
        check('F3 exception frame behind the additional state context: 0x28 + 32 bytes from SP up',
            calls[0].json === '{"memoryReference":"0x30000f00","count":72}', calls.map((c) => c.json));
        const info = await ex.getFaultInfo();
        check('F getFaultInfo text', info.startsWith('=== Cortex-M Fault Analysis ==='));
        reset();
        const e = await rejects(new DebuggingExecutor().readFaultRegisters());
        console.log(`       fault no session: ${e && e.message}`);
    }
    reset();
    {
        // The stacked frame counts only when it begins where it was asked for; the fault registers are words.
        const { session, calls } = makeSession((c, a) => {
            if (c !== 'readMemory') { throw new Error('?'); }
            if (a.memoryReference === '0x1ffffff0') { return { address: '0x20000000', data: b64(Array(16).fill(0xaa)) }; }
            if (a.count === 24) { return { address: '0xE000ED2C', data: b64(Array.from({ length: 24 }, (_, i) => i)) }; }
            return { data: le(0x11).toString('base64') };
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        const frame = await ex.readExceptionFrame(0x1ffffff0);
        check('F4 a stacked frame whose start cannot be read has no bytes, not those after the hole', frame.length === 0, [...frame]);
        const regs = await ex.readFaultRegisters();
        check('F4 the fault registers are six word reads, none of 24 bytes', regs.CFSR === 0x11 && regs.AFSR === 0x11
            && calls.filter((c) => c.args.count === 4).length === 6 && !calls.some((c) => c.args.count === 24), regs);
    }
    reset();
    {
        const { session } = makeSession((c) => { if (c === 'readMemory') { return never(); } throw new Error('?'); });
        focusOn(session);
        const e = await rejects(new DebuggingExecutor({ dapRequestMs: 60 }).readFaultRegisters());
        check('F timeout in the first word read, DHCSR times out too → PROBE_WEDGED (#3)', e && e.code === 'PROBE_WEDGED'
            && e.message.startsWith('Memory reads time out and the debug port does not answer (DHCSR at 0xE000EDF0 timed out). Reading 0xE000ED28'), String(e));
    }

    // ── Peripheral registers: the SVD gives the address, no other extension is asked ──
    reset();
    {
        // The Peripheral Inspector as the CMSIS Debugger's extension pack installs it, not yet active.
        // Its API (1.10.0) registers SVD files and parsers and reloads its view; nothing in it reads a register.
        const PERIPHERAL_INSPECTOR = 'eclipse-cdt.peripheral-inspector';
        const api = {
            registerSVDFile() {}, getSVDFile: () => undefined, getSVDFileFromCortexDebug: async () => undefined,
            registerPeripheralsProvider() {}, getInterruptTable: () => undefined, loadPeripheralsForSession: async () => {},
        };
        const inspector = { id: PERIPHERAL_INSPECTOR, isActive: false, exports: undefined };
        let activations = 0;
        inspector.activate = async () => { activations++; inspector.isActive = true; inspector.exports = api; return api; };
        const asked = [];
        stub.extensions.getExtension = (id) => { asked.push(id); return id === PERIPHERAL_INSPECTOR ? inspector : undefined; };
        try {
            const e = await rejects(new DebuggingExecutor().readPeripheralRegister('RCC', 'CR'));
            check('P1 no session: the no-session error before anything else; the Peripheral Inspector is not asked',
                e && e.message === 'No debug session is running in this window' && !asked.includes(PERIPHERAL_INSPECTOR) && activations === 0,
                { error: e && e.message, asked, activations });
            asked.length = 0; activations = 0; inspector.isActive = false; inspector.exports = undefined;
            const svdFile = path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures', 'test-device.svd');
            const { session, calls } = makeSession((c, a) => {
                if (c === 'readMemory' && a.memoryReference === '0x40023800') { return { data: b64(le(0x03000083)) }; }
                throw new Error(`unexpected ${c}`);
            }, { type: 'gdbtarget', name: 'Cfg', svdFile });
            focusOn(session);
            const text = await new DebuggingExecutor().readPeripheralRegister('RCC', 'CR');
            check('P2 the word at the SVD address, fields decoded; the Peripheral Inspector is neither asked nor activated',
                text.startsWith('RCC.CR @ 0x40023800 = 0x03000083\n') && text.includes('HSION') && !asked.includes(PERIPHERAL_INSPECTOR) && activations === 0
                && eq(calls.map((c) => c.command + ' ' + c.json), ['readMemory {"memoryReference":"0x40023800","count":4}']),
                { text, asked, activations, calls: calls.map((c) => c.command + ' ' + c.json) });
        } finally {
            stub.extensions.getExtension = () => undefined;
        }
    }

    // ── A wedged probe told apart from an unreadable address (#3) ──
    reset();
    {
        let dhcsr = 'readable';
        const { session, calls } = makeSession((c, a) => {
            if (c === 'readMemory') {
                if (a.memoryReference === '0xE000EDF0') {
                    if (dhcsr.startsWith('readable')) { return { data: le(0x000b0003).toString('base64') }; }
                    if (dhcsr === 'hang') { return never(); }
                    throw new Error('Unable to read memory.');
                }
                if (a.memoryReference === '0x20000000' && dhcsr === 'readable-slow') { return never(); }
                throw new Error(`Unable to read memory. (@ ${a.memoryReference})`);
            }
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (String(a.expression).startsWith('>')) { throw new Error('Unable to read memory.'); }
            return { result: 'Error: could not evaluate expression' };
        }, { type: 'gdbtarget', name: 'Cfg', request: 'attach' });
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 100 });
        const unreadable = await rejects(ex.readMemory('0x60000000', 8));
        check('W1 DHCSR readable after a failed read → INVALID_ARGUMENT naming the address', unreadable && unreadable.code === 'INVALID_ARGUMENT'
            && unreadable.message === 'Cannot read 0x60000000 — the debug port answers, the address is not readable in this state: '
                + 'DAP readMemory: Unable to read memory. (@ 0x60000000); watch expression: no value in \'Error: could not evaluate expression\'; '
                + 'MI read: Unable to read memory.', unreadable && unreadable.message);
        check('W1 requests: the read, the ladder of the first word, then DHCSR once', eq(calls.map((c) => c.command + ' ' + (c.args.memoryReference ?? c.args.expression ?? '')), [
            'readMemory 0x60000000', 'evaluate *(unsigned int*)0x60000000', 'evaluate >-data-read-memory-bytes 0x60000000 4', 'readMemory 0xE000EDF0']),
        calls.map((c) => c.command + ' ' + c.json));
        check('W1 the port answered with S_LOCKUP set', (await ex.probeDebugPort()).dhcsr === 0x000b0003);

        dhcsr = 'fails';
        calls.length = 0;
        const wedged = await rejects(ex.readFaultRegisters());
        check('W2 fault registers on a wedged probe: PROBE_WEDGED after both ways failed, DHCSR read once, the attach hint', wedged && wedged.code === 'PROBE_WEDGED'
            && wedged.message.startsWith('Memory reads fail and the debug port does not answer (DHCSR at 0xE000EDF0 unreadable: Unable to read memory.). Reading 0xE000ED28 — ')
            && wedged.message.includes('DAP readMemory: Unable to read memory. (@ 0xE000ED28)')
            && calls.filter((c) => c.args.memoryReference === '0xE000EDF0').length === 1
            && wedged.hint.startsWith('This session is attached to a GDB server that lives as long as its CMSIS Run task: cmsis_action detach, then cmsis_action attach'),
        wedged && `${wedged.code} ${wedged.message} / ${wedged.hint}`);

        dhcsr = 'hang';
        const hung = await rejects(ex.readMemoryWord('0x20000004'));
        check('W3 a DHCSR read that times out after a failed read → PROBE_WEDGED', hung && hung.code === 'PROBE_WEDGED'
            && hung.message.startsWith('Memory reads fail and the debug port does not answer (DHCSR at 0xE000EDF0 timed out).'), hung && hung.message);

        dhcsr = 'readable-slow';
        const slow = await rejects(ex.readMemoryWord('0x20000000'));
        check('W4 a read that times out on a port that answers keeps its timeout', slow instanceof HardwareTimeoutError && slow.operation === 'DAP readMemory', String(slow));

        reset();
        const none = await new DebuggingExecutor().probeDebugPort();
        check('W5 no session: the port does not answer, and nothing throws', none.readable === false && none.cause === 'No debug session is running in this window', none);
    }

    // ── Reset ──
    async function resetCase(name, { config, stopped = true, method, halt, words = {}, pc = '0x08000100 <Reset_Handler>', monitorReply = () => ({ result: '' }), stopEvents, pauseStops = false, terminateDuringWait = false }) {
        reset();
        const cfg = { type: 'gdbtarget', name: 'Cfg', ...(config ?? {}) };
        const gdbCommands = [];
        let t;
        const { session, calls } = makeSession((c, a) => {
            if (c === 'readMemory') {
                if (!(a.memoryReference in words)) { throw new Error('unreadable'); }
                return { data: le(words[a.memoryReference]).toString('base64') };
            }
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (c === 'evaluate' && a.expression === '$pc') { return { result: typeof pc === 'function' ? pc() : pc }; }
            if (c === 'evaluate' && a.context === 'repl' && a.expression.startsWith('>')) {
                const command = a.expression.slice(1);
                gdbCommands.push(command);
                if (terminateDuringWait && command.startsWith('monitor ')) { setTimeout(() => event(t, 'terminated'), 50); }
                return monitorReply(command);
            }
            if (c === 'pause') { if (pauseStops) { setTimeout(() => event(t, 'stopped', { reason: 'pause', threadId: 1 }), 5); } return undefined; }
            if (c === 'continue') { return undefined; }
            throw new Error(`? ${c}`);
        }, cfg, name);
        focusOn(session);
        t = trackerFor(session);
        event(t, stopped ? 'stopped' : 'continued', { reason: 'breakpoint', threadId: 1 });
        const ex = new DebuggingExecutor();
        const t0 = Date.now();
        const out = await ex.resetTarget({ method, halt });
        return { out, calls, gdbCommands, ms: Date.now() - t0 };
    }
    {
        const { out, calls, gdbCommands, ms } = await resetCase('pyOCD S', { config: { target: { server: 'pyocd' } }, method: 'auto', words: { '0xE000ED08': 0, '0x00000004': 0x08000101 } });
        check('RS1 the reset command reaches GDB with `>`, then GDB\'s caches are flushed (#56)',
            eq(gdbCommands, ['monitor reset halt system', 'maintenance flush register-cache', 'maintenance flush dcache']), gdbCommands);
        check('RS1 pyocd verified', out.serverKind === 'pyocd' && eq(out.commandsIssued, ['monitor reset halt system']) && eq(out.replies, ['<no echo from adapter>'])
            && eq(out.methodsTried, ['system']) && out.verified === true && out.verificationDetail === 'PC=0x08000100 matches the reset vector (0x08000100, vector table at 0x00000000)'
            && out.haltedByUs === false && out.resumed === false, out);
        check('RS1 timing ~3.5 s', ms >= 3400 && ms < 4500, ms);
        check('RS1 VTOR exact reference, vector at 0x00000004', calls.some((c) => c.json === '{"memoryReference":"0xE000ED08","count":4}') && calls.some((c) => c.json === '{"memoryReference":"0x00000004","count":4}'));
    }
    {
        const { out, calls, gdbCommands } = await resetCase('J-Link S', { config: { target: { server: 'JLinkGDBServer' } }, method: 'core', monitorReply: (cmd) => ({ result: cmd === 'monitor reset 1' ? 'Unknown monitor command' : '' }) });
        check('RS2 jlink core unsupported', out.serverKind === 'jlink' && eq(out.commandsIssued, ['monitor halt', 'monitor reset 1']) && out.verificationDetail === unsupportedResetDetail('core', 0)
            && !calls.some((c) => c.command === 'readMemory') && out.verified === false, out);
        check('RS2 no cache flush after a command the server did not know', eq(gdbCommands, ['monitor halt', 'monitor reset 1']), gdbCommands);
    }
    {
        const { out, calls } = await resetCase('S', { method: 'auto', halt: false, words: { '0xE000ED08': 0x08000000, '0x08000004': 0x08000199 }, pc: '0x8000256 <delay_ms+14>' });
        check('RS3 all methods, unverified, no continue', eq(out.methodsTried, ['system', 'core', 'hardware']) && out.verified === false
            && out.verificationDetail === 'PC=0x08000256 does NOT match the reset vector 0x08000198 (vector table at 0x08000000)' && !calls.some((c) => c.command === 'continue') && out.resumed === false, out);
        check('RS6 vector read at 0x08000004', calls.some((c) => c.json === '{"memoryReference":"0x08000004","count":4}'));
    }
    {
        const { out, calls, ms } = await resetCase('S', { stopped: false, method: 'system' });
        check('RS4 running, pause did not stop', out.verificationDetail === 'could not halt the target to issue the reset (pause did not stop it within 5 s)' && out.commandsIssued.length === 0
            && out.haltedByUs === false && calls[0].command === 'pause' && ms >= 4900, { out, ms });
    }
    {
        const { out, calls } = await resetCase('S', { stopped: false, pauseStops: true, method: 'system', halt: false, words: { '0xE000ED08': 0, '0x00000004': 0x08000101 } });
        const order = calls.map((c) => c.command);
        check('RS5 halted by us, verified, resumed', out.haltedByUs === true && out.verified === true && out.resumed === true && order[0] === 'pause' && order[order.length - 1] === 'continue', { out, order });
    }
    {
        const { out } = await resetCase('S', { method: 'system', terminateDuringWait: true, words: { '0xE000ED08': 0, '0x00000004': 0x08000101 } });
        check('RS5 terminated during wait', out.verificationDetail === 'debug session ended during the reset' && out.verified === false, out);
    }
    {
        const { out } = await resetCase('S', { method: 'system', words: { '0xE000ED08': 0x08000000, '0x08000004': 0x08000199 }, pc: 'xyz' });
        check('RS6 unparsable pc', out.verificationDetail === "verification reads failed: could not parse PC from 'xyz'", out.verificationDetail);
    }
    {
        const { out } = await resetCase('S', { method: 'system', words: { '0x00000004': 0x08000101 } });
        check('RS VTOR failure → base 0 silently', out.verified === true && out.verificationDetail.endsWith('vector table at 0x00000000)'), out.verificationDetail);
    }
    {
        // A J-Link part that only a pull of its reset pin re-vectors: the last step of `auto` is J-Link's reset-pin strategy (2), not its normal reset (0) again.
        let pinPulled = false;
        const { out } = await resetCase('J-Link S', {
            config: { target: { server: 'JLinkGDBServer' } }, method: 'auto', words: { '0xE000ED08': 0, '0x00000004': 0x08000101 },
            monitorReply: (cmd) => { pinPulled = pinPulled || cmd === 'monitor reset 2'; return { result: '' }; },
            pc: () => (pinPulled ? '0x08000100 <Reset_Handler>' : '0x08000256 <delay_ms+14>'),
        });
        check('RS7 jlink auto: normal, core, then the reset pin, which verifies', eq(out.methodsTried, ['system', 'core', 'hardware']) && out.verified === true
            && eq(out.commandsIssued, ['monitor halt', 'monitor reset 0', 'monitor halt', 'monitor reset 1', 'monitor halt', 'monitor reset 2']), out);
    }

    // ── Threads, stack, variables, evaluate, device info ──
    reset();
    {
        let outstanding = 0;
        let maxOutstanding = 0;
        const { session, calls } = makeSession((c, a) => {
            if (c === 'threads') { return { threads: Array.from({ length: 40 }, (_, i) => (i === 5 ? { id: i + 1 } : { id: i + 1, name: `t${i + 1}` })) }; }
            if (c === 'stackTrace') {
                outstanding++;
                maxOutstanding = Math.max(maxOutstanding, outstanding);
                return new Promise((res, rej) => setTimeout(() => {
                    outstanding--;
                    if (a.threadId === 3) { rej(new Error('bad')); } else { res({ stackFrames: [{ id: 7, name: 'fn', source: { path: '/p/a.c' }, line: 3, column: 0 }] }); }
                }, 5));
            }
            throw new Error('?');
        });
        focusOn(session);
        const threads = await new DebuggingExecutor().getThreads();
        const st = calls.filter((c) => c.command === 'stackTrace');
        check('T1 40 threads, unnamed', threads.length === 40 && threads[5].name === 'thread-6' && threads[0].name === 't1', threads.slice(0, 7));
        check('T1 32 stackTrace levels 1, ≤4 outstanding', st.length === 32 && st.every((c) => c.json === `{"threadId":${c.args.threadId},"startFrame":0,"levels":1}`) && maxOutstanding === 4, { n: st.length, maxOutstanding });
        check('T1 failed leaves no topFrame; beyond 32 none', threads[2].topFrame === undefined && threads[35].topFrame === undefined && eq(threads[0].topFrame, { name: 'fn', source: '/p/a.c', line: 3 }) && !('frameId' in threads[0].topFrame), threads[0]);
    }
    reset();
    {
        const { session, calls } = makeSession(() => ({ stackFrames: [{ name: '', source: { name: 'n.c' } }, { id: 0, name: 'm', source: { path: '/x/m.c', name: 'm.c' }, line: 4, column: 2 }] }));
        focusOn(session);
        const frames = await new DebuggingExecutor().getCallStack();
        check('T2 call stack request', calls[0].json === '{"threadId":1,"startFrame":0,"levels":50}', calls[0].json);
        check('T2 mapping', eq(frames, [{ name: 'unknown', source: 'n.c' }, { name: 'm', source: '/x/m.c', line: 4, column: 2, frameId: 0 }]) && !('frameId' in frames[0]), frames);
        calls.length = 0;
        await new DebuggingExecutor().getCallStack(0, 3, 500);
        check('T2 thread 0 given', calls[0].json === '{"threadId":0,"startFrame":0,"levels":3}', calls[0].json);
    }
    reset();
    {
        let varsFail = false;
        let scopes = [{ name: 'Locals', variablesReference: 1 }, { name: 'Globals', variablesReference: 2 }, { name: 'Registers', variablesReference: 3 }];
        const { session, calls } = makeSession((c, a) => {
            if (c === 'scopes') { return scopes === 'hang' ? never() : { scopes }; }
            if (c === 'variables') { if (varsFail) { throw new Error('vars bad'); } return { variables: [{ name: 'v' + a.variablesReference }] }; }
            throw new Error('?');
        });
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 80 });
        const r = await ex.getVariables(3, 'local');
        check('V3 local filter', calls.length === 2 && calls[0].json === '{"frameId":3}' && calls[1].json === '{"variablesReference":1}' && r.scopes.length === 1 && r.scopes[0] === scopes[0] && eq(r.scopes[0].variables, [{ name: 'v1' }]), calls.map((c) => c.json));
        varsFail = true;
        const r2 = await ex.getVariablesForFrame(3, 'global');
        check('V3 rejected variables', r2.scopes.length === 1 && eq(r2.scopes[0].variables, []) && r2.scopes[0].error === 'vars bad', r2);
        scopes = [];
        check('V3 empty scopes', eq(await ex.getVariables(3), { scopes: [] }));
        scopes = 'hang';
        const e = await rejects(ex.getVariables(3));
        // KB14 flattens the class; since #11 the wrap keeps the error code, TIMEOUT.
        check('V3 scopes timeout → Error with HardwareTimeoutError: and the code TIMEOUT', e && !(e instanceof HardwareTimeoutError) && e.message.includes('HardwareTimeoutError:') && e.code === 'TIMEOUT', e && `${e.code} ${e.message}`);
        console.log(`       S9 text: ${e && e.message.slice(0, 60)}`);
        reset();
        const e2 = await rejects(ex.getVariables(3));
        console.log(`       S9 no session: ${e2 && e2.message}`);
    }
    reset();
    {
        // cdt-gdb-adapter marks its Registers scope expensive: every core and FPU register, read over the probe.
        let scopes = [{ name: 'Local', variablesReference: 1, expensive: false }, { name: 'Registers', variablesReference: 2, expensive: true }];
        const answer = (c, a) => {
            if (c === 'scopes') { return { scopes: scopes.map((s) => ({ ...s })) }; }
            if (c === 'variables') { return { variables: [{ name: 'v' + a.variablesReference }] }; }
            throw new Error('?');
        };
        const { session, calls } = makeSession(answer);
        focusOn(session);
        const ex = new DebuggingExecutor();
        const reads = () => calls.filter((c) => c.command === 'variables').map((c) => c.args.variablesReference);
        const r = await ex.getVariables(3);
        check('V4 all on the CMSIS Debugger: the expensive Registers scope is not read, and named', eq(reads(), [1])
            && eq(r, { scopes: [{ name: 'Local', variablesReference: 1, expensive: false, variables: [{ name: 'v1' }] }], skipped: ['Registers'] }), r);
        calls.length = 0;
        const r2 = await ex.getVariablesForFrame(3, 'all');
        check('V4 get_frame_variables\' all leaves it out too', eq(reads(), [1]) && eq(r2.skipped, ['Registers']), r2);
        scopes = [...scopes, { name: 'Global', variablesReference: 4, expensive: true }];
        calls.length = 0;
        const r3 = await ex.getVariables(3, 'global');
        check('V4 an explicit scope is read although expensive', eq(reads(), [4]) && r3.scopes.length === 1 && r3.skipped === undefined, r3);
        calls.length = 0;
        const r4 = await ex.getVariables(3, 'all');
        check('V4 an expensive scope of program variables is read; only the register scope is left out (K03)', eq(reads(), [1, 4])
            && eq(r4.skipped, ['Registers']), r4);
        scopes = [{ name: 'Local', variablesReference: 1, expensive: false }, { name: 'Statics', variablesReference: 7, expensive: true },
            { name: 'Core', variablesReference: 8, expensive: true, presentationHint: 'registers' }];
        calls.length = 0;
        const r4b = await ex.getVariables(3, 'all');
        check('V4 a register scope by its presentationHint is left out, Statics read', eq(reads(), [1, 7]) && eq(r4b.skipped, ['Core']), r4b);
        scopes = [{ name: 'Registers', variablesReference: 2, expensive: true }];
        calls.length = 0;
        const r5 = await ex.getVariables(3);
        check('V4 nothing but expensive scopes: all are read', eq(reads(), [2]) && r5.scopes.length === 1 && r5.skipped === undefined, r5);

        // js-debug marks Global and Module expensive; other adapters keep every scope.
        scopes = [{ name: 'Local', variablesReference: 1, expensive: false }, { name: 'Module', variablesReference: 5, expensive: true },
            { name: 'Global', variablesReference: 6, expensive: true }];
        const node = makeSession(answer, { type: 'pwa-node', name: 'Node' });
        focusOn(node.session);
        const r6 = await ex.getVariables(3);
        check('V4 other adapters: all reads every scope, expensive or not', eq(node.calls.filter((c) => c.command === 'variables').map((c) => c.args.variablesReference), [1, 5, 6])
            && r6.scopes.length === 3 && r6.skipped === undefined, r6);
    }
    reset();
    {
        const body = { result: '42', type: 'int', variablesReference: 0 };
        const { session, calls } = makeSession(() => body);
        focusOn(session);
        const ex = new DebuggingExecutor();
        const r = await ex.evaluateExpression('x', 4);
        check('E4 evaluate', calls[0].json === '{"expression":"x","frameId":4,"context":"repl"}' && r === body);
        session.customRequest = () => Promise.reject(new Error('eval bad'));
        const e = await rejects(ex.evaluateExpression('x', 4));
        console.log(`       S10 text: ${e && e.message}`);
    }
    reset();
    {
        const listed = [{ name: 'period_ms', value: '500', type: 'uint32_t', variablesReference: 0 }, { name: 'broken' }, null];
        const { session, calls } = makeSession(() => ({ variables: listed }));
        focusOn(session);
        const ex = new DebuggingExecutor();
        const children = await ex.getVariableChildren(7, 900);
        check('E6 children: one variables request, entries without a value dropped',
            calls.length === 1 && calls[0].json === '{"variablesReference":7}' && eq(children, [listed[0]]), calls.map((c) => c.json));
        session.customRequest = () => Promise.reject(new Error('Invalid variable reference'));
        const e = await rejects(ex.getVariableChildren(7));
        check('E6 children: a failure is wrapped', e && e.message === 'Reading the fields failed: Invalid variable reference', e && e.message);
    }
    reset();
    {
        const { session } = makeSession(() => undefined, { type: 'gdbtarget', program: 'a.elf', target: { server: 'pyocd', port: 3333 }, cmsis: { cbuildRunFile: 'x.cbuild-run.yml' } }, 'S');
        focusOn(session);
        const info = await new DebuggingExecutor().getDeviceInfo();
        check('D5 device info', info === '=== Debug Session Info ===\n  Session name: S\n  Debug type: gdbtarget\n  Program: a.elf\n  GDB: <default>\n  Server: pyocd\n  Port: 3333\n  cbuild-run: x.cbuild-run.yml\n', info);
        const s2 = makeSession(() => undefined, {}, 'T');
        focusOn(s2.session);
        const info2 = await new DebuggingExecutor().getDeviceInfo();
        check('D5 fallbacks, no cbuild-run', info2 === '=== Debug Session Info ===\n  Session name: T\n  Debug type: <unknown>\n  Program: <unknown>\n  GDB: <default>\n  Server: <unknown>\n  Port: <unknown>\n', info2);
    }
    reset();
    {
        const { session } = makeSession(() => undefined);
        focusOn(session);
        stub.debug.stopDebugging = async (s) => { stub.stopped = s; };
        await new DebuggingExecutor().stopDebugging();
        check('stopDebugging default target', stub.stopped === session);
        reset();
        stub.stopped = 'untouched';
        await new DebuggingExecutor().stopDebugging();
        check('stopDebugging nothing to stop', stub.stopped === 'untouched');
        stub.debug.stopDebugging = async () => { throw new Error('stop bad'); };
        const e = await rejects(new DebuggingExecutor().stopDebugging(session));
        console.log(`       S5 text: ${e && e.message}`);
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        stub.debug.addBreakpoints = () => { throw new Error('add bad'); };
        console.log(`       S7 text: ${(await rejects(ex.addBreakpoint(stub.Uri.file('/a'), 1))).message}`);
        stub.debug.breakpoints = [new stub.SourceBreakpoint(new stub.Location(stub.Uri.file('/a'), new stub.Position(0, 0)), true)];
        stub.debug.removeBreakpoints = () => { throw new Error('remove bad'); };
        console.log(`       S8 text: ${(await rejects(ex.removeBreakpoint(stub.Uri.file('/a'), 1))).message}`);
    }

    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error', e); process.exit(2); });
