# Transport harness

Drives the real `DebugMCPServer` over HTTP outside the extension host, with a
stubbed `vscode` module (`vscode-stub.js`, injected via a `Module._resolveFilename`
override). No board and no VS Code required.

```sh
npm run compile
node test/transport/session-lifecycle.js
node test/transport/two-window-routing.js
```

Each exits non-zero if any check failed.

## What `session-lifecycle.js` covers

- `POST /mcp` with an `initialize` request mints an `mcp-session-id`.
- `GET /mcp` carrying that id returns a live `text/event-stream`.
- `GET /mcp` with a missing id is rejected with **400**, and so is a `POST`
  without one that is not an initialize request. A route that answered
  Express's bare HTML 404 is the regression that made Cursor's MCP client
  tombstone the connection as "errored" while POST tool calls kept working.
- `POST`, `GET` and `DELETE` with an **unknown** id get the SDK transport's
  JSON 404 with `-32001` "Session not found" (#14), an initialize request
  with a stale id too: the answer that tells a client to initialize again.
- `tools/list` returns the full tool surface.
- **Three consecutive `get_threads` calls on one session all return.** This is
  the load-bearing check. The server originally shared one `McpServer` across
  requests and closed it per request, so a concurrent call stripped the other's
  transport and its response went nowhere — `get_threads` hung after the third
  call. The fix was per-request servers; moving to per-*session* servers (needed
  for the SSE stream and for routing) must not bring the hang back.
- `DELETE /mcp` tears the session down, and a `GET` after it is rejected
  with 404.
- The tool contract (#50): the `instructions` start with the tool rules, the
  first `get_session_status` of a session repeats them in one line and the
  second does not, and `tools/list` stays within the single-window and
  all-groups byte budgets — the contract never goes into a tool description.
  Review deliberate schema/description changes against those budgets and
  update the surface snapshot in the same change.
- No tool of the single-window list takes the router's `window` argument
  (#16).
- The problem journal (#48) on the server without a router:
  `get_recent_problems` is listed and an empty answer stays under 256 bytes;
  a failing call carries `structuredContent.problems`, stamped with its call
  id, and lists them under its text; an error nobody saw is noted once on
  the next successful result, counted by `get_session_status`, and gone from
  both after `get_recent_problems`.
- The end of a session releases its serial port (#49), on mock ports only
  (the serial controller's port factory is swapped for serialport's
  `SerialPortMock`): `serial_capture` reads until its regex matches and
  leaves the port closed; a port `serial_open` held for the session is
  released by `DELETE`, through the local serial handler; on an injected
  clock the sweep ends a session idle for its limit, spares one with an open
  GET stream and one used meanwhile, refuses the expired id with a 4xx and
  releases its port. The serial group has eleven tools.

Belongs here rather than in `src/test/` because it needs a real listening
socket, which the `vscode-test` Electron harness does not give us.

## What `two-window-routing.js` covers

Stands up two `WindowCoordinator`s against a shared temporary registry — the
same code path the extension uses — and drives the router over MCP:

- Exactly one window binds the well-known port; the other becomes a worker.
- Both windows advertise the **same** endpoint. A worker pointing agents at its
  own port is the misrouting bug this whole layer exists to fix.
- Both publish themselves to the registry, and `list_debug_windows` shows both.
- `select_debug_window` pins a session, and the pin is reflected back.
- Starting a debug session republishes the window as `debugging: <config>`,
  which is what makes path-less tools (`read_memory`, `cmsis_action`, `flash`)
  routable at all.
- Closing the router frees the port and a worker is promoted, so the agents'
  single URL survives the router window being closed.
- Window selection for people (#16): each window publishes its role and shows
  it in a status-bar item (the stub keeps the items in `statusBarItems`); the
  routed `tools/list` offers `window` on exactly the tools of
  `WINDOW_ARGUMENT_TOOLS`; `cmsis_action {window}` runs in the named window,
  by pid or by path, and re-aims the session; a `window` that matches nothing
  is `INVALID_ARGUMENT`; a default target chosen through
  Select Target Window (the stub's `showQuickPick` answers through
  `pickAnswer`) resolves the tie of two idle windows and moves a session that
  already had a target; the router's tooltip lists the sessions; Automatic
  removes the file.
- The problem journal is per window (#48): `get_recent_problems` and the
  count of new errors in `get_session_status` come from the window the
  session is pinned to, never from the router or the other window.
- The control channel's fences (#14): with a tool timeout of 1 s and
  shortened margins (`timings`), a worker whose handler never answers
  returns `WORKER_TIMEOUT` inside the router's 3 s budget and turns its
  status-bar item to the warning background. A debugging op's hint names the
  debug adapter and shows the user nothing; an op that can wait for a picker
  (`restart_debugging`) names the picker and shows its user one warning (the
  stub's `showWarningMessage` is replaced to catch it). After failover the
  new router answers the old router's session id with 404 and `-32001`, and
  a new session works.

Note: requests use `agent: false`. `server.close()` stops new connections but
leaves keep-alive sockets open, so a pooled socket to the disposed router would
otherwise be reused after failover and reset.

## What `dap-scenarios.js` covers

A behaviour oracle for the rewrite (issue #53). It drives the real
single-window server against a scripted `gdbtarget` session and compares with
`dap-scenarios.snapshot.json`; `--update` rewrites the snapshot and
`--only=<name>` prints one scenario. About 40 s, no window, network or probe.

Each scenario gets a fresh server and fake session (pyOCD or J-Link
launch/attach configuration, cbuild-run file, SVD under a fake pack root) and
records, per tool call, the reply and its traffic: DAP requests with the
scripted answer, VS Code commands, breakpoint and start/stop API calls, the
`setBreakpoints` VS Code sends for its breakpoint model with the adapter's
answer, and the adapter events. The stub extensions live in the harness;
`vscode-stub.js` is unchanged. Like `surface-snapshot.js`, it fails any reply
whose `structuredContent` leaves out a line of its text.

The scripted adapter answers as cdt-gdb-adapter does: an evaluate of
`-exec <cmd>` is an expression to it and comes back as the result "Error:
could not evaluate expression"; a `>` CLI command answers '\r' and prints its
text as `stdout` output events; a `>` MI command answers its MI result as
JSON. The scripted GDB behind it keeps a breakpoint table (`dprintf`,
`-dprintf-insert`, `condition`, `delete`, `-break-list`, `info breakpoints`),
resets the core on `monitor reset …` without telling GDB until the register
cache is flushed, and prints `$lr` as an int, so EXC_RETURN reads "-7". A
wedged probe fails every memory read, DHCSR included, while GDB still answers
from its caches. While GDB connects, and once the GDB server has exited, the
adapter answers every request with an empty success that carries no body.
The header of the harness lists the other fidelity choices.

## `config-scenarios.js`: configuration behaviour oracle

```sh
npm run compile
node test/transport/config-scenarios.js              # compare with config-scenarios.snapshot.json
node test/transport/config-scenarios.js --update     # re-record after a deliberate change
node test/transport/config-scenarios.js --only launch/prompt   # print some scenarios, no compare
node test/transport/config-scenarios.js --check-fence          # self-test of the sandbox
```

Records what `utils/agentConfigurationManager`, `utils/debugConfigurationManager`
and `extension` do, driven only through their public entry points so the same
script runs against a rewrite:

- **Agents:** the eight agent config files written by the setup flow (full
  contents) per platform and environment, over missing, foreign, legacy-key,
  stale, JSONC/invalid and unwritable files. It also covers Codex TOML variants,
  `migrateExistingConfigurations`, popup state, the skill scope and skill
  pickers, `syncSkills` (installer calls, serialisation) and the monthly nudge.
- **Launch configurations:** the synthesized configuration per file type, test
  configurations, named entries from plain and JSONC `launch.json`, and the
  configuration quick-pick.
- **Extension:** `activate()`/`deactivate()` as router, worker and with a failed
  start. It records the order of the major calls, the settings read with their
  fallbacks, the registered commands and subscriptions, the MCP server
  definition provider, the listeners, the commands and the 2 s setup timer.

Every VS Code UI call is recorded with the answer the scenario scripts, in one
ordered event log per scenario together with globalState and settings writes,
skill-sync calls and file writes. Skills come from a small fixture catalog, not
the shipped one, so a `skills:sync` does not move the snapshot.

The `vscode` stub is extended inside this script only; `vscode-stub.js` is
unchanged. Every path the code derives from `HOME`, `USERPROFILE`, `APPDATA`,
`XDG_CONFIG_HOME`, `CODEX_HOME`, `COPILOT_HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR`,
`os.homedir()`, `os.tmpdir()`, `extensionPath` or `globalStorageUri` points into
one fresh temporary directory, and this is checked before every scenario. A
write fence on `fs` refuses and reports any write outside that directory. The
MCP router binds an ephemeral 127.0.0.1 port, never 3001.

## `executor-cases.js`: executor characterization

```sh
npm run compile
node test/transport/executor-cases.js
```

Runs the characterization cases of
[docs/provenance/specs/debuggingExecutor.md](../../docs/provenance/specs/debuggingExecutor.md)
against the compiled executor with scripted fake debug sessions: the DAP
requests and their arguments, the UI fallbacks and GDB's refusals, restart,
timeouts, the readiness probe on an adapter that takes no requests, reset
verification, the GDB command prefixes and output capture,
breakpoint bindings and the GDB memory-read ladder. About 40 s, mostly deliberate timeouts; no
window, network or probe. It complements `dap-scenarios.js`, which reaches the
executor only through the handler.
