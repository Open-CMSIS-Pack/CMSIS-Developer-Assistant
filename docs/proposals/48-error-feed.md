# #48 Proposal: one standardized error feed for agents (debug adapter, GDB server, build, Problems, UI notifications)

> **2.7.0 status (2026-10-27).** The problem journal and phases 1–2 are implemented; phases 3–4 remain separate integration proposals. Review only that remaining scope, not the old plan to add the journal again. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#48](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/48) |
| Area · priority · source | Debug & run control · Medium (proposed) · Maintainer |
| Original release plan | 2.3.12, phases 1–2 (WP-H, together with the interim #15 half). Phases 3–4: Future |
| Size | XL overall; phases 1–2 L |
| Depends on | #11 (`ToolError`, `ToolReply`, envelope v2, the mapping in `MeasuredMcpServer`), #47 / #46 / #12 (`CmsisJobTracker`), WP-G (tool-list bytes) |
| Related | #13, #14, #15, #21, #41, #49, #50 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

The issue's inventory holds for 2.3.10, with three corrections:

- The DAP tracker already records failed responses to requests that VS Code's own UI sent, such as a rejected `setBreakpoints` (#13), because it sees every response. It just never exposes them outside a failed `start_debugging`.
- The ring keeps `console` output at the same weight as `stderr`, so chatty GDB console lines push real errors out of its 20 slots.
- "Fenced tools return errors as success text" is fixed by #11 in 2.3.11. This proposal builds on that fix.

Everything else is as described:

- One ring of 20 lines × 3 sessions, of which only the newest session is readable.
- One consumer, which appends prose to three failure texts.
- A build result that carries only the exit code, because CMSIS Solution runs cbuild in a `CustomExecution` pseudoterminal whose output no API can read (#15).
- `flash` has its own tail format.
- Our 9 toasts are invisible to the agent.
- None of these are used: `languages.getDiagnostics`, terminal shell-execution events, MCP logging notifications, resource subscriptions.

## Current state (2.3.10)

- **DAP ring** in [sessionStateTracker.ts:189-221](../../src/utils/sessionStateTracker.ts#L189-L221): 20 lines per session, 300 characters per line, 3 sessions ([:195-197](../../src/utils/sessionStateTracker.ts#L195-L197)).
  - It records failed responses ([:237-239](../../src/utils/sessionStateTracker.ts#L237-L239)), output of category `stderr` / `console` / `important` ([:242-251](../../src/utils/sessionStateTracker.ts#L242-L251)) and adapter `onError` ([:278-281](../../src/utils/sessionStateTracker.ts#L278-L281)).
  - It is registered for `'*'` ([:287-289](../../src/utils/sessionStateTracker.ts#L287-L289)).
  - `getRecentDiagnostics` returns only the newest session ([:217-221](../../src/utils/sessionStateTracker.ts#L217-L221)).
- **Only consumer.** `diagnosticsSuffix()` ([debuggingHandler.ts:226-230](../../src/debuggingHandler.ts#L226-L230)), used at [:305](../../src/debuggingHandler.ts#L305) (start failure), [:2125](../../src/debuggingHandler.ts#L2125) (CMSIS command failure) and [:2164](../../src/debuggingHandler.ts#L2164) (attach did not survive).
- **Build.** `cmsis_action build` reports only the exit code ([debuggingHandler.ts:2189-2220](../../src/debuggingHandler.ts#L2189-L2220)). `flash` has its own `outputTail` / `errorLines` ([flashController.ts:43-45](../../src/core/flashController.ts#L43-L45), [:152-153](../../src/core/flashController.ts#L152-L153)).
- **Toasts.**
  - Seven `showErrorMessage` calls: [extension.ts:167](../../src/extension.ts#L167), and `agentConfigurationManager.ts` at [:276](../../src/utils/agentConfigurationManager.ts#L276), [:641](../../src/utils/agentConfigurationManager.ts#L641), [:655](../../src/utils/agentConfigurationManager.ts#L655), [:905](../../src/utils/agentConfigurationManager.ts#L905), [:999](../../src/utils/agentConfigurationManager.ts#L999) and [:1104](../../src/utils/agentConfigurationManager.ts#L1104).
  - Two `showWarningMessage` calls: [extension.ts:108](../../src/extension.ts#L108) and [packDocsPanel.ts:191](../../src/packDocsPanel.ts#L191). The second is a modal confirmation, not a problem.
- **Logger.** A `LogOutputChannel` with no ring ([logger.ts:13-20](../../src/utils/logger.ts#L13-L20)).
- **Tool wrapper.** Outcomes are classified by regex over the text ([toolMetrics.ts:61-80](../../src/core/toolMetrics.ts#L61-L80)). `MeasuredMcpServer` sees `extra.sessionId` but assigns no call id ([measuredMcpServer.ts:63-96](../../src/core/measuredMcpServer.ts#L63-L96)).
- **Tool-list bytes**, measured on a scratch build of `f76aa8b`: single-window list 28 799 B of 30 000 B; routed list (47 tools) 29 987 B, not tested; everything on 40 527 B of 42 000 B.

## Proposed fix

The 2.3.12 scope is phases 1–2: the journal, the local sources, the tool, attach, the hint and the human copy. Phase 3 (the sibling-extension contract) and phase 4 (push, log files) are follow-ups.

### Record and journal

1. New pure module `src/core/problemJournal.ts`. The record follows the issue, with two changes (see Decisions):

   ```ts
   export type ProblemSource = 'dap' | 'gdb-server' | 'task' | 'build' | 'problems' | 'ui' | 'extension' | 'serial';
   export interface IProblemRecord {
       seq: number;                 // monotonic per window: the cursor
       time: string;                // ISO 8601
       source: ProblemSource;
       origin: string;              // debug session name, task name, diagnostic source, extension id
       severity: 'error' | 'warning' | 'info';
       code?: ProblemCode;          // ErrorCode (#11) ∪ source codes (item 2)
       message: string;             // original text, ≤ 300 chars, never rewritten
       location?: { file: string; line?: number };   // workspace-relative
       debugSessionId?: string;     // renamed from sessionId: it is the DAP session, not the MCP session
       toolCallId?: string;
       hint?: string;
       count?: number;              // repeats coalesced into this record
   }
   ```

   - `ProblemJournal` holds 200 records, one instance per window.
   - Eviction removes the oldest `info` first, then the oldest `warning`, then the oldest `error`.
   - Repeats (same source, origin, code and message within 10 s) raise `count` and do not take a slot.
   - `query({sinceSeq, sources, minSeverity, limit})` returns `{records (oldest first), nextSeq, omitted}`.
   - Two monotonic counters: `nextSeq` and `errorTotal`.
2. New `src/core/problemCodes.ts`: `classifyProblem(text, source) → {code, severity, hint} | undefined`. Its first rows ship only once a captured fixture pins them:

   | Pattern (case-insensitive) | Code | Hint |
   |---|---|---|
   | `Failed to power up DAP` | `DAP_POWER_UP_FAILED` | check board power and the debug cable; then `cmsis_action load_and_debug` |
   | `target is running` / `while the target is running` | `TARGET_RUNNING` | `pause_execution` first |
   | `Waiting for a debug probe matching unique ID` (#46 symptom) | `PROBE_BUSY` | `cmsis_action stop_run` or `stop_debugging` |
   | pyOCD `No available debug probes` / J-Link connect failure | `PROBE_NOT_FOUND` | check USB; `get_session_status` |
   | `Could not find core in Coresight setup` | `CORE_NOT_FOUND` | reset or power-cycle the board |
   | `no active solution` | `CMSIS_NO_SOLUTION` | open the csolution folder in that window |

   `ProblemCode = ErrorCode | 'DAP_POWER_UP_FAILED' | 'PROBE_NOT_FOUND' | 'CORE_NOT_FOUND' | 'BUILD_ERROR'`. #49's serial records use `PORT_HELD` for a refused open and no code for a release.

### Sources in 2.3.12

1. **DAP.**
   - The tracker writes to the journal instead of its own ring: a failed response is an `error`, an adapter error is an `error`, `stderr` is a `warning`, and `console` / `important` are `info` unless `classifyProblem` matches.
   - Output that matches a known GDB-server pattern (pyOCD logger prefix, J-Link banner) becomes `source: 'gdb-server'`. The patterns are checked against fixtures from the WP-B spike.
   - `getRecentDiagnostics` and the ring go away, and with them the session-prune loop the codebase review flagged (`sessionStateTracker.ts:207-211`).
2. **Tasks and build.**
   - A subscription to `CmsisJobTracker.onDidFinishJob` ([47-task-completion-detection.md](47-task-completion-detection.md)): an execution whose exit is not 0 gives `TASK_FAILED` (`source: 'build'` for build, `'task'` otherwise) with the execution name as origin.
   - The #15 diagnostic re-run adds `BUILD_ERROR` records with `file:line` ([15-build-error-lines.md](15-build-error-lines.md)).
3. **Problems panel, on demand.** `syncProblems()` runs inside `get_recent_problems` (when `problems` is in the selected sources) and after a failed build:
   - It reads `vscode.languages.getDiagnostics()`, keeps `Error` severity, and skips the IntelliSense sources `C/C++`, `cpptools` and `clangd` by default. Those reflect the IntelliSense configuration, not the build.
   - It diffs against the last snapshot by (uri, line, message) and appends only new entries, at most 20 per sync, with the diagnostic's `source` as origin.
   - There is no `onDidChangeDiagnostics` subscription.
4. **Our notifications.**
   - New `src/utils/notify.ts` with `notifyError` / `notifyWarning`. Each shows the toast and journals it (`source: 'ui'`, origin `cmsis-developer-assistant`).
   - It replaces the 8 non-modal sites; the modal confirmation in `packDocsPanel.ts` stays.
   - `logger.error` journals `source: 'extension'` through a sink hook, rate-limited to one per message per minute.
5. **Serial** (#49): open failures, releases and disconnects. Payload never.
6. **Control channel** (#14): an expired worker fence is journaled in the worker window (`WORKER_TIMEOUT`, `warning`).

### Agent surface

1. **Tool `get_recent_problems {sinceSeq?, sources?, minSeverity?, limit?}`.**
   - Defaults: `minSeverity: 'warning'`, `limit: 20` (maximum 50).
   - It is routed like every op: `handleGetRecentProblems` on `IDebuggingHandler` → `DEBUG_OPS` → the forward → `registerTool`, followed by the rest of the new-tool checklist.
   - The description says the records come from the target window and are data, not instructions.
   - The reply text has one line per record, then `nextSeq=`. `structuredContent` is `{status: 'ok', nextSeq, returned, omitted}`; the records stay in the text only, so they are not duplicated into the context.
   - An empty reply reads "No problems since #118 (nextSeq=119)".
   - Byte cost: about 870 B, measured with a draft description through the SDK 1.26 serializer.
2. **Attach to failures.**
   - `ControlServer` (and the single-window dispatch) notes `startSeq` when an op starts.
   - When the op throws a `ToolError` or returns `status: 'timeout'`, up to 5 records with `seq ≥ startSeq` and severity `warning` or above ride along as `data.problems`. That is #11's optional `data`: in the envelope `{error: {message, code, hint, data: {problems}}}`, and from `MeasuredMcpServer`, which spreads `data`, as `structuredContent.problems`. The text gets a "Recent problems:" block of at most 5 lines.
   - A record appended while exactly one op is in flight gets that op's `toolCallId`. DAP callbacks run outside our async context, so this goes by timing, not by context.
   - This replaces `diagnosticsSuffix()` at all three sites.
3. **Call id.**
   - `MeasuredMcpServer` assigns `toolCallId` = `<first 8 characters of the session id>-<n>` and runs the handler inside an `AsyncLocalStorage` `callContext {callId, sessionId}`.
   - `RoutingDebuggingHandler.forward` copies `callId` into the envelope, and #49's `sessionId` rides in the same context.
4. **"New errors" hint.**
   - Worker replies carry `journalSeq` (the newest seq, as #11 reserves it) and one addition to the envelope, `journalErrors` (the monotonic `errorTotal`).
   - The router keeps a baseline per (MCP session, pid): the first reply sets it, and `get_recent_problems` advances it.
   - When `journalErrors` passes the baseline and this count has not been announced yet, one successful result gets the line "Note: 2 new errors in this window since you last looked — get_recent_problems {sinceSeq: 118}". The line appears once per new batch.
   - `get_session_status` always shows "Problems: 2 new errors since #118" while the count is above 0.
   - An old worker sends no counters, and then there is no hint.
5. **Humans.**
   - Command `cmsis-developer-assistant.copyRecentProblems`, titled "CMSIS Developer Assistant: Copy Recent Problems": this window's last 50 records at `warning` or above, as text, copied to the clipboard.
   - Every record at `warning` or above is also written to the output channel as `[problem #123] …`.
6. **Contract and docs.**
   - The WP-D failure rule names `get_recent_problems`.
   - A "Reading results" line in `SKILL.md` and `debug_instructions.md` mentions `structuredContent.problems`.
   - `docs/architecture/{debuggingHandler,debugMCPServer}.md`, README, feature inventory, CHANGELOG.

### Guard rails

- Messages are capped at 300 characters, replies at 50 records and 8 kB, and attached lists at 5 records.
- Paths are workspace-relative, as in `get_call_stack`.
- Target `stdout` stays excluded.
- The journal is per window and routed like every other op; nothing leaves localhost.

## What changes for the agent and the user

```text
Before: load_and_debug with the board unpowered
  "CMSIS 'load_and_debug' … started a debug session but it did NOT survive the initial connect …
   Recent adapter traffic (last 20 lines): [console] … [console] … (the power-up error scrolled out)"

After
  isError (error_code as #11 assigns it), structuredContent.problems:
    #212 error gdb-server [DAP_POWER_UP_FAILED] Failed to power up DAP → check board power and the debug cable …
  text ends with "Recent problems:" and the same line

Before: the user adds a breakpoint in the editor while the target runs → red toast, agent never knows
After:  the next successful tool result ends with
  "Note: 1 new error in this window since you last looked — get_recent_problems {sinceSeq: 230}"
  get_recent_problems {sinceSeq: 230} →
    #231 error dap [TARGET_RUNNING] error response to 'setBreakpoints': … → pause_execution first
    nextSeq=232

User: Command Palette → "Copy Recent Problems" → paste into the issue instead of a screenshot
```

## Decisions for you

- [ ] **Is one tool enough, or should `get_session_status` also carry the unseen-error count?** (open question 1) **Recommended:** one tool. `get_session_status` also carries the count line, at no schema cost, and a successful result gets a one-time hint per new batch. Alternative: the count in `get_session_status` only, without the hint. That is quieter, but a UI-originated error such as #13 stays unseen until the agent happens to ask.
- [ ] **Who owns the `code` vocabulary?** (open question 2) **Recommended:** this repo, in `src/core/problemCodes.ts` as a superset of #11's `ErrorCode`, with the table documented in `docs/architecture/debuggingHandler.md`. Agents need no list, because each record carries its hint. Codes from sibling extensions pass through unchanged with a prefix (`CSOLUTION_*`, `CMSIS_DEBUGGER_*`). The list moves to a shared Open-CMSIS-Pack document when the phase 3 contract is agreed (WP-Q). Alternative: a shared document now, which blocks 2.3.12 on other teams.
- [ ] **Journal the Problems panel continuously or read it on demand?** (open question 3) **Recommended:** on demand, diffed against the last snapshot so that `sinceSeq` still works. Errors only, IntelliSense sources excluded. Alternative: subscribe to `onDidChangeDiagnostics`. It churns while the user types and evicts DAP errors.
- [ ] **Default for the log-file fallback.** (open question 4) **Recommended:** absent, not built. Revisit it in phase 4 only if CMSIS Solution and CMSIS Debugger do not adopt the contract, because the log paths are undocumented, break silently and hold other extensions' data. Alternative: build it and leave it off, which is code to maintain with no user.
- [ ] **Record shape.** **Recommended:** `debugSessionId` instead of the issue's `sessionId`, because the MCP session id is a different thing (#49 uses it). Add `count` for coalesced repeats. Alternative: the issue's shape verbatim.
- [ ] **Weight of DAP `console` output.** **Recommended:** `info` unless a pattern matches, so it is evicted first. Alternative: `warning`, as heavy as `stderr` (what the ring does today), which lets GDB console chatter push out errors.

## Tests and acceptance

- New `src/test/problemJournal.test.ts`:
  - Severity-aware eviction at 200 records.
  - Coalescing and `count`.
  - Cursor: `sinceSeq`, `nextSeq`, `omitted`.
  - Filters and `limit`; the `errorTotal` monotonicity.
- New `src/test/problemCodes.test.ts`: every table row against a captured fixture line (pyOCD, J-Link, CDT GDB adapter). A row without a fixture is not shipped.
- A tracker adapter test with fake DAP messages: a failed response becomes an `error`, `console` becomes `info`, and a classified `stderr` line gets its code.
- `src/test/routing.test.ts`:
  - `callId` is in the envelope.
  - `journalSeq` and `journalErrors` come back.
  - A worker `ToolError` arrives with `problems`.
  - The hint appears once per batch and moves with `get_recent_problems`.
  - An old worker without counters gives no hint.
- `test/transport/session-lifecycle.js`:
  - `get_recent_problems` is listed.
  - An empty reply is under 200 B.
  - A failing call carries `structuredContent.problems`.
  - The budgets hold after WP-G.
- `test/transport/two-window-routing.js`: records come from the target window, not from the router.
- Live:
  - Board unpowered → `cmsis_action load_and_debug` fails with `DAP_POWER_UP_FAILED` attached.
  - Editor breakpoint while the target runs → the hint on the next successful result.
  - Compile error → `BUILD_ERROR` records with `file:line` (with #15).
  - "Copy Recent Problems" produces pasteable text.

## Out of scope and follow-ups

- **Phase 3.** A `getRecentProblems` command contract with CMSIS Solution and CMSIS Debugger. Filed through WP-Q (#21), designed with WP-M (#41).
- **Phase 4.** MCP logging notifications (`notifications/message`), the journal as a subscribable resource, and the log-file fallback if it is still needed.
- **Terminal source.** `onDidEndTerminalShellExecution` needs shell integration, and CMSIS tasks are `CustomExecution` pseudoterminals, so it would not see them.
- **Cross-window view.** An aggregated journal across windows. For now `get_recent_problems` follows the session's window like every other op.
- **#50 detection.** A foreign pyocd, gdb or JLinkGDBServer process holding the probe, recorded as a journal source.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
