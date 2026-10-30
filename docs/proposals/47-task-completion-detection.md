# #47 Completion detection

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** CMSIS task classification and job tracking are implemented; see [handler architecture](../architecture/debuggingHandler.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#47](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/47) |
| Area · priority · source | Build & flash · High (proposed) · Internal test (christophe0606) |
| Original release plan | 2.3.11 (WP-B, together with #46 and #12) |
| Size | M (WP-B as a whole: L) |
| Depends on | #11 (`ToolError`, `ToolReply`) |
| Related | #12, #46 (same work package; both build on the design in this document), #15, #48, #45 |
| Original status | Proposed, awaiting review (2026-09-23) |

This document holds the shared design of WP-B: the task classifier, the `CmsisJobTracker` and the job outcomes. [#12](12-long-builds-as-jobs.md) adds the long-wait cap and the `status` action on top of it; [#46](46-probe-busy-parallel-run-tasks.md) adds the probe guard, the verified `stop_run` and the pyOCD resolution for `flash`.

## Problem

`cmsis_action` waits for "a CMSIS task" to end, but it does not recognise the tasks the CMSIS Solution extension actually runs, and it does not know which execution belongs to the call. The report is confirmed in 2.3.10:

- `load`, `erase` and `load_and_run` never see their task. The filter lowercases only part of its input and the regex is case-sensitive, so "CMSIS Load" (source `Workspace`, type `shell`) does not match. The call waits the whole window, then says "no cbuild/flash task ran … usually means the active context is already up to date". That is false: the board was flashed long ago.
- Builds match only because the build label starts with a lowercase `cbuild` and the task type is `cmsis-csolution.build`.
- The waiter resolves on the first matching task end in the window, from any execution. A `cbuild setup` that the extension starts after a solution re-activation (our target switch does exactly that), or an earlier build that is still running, is reported as the result of this call.
- CMSIS Run never ends. It hosts the GDB server (`pyocd gdbserver --persist`, `JLinkGDBServerCL`, or the FVP model), so "wait until the task ends" cannot be the completion rule for `load_and_run`.

The issue's claim that Load's exit is reported as the end of the whole Load+Run is not what 2.3.10 does: Load is not recognised at all. It becomes true as soon as only the case bug is fixed, which is why the fix below binds to executions and phases, not to names alone.

## Current state (2.3.10)

- The waiter is [debuggingHandler.ts:2244-2284](../../src/debuggingHandler.ts#L2244-L2284). `isCmsisTask` at [:2263-2268](../../src/debuggingHandler.ts#L2263-L2268): `` `${name} ${source} ` + `${type}`.toLowerCase() `` lowercases only the second template literal, and `/cmsis|cbuild/` has no `i` flag.
- The waiter resolves on the first matching `onDidEndTaskProcess` of any execution ([:2278-2282](../../src/debuggingHandler.ts#L2278-L2282)). `startedTaskName` is recorded ([:2250](../../src/debuggingHandler.ts#L2250), [:2275](../../src/debuggingHandler.ts#L2275)) but never compared.
- It is armed at [:2093-2095](../../src/debuggingHandler.ts#L2093-L2095), after the solution query and the target switch ([:2048-2067](../../src/debuggingHandler.ts#L2048-L2067)). The switch deactivates and re-activates the solution ([:1835-1839](../../src/debuggingHandler.ts#L1835-L1839)). In CMSIS Solution 1.70.1 a convert that completes without errors then calls `requestCbuildSetup()`, which starts `cbuild setup`.
- The command is not awaited; it races a 4 s kick-off ([:2131-2135](../../src/debuggingHandler.ts#L2131-L2135)).
- Result texts:
  - The success line for `load_and_run`, "Firmware flashed and running (no debug session)", is asserted from a single task end ([:2185](../../src/debuggingHandler.ts#L2185), [:2189-2192](../../src/debuggingHandler.ts#L2189-L2192)).
  - The "no task ran … already up to date" text is at [:2205-2214](../../src/debuggingHandler.ts#L2205-L2214).
- `load_and_debug` and `attach` wait 8 s for a session, then probe twice for threads ([:2143-2173](../../src/debuggingHandler.ts#L2143-L2173), [:1871-1908](../../src/debuggingHandler.ts#L1871-L1908)). A slow multi-core start still has 0 threads at the second probe and is reported as "did NOT survive". This is step 3 of the issue's workaround.
- `vscode.tasks.taskExecutions` and `onDidStartTask` are used nowhere in `src/`.

What CMSIS Solution 1.70.1 does (read from `dist/extension.js` and `templates/debug/*.adapter.json` of the installed extension):

- **Load, Run, Load+Run, Erase are workspace tasks.** `getTasksFromWorkspace` keeps `fetchTasks()` entries with `source === "Workspace"` scoped to the solution's folder. `runCmsisTask` picks one by exact label and calls `vscode.tasks.executeTask`.
- **The command returns before the task starts.** The handler returns `undefined`. A missing label only shows the toast "Task 'CMSIS Load' not found"; the command does not throw.
- **The task labels come from the debugger adapter template.** They are written into `.vscode/tasks.json`:

  | Adapter template | CMSIS Load | CMSIS Run | CMSIS Load+Run | CMSIS Erase |
  |---|---|---|---|---|
  | CMSIS-DAP-pyOCD, STLink-pyOCD | shell `pyocd load` | shell `pyocd gdbserver --persist --reset-run` (never exits) | `dependsOn` Load, Run, `dependsOrder: sequence` | shell `pyocd erase --chip` |
  | JLink | shell, JLinkExe script | shell `JLinkGDBServerCL` (persistent) | compound, as above | shell, JLinkExe script |
  | FVP | shell `echo` (the model loads the images) | shell, the FVP model | compound, as above | none |
  | CMSIS-DAP-Arm-Debugger, STLink-Arm-Debugger | none | none | one task of type `arm-debugger.flash` | none |
  | uVision | none | none | one shell task (Windows only) | none |

- **Build.** The command runs `createAndExecuteTaskDefinition`, which:
  1. terminates a running `cbuild setup`;
  2. waits for every running `cmsis-csolution.build` execution to end (`waitForActiveBuildTasksCompletion`);
  3. saves dirty files, which can show a modal prompt;
  4. returns `vscode.tasks.executeTask(task)`, which is a `TaskExecution`.

  The task has type `cmsis-csolution.build`, label `cbuild <args…>` and a `CustomExecution` pseudoterminal. The setup run is the same type with `setup: true` and label `cbuild setup …`.
- **Stop Run.** `cmsisStopRun` calls `stopCmsisTask("CMSIS")`, which calls `terminate()`, without awaiting it, on every execution whose name starts with "CMSIS". It stops the tracked debug session and resets the panel state.
- **The extension's own state machine.** It uses the rule proposed below: `executionState = "running"` once Load exited 0 and Run's process started.

## Proposed fix

### Step 0: live spike (half a day)

Record `onDidStartTask`, `onDidStartTaskProcess`, `onDidEndTaskProcess`, `onDidEndTask` and `taskExecutions`: name, `source`, `definition.type`, `definition.setup`, exit code and timestamps. Record them for `build`, `load`, `erase`, `load_and_run`, `load_and_debug` and `stop_run`, on the corstone-blinky FVP and on one probe board (ULINKplus with pyOCD, Alif E8 with J-Link).

Confirm these five points; the design below assumes them:

1. For the compound Load+Run, which start and end events fire for the parent, and whether a Load failure stops the sequence.
2. Whether `executeCommand('cmsis-csolution.build')` resolves to the `TaskExecution` object.
3. What a second `executeTask` of an active "CMSIS Run" does: prompt, or a second instance.
4. When `cbuild setup` fires after `activateSolution`.
5. What the single `arm-debugger.flash` task does.

Save the sequences as fixtures under `src/test/fixtures/cmsisTasks/`.

### Step 1: `src/core/cmsisTasks.ts` (pure, no `vscode` import)

- `interface TaskFacts { name: string; source: string; type?: string; setup?: boolean }`.
- `classifyCmsisTask(f): CmsisTaskKind | undefined` returns `'build' | 'setup' | 'load' | 'run' | 'loadRun' | 'erase' | 'targetInfo'`:
  - type `cmsis-csolution.build`: `setup` when `setup === true`, else `build`;
  - source `Workspace` and an exact CMSIS label (`CMSIS Load`, `CMSIS Run`, `CMSIS Load+Run`, `CMSIS Erase`, `CMSIS TargetInfo`): the matching kind. These are the same strings CMSIS Solution matches;
  - type `arm-debugger.flash` named `CMSIS Load+Run`: `loadRun`.

  A case-insensitive label match is only a logged fallback. There is no regex over a concatenated haystack.
- `ACTION_PHASES`: what each action waits for. The table is in [step 3](#step-3-outcomes-per-action).
- `reduceJob(job, event): Job`: a pure state machine, `armed → started → ok | failed | cancelled | running-ok`, plus `not-started` when the deadline passes. Unit-tested against the spike fixtures.

### Step 2: `src/cmsisJobTracker.ts` (one per window)

`registerCmsisJobTracker(context)` in `extension.ts`, next to `registerSessionStateTracker`. It is a module singleton because two `DebuggingHandler`s exist ([debugMCPServer.ts:234](../../src/debugMCPServer.ts#L234), [windowCoordinator.ts:101](../../src/windowCoordinator.ts#L101)) and must share one set of listeners.

- **Live table.** It subscribes once to the four task events, seeds itself from `vscode.tasks.taskExecutions`, and keeps `live: Map<TaskExecution, { kind, name, startedAt, processStarted }>`. Tasks the user starts from the panel are seen too.
- **Correlation.**
  - `begin(action, target)` arms a job before the command is issued.
  - Executions that were alive before `begin` never complete the job.
  - The job binds to the first execution of an expected kind that starts after `begin`. For `build` it binds by identity to the `TaskExecution` the command returns, if the spike confirms the command returns one.
  - Setup runs and other executions are recorded as notes ("a cbuild setup ran meanwhile"); they are never the result.
- **API.**
  - `begin`;
  - `waitFor(job, deadline)`, bounded by the call's deadline (#12);
  - `inFlight(action?)`;
  - `last(action)`: the finished job, kept 10 min;
  - `probeOwners()`, used by #46;
  - `waitForEnd(filter, ms)`, used by `stop_run`;
  - `onDidFinishJob`, used by #15 and #48.
- **Job record.** `{ id, action, target, executions[{name, kind, startedAt, endedAt, exitCode}], state, notes[] }`. It is kept in memory only; it does not survive a window reload.

### Step 3: outcomes per action

| Action | Done when | Result |
|---|---|---|
| `build` | the bound `build` execution's process ends | exit 0: ✅; ≠ 0: `ToolError(TASK_FAILED)` with the exit code (error lines: #15); no exit code: `TASK_FAILED` "ended without exit code (cancelled?)" |
| `load`, `erase` | the bound Load or Erase ends | as for `build`; on ❌ the hint names `flash`, which returns pyOCD's own error lines |
| `load_and_run`, compound (pyOCD, J-Link, FVP) | Load ended 0 **and** Run's process started and is still alive 2 s later | ✅ "flashed; CMSIS Run task started and stays active (it hosts the GDB server) — attach to debug, stop_run to free the probe". Load ≠ 0: ❌ with Load's code. Run ended within the grace: ❌ with Run's code. |
| `load_and_run`, single task (Arm Debugger, uVision) | that task ends | exit code as for `build` |
| `load_and_debug` | the `preLaunchTask` "CMSIS Load" ended (pyOCD and J-Link templates; FVP and Arm Debugger have none), then the session check | the Load exit code and duration are part of the result; a failed Load is `TASK_FAILED` before any session probe |
| any | nothing expected starts within 10 s after the command settled or the kick-off ended | label missing from `tasks.json`: `ToolError(INVALID_ARGUMENT)` "this debugger adapter has no 'CMSIS Load' task (Arm Debugger adapters offer only load_and_run and load_and_debug)"; otherwise `TASK_FAILED` "nothing started: the CMSIS panel may be showing a picker or a save prompt" |
| any | the deadline passes first | `ToolReply` with status `running` and the job in `data`; see #12 |

- **Label pre-check.** `fetchTasks()` runs before `load`, `erase` and `load_and_run`, with a 3 s timeout, cached until `.vscode/tasks.json` changes. Missing labels are caught before anything is issued.
- **Wrong hypothesis removed.** The "already up to date" text goes: cbuild runs even when nothing changed, so "no task started" never means "nothing to build".
- **`load_and_debug` readiness.** When the session object still exists at the second probe but reports 0 threads, the result becomes `status: 'running'`: "session up, target not yet reporting threads — poll get_session_status". "Did not survive" is reserved for a session object that is gone. The probe starts only after the tracked Load has ended.

### Step 4: wiring and budget

- `waitForCmsisTaskResult` and `isCmsisTask` are deleted; `handleCmsisCommand` uses the tracker. Every result line keeps naming the target and adds the task name, the exit code and the duration.
- This step adds no bytes to `tools/list`. The enum value `status` and the description change are costed in #12.
- Docs: `docs/architecture/debuggingHandler.md` gets a "CMSIS jobs" section; the `build` topic of `debug_instructions.md` and SKILL.md describe the job outcomes. That doc work is batched in #12's last commit.

## What changes for the agent and the user

```text
Before (2.3.10), load on a pyOCD board, flashing done after 9 s:
  … 57 s later …
  CMSIS 'load' on HP@debug issued via 'cmsis-csolution.cmsisLoad', but no cbuild/flash task ran within the
  wait window. This usually means the active context is already up to date …

After:
  ✅ CMSIS 'load' succeeded on HP@debug (task 'CMSIS Load' exited 0 after 9 s). Use cmsis_action attach
  or load_and_debug to start a debug session.

After, load_and_run:
  ✅ CMSIS 'load_and_run' on HP@debug: flashed ('CMSIS Load' exited 0 after 9 s); 'CMSIS Run' started and
  stays active — it hosts the GDB server. cmsis_action attach to debug; cmsis_action stop_run frees the probe.
```

For the user, the CMSIS panel behaves as before. Only the reports change.

## Decisions for you

- [ ] **Completion rule for compound Load+Run.** **Recommended:** Load exit 0, plus Run's process start, plus 2 s alive; this is the rule CMSIS Solution itself uses for its panel state. Alternative: wait until the GDB port from the attach configuration accepts a connection. That is stronger, but adapter-specific, and it opens a socket on the probe's server.
- [ ] **Build binding.** **Recommended:** bind by identity to the `TaskExecution` the build command returns, with "first build execution started after `begin`" as the fallback. Alternative: name and time only, which is simpler but depends on nobody else starting a build in the window.
- [ ] **Label pre-check through `fetchTasks()`.** **Recommended:** yes, with a 3 s timeout and a cache keyed to the `tasks.json` mtime; it turns a 10 s "nothing started" into an immediate `INVALID_ARGUMENT` on Arm Debugger adapters. Alternative: no pre-check (saves one `fetchTasks` per call).
- [ ] **`load_and_debug` 0-thread false negative.** **Recommended:** fix it here, since it is the same completion question and the same code path. Alternative: split it into its own issue and keep WP-B to tasks.

## Tests and acceptance

- **Unit tests.**
  - `src/test/cmsisTasks.test.ts`: the classifier table, including the regressions: name "CMSIS Load" with source `Workspace` and type `shell` is `load`; "cbuild setup …" with `setup: true` is `setup`, never `build`.
  - The same file: the `reduceJob` state machine replayed over the spike fixtures (build ok, build failed, build with a setup running, load ok, pyOCD Load+Run, Arm Debugger Load+Run, stop_run).
  - `src/test/cmsisJobTracker.test.ts`: correlation (a pre-existing execution never completes a job), the 10 min retention, and the deadline.
- **Stub.** `test/transport/vscode-stub.js` gains `tasks.onDidStartTask`, `onDidStartTaskProcess`, `onDidEndTaskProcess`, `onDidEndTask`, `taskExecutions`, `executeTask` and `fetchTasks` emitters.
- **Transport test.** `session-lifecycle.js`: `cmsis_action {action:'status'}` without a solution answers ok with "no CMSIS job in this window".
- **Live, FVP corstone-blinky.** `load_and_run` reports Run started within a few seconds; `build` right after a target switch reports the build, not the setup run.
- **Live, probe board** (ULINKplus with pyOCD, Alif E8 with J-Link):
  - `load` reports exit 0 within seconds of the flash finishing;
  - `load_and_run` reports "Run started";
  - `load` on an Arm Debugger adapter is refused at once with `INVALID_ARGUMENT`.

## Out of scope and follow-ups

- **Reading task output.** The terminals are not readable through the API; the error lines come from #15.
- **Other claims in the workaround.** `continue_execution` pausing on timeout and `reset(halt=false)` without a frame ID were not verified here. Triage them under #13 and #20.
- **Cross-window task visibility.** The tracker sees only its own window. A registry heartbeat that carries probe owners belongs with #14 and WP-I; see #46.
- **Journal records.** Task-end records for the problem journal come from `onDidFinishJob` once #48 lands.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
