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

// Two-window routing check for CMSIS Developer Assistant.
//
// Stands up two WindowCoordinators against a shared temporary registry, with a
// stubbed `vscode`, and drives the router's MCP endpoint with a real MCP client.
// No board and no VS Code required.
//
// Covers:
//   1. Exactly one window binds the well-known port; the other becomes a worker.
//   2. Both windows publish themselves to the registry.
//   3. list_debug_windows reports both.
//   4. A path hint routes to the window owning that folder.
//   5. A later path-less call sticks to that same window.
//   6. A path-less call with no hint routes to the sole window that has an
//      active debug session.
//   7. With both windows debugging, a path-less call is refused as
//      AMBIGUOUS_WINDOW and both windows come back as candidates (#11).
//   8. Closing the router frees the port and a worker is promoted.
//   9. The routed tools/list, what agents see, stays within its byte budget.
//  10. Window selection for people (#16): each window publishes its role and
//      shows it in the status bar; the routed tools/list offers window on
//      exactly the listed tools; cmsis_action {window} runs in the named
//      window and re-aims the session; Select Target Window (the stub's
//      quick pick) saves a default that resolves the tie of two idle windows
//      and moves a session that had a target; the router's tooltip lists the
//      sessions; Automatic clears it; the promoted window shows its new role.
//  11. The problem journal is per window (#48): get_recent_problems and the
//      count in get_session_status come from the window the session targets.
//  12. The control channel's fences (#14): a worker whose handler never
//      answers returns WORKER_TIMEOUT inside the router's budget (a small
//      timeoutInSeconds and shortened margins) and shows the call past its
//      fence in its status bar; only for an op that can wait for a picker or
//      dialog does it tell its user, once. After failover the
//      new router answers a session id of the old one with 404 and -32001,
//      the answer that tells a client to initialize again.
//  13. Two windows on one GDB port: each window publishes the GDB ports its
//      sessions and CMSIS Run tasks use (an injected source here), the other
//      window reads them from the registry, and the listing names them.

const stub = require('./vscode-stub.js');

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) { failures++; }
}

const REGISTRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-twowindow-'));
// The router's well-known port; CDA_ROUTER_TEST_PORT lets concurrent runs (several checkouts) use their own.
const PORT = Number(process.env.CDA_ROUTER_TEST_PORT) || 39117;

// Point the registry at the temp dir and give each coordinator its own identity
// and its own view of `vscode`, since a real window has both.
const { WorkspaceRegistry } = require(path.join(OUT, 'utils', 'workspaceRegistry.js'));
const origRegistry = WorkspaceRegistry;

const { ProblemJournal } = require(path.join(OUT, 'core', 'problemJournal.js'));

function makeWindow(pid, folder, name) {
    const registry = new origRegistry(pid, REGISTRY_DIR, () => true);
    // Two windows in one process: each gets a problem journal of its own, as two extension hosts would have.
    return { pid, folder, name, registry, journal: new ProblemJournal() };
}

// The coordinator reads vscode.workspace.* and vscode.debug.* at publish time.
// Swap those per window around each call.
// Must be awaited around async work: restoring the stub synchronously while
// `fn()`'s promise is still pending means publish() sees the wrong window.
async function withWindowContext(win, activeSession, fn) {
    const prevFolders = stub.workspace.workspaceFolders;
    const prevName = stub.workspace.name;
    const prevSession = stub.debug.activeDebugSession;
    stub.workspace.workspaceFolders = [{ uri: { fsPath: win.folder } }];
    stub.workspace.name = win.name;
    stub.debug.activeDebugSession = activeSession;
    try {
        return await fn();
    } finally {
        stub.workspace.workspaceFolders = prevFolders;
        stub.workspace.name = prevName;
        stub.debug.activeDebugSession = prevSession;
    }
}

function post(port, headers, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'POST',
            agent: false,
            headers: {
                'Host': `127.0.0.1:${port}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers,
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

function parseSse(text) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text);
}

async function openSession(port) {
    const init = await post(port, {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'two-window', version: '1' } },
    });
    const sid = init.headers['mcp-session-id'];
    await post(port, { 'mcp-session-id': sid }, { jsonrpc: '2.0', method: 'notifications/initialized' });
    return sid;
}

async function callToolResult(port, sid, name, args, id) {
    const res = await post(port, { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    });
    const parsed = parseSse(res.body);
    return parsed?.result ?? { content: [{ type: 'text', text: JSON.stringify(parsed) }] };
}

async function callTool(port, sid, name, args, id) {
    return (await callToolResult(port, sid, name, args, id)).content?.[0]?.text ?? '';
}

/** The line of a window listing that names `folder`. */
function rowOf(listing, folder) {
    return listing.split('\n').find((line) => line.includes(folder)) ?? '';
}

async function main() {
    const { WindowCoordinator } = require(path.join(OUT, 'windowCoordinator.js'));
    const { WINDOW_ARGUMENT_TOOLS } = require(path.join(OUT, 'debugTools.js'));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-projects-'));
    const alphaDir = path.join(root, 'alpha');
    // A non-ASCII folder name: the path crosses the registry file, the router and the MCP reply as UTF-8.
    const betaDir = path.join(root, 'beta-😀');
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });

    const alpha = makeWindow(600001, alphaDir, 'alpha');
    const beta = makeWindow(600002, betaDir, 'beta');

    const context = { subscriptions: [] };

    // Each coordinator gets its own registry instance (own pid + temp dir),
    // which is what two real windows look like. A tool timeout of 1 s and a
    // forward margin of 2 s make a forward's budget 3 s, and the worker's
    // fence 1 s inside it (#14): the check of the fence waits 2 s, not 190.
    // Beta's CMSIS Run serves pyOCD's port; alpha uses none.
    const betaPorts = [{ port: 3333, source: 'cmsis-run', label: 'CMSIS Run', server: 'pyOCD' }];
    const makeCoordinator = (win) => new WindowCoordinator({
        port: PORT, timeoutInSeconds: 1, hardwareTimeouts: {}, registry: win.registry, journal: win.journal,
        timings: { forwardMarginMs: 2_000, fenceMarginMs: 1_000 },
        gdbPorts: async () => (win === beta ? betaPorts : []),
    });

    const c1 = makeCoordinator(alpha);
    const c2 = makeCoordinator(beta);

    await withWindowContext(alpha, undefined, () => c1.start(context));
    await withWindowContext(beta, undefined, () => c2.start(context));

    check('exactly one window became the router',
        (c1.isRouter() ? 1 : 0) + (c2.isRouter() ? 1 : 0) === 1,
        `alpha=${c1.isRouter()} beta=${c2.isRouter()}`);
    check('both windows advertise the same endpoint',
        c1.getEndpoint() === c2.getEndpoint() && c1.getEndpoint().endsWith(`:${PORT}`),
        c1.getEndpoint());

    const registered = alpha.registry.list();
    check('both windows are in the registry', registered.length === 2, `${registered.length} entries`);

    // #16: each entry says what its window does, and each window shows it in the status bar.
    const roleOf = (c) => (c.isRouter() ? 'router' : 'worker');
    const published = Object.fromEntries(registered.map((w) => [w.pid, w.role]));
    check('each window publishes its role', published[alpha.pid] === roleOf(c1) && published[beta.pid] === roleOf(c2),
        JSON.stringify(published));
    // The stub keeps its items in creation order, and alpha's coordinator started first.
    const [alphaItem, betaItem] = stub.statusBarItems;
    check('each window shows its role in the status bar, and a click on it selects the target window',
        alphaItem?.text === `$(cda-robot) ${c1.isRouter() ? 'R' : 'W'}` && betaItem?.text === `$(cda-robot) ${c2.isRouter() ? 'R' : 'W'}`
            && alphaItem.visible && betaItem.visible && alphaItem.name === 'CMSIS Developer Assistant'
            && alphaItem.command === 'cmsis-developer-assistant.selectTargetWindow',
        `${alphaItem?.text} / ${betaItem?.text}`);

    const sid = await openSession(PORT);

    // The routed list is what agents see: a router always routes, so it adds
    // list_debug_windows and select_debug_window to the single-window list
    // that session-lifecycle.js measures, and the window argument (#16). It
    // rides along on every agent turn. 47 tools measured 30 104 bytes in
    // 2.5.0; the budget leaves room for the 2.5.1 additions
    // (get_recent_problems, serial_capture, the window argument).
    // Raised from 34 000 for the knowledge tools, which are on in every session (35 301 measured).
    // Raised from 36 000 for cmsis_query and cmsis_action create_solution (36 373 measured).
    const ROUTED_TOOLS_LIST_BUDGET_BYTES = 37_000;
    const routedList = await post(PORT, { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 90, method: 'tools/list', params: {} });
    const routedTools = parseSse(routedList.body)?.result?.tools ?? [];
    const routedBytes = Buffer.byteLength(JSON.stringify(routedTools));
    check(`the routed tools/list stays under the ${ROUTED_TOOLS_LIST_BUDGET_BYTES} byte budget`,
        routedTools.length > 30 && routedBytes <= ROUTED_TOOLS_LIST_BUDGET_BYTES, `${routedTools.length} tools, ${routedBytes} bytes`);
    const withWindow = routedTools.filter((t) => t.inputSchema?.properties?.window !== undefined).map((t) => t.name).sort();
    const listed = [...WINDOW_ARGUMENT_TOOLS].filter((name) => routedTools.some((t) => t.name === name)).sort();
    check('the routed tools/list offers window on exactly the listed tools',
        JSON.stringify(withWindow) === JSON.stringify(listed) && ['cmsis_action', 'flash', 'reset', 'serial_open'].every((n) => withWindow.includes(n)),
        withWindow.join(', '));

    const listing = await callTool(PORT, sid, 'list_debug_windows', {}, 2);
    check('list_debug_windows reports both windows and marks the router',
        listing.includes(alphaDir) && listing.includes(betaDir) && rowOf(listing, c1.isRouter() ? alphaDir : betaDir).includes(' | router'),
        listing.replace(/\n/g, ' | '));
    const betaSeen = alpha.registry.list().find((entry) => entry.pid === beta.pid);
    check('a window\'s GDB ports reach the other window through the registry, and the listing names them',
        JSON.stringify(betaSeen?.gdbPorts) === JSON.stringify(betaPorts) && rowOf(listing, betaDir).includes(' | GDB port 3333 (CMSIS Run)')
            && !rowOf(listing, alphaDir).includes('GDB port'),
        `${JSON.stringify(betaSeen?.gdbPorts)} | ${rowOf(listing, betaDir)}`);

    // #16: two idle windows are a tie for a path-less call.
    const idleTie = await callToolResult(PORT, sid, 'read_memory', { address: '0x20000000', length: 4 }, 20);
    const idleData = idleTie.structuredContent ?? {};
    check('two idle windows are refused as AMBIGUOUS_WINDOW; the hint names the status bar, the candidates isDefault and role',
        idleTie.isError === true && idleData.error_code === 'AMBIGUOUS_WINDOW' && /Select Target Window/.test(idleData.hint ?? '')
            && (idleData.candidates ?? []).length === 2
            && (idleData.candidates ?? []).every((c) => c.isDefault === false && c.role === published[c.pid]),
        JSON.stringify(idleData.candidates));

    // The knowledge index needs no window: a tie sends knowledge_search to the router's own window instead of refusing it.
    // Without pack-docs handlers in this harness the worker answers TOOL_DISABLED, which shows the call was routed.
    const idleSearch = await callToolResult(PORT, sid, 'knowledge_search', { query: 'HardFault' }, 120);
    const idleSearchData = idleSearch.structuredContent ?? {};
    check('knowledge_search runs in the router\'s own window when two idle windows tie, instead of AMBIGUOUS_WINDOW',
        idleSearchData.error_code === 'TOOL_DISABLED' && /not available in this window/.test(idleSearch.content?.[0]?.text ?? ''),
        `${idleSearchData.error_code}: ${(idleSearch.content?.[0]?.text ?? '').split('\n')[0]}`);

    // The window argument names the window for one call, by pid or by path, and re-aims the session.
    const tooltipCall = (item) => (item.tooltip ?? '').split('\n').find((line) => line.startsWith('Last agent call here:')) ?? '';
    const byPid = await callToolResult(PORT, sid, 'cmsis_action', { action: 'status', window: String(beta.pid) }, 21);
    const byPidText = byPid.content?.[0]?.text ?? '';
    check('cmsis_action {window: pid} runs in the named window',
        byPid.isError !== true && /^No CMSIS job in this window/.test(byPidText)
            && tooltipCall(betaItem).startsWith('Last agent call here: cmsis_action') && !tooltipCall(alphaItem).includes('cmsis_action'),
        `${byPidText.split('\n')[0]} | beta: ${tooltipCall(betaItem)} | alpha: ${tooltipCall(alphaItem)}`);
    const aimed = await callTool(PORT, sid, 'list_debug_windows', {}, 22);
    check('the window argument re-aims the session\'s later path-less calls', rowOf(aimed, betaDir).includes('current target'),
        rowOf(aimed, betaDir));
    const byPath = await callToolResult(PORT, sid, 'cmsis_action', { action: 'status', window: path.join(alphaDir, 'src') }, 23);
    check('cmsis_action {window: path} runs in the window owning the path',
        byPath.isError !== true && tooltipCall(alphaItem).startsWith('Last agent call here: cmsis_action'), tooltipCall(alphaItem));
    const missed = await callToolResult(PORT, sid, 'flash', { window: path.join(root, 'no-such-window') }, 24);
    check('a window that matches nothing is INVALID_ARGUMENT with the candidates',
        missed.isError === true && missed.structuredContent?.error_code === 'INVALID_ARGUMENT'
            && (missed.structuredContent?.candidates ?? []).length === 2,
        (missed.content?.[0]?.text ?? '').split('\n')[0]);

    // #16: the user chooses beta in Select Target Window, here from beta's own window.
    stub.pickAnswer = (items) => items.find((item) => item.window?.pid === beta.pid);
    await c2.selectTargetWindow();
    stub.pickAnswer = undefined;
    const defaultFile = path.join(REGISTRY_DIR, 'default-target.json');
    const saved = fs.existsSync(defaultFile) ? JSON.parse(fs.readFileSync(defaultFile, 'utf8')) : {};
    check('Select Target Window saves the choice, 0600, in the registry directory',
        saved.pid === beta.pid && saved.workspaceFolder === betaDir && saved.name === 'beta' && typeof saved.setAt === 'number'
            && (process.platform === 'win32' || (fs.statSync(defaultFile).mode & 0o777) === 0o600),
        JSON.stringify(saved));
    check('the window that was chosen says so in its status bar at once', betaItem.text === `$(cda-robot) ${c2.isRouter() ? 'R' : 'W'} · default`,
        betaItem.text);

    const defaultSid = await openSession(PORT);
    const viaDefault = await callToolResult(PORT, defaultSid, 'read_memory', { address: '0x20000000', length: 4 }, 25);
    const defaultListing = await callTool(PORT, defaultSid, 'list_debug_windows', {}, 26);
    check('a written default resolves the tie of two idle windows',
        viaDefault.structuredContent?.error_code !== 'AMBIGUOUS_WINDOW' && rowOf(defaultListing, betaDir).includes('current target')
            && rowOf(defaultListing, betaDir).includes('default target (set in VS Code)'),
        `${viaDefault.structuredContent?.error_code} | ${rowOf(defaultListing, betaDir)}`);
    // The first session had reached alpha through its window argument; a new choice moves it.
    await callToolResult(PORT, sid, 'read_memory', { address: '0x20000000', length: 4 }, 27);
    const moved = await callTool(PORT, sid, 'list_debug_windows', {}, 28);
    check('a new default moves a session that already had a target', rowOf(moved, betaDir).includes('current target'),
        rowOf(moved, betaDir));

    // The router's tooltip lists the sessions; an op in the router window brings it up to date.
    const routerItem = c1.isRouter() ? alphaItem : betaItem;
    const routerCoordinatorWindow = c1.isRouter() ? alpha : beta;
    const hereSid = await openSession(PORT);
    await callToolResult(PORT, hereSid, 'cmsis_action', { action: 'status', window: String(routerCoordinatorWindow.pid) }, 29);
    const sessionLines = (routerItem.tooltip ?? '').split('\n').filter((line) => line.startsWith('  • two-window ('));
    check('the router\'s status tooltip lists each agent session with its window and the reason',
        sessionLines.length >= 3 && sessionLines.some((line) => line.endsWith(', default target'))
            && sessionLines.some((line) => line.endsWith('→ this window, named by a call')),
        sessionLines.join(' | '));

    // Automatic clears the choice, from any window.
    stub.pickAnswer = (items) => items.find((item) => item.window === undefined);
    await c1.selectTargetWindow();
    stub.pickAnswer = undefined;
    check('Automatic removes the saved choice', !fs.existsSync(defaultFile));

    // A path hint must reach the window owning that folder. The handler will
    // fail for lack of a real debug session — what matters is *which* window
    // reports the failure, which the registry listing lets us infer. Instead
    // assert routing directly via select + list.
    const pinned = await callTool(PORT, sid, 'select_debug_window', { workspaceFolder: betaDir }, 3);
    check('select_debug_window pins to the named workspace',
        pinned.startsWith('This session is now pinned to:') && pinned.includes(betaDir), pinned);

    const afterPin = await callTool(PORT, sid, 'list_debug_windows', {}, 4);
    const betaLine = rowOf(afterPin, betaDir);
    check('the pinned window is marked as the current target',
        betaLine.includes('pinned') && betaLine.includes('current target'), betaLine);

    // The problem journal is per window (#48): the session reads the journal of
    // the window it is pinned to, never the router's, and the count of new
    // errors follows that window too.
    alpha.journal.append({ source: 'dap', origin: 'Alpha session', severity: 'error', message: 'alpha: Failed to power up DAP' });
    beta.journal.append({ source: 'gdb-server', origin: 'Beta session', severity: 'error', message: 'beta: Failed to power up DAP' });
    const problems = await callTool(PORT, sid, 'get_recent_problems', {}, 11);
    check('get_recent_problems returns the records of the target window, not those of the router or another window',
        problems.includes('beta: Failed to power up DAP') && !problems.includes('alpha:') && /\nnextSeq=2$/.test(problems),
        problems.replace(/\n/g, ' | '));
    beta.journal.append({ source: 'dap', origin: 'Beta session', severity: 'error', message: 'beta: setBreakpoints refused' });
    alpha.journal.append({ source: 'dap', origin: 'Alpha session', severity: 'error', message: 'alpha: another error' });
    const counted = await callTool(PORT, sid, 'get_session_status', {}, 12);
    check('get_session_status counts the new errors of the target window only',
        counted.split('\n').includes('Problems: 1 new error since #2 — get_recent_problems {sinceSeq: 2}'),
        counted.split('\n').filter((l) => l.startsWith('Problems') || l.startsWith('State')).join(' | '));

    // An active session in beta only must make beta the automatic target for a
    // fresh session that has no hint and no pin.
    await withWindowContext(beta, { configuration: { name: 'AppKit-E8 Debug' } }, async () => {
        // publish() is private, but the debug-session listeners call it; invoke
        // the same path directly here since there is no real event to fire.
        c2.publish();
    });
    const withActive = alpha.registry.list().filter((w) => w.hasActiveSession);
    check('the active session is published to the registry',
        withActive.length === 1 && withActive[0].workspaceFolders[0] === betaDir,
        JSON.stringify(withActive.map((w) => w.name)));

    const sid2 = await openSession(PORT);
    const listing2 = await callTool(PORT, sid2, 'list_debug_windows', {}, 5);
    check('a window with an active session is shown as debugging',
        /debugging: AppKit-E8 Debug/.test(listing2), listing2.replace(/\n/g, ' | '));

    // Both windows debugging: the router must not guess, and says which windows qualify.
    await withWindowContext(alpha, { configuration: { name: 'Corstone Debug' } }, async () => {
        c1.publish();
    });
    const tieSid = await openSession(PORT);
    const tie = await callToolResult(PORT, tieSid, 'read_memory', { address: '0x20000000', length: 4 }, 7);
    const tied = tie.structuredContent ?? {};
    const candidatePids = (tied.candidates ?? []).map((c) => c.pid).sort();
    check('two debugging windows are refused as AMBIGUOUS_WINDOW with both as candidates',
        tie.isError === true && tied.error_code === 'AMBIGUOUS_WINDOW'
            && JSON.stringify(candidatePids) === JSON.stringify([alpha.pid, beta.pid].sort())
            && (tied.candidates ?? []).every((c) => c.hasActiveSession === true),
        JSON.stringify(tied));

    // Router failover below: close the router, the survivor must take the port.
    const router = c1.isRouter() ? c1 : c2;
    const worker = c1.isRouter() ? c2 : c1;
    const workerItem = c1.isRouter() ? betaItem : alphaItem;
    const workerWindow = c1.isRouter() ? beta : alpha;

    // #14: a worker whose handler never answers. Its fence answers
    // WORKER_TIMEOUT inside the router's 3 s budget and the call runs on
    // there, so its status bar item turns to the warning background. A
    // debugging op waits for the debug adapter: the hint says so and the
    // user, who could not answer it, is not told. An op that can wait for a
    // picker or dialog, as restart_debugging for a preLaunchTask's prompt,
    // says so in its hint and tells the user once.
    worker.localHandler.handleGetDeviceInfo = () => new Promise(() => { /* the debug adapter never answers */ });
    worker.localHandler.handleRestart = () => new Promise(() => { /* waits for a picker nobody answers */ });
    const warnings = [];
    const showWarning = stub.window.showWarningMessage;
    stub.window.showWarningMessage = (message, ...items) => { warnings.push({ message, items }); return Promise.resolve(undefined); };
    const hangSid = await openSession(PORT);
    await callTool(PORT, hangSid, 'select_debug_window', { pid: workerWindow.pid }, 60);
    const hangBegan = Date.now();
    const hung = await callToolResult(PORT, hangSid, 'get_device_info', {}, 61);
    const hungMs = Date.now() - hangBegan;
    const hungText = hung.content?.[0]?.text ?? '';
    check('a worker whose handler never answers returns WORKER_TIMEOUT inside the budget, the hint naming the debug adapter',
        hung.isError === true && hung.structuredContent?.error_code === 'WORKER_TIMEOUT' && hungMs >= 1_800 && hungMs < 3_000
            && /^\[WORKER_TIMEOUT\] 'get_device_info' did not finish within 2 s in window pid \d+( \(.+\))?; it is still running there\.\n/.test(hungText)
            && hungText.includes('\nThe debug adapter or GDB has not answered: call get_session_status, then check_target_connection.'),
        `${hungMs} ms: ${hungText.replace(/\n/g, ' | ')}`);
    check('a debugging op past its fence: no warning for the user; the status bar shows the call past its fence',
        warnings.length === 0
            && workerItem.backgroundColor?.id === 'statusBarItem.warningBackground'
            && /get_device_info for \d+ s \(the agent was told it timed out\)/.test(workerItem.tooltip ?? ''),
        `${warnings.map((w) => w.message).join(' | ')} / ${workerItem.backgroundColor?.id} / `
            + `${(workerItem.tooltip ?? '').split('\n').find((line) => line.startsWith('Running here')) ?? ''}`);
    const restarted = await callToolResult(PORT, hangSid, 'restart_debugging', {}, 62);
    const restartedText = restarted.content?.[0]?.text ?? '';
    const again = await callToolResult(PORT, hangSid, 'restart_debugging', {}, 63);
    check('an op that can wait for a picker: the hint names it, the user is told once, with the log a click away',
        restarted.structuredContent?.error_code === 'WORKER_TIMEOUT' && again.structuredContent?.error_code === 'WORKER_TIMEOUT'
            && restartedText.includes('\nA picker or dialog may be open in that window: ask the user, or call get_session_status.')
            && warnings.length === 1
            && /: an agent's restart_debugging has been waiting 2 s in this window; the agent was told it timed out\. A picker or dialog here may be waiting for you\./.test(warnings[0].message)
            && warnings[0].items.join() === 'Show Log'
            && /restart_debugging for \d+ s \(the agent was told it timed out; a picker or dialog here may be waiting for you\)/.test(workerItem.tooltip ?? ''),
        `${restartedText.replace(/\n/g, ' | ')} / ${warnings.map((w) => w.message).join(' | ')}`);
    stub.window.showWarningMessage = showWarning;
    await router.dispose();
    check('the router released the port', !router.isRouter());
    check('the closed window\'s status bar item is gone', routerItem.disposed === true);

    // The promotion republishes the window, which reads its folders from `vscode`.
    await withWindowContext(workerWindow, undefined, () => worker.tryBecomeRouter());
    check('the surviving worker was promoted to router', worker.isRouter(),
        `isRouter=${worker.isRouter()}`);
    const promotedEntry = workerWindow.registry.list().find((w) => w.pid === workerWindow.pid);
    check('the promoted window publishes and shows its new role',
        promotedEntry?.role === 'router' && workerItem.text.startsWith('$(cda-robot) R'),
        `${promotedEntry?.role} / ${workerItem.text}`);

    // #14: the old router's session id means nothing to the new one; 404 tells the client to start over.
    const stale = await post(PORT, { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 63, method: 'tools/list', params: {} });
    const staleBody = (() => { try { return JSON.parse(stale.body); } catch { return {}; } })();
    check('after failover a session id of the old router gets 404 and -32001 "Session not found"',
        stale.status === 404 && staleBody.error?.code === -32001 && staleBody.error?.message === 'Session not found',
        `status=${stale.status} ${stale.body}`);

    const sid3 = await openSession(PORT);
    const listing3 = await callTool(PORT, sid3, 'list_debug_windows', {}, 6);
    check('the promoted router serves MCP, a new session included', listing3.includes('Registered VS Code windows'), listing3.slice(0, 120));

    await worker.dispose();
    fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
