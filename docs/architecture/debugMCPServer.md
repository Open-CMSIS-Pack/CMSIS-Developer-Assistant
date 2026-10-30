# DebugMCPServer and the session tool surface

The MCP endpoint of the extension lives in two files:

- `src/debugMCPServer.ts` is the HTTP side: the loopback listener, one MCP
  transport and one MCP server per client session, start and stop, and where
  the measurement of each tool call goes.
- `src/debugTools.ts` is what a client sees inside a session: the server name
  and instructions, the tools with their descriptions and input schemas, and
  the Markdown files served as resources.

## Why it is built this way

Agents outside VS Code (Claude Code, Codex, Cursor, Cline and others) and
Copilot inside it all reach the extension through one Streamable HTTP URL,
`http://localhost:<serverPort>/mcp`, port 3001 unless configured otherwise.
Three constraints shape the code:

- **Runs without VS Code.** `debugMCPServer.ts` does not import `vscode` and
  reads no settings. Port, timeouts, the handler factory and the options come
  in through the constructor, so the transport harness under
  `test/transport/` runs the real server in plain Node with a stubbed `vscode`
  module.
- **Sessions share nothing.** An early version kept one MCP server for all
  requests and closed it after each one; a concurrent call then lost its
  transport, and the third `get_threads` of a session never answered. Now a
  session owns its transport and its server from `initialize` until the
  transport closes, and nothing is closed while one of its requests runs.
- **The tool list holds for a session.** The switches that add or remove tool
  groups are fixed when the server instance is built and read when a session
  is built. A client that cached `tools/list` never finds a tool gone, or a
  new one, halfway through its session. Changing those settings takes a
  window reload.

## The HTTP endpoint

`buildApp()` puts together an Express app that listens on `127.0.0.1` only.

| Route | Answer |
| ----- | ------ |
| `POST /mcp` | An `initialize` request without a session id opens a session; every other request must name an open session in `mcp-session-id`. |
| `GET /mcp` | The server-sent event stream of the named session; 405 for a session whose client is on `NO_GET_STREAM_CLIENTS` (Kimi Code). |
| `DELETE /mcp` | Ends the named session. |
| `GET /sse` | 410 with a pointer to `POST /mcp`: the SSE transport of older releases is retired. |
| any other | 404 with a JSON-RPC error that names the endpoint, for example for an agent entry that names the port without `/mcp`: the client shows that text, where Express's HTML "Cannot POST /" told the user nothing. |

- `loopbackOnly` answers 403 to a `Host` header that does not name this
  machine and to an `Origin` that is not local (`isLoopbackHostHeader()`,
  `isLoopbackOrigin()` from `src/utils/loopback.ts`, which the control
  server of each window uses too), before the body is read. Together they
  keep a web page that resolves its own host name to 127.0.0.1 (DNS
  rebinding) away from the tools.
- A body above 1 MB is refused with 413 before MCP code sees it.
- An idle keep-alive connection stays open for 120 s (`listenOnLoopback()`).
  Node's default of 5 s raced clients that pool connections longer, such as
  Codex: a request sent while the server closed the socket failed with
  "error sending request". `closeHttpServer` still drops idle sockets at
  dispose, so a router change does not leave clients on a dead one.
- A request that names no session, and is not an initialize request, gets a
  JSON-RPC error with `id: null` and status 400. A request that names a
  session this server does not know gets 404 with the JSON-RPC code -32001
  and the message "Session not found", on `POST` (an initialize request
  included), `GET` and `DELETE` alike (#14). That is what the SDK's own
  transport answers and what the MCP specification prescribes: only a 404
  tells a client to initialize a new session. It matters after a router
  change, when the new router has never seen the clients' session ids;
  before 2.5.1 they got 400 and stayed stuck until restarted. The routes
  themselves always exist: Express's HTML 404 for a missing `GET` route is
  what once made Cursor mark the whole server as failed. A request whose
  handling throws gets 500.

## Session life cycle

1. `acceptPost()` receives an `initialize` request without a session id and
   calls `openSession()`: a `ToolMetrics` ring for the session, a server from
   `buildSessionServer()`, and a `StreamableHTTPServerTransport` that issues a
   random UUID as the session id.
2. When the SDK assigns that id, `adopt()` enters the pair in the session map
   and logs one info line that names the client and its version, `MCP
   session <id> opened by <name> <version>`. The SDK assigns the id before its
   server has read the initialize request, so the name comes from the
   request's `clientInfo`, which `acceptPost()` hands to `openSession()`.
   A session that fails before this point is closed at once (`discard()`).
3. Later requests carrying the id go straight to the session's transport
   (`acceptSessionRequest()` for `GET` and `DELETE`). Each one marks the
   session as used (`lastSeenAt`, when it arrives and when its answer is
   done); a `GET` counts as an open stream until its connection closes.
4. When the transport closes (client `DELETE`, expiry, or `stop()`),
   `release()` removes the entry and tells the session's handlers
   (`announceEnd()`, without waiting).
5. Expiry (#49): many clients never send `DELETE`, they just go away. Every
   minute `sweepIdleSessions()` closes the transport of each session that has
   had no request for 30 minutes and holds no `GET` stream open; a request
   with its id is then refused like any unknown id. Clock, idle time and sweep
   interval come from the `sessionExpiry` option, which tests use.

A client that takes the loss of its `GET` stream as the end of the server
gets no stream (`NO_GET_STREAM_CLIENTS` in `src/core/clientHosting.ts`):
its `GET` is answered 405, as the specification allows for a server that
offers none, and the SDK client then opens none. The stream drops at every
restart of the endpoint (a reload or close of the router window, a router
change); the SDK client retries it twice within about 2.5 s and gives up
with "Maximum reconnection attempts (2) exceeded", which Kimi Code treats as
final: the server is marked failed, and a Kimi session opened or resumed
afterwards has none of its tools until the window reloads. Without the
stream the first call after a restart gets 404, and Kimi reconnects and
retries it. Such a session expires after 30 idle minutes like one of a
client that never opens a stream, and is opened again the same way.

A session's end matters beyond the server: the serial ports it held stay
held otherwise (see [serial.md](serial.md)). `SessionHandlers.ended` hears
of it; the coordinator gives a routed session one that tells every window
the session forwarded to. A session without it whose serial ops run locally
(`localSerialDispatch`) tells the local serial handler instead.

The handlers a session talks to (`SessionHandlers`: `debug`, `serial` and the
optional `packDocs` dispatch) come from the factory given to the constructor,
which is called once while the session is built; the session keeps them. In
the extension the factory belongs to the `WindowCoordinator` and returns a new
`RoutingDebuggingHandler` for every session (see
[windowRouting.md](windowRouting.md)). There each call is forwarded to the
window that owns its target, under a budget the target window's own fence
answers within, and after a health check when that window has been quiet;
the sessions of one router share when each window last answered (#14, see
[Fences and health checks](windowRouting.md#fences-and-health-checks)).
Every window publishes its role, and the router's status bar lists the
sessions. Without a factory, as in the transport
tests, one `DebuggingHandler` with `localSerialDispatch` serves all sessions
(`singleWindowHandlers()`). `describeSessions()` lists the open sessions with
their client's name and, for a routing handler, the window its path-less
calls go to; the router window's status bar shows them (#16).

## Start and stop

- `initialize()` has nothing to do; it keeps the two-step start its callers
  follow.
- `start()` binds the configured port and has no fallback port.
  `listenOnLoopback()` waits for the `listening` event, because Express 5
  calls the listen callback on failure as well. `EADDRINUSE` becomes
  `PortInUseError`: another window serves MCP, and the caller becomes a worker.
- `start()` also starts the sweep timer of the expiry, which never keeps
  the process alive; `stop()` clears it.
- `stop()` closes every session, then the HTTP server through
  `closeHttpServer()` (idle connections at once, busy ones after a grace
  period). It is safe after a failed start. The window's own serial ports are
  released by the window coordinator, not here; closing the sessions tells
  the other windows, as any session end does.
- `getActualPort()` reports the port actually bound, which tests use with a
  configured port of 0.

## Measurement and telemetry

Every tool is registered through `MeasuredMcpServer`
(`src/core/measuredMcpServer.ts`). It wraps each tool callback and records a
`ToolSample` at the MCP boundary: tool name, argument and result bytes,
duration, outcome and session id. The outcome is `ok`, `timeout` or `error`.
`classifyOutcome()` in `src/core/toolMetrics.ts` reads it from the result's
status and `isError` first — an error with the code `TIMEOUT` or
`WORKER_TIMEOUT` counts as a timeout, a `running` reply as ok — and only a
result without either is judged by its wording, the way 2.3.10 texts were.
Because the sample is taken at the boundary, it measures what the client
experienced, forwarding to another window included.

The wrapper also gives every call an id, the first eight characters of the
MCP session id and a count (`ebc40edd-20`), and runs the callback inside a
call context with that id and the session id (`src/core/callContext.ts`,
Node's `AsyncLocalStorage`). Whatever the call awaits sees it: the router
copies both into the control envelope, and the problem journal stamps its
records with the id (#48). `serial_open` records the session id as the
holder of the port (#49).

The sample goes into the session's ring of 200 samples. The ring's callback,
`observe()`, adds it to the totals of the server instance (500 samples),
appends it as one JSON line to the file named by the `telemetry.jsonlPath`
setting (`jsonlSink()`: never awaited, and silent after the first failed
write, which logs one warning), and logs a one-line summary. The session
totals close every `get_session_status` reply; the
`cmsis-developer-assistant://stats` resource returns the session totals, the
instance totals and the last 50 samples as JSON.

## What a session offers

`buildSessionServer()` in `src/debugTools.ts` creates the server of one
session and registers its tools and resources.

### Identity and instructions

The server reports the name `cmsis-developer-assistant` and the version
`SERVER_VERSION` from `src/debuggingExecutor.ts`. The `instructions` of the
initialize result come from `buildServerInstructions()` in
`src/core/serverInstructions.ts`, and they start with the tool rules (#50):
the rules block of `docs/agent-resources/tool-contract.md`, which says what
the rules cover (the targets of the CMSIS Debugger, not a host program or a
board of another toolchain), keeps agents from running pyOCD, GDB, cbuild or
a serial terminal in the shell against such a target and tells them what to
do when a tool fails. The block holds only the scope and the bans, because
the same block goes into user-level rule files that agents read in every
project; what matters in a session alone is said after it. Many clients keep
the instructions in the system prompt for the whole session, and a client
that shortens them keeps the beginning, so the rules lead. `DebugMCPServer` reads them once, when it
is built (`loadToolRules()` through `ShippedDocs.readNow()`); without the
file, or without its rules block, every session gets the instructions
without the rules, and a warning says why.

After the rules, `composeInstructions()` adds fixed sentences: what the tools
are for, to invoke the `cmsis-help` Agent Skill first and what it brings,
that the other CMSIS procedures come from `knowledge_search` and
`knowledge_get`, `get_debug_instructions` for harnesses that load no skills, the 60 s
cap on `timeoutMs` (600 s for `cmsis_action` and `flash`) and that a wait the
client gives up on is no failure (the work goes on, `cmsis_action status`
returns its result), how to read a
result (`isError` and the `[CODE]` prefix; `timeout` and `running` are not
failures; a running target wants `pause_execution` first), that the control
server and the registry files are internal and several windows are told
apart with `list_debug_windows` and `select_debug_window`, and one sentence
each for the documentation and build-artefact groups. While a group is off,
its sentence names the setting that enables it instead.
`src/test/debugSkillGuidance.test.ts` and `src/test/toolContract.test.ts`
pin the phrases agents rely on.

The first `get_session_status` of a session repeats the rules in one line
(`TOOL_RULES_REMINDER`), between the status and the call statistics: by then
the instructions may lie far back in the conversation, or have been
compacted away. A client whose model never sees the instructions at all
(`NO_INSTRUCTIONS_CLIENTS` in `src/core/clientHosting.ts`: Kimi Code) gets
the whole rules block there instead of a line that points at them. A flag in
the closure of that registration keeps it to one reply per session; the state
lives where the session is built, in the router window, so no worker takes
part.

Neither the rules, nor the sentence on results, nor the reminder is in a tool
description: `tools/list` goes along with every turn, and
`test/transport/session-lifecycle.js` pins its size. The rules also reach the
bundled skills and the agent guide, together with the table of shell commands
and the tools that replace them: `npm run skills:sync` copies both
blocks between marker comments (`src/core/toolContract.ts`,
`src/utils/markerBlock.ts`; see `skills/README.md`), and
`src/test/toolContract.test.ts` compares every copy with the source.

### Tools

`registerTools()` registers each tool with a literal name
(`mcp.registerTool('read_memory', …)`), its description from the `ABOUT`
table, a zod input schema, and the annotations where they apply:
`LOOK_ONLY`, `ALTERS_TARGET`, or `SETS_UP_TARGET` for `read_cycle_counter`,
which enables the cycle counter on first use (not read-only, not
destructive, idempotent). Every callback passes the parsed arguments to one handler
method and hands its outcome to `reply()`. Nothing is caught here: a
rejection reaches `MeasuredMcpServer`, which answers it as an error result
itself (see [Results](#results)). `src/packDocsTools.ts` and
`src/buildInfoTools.ts` reply the same way.

| Group | Registered when | Answered by |
| ----- | --------------- | ----------- |
| Session, run control, breakpoints, variables, Cortex-M state, SVD lookups, stack and threads, `cmsis_action`, `cmsis_query`, `flash`, `get_session_status`, `get_recent_problems` | always | the session's debugging handler |
| `get_debug_instructions` | always | `ShippedDocs` and the topic slicer, no handler |
| The eleven `serial_*` tools | `serialEnabled` is not `false` | the `serial` dispatch, by op name |
| Documentation (`registerPackDocsTools()`) | `packDocsEnabled`, and the session has a `packDocs` dispatch | `src/packDocsTools.ts`, then the dispatch |
| Build artefacts (`registerBuildInfoTools()`) | `buildInfoEnabled`, and the session has a `packDocs` dispatch | `src/buildInfoTools.ts`, then the dispatch |
| Knowledge (`registerKnowledgeTools()`) | the session has a `packDocs` dispatch; always enabled in the extension | `src/knowledgeTools.ts`, then the dispatch |
| `list_debug_windows`, `select_debug_window` | the debugging handler is a window router | the router |
| The `window` argument on the tools in `WINDOW_ARGUMENT_TOOLS` (`cmsis_action`, `flash`, `reset`, `serial_open`, `serial_capture`, `knowledge_search`) | the debugging handler is a window router | the router, which reads it and never forwards it |

A router is recognised by its two extra methods (`windowRoutingOf()`), so this
module does not import the routing code. A router's calls are journaled in
the window they are forwarded to; on a server without a router,
`buildSessionServer()` wraps the session's handlers with `journalLocally()`
(`src/core/problemFeed.ts`), which runs each op the way a control server
runs a forwarded one: registered in this window's problem journal, with the
problems of a failure attached, and with the session's notice of new errors
(#48, see [debuggingHandler.md](debuggingHandler.md#the-problem-journal)).
Tool names stay literal because
`src/test/skill.test.ts` collects them from the `registerTool('…'` calls and
compares them with the `allowed-tools` list of the `cmsis-help` skill.
The `window` argument is added in one place for all its tools:
`buildSessionServer()` calls `MeasuredMcpServer.addArgument()` before the
tools are registered, and the server appends the argument to the input shape
of each tool in the list, so a tool joins by adding its name to
`WINDOW_ARGUMENT_TOOLS`. A single window has no windows to name, and its
`tools/list` does not change.

### Results

A handler resolves with a `ToolText` — a plain string, or a `ToolReply`
with a status — or rejects, normally with a `ToolError` that carries an
error code, a message and a hint (`src/core/toolResult.ts`, #11).
`toCallToolResult()` in `src/core/measuredMcpServer.ts` is the only place
that turns this into an MCP result:

| Outcome | Text | `isError` | `structuredContent` |
| ------- | ---- | --------- | ------------------- |
| string | the string | — | none |
| reply `ok` | its text | — | `{status: 'ok', message, ...data}`, only with data |
| reply `running` or `timeout` | its text | — | `{status, message, ...data}` |
| `ToolError` | `[CODE] message`, the hint on the next line | `true` | `{status: 'error', error_code, message, hint, ...data}` |

A plain `Error` gets a code from `classifyError()`, so the SDK's own error
result, which would carry the message alone, is never used for a handler's
failure; schema errors are raised by the SDK before the callback runs and
stay its own. No tool declares an `outputSchema`: the SDK passes
`structuredContent` through without one, and the tool list stays as it is.
Some clients show the model `structuredContent` instead of the text, so
every `structuredContent` carries the whole text as `message` (and the
hint as `hint`), and a plain success carries none at all. The surface and
DAP oracles fail any reply whose `structuredContent` leaves out a line of
its text (`linesMissingFromStructured()`). `get_session_status` appends its
statistics to the text of the handler's outcome.

Other clients show the model both, the text and `structuredContent`
serialized after it. For them that guarantee doubles every result with
data: in a tester's session under the GitHub Copilot SDK agent, 635 KB of
`structuredContent` came on top of 764 KB of text, and that client puts a
result over about 8 KB into a file the agent then pages through (50 of 410
calls). So the shape of a result also depends on the client:
`MeasuredMcpServer` drops `structuredContent` from every result of a session
whose client sent a name in `TEXT_ONLY_CLIENTS` (`src/core/clientHosting.ts`,
matched exactly, `wantsTextOnly()`). The text is complete without it, and a
failure keeps `isError` and its `[CODE]`. The wrapper classifies the outcome
from the whole result before, and records the bytes the client receives.
The list holds `kimi-code`, Kimi Code's name for its CLI and its VS Code
extension, which append `structuredContent` to the text as JSON; the Copilot
SDK's name joins it once known. The constructor takes another list for
tests.

The problem records that ride along with a failure or a timeout
(`data.problems`, #48) reach `structuredContent.problems` like any other
data, and `toCallToolResult()` also lists them under the text as
"Recent problems:", one line each (`renderProblemsBlock()`). The block is
rendered here rather than in the window that ran the call, so the records
cross the control channel once, as data.

### Long waits and the client's timeout

A call may wait minutes: `cmsis_action` and `flash` take `timeoutMs` up to
600 s, the documentation tools too. The client has a request timeout of its
own, which the server cannot ask for: the MCP TypeScript SDK defaults to
60 s, and the GitHub Copilot SDK agent gave up after 180 s in a tester's
session while a first build downloaded packs. The client then cancels the
request (`notifications/cancelled`), the SDK drops the reply, and the agent
learns nothing of a build that went on. `MeasuredMcpServer` deals with it at
the boundary, so that no handler and no worker window has to know the client:

- **Progress.** A request that carries `_meta.progressToken` gets a
  `notifications/progress` every 15 s once it has run that long, with the
  seconds so far (`watchCall()`). A client that resets its timeout on
  progress keeps waiting; without a token nothing is sent.
- **The learned limit.** A call cancelled with a timeout as the reason (the
  SDK's "Request timed out", -32001) tells the session how long its client
  waits: the time the call had run, the shortest one kept, logged once. From
  then on, a call whose wait exceeds that limit less 10 s gets `timeoutMs`
  cut to it before the callback runs (`cutWait()`, `cutWaitMs()`). The wait
  is the call's `timeoutMs`, or the default a tool declares
  (`declareWait()`; `cmsis_action`'s depends on the action). A tool without
  `timeoutMs` is never cut, nor is `flash`: its `timeoutMs` is pyOCD's
  budget, so a cut would end the programming, not just the wait.

A cut wait that runs out is answered like any other — status `running` or
`timeout`, the job goes on — and its reply carries one more line that says
why the wait was shorter than asked and how to pick up the result
(`clientLimitNote()`), in the text and in `structuredContent.message`. A
call that ended within the cut wait gets no note. A cancellation for another
reason, such as the user stopping the agent, teaches nothing. The limit lives
in the session's server and ends with it: the first call a client gives up on
is still lost, the later ones are answered. The documentation tools take
their default wait from the worker window's settings, which the session does
not know, so only their explicit `timeoutMs` is cut.

### Resources and shipped documents

| URI | Content |
| --- | ------- |
| `cmsis-developer-assistant://stats` | Tool-call statistics, JSON |
| `cmsis-developer-assistant://docs/debug_instructions` | `docs/agent-resources/debug_instructions.md` |
| `cmsis-developer-assistant://docs/cmsis-embedded-guide` | `docs/agent-resources/cmsis-embedded-guide.md` |
| `cmsis-developer-assistant://docs/troubleshooting/embedded` | `docs/agent-resources/troubleshooting/embedded.md` |
| `cmsis-developer-assistant://docs/troubleshooting/<lang>` | `docs/agent-resources/troubleshooting/<lang>.md` for `python` and `cpp` (C and C++) |

`ShippedDocs` reads a file on first use and keeps its text for the life of
the server instance. It looks for `docs/` first next to the bundle's
directory (`dist/`), then two levels above the tsc output (`out/src/`), so
both layouts work. A file that cannot be read is answered with a note that
names the paths tried, and is tried again on the next request. `readNow()`
reads the same way but at once, for what a session needs before its first
request: the tool contract, which is not a resource of its own.

`get_debug_instructions` does not return the guide whole. `sliceTopic()` in
`src/core/instructionTopics.ts` cuts it at its
`<!-- topic: name | blurb -->` … `<!-- /topic -->` markers and returns either
the overview with the topic list or one topic. If the markers are broken, the
whole guide is served and a warning is logged.

A topic is sized to be read in one piece: GitHub Copilot's agent writes a
result over about 8 KB to a file and pages through it, which is why the
`build` topic became `target`, `cmsis-action` and `flash` in 2.7.0, and why
every topic is held to at most 7 000 bytes as served. A topic that grows past it
first loses what the tool descriptions and replies already say; it is split
only where it has two halves an agent asks for apart. A retired
name stays in the tool's enum (`RETIRED_TOPICS`) and serves the topic that
took over most of it, under one line that says where the rest went, so that a
skill, a knowledge procedure or an agent's memory written before the split
still gets an answer.

## Where to look

- `src/debugMCPServer.ts`: `DebugMCPServer` (`start`, `stop`, `buildApp`,
  `acceptPost`, `acceptSessionRequest`, `openSession`, `release`,
  `announceEnd`, `sweepIdleSessions`, `describeSessions`, `observe`),
  `loopbackOnly`, `listenOnLoopback`, `jsonlSink`, `singleWindowHandlers`,
  `PortInUseError`, `SessionHandlers`, `SessionExpiry`,
  `DebugMCPServerOptions`, `localSerialDispatch`
- `src/debugTools.ts`: `buildSessionServer`, `loadToolRules`, `ABOUT`,
  `WINDOW_ARGUMENT_TOOLS`, `registerTools`, `registerResources`,
  `ShippedDocs`, `SHIPPED_RESOURCES`
- `src/core/serverInstructions.ts`: `buildServerInstructions`,
  `composeInstructions`, `TOOL_RULES_REMINDER`
- `src/core/toolContract.ts` and `src/utils/markerBlock.ts`: the tool
  contract's blocks, their copies and the marker comments around them
- `src/core/measuredMcpServer.ts` (`toCallToolResult`, `addArgument`,
  `shapedForClient`, `declareWait`, `watchCall`, `cutWait`, `cutWaitMs`,
  `clientLimitNote`) and `src/core/toolMetrics.ts`: the MCP result, its shape
  per client, the added arguments, progress and the client's limit, and
  measurement;
  `src/core/clientHosting.ts`: `TEXT_ONLY_CLIENTS`, `wantsTextOnly`;
  `src/core/callContext.ts`: the call context
- `src/core/problemFeed.ts`: `journalLocally`, `renderProblemsBlock` and the
  rest of the problem journal's delivery
- `src/core/toolResult.ts`: `ToolText`, `ToolReply`, `ToolError`, the error
  codes and their classification
- `src/core/instructionTopics.ts`: topic markers of the guide
- `src/windowCoordinator.ts`: builds the server in the window that wins the
  port

## Tests

- `src/test/loopback.test.ts`: the `Host` and `Origin` checks;
  `src/test/debugMCPServer.test.ts`: that the server still exports them
- `src/test/measuredMcpServer.test.ts`: every outcome as a client receives
  it, the metrics outcome, an added argument, the call ids and context, the
  problems block, the text alone for a client on the text-only list, and
  long waits against an SDK client that times out: the limit learned or
  not, the cut and its note, progress notifications;
  `src/test/clientHosting.test.ts`: which names are on it
- `src/test/toolResult.test.ts`: classification, wrapping, the reading of
  2.3.10 texts
- `src/test/debugSkillGuidance.test.ts`: instructions, tool descriptions and
  the guide send agents to the live debugger first
- `src/test/toolContract.test.ts`: the rules' size, the tools the contract
  names, every copy against the source, the rules first in the instructions,
  the reminder once per session; `src/test/markerBlock.test.ts`: the marker
  comments
- `src/test/instructionTopics.test.ts`: marker grammar, the shipped
  guide's topics and their sizes, the retired names
- `test/transport/session-lifecycle.js`: sessions over real HTTP — session
  ids, the 400 answers without a session id and the 404 with -32001 for an
  unknown one, three consecutive `get_threads`, the 413 limit,
  topics, statistics, typed errors without a session, no `outputSchema`,
  no `window` argument, the tool rules first and once in a status, the
  pinned `tools/list` size, and the problem journal without a router: an
  empty `get_recent_problems`, the problems of a failing call, the note and
  the count of new errors; the serial port of a session released by
  `DELETE` and by expiry, and a session with an open stream or a recent
  request spared by the sweep; a pending call cancelled over the socket,
  which teaches the session its client's limit only for a timeout
- `test/transport/surface-snapshot.js` (`npm run test:surface`): initialize
  result, tool list, resources and every tool's reply without a session,
  compared with `test/transport/surface.snapshot.json`
- `test/transport/two-window-routing.js`: the server as router for two
  windows, the routed `tools/list` with its budget and the `window` argument,
  and after failover the old session id answered with 404
