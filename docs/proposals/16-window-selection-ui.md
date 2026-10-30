# #16 Human-facing window selection: status-bar target, Select Target Window quick-pick, optional pid on path-less tools

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** The status bar and target-window picker are implemented; see [window routing](../architecture/windowRouting.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#16](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/16) |
| Area · priority · source | Multi-window/transport · Medium · Studio test |
| Original release plan | 2.3.12 (WP-J) |
| Size | M |
| Depends on | #11 (`AMBIGUOUS_WINDOW` with the candidate list in `data`), #19 (the `mode` option of `atomicFile`), WP-G (tool-list bytes) |
| Related | #14 (`role` in the registry), #49 (`serial_capture` takes the same `window` argument) |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

With two windows open and no single window that has an active session, every path-less tool fails with a tie error. The agent then has to pin a window itself. The user has no UI to choose a window. The user also cannot see which window is the router, which windows are workers, or which window an agent session is driving.

`select_debug_window` is the only tool that takes a pid or a folder, so `cmsis_action`, `flash`, `reset` and the serial tools cannot be aimed per call. The pin lives in memory per MCP session, so it is lost whenever the agent reconnects.

The issue's claim that the tie error already lists every candidate is true. #11 (2.3.11) moves that list into the `AMBIGUOUS_WINDOW` error's `data`.

## Current state (2.3.10)

- **UI.** `createStatusBarItem` is not used anywhere. The only quick-picks choose a launch configuration, the skill install scope, or a document's target scope and category.
- **Tools.**
  - `list_debug_windows` ([debugMCPServer.ts:987-994](../../src/debugMCPServer.ts#L987-L994) → [routingDebuggingHandler.ts:201-215](../../src/routingDebuggingHandler.ts#L201-L215)).
  - `select_debug_window` ([debugMCPServer.ts:996-1006](../../src/debugMCPServer.ts#L996-L1006) → [routingDebuggingHandler.ts:218-238](../../src/routingDebuggingHandler.ts#L218-L238)).
  - Both are registered only when the session handler routes ([debugMCPServer.ts:984](../../src/debugMCPServer.ts#L984)).
- **Pin.** `pinnedPid` is a field of the per-session `RoutingDebuggingHandler` ([routingDebuggingHandler.ts:25](../../src/routingDebuggingHandler.ts#L25), set at [:234](../../src/routingDebuggingHandler.ts#L234)). It is held in memory only.
- **Ladder** `resolveTarget` ([routingDebuggingHandler.ts:51-95](../../src/routingDebuggingHandler.ts#L51-L95)):
  1. A path hint. It re-aims the session even over a pin, and a hint that matches no window is a hard error.
  2. The pin. When the pinned window is gone, this is a hard error.
  3. The cached target.
  4. `findSoleActiveSession` ([workspaceRegistry.ts:231-234](../../src/utils/workspaceRegistry.ts#L231-L234)).
  5. `findSoleWindow`.
  6. On a tie, the error from `noTargetMessage` ([:97-119](../../src/routingDebuggingHandler.ts#L97-L119)).
- **Path hint.** `pathHintOf` reads only `fileFullPath` and `workingDirectory` ([opTable.ts:186-195](../../src/core/opTable.ts#L186-L195)).
- **Path-less tools.** None of them has a window selector:
  - `cmsis_action {action, target, timeoutMs}` ([debugMCPServer.ts:925-945](../../src/debugMCPServer.ts#L925-L945)). Its `target` is the csolution target-type, not a window.
  - `flash {cbuildRunFile, timeoutMs}` ([:949-964](../../src/debugMCPServer.ts#L949-L964)).
  - `reset` ([:474-490](../../src/debugMCPServer.ts#L474-L490)).
  - The ten `serial_*` tools ([:804-910](../../src/debugMCPServer.ts#L804-L910)).
- **Tool-list bytes**, measured on a scratch build of `f76aa8b`: the routed list (47 tools) is 29 987 B and no test measures it. The single-window list (45 tools) is 28 799 B against the 30 000 B budget of [session-lifecycle.js:149](../../test/transport/session-lifecycle.js#L149).

## Proposed fix

1. **Status-bar item** `cmsis-developer-assistant.window` in every window:
   - It is named "CMSIS Developer Assistant", so users can hide it through the status bar's own context menu.
   - A pure renderer `renderWindowStatus(state)` lives in new `src/core/windowStatus.ts`; the wiring lives in `src/windowStatus.ts`.
   - Text: `$(plug) CDA router` or `$(plug) CDA worker`. It adds `· default` when this window is the default target and `$(sync~spin)` while a forwarded op runs here.
   - Tooltip: the role, the endpoint and the last agent op ("read_memory 4 s ago"). In the router window it also lists the live MCP sessions with their target window and the reason for it (pinned, default, path, cached). It ends with "Click to choose the target window".
   - Sources:
     - The worker learns about ops from a `ControlServer` `onOp` hook.
     - The router asks `DebugMCPServer` for its sessions' `RoutingDebuggingHandler.describeTarget()`.
     - The default target is re-read on the 20 s heartbeat, and immediately in the window that changed it.
2. **Command** `cmsis-developer-assistant.selectTargetWindow`, titled "CMSIS Developer Assistant: Select Target Window":
   - It is the status bar's click action.
   - It offers a quick-pick over `registry.list()`: the label is the window name, the description its folders, and the detail "router · debugging: CMSIS Debug · cmsis=…". The current choice carries `$(check)`, and there is an extra item "Automatic (no default)".
   - The choice is written to `default-target.json` in the registry directory with mode 0600: `{pid, workspaceFolder, name, setAt}`. "Automatic" deletes the file.
3. **Ladder** (`resolveTarget`), strongest first. New steps are in bold.
   1. **The per-call `window` argument.** It re-aims the session's cached target, as a path does.
   2. A path hint (unchanged).
   3. The session pin from `select_debug_window`.
   4. The cached target. It is **dropped when the default target's `setAt` changed** since this session last looked, so a click in the status bar takes effect for sessions that already have a target.
   5. **The default target**, if its window is live: looked up by pid, then by `workspaceFolder`, so it survives a window reload.
   6. The sole window with an active session.
   7. The sole window.
   8. `AMBIGUOUS_WINDOW`. Its candidate list gains `isDefault` and `role`, and its hint reads: "select_debug_window, or ask the user to pick one: click 'CDA' in the status bar → Select Target Window".

   `ResolutionReason` gains `'window-arg'` and `'default'`.
4. **`window` argument** on `cmsis_action`, `flash`, `reset`, `serial_open` and `serial_capture` (#49):
   - Schema: `window: z.string().optional().describe(WINDOW_DESC)` with `WINDOW_DESC = 'Run in this window: its pid or a path inside its workspace (list_debug_windows).'`
   - The argument is registered only when the session routes, so the single-window list is unchanged.
   - `pathHintOf` becomes `targetHintOf(args)`, which returns `{pid}` for an all-digit value and `{path}` otherwise.
   - `RoutingDebuggingHandler` strips `window` before forwarding.
   - A `window` that matches nothing is a `ToolError('INVALID_ARGUMENT')` with the candidate list in `data`.
5. **Listing and pinning.**
   - `list_debug_windows` marks the default window "default target (set in VS Code)" and shows `role` once #14 writes it.
   - The reply of `select_debug_window` mentions a default target when one exists, and states that the session pin overrides it.
6. **Docs.**
   - The "Several windows" paragraph in `skills/cmsis-debug-live/SKILL.md` and in `debug_instructions.md`.
   - The README multi-window section, the `package.json` command contribution, `docs/architecture/debugMCPServer.md` and the CHANGELOG.

**Byte cost.** About 100 B per `window` parameter, measured with the SDK 1.26 serializer (135 B with a 120-character description), so about 500 B for five tools. Only the routed list pays it. WP-G adds a routed-list measurement and must leave room for this.

## What changes for the agent and the user

```text
Before: two windows, neither debugging
  cmsis_action {action:"load_and_debug"}
  → "2 VS Code windows are registered and none has an active debug session … Pick a window with select_debug_window: …"
  user: no way to choose, no way to see router/worker

After
  status bar (window A)   $(plug) CDA router · default
  status bar (window B)   $(plug) CDA worker $(sync~spin)        tooltip: "read_memory 2 s ago"
  user clicks → Select Target Window → "CDA-Testdrive"           writes default-target.json
  cmsis_action {action:"load_and_debug"}                           → runs in CDA-Testdrive (via default)
  flash {window:"/work/other-board"}                               → this call, and the session's later path-less calls, go to that window
```

## Decisions for you

- [ ] **Where the default target sits in the ladder.** **Recommended:** after the cached target, and a change of default drops every session's cache. The click takes effect at once, and a path the agent named keeps its precedence within the session. Alternatives: before the cached target (the plan), where a path-less call right after `add_breakpoint` on a file in window B would jump to default window A; or only on ties (the issue), where a click does not affect sessions that already have a target.
- [ ] **What identifies the default window.** **Recommended:** the pid, with a folder fallback, because a window reload changes the pid. Alternative: the pid only, which silently expires on every reload.
- [ ] **Type of `window`.** **Recommended:** one string, either the pid digits or a path. Alternative: `pid` and `workspaceFolder` like `select_debug_window`, which costs about twice the bytes and allows an ambiguous combination.
- [ ] **Which tools take `window`.** **Recommended:** the five that start or own something. The others follow the session, so this costs about 500 B. Alternative: every path-less tool, about 30 × 100 B ≈ 3 kB.
- [ ] **Does `window` re-aim the session?** **Recommended:** yes, like a file path. Otherwise `cmsis_action {action:'load_and_debug', window:B}` followed by `read_memory` would read window A. Alternative: strictly this call only.
- [ ] **Status bar in single-window setups.** **Recommended:** show it. It confirms the server runs and costs nothing. Alternative: show it only when two or more windows are registered.

## Tests and acceptance

- `src/test/routing.test.ts`:
  - The default target resolves a tie.
  - A dead default pid falls back to the folder.
  - Changing `setAt` drops a cached target but never the session pin.
  - A `window` pid or path routes the call and re-aims later path-less calls.
  - A `window` that matches nothing gives `INVALID_ARGUMENT` with candidates.
  - `window` never reaches the worker's arguments.
  - The `AMBIGUOUS_WINDOW` data carries `isDefault`.
- New `src/test/windowStatus.test.ts`: the pure renderer for router, worker, default and active states, and the tooltip session list.
- `test/transport/vscode-stub.js`: `window.createStatusBarItem` and `showQuickPick` stubs.
- `test/transport/two-window-routing.js`:
  - A written default resolves the "two idle windows" tie.
  - `cmsis_action {window}` lands in the named window.
  - `tools/list` on the routed server shows `window` on exactly the five tools.
- `test/transport/session-lifecycle.js`: the single-window list has no `window` parameter; the budget is unchanged.
- Live: two windows, pick one in the status bar, and an agent's `cmsis_action load_and_debug` runs there. Reload that window, and the default still applies.

## Out of scope and follow-ups

- A per-workspace default kept in `workspaceState`. The router runs in another window and cannot read it.
- Choosing the csolution target-type. That is `cmsis_action {target}`, unrelated to windows.
- Focusing or raising another VS Code window. There is no API for it.
- A panel that lists sessions; the router tooltip covers this for now.
- A `window` argument on the remaining path-less tools, if agents ask for it.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
