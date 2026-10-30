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
//   3. A request with a missing id is rejected with 400; POST, GET and
//      DELETE with an unknown id get 404 and JSON-RPC -32001 "Session not
//      found", as the SDK's own transport answers, which tells a client to
//      initialize again (#14); a request on another path gets JSON that
//      names the endpoint; a GET of a Kimi Code session gets 405
//   4. DELETE /mcp tears the session down
//   5. REGRESSION: three consecutive get_threads calls on one session all
//      return — the bug the old per-request model was built to fix.
//   6. Every tool call is measured: the stats resource, the
//      get_session_status trailer and the server aggregate all count them.
//   7. Server options are accepted and readable back; serialEnabled:false
//      drops the serial tools. The tool list has a byte budget, and no tool
//      takes the router's window argument (#16).
//   8. Results are typed (#11): a failure without a session is isError with
//      structuredContent.error_code, get_session_status is not, and no tool
//      declares an outputSchema, so tools/list does not grow.
//   9. CMSIS jobs (#47, #46, #12): cmsis_action status needs no solution and
//      answers at once, and flash without a workspace explains itself without
//      suggesting to install pyOCD.
//  10. The tool contract (#50): the instructions start with the tool rules,
//      the first get_session_status of a session repeats them in one line and
//      the second does not, and tools/list keeps its size to the byte.
//  11. The problem journal (#48): get_recent_problems is listed, an empty
//      answer stays under 256 bytes, a failing call carries
//      structuredContent.problems with its call id, and an error nobody saw
//      is noted once, counted by get_session_status, and cleared by
//      get_recent_problems.
//  12. The end of a session releases its serial port (#49): serial_capture
//      reads a mock port until its regex matches and leaves it closed;
//      serial_open holds a mock port for the session, and DELETE releases it
//      through the local serial handler. A session without a request for the
//      idle time and without an open GET stream expires (injected clock): a
//      later request with its id gets 404, and its port is
//      released. Mock ports only: the serial controller's port factory is
//      swapped for serialport's SerialPortMock.
//  13. A wait the client gives up on (2.7.0 tester feedback): a pending call
//      cancelled over the socket with another reason teaches nothing; one
//      cancelled with the SDK client's "Request timed out" teaches the
//      session its client's limit, which is logged once.

const stub = require('./vscode-stub.js');

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');

const { DebugMCPServer } = require(path.join(OUT, 'debugMCPServer.js'));

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) { failures++; }
}

function request(port, method, extraHeaders, body, agent, route = '/mcp') {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            host: '127.0.0.1', port, path: route, method, ...(agent ? { agent } : {}),
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
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, reused: req.reusedSocket }));
        });
        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

// A GET stream that stays open until `close()` is called: the session it belongs to must not expire meanwhile.
function holdStream(port, sessionId) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'GET',
            headers: { 'Host': `127.0.0.1:${port}`, 'Accept': 'text/event-stream', 'mcp-session-id': sessionId },
        }, (res) => {
            res.on('data', () => undefined);
            res.on('error', () => undefined);
            resolve({ status: res.statusCode, close: () => new Promise((done) => { res.once('close', done); req.destroy(); }) });
        });
        req.on('error', (err) => { if (err.code !== 'ECONNRESET') { reject(err); } });
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
    const instructions = parseSse(init.body)?.result?.instructions ?? '';
    check('the default instructions point at the documentation setting instead of leaving agents to ask for PDFs',
        /packDocs\.enabled/.test(instructions) && /rather than asking the user for a document/.test(instructions));
    check('the instructions start with the tool rules', instructions.startsWith('## CMSIS Developer Assistant tool rules\n'),
        instructions.split('\n')[0]);
    check('POST initialize mints an mcp-session-id', typeof sid === 'string' && sid.length > 0, `sid=${sid}`);

    await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', method: 'notifications/initialized',
    });

    // An idle pooled connection outlives Node's default (5 s, plus a 1 s buffer): a client that keeps its sockets longer
    // (Codex) must not send on one the server is closing ("error sending request"). With the default, the request after
    // 7 s idle needs a new connection.
    const pooled = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await request(port, 'POST', { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 90, method: 'ping' }, pooled);
    await new Promise((wake) => setTimeout(wake, 7_000));
    const afterIdle = await request(port, 'POST', { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 91, method: 'ping' }, pooled);
    check('a request after 7 s idle goes over the same connection: the endpoint keeps it open for 120 s',
        afterIdle.status === 200 && afterIdle.reused === true, `status=${afterIdle.status} reused=${afterIdle.reused}`);
    pooled.destroy();

    // 2. GET with a valid session id opens the SSE stream
    const stream = await openStream(port, sid);
    check('GET /mcp with a valid session opens text/event-stream',
        stream.status === 200 && String(stream.headers['content-type']).includes('text/event-stream'),
        `status=${stream.status} content-type=${stream.headers['content-type']}`);

    // 3. Without a session id: 400. With an unknown one: the SDK's JSON 404
    //    and -32001, on POST, GET and DELETE alike, never Express's HTML 404 (#14).
    const noSid = await openStream(port, undefined);
    check('GET /mcp without a session id is rejected with 400', noSid.status === 400, `status=${noSid.status}`);
    const noSidPost = await request(port, 'POST', {}, { jsonrpc: '2.0', id: 90, method: 'tools/list', params: {} });
    check('POST /mcp without a session id that is not an initialize request is rejected with 400 and -32000',
        noSidPost.status === 400 && JSON.parse(noSidPost.body).error?.code === -32000, `status=${noSidPost.status} ${noSidPost.body}`);
    const unknownSession = { 'mcp-session-id': 'not-a-real-session' };
    const sessionNotFound = (reply) => reply.status === 404 && /application\/json/.test(String(reply.headers['content-type']))
        && JSON.stringify(JSON.parse(reply.body)) === JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
    const unknownGet = await request(port, 'GET', unknownSession);
    check('GET /mcp with an unknown session id gets 404 and -32001 "Session not found"', sessionNotFound(unknownGet),
        `status=${unknownGet.status} ${unknownGet.body}`);
    const unknownPost = await request(port, 'POST', unknownSession, { jsonrpc: '2.0', id: 91, method: 'tools/list', params: {} });
    check('POST /mcp with an unknown session id gets 404 and -32001', sessionNotFound(unknownPost), `status=${unknownPost.status} ${unknownPost.body}`);
    const unknownInit = await request(port, 'POST', unknownSession, {
        jsonrpc: '2.0', id: 92, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-check', version: '1.0.0' } },
    });
    check('an initialize request that carries an unknown session id gets 404 too', sessionNotFound(unknownInit),
        `status=${unknownInit.status} ${unknownInit.body}`);
    const unknownDelete = await request(port, 'DELETE', unknownSession);
    check('DELETE /mcp with an unknown session id gets 404 and -32001', sessionNotFound(unknownDelete),
        `status=${unknownDelete.status} ${unknownDelete.body}`);
    // Kimi Code is offered no GET stream: when one drops at a server restart it marks the server failed for good.
    const kimiInit = await request(port, 'POST', {}, {
        jsonrpc: '2.0', id: 94, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'kimi-code', version: '2.3.2' } },
    });
    const kimiSid = kimiInit.headers['mcp-session-id'];
    await request(port, 'POST', { 'mcp-session-id': kimiSid }, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const kimiStream = await request(port, 'GET', { 'mcp-session-id': kimiSid, 'Accept': 'text/event-stream' });
    check('a GET of a Kimi Code session gets 405 with Allow: POST, DELETE, so its client opens no stream',
        kimiStream.status === 405 && kimiStream.headers.allow === 'POST, DELETE' && JSON.parse(kimiStream.body).error?.code === -32000,
        `status=${kimiStream.status} allow=${kimiStream.headers.allow} ${kimiStream.body}`);
    const kimiList = await request(port, 'POST', { 'mcp-session-id': kimiSid }, { jsonrpc: '2.0', id: 95, method: 'tools/list', params: {} });
    check('the Kimi Code session itself keeps working', kimiList.status === 200 && (parseSse(kimiList.body)?.result?.tools?.length ?? 0) > 0,
        `status=${kimiList.status}`);
    await request(port, 'DELETE', { 'mcp-session-id': kimiSid });

    // An entry that names the port without /mcp (a hand-written Kimi Code entry did): JSON naming the endpoint.
    const wrongPath = await request(port, 'POST', {}, { jsonrpc: '2.0', id: 93, method: 'initialize', params: {} }, undefined, '/');
    const wrongPathError = /application\/json/.test(String(wrongPath.headers['content-type'])) ? JSON.parse(wrongPath.body).error : undefined;
    check('POST / gets a JSON 404 that names the endpoint, not Express\'s HTML "Cannot POST /"',
        wrongPath.status === 404 && wrongPathError?.message === `POST / is not the MCP endpoint of the CMSIS Developer Assistant: it serves Streamable HTTP at http://localhost:${port}/mcp.`,
        `status=${wrongPath.status} ${wrongPath.body}`);

    // 4. tools/list works on the session
    const list = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    const tools = parseSse(list.body)?.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    check('tools/list returns the tool surface', tools.length > 30, `${tools.length} tools`);
    for (const expected of ['add_logpoint', 'list_variable_names', 'add_breakpoint', 'get_variables_values', 'diagnose_fault', 'lookup_register']) {
        check(`tools/list includes ${expected}`, names.includes(expected));
    }
    // The tool list rides along on every agent turn, so its size is a
    // per-turn cost. Budget for the single-window surface: 45 tools measured
    // 28 916 bytes in 2.5.0. Raised from 30 000 for the 2.5.1 additions
    // (get_recent_problems, serial_capture); two-window-routing.js budgets the
    // routed list, which is what agents see. A regression must be attributable
    // to one tool, hence the per-description cap. Raised from 32 000 for
    // cmsis_query and cmsis_action create_solution (32 724 measured), and from
    // 33 000 for the comparator counts of add_breakpoint and the ownership note
    // of clear_all_breakpoints (33 053 measured).
    const TOOLS_LIST_BUDGET_BYTES = 33_200;
    const DESCRIPTION_CAP_CHARS = 700;
    const toolsBytes = Buffer.byteLength(JSON.stringify(tools));
    check(`tools/list stays under the ${TOOLS_LIST_BUDGET_BYTES} byte budget`, toolsBytes <= TOOLS_LIST_BUDGET_BYTES, `${toolsBytes} bytes`);
    // The tool contract (#50) rides in the instructions and the first
    // get_session_status, never in a tool description; the check after the
    // reminder below compares the list before and after it.
    const longest = tools.map((t) => ({ name: t.name, len: (t.description ?? '').length })).sort((a, b) => b.len - a.len)[0];
    check(`no tool description exceeds ${DESCRIPTION_CAP_CHARS} chars`, longest.len <= DESCRIPTION_CAP_CHARS, `${longest.name} ${longest.len}`);
    const serialCount = names.filter((n) => n.startsWith('serial_')).length;
    check('the serial tools are registered by default', serialCount === 11, `${serialCount} serial tools`);
    // structuredContent rides without an outputSchema; declaring one would cost tools/list bytes on every turn.
    const withSchema = tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name);
    check('no tool declares an outputSchema', withSchema.length === 0, withSchema.join(', '));
    // The window argument (#16) belongs to a router's sessions: a single window has nothing to name.
    const withWindow = tools.filter((t) => t.inputSchema?.properties?.window !== undefined).map((t) => t.name);
    check('no tool of the single-window list takes a window argument', withWindow.length === 0, withWindow.join(', '));

    // 4a. The MCP body limit is explicit (1 MiB, matching the control channel's request cap).
    const oversize = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'get_session_status', arguments: { blob: 'x'.repeat(1_100_000) } },
    });
    check('a request body above 1 MiB is refused with 413', oversize.status === 413, `status=${oversize.status}`);

    // 4b. get_debug_instructions serves one topic on request and a small
    //     overview with the topic list by default.
    const topicCall = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'get_debug_instructions', arguments: { topic: 'breakpoints' } },
    });
    const topicText = parseSse(topicCall.body)?.result?.content?.[0]?.text ?? '';
    check('get_debug_instructions serves the breakpoints topic', /FPB/.test(topicText) && !/CFSR/.test(topicText),
        `${topicText.length} chars`);
    const overviewCall = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_debug_instructions', arguments: {} },
    });
    const overviewText = parseSse(overviewCall.body)?.result?.content?.[0]?.text ?? '';
    // The overview leads with the tool rules (#50, under 1 600 bytes) before its own 3 700.
    // Capped at 5 100 chars until 2.7.0 split `build` into three topics, two more lines in the list.
    check('get_debug_instructions defaults to the overview with the topic list, the tool rules first',
        /## Topics/.test(overviewText) && overviewText.length < 5500 && overviewText.length < topicText.length * 2
            && /^# .*\n\n<!-- cmsis-developer-assistant:rules:begin -->\n## CMSIS Developer Assistant tool rules\n/.test(overviewText),
        `${overviewText.length} chars`);
    // `build`, a topic until 2.7.0, is still accepted by the schema and serves its successor.
    const retiredCall = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'get_debug_instructions', arguments: { topic: 'build' } },
    });
    const retiredResult = parseSse(retiredCall.body)?.result;
    const retiredText = retiredResult?.content?.[0]?.text ?? '';
    check('get_debug_instructions still takes topic build: the cmsis-action topic under a line naming the split',
        retiredResult?.isError !== true && /^_Topic `build` is split in three: `target`/.test(retiredText)
            && /load_and_debug/.test(retiredText) && retiredText.length < 7000,
        `${retiredText.length} chars: ${retiredText.slice(0, 80)}`);

    // 4c. The SVD lookups need no session; with no workspace (this stub) they
    //     explain where an SVD was looked for instead of failing.
    const lookup = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lookup_peripheral', arguments: {} },
    });
    const lookupParsed = parseSse(lookup.body);
    const lookupText = lookupParsed?.result?.content?.[0]?.text ?? '';
    check('lookup_peripheral without an SVD explains what it tried',
        !lookupParsed?.error && lookupParsed?.result?.isError !== true && /No SVD file found.*Tried:/s.test(lookupText),
        lookupText.split('\n')[0]);

    // 4d. cmsis_action names the target it acts on, refuses an undeclared
    //     target, and switches a declared one through cmsis.json + solution
    //     re-activation — verified through getActiveTargetSet before it acts.
    //     `detach` is the action under test because it runs no cbuild task.
    const solDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-target-'));
    const solutionFile = path.join(solDir, 'demo.csolution.yml');
    fs.writeFileSync(solutionFile, [
        'solution:', '  target-types:',
        '    - type: HE', '      device: X:HE', '      target-set:', '        - set:',
        '          debugger:', '            name: CMSIS-DAP@pyOCD',
        '    - type: HP', '      device: X:HP', '      target-set:', '        - set: debug', '        - set: release',
        '  build-types:', '    - type: Debug',
        '  projects:', '    - project: app.cproject.yml', '',
    ].join('\n'));
    const cmsisJsonPath = path.join(solDir, '.vscode', 'cmsis.json');
    let activeTarget = 'HE';
    const commandLog = [];
    stub.workspace.workspaceFolders = [{ uri: { fsPath: solDir } }];
    stub.commandHandlers = {
        'cmsis-csolution.getSolutionFile': async () => solutionFile,
        'cmsis-csolution.getActiveTargetSet': async () => activeTarget,
        'cmsis-csolution.deactivateSolution': async () => { commandLog.push('deactivate'); activeTarget = ''; },
        'cmsis-csolution.activateSolution': async (p) => {
            // The extension re-reads cmsis.json on activation; mimic that.
            commandLog.push(`activate ${p}`);
            const sel = JSON.parse(fs.readFileSync(cmsisJsonPath, 'utf8')).targetSet?.demo;
            activeTarget = sel?.activeTargetType === 'HP' ? (sel.HP === 1 ? 'HP@release' : 'HP@debug') : 'HE';
        },
        'cmsis-csolution.cmsisDetachDebugger': async () => undefined,
    };
    const cmsisAction = async (args, id) => {
        const r = await request(port, 'POST', { 'mcp-session-id': sid }, {
            jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cmsis_action', arguments: args },
        });
        return parseSse(r.body)?.result?.content?.[0]?.text ?? '';
    };
    const plain = await cmsisAction({ action: 'detach' }, 6);
    check('cmsis_action names the active target', /CMSIS 'detach' on HE issued/.test(plain), plain.split('\n')[0]);
    const undeclared = await cmsisAction({ action: 'detach', target: 'Nope' }, 7);
    check('cmsis_action refuses an undeclared target and lists the choices',
        /not attempted.*'Nope' is not declared.*Declared targets: HE, HP@debug, HP@release/s.test(undeclared)
            && commandLog.length === 0 && !fs.existsSync(cmsisJsonPath),
        undeclared.split('\n')[0]);
    // A target-type written as a flow mapping is read (K02): the refusal of an undeclared target lists it, nothing written.
    const blockYaml = fs.readFileSync(solutionFile, 'utf8');
    fs.writeFileSync(solutionFile, blockYaml.replace('  build-types:', '    - { type: MPS3, device: X:MPS3 }\n  build-types:'));
    const flow = await cmsisAction({ action: 'detach', target: 'Nope' }, 70);
    // Invalid YAML is refused before anything is written.
    fs.writeFileSync(solutionFile, blockYaml.replace('  build-types:', '    - { type: MPS3\n  build-types:'));
    const invalid = await cmsisAction({ action: 'detach', target: 'MPS3' }, 71);
    fs.writeFileSync(solutionFile, blockYaml);
    check('cmsis_action reads a target-type written as a flow mapping',
        /not attempted.*'Nope' is not declared.*Declared targets: HE, HP@debug, HP@release, MPS3/s.test(flow)
            && commandLog.length === 0 && !fs.existsSync(cmsisJsonPath),
        flow.split('\n')[0]);
    check('cmsis_action refuses to switch when the csolution YAML is invalid, and writes nothing',
        /not attempted.*cannot supply a valid target selection.*No selection was changed/s.test(invalid)
            && commandLog.length === 0 && !fs.existsSync(cmsisJsonPath),
        invalid.split('\n')[0]);
    const switched =await cmsisAction({ action: 'detach', target: 'HP@release' }, 8);
    const written = fs.existsSync(cmsisJsonPath) ? JSON.parse(fs.readFileSync(cmsisJsonPath, 'utf8')) : {};
    check('cmsis_action switches a declared target via cmsis.json + re-activation and verifies it',
        /CMSIS 'detach' on HP@release, switched from HE issued/.test(switched)
            && commandLog.join(',') === `deactivate,activate ${solutionFile}`
            && written.targetSet?.demo?.activeTargetType === 'HP' && written.targetSet?.demo?.HP === 1,
        `${switched.split('\n')[0]} | ${commandLog.join(',')} | ${JSON.stringify(written)}`);
    const matching = await cmsisAction({ action: 'detach', target: 'HP' }, 9);
    check('cmsis_action leaves a matching target alone', /CMSIS 'detach' on HP@release issued/.test(matching) && commandLog.length === 2,
        matching.split('\n')[0]);
    // An extension that ignores the written selection: the panel stays on HE.
    activeTarget = 'HE';
    stub.commandHandlers['cmsis-csolution.deactivateSolution'] = async () => { commandLog.push('deactivate'); };
    stub.commandHandlers['cmsis-csolution.activateSolution'] = async (p) => { commandLog.push(`activate ${p}`); };
    const unverified = await cmsisAction({ action: 'detach', target: 'HP', timeoutMs: 20_000 }, 10);
    check('cmsis_action refuses when the switch cannot be verified',
        /not attempted: wrote 'HP' to .*still reports 'HE'.*Manage Solution/s.test(unverified), unverified.split('\n')[0]);
    // A multi-root workspace with the solution in its second folder: CMSIS
    // Solution (1.72.0) reads only the first folder's cmsis.json, files the
    // solution there as '../fw/demo' and looks that key up split at every '.'.
    const rootsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-roots-'));
    const firstDir = path.join(rootsDir, 'app');
    const secondDir = path.join(rootsDir, 'fw');
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    const secondSolution = path.join(secondDir, 'demo.csolution.yml');
    fs.copyFileSync(solutionFile, secondSolution);
    const firstSelection = () => {
        let node;
        try {
            node = JSON.parse(fs.readFileSync(path.join(firstDir, '.vscode', 'cmsis.json'), 'utf8'));
        } catch {
            return undefined;
        }
        for (const key of 'targetSet.../fw/demo'.split('.')) { node = node && typeof node === 'object' ? node[key] : undefined; }
        return node;
    };
    activeTarget = 'HE';
    stub.workspace.workspaceFolders = [{ uri: { fsPath: firstDir } }, { uri: { fsPath: secondDir } }];
    stub.commandHandlers['cmsis-csolution.getSolutionFile'] = async () => secondSolution;
    stub.commandHandlers['cmsis-csolution.activateSolution'] = async () => {
        const sel = firstSelection();
        activeTarget = sel?.activeTargetType === 'HP' ? (sel.HP === 1 ? 'HP@release' : 'HP@debug') : 'HE';
    };
    const multiRoot = await cmsisAction({ action: 'detach', target: 'HP@release' }, 11);
    check('cmsis_action switches a solution in the second folder through the first folder\'s cmsis.json',
        /CMSIS 'detach' on HP@release, switched from HE issued/.test(multiRoot)
            && !fs.existsSync(path.join(secondDir, '.vscode', 'cmsis.json')),
        `${multiRoot.split('\n')[0]} | ${JSON.stringify(firstSelection() ?? null)}`);
    fs.rmSync(rootsDir, { recursive: true, force: true });
    stub.commandHandlers = {};
    stub.workspace.workspaceFolders = [];
    fs.rmSync(solDir, { recursive: true, force: true });

    // 4e. CMSIS jobs: status needs no solution and launches nothing; flash
    //     without a workspace says why, and never tells the agent to install pyOCD.
    const callTool = async (name, args, id) => {
        const r = await request(port, 'POST', { 'mcp-session-id': sid }, {
            jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
        });
        return parseSse(r.body)?.result ?? {};
    };
    const idle = await callTool('cmsis_action', { action: 'status' }, 30);
    const idleText = idle.content?.[0]?.text ?? '';
    check('cmsis_action status without a solution answers ok with "No CMSIS job in this window"',
        idle.isError !== true && /^No CMSIS job in this window/.test(idleText), idleText.split('\n')[0]);
    const noWorkspace = await callTool('flash', {}, 31);
    const noWorkspaceText = noWorkspace.content?.[0]?.text ?? '';
    check('flash without a workspace is a NO_WORKSPACE error that names open_solution, without pip',
        noWorkspace.isError === true && noWorkspace.structuredContent?.error_code === 'NO_WORKSPACE'
            && /no folder is open in this VS Code window/.test(noWorkspaceText) && /open_solution/.test(noWorkspaceText)
            && !/pip/i.test(noWorkspaceText),
        noWorkspaceText.split('\n')[0]);
    const noProject = await callTool('cmsis_action', { action: 'build' }, 32);
    check('cmsis_action build without a workspace is NO_WORKSPACE with the bootstrap topic',
        noProject.isError === true && noProject.structuredContent?.error_code === 'NO_WORKSPACE'
            && /topic:'bootstrap'/.test(noProject.content?.[0]?.text ?? ''),
        (noProject.content?.[0]?.text ?? '').split('\n')[0]);
    const badOpen = await callTool('cmsis_action', { action: 'open_solution', path: 'relative/demo.csolution.yml' }, 33);
    check('cmsis_action open_solution with a relative path is INVALID_ARGUMENT',
        badOpen.isError === true && badOpen.structuredContent?.error_code === 'INVALID_ARGUMENT',
        (badOpen.content?.[0]?.text ?? '').split('\n')[0]);

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
        !!statsJson && statsJson.session.calls >= 6 && statsJson.session.perTool.get_threads?.calls === 3
            && statsJson.session.perTool.get_debug_instructions?.calls === 3,
        statsJson ? `session.calls=${statsJson.session.calls}` : statsText.slice(0, 120));
    const status = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_session_status', arguments: {} },
    });
    const statusText = parseSse(status.body)?.result?.content?.[0]?.text ?? '';
    check('get_session_status carries the tool stats', /^Tool stats \(this session\): 19 calls/m.test(statusText),
        statusText.split('\n').filter((l) => l.startsWith('Tool stats')).join(' | ') || statusText.slice(0, 120));
    check('server aggregate sees every session sample', server.getMetrics().totals().calls >= 7,
        `${server.getMetrics().totals().calls} calls`);
    const statusResult = parseSse(status.body)?.result ?? {};
    check('get_session_status is not an error result', statusResult.isError !== true && statusResult.structuredContent === undefined,
        JSON.stringify({ isError: statusResult.isError, structuredContent: statusResult.structuredContent }));

    // 6b. The tool rules come back once per session, in the first status only (#50).
    const REMINDER = 'Tool rules: board, build, serial and documentation work goes through these tools, not the shell '
        + '(see the server instructions).';
    check('the first get_session_status of the session repeats the tool rules before its stats',
        statusText.includes(`\n\n${REMINDER} Procedures for CMSIS tasks come from knowledge_search and knowledge_get: look one up before you start.\n\nTool stats (this session):`),
        statusText.split('\n').slice(-4).join(' | '));
    const again = await request(port, 'POST', { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'get_session_status', arguments: {} },
    });
    const againText = parseSse(again.body)?.result?.content?.[0]?.text ?? '';
    check('the second get_session_status does not repeat them', /^State: /.test(againText) && !againText.includes('Tool rules:'),
        againText.split('\n').slice(-3).join(' | '));
    const relist = await request(port, 'POST', { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 25, method: 'tools/list', params: {} });
    const relistTools = parseSse(relist.body)?.result?.tools ?? [];
    check('tools/list is byte-identical after the reminder was given', JSON.stringify(relistTools) === JSON.stringify(tools),
        `${Buffer.byteLength(JSON.stringify(relistTools))} bytes`);

    // 6a. Typed failures (#11): without a session a read and a step are error
    //     results with the NO_SESSION code, the code in front of the text and
    //     the next step after it.
    for (const [id, name, args] of [[22, 'read_memory', { address: '0x20000000', length: 4 }], [23, 'step_over', {}]]) {
        const failed = await request(port, 'POST', { 'mcp-session-id': sid }, {
            jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
        });
        const result = parseSse(failed.body)?.result ?? {};
        const text = result.content?.[0]?.text ?? '';
        const structured = result.structuredContent ?? {};
        check(`${name} without a session is an error result with error_code NO_SESSION`,
            result.isError === true && structured.status === 'error' && structured.error_code === 'NO_SESSION'
                && text.startsWith('[NO_SESSION] ') && typeof structured.hint === 'string' && text.endsWith(`\n${structured.hint}`),
            `${JSON.stringify(structured)} | ${text.split('\n')[0]}`);
    }

    // 6c. The problem journal (#48), on the server without a router:
    //     get_recent_problems is listed and an empty answer is small; a failing
    //     call carries the problems its call produced, stamped with its call id;
    //     an error nobody saw is noted once on a successful result, counted in
    //     get_session_status, and gone from both once get_recent_problems ran.
    const { problemJournal } = require(path.join(OUT, 'core', 'problemJournal.js'));
    check('tools/list includes get_recent_problems', names.includes('get_recent_problems'));
    const first = await callTool('get_recent_problems', {}, 40);
    const cursor = first.structuredContent?.nextSeq;
    const empty = await callTool('get_recent_problems', { sinceSeq: cursor }, 41);
    const emptyText = empty.content?.[0]?.text ?? '';
    const emptyBytes = Buffer.byteLength(JSON.stringify(empty));
    // The text rides twice, as content and as structuredContent.message.
    check('an empty get_recent_problems answer is under 256 bytes',
        typeof cursor === 'number' && empty.isError !== true && emptyBytes < 256 && emptyText === `No warnings or errors since #${cursor} (nextSeq=${cursor}).`,
        `${emptyBytes} B: ${emptyText}`);

    const problemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-problems-'));
    const problemSolution = path.join(problemDir, 'demo.csolution.yml');
    fs.writeFileSync(problemSolution, 'solution:\n  target-types:\n    - type: HE\n  projects:\n    - project: app.cproject.yml\n');
    stub.workspace.workspaceFolders = [{ uri: { fsPath: problemDir } }];
    stub.commandHandlers = {
        'cmsis-csolution.getSolutionFile': async () => problemSolution,
        'cmsis-csolution.getActiveTargetSet': async () => 'HE',
        // The GDB server reports a problem while the command runs, then the command fails.
        'cmsis-csolution.cmsisDetachDebugger': async () => {
            problemJournal().append({
                source: 'gdb-server', origin: 'transport-check', severity: 'error', code: 'DAP_POWER_UP_FAILED',
                message: 'Failed to power up DAP', hint: 'Check the power.',
            });
            throw new Error('probe gone');
        },
    };
    const detached = await callTool('cmsis_action', { action: 'detach' }, 42);
    const detachedText = detached.content?.[0]?.text ?? '';
    const attached = detached.structuredContent?.problems ?? [];
    check('a failing call carries structuredContent.problems with its call id, and lists them under its text',
        detached.isError === true && attached.length === 1 && attached[0].code === 'DAP_POWER_UP_FAILED'
            && String(attached[0].toolCallId).startsWith(`${sid.slice(0, 8)}-`)
            && /\nRecent problems:\n {2}#\d+ error gdb-server \[DAP_POWER_UP_FAILED\] Failed to power up DAP → Check the power\.$/.test(detachedText),
        `${JSON.stringify(attached)} | ${detachedText.split('\n').slice(-2).join(' | ')}`);
    stub.commandHandlers = {};
    stub.workspace.workspaceFolders = [];
    fs.rmSync(problemDir, { recursive: true, force: true });

    // An error in the window outside any call: the user set a breakpoint in the editor while the target ran.
    problemJournal().append({
        source: 'dap', origin: 'transport-check', severity: 'error',
        message: 'error response to \'setBreakpoints\': Cannot execute this command while the target is running.',
    });
    const noted = (await callTool('cmsis_action', { action: 'status' }, 43)).content?.[0]?.text ?? '';
    check('an error nobody saw is noted on the next successful result',
        /\n\nNote: \d+ new errors? in this window since you last looked — get_recent_problems \{sinceSeq: \d+\}$/.test(noted),
        noted.split('\n').slice(-1)[0]);
    const quiet = (await callTool('cmsis_action', { action: 'status' }, 44)).content?.[0]?.text ?? '';
    check('the note comes once per batch', !quiet.includes('Note:'), quiet.split('\n').slice(-1)[0]);
    const counted = (await callTool('get_session_status', {}, 45)).content?.[0]?.text ?? '';
    const countLine = counted.split('\n').find((line) => line.startsWith('Problems: ')) ?? '';
    const countedSince = /since #(\d+) — get_recent_problems \{sinceSeq: (\d+)\}$/.exec(countLine);
    check('get_session_status counts the new errors and names the call that lists them',
        countedSince !== null && countedSince[1] === countedSince[2], countLine || counted.slice(0, 120));
    const listed = (await callTool('get_recent_problems', { sinceSeq: Number(countedSince?.[2]) }, 46)).content?.[0]?.text ?? '';
    check('get_recent_problems lists them from there on',
        listed.includes('[DAP_POWER_UP_FAILED] Failed to power up DAP') && listed.includes('error response to \'setBreakpoints\'')
            && /\nnextSeq=\d+$/.test(listed), listed.replace(/\n/g, ' | '));
    const cleared = (await callTool('get_session_status', {}, 47)).content?.[0]?.text ?? '';
    check('after get_recent_problems the count line is gone', /^State: /.test(cleared) && !cleared.includes('Problems: '),
        cleared.split('\n').filter((line) => line.startsWith('Problems')).join(' | '));

    // 6d. The session holds a serial port (#49): a mock port, opened through serial_open.
    const { SerialPortMock } = require('serialport');
    const { serialController } = require(path.join(OUT, 'core', 'serialController.js'));
    serialController.createPort = (options) => new SerialPortMock(options);
    SerialPortMock.binding.createPort('/dev/ttyMOCK48', { echo: true });
    const captured = await callTool('serial_capture', { path: '/dev/ttyMOCK48', write: 'hello\n', until: 'hello', durationMs: 5000 }, 49);
    const capturedText = captured.content?.[0]?.text ?? '';
    check('serial_capture reads until its regex matches and leaves the port closed',
        captured.isError !== true && captured.structuredContent?.stop === 'match' && /\(matched \/hello\/\)\. Port closed\./.test(capturedText)
            && !serialController.status().open,
        capturedText.split('\n')[0]);
    SerialPortMock.binding.createPort('/dev/ttyMOCK49');
    const serialOpened = await callTool('serial_open', { path: '/dev/ttyMOCK49' }, 50);
    const heldBy = await callTool('serial_status', {}, 51);
    check('serial_open holds the port for this session, released after 300 s without a serial call',
        serialOpened.isError !== true && /held by this session, released after 300 s without a serial call/.test(heldBy.content?.[0]?.text ?? ''),
        (heldBy.content?.[0]?.text ?? '').split('\n')[0]);

    // 6e. A wait the client gives up on: serial_read waits on the held, silent port while the
    //     client cancels it over the socket, then hangs up, as the SDK client does at its timeout.
    const { logger } = require(path.join(OUT, 'utils', 'logger.js'));
    const learned = [];
    const logInfo = logger.info;
    logger.info = function (message, detail) {
        if (/gave up on/.test(String(message))) { learned.push(String(message)); }
        return logInfo.call(this, message, detail);
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const giveUp = async (id, afterMs, reason) => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'serial_read', arguments: { waitMs: afterMs + 300 } } });
        const pendingCall = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'POST',
            headers: {
                'Host': `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
                'Content-Length': Buffer.byteLength(payload), 'mcp-session-id': sid,
            },
        });
        pendingCall.on('error', () => undefined);
        pendingCall.end(payload);
        await sleep(afterMs);
        const cancelled = await request(port, 'POST', { 'mcp-session-id': sid }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } });
        pendingCall.destroy();
        // The read's own wait ends before the next step uses the port.
        await sleep(350);
        return cancelled.status;
    };
    const userStop = await giveUp(52, 100, 'The user stopped the agent.');
    check('a call cancelled for another reason teaches the session nothing', userStop === 202 && learned.length === 0,
        `status=${userStop} ${learned.join(' | ')}`);
    const timedOut = await giveUp(53, 1000, 'McpError: MCP error -32001: Request timed out');
    check('a call the client gives up on with "Request timed out" teaches the session its client\'s limit, logged once',
        timedOut === 202 && learned.length === 1
            && new RegExp(`^MCP session ${sid}: the client gave up on serial_read after \\d s; long waits are cut to 1 s$`).test(learned[0]),
        `status=${timedOut} ${learned.join(' | ')}`);
    logger.info = logInfo;

    // 7. DELETE tears the session down
    const del = await request(port, 'DELETE', { 'mcp-session-id': sid });
    check('DELETE /mcp accepts a valid session', del.status === 200 || del.status === 204, `status=${del.status}`);
    const afterDelete = await openStream(port, sid);
    check('GET /mcp after DELETE is rejected with 404: the session is unknown now', afterDelete.status === 404, `status=${afterDelete.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const releasedByDelete = serialController.status();
    check('DELETE releases the serial port the session held, through the local serial handler (#49)',
        !releasedByDelete.open && releasedByDelete.lastRelease?.reason === 'owner-gone' && releasedByDelete.lastRelease?.path === '/dev/ttyMOCK49',
        JSON.stringify(releasedByDelete.lastRelease));

    await server.stop();

    // 7a. Session expiry (#49), on a clock the harness moves: 60 s idle here instead of 30 min.
    let clock = 1_000_000;
    const expiring = new DebugMCPServer(0, 30, undefined, undefined,
        { sessionExpiry: { idleMs: 60_000, sweepMs: 3_600_000, now: () => clock } });
    await expiring.initialize();
    await expiring.start();
    const eport = expiring.getActualPort();
    const openAt = async (p) => {
        const r = await request(p, 'POST', {}, {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-check', version: '1.0.0' } },
        });
        const id = r.headers['mcp-session-id'];
        await request(p, 'POST', { 'mcp-session-id': id }, { jsonrpc: '2.0', method: 'notifications/initialized' });
        return id;
    };
    const idleSid = await openAt(eport);
    const streamingSid = await openAt(eport);
    const busySid = await openAt(eport);
    SerialPortMock.binding.createPort('/dev/ttyMOCK50');
    await request(eport, 'POST', { 'mcp-session-id': idleSid }, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'serial_open', arguments: { path: '/dev/ttyMOCK50' } },
    });
    const held = await holdStream(eport, streamingSid);
    clock += 50_000;
    await request(eport, 'POST', { 'mcp-session-id': busySid }, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    clock += 20_000;
    const swept = expiring.sweepIdleSessions();
    check('the sweep ends the session idle for the limit and spares one with an open GET stream and one used meanwhile',
        swept === 1 && held.status === 200, `ended ${swept}, stream ${held.status}`);
    const expiredPost = await request(eport, 'POST', { 'mcp-session-id': idleSid }, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    const expiredGet = await openStream(eport, idleSid);
    check('a request with the expired session id gets 404, so the client starts over (#14)',
        expiredPost.status === 404 && expiredGet.status === 404,
        `POST ${expiredPost.status}, GET ${expiredGet.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const releasedByExpiry = serialController.status();
    check('the expiry releases the serial port the session held',
        !releasedByExpiry.open && releasedByExpiry.lastRelease?.reason === 'owner-gone' && releasedByExpiry.lastRelease?.path === '/dev/ttyMOCK50',
        JSON.stringify(releasedByExpiry.lastRelease));
    const spared = await request(eport, 'POST', { 'mcp-session-id': busySid }, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    check('the session used meanwhile keeps working', spared.status === 200, `status=${spared.status}`);
    await held.close();
    // The server hears of the hang-up a moment after the client.
    await new Promise((resolve) => setTimeout(resolve, 100));
    clock += 61_000;
    const later = expiring.sweepIdleSessions();
    const streamGone = await request(eport, 'POST', { 'mcp-session-id': streamingSid }, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} });
    check('once its stream closed, that session expires too', later === 2 && streamGone.status === 404,
        `ended ${later}, status ${streamGone.status}`);
    await expiring.stop();

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
    const cnames = ctools.map((t) => t.name);
    check('serialEnabled:false leaves the serial tools out',
        cnames.every((n) => !n.startsWith('serial_')) && ctools.length === tools.length - serialCount,
        `${ctools.length} tools`);
    await request(cport, 'DELETE', { 'mcp-session-id': csid });
    await configured.stop();

    // 9. The documentation / build-artefact tools are off by default (the
    //    list measured above) and on per instance through two gates. Real
    //    handlers on a temp-dir host — the cores need no vscode — so the
    //    enabled list is measured against its own budget and the tools answer
    //    a workspace with no build with guidance rather than an error.
    const { PackDocsHandler } = require(path.join(OUT, 'packDocsHandler.js'));
    const { BuildInfoHandler } = require(path.join(OUT, 'buildInfoHandler.js'));
    const { localPackDocsDispatch } = require(path.join(OUT, 'packDocsDispatch.js'));
    const { defaultSettings, silentLog } = require(path.join(OUT, 'core', 'packDocs', 'host.js'));
    const { defaultBuildInfoSettings } = require(path.join(OUT, 'core', 'buildInfo', 'host.js'));
    const { DebuggingExecutor, ConfigurationManager, DebuggingHandler } = require(path.join(OUT, 'index.js'));
    const { localSerialDispatch } = require(path.join(OUT, 'debugMCPServer.js'));
    const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-packdocs-'));
    const docsHost = {
        packRoot: path.join(docsDir, 'packs'), storageDir: path.join(docsDir, 'store'),
        settings: () => defaultSettings, log: silentLog, userAgent: 'transport-check',
        workspaceFolders: () => [docsDir], findCbuildRunFiles: async () => [],
    };
    const buildHost = { workspaceFolders: () => [docsDir], findFiles: async () => [], settings: () => defaultBuildInfoSettings, log: silentLog };
    const packDocs = localPackDocsDispatch({
        docs: new PackDocsHandler(docsHost, { timeoutMs: 30_000 }),
        build: new BuildInfoHandler(buildHost, { timeoutMs: 30_000 }),
    });
    const debug = new DebuggingHandler(new DebuggingExecutor(), new ConfigurationManager(), 30);
    const full = new DebugMCPServer(0, 30, undefined, () => ({ debug, serial: localSerialDispatch, packDocs }),
        { packDocsEnabled: true, buildInfoEnabled: true });
    await full.initialize();
    await full.start();
    const fport = full.getActualPort();
    const finit = await request(fport, 'POST', {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-check', version: '1.0.0' } },
    });
    const fsid = finit.headers['mcp-session-id'];
    const finstructions = parseSse(finit.body)?.result?.instructions ?? '';
    check('the server instructions mention the documentation and build-artefact tools when they are on',
        /documentation tools/.test(finstructions) && /build-artefact tools/.test(finstructions));
    await request(fport, 'POST', { 'mcp-session-id': fsid }, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const flist = await request(fport, 'POST', { 'mcp-session-id': fsid }, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    const ftools = parseSse(flist.body)?.result?.tools ?? [];
    const fnames = new Set(ftools.map((t) => t.name));
    const PACKDOCS_TOOLS = ['list_target_docs', 'search_target_docs', 'read_doc_pages', 'fetch_doc', 'get_peripheral_docs',
        'list_build_artifacts', 'get_memory_usage', 'lookup_symbol', 'get_section_layout', 'get_build_diagnostics'];
    check('packDocs/buildInfo enabled adds exactly the ten documentation and build-artefact tools and the three knowledge tools',
        PACKDOCS_TOOLS.every((n) => fnames.has(n)) && ftools.length === tools.length + PACKDOCS_TOOLS.length + 3,
        `${ftools.length} tools`);
    check('the default list carries none of them', PACKDOCS_TOOLS.every((n) => !names.includes(n)));
    // Budget for the everything-on list; the default list keeps its own above.
    // 55 tools measured 40 644 bytes in 2.5.0: the ten documentation and
    // build-artefact tools cost ~11.7 kB, most of it the per-tool
    // target/pack/device/board arguments. Raised from 42 000 for the 2.5.1
    // additions. Raised from 44 000 for the knowledge tools, which are on in
    // every session (45 243 measured, before any trimming). Raised from 46 000
    // for cmsis_query and cmsis_action create_solution (46 315 measured). A
    // regression must be attributable to one tool, hence the cap.
    const TOOLS_LIST_ALL_BUDGET_BYTES = 47_000;
    const ftoolsBytes = Buffer.byteLength(JSON.stringify(ftools));
    check(`tools/list with every group on stays under the ${TOOLS_LIST_ALL_BUDGET_BYTES} byte budget`,
        ftoolsBytes <= TOOLS_LIST_ALL_BUDGET_BYTES, `${ftoolsBytes} bytes`);
    const flongest = ftools.map((t) => ({ name: t.name, len: (t.description ?? '').length })).sort((a, b) => b.len - a.len)[0];
    check(`no documentation or build-artefact description exceeds ${DESCRIPTION_CAP_CHARS} chars`,
        flongest.len <= DESCRIPTION_CAP_CHARS, `${flongest.name} ${flongest.len}`);
    const fcall = async (name, args, id) => {
        const r = await request(fport, 'POST', { 'mcp-session-id': fsid }, {
            jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
        });
        const parsed = parseSse(r.body);
        return { error: !!parsed?.error || parsed?.result?.isError === true, text: parsed?.result?.content?.[0]?.text ?? '' };
    };
    const ldocs = await fcall('list_target_docs', {}, 3);
    check('list_target_docs on a workspace without a build explains what to do instead of failing',
        !ldocs.error && /cbuild-run|pack/i.test(ldocs.text), ldocs.text.split('\n')[0]);
    const lbuild = await fcall('list_build_artifacts', {}, 4);
    check('list_build_artifacts on a workspace without a build explains what to do instead of failing',
        !lbuild.error && /cbuild-run|build/i.test(lbuild.text), lbuild.text.split('\n')[0]);
    await request(fport, 'DELETE', { 'mcp-session-id': fsid });
    await full.stop();

    // 10. The experimental knowledge tools: in neither list above, and three
    //     tools more through their own gate. Without an index they fail with
    //     the setting to fill in.
    const { KnowledgeHandler } = require(path.join(OUT, 'knowledgeHandler.js'));
    const knowledgeDispatch = localPackDocsDispatch({
        docs: new PackDocsHandler(docsHost, { timeoutMs: 30_000 }),
        build: new BuildInfoHandler(buildHost, { timeoutMs: 30_000 }),
        knowledge: new KnowledgeHandler(
            { indexPath: () => undefined, includeIncomplete: () => false, packRoot: async () => undefined, workspaceFolders: () => [], projectFacts: async () => ({}), log: silentLog }, { timeoutMs: 30_000 }),
    });
    const withKnowledge = new DebugMCPServer(0, 30, undefined, () => ({ debug, serial: localSerialDispatch, packDocs: knowledgeDispatch }),
        {});
    await withKnowledge.initialize();
    await withKnowledge.start();
    const kport = withKnowledge.getActualPort();
    const kinit = await request(kport, 'POST', {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-check', version: '1.0.0' } },
    });
    const ksid = kinit.headers['mcp-session-id'];
    // The knowledge index is mandatory: every session with a documentation dispatch names the tools in its instructions.
    check('the server instructions name the knowledge tools in every session',
        /knowledge_search/.test(parseSse(kinit.body)?.result?.instructions ?? '') && /knowledge_search/.test(instructions) && /knowledge_search/.test(finstructions));
    await request(kport, 'POST', { 'mcp-session-id': ksid }, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const klist = await request(kport, 'POST', { 'mcp-session-id': ksid }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const ktools = parseSse(klist.body)?.result?.tools ?? [];
    const KNOWLEDGE_TOOLS = ['knowledge_search', 'knowledge_get', 'knowledge_expand'];
    check('knowledge enabled adds exactly the three knowledge tools',
        KNOWLEDGE_TOOLS.every((n) => ktools.some((t) => t.name === n)) && ktools.length === tools.length + KNOWLEDGE_TOOLS.length, `${ktools.length} tools`);
    check('without a documentation dispatch the default list has no knowledge tools', KNOWLEDGE_TOOLS.every((n) => !names.includes(n)));
    check('with the documentation dispatch every group on offers them', KNOWLEDGE_TOOLS.every((n) => fnames.has(n)));
    // What the three tools add to every turn of a session that has them.
    const KNOWLEDGE_TOOLS_BUDGET_BYTES = 2_000;
    const knowledgeBytes = Buffer.byteLength(JSON.stringify(ktools)) - toolsBytes;
    check(`the knowledge tools add at most ${KNOWLEDGE_TOOLS_BUDGET_BYTES} bytes to tools/list`,
        knowledgeBytes > 0 && knowledgeBytes <= KNOWLEDGE_TOOLS_BUDGET_BYTES, `${knowledgeBytes} bytes`);
    const ksearch = parseSse((await request(kport, 'POST', { 'mcp-session-id': ksid }, {
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'knowledge_search', arguments: { query: 'M302' } },
    })).body);
    const ksearchText = ksearch?.result?.content?.[0]?.text ?? '';
    check('knowledge_search without an index fails with TOOL_DISABLED and names the setting',
        ksearch?.result?.isError === true && /^\[TOOL_DISABLED\]/.test(ksearchText) && /knowledge\.indexPath/.test(ksearchText), ksearchText.split('\n')[0]);
    await request(kport, 'DELETE', { 'mcp-session-id': ksid });
    await withKnowledge.stop();
    fs.rmSync(docsDir, { recursive: true, force: true });

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
