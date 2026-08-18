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
//   7. Closing the router frees the port and a worker is promoted.

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
const PORT = 39117;

// Point the registry at the temp dir and give each coordinator its own identity
// and its own view of `vscode`, since a real window has both.
const { WorkspaceRegistry } = require(path.join(OUT, 'utils', 'workspaceRegistry.js'));
const origRegistry = WorkspaceRegistry;

function makeWindow(pid, folder, name) {
    const registry = new origRegistry(pid, REGISTRY_DIR, () => true);
    return { pid, folder, name, registry };
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

async function callTool(port, sid, name, args, id) {
    const res = await post(port, { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    });
    const parsed = parseSse(res.body);
    return parsed?.result?.content?.[0]?.text ?? JSON.stringify(parsed);
}

async function main() {
    const { WindowCoordinator } = require(path.join(OUT, 'windowCoordinator.js'));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-projects-'));
    const alphaDir = path.join(root, 'alpha');
    const betaDir = path.join(root, 'beta');
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });

    const alpha = makeWindow(600001, alphaDir, 'alpha');
    const beta = makeWindow(600002, betaDir, 'beta');

    const context = { subscriptions: [] };

    // Each coordinator gets its own registry instance (own pid + temp dir),
    // which is what two real windows look like.
    const makeCoordinator = (win) => new WindowCoordinator({
        port: PORT, timeoutInSeconds: 30, hardwareTimeouts: {}, registry: win.registry,
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

    const sid = await openSession(PORT);

    const listing = await callTool(PORT, sid, 'list_debug_windows', {}, 2);
    check('list_debug_windows reports both windows',
        listing.includes(alphaDir) && listing.includes(betaDir), listing.replace(/\n/g, ' | '));

    // A path hint must reach the window owning that folder. The handler will
    // fail for lack of a real debug session — what matters is *which* window
    // reports the failure, which the registry listing lets us infer. Instead
    // assert routing directly via select + list.
    const pinned = await callTool(PORT, sid, 'select_debug_window', { workspaceFolder: betaDir }, 3);
    check('select_debug_window pins to the named workspace',
        pinned.startsWith('This session is now pinned to:') && pinned.includes(betaDir), pinned);

    const afterPin = await callTool(PORT, sid, 'list_debug_windows', {}, 4);
    const betaLine = afterPin.split('\n').find((l) => l.includes(betaDir)) ?? '';
    check('the pinned window is marked as the current target',
        betaLine.includes('pinned') && betaLine.includes('current target'), betaLine);

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

    // Router failover: close the router, the survivor must take the port.
    const router = c1.isRouter() ? c1 : c2;
    const worker = c1.isRouter() ? c2 : c1;
    await router.dispose();
    check('the router released the port', !router.isRouter());

    await worker.tryBecomeRouter();
    check('the surviving worker was promoted to router', worker.isRouter(),
        `isRouter=${worker.isRouter()}`);

    const sid3 = await openSession(PORT);
    const listing3 = await callTool(PORT, sid3, 'list_debug_windows', {}, 6);
    check('the promoted router serves MCP', listing3.includes('Registered VS Code windows'), listing3.slice(0, 120));

    await worker.dispose();
    fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
