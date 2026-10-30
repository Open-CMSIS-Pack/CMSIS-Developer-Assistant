# #11 Fenced tools return errors and timeouts as plain success text (no isError / status)

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** Typed errors, structured results and the control envelope are implemented; see [server architecture](../architecture/debugMCPServer.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#11](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/11) |
| Area · priority · source | MCP tool results and routing · High (P1) · studio test |
| Original release plan | 2.3.11 (WP-A) |
| Size | L |
| Depends on | none |
| Related | #48 (reuses the error codes), #12 and #47 (`status: 'running'`), #13 (`TARGET_RUNNING`), #14 (`WORKER_TIMEOUT`), #16 (`AMBIGUOUS_WINDOW` data), #41 (`ToolReply.data`), #3 (`PROBE_WEDGED`), #49 (`PORT_HELD`) |
| Original status | Proposed, awaiting review (2026-09-23) |

This proposal also defines the shared vocabulary the other proposals use: `ErrorCode`, `ToolError`, `ToolReply`, `ToolText`, the MCP result mapping and control envelope v2.

## Problem

An agent cannot tell a failed call from a successful one without parsing prose. In 2.3.10 three things cause this:

- **Fences turn failures into text.** 18 debug tools run inside `withHandlerTimeout`, and 10 documentation and build tools run inside `runTool`. Both turn every thrown error and every timeout into ordinary text, so these tools never set `isError`. Measured on the compiled 2.3.10 server: `read_memory` without a session returns `Error in 'read_memory': Cannot read memory: session state is 'no-session'. …` with no `isError`.
- **Refusals are returned as text.** About a dozen refusals and failures are returned as text even without a fence, for example `❌ CMSIS 'build' FAILED`, `❌ Flash FAILED`, "Refusing to flash…", "A debug session is already active… Refusing…", "CMSIS '…' not attempted" and "Cannot pause…".
- **The router misreports handler errors (new, not in the issue).** The shipped extension routes every call, even to the router's own window ([windowCoordinator.ts:193-206](../../src/windowCoordinator.ts#L193-L206)).
  - A handler error crosses the control channel as HTTP 500.
  - The router rewrites it as "Could not reach the VS Code window handling this session (pid=…) … It may have been closed", then drops its cached target.
  - So the tools that did get `isError` because they throw arrive with a false cause.
  - The next path-less call then has to resolve the window again. With two active sessions it fails as ambiguous.

The issue is still accurate on one point: a fenced tool can only get `isError` from a router-side failure. No result carries `structuredContent`. Nothing has been mitigated since 2.1.0.

## Current state (2.3.10)

- **The debug fence.** `withHandlerTimeout` is at [debuggingHandler.ts:47-76](../../src/debuggingHandler.ts#L47-L76). The cap is 60 s ([:38](../../src/debuggingHandler.ts#L38)) and the default 30 s ([:39](../../src/debuggingHandler.ts#L39)).
  - The cap produces text ([:59-62](../../src/debuggingHandler.ts#L59-L62)), and so do thrown errors: "Error in '<label>': …" ([:65-68](../../src/debuggingHandler.ts#L65-L68)).
  - Callers: `wait_for_stop` :511, `reset` :579, `list_variable_names` :987, `get_variables_values` :1004, `evaluate_expression` :1042, `read_memory` :1292, `read_core_registers` :1358, `read_cycle_counter` :1390, `read_peripheral_register` :1418, `get_fault_info` :1428, `diagnose_fault` :1449, `lookup_peripheral` :1542, `lookup_register` :1572, `get_call_stack` :1640, `get_threads` :1674, `get_frame_variables` :1709, `flash` :1919, `cmsis_action` :2021.
- **The docs and build fence.** `runTool` is at [toolRun.ts:41-73](../../src/core/toolRun.ts#L41-L73). It produces timeout text ([:55](../../src/core/toolRun.ts#L55)) and failure text ([:69](../../src/core/toolRun.ts#L69)). Callers are [packDocsHandler.ts:772](../../src/packDocsHandler.ts#L772) and [buildInfoHandler.ts:315](../../src/buildInfoHandler.ts#L315).
- **Failures returned as text:**
  - `start_debugging`: [debuggingHandler.ts:247-253](../../src/debuggingHandler.ts#L247-L253).
  - `pause_execution`: [:479-487](../../src/debuggingHandler.ts#L479-L487).
  - `wait_for_stop` timeout and session end: [:518-526](../../src/debuggingHandler.ts#L518-L526).
  - The motion-tool timeout trailer: [:1188-1191](../../src/debuggingHandler.ts#L1188-L1191).
  - `flash`: [:1920-1930](../../src/debuggingHandler.ts#L1920-L1930) and [:1946-1949](../../src/debuggingHandler.ts#L1946-L1949).
  - `cmsis_action`: [:2023-2027](../../src/debuggingHandler.ts#L2023-L2027), [:2032-2042](../../src/debuggingHandler.ts#L2032-L2042), [:2051-2064](../../src/debuggingHandler.ts#L2051-L2064) and [:2193-2197](../../src/debuggingHandler.ts#L2193-L2197).
- **Errors are re-wrapped as plain `Error`.** 14 handler catch blocks ("Error executing step over: ${error}", e.g. [:409](../../src/debuggingHandler.ts#L409)) and 9 executor catch blocks ("Failed to …: ${error}") re-wrap errors. Any typed error would lose its type there.
- **How tools build results.** There are 47 literal `{ content: [{ type: 'text' as const, text: result }] }` in [debugMCPServer.ts](../../src/debugMCPServer.ts), plus the `text()` helpers in [packDocsTools.ts:37-39](../../src/packDocsTools.ts#L37-L39) and [buildInfoTools.ts:34-36](../../src/buildInfoTools.ts#L34-L36). `get_session_status` appends the metrics trailer ([debugMCPServer.ts:976](../../src/debugMCPServer.ts#L976)).
- **The central hook.** `MeasuredMcpServer` wraps every `registerTool` ([measuredMcpServer.ts:63-96](../../src/core/measuredMcpServer.ts#L63-L96)) and rethrows errors. `classifyOutcome` guesses the outcome with regexes ([toolMetrics.ts:66-80](../../src/core/toolMetrics.ts#L66-L80)).
- **What the SDK does (1.26.0, `node_modules/@modelcontextprotocol/sdk/dist/cjs/`):**
  - A thrown error becomes `createToolError` → `isError: true` with the message text only (`server/mcp.js:138-165`).
  - Without an `outputSchema`, `validateToolOutput` returns at once (`server/mcp.js:188-190`).
  - `CallToolResultSchema` accepts any object as `structuredContent` (`types.js:1327`). So `structuredContent` without an `outputSchema` is accepted. Verified in the source; the transport test below pins it.
- **The router.** `forward()` catches every rejection ([routingDebuggingHandler.ts:123-141](../../src/routingDebuggingHandler.ts#L123-L141)). `post()` accepts only `{result: string}` / `{error: string}` ([:175-183](../../src/routingDebuggingHandler.ts#L175-L183)). Ties and missing windows throw a plain `Error` from `resolveTarget` ([:51-119](../../src/routingDebuggingHandler.ts#L51-L119)). `selectDebugWindow` returns its refusals as text ([:221](../../src/routingDebuggingHandler.ts#L221), [:230](../../src/routingDebuggingHandler.ts#L230)).
- **The worker.** The control server replies `{result}` or 500 `{error: message}` ([controlServer.ts:119-126](../../src/controlServer.ts#L119-L126)). Its dispatch log computes `Buffer.byteLength(result ?? '')` ([:165](../../src/controlServer.ts#L165)), which throws on an object.
- **String-only seams.** Every `IDebuggingHandler` method returns `Promise<string>` ([debuggingHandler.ts:81-116](../../src/debuggingHandler.ts#L81-L116)). So do `SerialDispatch` and `PackDocsDispatch` ([packDocsDispatch.ts:38](../../src/packDocsDispatch.ts#L38)).

## Proposed fix

1. **New pure module `src/core/toolResult.ts`** (no `vscode`, no SDK import). This is the shared vocabulary:

   ```ts
   export type ErrorCode =
       | 'NO_SESSION' | 'TARGET_RUNNING' | 'TIMEOUT' | 'AMBIGUOUS_WINDOW' | 'WINDOW_UNREACHABLE'
       | 'WORKER_TIMEOUT' | 'CMSIS_NO_SOLUTION' | 'TASK_FAILED' | 'PROBE_BUSY' | 'PROBE_WEDGED'
       | 'PORT_HELD' | 'TOOL_DISABLED' | 'INVALID_ARGUMENT' | 'INTERNAL';
   export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
   export type JsonObject = { [key: string]: JsonValue };
   export class ToolError extends Error {
       constructor(readonly code: ErrorCode, message: string, readonly hint?: string, readonly data?: JsonObject) { super(message); }
   }
   export interface ToolReply { text: string; status: 'ok' | 'running' | 'timeout'; data?: JsonObject }
   export type ToolText = string | ToolReply;          // a bare string means ok
   export function classifyError(message: string): ErrorCode;      // fallback for plain Errors (step 4)
   export function toToolError(err: unknown): ToolError;          // passes ToolError through, classifies the rest
   export function wrapError(prefix: string, err: unknown): ToolError; // replaces the "Error …: ${error}" re-wraps
   export function textOf(result: ToolText): string;               // flattening for v1 peers
   export function upgradeLegacyText(text: string): ToolText | ToolError; // results from 2.3.10 workers
   ```

   `data` is an object so that the mapping can spread it. The shared definitions list `ToolError` with `code` and `hint` only. `data` is the one addition, and it carries the candidate list of `AMBIGUOUS_WINDOW` (Decision 5).

   | Code | Meaning | First raised by |
   |---|---|---|
   | `NO_SESSION` | no usable debug session (none, initializing, or ended) | `ensureStoppedSession`, fences, executor |
   | `TARGET_RUNNING` | the operation needs a halted core | `ensureStoppedSession`, #13 |
   | `TIMEOUT` | a hardware request timed out and the call has no result | `HardwareTimeoutError`, fence cap on read tools (Decision 3) |
   | `AMBIGUOUS_WINDOW` | several windows qualify; `data.candidates` lists them | router |
   | `WINDOW_UNREACHABLE` | the target window is gone or refuses the connection | router |
   | `WORKER_TIMEOUT` | the target window did not answer in time | router (here), worker fence (#14) |
   | `CMSIS_NO_SOLUTION` | CMSIS Solution has no active solution in that window | `cmsis_action`, #41 |
   | `TASK_FAILED` | a build, flash or erase task or process failed | `cmsis_action`, `flash` |
   | `PROBE_BUSY` | the probe or debug connection is already in use | "already active" refusals, #46 |
   | `PROBE_WEDGED` | the probe or GDB server stopped answering memory reads | #3 |
   | `PORT_HELD` | the serial port is owned elsewhere | #49 |
   | `TOOL_DISABLED` | the tool group is off or not available in that window | control server, pack-docs gates |
   | `INVALID_ARGUMENT` | the arguments cannot work (bad line, unknown target, no cbuild-run) | handlers, router |
   | `INTERNAL` | anything unclassified | fallback |

   Additions proposed elsewhere, decided there:
   - `PORT_CLOSED`, for a write to a serial port that was released or unplugged ([49-serial-port-release.md](49-serial-port-release.md)).
   - Journal-only codes such as `DAP_POWER_UP_FAILED`, `PROBE_NOT_FOUND`, `CORE_NOT_FOUND` and `BUILD_ERROR`. They extend `ErrorCode` as `ProblemCode` in the problem journal and are never thrown as `ToolError` ([48-error-feed.md](48-error-feed.md)).

2. **Fences.**
   - `withHandlerTimeout` and `runTool` return `Promise<ToolText>`. A body that throws gives `throw toToolError(err)`, so the label prefix "Error in '<label>'" disappears because the client already knows the tool.
   - When the cap fires, the fence returns `{status: 'timeout', text}` for wait-type tools and throws `ToolError('TIMEOUT')` for read tools (Decision 3). `withHandlerTimeout` gets a fourth parameter, `onCap: 'reply' | 'error'`.
   - A rejection after the cap stays observed, as `runTool` does today ([toolRun.ts:60](../../src/core/toolRun.ts#L60)).
3. **Throw instead of returning failure text.** `ensureStoppedSession` throws `ToolError` directly: the state maps to its code, and the existing per-state hint becomes `hint`. The 14 handler catch blocks and the 9 executor catch blocks use `wrapError`, which keeps the code. Returned strings convert as follows:

   | Site | Becomes |
   |---|---|
   | `start_debugging` / `cmsis_action` "already active … Refusing", `flash` "Refusing to flash while a debug session is active", target switch under a live session | `ToolError('PROBE_BUSY')`, hint `stop_debugging` |
   | `cmsis_action` no active solution | `ToolError('CMSIS_NO_SOLUTION')`, the three fixes as hint |
   | `cmsis_action` invalid target, `flash` cbuild-run not found, several found, or no workspace | `ToolError('INVALID_ARGUMENT')` |
   | `❌ CMSIS … FAILED`, task ended without exit code, attach session "did NOT survive", `❌ Flash FAILED`, pyOCD not found | `ToolError('TASK_FAILED')` |
   | `cmsis_action` still running, `load_and_debug` / `attach` "issued … poll get_session_status" | `ToolReply` `status: 'running'` |
   | `wait_for_stop` "did not stop", motion-tool "did not complete" trailer, pause "did not stop within the timeout", `flash` timed out | `ToolReply` `status: 'timeout'` (text unchanged) |
   | `wait_for_stop` / pause "session ended" | `ToolError('NO_SESSION')` |
   | pause "unresponsive" / "still initializing" | `ToolError('TIMEOUT')` / `ToolError('NO_SESSION')` |
   | router tie (≥2 windows) | `ToolError('AMBIGUOUS_WINDOW')`, `data.candidates: [{pid, name, workspaceFolders, hasActiveSession}]` |
   | router: no window registered, pinned window gone | `ToolError('WINDOW_UNREACHABLE')` |
   | router: path hint inside no window; `select_debug_window` without arguments or with no match | `ToolError('INVALID_ARGUMENT')` |
   | control server: pack-docs handlers absent | `ToolError('TOOL_DISABLED')` |

   `get_session_status` and `check_target_connection` stay non-throwing: reporting the state is their job.
4. **Fallback classifier** `classifyError(message)`, used for every thrown `Error` that is not a `ToolError`. This covers the unfenced tools and the executor without touching them. It is an ordered regex table: `no-session|No active debug session` and `'initializing'` → `NO_SESSION`; `'running'|target is running` → `TARGET_RUNNING`; `'unresponsive'|HardwareTimeoutError|timed out after` → `TIMEOUT`; `no active (CMSIS )?solution` → `CMSIS_NO_SOLUTION`; `Invalid line|must be a 1-based|Unbalanced|No location given|Could not find any lines` → `INVALID_ARGUMENT`; anything else → `INTERNAL`. New code throws `ToolError` directly. The classifier is only the safety net.
5. **Control envelope v2** ([controlServer.ts](../../src/controlServer.ts), [routingDebuggingHandler.ts](../../src/routingDebuggingHandler.ts)).
   - **Request.** The router adds the header `x-cmsis-developer-assistant-envelope: 2`. The body is `{op, args, callId?, sessionId?, budgetMs?}`. WP-A sends none of the optional fields: `callId` comes with #48, `sessionId` with #49 and `budgetMs` (the worker-side fence) with #14.
   - **Worker reply to a v2 router** (the header is present): 200 `{result: ToolText, journalSeq?, journalErrors?}`, or 500 `{error: {message, code, hint, data?}}`. `journalSeq` and `journalErrors` come with #48.
   - **Internal ops.** The same channel carries ops that are not MCP tools: `health` (#14) and `sessionEnded` (#49), listed as `INTERNAL_OPS` in `opTable.ts`.
   - **Worker reply to a v1 router** (a window not yet reloaded): 200 `{result: textOf(result)}`, and 500 `{error: message + '\n' + hint}`. This is exactly the 2.3.10 shape. The version is negotiated by a header so that the body keeps the agreed shape.
   - **Router, `post()`.**
     - A `result` string or object becomes `ToolText`. A string from an old worker goes through `upgradeLegacyText`: `Error in '…': …` becomes a classified `ToolError`, and the old cap text becomes `status: 'timeout'`.
     - An `error` object becomes `ToolError`. An `error` string from an old worker goes through `toToolError`.
     - **In all these cases the cached target is kept.**
   - **Router, transport failures.** Only these drop the cache, as today: `ECONNREFUSED`, `ECONNRESET`, "socket hang up", 403 (stale token), 404 and a malformed body. They become `WINDOW_UNREACHABLE`, with the current "Could not reach …" text. The request timeout ([:187-191](../../src/routingDebuggingHandler.ts#L187-L191)) becomes `WORKER_TIMEOUT` and keeps the cache (Decision 4). 413 becomes `INVALID_ARGUMENT`.
   - The dispatch log measures `Buffer.byteLength(textOf(result))`.
   - `IDebuggingHandler`, `SerialDispatch` and `PackDocsDispatch` move to `Promise<ToolText>`. A `string` is a `ToolText`, so every existing handler compiles unchanged, and the `opTable.ts` checks are unaffected.
6. **One mapping point in `MeasuredMcpServer`.**
   - The registrations call `reply(result)` instead of building `content`. This is a mechanical change: 47 sites plus the two `text()` helpers. `get_session_status` appends its metrics trailer to `textOf(result)`.
   - `measured` returns `toCallToolResult(result)` on success. In its `catch` it returns `toCallToolResult(toToolError(err))` instead of rethrowing, so the SDK's `createToolError` never sees our errors. Schema errors (`McpError`) are raised before the callback and stay untouched.

   | Handler outcome | `content[0].text` | `isError` | `structuredContent` |
   |---|---|---|---|
   | `string` | the string | – | none (Decision 1) |
   | `ToolReply`, `ok` with `data` (without `data` it maps like a string) | `text` | – | `{status: 'ok', ...data}` |
   | `ToolReply`, `running` / `timeout` | `text` | – | `{status, message: text, ...data}` |
   | `ToolError` | `[CODE] message` + `\n` + hint (Decision 2) | `true` | `{status: 'error', error_code, message, hint, ...data}` |

   `classifyOutcome` reads `structuredContent.status` and `isError` first. The regexes stay as the fallback for results from 2.3.10 workers.
7. **Agent guidance.**
   - Add four lines "Reading results" to `skills/cmsis-debug-live/SKILL.md` and `docs/agent-resources/debug_instructions.md`: check `isError` and `error_code`; `status: 'timeout'` and `'running'` are not failures; follow `hint`.
   - Add one sentence to the server instructions. It goes in `initialize`, not in `tools/list`.
   - Update `docs/architecture/{debugMCPServer,debuggingHandler}.md`, `CHANGES-VS-UPSTREAM.md` and the CHANGELOG.
   - Cost to `tools/list`: 0 B. No `outputSchema` and no description changes are needed.

## What changes for the agent and the user

```text
read_memory {address: "0x20000000", length: 4}, no debug session

2.3.10   content: "Error in 'read_memory': Cannot read memory: session state is 'no-session'. No active
                  debug session. Call start_debugging first. Use get_session_status for …"
         isError: (absent)                        → VS Code chat shows a green ✓

new      content: "[NO_SESSION] Cannot read memory: session state is 'no-session'.
                  No active debug session. Call start_debugging first. …"
         isError: true
         structuredContent: {"status":"error","error_code":"NO_SESSION","message":"Cannot read memory: …","hint":"No active debug session. …"}

step_over while the target runs, routed build (every shipped build)

2.3.10   "Could not reach the VS Code window handling this session (pid=4711): Error executing step over:
          Error: Cannot step over: session state is 'running'. … It may have been closed. Call list_debug_windows …"
         and the router forgets its target
new      "[TARGET_RUNNING] Cannot step over: session state is 'running'. …" — target kept

wait_for_stop {timeoutMs: 5000} on a free-running target

2.3.10   "Target did not stop within the timeout — it is still running …"            (plain ok)
new      same text, no isError, structuredContent {"status":"timeout","message":"Target did not stop …"}
```

In VS Code chat the red error badge now marks real failures, and a wait that ran out is no longer shown as a success. Other clients get the same signal from `isError`.

## Decisions for you

- [ ] **1. What a plain ok result carries.** **Recommended:** no `structuredContent`; the absence of `isError` means ok. `ToolReply` and `ToolError` always put `message` into `structuredContent`, so it stands on its own. The reason: some MCP clients may pass `structuredContent` to the model *instead of* `content`. Codex CLI is suspected of this and not verified. For such a client, `{status: 'ok'}` alone would hide every successful result. This deviates from the shared definition "ok results carry `{status: 'ok'}`".
  - Alternative: `{status: 'ok'}` on every result, a uniform field. Safe only after a client matrix (Claude Code, Codex CLI, Copilot Chat, Cursor, Cline) shows that all of them keep feeding `content`.
- [ ] **2. Error code in the text.** **Recommended:** prefix the text with `[CODE]` and a space, about 15 B per error. Most clients show only `content` to the model, so the prefix is what makes the code visible there.
  - Alternative: code only in `structuredContent`. The text stays unchanged, but the code is invisible wherever `structuredContent` is dropped.
- [ ] **3. What the fence cap means.** **Recommended:** `status: 'timeout'` for wait-type tools (`wait_for_stop`, step, continue, pause, `cmsis_action`, `flash`, `reset`), and `ToolError('TIMEOUT')` for read tools (`read_*`, `get_*`, `evaluate_expression`, `list_variable_names`, `lookup_*`, `diagnose_fault`): a read that returned no data has failed. This deviates from the plan, which uses `status: 'timeout'` for every cap.
  - Alternative: `status: 'timeout'` everywhere. Simpler, but a capped `read_memory` then shows as a non-error without data.
- [ ] **4. Router request timeout.** **Recommended:** `WORKER_TIMEOUT` and keep the cached target. The window is alive (the registry heartbeat says so) but busy. Re-resolving gains nothing and can turn into `AMBIGUOUS_WINDOW`.
  - Alternative: drop the cache as today. That is defensive, but it produces the misroute described in #16.
- [ ] **5. `ToolError.data`.** **Recommended:** add the optional `data` object to `ToolError`. It carries the `AMBIGUOUS_WINDOW` candidates, which #16 relies on, and the #48 `problems` records later.
  - Alternative: keep `ToolError` to `code` and `hint`, and put candidates only in the text. #16 then parses prose.

## Tests and acceptance

- **Unit, new `src/test/toolResult.test.ts`:**
  - The classifier table, one case per code and per message family above.
  - `wrapError` keeps the code.
  - `upgradeLegacyText` handles `Error in '…'` and the cap text.
  - `textOf` flattening.
- **Unit, `src/test/toolRun.test.ts`:** a body that throws gives `ToolError`; the timer gives `status: 'timeout'`; a late rejection is still observed.
- **Unit, new `src/test/measuredMcpServer.test.ts`** (codebase review item 4.5): `ToolError` → `isError` plus `structuredContent`; a plain `Error` → a classified code; `ToolReply` → `status`; a string → no `structuredContent`; the metrics outcome comes from `status`.
- **Unit, `src/test/debuggingHandler.test.ts`** (fake executor):
  - `handleReadMemory` without a session rejects with `NO_SESSION`.
  - `handleWaitForStop` on a timeout gives `status: 'timeout'`.
  - `handleStepOver` while running rejects with `TARGET_RUNNING` through `wrapError`.
- **Unit, `src/test/routing.test.ts`:**
  - A worker `ToolError` arrives with its code, and the next path-less call resolves `cached`.
  - A dead port gives `WINDOW_UNREACHABLE` and clears the cache.
  - A worker that never answers gives `WORKER_TIMEOUT`.
  - A v1 worker reply (`{error: string}`, and a `{result: "Error in '…'"}`) is classified.
  - A request without the envelope header gets the 2.3.10 shapes.
  - The existing "a dead window surfaces as an actionable error" test stays green.
- **Transport, `test/transport/session-lifecycle.js`:**
  - `read_memory` and `step_over` without a session give `isError` and `structuredContent.error_code === 'NO_SESSION'`.
  - `get_session_status` has no `isError`.
  - The `tools/list` byte count is unchanged, and no tool has `outputSchema`.
- **Transport, `test/transport/two-window-routing.js`:** two windows with active sessions give `AMBIGUOUS_WINDOW` with two `data.candidates`.
- **Live** (FVP corstone-blinky, Claude Code and Copilot Chat):
  - `read_memory` without a session shows as failed in both clients.
  - `wait_for_stop` on the free-running blinky loop shows as not failed with `status: 'timeout'`.
  - A reloaded router talks to a non-reloaded worker and back without errors.
  - Record in `test/acceptance-ai-efficiency.md` whether each client feeds `content` or `structuredContent` to the model. This settles Decision 1.

## Out of scope and follow-ups

- **#48 (WP-H):** `callId`, `journalSeq` and the `problems` records on failing results.
- **#12 and #47 (WP-B):** job status for long builds. Here `cmsis_action` only labels its current texts `running` or `timeout`.
- **Per-tool `outputSchema`:** it would cost `tools/list` bytes on every turn. Revisit when MCP clients gain lazy schema loading.
- **Serial handler errors** reach the agent through the classifier until #49 (WP-K) gives them `PORT_HELD`.
- **Splitting `setupTools` into `src/debugTools.ts`** (codebase review 3.5) collides with step 6. Do it right after 2.3.11 ships.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
