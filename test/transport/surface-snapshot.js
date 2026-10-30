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

// Agent-visible surface snapshot.
//
// Records everything an MCP client can observe without hardware: the
// initialize result, tools/list, resources, and the reply of every tool when
// no debug session exists. Four server shapes are covered: default,
// serial off, every tool group on, and routed (no window registered).
//
//   node test/transport/surface-snapshot.js            compare with the snapshot
//   node test/transport/surface-snapshot.js --update   rewrite the snapshot
//
// A refactoring that is meant to change no behaviour must leave the snapshot
// byte-identical. A deliberate change updates it in the same commit.
//
// Independent of the snapshot, every reply that has structuredContent must
// carry all of its text there too (some MCP clients show the model that
// object instead of the text); a reply that does not fails the run, with or
// without --update.

const stub = require('./vscode-stub.js');

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');
const { linesMissingFromStructured } = require(path.join(OUT, 'core', 'measuredMcpServer.js'));
/** Replies whose structuredContent leaves out part of their text: `shape tool: lines`. */
const uncarried = [];
const SNAPSHOT = path.join(__dirname, 'surface.snapshot.json');
const CALL_TIMEOUT_MS = 90_000;
// Pids no real process on a developer machine uses; only these count as live.
const FAKE_ROUTER_PID = 3_999_001;
const FAKE_WORKER_PID = 3_999_002;

// Tools whose reply depends on the host or the network rather than on our code.
const SKIP_CALLS = new Set([
    'serial_list_ports',   // lists this machine's ports
    'fetch_doc',           // downloads
]);

// Arguments for tools whose required parameters need a meaningful value.
const ARGS = {
    add_breakpoint: { fileFullPath: '/nonexistent/main.c', lineContent: 'int main(void)' },
    add_logpoint: { fileFullPath: '/nonexistent/main.c', lineContent: 'int main(void)', logMessage: 'hit' },
    remove_breakpoint: { fileFullPath: '/nonexistent/main.c', line: 1 },
    start_debugging: { fileFullPath: '/nonexistent/main.c', workingDirectory: '/nonexistent' },
    read_memory: { address: '0x20000000', length: 16 },
    read_peripheral_register: { peripheral: 'SCB', register: 'CFSR' },
    evaluate_expression: { expression: 'SystemCoreClock' },
    get_variables_values: { variableNames: ['x'] },
    cmsis_action: { action: 'stop_run' },
    cmsis_query: { what: 'boards' },
    flash: { cbuildRunFile: '/nonexistent/x.cbuild-run.yml' },
    serial_open: { path: '/nonexistent/tty.none', baudRate: 115200 },
    serial_capture: { path: '/nonexistent/tty.none', durationMs: 100 },
    serial_write: { data: 'x' },
    select_debug_window: { pid: 1 },
    lookup_peripheral: { name: 'SCB' },
    lookup_register: { name: 'SCB_CFSR' },
    get_debug_instructions: {},
    // Errors only: the journal is shared by the shapes of this process, and the
    // warnings of the failed serial_open calls fold together or not by timing (10 s).
    get_recent_problems: { minSeverity: 'error' },
};

function request(port, method, sid, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method,
            headers: {
                'Host': `127.0.0.1:${port}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(sid ? { 'mcp-session-id': sid } : {}),
            },
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
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

/** Replace host-, time- and run-dependent fragments so two runs compare equal. */
function normalise(text, ctx) {
    let t = String(text);
    for (const [from, to] of ctx.paths) { t = t.split(from).join(to); }
    return t
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
        .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, '<n>$2')
        .replace(/\b(pid|port)[=: ]\s*\d+/gi, '$1=<n>')
        .replace(/\b127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
        // The release number (with a pre-release suffix when CI set one), so that a version bump leaves the snapshot alone.
        .replace(/\bserverVersion=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g, 'serverVersion=<version>');
}

/**
 * get_session_status ends with this session's tool statistics. Their byte sizes
 * sum the raw replies (temporary paths included, before normalisation), so they
 * are masked; the counts of calls, timeouts and errors stay.
 */
function maskStatsTrailer(text) {
    return text.replace(/\n\nTool stats \(this session\):[\s\S]*$/,
        (trailer) => trailer.replace(/\b\d+(?:\.\d+)? (?:kB|B)\b/g, '<size>'));
}

async function withTimeout(promise, ms) {
    let timer;
    const t = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
    try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

async function capture(label, server, ctx, { callTools }) {
    await server.initialize();
    await server.start();
    const port = server.getActualPort();
    const init = await request(port, 'POST', undefined, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'surface-snapshot', version: '1.0.0' } },
    });
    const sid = init.headers['mcp-session-id'];
    const initResult = parseSse(init.body).result;
    initResult.serverInfo = { ...initResult.serverInfo, version: '<version>' };
    await request(port, 'POST', sid, { jsonrpc: '2.0', method: 'notifications/initialized' });

    let id = 2;
    const rpc = async (method, params = {}) => parseSse((await request(port, 'POST', sid, { jsonrpc: '2.0', id: id++, method, params })).body);
    const tools = (await rpc('tools/list')).result.tools;
    const resources = (await rpc('resources/list')).result?.resources ?? [];
    const templates = (await rpc('resources/templates/list')).result?.resourceTemplates ?? [];
    const resourceText = {};
    for (const r of resources) {
        if (r.uri.endsWith('://stats')) { continue; }   // live counters
        const read = await rpc('resources/read', { uri: r.uri });
        const text = (read.result?.contents ?? []).map((c) => normalise(c.text ?? '', ctx)).join('\n');
        // Resources are served files; a digest keeps the snapshot small and still names the one that changed.
        resourceText[r.uri] = { bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') };
    }

    const calls = {};
    if (callTools) {
        for (const tool of tools) {
            if (SKIP_CALLS.has(tool.name)) { continue; }
            const args = ARGS[tool.name] ?? {};
            const res = await withTimeout(rpc('tools/call', { name: tool.name, arguments: args }), CALL_TIMEOUT_MS);
            if (res.timedOut) { calls[tool.name] = { timedOut: true }; continue; }
            const r = res.result ?? {};
            const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `<${c.type}>`)).join('\n');
            const missing = linesMissingFromStructured(r);
            if (missing.length > 0) { uncarried.push(`${label} ${tool.name}: ${JSON.stringify(missing)}`); }
            calls[tool.name] = {
                ...(res.error ? { rpcError: normalise(res.error.message, ctx) } : {}),
                ...(r.isError ? { isError: true } : {}),
                ...(r.structuredContent ? { structuredContent: JSON.parse(normalise(JSON.stringify(r.structuredContent), ctx)) } : {}),
                text: normalise(maskStatsTrailer(text), ctx),
            };
        }
    }

    await request(port, 'DELETE', sid);
    await server.stop();
    return { label, initialize: { ...initResult, instructions: normalise(initResult.instructions ?? '', ctx) }, tools, resources, templates, resourceText, calls };
}

async function main() {
    const update = process.argv.includes('--update');
    const { DebugMCPServer, localSerialDispatch } = require(path.join(OUT, 'debugMCPServer.js'));
    const { DebuggingExecutor, ConfigurationManager, DebuggingHandler } = require(path.join(OUT, 'index.js'));
    const { RoutingDebuggingHandler } = require(path.join(OUT, 'routingDebuggingHandler.js'));
    const { WorkspaceRegistry } = require(path.join(OUT, 'utils', 'workspaceRegistry.js'));
    const { ControlServer } = require(path.join(OUT, 'controlServer.js'));
    const { PackDocsHandler } = require(path.join(OUT, 'packDocsHandler.js'));
    const { BuildInfoHandler } = require(path.join(OUT, 'buildInfoHandler.js'));
    const { localPackDocsDispatch } = require(path.join(OUT, 'packDocsDispatch.js'));
    const { defaultSettings, silentLog } = require(path.join(OUT, 'core', 'packDocs', 'host.js'));
    const { defaultBuildInfoSettings } = require(path.join(OUT, 'core', 'buildInfo', 'host.js'));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-surface-'));
    const ctx = { paths: [[fs.realpathSync(tmp), '<tmp>'], [tmp, '<tmp>'], [path.resolve(__dirname, '..', '..'), '<repo>']] };
    const docsHost = {
        packRoot: path.join(tmp, 'packs'), storageDir: path.join(tmp, 'store'),
        settings: () => defaultSettings, log: silentLog, userAgent: 'surface-snapshot',
        workspaceFolders: () => [tmp], findCbuildRunFiles: async () => [],
    };
    const buildHost = { workspaceFolders: () => [tmp], findFiles: async () => [], settings: () => defaultBuildInfoSettings, log: silentLog };
    const packDocs = localPackDocsDispatch({
        docs: new PackDocsHandler(docsHost, { timeoutMs: 30_000 }),
        build: new BuildInfoHandler(buildHost, { timeoutMs: 30_000 }),
    });

    const shapes = [];
    shapes.push(await capture('default', new DebugMCPServer(0, 30), ctx, { callTools: true }));
    shapes.push(await capture('serial-off', new DebugMCPServer(0, 30, undefined, undefined, { serialEnabled: false }), ctx, { callTools: false }));
    const debug = new DebuggingHandler(new DebuggingExecutor(), new ConfigurationManager(), 30);
    shapes.push(await capture('all-groups', new DebugMCPServer(0, 30, undefined,
        () => ({ debug, serial: localSerialDispatch, packDocs }),
        { packDocsEnabled: true, buildInfoEnabled: true }), ctx, { callTools: true }));
    // Routed shapes use a private registry directory and a liveness check that
    // accepts only the fake pids below, so no call can ever reach a real
    // VS Code window on this machine.
    const routed = (registryDir, livePids) => () => {
        const registry = new WorkspaceRegistry(FAKE_ROUTER_PID, registryDir, (pid) => livePids.has(pid));
        const router = new RoutingDebuggingHandler(registry, 30_000);
        return { debug: router, serial: (op, args) => router.serialOp(op, args), packDocs: (op, args) => router.packDocsOp(op, args) };
    };
    const emptyDir = path.join(tmp, 'registry-empty');
    fs.mkdirSync(emptyDir);
    shapes.push(await capture('routed-no-window', new DebugMCPServer(0, 30, undefined, routed(emptyDir, new Set())), ctx, { callTools: true }));

    const workerDir = path.join(tmp, 'registry-worker');
    fs.mkdirSync(workerDir);
    const worker = new ControlServer(new DebuggingHandler(new DebuggingExecutor(), new ConfigurationManager(), 30),
        'surface-token', { docs: new PackDocsHandler(docsHost, { timeoutMs: 30_000 }), build: new BuildInfoHandler(buildHost, { timeoutMs: 30_000 }) });
    const workerPort = await worker.start();
    fs.writeFileSync(path.join(workerDir, `window-${FAKE_WORKER_PID}.json`), JSON.stringify({
        pid: FAKE_WORKER_PID, controlPort: workerPort, controlToken: 'surface-token',
        workspaceFolders: [tmp], name: 'fake-worker', updatedAt: Date.now(),
    }));
    shapes.push(await capture('routed-one-worker', new DebugMCPServer(0, 30, undefined,
        routed(workerDir, new Set([FAKE_WORKER_PID]))), ctx, { callTools: true }));
    await worker.stop();
    fs.rmSync(tmp, { recursive: true, force: true });

    if (uncarried.length > 0) {
        console.log(`STRUCTURED CONTENT WITHOUT THE TEXT in ${uncarried.length} replies:\n  ${uncarried.join('\n  ')}`);
        process.exit(1);
    }
    const actual = JSON.stringify({ format: 1, shapes }, null, 2) + '\n';
    if (update || !fs.existsSync(SNAPSHOT)) {
        fs.writeFileSync(SNAPSHOT, actual);
        console.log(`snapshot written: ${path.relative(process.cwd(), SNAPSHOT)} (${Buffer.byteLength(actual)} bytes)`);
        process.exit(0);
    }
    const expected = fs.readFileSync(SNAPSHOT, 'utf8');
    if (expected === actual) {
        console.log(`surface identical to the snapshot (${shapes.length} shapes, ${Buffer.byteLength(actual)} bytes)`);
        process.exit(0);
    }
    const a = expected.split('\n');
    const b = actual.split('\n');
    const first = a.findIndex((line, i) => line !== b[i]);
    console.log(`SURFACE CHANGED — first difference at snapshot line ${first + 1}:`);
    console.log(`  expected: ${a[first]}`);
    console.log(`  actual:   ${b[first]}`);
    const out = path.join(os.tmpdir(), 'surface.actual.json');
    fs.writeFileSync(out, actual);
    console.log(`full actual surface written to ${out}; diff it against ${path.relative(process.cwd(), SNAPSHOT)}`);
    process.exit(1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
