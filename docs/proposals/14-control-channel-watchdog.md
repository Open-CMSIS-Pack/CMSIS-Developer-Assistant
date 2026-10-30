# #14 Control channel can hang with no watchdog: worker dispatch unbounded, no health op, no channel-lost notice

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** Control-channel fences and window health checks are implemented; see [window routing](../architecture/windowRouting.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#14](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/14) |
| Area · priority · source | Multi-window/transport · Medium · Studio test |
| Original release plan | 2.3.12 (WP-I) |
| Size | M |
| Depends on | #11 (`ToolError`, `WORKER_TIMEOUT` / `WINDOW_UNREACHABLE`, control envelope v2) |
| Related | #3, #16, #19, #48, #49 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

A forwarded op that never settles holds the agent's MCP call for the whole forward budget: 195 s by default, 600 s for `cmsis_action`, `flash` and the documentation ops. When the router gives up, the worker is never told. Nothing checks whether the target window's extension host is alive. A router whose extension host is blocked keeps port 3001, and no other window can notice or take over.

Part of the issue's list is outdated:

- Step, continue and pause have their own stop wait of at most 60 s.
- `get_session_status` and `check_target_connection` use short probes.
- 2.3.10 added the 1 MiB request cap with 413 and a bounded `stop()`.

These remain unbounded:

- `start_debugging` without `configurationName`: it always shows a quick-pick and waits for a human, in the worker window, where the agent cannot see it.
- `stop_debugging`.
- The breakpoint and logpoint ops (WP-C gates them for the running case).
- `get_device_info` and the serial ops.

The observed trigger cannot be confirmed without the log. The "window-status call" that hung is `list_debug_windows`, which runs in the router itself, so the router's extension host was blocked (or the agent was `curl`ing a worker, see #19).

New finding: after a router change the new router answers the clients' old `mcp-session-id` with 400. The MCP spec requires 404 there, and only 404 tells the client to re-initialize. So even a successful takeover leaves connected agents stuck until they are restarted.

## Current state (2.3.10)

- **Worker side.**
  - `onRequest` awaits `dispatch` with no timer and no abort ([controlServer.ts:71-128](../../src/controlServer.ts#L71-L128), await at [:119](../../src/controlServer.ts#L119), dispatch [:137-173](../../src/controlServer.ts#L137-L173)).
  - `requestTimeout` and `headersTimeout` are not set, so Node's defaults (300 s and 60 s) apply. They bound only the *receiving* of a request, never the handler.
  - The 413 drain is at [:87-112](../../src/controlServer.ts#L87-L112); `stop()` is bounded by [closeHttpServer.ts:25-35](../../src/utils/closeHttpServer.ts#L25-L35).
- **Router side.**
  - `http.request` gets `timeout`, which is socket inactivity, not wall clock ([routingDebuggingHandler.ts:145](../../src/routingDebuggingHandler.ts#L145), [:158](../../src/routingDebuggingHandler.ts#L158)).
  - The budget is `max(toolMs + 15 s, floor)` ([opTable.ts:171-176](../../src/core/opTable.ts#L171-L176)), with a 10-minute floor for `SLOW_OPS` ([:159-163](../../src/core/opTable.ts#L159-L163)) and toolMs defaulting to `timeoutInSeconds` = 180 s.
  - On expiry the request is destroyed ([routingDebuggingHandler.ts:187-191](../../src/routingDebuggingHandler.ts#L187-L191)) and the cached target is dropped ([:132-134](../../src/routingDebuggingHandler.ts#L132-L134)). The worker is never told.
- **Handler fences.** `withHandlerTimeout` ([debuggingHandler.ts:47-76](../../src/debuggingHandler.ts#L47-L76)) covers 18 tools. Unfenced:
  - `stop_debugging` is a bare `vscode.debug.stopDebugging` ([debuggingExecutor.ts:259-268](../../src/debuggingExecutor.ts#L259-L268)).
  - The quick-pick opens with no token and no timeout ([debuggingHandler.ts:256](../../src/debuggingHandler.ts#L256) → [debugConfigurationManager.ts:100-123](../../src/utils/debugConfigurationManager.ts#L100-L123)).
  - The breakpoint ops, `get_device_info` ([debuggingHandler.ts:1600-1613](../../src/debuggingHandler.ts#L1600-L1613)) and the serial ops.
- **Liveness.**
  - There is no health op. The only heartbeat is the registry refresh every 20 s ([windowCoordinator.ts:31](../../src/windowCoordinator.ts#L31), [:125](../../src/windowCoordinator.ts#L125)).
  - An entry goes stale at 60 s ([workspaceRegistry.ts:46](../../src/utils/workspaceRegistry.ts#L46)), and peers then *delete* it even though the pid is alive ([:168-172](../../src/utils/workspaceRegistry.ts#L168-L172)).
  - The registry does not record which window is the router.
- **Election.** A window becomes router only after a successful `listen` ([windowCoordinator.ts:151-156](../../src/windowCoordinator.ts#L151-L156)). Workers retry every 10 s ([:34](../../src/windowCoordinator.ts#L34), [:178-183](../../src/windowCoordinator.ts#L178-L183)). A router that is wedged but still listening is never displaced.
- **Unknown session id.** POST answers 400 ([debugMCPServer.ts:1236-1241](../../src/debugMCPServer.ts#L1236-L1241)), and so do GET and DELETE ([:1270-1283](../../src/debugMCPServer.ts#L1270-L1283)). SDK 1.26's own transport answers 404 with -32001 "Session not found". The 400 is pinned by [session-lifecycle.js:130-134](../../test/transport/session-lifecycle.js#L130-L134).
- **Tests.** `routing.test.ts` runs real `ControlServer`s with `fakeHandler` ([routing.test.ts:25-33](../../src/test/routing.test.ts#L25-L33)). The only never-resolving handler is used for `stop()` ([:441-458](../../src/test/routing.test.ts#L441-L458)). The router timeout is untested because the +15 s is hard-coded.

## Proposed fix

1. **Worker fence** in `ControlServer`:
   - Every dispatched op races a wall-clock timer of `budgetMs − 5 s`.
   - `budgetMs` arrives as an optional field of the v2 request body (#11): the router sends `forwardTimeoutMs(…)`. An old router sends none, and the worker then computes it from its own `timeoutInSeconds`.
   - On expiry the worker answers `{error: {code: 'WORKER_TIMEOUT', message, hint}}`, for example message "'start_debugging' did not finish within 190 s in window pid 4711 (CDA-Testdrive); it is still running there", hint "a picker or dialog may be open in that window — ask the user, or call get_session_status".
   - The op stays in a `busy` map `{op, callId, startedAt, fenced}` until its promise settles. A late settle is logged ("finished 22 s after its fence; result discarded"). `res.on('close')` before the answer logs "router abandoned op".
   - Set `server.requestTimeout = 10_000` and `server.headersTimeout = 5_000`: requests are loopback and at most 1 MiB.
2. **Handler fences for the known human waits:**
   - `promptForConfiguration` gets a `CancellationToken`, cancelled after `min(timeoutMs ?? 30 s, 60 s)`. On cancel it throws `ToolError('INVALID_ARGUMENT')` with the hint "pass configurationName: one of 'CMSIS Debug', 'Attach' (.vscode/launch.json)".
   - `stop_debugging` is fenced at 10 s and then returns `status: 'timeout'` with "stop requested; the session is still listed — call get_session_status".
3. **Internal `health` op.**
   - `INTERNAL_OPS = ['health']` in `opTable.ts`; #49 adds `sessionEnded`. They are not MCP tools and not in `DEBUG_OPS`.
   - `ControlServer` answers it itself and never queues it behind a handler.
   - The reply is a `ToolReply` with `data: {pid, version, role, uptimeS, lagMs: {p99, max}, busy: [{op, ageS, fenced}]}`.
   - Lag comes from `perf_hooks.monitorEventLoopDelay({ resolution: 20 })`, reset on every heartbeat.
   - An old worker's 500 "Unknown control op" counts as alive.
4. **Router use** in `RoutingDebuggingHandler`:
   - **Pre-flight.** When no reply came from the target pid for more than 30 s, call `health` with a 2 s timeout. On failure: `ToolError('WINDOW_UNREACHABLE')` "window pid 4711 (CDA-Testdrive) did not answer a health check within 2 s — its extension host is blocked or it closed", hint "list_debug_windows; if it persists, reload that window". The cached target is dropped.
   - **In flight.** Once a forward has been pending for 15 s, probe `health` every 15 s. After two consecutive failures, destroy the request and answer `WINDOW_UNREACHABLE`. A window that is busy but responsive, such as one running a long build, keeps its full budget.
   - **Budget expiry** with an old worker that has no fence: #11 maps it to `WORKER_TIMEOUT` and keeps the cache. This refines that: it stays so only when the last health check passed, and becomes `WINDOW_UNREACHABLE` with the cache dropped otherwise.
   - **Injectable timings** for tests: `forwardTimeoutMs(op, args, defaultToolMs, { marginMs = 15_000, slowFloorMs = 600_000 })` and `RoutingOptions { quietMs, healthTimeoutMs, watchdogEveryMs }`.
5. **Registry.**
   - Entries gain `role: 'router' | 'worker'`, `version`, `lagMs` and `busy` (ops older than 10 s). `publish()` writes them, and `heartbeat()` takes a patch so it refreshes `busy` and `lagMs` every 20 s.
   - `describeWindow` renders "router", "busy: cmsis_action 240 s" and "event-loop lag 4.2 s" (the last one only above 1 s). `list_debug_windows` shows them.
6. **Wedged router.** Each promotion poll that fails to bind also checks two things:
   - (a) Is there a `role: 'router'` entry older than 60 s whose pid is alive? The new `registry.findStaleRouter()` answers this. For it to work, `list()` must stop deleting such an entry and only skip it: today the first peer that reads it deletes it. The dead-pid rule still removes the entry once the process is gone.
   - (b) Does `GET /mcp` on the port, with no session, fail to answer within 2 s?
   - When both hold, the window shows one warning per episode: "CMSIS Developer Assistant: the router window (pid 4711, CDA-Testdrive) has not responded for 60 s, so agents cannot reach any window. Reload or close that window; another window takes over automatically." with the action [Show Log].
   - An old router writes no `role`. Then the text says "the window serving port 3001".
   - Taking over the port is impossible while it is bound, and there is no API to reload another window.
7. **Session-id recovery.** A request carrying an unknown `mcp-session-id` gets 404 with JSON-RPC -32001 "Session not found", as the SDK transport answers. A missing id on a non-initialize request stays 400. Compliant clients then re-initialize after a router change; #49's session TTL relies on the same behaviour.
8. **User notice in the worker window** when a fence fires:
   - Sent through #48's `notify` helper, so it is also journaled, and rate-limited to one per op name per 10 min: "An agent's start_debugging has been waiting 190 s in this window; the agent was told it timed out. [Show Log]".
   - When #16's status-bar item exists, it turns to the warning background while an op is past its fence.
9. **Docs.**
   - `docs/architecture/debugMCPServer.md` multi-window section: fences, health, roles, the 404.
   - `debug_instructions.md`: what to do on `WORKER_TIMEOUT` (the window is alive and busy: `get_session_status`, ask the user) and on `WINDOW_UNREACHABLE` (`list_debug_windows`, the window may be gone).
   - CHANGELOG.

Budget arithmetic with the defaults:

| Call | Router budget | Worker fence |
|---|---|---|
| `start_debugging` (no `timeoutMs`) | 195 s | 190 s |
| `cmsis_action` / `flash` / doc ops | 600 s floor | 595 s |
| `read_memory {timeoutMs: 5000}` | 20 s | 15 s (handler cap fires first at 5 s) |

None of this adds a tool or a parameter, so the tool list does not grow.

## What changes for the agent and the user

```text
Before: start_debugging (no configurationName) in a worker whose picker nobody sees
  … 195 s …  "Could not reach the VS Code window handling this session (pid=4711): no response within 195s …"
  cached target dropped; the next call re-resolves and may hang again

After
  30 s   isError, error_code INVALID_ARGUMENT
         "No debug configuration chosen within 30 s" hint "pass configurationName: one of 'CMSIS Debug', 'Attach'"

Before: target window's extension host blocked
  every call waits 195 s (600 s for cmsis_action), no message anywhere

After
  ≤ 2 s   isError, WINDOW_UNREACHABLE "window pid 4711 did not answer a health check within 2 s …"
  user    worker windows show "the router window … has not responded for 60 s" when the router is the one blocked
  list_debug_windows   "pid=4711 | … | router | busy: cmsis_action 240 s | event-loop lag 4.2 s"
```

## Decisions for you

- [ ] **Where the worker fence gets its budget.** **Recommended:** the router sends `budgetMs` in the envelope. `timeoutInSeconds` is window-scoped and can differ between windows, and the router's number is the one the agent waits on. Alternative: the worker uses its own setting only; the envelope stays unchanged, but the fence can fire after the router has already given up.
- [ ] **In-flight watchdog.** **Recommended:** add it (item 4). Otherwise a window that blocks during a 600 s `cmsis_action` still costs 600 s. Alternative (the plan): pre-flight probe only, which is simpler and catches only windows that were already blocked.
- [ ] **`start_debugging` picker.** **Recommended:** keep it, bounded and cancellable, and list the configuration names in the error. Alternatives: never show a picker for agent calls, which breaks the inherited multi-language flow; or leave it unbounded, so the worker fence answers after 190 s.
- [ ] **404 for unknown session ids.** **Recommended:** yes, per spec, with a verification step: Claude Code, Copilot, Cursor, Codex and Cline must re-initialize on 404. The old "never a bare 404" note was about the missing GET route (Express's HTML 404), not about a JSON 404 for an unknown id. Alternative: keep 400 and accept that clients stay stuck after a router change.
- [ ] **Toast on fence expiry.** **Recommended:** yes, rate-limited, because the user is often the only one who can close the picker or dialog. Alternative: status bar and log only, which is quieter but easy to miss.

## Tests and acceptance

- `src/test/routing.test.ts`:
  - A handler that never resolves: the router gets `WORKER_TIMEOUT` within the injected fence, the cache survives, and `health` lists the op as busy and fenced.
  - A "blocked" worker (a raw HTTP server that accepts and never answers): the pre-flight gives `WINDOW_UNREACHABLE` within `healthTimeoutMs`, and the cache is dropped.
  - A worker that stops answering `health` mid-op: the forward is aborted after two failed probes.
  - A worker that answers `health` with 500 (old version) counts as alive.
  - `requestTimeout` and `headersTimeout` are set.
  - A fenced op that settles later leaves `busy` and does not answer twice.
- `src/test/workspaceRegistry.test.ts`: a stale `role: 'router'` entry with a live pid is skipped, not deleted, and `findStaleRouter()` returns it. Stale worker entries are pruned as before.
- `src/test/windowCoordinator.test.ts`:
  - `role` is published.
  - A stale router entry plus a silent port raises one warning (injected notify and clock); a healthy router raises none.
- `src/test/debuggingHandler.test.ts`: a cancelled picker gives `INVALID_ARGUMENT` with the configuration names; `stop_debugging` returns `status: 'timeout'` when the stop never settles.
- `test/transport/session-lifecycle.js`: an unknown `mcp-session-id` gets 404 and -32001 on POST, GET and DELETE. The 400 check for a missing id stays.
- `test/transport/two-window-routing.js`:
  - A worker whose handler never answers: the MCP call returns `isError` with `WORKER_TIMEOUT` inside the budget, using a small `timeoutInSeconds`.
  - After failover, the old session id gets 404 and a new session works.
- Live (plan):
  - A never-answering worker returns an error within budget.
  - Block a worker's extension host (a debugger breakpoint in the extension host): the next tool call fails within 2 s.
  - Block the router: the other windows warn within about 70 s.

## Out of scope and follow-ups

- Cancelling the work at the fence. There is no API to abort a DAP request or a VS Code task mid-flight; the busy table and the notice make the leftover visible. #3 (probe reconnect) builds on `WORKER_TIMEOUT`.
- Taking over a bound port, or reloading another window. Neither is possible from an extension.
- `health` as an MCP tool. `list_debug_windows` carries the same information.
- A Unix-socket or named-pipe control channel ([19-registry-token-exposure.md](19-registry-token-exposure.md) follow-up).
- Fencing each breakpoint op at the handler level. WP-C (#13) reworks those ops, and the worker fence covers them meanwhile.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
