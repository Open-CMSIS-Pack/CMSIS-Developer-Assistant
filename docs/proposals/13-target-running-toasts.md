# #13 "Cannot execute this command while the target is running" toast: UI-command fallbacks and ungated breakpoint ops

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** The run-state guards and gdbtarget control changes are implemented; see [executor architecture](../architecture/debuggingExecutor.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#13](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/13) |
| Area · priority · source | Run control and breakpoints · High (P1) · studio test |
| Original release plan | 2.3.11 (WP-C) |
| Size | M |
| Depends on | #11 (`ToolError`, `TARGET_RUNNING`) |
| Related | #21 (toast truncation is VS Code / CMSIS Debugger behaviour), #3 (same GDB CLI path), #48 (journal records the rejection) |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

The red toast is GDB's own message: "Cannot execute this command while the target is running. Use the "interrupt" command…". VS Code shows it when a request issued by its debug UI fails. A request we send with `session.customRequest` fails back to us as a rejected promise and never toasts.

2.3.10 still sends three kinds of request through the UI layer while the target may be running:

- **UI-command fallbacks.** Step, continue and pause fall back to a `workbench.action.debug.*` command after any DAP rejection that is not a timeout. GDB has just refused, so the UI command repeats the refused operation and the refusal becomes a toast. Our tool gets no error; it waits for a stop that never comes.
- **Restart.** `restart_debugging` always runs `workbench.action.debug.restart`.
- **Breakpoint changes.** The breakpoint tools change VS Code's breakpoint model, and VS Code then sends `setBreakpoints` from the UI layer. They check only that a session exists.

A second, silent failure sits next to the toast. When GDB rejects our own `break`, `clear` or `delete` because the target is running, the tools still report success.

Partly changed since the issue:

- The `gdbtarget` adapter now pauses and resumes the target around `setBreakpoints` itself. This is cdt-gdb-adapter 1.10.0, inside cdt-gdb-vscode 2.9.1, which CMSIS Debugger 1.8.0 depends on. So the model path should only toast when the adapter's view of the run state is stale.
- Reading that adapter turned up a new suspected bug. It treats REPL input as a GDB command only when the input starts with `>`, while we send `-exec <cmd>`. If this holds, our `break`, `dprintf`, `clear`, `delete` and `monitor reset` never reach GDB at all (see step 0).

## Current state (2.3.10)

- **UI fallbacks.** All five fire on any error that is not a `HardwareTimeoutError`, and each acts on VS Code's focused session:
  - `workbench.action.debug.stepOver` at [debuggingExecutor.ts:282](../../src/debuggingExecutor.ts#L282).
  - `stepInto` at [:297](../../src/debuggingExecutor.ts#L297).
  - `stepOut` at [:312](../../src/debuggingExecutor.ts#L312).
  - `continue` at [:328](../../src/debuggingExecutor.ts#L328).
  - `pause` at [:345](../../src/debuggingExecutor.ts#L345).
  - The timeout recovery pauses through the same path ([debuggingHandler.ts:1205-1215](../../src/debuggingHandler.ts#L1205-L1215)).
- **Restart.** `restart()` always runs `workbench.action.debug.restart` ([debuggingExecutor.ts:385-391](../../src/debuggingExecutor.ts#L385-L391)). The adapter advertises no restart request (`getCapabilities`, cdt-gdb-adapter `dist/gdb/GDBDebugSessionBase.js:308-328`), so VS Code tears the session down and relaunches it from the UI layer. For a CMSIS launch configuration that includes `preLaunchTask: "CMSIS Load"` and `monitor reset halt`. `handleRestart` checks only that a session exists ([debuggingHandler.ts:544-569](../../src/debuggingHandler.ts#L544-L569)).
- **Run-state gate.** `ensureStoppedSession` ([debuggingHandler.ts:370-398](../../src/debuggingHandler.ts#L370-L398)) guards step, continue and the inspection tools. It does not guard these:
  - `add_breakpoint` ([:808-885](../../src/debuggingHandler.ts#L808-L885)).
  - `add_logpoint` ([:734-806](../../src/debuggingHandler.ts#L734-L806)).
  - `remove_breakpoint` ([:890-925](../../src/debuggingHandler.ts#L890-L925)).
  - `clear_all_breakpoints` ([:333-361](../../src/debuggingHandler.ts#L333-L361)).
  - `restart_debugging`.
- **Model changes.** `vscode.debug.addBreakpoints` is at [debuggingExecutor.ts:409](../../src/debuggingExecutor.ts#L409), and `removeBreakpoints` at [:550](../../src/debuggingExecutor.ts#L550) and [:775](../../src/debuggingExecutor.ts#L775). The adapter wraps `setBreakpoints` in `pauseIfNeeded` / `continueIfNeeded` (`GDBDebugSessionBase.js:968-999`).
- **GDB replies.**
  - `execGdbCommand` returns `{raw, errored}` ([debuggingExecutor.ts:432-451](../../src/debuggingExecutor.ts#L432-L451)), but every caller keeps only `raw` ([:469-535](../../src/debuggingExecutor.ts#L469-L535)).
  - `classifyGdbBreakpointReply` ([debuggingHandler.ts:605-614](../../src/debuggingHandler.ts#L605-L614)) maps GDB's "target is running" text to `'unconfirmed'`, which `add_breakpoint` reports as "The breakpoint is set" ([:879-881](../../src/debuggingHandler.ts#L879-L881)).
  - The `clear` and `delete` handling reports success for any reply ([:915-920](../../src/debuggingHandler.ts#L915-L920), [:345-352](../../src/debuggingHandler.ts#L345-L352)).
- **The GDB command prefix (suspected bug, not verified live).**
  - We send `-exec <command>` as the evaluate expression ([debuggingExecutor.ts:440](../../src/debuggingExecutor.ts#L440)).
  - cdt-gdb-adapter 1.10.0 checks `isCliCommand = expression.startsWith('>') && args.context === 'repl'` (`GDBDebugSessionBase.js:1982`). Anything else is evaluated as a C expression. When `-var-create` fails it answers *success* with the default body `Error: could not evaluate expression` (`:1969`, `:2110`).
  - Our own comments already call that reply "a harmless adapter quirk" ([debuggingHandler.ts:846-849](../../src/debuggingHandler.ts#L846-L849)).
  - The adapter's integration tests use only `>`-prefixed commands.

## Proposed fix

0. **Spike (½ day, live, before coding).** Enable DAP tracing on the corstone-blinky FVP and on one probe board, then:
   - Reproduce the toast on each path: step racing a running target, `restart_debugging` while running, `add_breakpoint` while running.
   - Send `-exec info breakpoints` and `> info breakpoints` through `evaluate` (context `repl`), with the target stopped and with it running.

   Record which paths toast and what each evaluate returns. If `>` is confirmed, open a separate bug for the prefix. The prefix also affects `reset` (`monitor reset`), the memory-read ladder (#3) and the `-exec` passthrough documented in `debug_instructions.md`.
1. **No UI fallback on `gdbtarget`** ([debuggingExecutor.ts:273-347](../../src/debuggingExecutor.ts#L273-L347)).
   - For `session.type === 'gdbtarget'`, a rejected `next`, `stepIn`, `stepOut`, `continue` or `pause` is thrown as a `ToolError`. It never reaches `executeCommand`:
     - If the text matches `/target is running/i`, the code is `TARGET_RUNNING`, hint "pause_execution first, or wait_for_stop if a stop is expected".
     - Otherwise the code is `INTERNAL` with the adapter's text: "GDB rejected '<op>': …".
   - Other debug types keep the fallback, which protects the inherited multi-language support (Decision 2).
   - One private helper, `rejectOrFallBack(session, op, uiCommand, err)`, replaces the five copies.
2. **Pause, apply, resume for breakpoint operations on a running `gdbtarget` target.**
   - New handler helper `withTargetHalted(op, fn)`:
     - No session: `fn` runs on the model only, as today.
     - State `stopped`: `fn` runs directly.
     - State `running`: `issueAndWaitForStop(() => executor.pause(5_000), 5_000)`, then `fn`, then `executor.continue()`. The resume runs in `finally`, so a failing `fn` never leaves the core halted.
     - State `initializing` / `unresponsive`: `ToolError` `NO_SESSION` / `TIMEOUT`.
   - It is used by `add_breakpoint`, `add_logpoint`, `remove_breakpoint` and `clear_all_breakpoints`.
   - Inside the halted window, after `addBreakpoints`, the new breakpoint is polled via `session.getDebugProtocolBreakpoint(bp)` (VS Code API, engine ≥ 1.109 is fine) until the adapter reports it (`verified` known), for at most 2 s. So the resume never overtakes `setBreakpoints`.
   - The result says "target paused 0.2 s to apply, then resumed" and reports `verified` / `line` from the adapter. This is better evidence than today's "no echo — normal" (Decision 1).
3. **`restart_debugging` on `gdbtarget`** ([debuggingExecutor.ts:385-391](../../src/debuggingExecutor.ts#L385-L391)).
   - If the target is running, first pause it through DAP, so the adapter disconnects from a halted core.
   - Then take the root session (walk `parentSession`, which covers multi-core child sessions), `vscode.debug.stopDebugging(root)`, wait for it to end, and call `vscode.debug.startDebugging(root.workspaceFolder, root.configuration)`. This relaunches the same resolved configuration, including its `preLaunchTask`, exactly as the UI restart does today, but through the API. A failure now comes back to the tool instead of becoming a toast.
   - Other debug types keep the UI command (Decision 3).
   - The tool description is unchanged. The result mentions that a CMSIS launch configuration re-flashes and resets.
4. **Honest GDB replies.**
   - Move `classifyGdbBreakpointReply` into a new pure `src/core/gdbReplies.ts`. It returns `'bound' | 'rejected' | 'running' | 'unconfirmed'` and takes the `errored` flag.
   - `'running'`, meaning GDB's "Cannot execute this command while the target is running", becomes `ToolError('TARGET_RUNNING')`. After step 2 this is only possible in a race.
   - The `setBreakpointViaGdb`, `setLogpointViaGdb`, `clearBreakpointViaGdb` and `clearAllBreakpointsViaGdb` calls return `{raw, errored}` instead of `raw`. The `clear` and `delete` matchers report an errored reply as "GDB did not confirm" instead of "issued".
   - If the spike confirms the `>` prefix, `execGdbCommand` prefixes by session type: `>` for `gdbtarget`, `-exec` otherwise. This is a separate commit with its own issue (Decision 4). The spike also decides whether `'unconfirmed'` can stay "normal".
5. **Tools list and docs.** The `tools/list` cost is 0 B, because no description needs to change: the behaviour is explained by the result. Update `docs/architecture/debuggingExecutor.md` (which says the fallbacks are non-timeout only), the `breakpoints` topic of `get_debug_instructions` and `skills/cmsis-debug-live/SKILL.md` ("breakpoints can be set while running; the tool pauses briefly"), and the CHANGELOG.

## What changes for the agent and the user

```text
add_breakpoint {fileFullPath: "/w/Blinky/main.c", line: 42} while blinky free-runs (gdbtarget)

2.3.10   "Breakpoint added at /w/Blinky/main.c:42
          Sent to GDB (`break`). The adapter did not echo a confirmation — this is normal for gdbtarget
          and does NOT mean it failed. The breakpoint is set; …"                 (+ possibly a red toast)
new      "Breakpoint added at /w/Blinky/main.c:42 — adapter: verified, line 42.
          Target paused 0.2 s to apply the breakpoint, then resumed."

step_over in the race window: the stop tracker still says 'stopped' while GDB already runs the target

2.3.10   red toast "Cannot execute this command while the target is running. Use the …"
         tool: "⚠️ 'step_over' did not complete within 30s …"
new      isError: "[TARGET_RUNNING] GDB rejected 'next': the target is running.
          pause_execution first, or wait_for_stop if a stop is expected."   — no toast
```

The user no longer sees red toasts that the agent caused. A failed restart shows up in the agent's result instead of a toast only the human sees.

## Decisions for you

- [ ] **1. Breakpoint change on a running target.** **Recommended:** pause, apply, resume inside the tool, and say so in the result. This is what a human does, and what the adapter already does internally around `setBreakpoints`.
  - Alternative: refuse with `TARGET_RUNNING`. This never halts a timing-critical target (motor control, USB enumeration) behind the agent's back, but costs two extra calls, and the agent may forget to resume.
- [ ] **2. Where the UI fallbacks go.** **Recommended:** drop them for `gdbtarget` only.
  - Alternative: drop them for every debug type. Simpler, but it changes inherited upstream behaviour for Python, Node and cppdbg, which this repo does not test live.
- [ ] **3. How `restart_debugging` restarts a `gdbtarget` session.** **Recommended:** pause first, then `stopDebugging` + `startDebugging(root.configuration)` through the API.
  - Alternative A: keep `workbench.action.debug.restart` but pause first. A smaller change, but failures still toast and it acts on the focused session.
  - Alternative B: for CMSIS sessions, delegate to `cmsis_action load_and_debug`. It reuses CMSIS Solution's pipeline, but that command is fire-and-return and needs an active solution.
- [ ] **4. The `-exec` prefix, if the spike confirms it.** **Recommended:** open a separate bug and land the fix in the 2.3.11 branch before step 4. Step 4's reply handling only means something when the command reaches GDB.
  - Alternative: defer it. Step 4 then only uses the `errored` flag, and `break`, `dprintf` and `monitor reset` stay no-ops on `gdbtarget`.

## Tests and acceptance

- **Unit, `src/test/debuggingHandler.test.ts`** (fake executor, existing style):
  - Gating matrix per breakpoint tool: `stopped` → no pause; `running` → `arm, pause, <mutation>, continue` in that order; a mutation that throws still resumes; `initializing` → `NO_SESSION`; no session → model only, no pause.
  - `restart_debugging` pauses a running target first.
- **Unit, new `src/test/gdbReplies.test.ts`:**
  - `Breakpoint 3 at 0x80001a4: file main.c, line 42.` → `bound`.
  - `No source file named foo.c.` → `rejected`.
  - GDB's full three-line running message → `running`.
  - `Error: could not evaluate expression` with `errored: false` → per the spike result.
  - Any text with `errored: true` is never `bound`.
- **Unit, executor with `test/transport/vscode-stub.js`:**
  - A fake `gdbtarget` session whose `customRequest('next')` rejects with the running text: `stepOver` rejects with `TARGET_RUNNING`, and `commandHandlers['workbench.action.debug.stepOver']` is never called.
  - The same with a `python` session still calls it.
- **Live, FVP corstone-blinky (Arm-FVP in Docker on macOS), and one probe board:**
  - `continue_execution` into the free-running loop, then `add_breakpoint` on the loop body: the tool reports pause and resume, the breakpoint hits, and there is no toast.
  - `restart_debugging` while running: no toast, and the session is back.
  - Resume from the Debug Console with `> continue` and call `step_over` right away. If the race is hit, the result is `TARGET_RUNNING` and there is no toast. The race is forced reliably only in the executor unit test above.
  - The spike's evaluate replies are recorded in the PR.

## Out of scope and follow-ups

- **Truncated toasts** are VS Code / CMSIS Debugger behaviour, tracked in #21.
- **The `-exec` / `>` prefix** gets its own issue if the spike confirms it. It also changes `reset` and the memory-read ladder (#3) and the `-exec` passthrough documented in `docs/agent-resources/debug_instructions.md` and `troubleshooting/embedded.md`.
- **UI fallbacks for other debug types** stay as they are.
- **`add_logpoint` sets both a model logpoint and a GDB `dprintf`.** Once commands reach GDB, check whether a hit prints twice.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
