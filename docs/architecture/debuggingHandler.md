# DebuggingHandler

`DebuggingHandler` (`src/debuggingHandler.ts`, with helper modules in
`src/handler/`) decides what an agent is told. Every debugging tool has one
`handle*` method. The method checks the state of the debug session, asks the
executor — and, for `cmsis_action`, `cmsis_query` and `flash`, the CMSIS
Solution extension or pyOCD — and answers with one text: what happened, the state that
resulted, and the next useful call when something stands in the way. A
failure is not an answer but a rejection with an error code (#11).

## Why a layer of its own

- The MCP layer stays a table of tool registrations (`src/debugTools.ts`)
  with no behaviour of its own.
- The executor (`src/debuggingExecutor.ts`) stays with VS Code and DAP
  mechanics: it returns data and throws when a request fails.
- Refusals, hints, state renderings and recovery reports are decided in one
  place, which can be tested against a scripted executor without a debug
  adapter.

## The contract

`IDebuggingHandler` has one method per debugging tool. Each takes the tool's
parsed arguments and resolves to a `ToolText` — a string, or a `ToolReply`
whose status says a wait ran out (`timeout`) or the work goes on
(`running`) — or rejects with a `ToolError` that carries an `ErrorCode`, the
message and, where there is one, the next step as `hint`
(`src/core/toolResult.ts`). The method names are also the op
names that cross window boundaries: the router forwards a call by name, and
the `ControlServer` of the target window invokes the method of that name with
`args ?? {}`. `src/core/opTable.ts` checks at compile time that its
`DEBUG_OPS` list and the interface name the same methods, so a new tool
cannot be left out of the routing (see [windowRouting.md](windowRouting.md)).

## How a call ends

| Tools | Failure | Too slow |
| ----- | ------- | -------- |
| Variables and expressions, memory, registers, cycle counter, peripherals, fault tools, SVD lookups, call stack and threads | rejected with the body's `ToolError`; a plain error gets a code from `classifyError()` | rejected with `TIMEOUT`: a read that returned nothing has failed |
| `reset`, `wait_for_stop`, `cmsis_action`, `flash` | as above | answered with status `timeout` and the notice that the call did not complete within its limit |
| `cmsis_query` | as above | answered with status `running`: the extension is still filling its catalog from Arm's web service, and the same call again finds it (`FenceOptions.capStatus`) |
| Session start, stop and restart, steps and continue, breakpoints and logpoints, `get_device_info`, `check_target_connection` | rejected as `<what failed>: <cause>` by `wrapError()`, which keeps the cause's code and hint; a `Refusal` passes as it is | bounded by the executor's request deadlines and by the stop and session waits below; the configuration picker of `start_debugging` fails with `INVALID_ARGUMENT` after its limit, and `stop_debugging` answers with status `timeout` after 10 s (#14). What stays unbounded here, the window's fence answers (see [windowRouting.md](windowRouting.md#fences-and-health-checks)) |

The cause reads as its message: a plain `Error` loses the `Error:` prefix and
following space its string form would add, while a named class such as
`HardwareTimeoutError` keeps its name, which says what happened. A
`Refusal` (`src/core/toolResult.ts`) is a refusal that already names the
operation, the reason and the next step — the state gate, "nothing to
restart", a breakpoint change the session state rules out — so
`wrapError()` hands it on unchanged instead of prefixing it a second time.

The first two groups run inside `fenced()` (`src/handler/fence.ts`); its
`onCap` argument says which answer the cap gives. The limit is the call's
`timeoutMs`, at most 60 s, or 30 s when none is given. `cmsis_action` and
`flash` may wait up to 600 s (#12); they default to 60 s and count one
deadline from the call, so they answer before their fence, which stays as a
backstop with advice of its own. The timer starts before the work; when it
fires, the work keeps running, since a DAP request cannot be withdrawn, and
whatever it produces later, a rejection included, is dropped.

Refusals reject too: a second `start_debugging` while a session exists, or
`flash` while a session or a CMSIS task holds the probe, is `PROBE_BUSY`
with the step that frees the probe in the hint. `pause_execution` on a
halted target is an answer, since there is
nothing to do; it is neither fenced nor wrapped, so its refusals keep their
own text and code (`PROBE_WEDGED` for an unresponsive probe, built by
`stoppedTargetRefusal()` like every gate's, `NO_SESSION` while the session
starts or after it ended). On an unresponsive session it is the one call
that is not refused at once: a threads probe that timed out can be a GDB
busy with a running target, which a pause brings back, so
`pauseUnresponsive()` sends one pause with a 5 s deadline and answers
`PROBE_WEDGED` only when that does not stop the target. `get_session_status` and
`check_target_connection` never reject for the state they report:
`check_target_connection` answers a hardware timeout as text.

## State gates

Most reads need a halted target. `requireStoppedTarget()` asks the executor
whether a session exists, answers its `threads` probe and is stopped
(`hasActiveSession()`). If not, it throws the `Refusal` that
`stoppedTargetRefusal()` (`src/handler/sessionText.ts`) builds for the
current state: `NO_SESSION` for `no-session` and `initializing`,
`TARGET_RUNNING` for `running`, `PROBE_WEDGED` for `unresponsive` (#3), each
with the next action for that state as its hint: `cmsis_action
load_and_debug` (or `start_debugging` outside CMSIS projects) without a
session; `pause_execution`, or a breakpoint and `wait_for_stop`, while the
target runs (#20); and for `unresponsive` the way to reconnect for the
session's `request`, as for a failed read. The SVD lookups are not gated, and
the breakpoint tools do not refuse a running target (see below). `get_session_status` never fails: it reports the state, the
session's identity, the probe round trip and a hint for each state
(`renderSessionStatus()`).

## Moving the target and waiting for the stop

Steps, `continue_execution` and `pause_execution` go through
`sendAndAwaitStop()`. It arms the executor's stop waiter, which listens for
the DAP `stopped` event of the session, *before* the request goes out, then
waits for that event, the end of the session, or the limit: the call's
`timeoutMs` or the configured `timeoutInSeconds`, capped at 60 s either way.
VS Code's stack-item events never end a wait, because they also fire when
the item is cleared on resume. The state is read only after a stop: a
target whose wait ran out may still run, and a `stackTrace` to a running
target holds the call for the whole DAP request deadline, which made every
continue that ended `running` 10 s slower and pushed short ones past the
window's fence.

What a wait that runs out means depends on the request (`MotionSpec.onWaitOut`).
A step should have stopped, so `locateRunawayTarget()` pauses the target and
reports where it is — PC, LR, function and source line, then the compact
state read after that stop, behind the overrun line — so the agent learns
whether the firmware sits in a loop, an ISR or a fault handler before it sets
more breakpoints; that answer has status `timeout`, as has a pause that sees
no stop in time. A continue is meant to run: the target is left running, and
the answer has status `running`, gives the wait it really had and names
`wait_for_stop` and `pause_execution`. Halting a target the agent asked to
run would change what it was waiting to observe. Every timeout text gives
the wait the call had, not the `timeoutInSeconds` setting.
`wait_for_stop` sends nothing: it waits for the next stop, or returns at
once when the target is already halted. A wait that runs out answers with
status `timeout`. A session that ends meanwhile rejects with `NO_SESSION`,
in a step or continue as in `pause_execution` and `wait_for_stop`, with the
calls that confirm it and start a new session as the hint.

An Arm FVP's GDB server ignores GDB's interrupt while the model runs; only a
breakpoint stops it. `isFvpSession()` (`src/core/gdbServerPorts.ts`) tells
such a session from its configuration, and the replies that would advise a
pause say so instead (`FVP_*` in `src/handler/sessionText.ts`): a pause that
sees no stop, a continue that keeps running, a breakpoint change the model
did not stop for (`TARGET_RUNNING`), a stop the adapter holds while it waits
for a halt (stop again), a session that came up through `cmsis_action`
(set breakpoints first), the `running` refusal of the gates and the
`running` hint of `get_session_status`, and a `wait_for_stop` that runs
out. A step that does not stop sends no recovery pause there
(`locateRunawayTarget()` is skipped), since the model would ignore it too.

Before it reads anything after a stop, the handler waits for the frame VS
Code selects for it (`frameSelected()`), at most 2 s and never past the
call's own limit: the state, registers and variables go through VS Code's
focused frame, and VS Code selects one only after it has fetched the stop's
threads and stack, which over a probe with an RTOS comes after a read that
starts with the `stopped` event. The focus watch is taken before the
request, so a frame VS Code still holds from before it does not count. When
the wait runs out, the answer says so in one line instead of showing an
empty state. `wait_for_stop` waits the same way after a stop event, not for
a target that was stopped before the call. A session that comes up during
the call — `start_debugging`, and the session phases of `cmsis_action`
`load_and_debug` and `attach` — is read the same way (`stateAfterStart()`
in `src/handler/cmsisAction.ts`): the watch (`watchStartFocus()`) is taken
before the start, so a frame of an earlier session does not count; once
the session is live and stopped it waits for a frame of that session,
bounded the same way by what is left of the call, and a target that runs
is read at once. `restart_debugging` reads no state, so it does not wait.

After a stop the handler takes a `DebugState` from the executor and returns
its compact form. `compactState()` includes the breakpoint list only when it
differs from the list the agent saw last; `fullState()`, used after a session
start or a `cmsis_action` attach, shows everything. See
[debugState.md](debugState.md).

## Starting and stopping

`handleStartDebugging()` refuses while a session exists. With a
`configurationName` it starts that `launch.json` entry by name through the
executor; a CMSIS Debugger launch whose GDB server has a fixed local port
reserves it atomically before checking for another window or listener
(`reserveGdbPortForStart()`, see [GDB ports](windowRouting.md#gdb-ports)). A
confirmed failed start releases the reservation; a session that is still
starting keeps it beyond the tool's wait. Without a name it lets the user choose through
`promptForConfiguration()`, and the entry `Default Configuration` gets a
configuration synthesized from the source file (see
[debugConfigurationManager.md](debugConfigurationManager.md)). The picker
waits for a person in a window the agent may not see, so
`chooseConfiguration()` bounds it (#14): a cancellation token fires after
the call's `timeoutMs`, 30 s without one and 60 s at most, on the host's
clock. The picker then closes and rejects with `PickerCancelled`, and the
call fails with `INVALID_ARGUMENT`, its hint naming the `launch.json`
entries to pass as `configurationName`. It then polls
the session state with exponential backoff (`awaitLiveSession()`) until the
target runs or stops, and answers with the full state; a failed start
carries what the adapter and the GDB server reported during the call, as
problem records (see [The problem journal](#the-problem-journal)).
`handleStopDebugging()` waits at most 10 s for VS Code to end the session
(`settlesWithin()`, #14): a stop that has not settled by then, while the
session is still listed, answers with status `timeout` and points to
`get_session_status`. The first successful stop of each MCP session
adds a root-cause check (`withRootCauseCheck()`): a reminder to explain
the bug, not only where it showed, before the investigation is closed.
Only once, since a stop also ends sessions in the middle of an
investigation; its way to run the program again is `cmsis_action
load_and_debug` on a CMSIS Debugger session, `start_debugging` elsewhere. `handleRestart()`
pauses a running CMSIS Debugger target first, so the adapter lets go of a
halted core, and then has the executor stop the session and start its
launch configuration again; the answer says so, names the configuration's
`preLaunchTask` and counts the GDB logpoints that ended with the old
session.

## Breakpoints and logpoints

A breakpoint lives in VS Code's breakpoint model on every adapter, its
condition included; VS Code sends it to the adapter, and the answer reports
how the adapter bound it (`breakpointBinding()`: verified — on the CMSIS
Debugger with GDB's breakpoint number and the line it moved to — or not,
with the adapter's reason), waiting at most 2 s for the adapter.
`list_breakpoints` shows the same for every breakpoint. A condition is
evaluated by GDB at every hit, which halts the core each time; the session
stops only when it holds. The deprecated `lineContent` argument still works
and sets a breakpoint on every line that contains the text.

VS Code adds a breakpoint the adapter announces as new (a `breakpoint`
event with reason `new` and a source line: a GDB `break` in the launch
configuration's `initCommands`, or typed in the Debug Console) to its own
model without telling extensions: `vscode.debug.breakpoints` lists it only
after a window reload, yet VS Code saves it and sends it to the next
session. A live test listed "The breakpoint list is empty." while the
workspace held five such breakpoints and the next session stopped at one.
The session tracker therefore keeps the breakpoints it saw announced, for
the window, and forgets one when its adapter announces its removal
(`adoptedBreakpointsOf()`); `list_breakpoints` lists those the API does not
show apart, saying that only VS Code's Breakpoints view removes them, and
`clear_all_breakpoints` says they stay (`unlistedAdopted()`). A removal in
that view is not seen, so the list may keep one until the window reloads.

On the CMSIS Debugger a logpoint is a GDB `dprintf` (#56), because
cdt-gdb-adapter prints a VS Code logpoint's message without filling in the
values. `translateLogMessage()` (`src/handler/gdbText.ts`) derives the format
string and arguments from the `{expr}` and `{expr:%fmt}` message syntax; the
executor sends MI `-dprintf-insert` at the file's path relative to its
workspace folder (a location that does not name the absolute path, so the
adapter's sync of VS Code's breakpoints for that file leaves the dprintf
alone), then `condition <n>` for a condition — a condition GDB refuses takes
the dprintf back out. The number from the MI result is remembered for the
session: `remove_breakpoint` and `clear_all_breakpoints` delete by number,
never with a bare `delete`, and `list_breakpoints` shows each logpoint with
its hit count from `-break-list`, forgetting one GDB no longer has. A VS
Code logpoint set at that line before the session is replaced. Other
adapters, and a logpoint set without a session, use a VS Code logpoint.
`classifyGdbReply()` sorts GDB's replies into done, running, rejected and
failed, and `gdbRefusal()` turns a refusal into `TARGET_RUNNING`,
`INVALID_ARGUMENT` or `INTERNAL`.

A breakpoint change on a running CMSIS Debugger target pauses the target,
applies the change and resumes it, also when the change fails
(`withTargetHalted()`, #13); the answer says for how long the target was
paused. The change is refused while the session initialises (`NO_SESSION`),
when the probe hangs (`TIMEOUT`) or when the pause does not stop the target
within 5 s (`TIMEOUT`; `TARGET_RUNNING` on an Arm FVP, which never stops for
it). Other adapters take breakpoint changes while their target runs.

## Reading the target

- Variables and expressions use the frame VS Code has focused
  (`focusedFrame()`, `focusedScopes()`); a request for `global` falls back to
  all scopes when the adapter reports no global scope. The frame is asked
  for only after the state gate passed, so when none is focused the stop has
  not reached VS Code yet, a thread rather than a frame is focused, focus is
  on another session, or the target resumed without the adapter saying so:
  a `TARGET_RUNNING` refusal whose hint is `wait_for_stop` or
  `pause_execution`. `src/core/variableView.ts` renders them, with caps unless the
  agent names the variables it wants. A scope the executor left unread (the
  CMSIS Debugger's Registers) is named in one line that points to
  `read_core_registers`; a read by name shows it only when a name was not
  found.
- An expression whose value has children — a struct, an array, a pointer —
  lists them under its `Result:` as `Fields:`, one level unless the call
  asks for `depth` 2 or 3. An agent that gets only `{...}` reads the fields
  one call at a time, so one `variables` request per level saves many round
  trips. `expandFields()` in `src/core/variableView.ts` fetches them through
  the executor, at most 32 per level and 16 requests in all, cuts long
  values, and redacts each field by its name and value; a withheld field, or
  one whose name is a credential name, is never opened.
- Variable and expression values that look like credentials are withheld
  while `redactSecrets` is on (read on every call; `src/utils/secretRedaction.ts`).
  Raw target reads — memory, core registers, peripherals, fault status — and
  GDB commands (`-exec …` or `>…`) are never redacted: real SVDs name
  registers `KEY` or `UNLOCK`. On the CMSIS Debugger the executor sends such
  a command in the adapter's `>` prefix and returns the text GDB printed.
- `read_memory` takes a hex address or a C expression for one, as the
  guide itself writes it (`&adc_buffer`): anything that is not hex digits
  is evaluated as `(unsigned long)(expression)` in the focused frame
  (`addressOfExpression()`), and the dump names both. Before, the executor
  put `0x` in front of the expression and the read failed inside the
  adapter (a Kimi Code session hit it). An expression GDB cannot place is
  refused with `INVALID_ARGUMENT` and GDB's words. GDB would carry out an
  assignment, `++`, a function call or a string literal it copies into
  target memory, so `sideEffectOf()` refuses those before GDB sees the
  expression: `read_memory` only reads. A literal is `0x` and hex digits,
  or hex digits that start with a decimal one; `face` is the symbol of that
  name, and its refusal says to write `0xface` for the address.
- The memory dump, the core-register table and the cycle-counter text come
  from `src/handler/targetText.ts`. A dump labels its rows from the first
  byte the read returned and, when part of the range could not be read,
  says how much was read and which part was not. A register the GDB
  server's target description lacks comes back from GDB as `void` (the Arm
  FVP has no msp, psp, control or masks); the table says it is not
  reported, and in Handler mode it shows the SP as the MSP, which
  `diagnose_fault` then uses for a frame on the MSP (`mspFromHandlerSp()`).
- `diagnose_fault` combines the decoded fault registers, the stacked
  exception frame chosen by `EXC_RETURN`, the top of the call stack and the
  SVD's view of the faulting address into one report with ranked hypotheses
  (`src/core/faultTriage.ts`). Clear fault status while a fault handler is
  active (IPSR 3–7) is not reported as "not in a fault": the handler may
  have cleared it, or the debug server may not report it. With TrustZone,
  `EXC_RETURN` can put the frame on the stack of the Security state the
  core is not in, and the integrity signature and R4–R11 below the stacked
  R0 (`selectExceptionFrame()`). The
  other state's banked stack pointers are read only for such a frame
  (`bankedStackRegisters()`); a server that does not report them gets a note,
  never a frame read from the current state's MSP or PSP. Each read after the
  fault registers turns into a note when it fails, instead of failing the
  call — except a wedged probe:
  `get_fault_info` and `diagnose_fault` answer the executor's `PROBE_WEDGED`
  itself rather than a diagnosis built on registers that were not read (#3).
  Both read DHCSR once more (`probeDebugPort()`) and add a lockup note when
  `S_LOCKUP` is set. `read_core_registers` reads DHCSR only when a register
  could not be read, and then says whether the core answers; the stopped hint of
  `get_session_status` names a DHCSR read that got no answer, which the
  executor's status carries.
- `lookup_peripheral` and `lookup_register` answer from the device SVD
  (`src/core/svdParser.ts`, `src/core/svdLookup.ts`) without a session.
  During one, they and `diagnose_fault` take the SVD of the session the
  executor acts on (`getActiveSession()`), focused or not, so they agree
  with `read_peripheral_register`: the tool's `svdFile` when given, else
  that session's launch `svdFile`, then its cbuild-run file, then the
  workspace's. A launch `svdFile` describes the session's own core, so a
  lookup that names a core with `pname` skips it and takes that core's
  entry of the cbuild-run file. A cbuild-run file names its SVD under
  `${CMSIS_PACK_ROOT}` or relative to its own folder, as csolution writes
  it.

## CMSIS actions and flashing

`src/handler/cmsisAction.ts` runs `cmsis_action`. Each action maps to a
command of the CMSIS Solution extension (`cmsis-csolution.build`,
`cmsis-csolution.cmsisLoadAndDebug` and so on). Those commands return before
their work is done, so the outcome is observed separately, through the
window's CMSIS job tracker (next section):

- `build`, `load`, `erase`, `run` and `load_and_run` arm a job, issue the
  command and wait for the job: a ✅ line with the task, its exit code, how
  long it ran and the job id, or a ❌ line rejected as `TASK_FAILED`. `run`
  (#73) starts the adapter's `CMSIS Run` task alone, job id `g-<n>`; its
  result says what the task did to the target, because the adapters differ:
  the pyOCD task resets and runs, the J-Link task leaves the core as it was,
  and the FVP task starts the model with the last-built image and hosts no
  GDB server, so `attach` has nothing to reach there. `rebuild` and `clean`
  (CMSIS Solution 1.72.0's Rebuild and Clean, the build task type with
  `--rebuild` or `--clean`) are jobs of their own, `rb-<n>` and `c-<n>`. A
  build, rebuild or clean while another of the three is in flight is
  refused: CMSIS Solution would start it only after that one ended, too late
  for the job's not-started window.
- `load_and_debug` waits for its pre-launch `CMSIS Load` when the launch
  configuration has one (a failed Load is the answer, before any session
  probe); then it and `attach` wait for a live session and probe its threads
  twice (`probeSchedule()`). The CMSIS Solution command returns before the
  session is up, so the wait sees GDB connect: until the adapter takes
  requests the session is `initializing`, not live. A session still
  connecting when the wait runs out, or one without threads yet, is
  answered with status `running`; `TASK_FAILED` is kept for a session that
  is gone, and one that ends before it came up ends the wait at once, where
  a start or a restart waits on (`awaitLiveSession()`). The wait polls at
  growing gaps and can miss a session that starts and fails between two
  polls, so a wait that saw none reads the journal from the call's start:
  an error of the debug adapter or the GDB server in this call — while a
  session is still there, only a refused launch or attach request — makes
  it `TASK_FAILED`, with those records listed (`startFailed()`). Without
  one it stays `running`, since a slow multi-core flash may still be on
  its way.
- `attach` connects to a GDB server it does not start, so before the
  command it checks only what the window knows
  (`refuseAttachToBareModel()`, `src/core/gdbServerPorts.ts`): while the
  window's CMSIS Run task is an FVP model without its GDB server plugin —
  the task's command line says so, or, for a model shim, the target's
  `Arm-FVP` debugger — nothing the window started serves the attach
  configurations' ports, and the call is refused with `load_and_debug` as
  the way. It never connects to such a port to find out: a GDB server takes
  any connection as a client (pyOCD halts the target for it, resumes it
  afterwards and, without `--persist`, shuts down; a J-Link server started
  with `-singlerun` closes with its last client). With no CMSIS Run alive
  the attach goes ahead, since a server started outside the window may
  listen, and GDB's own connect decides; a reply still `running` then says
  what happens when none does.
- `status` launches nothing and needs no solution: it waits for the job in
  flight, or lists the recent results and the live CMSIS tasks, with the
  error lines of a failed build once they are in. A Load or Erase task alive
  for `LONG_FLASH_MS` (2 min, `src/handler/jobText.ts`) is stuck, not
  programming: pyOCD waits without a limit for a probe it cannot see or that
  another holds, and says so only in its terminal, which no tool reads.
  `status` then answers at once, and its reply, the `running` reply of the
  action and the task line of `get_session_status` say that the task is
  stuck, give the probe causes and name `stop_run`, which ends it; `data.job`
  carries `stuck: true`.
- `stop_run` waits until the CMSIS tasks it stops have ended, terminates
  leftovers itself after 3 s, and answers `PROBE_BUSY` for a task still
  alive after 10 s of verification. A caller's shorter deadline returns
  `running`, with the stop still pending: it neither spends the owner's
  grace early nor mistakes a short observation for failed termination.
  The reply points to `status` and a longer stop call if needed. Builds are
  not its tasks, but CMSIS Solution's Stop Running can end one: the reply
  names a build that ended during the wait
  and one that runs on, which `stop_build` ends. `detach` returns at once.
- `stop_build` does the same for the build-type tasks of the window (build,
  rebuild, clean, or the `cbuild setup` CMSIS Solution runs after loading a
  solution), over `cmsis-csolution.stopBuild`, which ends only one of them.
  It marks their jobs first (`CmsisJobTracker.requestStop`), so they read as
  stopped once they end, whatever code the task closes with, without a
  failed-build diagnostic rerun. A short deadline also leaves this stop
  pending; `TASK_FAILED` requires the full verification period. With no
  build running it issues nothing and says so, and names a build result that is still being
  checked: that check is no task, and `status` waits for it. It never
  switches the target.
- `refresh` issues `cmsis-csolution.refresh`, the panel's Refresh, which in
  CMSIS Solution 1.72.0 is a convert with `updateRte`: it writes the files a
  component brings that a build reports as "not found; use --update-rte".
  It runs no task, so no job follows it; the call waits until the
  solution's `<name>.cbuild-idx.yml` has changed and stays unchanged for one
  more look, and answers with the messages csolution recorded there
  (`idxMessages()`). A failed build whose errors ask for `--update-rte`
  names `refresh` in its hint.
- `activate_environment` issues `environment-manager.reactivate`, the Arm
  Tools Environment Manager's Reactivate Environment, which no tool could
  issue before: an agent could only ask the user, and could not tell
  afterwards whether it had happened. It resolves `vcpkg-configuration.json`
  again and installs what is missing; CMSIS Solution then rewrites
  `.cmsis/tools-environment.yml`, the record of the tools its tasks run
  with (`environmentFiles()` finds both). The command takes the manifest's
  Uri, as the Explorer's context menu hands it, and fails without one. The call is refused when the
  command is not registered (the extension is missing) or the solution has
  no manifest, and otherwise waits as `refresh` does, for the record to
  change and stay unchanged one more look, then lists the tools it names
  (`readToolsEnvironment()`); a resolution that outlasts the wait answers
  `running`. The task actions compare the two files first
  (`staleEnvironmentNote()`): a manifest newer than the record, or a record
  that is missing, puts one sentence before the result, so that a build
  that ran with the tools of an earlier activation says so.

- `open_solution` needs no active solution either. It takes the path of a
  csolution or of its folder. A folder this window has open, by its path
  or by its real path (links resolved, letter case as on disk;
  `liesInFolder()`), is activated here
  (`cmsis-csolution.activateSolution`, verified, refused under a live
  session). The extension takes only a path spelled exactly as in its list,
  which it builds from `vscode.workspace.findFiles`, and otherwise waits in
  its own picker. So open_solution runs the extension's own search
  (`listedSolutions()`: its include and its exclude of hidden folders and
  `cmsis-csolution.exclude`, from `src/core/bootstrapState.ts`, without a
  limit) and hands over the entry that is the same file as the path given,
  compared by real path (`solutionAsListed()`), whatever the letter case,
  the separators or the links on the way. A csolution the extension does
  not list is refused before it is asked, and one it did not take while
  another stays active is `TASK_FAILED`, not a hint to build. A window without any folder opens it in itself
  (`openHere()`) when the client runs outside the window — the tool passes
  the client's `initialize` name, `src/core/clientHosting.ts` knows the
  CLIs: VS Code reloads the window for that, the MCP server with it, so the
  reply goes out first and `HandlerHost.openFolder` runs a second later;
  the reply (`data.reloads`) tells the agent to come back after the reload,
  and the client reconnects on the same port (Claude Code does so by
  itself). A chat inside the window (Copilot Chat, Cline, Roo Code; also any
  unknown client) would be ended by the reload, so for it, as for a window
  with another folder, the folder opens in a new VS Code window and the
  window that answers keeps running; the result's `data.newWindow` tells
  the router to follow (see windowRouting.md).
- `install_pack` needs no active solution or folder either
  (`src/handler/installPack.ts`, the pure parts in `src/core/packInstall.ts`).
  It exists so that a pack's knowledge units can be read before the project
  that needs the pack is written, without a `cpackget add` in the shell. It
  calls the CMSIS Solution extension's hidden `installPack` command, which
  answers only a folder or nothing, so the call checks what it can first:
  `Vendor::Name@version` with the version required, the extension installed,
  and the command present once the extension is activated (a window without
  a csolution has not activated it). The licence gate reads the `<license>`
  of the pack's PDSC in the pack root's `.Web/` and asks the user in a modal
  before anything is installed; without that PDSC it installs and says that
  the licence was not checked. After the command the folder is checked, a
  failure is journaled with a pointer to the "CMSIS Solution" output
  channel, and the result names the pack's knowledge units as a
  `knowledge_expand` call, which lists them although `knowledge_search`
  scopes them to projects that use the pack. One install per pack runs at
  a time (question included): a repeated call waits for it, and the call
  answers by its deadline, `running` while cpackget runs. Everything that
  touches VS Code is the host's `packInstall()`.
- `create_solution` needs no active solution either
  (`src/handler/createSolution.ts`). It creates a project from an example,
  reference application or template of CMSIS Solution's catalog through
  that extension's API (next section): the board, device and draft are
  looked up by the ids `cmsis_query` lists, and the API's
  `createNewSolution` gets the objects it listed. After it has copied the
  files, CMSIS Solution writes `.vscode/cmsis.json`, may add a
  `vcpkg-configuration.json` through the Arm Tools Environment Manager, and
  opens the folder in the window that created it, without asking and
  without waiting for us. A window that has exactly that folder open stays,
  any other reloads into it. So the call runs only in such a window, or in
  a window without a folder for a client that survives the reload
  (`clientHosting.ts`, as for `open_solution`); a window with another folder
  would lose it and is refused, and so is an empty window for a chat inside
  it. The reply says what CMSIS Solution does next (`data.reloads`), and a
  creation that outlasts the wait (a web example downloads first) is
  answered with status `running`. In the window that stays, CMSIS Solution
  does not make the new csolution its active solution, so the call does:
  `runCmsisAction` hands `createSolution()` the activation of
  `open_solution` (`activateHere()`, the same lookup in the extension's
  list by real path and the same checks), which runs within the time the
  call has left and names the solution as the extension reports it
  (`data.activation`, `data.active`). A refusal, a failure or no time left
  goes into the reply with its hint; the created folder stays a success.

Before any command: a debug session refuses `load_and_debug` and `attach`,
the probe guard refuses what another owner blocks (`PROBE_BUSY`), a window
without an active solution is refused, an unknown target or action is
`INVALID_ARGUMENT`, and so is a task the solution's `tasks.json` does not
have (`load` on an Arm Debugger adapter, for example). The probe guard
knows this window only; a GDB port is shared by the machine. So
`load_and_debug`, `run` and `load_and_run` first reserve, then ask who holds the GDB ports
they would start a server on — the fixed port of each launch configuration
CMSIS Solution can start for the active target (`activeLaunchConfigurations()`:
not an FVP's or another board's that launch.json keeps beside it), the
CMSIS Run task's ports (`reserveLaunchPorts()`, `reserveRunPorts()`)
— and refuse with `PROBE_BUSY` naming the other window and what holds the
port there, or another program, before the command goes out. GDB would
otherwise connect to that server and halt its target, while the session
here looked fine ([windowRouting.md](windowRouting.md#gdb-ports)). Partial
acquisitions roll back on refusal. Pending starts retain their reservations;
confirmed command/task failures release them only when no session or
launch-related task remains, and the coordinator releases adopted batches
when their session/task ends.

A `tasks.json` without any CMSIS task is a hand-off to the CMSIS Solution
extension rather than a dead end: when the active target's cbuild-run.yml
names a debugger (`cbuildRunDebugger()` in
`src/core/packDocs/cbuildRun.ts`), `writeCmsisTasks()` runs
`cmsis-csolution.updateDebugTasks` once — what that extension runs itself
after each successful convert; it renders the debugger adapter's template
into the CMSIS tasks and launch configurations and leaves other tasks alone
— reads the labels again for up to 5 s and goes on. It is not run when no
debugger is named (the command does nothing then) or when
`cmsis-csolution.autoDebugLaunch` is off (it writes no file then). Otherwise,
or when it wrote nothing, the refusal says why and that the user chooses
the debugger in Manage Solution Settings. The cbuild-run.yml is the one the
extension names, through the lookup `flash` uses
(`HandlerHost.activeCbuildRunFile`): Update Debug Tasks reads that file and
no other, so a file found on disk by convention would not predict what it
does.

`load_and_debug` and `attach` go through the same check, since CMSIS
Solution writes its launch configurations together with its tasks: without
them its Load & Debug only shows "Unable to start debugging", which the
agent never sees. With the setting off they also need a launch
configuration of the right request with a `cmsis` node in `launch.json`
(`cmsisLaunchConfigurations()` in `src/core/gdbServerPorts.ts`); the
setting is read through `HandlerHost.autoDebugLaunch`. When that
configuration runs `CMSIS Load` first, a Load that has not started 10 s
after the command is the answer — the job is settled as not started and
stays in `status` — while for FVP and Arm Debugger, whose sessions start
without one, the session alone decides.

A window without an active solution is an ordinary state for an agent that
starts in an empty VS Code, so the refusal says which part is missing
(`whyNoSolution()`, texts in `src/core/bootstrapState.ts`): no folder open is
`NO_WORKSPACE`; the CMSIS Solution extension not installed, no csolution file
in the workspace, or a file the extension has not loaded are
`CMSIS_NO_SOLUTION`, each with its own next step. `flash` answers
`NO_WORKSPACE` likewise, and `get_session_status` adds the same finding as
lines while no session runs in a window without a folder. The steps from
there are the `bootstrap` topic of the agent guide and the knowledge
procedure `proc-cmsis-bootstrap`, read with `knowledge_get`.

When `target` names a target-type or target-set that is not active, the
selection is written into `.vscode/cmsis.json`, the solution is
re-activated, and the switch is verified through the extension before
anything runs. The file is the one CMSIS Solution reads: that of the
workspace's first folder, also for a solution in another folder of a
multi-root workspace, keyed by the solution's path relative to that folder,
a key the extension splits at every dot. The solution's `tasks.json` and
`launch.json`, by contrast, are those of the folder that holds it. A switch
is refused under a live debug session. `src/core/cmsisTarget.ts` reads the
declared target-types and their sets from the csolution and edits the file.
It uses the full YAML parser `js-yaml`, so block and flow collections,
quoted escapes, anchors, aliases and merge keys have the same meaning.
Selection fields are checked without coercing YAML scalars or following
object prototype properties, while unrelated CMSIS fields stay the owner's
responsibility. Bounds on the document, parser work and extracted names
prevent an input from tying up the window. Invalid or unsupported YAML and
target shapes produce `INVALID_ARGUMENT` before any selection write or
reactivation, never an invented empty target list. A set's index counts
every entry of `target-set:`, as the CMSIS Solution extension's index into
that list does; missing and null names retain their unnamed place.

`src/handler/flashTool.ts` runs `flash`. It picks the `*.cbuild-run.yml` —
the argument, else the one of the CMSIS Solution extension's active target
when that file exists (`HandlerHost.activeCbuildRunFile`, the extension's
`getCbuildRunFile`, asked only while the extension is active), else
`cmsis.cbuildRunFile` from `launch.json`, else the only match under `out/` —
refuses while a session or a CMSIS task holds the probe,
and runs `pyocd load --no-wait --cbuild-run` through `src/core/flashController.ts`
with the pyOCD the CMSIS tasks use: the CMSIS Debugger extension's bundled
one, else the one the solution's `.cmsis/tools-environment.yml` names, else
one on PATH (`resolvePyocd()`). pyOCD's cbuild-run support selects no probe,
so `flash` passes the selection of CMSIS Solution's CMSIS Load task: `--probe`
by the debug adapter the cbuild-run file names (`pyocdProbeType()`), `--uid`
by that file's `debugger: probe-id`, else by the setting
`cmsis-csolution.probe-id` (`HandlerHost.solutionProbeId`). Whether a run
worked is pyOCD's exit status; its output explains the result. A failure
shows the error and critical log lines and tracebacks, or the probes pyOCD
lists when several match and it chooses none, which the result names with the
place the user selects one. A success lists the warnings and errors pyOCD
logged anyway. A data chunk of the image that pyOCD could not add (no writable
memory at its address, or overlapping data) does not fail the run, since
pyOCD goes on and exits 0, but it turns the success into a ⚠️: the target
does not hold the image as built. A refusal is `PROBE_BUSY`, a file that
cannot be chosen `INVALID_ARGUMENT`, no runnable pyOCD `TOOL_DISABLED`, a
failing run `TASK_FAILED`, and a run killed at its budget is answered with
status `timeout`.

### The catalog: `cmsis_query`

CMSIS Solution publishes a versioned API (`exports.getApi(2)`, the types of
`@arm-software/vscode-cmsis-csolution`). Its catalog merges Arm's web
catalog with the installed packs, so it knows a board's examples before any
of its packs is installed, which `csolution list examples` does not.
`handleCmsisQuery` serves the first slice of #41's `cmsis_query`: `what` is
`boards`, `devices` or `examples`, and `context` and `toolchain` are meant to
join it as further kinds (`QUERY_KINDS` in `src/core/catalogQuery.ts`).

Two pure modules carry it. `src/core/solutionApi.ts` holds the part of the
API this extension calls, as types of its own, and `acquireSolutionApi()`,
the seam: the extension missing is the bootstrap refusal
`CMSIS_NO_SOLUTION`, an inactive one is activated (`TIMEOUT` after 20 s,
`TASK_FAILED` when it fails), and no `getApi`, no version 2 or a version 2
without a method is `TOOL_DISABLED`; one API object is kept per extension,
since `getApi` makes a new one per call. It also finds a board, device or
draft by id, case-insensitively, with near ids when none matches.
`src/core/catalogQuery.ts` applies the filters itself, as case-insensitive
regular expressions (the API's name filter is case-sensitive and its vendor
filter exact); a name is tried against the entry's name and its id, and
also as text without separators, so the user's `micro:bit` finds the board
`microbit-v2` (`matcherOf`). No filter an agent passes is ignored: `board`
for boards and `device` for devices, the arguments the other kinds take, are
patterns for the name as well (`nameMatches()`), since an agent that names
the device it means and gets the whole catalog of 13 000 devices back has
nothing to read. It sorts boards and devices by id, caps the list at `limit`
(20, at most 100) and counts the rest. The pack, devices and cores of an
entry can cost the web catalog one request each, so they are read for the
listed entries only, in parallel, and left out with a note when they do not
arrive within 10 s. The answer is a text and the same as `data`.

The extension's first list request in a window fills its catalog from Arm's
web service, which can take longer than the call. That is answered as a
`running` reply, not a failure, by the query's own deadline (3 s before the
fence) and by the fence behind it (`capStatus`): the text says the catalog
is still loading and to repeat the same call. Nothing is cached here: the
extension goes on loading, its API object is kept per extension
(`acquireSolutionApi()`), and the repeat finds the catalog or waits for
less of it.

The API keeps a source's failure to itself. Only a draft says where it came
from (`draftSource`: web or installed pack). Whether the web catalog was
reachable is read from the API object's data manager (`dataManager.errors`,
"Web service could not be reached"), a field outside the published API,
used when it is there (`catalogErrorsOf()`); without it, examples of which
none came from the web are answered with a note that says the cause is not
known.

A pack's own examples (a DFP's `RTX_Blinky`, say) are listed only once the
pack is installed, and Arm's web catalog may not have them: a tester's
agent saw only web demos for the XMC4700 Relax Kit and never the DFP's
Blinky, since the pack was installed afterwards. So the examples of a
board whose pack — the `pack` of the board entry — is not installed, and
of which none comes from an installed copy of it, end with a line naming
the pack and the `cmsis_action install_pack` call (`boardPackMissing()`,
`data.boardPackNotInstalled`). The module reads no files: the handler
passes `PackInstalled`, which looks for any version of the pack with its
PDSC in the pack root CMSIS Solution uses (`packInstalledIn()` in
`src/core/packInstall.ts`); an answer it cannot give says nothing.

Arm's web catalog keeps one example per pack release that ships it: the
XMC4700 Relax Kit has `snmp_agent_demo` from Oryx-Embedded Middleware 2.6.6
and from 2.4.4, same name, same description. The API passes on only id,
name, description and format of a web example, so the two would be listed
alike and the agent would have to ask the user for an id. When listed web
examples share a name, `src/core/webCatalog.ts` asks the catalog itself for
the one field that tells them apart, the example's origin pack, with the
same two GraphQL queries CMSIS Solution makes (the board by its CMSIS id,
then its projects), at most 5 s within the call and only for such a
listing; the line then reads `web from Oryx-Embedded::Middleware@2.6.6`
and `data.pack` carries it. When the catalog does not answer, a note says
that CMSIS Solution does not tell the copies apart. The fetch comes from
the host (`HandlerHost.webCatalogFetch`), so tests script it.

Programming can make the probe's virtual COM port re-enumerate, which closes
a serial port the window holds. So `flash` and the programming actions of
`cmsis_action` (`load`, `erase`, `load_and_run`) add one line to a result
when the window held a port as they started (`noteHeldSerialPort()`): that
it is open and may need reopening, or why it went during programming (#49).
They do not release the port first: nothing ties a COM port to the probe
being programmed, and a second board's UART would go too.

## CMSIS jobs

The CMSIS Solution extension runs builds as its own task type and the
panel's Load, Run, Load+Run and Erase as tasks it writes into `tasks.json`.
`src/core/cmsisTasks.ts` knows those shapes: `classifyCmsisTask()` names a
task's kind by the rules the extension itself applies (the build type, the
Arm Debugger's flash task, exact labels from `tasks.json`); the build type
splits into build, rebuild, clean and setup by its definition's flags, so
that none answers for another. `reduceJob()`
folds task events into a job's state (`armed`, `started`, then `ok`,
`failed`, `cancelled`, `running-ok` or `not-started`), and `guardProbe()` is
the matrix of which action may touch the probe beside which owner.

`CmsisJobTracker` (`src/cmsisJobTracker.ts`) is one per window, shared by
its debugging handlers and created at activation, so that tasks started from
the panel are seen too. It keeps the live CMSIS executions and the jobs:

- a job is armed before its command goes out; executions alive at that
  moment never complete it, and it binds the first execution of each kind it
  expects that starts afterwards — for a build, the execution the command
  returns. Other CMSIS executions are noted, never the result, so a
  `cbuild setup` after a target switch cannot answer for a build;
- `load_and_run` counts as done once Load ended 0 and CMSIS Run, which
  hosts the GDB server and never ends, stayed up for 2 s; `run` once CMSIS
  Run alone stayed up that long, and a Run that ends earlier is `failed`
  with its exit code;
- nothing expected starting within 10 s of the command is `not-started`;
- a build-type task that closes with 130 (CMSIS Solution's Stop Build) or
  that `stop_build` asked to end is `cancelled` and reads as stopped, never
  as a failed build, so no diagnosis runs for it;
- a build, rebuild, clean, load or erase started elsewhere is adopted as a
  job of its own, so that a repeated call attaches to it instead of
  starting another;
- the latest settled job of each action is kept until a newer one of that
  action settles, since an agent may ask `status` long after a build
  failed, while it waited for the user; older settled jobs are kept for 10
  minutes; all in memory only. `get_session_status` shows one line from
  them and the live tasks.

A call has one deadline (#12): the solution checks and a target switch come
out of it, and a job still going when it passes is answered with status
`running` and the job in `data`. The texts live in `src/handler/jobText.ts`.

### Why a build failed

The CMSIS Solution extension runs cbuild in a pseudoterminal no other
extension can read and keeps no log, so a failed build job knows only its
exit code. `src/cmsisBuildDiagnosis.ts` completes such a job's result
(#15); a rebuild is treated as a build. The tracker calls its `onDidFinishJob` listener before it wakes the
job's waiters, and `completeWith` makes them wait for the work as well: the
job carries a pending `diagnosis` until it is done.

- **Stage A** reads the errors and warnings csolution recorded in the
  solution's `*.cbuild-idx.yml`, when the build wrote that file. Errors
  there (a missing pack or component, a schema error) are the answer.
- **Stage B** runs cbuild once more with `--log`: the failed task's
  arguments without the steps that download packs, update RTE files or
  clean, `--skip-convert` after a fresh index, and the environment CMSIS
  Solution recorded in `.cmsis/tools-environment.yml`. Its log is parsed
  with the parser of `get_build_diagnostics`. The re-run starts only while
  no other build or setup runs, is killed when one starts or after 120 s,
  and can be switched off (`build.diagnosticRerun`). It is interim, until
  CMSIS Solution offers a build log of its own (#21).

The same machinery checks a build whose task exited 0. CMSIS Solution
1.70.1 cannot report a failed build: its build runner drops the exit code
cbuild returned, and the task's pseudoterminal closes with 0 either way. So
exit 0 is not a success until `BuildDiagnosisRunner.check` agrees:

- errors in a fresh `*.cbuild-idx.yml` make it a failure;
- the images the build writes — the primary outputs of each context the
  index names, else those of the cbuild-run file — all written since the
  build started confirm it. "Written" means changed since the build task
  started, when `onStarted` noted their times; only without that note does
  an image up to 2 s older than the build count, for coarse file times. A
  failed build that starts right after a good one finds the image of that
  one younger than 2 s, so the age alone would have confirmed it;
- otherwise stage B decides. The build is incremental, so the re-run fails
  where the build failed and succeeds at once when there was nothing to
  rebuild; an image that kept its old time is no failure by itself.

The check's verdict is `diagnosis.check`: `rebuilt` and `up-to-date` are
successes, `failed` turns the job into a failed one (`withDiagnosis` in
`src/core/cmsisTasks.ts`), and `unverified` — an image not rewritten and no
re-run possible — is answered as a warning, not as ✅.

A clean that exited 0 has a check of its own, since exit 0 proves nothing
there either: when its task starts, before cbuild gets to work,
`BuildDiagnosisRunner.onStarted` notes which images of the active target
exist; at its end, `checkClean` names those it removed (`cleaned`), or the
one still there (`unverified`). A failed clean is never re-run.

The `diagnosis` holds the errors and warnings with file and line, which
`onDidDiagnoseJob` announces for the problem journal (#48), and the short
block `renderBuildFailure` makes for the result. When it arrives within the
call's deadline the failing call shows it; otherwise the call says the lines
are coming, and `status` waits for them. The pure parts — the readers of the
two YAML files, the re-run's command line and environment — are in
`src/core/buildFailure.ts`.

### Why a Load or a launch failed

A failed Load or Erase leaves its reason in a task terminal no tool reads,
so its hint says where to get it, and that depends on the program the task
ran. The tracker keeps each task's command words (`commandOf()`), and
`taskProgram()` in `src/core/programLookup.ts` reads the kind from them:
pyOCD, J-Link (the J-Link adapter's Load is a shell line that writes a
command file and calls `JLink.exe` or `JLinkExe`), an FVP model, another
program, or unknown. `flashFailedHint()` keeps the pyOCD wording, which
points at `flash` for pyOCD's own lines, for pyOCD and for an unknown
command; a J-Link task gets J-Link's two connect failures instead, and any
other program only the request for the terminal's last lines.

A J-Link task that exits non-zero within `FAILED_AT_ONCE_MS` (2 s) most
likely never ran: the shell did not find the program. Then the program is
looked up on the PATH the CMSIS tasks run with — the directories of
`.cmsis/tools-environment.yml`, then the PATH of the setting
`terminal.integrated.env.<platform>` with its `${env:PATH}` expanded, or VS
Code's own PATH when the setting has none — honouring `PATHEXT` and case on
Windows. Missing, the hint says so with the places searched, and names the
SEGGER installation folder that holds the program when one does; found, it
asks for the terminal's lines and says J-Link ran.

A launch that loses its session gets the same treatment when the debug
adapter journaled `GDB_SERVER_NOT_FOUND` during the call: the adapter
starts the launch configuration's `target.server` with VS Code's own PATH,
which a terminal setting does not reach, so the server can be on the
tasks' PATH and still not start. `gdbServerMissingHint()` looks it up on
both and says which lacks it, replacing the generic lost-launch hint; with
that record, a load_and_debug whose session never showed is a failure, not
`running`. The record's own static hint, which knows only the line, still
rides along with the same fix and pointer. A server found on VS Code's PATH
points at the launch configuration's `cwd` instead, since Node reports a
missing working directory with the same `ENOENT`.

These hints carry only what the tool found out — which program is missing
from which PATH, where it looked, which folder holds it — and one line of
fix: install the software or put its folder on the system or user PATH,
then restart VS Code completely. Why there are two PATHs, the default
folders per platform and what not to do are knowledge, not findings, and
live in the troubleshooting procedure (`cmsis-knowledge-base/sources/cda-procedures/debugger-troubleshooting/`,
unit `proc-debugger-troubleshooting`), which every such hint names with
`knowledge_get`. Starting the server with `cmsis_action run` and attaching
is deliberately not offered: it programs nothing and leaves `load_and_debug`
broken.

`src/handler/taskProgram.ts` holds this glue: it reads the tools
environment file and takes the setting, the environment and the file tests
from the host's `toolEnvironment()`, so tests fake a Windows machine on any
platform. Nothing is written and nothing is run.

## The problem journal

What goes wrong in a window shows up in places the agent cannot see: the
debug adapter's output, the GDB server behind it, a breakpoint VS Code's own
UI set while the target ran, a build started from the CMSIS panel, a toast.
The problem journal (#48) collects all of it in one record shape, one
journal per window, and the agent reads it in three ways: the records a
failed call produced ride along with the failure, a successful result notes
once when errors arrived that the agent has not seen, and
`get_recent_problems` lists them with a cursor.

- **The journal** (`ProblemJournal` in `src/core/problemJournal.ts`, the
  window's instance from `problemJournal()`) keeps 200 records. Every record
  has a `seq`, monotonic per window, which is the cursor; the oldest `info`
  is evicted first, then the oldest `warning`, then the oldest `error`, so
  chatter never pushes out an error. A repeat within 10 s is counted in its
  record, which moves to the end with a new `seq`. Two counters — the newest
  `seq` and the errors ever appended — travel with every answer of the
  window. A call running in the window is registered (`beginCall`), so a
  record written while it runs carries its call id: from the async call
  context when there is one, else by timing while it is the only call.
- **Sources.** The adapter tracker (`src/utils/sessionStateTracker.ts`)
  journals failed responses, adapter errors and output line by line: GDB's
  `stderr` as warnings; the adapter's `console` and `important` and the GDB
  server's own log (category `server` on cdt-gdb-adapter) as `info` unless a
  line is known or, for the server's log, pyOCD's level column says `W`
  (warning) or `E`/`C` (error), so that a server that ends at once leaves
  its reason among the errors a failed `load_and_debug` carries; colour codes
  are stripped; never the target's `stdout` or GDB's `log` stream. A line
  arrives in pieces when the server writes a few characters at a time (an
  FVP's model output), so the start of a line waits for the output event
  with its newline, at most 500 ms and 4 096 characters, and the session's
  end journals what is left. A failed
  response is an error when VS Code sent the request and a warning when a
  tool did, since the tool reports its own outcome; an `evaluate` that a
  view sent on its own (Watch, hover, the CMSIS Debugger's Live Watch) is
  `info`, since the views repeat theirs at every stop;
  `customRequestWithTimeout` announces the tools' requests to tell them
  apart. `src/windowProblems.ts` journals a
  failed CMSIS job as `TASK_FAILED` and the error lines of a failed build
  (#15) as `BUILD_ERROR` with a workspace-relative file, and reads the
  Problems panel's errors on demand, diffed against the last reading and
  without the IntelliSense sources. `src/utils/notify.ts` journals this
  extension's error and warning toasts, `logger.error` feeds a sink (the same
  message at most once a minute), and the serial controller journals a port
  that cannot be opened or goes away. #49's releases and #14's worker fence
  journal through `problemJournal()` as well.
- **The output channel.** `mirrorProblem()` in `src/windowProblems.ts`
  writes each warning and error as a `[problem #N] …` line at debug level,
  so the channel stays quiet unless the user sets it to Debug: the journal
  is for the agent and for "Copy Recent Problems", not a second log.
- **Codes.** `classifyProblem()` in `src/core/problemCodes.ts` recognises
  known lines and gives them a code, a weight and the next step as the hint.
  The codes are this repository's: `ErrorCode` (#11) and the journal's own
  `DAP_POWER_UP_FAILED`, `GDB_SERVER_NOT_FOUND` and `BUILD_ERROR`. A row
  ships only with a line captured from a real session, which its test holds
  as a fixture:

  | Line | Code | Weight | Source |
  | ---- | ---- | ------ | ------ |
  | `Failed to power up DAP` | `DAP_POWER_UP_FAILED` | error | `gdb-server` |
  | `Waiting for a debug probe matching unique ID` | `PROBE_BUSY` | error | `gdb-server` |
  | `gdbserver has hit error Error: spawn … ENOENT` | `GDB_SERVER_NOT_FOUND` | error | as reported |
  | `target is running` | `TARGET_RUNNING` | warning | as reported |
  | `no active solution` | `CMSIS_NO_SOLUTION` | error | as reported |

  `PROBE_NOT_FOUND` (pyOCD's "No available debug probes", a J-Link connect
  failure) and `CORE_NOT_FOUND` wait for a captured line, as does the J-Link
  banner that would mark any GDB-server line; `serverLineSeverity()` reads
  pyOCD's log prefix, captured from a tester's failed launch.
- **Delivery** (`src/core/problemFeed.ts`). `runJournaled()` runs an op in
  the window that owns it — the control server for a forwarded call,
  `journalLocally()` on a server without a router — and attaches up to five
  records of the call at warning or above to a failure or a timeout, as
  `data.problems`, leaving out records of another call and records that
  only restate the failure. `ProblemNotices` keeps, per MCP session and
  window, what the agent has seen: the first answer sets the baseline,
  `get_recent_problems` moves it, `get_session_status` carries a count line
  while errors lie beyond it, and one successful result per batch carries a
  note naming the call to make. `handleGetRecentProblems()` renders the
  journal from `sinceSeq` on (`src/handler/problemText.ts`): one line per
  record, newest 20 (at most 50), and the same records as JSON in
  `data.records`, for clients that show the model `structuredContent`
  instead of the text; the lines and the records each stay within 8 kB.

## The host seam

Everything else the handler needs comes from a `HandlerHost`
(`src/handler/host.ts`): clock, timers, VS Code's focused frame, the
window's CMSIS job tracker, its owned serial port, workspace folders, file
search, where `flash` looks for pyOCD and the hints of a failed J-Link task
or GDB server start look a program up, what `install_pack` asks of VS
Code and the CMSIS Solution extension (`packInstall()`), and the CMSIS
Solution extension behind `cmsis_query` and `create_solution`
(`solutionExtension()`, its activation state and exports read at each
use), and who holds a GDB port before a launch (`gdbPortHolder()`: the
other windows' claims, which the window's coordinator hands the handler's
constructor, then a bind test). `get_session_status` adds a line
on the serial port from it (#49): the port held, for whom and how long idle,
or why it was released, seen from the MCP session that asks. `VSCODE_HOST` looks each of them up in VS Code at the
moment of the call. Unit tests override `host()` with a scaled clock, so a
60 s fence or an 8 s session wait takes milliseconds, and with a tracker
over fake task events.

## Known deviations

A few behaviours are known to be wrong and were kept on purpose, so that the
rewrite could be reviewed as behaviour-neutral. Comments in the code mark
each with its number (`KB9`, `KB15`, …); the list is in the *Known bugs to
preserve* section of `docs/provenance/specs/debuggingHandler.md`. Each is
fixed in a change of its own: KB1, failures answered as ordinary text, by
the typed results of #11; KB2, KB4 and KB5 — the 60 s cap, the missing
probe guards and the task matching of `cmsis_action` — by the CMSIS jobs of
issues #12, #46 and #47; KB3 and KB12, breakpoint changes that ignored the
run state and a GDB breakpoint `remove_breakpoint` could not reach, by #13;
KB6, the `-exec` passthrough that never reached GDB on the CMSIS Debugger,
by #56.

## Where to look

| File | Contents |
| ---- | -------- |
| `src/debuggingHandler.ts` | `IDebuggingHandler`, `DebuggingHandler`: gates, stop waits, state rendering, session start and stop, breakpoints, variables, target reads, fault triage, SVD lookups |
| `src/handler/fence.ts` | `fenced()` and its `onCap` choice, `fenceLimitMs()`, `failureText()` |
| `src/core/toolResult.ts` | `ToolText`, `ToolReply`, `ToolError`, `ErrorCode`, `classifyError()`, `wrapError()` |
| `src/handler/host.ts` | `HandlerHost`, `VSCODE_HOST` |
| `src/handler/gdbText.ts` | GDB reply classification and refusals, the MI results of `-dprintf-insert` and `-break-list`, a logpoint's GDB location, logpoint message to `dprintf` |
| `src/handler/sessionText.ts` | state refusals with their codes (`PROBE_WEDGED` and its reconnect hint for `unresponsive`), the `get_session_status` text, call-stack and thread listings |
| `src/core/problemJournal.ts` | `ProblemJournal`, `problemJournal()`, the record shape, `formatProblemLine()` (#48) |
| `src/core/problemCodes.ts` | `ProblemCode`, `classifyProblem()` and its rows |
| `src/core/problemFeed.ts` | `runJournaled()`, `ProblemNotices`, `journalLocally()`, the "Recent problems:" block |
| `src/handler/problemText.ts` | the `get_recent_problems` reply |
| `src/windowProblems.ts` | the output-channel mirror (`mirrorProblem()`, debug level), the `logger.error` sink, "Copy Recent Problems", failed jobs and build lines, the Problems panel |
| `src/handler/targetText.ts` | register normalisation, register table, memory dump, cycle-counter text |
| `src/handler/cmsisAction.ts` | `cmsis_action`: commands, probe guard, target switch, label pre-check and the Update Debug Tasks hand-off, jobs, session waits, verified `stop_run` and `stop_build`, `status`, `open_solution`, the dispatch of `install_pack` and `create_solution`, why no solution is active |
| `src/handler/installPack.ts`, `src/core/packInstall.ts` | `install_pack`: the pack id, the licence gate, the install in flight, the folder check, the knowledge line; `PackInstallHost` |
| `src/core/solutionApi.ts`, `src/core/catalogQuery.ts`, `src/core/webCatalog.ts` | CMSIS Solution's API version 2 as far as it is used, `acquireSolutionApi()`, the lookups by id, `catalogErrorsOf()`; `cmsis_query`'s kinds, filters, caps, texts and data; the origin pack of web examples alike, from Arm's web catalog |
| `src/handler/createSolution.ts` | `cmsis_action create_solution`: the folder, the window check, the lookups, `createNewSolution`, the text of what follows |
| `src/core/bootstrapState.ts`, `src/utils/solutionFiles.ts` | The refusals and status lines of a window that lacks a folder, the CMSIS extensions or a loaded solution; path comparison per platform and the CMSIS Solution extension's csolution search; the csolution files below a folder that is not open yet |
| `src/core/solutionAnswers.ts`, `src/utils/solutionQueries.ts` | What the answers of the CMSIS Solution extension's getters mean (`getSolutionFile`, `getActiveTargetSet`, `getCbuildRunFile`, `getDfpPath`, `getBspPath`), for every caller; asking the hidden getters only while the extension is active, feature-detected, under a 3 s fence |
| `src/handler/jobText.ts` | job results, `running` replies, `status`, `PROBE_BUSY` refusals, the `get_session_status` task line; `flashFailedHint()` by the task's program |
| `src/core/programLookup.ts`, `src/handler/taskProgram.ts` | The kind of a task's program, the PATH of the CMSIS tasks and VS Code's, the lookup and the SEGGER folders; `failedTaskProgram()`, `gdbServerMissingHint()` |
| `src/cmsisJobTracker.ts` | `CmsisJobTracker`: live CMSIS executions, jobs, probe owners, the label pre-check, work that completes a settled job; the window's instance |
| `src/cmsisBuildDiagnosis.ts` | The error lines of a failed build or rebuild: csolution's index, the diagnostic re-run of cbuild and its guards (#15); the check of a build that exited 0, and of a clean |
| `src/core/buildFailure.ts` | The readers of `cbuild-idx.yml` and `tools-environment.yml`, the re-run's arguments and environment, the reasons for no re-run; `renderBuildFailure()` is in `src/core/buildInfo/render.ts` |
| `src/core/cmsisTasks.ts` | task classifier, `reduceJob()`, `guardProbe()` |
| `src/core/gdbServerPorts.ts`, `src/core/gdbPortGuard.ts` | The GDB port of a launch configuration, a session and a CMSIS Run task, the claims a window publishes; who holds a port (the other windows' claims, the bind test) and the `PROBE_BUSY` refusal |
| `src/handler/flashTool.ts` | `flash`: choice of the cbuild-run file, probe guard, pyOCD lookup |
| `src/core/flashController.ts` | `resolvePyocd()`, the pyOCD process and its output |

## Tests

- `src/test/debuggingHandler.test.ts`: the handler against a scripted
  executor and host, CMSIS jobs over fake task events included; a picker
  nobody answers and a stop that never settles (#14)
- `src/test/debugConfigurationManager.test.ts`: the configuration picker
  against VS Code's own quick pick, closed by its cancellation token
- `src/test/cmsisTasks.test.ts`, `src/test/cmsisJobTracker.test.ts`: the
  classifier, the job state machine, the guard matrix and the tracker,
  replayed over task sequences derived from CMSIS Solution 1.70.1
  (`src/test/fixtures/cmsisTasks/`)
- `src/test/programLookup.test.ts`: the kind of a task's program, the
  PATH of the CMSIS tasks, the lookup on Windows and elsewhere, the SEGGER
  folders
- `src/test/buildFailure.test.ts`, `src/test/cmsisBuildDiagnosis.test.ts`:
  the two YAML readers on generated files (`src/test/fixtures/buildinfo/`),
  the re-run's command line and the result block, and the diagnosis over
  fake task events with a fake cbuild and a hand-moved clock
- `test/transport/dap-scenarios.js`: scripted `gdbtarget` sessions
  through the real server; every reply and the adapter traffic are compared
  with `dap-scenarios.snapshot.json`
- `src/test/gdbText.test.ts`: GDB reply classification, MI results, logpoint
  locations
- `src/test/problemJournal.test.ts`: eviction, repeats, the cursor, filters,
  call ids, the attached records, the notices and the `get_recent_problems`
  reply; `src/test/problemCodes.test.ts`: every code row against its captured
  line; `src/test/windowProblems.test.ts`: failed jobs, build lines, the
  Problems panel and the copied text; the adapter tracker's records in
  `src/test/sessionStateTracker.test.ts`
- `src/test/solutionCatalog.test.ts`: `cmsis_query` and `create_solution`
  against a stub of CMSIS Solution's API: filters, caps, sources, web
  examples alike with their origin pack and the lookup behind it against a
  scripted fetch, the web
  catalog unreachable, the extension missing, inactive or without API
  version 2, unknown ids, the window checks
- `test/transport/surface-snapshot.js`: every tool's reply without a session
- `test/realboard/run.ts`: every tool against a real board, run by hand
