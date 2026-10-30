# #12 60 s hard cap turns long cmsis_action builds (pack resolution, first build) into false failures

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** Job tracking, the status action and longer waits are implemented; see [handler architecture](../architecture/debuggingHandler.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#12](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/12) |
| Area · priority · source | Build & flash · High · Studio test |
| Original release plan | 2.3.11 (WP-B, together with #47 and #46) |
| Size | M |
| Depends on | #11 (`ToolReply` with status `running`), #47 (`CmsisJobTracker`) |
| Related | #46, #47, #14 (router and worker budgets), #15, #50 |
| Original status | Proposed, awaiting review (2026-09-23) |

The job model, the task classifier and the per-action outcomes are defined in [47-task-completion-detection.md](47-task-completion-detection.md#proposed-fix). This document adds the long-wait cap, the `status` action and the "attach instead of relaunch" rule.

## Problem

A `cmsis_action build` that runs longer than 60 s cannot be waited for. Pack download (`downloadPacks` is on by default, so every build passes `--packs`) and first builds routinely take longer. The 2.3.6 mitigation changed the text: past the wait the call says the build is still running and suggests calling `build` again. Everything else is unchanged in 2.3.10:

- The fence re-clamps any `timeoutMs` to 60 s, and zod refuses anything above 60 000.
- A second `build` is a second command. CMSIS Solution queues it behind the running build (`waitForActiveBuildTasksCompletion`). The second call's waiter then reports the *first* build's exit code, which is right by accident, and a duplicate build starts that nobody observes.
- The waiter's budget is fixed when it is armed, after the target switch. A switch that takes more than 3 s lets the handler fence fire first. Its text says "the DAP probe or target may be unresponsive", which is wrong for a build and is the "did not complete within its cap" case the docs describe.

The issue's statement that the router is not the limit still holds: the forward floor for `cmsis_action` and `flash` is 10 min.

## Current state (2.3.10)

- **Caps.** `HARD_HANDLER_CAP_MS = 60_000` ([debuggingHandler.ts:38](../../src/debuggingHandler.ts#L38)) is applied with `Math.min` in `withHandlerTimeout` ([:52-54](../../src/debuggingHandler.ts#L52-L54)). `cmsis_action` defaults to it for build-class actions ([:2016-2020](../../src/debuggingHandler.ts#L2016-L2020)) and is fenced at [:2021](../../src/debuggingHandler.ts#L2021). `flash` is fenced the same way ([:1919](../../src/debuggingHandler.ts#L1919), [:1933](../../src/debuggingHandler.ts#L1933)).
- **Waiter.** It gets `max(5 s, timeout − 3 s)`, measured from arming ([:2093-2095](../../src/debuggingHandler.ts#L2093-L2095)). Arming happens after the solution query, the target query and the switch: two 10 s re-activation steps plus a 15 s poll ([:1835-1854](../../src/debuggingHandler.ts#L1835-L1854)). The fence clock runs from entry.
- **Still-running text.** [:2215-2220](../../src/debuggingHandler.ts#L2215-L2220): "re-run cmsis_action build to get the final exit status". There is no job memory: the re-run issues `cmsis-csolution.build` again ([:2103](../../src/debuggingHandler.ts#L2103)).
- **Schema.**
  - `cmsis_action` `timeoutMs`: `.min(100).max(60_000)` ([debugMCPServer.ts:940](../../src/debugMCPServer.ts#L940)).
  - `flash` `timeoutMs`: `.min(1_000).max(60_000)` ([:958-959](../../src/debugMCPServer.ts#L958-L959)).
  - `TIMEOUT_DESC` "max 60000" ([:351](../../src/debugMCPServer.ts#L351)).
  - The server instructions say "capped at 60 s" ([:295-296](../../src/debugMCPServer.ts#L295-L296)).
  - The description promises that build, load, erase and load_and_run "wait for the task and end with ✅ or ❌" ([:926-931](../../src/debugMCPServer.ts#L926-L931)).
- **Router.** `SLOW_OPS` gives `handleCmsisCommand` and `handleFlash` a forward floor of `max(timeoutMs + 15 s, 10 min)` ([opTable.ts:159-176](../../src/core/opTable.ts#L159-L176)).
- **Precedent.** The documentation and build-artefact tools already accept `timeoutMs` up to 600 000 ([toolRun.ts:35-39](../../src/core/toolRun.ts#L35-L39), [packDocsTools.ts:34](../../src/packDocsTools.ts#L34), [buildInfoTools.ts:29](../../src/buildInfoTools.ts#L29)).
- **Docs repeat the 60 s cap and the "run build again" advice:**
  - [debug_instructions.md:110](../../docs/agent-resources/debug_instructions.md#L110);
  - [SKILL.md:106-111](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/SKILL.md#L106-L111);
  - [cmsis-embedded-guide.md:80](../../docs/agent-resources/cmsis-embedded-guide.md#L80);
  - [troubleshooting/embedded.md:44](../../docs/agent-resources/troubleshooting/embedded.md#L44).

## Proposed fix

1. **Two caps.** `withHandlerTimeout(label, timeoutMs, fn, capMs = HARD_HANDLER_CAP_MS)`.
   - A new `LONG_HANDLER_CAP_MS = 600_000` is used only by `cmsis_action` and `flash`.
   - The default wait of both stays 60 s (`DEFAULT_LONG_WAIT_MS`), because MCP clients cut calls on their own. The JSON configs we write for Cline, Roo, Cursor and Antigravity carry `timeout: 180` (the `timeoutInSeconds` setting); the Codex block sets only `url` ([agentConfigurationManager.ts:80-106](../../src/utils/agentConfigurationManager.ts#L80-L106), [:449-455](../../src/utils/agentConfigurationManager.ts#L449-L455)).
   - The DAP tools keep 60 s.
2. **One deadline per call.**
   - `handleCmsisCommand` computes `deadline = start + wait` on entry.
   - The job wait (`tracker.waitFor(job, deadline − 1.5 s)`) uses what is left after the pre-checks and the target switch.
   - The fence stays as a backstop only. For `cmsis_action`, the handler always answers before it, so the "DAP probe may be unresponsive" text can no longer appear for a build.
3. **Past the wait: a job, not an error.**

   ```text
   CMSIS 'build' on MPS3 is still running after 60 s (task 'cbuild Blinky.csolution.yml --active MPS3 …', job b-3).
   This is not a failure. Call cmsis_action {action:'status'} to wait for the result — do not start another build.
   ```

   This is a `ToolReply` with status `running` and `data: { job: { id, action, target, task, startedAt, elapsedMs } }`, so there is no `isError`. #11 maps it to `structuredContent`.
4. **Attach instead of relaunch.**
   - A `build` while a build job is in flight, whether ours or one the user started from the panel, attaches to it: "attached to the build started 75 s ago (not started again)".
   - The same holds for `load`, `erase` and `load_and_run` while a job of the same action is in flight.
   - `target` must match the in-flight job's target. A different target while a build runs is refused with `ToolError(TASK_FAILED)`, hint "wait with status, then build the other target".
5. **New `action: "status"`** (an enum value, no new tool).
   - It skips the solution pre-check and the target switch.
   - With a job in flight it waits up to `timeoutMs` (default 60 s) and returns the job's outcome as defined in #47.
   - Without one it returns at once: the last result per action from the last 10 min, and the live CMSIS executions of the window ("CMSIS Run alive for 3 min — holds the probe", from #46).
   - No `jobId` parameter: each action has at most one job in flight per window, so "the latest" is unambiguous.
6. **Schema and descriptions** (bytes in the single-window `tools/list`, measured at 28 799 of 30 000 B with `test/transport/session-lifecycle.js`).
   - `action` enum `+ 'status'`: +9 B.
   - `timeoutMs` `.max(600_000)` on `cmsis_action` and `flash`: +2 B.
   - A new `LONG_TIMEOUT_DESC` = "Wait in ms, default 60000, max 600000." replaces `TIMEOUT_DESC` on these two tools: −22 B on `cmsis_action` (the readiness-wait suffix stays) and −46 B on `flash`.
   - `cmsis_action` description: replace "wait for the task … Long builds: get_debug_instructions topic build." with "wait for their task and end with ✅ or ❌ plus the exit code. A task still running at the wait returns status running: call action status, never start it again." and shorten the `load_and_debug` clause. That is −20 B, at 492 of the 700 characters allowed.
   - Net about −80 B. The server instructions (not part of `tools/list`) change "capped at 60 s" to "capped at 60 s (cmsis_action and flash: 600 s)".
7. **Docs.** The build topic, SKILL.md, `cmsis-embedded-guide.md` (and its skill copy) and `troubleshooting/embedded.md` all get the same rule: long builds return `running`; call `status`; never start a build again to learn its status.
8. **`flash`.** It gets the long cap and the deadline. Its guard and its pyOCD resolution are in #46.

## What changes for the agent and the user

```text
Before: build with pack download, 140 s
  call 1 (57 s)  "… is still running after 57s … re-run cmsis_action build to get the final exit status"
  call 2 (≈80 s) "✅ CMSIS 'build' succeeded (task 'cbuild …' exited 0)"   ← the first build's result
                  meanwhile a second, unobserved build starts in the terminal
After:
  call 1 (60 s)  status: running — "still running after 60 s (job b-3) … call cmsis_action {action:'status'}"
  call 2 (≈80 s) "✅ CMSIS 'build' succeeded on MPS3 (task 'cbuild …' exited 0 after 140 s, job b-3)"
                  no second build
  or call 1 with timeoutMs 300000 → one call, one terminal result (if the client allows a 5 min call)
```

The user sees one build in the terminal instead of two.

## Decisions for you

- [ ] **Default wait for `cmsis_action` and `flash`.** **Recommended:** keep 60 s and let `status` carry longer waits, because clients with a 60 s call limit then never cut a call. Alternative: default to the full 600 s, which is simpler for agents in clients without a call limit but loses the result in the others.
- [ ] **What a `build` does while a build is in flight.** **Recommended:** attach to it, and document how to force a fresh build (wait with `status`, then `build`). Alternative: refuse with `TASK_FAILED` and a hint, which is stricter but costs a round trip in the common "is it done yet?" case.
- [ ] **`status` scope.** **Recommended:** one action value that reports jobs *and* the live CMSIS executions of the window, as #46 needs. Alternative: fold the live executions into `get_session_status` only; that costs nothing in `tools/list` but gives agents two places to look. #46 proposes adding one line there as well.
- [ ] **Client timeouts.** **Recommended:** leave the agent configs alone in 2.3.11 and document that `timeoutMs` above 60 s needs a client that allows long calls. Alternative: write a longer per-server call timeout into the configs we generate (Codex `tool_timeout_sec`, a larger `timeout` in the JSON configs). That is one more config key per agent to maintain and verify.

## Tests and acceptance

- **Unit tests.**
  - `src/test/timeout.test.ts` (or a new `handlerTimeout.test.ts`): the fence honours the long cap for `cmsis_action` and `flash` only.
  - `src/test/cmsisJobTracker.test.ts`: attach on repeat, the target-mismatch refusal, `status` with and without a job, and the deadline shared with the pre-checks (fake clock: a 20 s switch still returns the job's `running`, not the fence text).
- **Routing test.** `routing.test.ts` keeps the `forwardTimeoutMs('handleCmsisCommand', {timeoutMs: 600000})` ≥ 615 s case.
- **Transport test.** `session-lifecycle.js` checks the budget (the delta is negative) and `status` without a solution.
- **Live, FVP corstone-blinky.** Delete the pack cache or use a solution with a missing pack.
  - `build` returns `running` at 60 s;
  - `status` returns the exit code;
  - only one `cbuild` runs in the terminal.
- **Live, probe board.** `flash {timeoutMs: 120000}` on a large image completes in one call.

## Out of scope and follow-ups

- **Progress notifications.** MCP progress (`notifications/progress` for callers that send a progress token) could keep long calls alive in some clients. Decide once #11's result mapping is in.
- **Build error lines.** Covered by #15.
- **Worker fence.** The #14 wall-clock fence on worker ops must use the forward budget: 615 s with `timeoutMs` 600 000.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
