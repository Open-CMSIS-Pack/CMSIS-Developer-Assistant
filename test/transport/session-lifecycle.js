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

// Streamable-HTTP session lifecycle check for the CMSIS Developer Assistant server.
//
// Drives the real server over HTTP with a stubbed `vscode` module, covering:
//   1. POST initialize mints an mcp-session-id
//   2. GET /mcp with that id opens a live text/event-stream
//   3. GET /mcp with a missing / unknown id is rejected with 400 (not 404)
//   4. DELETE /mcp tears the session down
//   5. REGRESSION: three consecutive get_threads calls on one session all
//      return — the bug the old per-request model was built to fix.
//   6. Every tool call is measured: the stats resource, the
//      get_session_status trailer and the server aggregate all count them.
//   7. Server options are accepted and readable back.

require('./vscode-stub.js');

const http = require('http');
const path = require('path');
const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');

const { DebugMCPServer } = require(path.join(OUT, 'debugMCPServer.js'));

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) { failures++; }
}

function request(port, method, extraHeaders, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method,
            headers: {
                'Host': `127.0.0.1:${port}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...extraHeaders,
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

// GET opens a stream that never ends; grab the headers then hang up.
function openStream(port, sessionId) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'GET',
            headers: {
                'Host': `127.0.0.1:${port}`,
                'Accept': 'text/event-stream',
                ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
            },
        }, (res) => {
            const out = { status: res.statusCode, headers: res.headers };
            res.destroy();
            resolve(out);
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(new Error('GET /mcp timed out')); });
        req.end();
    });
}

function parseSse(text) {
    // A JSON response may arrive as SSE framing ("event: message\ndata: {...}").
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text);
}

async function main() {
    const server = new DebugMCPServer(0, 30);
    await server.initialize();
    await server.start();
    const port = server.getActualPort();
    console.log(`server on 127.0.0.1:${port}\n`);

    // 1. initialize
    const init = await request(port, 'POST', {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'transport-check', version: '1.0.0' },
        },
    });
    const sid = init.headers['mcp-session-id'];
    check('POST initialize returns 200', init.status === 200, `status=${init.status}`);
    check('POST initialize mints an mcp-session-id', typeof sid === 'string' && sid.length > 0, `sid=${sid}`);

    await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', method: 'notifications/initialized',
    });

    // 2. GET with a valid session id opens the SSE stream
    const stream = await openStream(port, sid);
    check('GET /mcp with a valid session opens text/event-stream',
        stream.status === 200 && String(stream.headers['content-type']).includes('text/event-stream'),
        `status=${stream.status} content-type=${stream.headers['content-type']}`);

    // 3. GET without / with an unknown session id is a 400, never a bare 404
    const noSid = await openStream(port, undefined);
    check('GET /mcp without a session id is rejected with 400', noSid.status === 400, `status=${noSid.status}`);
    const badSid = await openStream(port, 'not-a-real-session');
    check('GET /mcp with an unknown session id is rejected with 400', badSid.status === 400, `status=${badSid.status}`);

    // 4. tools/list works on the session
    const list = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    const tools = parseSse(list.body)?.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    check('tools/list returns the tool surface', tools.length > 30, `${tools.length} tools`);
    for (const expected of ['add_logpoint', 'list_variable_names', 'add_breakpoint', 'get_variables_values']) {
        check(`tools/list includes ${expected}`, names.includes(expected));
    }

    // 5. REGRESSION: three consecutive get_threads on one session must all return.
    for (let i = 1; i <= 3; i++) {
        const call = await Promise.race([
            request(port, 'POST', { 'mcp-session-id': sid }, {
                jsonrpc: '2.0', id: 10 + i, method: 'tools/call',
                params: { name: 'get_threads', arguments: {} },
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 10s')), 10_000)),
        ]).catch((e) => ({ status: 0, body: String(e) }));
        const parsed = call.status === 200 ? parseSse(call.body) : null;
        check(`get_threads call ${i}/3 returns`,
            call.status === 200 && !!parsed && (!!parsed.result || !!parsed.error),
            call.status === 200 ? '' : call.body);
    }

    // 6. Tool telemetry: the calls above were measured at the MCP boundary.
    const stats = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 20, method: 'resources/read', params: { uri: 'cmsis-developer-assistant://stats' },
    });
    const statsText = parseSse(stats.body)?.result?.contents?.[0]?.text ?? '';
    let statsJson = null;
    try { statsJson = JSON.parse(statsText); } catch { /* reported by the check */ }
    check('stats resource counts the tool calls',
        !!statsJson && statsJson.session.calls >= 3 && statsJson.session.perTool.get_threads?.calls === 3,
        statsJson ? `session.calls=${statsJson.session.calls}` : statsText.slice(0, 120));
    const status = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_session_status', arguments: {} },
    });
    const statusText = parseSse(status.body)?.result?.content?.[0]?.text ?? '';
    check('get_session_status carries the tool stats', /^Tool stats \(this session\): 3 calls/m.test(statusText),
        statusText.split('\n').filter((l) => l.startsWith('Tool stats')).join(' | ') || statusText.slice(0, 120));
    check('server aggregate sees every session sample', server.getMetrics().totals().calls >= 4,
        `${server.getMetrics().totals().calls} calls`);

    // 7. DELETE tears the session down
    const del = await request(port, 'DELETE', { 'mcp-session-id': sid });
    check('DELETE /mcp accepts a valid session', del.status === 200 || del.status === 204, `status=${del.status}`);
    const afterDelete = await openStream(port, sid);
    check('GET /mcp after DELETE is rejected', afterDelete.status === 400, `status=${afterDelete.status}`);

    await server.stop();

    // 8. Server options are accepted, kept for the instance's lifetime and
    //    readable back. Behaviour behind them (serial gating, telemetry) lands
    //    with the packages that consume each field; here only the plumbing.
    const configured = new DebugMCPServer(0, 30, undefined, undefined, { serialEnabled: false });
    await configured.initialize();
    await configured.start();
    const cport = configured.getActualPort();
    check('server options are readable back', configured.getOptions().serialEnabled === false,
        JSON.stringify(configured.getOptions()));
    const cinit = await request(cport, 'POST', {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-check', version: '1.0.0' } },
    });
    const csid = cinit.headers['mcp-session-id'];
    await request(cport, 'POST', { 'mcp-session-id': csid }, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const clist = await request(cport, 'POST', { 'mcp-session-id': csid }, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    const ctools = parseSse(clist.body)?.result?.tools ?? [];
    check('server with options still serves tools/list', ctools.length > 30, `${ctools.length} tools`);
    await request(cport, 'DELETE', { 'mcp-session-id': csid });
    await configured.stop();

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
