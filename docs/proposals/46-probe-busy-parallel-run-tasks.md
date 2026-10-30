# #46 Multithreading issue

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** Probe guards and task tracking are implemented; see [handler architecture](../architecture/debuggingHandler.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#46](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/46) |
| Area · priority · source | Build & flash (proposed) · High (proposed) · Internal test (christophe0606) |
| Original release plan | 2.3.11 (WP-B, together with #47 and #12; also the `flash` half of #45) |
| Size | M |
| Depends on | #11 (`ToolError` with `PROBE_BUSY`), #47 (`CmsisJobTracker`, `probeOwners()`) |
| Related | #45 (pyOCD called directly), #47, #12, #48 (maps the pyOCD wait line), #14, #3 |
| Original status | Proposed, awaiting review (2026-09-23) |

The task classifier and the job tracker are defined in [47-task-completion-detection.md](47-task-completion-detection.md#proposed-fix). This document adds the probe guard, the verified `stop_run`, the task state in `get_session_status`, and the pyOCD resolution for `flash`.

## Problem

"Waiting for a debug probe matching unique ID 'cmsisdap:' to be connected..." is printed by pyOCD's blocking probe search (`pyocd/core/helpers.py` in the pyOCD 0.45.1 bundled with CMSIS Debugger 1.8.0). pyOCD runs with `--probe cmsisdap:`, finds no free CMSIS-DAP probe, and waits forever. The usual holder is the CMSIS Run task: for pyOCD adapters that task is `pyocd gdbserver --persist --reset-run`, and it never ends. The report is confirmed in 2.3.10:

- `cmsis_action` guards only against a *debug session*. `load`, `erase` and `load_and_run` have no guard at all.
- `load_and_debug` starts a second pyOCD (its `preLaunchTask` "CMSIS Load", then the launch configuration's own `pyocd gdbserver`) while Run still holds the probe.
- `flash` spawns its own pyOCD with the same blind spot.
- After a timeout the text says to call the action again, which launches it again.
- `stop_run` returns before anything has stopped.
- None of this is visible to the agent: no tool reports the CMSIS tasks of the window.

What the sidebar showed as "several CMSIS Run tasks" is most likely "CMSIS Load+Run" plus its child "CMSIS Run". A compound task stays active as long as its child. The conflict itself needs a second pyOCD, which is what the guard below prevents. The spike in #47 reproduces the sequence and checks whether VS Code ever starts a second instance of the same label.

## Current state (2.3.10)

- **Guards.**
  - Session-only checks: before `load_and_debug` and `attach` ([debuggingHandler.ts:2023-2027](../../src/debuggingHandler.ts#L2023-L2027)), before a target switch ([:2056-2060](../../src/debuggingHandler.ts#L2056-L2060)), and in `flash` ([:1920-1923](../../src/debuggingHandler.ts#L1920-L1923)).
  - `load`, `erase` and `load_and_run` go straight to the command ([:2072-2135](../../src/debuggingHandler.ts#L2072-L2135)).
  - `vscode.tasks.taskExecutions` is not read anywhere in `src/`.
- **Retry.** The "still running" text asks for the same action again ([:2215-2220](../../src/debuggingHandler.ts#L2215-L2220)).
- **`stop_run`.** It is fire-and-return: "It runs in the CMSIS extension — check the CMSIS output channel" ([:2223-2225](../../src/debuggingHandler.ts#L2223-L2225)). The docs call it "Immediate" ([debug_instructions.md:106](../../docs/agent-resources/debug_instructions.md#L106)).
- **What `cmsisStopRun` does** in CMSIS Solution 1.70.1: it calls `terminate()`, without awaiting it, on every execution whose name starts with "CMSIS", stops a debug session that CMSIS started, and resets the panel state.
- **What `attach` needs.** The attach configurations of the pyOCD and J-Link templates have no `server`: they connect to the GDB port that CMSIS Run serves. `attach` therefore *requires* a live Run task. A guard that blocks every probe action while Run is alive would break the designed "Load+Run, then Attach" flow.
- **`get_session_status`** reports debug sessions only ([:2286-2336](../../src/debuggingHandler.ts#L2286-L2336)).
- **`flash` and pyOCD.**
  - `probePyocd` and `flashWithPyocd` spawn the literal `pyocd` from the extension host's PATH ([flashController.ts:89](../../src/core/flashController.ts#L89), [:125](../../src/core/flashController.ts#L125)).
  - The CMSIS Debugger adds `tools/pyocd` to PATH only through `environmentVariableCollection`, which reaches terminals and tasks (that is why "CMSIS Load" finds it) but not `process.env`. `flash` therefore fails on a clean machine even though a pyOCD is installed; this is the issue's "failed to resolve bundled pyOCD".
  - The failure text recommends `pip install pyocd` ([debuggingHandler.ts:1927-1930](../../src/debuggingHandler.ts#L1927-L1930)). The description and the docs say "needs pyocd on PATH" ([debugMCPServer.ts:953](../../src/debugMCPServer.ts#L953), [debug_instructions.md:112](../../docs/agent-resources/debug_instructions.md#L112)).
  - CMSIS Solution 1.70.1 also records the bundled pyOCD in `.cmsis/tools-environment.yml` (`tools: - name: pyOCD … directory: …/arm.vscode-cmsis-debugger-1.8.0-…/tools/pyocd`).

## Proposed fix

1. **Probe owners.** `CmsisJobTracker.probeOwners()` (#47) returns what holds, or is about to hold, the probe in this window:
   - live executions of kind `run`, `loadRun`, `load`, `erase` or `targetInfo`, with their start time;
   - the debug session, if any (`hasDebugSession()`, as today);
   - our own `flash` child process while it runs.
2. **Guard matrix**, checked right after the solution pre-check and before any target switch or command:

   | Action | Live Run or Load+Run | Load, Erase or `flash` in flight | Debug session |
   |---|---|---|---|
   | `build`, `status`, `detach`, `stop_run` | allowed | allowed | allowed (a target switch under a session stays refused) |
   | `load`, `erase`, `load_and_run` | refused (new) | refused, or attached when it is the same action (#12) | refused (new) |
   | `load_and_debug` | refused (new) | refused | refused (today) |
   | `attach` | allowed: attach connects to Run's GDB server | refused | refused (today) |
   | `flash` | refused (new) | refused | refused (today) |

3. **Refusal shape.** Refusals are `ToolError('PROBE_BUSY', hint)` (#11), and the message names the owner:

   ```text
   CMSIS 'load' on HP@debug not started: the 'CMSIS Run' task (started 3 min ago) holds the probe.
   Hint: cmsis_action {action:'stop_run'} first — or cmsis_action attach to debug the running firmware.
   ```

   The other hints are "stop_debugging first" (session) and "cmsis_action {action:'status'} waits for it" (a Load or Erase in flight). An `attach` with no Run alive and no session is still attempted, since the user may run a GDB server by hand. Its failure text gains "no CMSIS Run task is alive in this window — load_and_run first, or load_and_debug".
4. **Verified `stop_run`.**
   - Snapshot the live executions whose name starts with "CMSIS" (the set `cmsisStopRun` terminates).
   - Issue the command, then wait with `tracker.waitForEnd(snapshot, 3 s)`.
   - Call `terminate()` on any execution that is still alive, then wait until 10 s in total.
   - Results:
     - all ended: "stopped 'CMSIS Run' (ended after 0.6 s) and 'CMSIS Load+Run'; the probe is free";
     - nothing was alive: "nothing to stop: no CMSIS task is running in this window";
     - still alive after 10 s: `ToolError(PROBE_BUSY)`, hint "stop it with the trash icon in the Terminal panel, then call cmsis_action {action:'status'}".
5. **No relaunch to learn status.** A repeated `load`, `erase` or `load_and_run` attaches to its in-flight job, and `status` reports without launching anything (#12). This is the "never repeat a launch merely to obtain status" rule of the issue's workaround, enforced by the tool.
6. **Task state where agents look.** `get_session_status` gets one line from the tracker, for example `CMSIS tasks: 'CMSIS Run' alive 3 min (holds the probe); last load ✅ 4 min ago`. Its description does not change, so it costs nothing in `tools/list`.
7. **`flash` finds the bundled pyOCD** (this is the #45 link).
   - A new pure resolver in `src/core/flashController.ts` (or `src/core/pyocdResolver.ts`), `resolvePyocd({ debuggerExtensionPath, toolsEnvironmentYml, platform, pathEnv })`, tries in order:
     1. `vscode.extensions.getExtension('Arm.vscode-cmsis-debugger')?.extensionPath` + `tools/pyocd/pyocd`, or `pyocd.exe` on win32;
     2. the `pyOCD` entry's `directory` in the solution's `.cmsis/tools-environment.yml`, read line by line like the cbuild parsers (no YAML dependency);
     3. PATH.
   - `probePyocd(bin)` and `flashWithPyocd(file, ms, { bin })` take the resolved path. The result names it: "pyOCD 0.45.1 (CMSIS Debugger 1.8.0)".
   - The not-found text drops "pip install": "pyOCD not found: it ships with the CMSIS Debugger extension (Arm.vscode-cmsis-debugger) — install or enable it, or use cmsis_action load". It becomes a `ToolError`; the code follows #11's classifier, and `TOOL_DISABLED` is the closest fit.
   - The `flash` description changes "needs pyocd on PATH" to "uses the CMSIS Debugger's bundled pyOCD" and "Refuses while a debug session is active: …" to "Refuses while a debug session or CMSIS Run task holds the probe". That is −6 B in `tools/list`; #12 costs the rest of WP-B.
8. **Docs** (batched in WP-B's last commit):
   - `debug_instructions.md:106` and `:112`, and SKILL.md:
     - `stop_run` before `load`, `load_and_debug` or `flash`;
     - `attach` is for firmware started with `load_and_run`;
     - a `PROBE_BUSY` error names the step to take;
     - `flash` uses the bundled pyOCD, so never install one.
   - `embedded.md:18` (`pyocd list`) belongs to WP-D (#45 and #50).

## What changes for the agent and the user

```text
Before: load_and_run, then load_and_debug
  load_and_debug → "issued … poll get_session_status" → session never appears;
  the CMSIS Load terminal shows "Waiting for a debug probe matching unique ID 'cmsisdap:' to be connected..."
  agent retries → another pyOCD waits; the user finds two terminals and a blocked probe
After:
  load_and_debug → isError, PROBE_BUSY: "the 'CMSIS Run' task (started 2 min ago) holds the probe.
                   Hint: cmsis_action {action:'stop_run'} first — or cmsis_action attach …"
  stop_run       → "stopped 'CMSIS Run' (ended after 0.6 s) …; the probe is free"
  load_and_debug → session up
flash on a machine without a PATH pyOCD:
  before → "pyocd not found on PATH. Install it (pip install pyocd …)"
  after  → "✅ Flash succeeded — programmed 41984 bytes at 52 kB/s (pyOCD 0.45.1 from CMSIS Debugger 1.8.0: …)"
```

## Decisions for you

- [ ] **`attach` while Run is alive.** **Recommended:** allow it, because it is the designed Load+Run → Attach flow and the attach configuration has no server of its own. Alternative: refuse it like every other probe action; that is simpler, but the agent could then never debug firmware it started with `load_and_run`.
- [ ] **`stop_run` terminates leftovers itself.** **Recommended:** yes, after 3 s, on the snapshot taken before the command (only "CMSIS …" executions). Alternative: report only and leave termination to CMSIS Solution, which avoids acting on another extension's tasks but leaves a probe blocked when its command does nothing.
- [ ] **pyOCD resolution order.** **Recommended:** CMSIS Debugger extension, then `tools-environment.yml`, then PATH, which is the pyOCD the CMSIS tasks themselves use. Alternative: PATH first, which respects a user's own pyOCD but reproduces the version drift #45 complains about.
- [ ] **Scope of the guard.** **Recommended:** this window only in 2.3.11, since the tracker sees nothing else. Alternative: wait for a cross-window owner list in the registry heartbeat (#14 or WP-I), which covers two windows on one probe but delays the fix to 2.3.12.

## Tests and acceptance

- **Unit tests.**
  - `src/test/cmsisJobTracker.test.ts`: the guard matrix as a table test (action × owner → allowed, refused or attached), `stop_run` with an execution that ignores `terminate()`, and the `get_session_status` line.
  - `src/test/flashController.test.ts`: resolver cases (extension path on darwin, linux and win32 with `.exe`, a `tools-environment.yml` fixture, a PATH fallback, nothing found) and a `flashWithPyocd` command line that shows the resolved binary.
  - Paths are checked against macOS `/private/var` realpaths and Windows backslashes.
- **Transport test.** `session-lifecycle.js`: `flash` without a workspace still answers with a clear error and no `pip` text.
- **Live, probe board** (ULINKplus with pyOCD; Alif E8 with J-Link):
  - `load_and_run`, then `load` gives `PROBE_BUSY`; `attach` works;
  - `stop_run` reports "stopped"; `load_and_debug` then works;
  - `flash` uses the bundled pyOCD with nothing on PATH.
- **Live, FVP corstone-blinky.** `load_and_run`, then `load_and_debug` gives `PROBE_BUSY` (Run is the model); `stop_run` ends the model.

## Out of scope and follow-ups

- **Probes held outside this window.** Another VS Code window, a shell pyOCD or a JLinkGDBServer started by hand stay invisible to the guard. Follow-ups:
  - probe owners in the registry heartbeat (#14);
  - foreign-process detection (#50 "detection", Future);
  - #48 mapping "Waiting for a debug probe matching unique ID" to `PROBE_BUSY` where the line is readable: the GDB server started by a debug launch writes it to the debug console, which the DAP tracker already captures.
- **Probe selection in `flash`.** `flash` passes neither `--probe` nor `--uid`; with two probes attached pyOCD asks on stdin. Passing the cbuild-run's probe id is a separate improvement.
- **Agent rules.** The instruction and rule-file half of #45 is WP-D and WP-L (#50).

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
