# DebuggingExecutor

`DebuggingExecutor` (`src/debuggingExecutor.ts`, with its modules in
`src/executor/`) is the only code that calls VS Code's debug API and sends
Debug Adapter Protocol requests to a debug adapter. The handler calls it for
every debugging tool. It hands back data — a `DebugState`, a `Buffer`, a
register table, a status record — and, for a few reports (connection check,
device information, decoded fault registers, peripheral reads), finished
text; how the result is presented to the agent is the handler's business.

The exact extension IDs, command arguments, optional exports and DAP
requests are listed in the
[cross-extension call inventory](../proposals/extension-calls.md), a working
note under `docs/proposals/` that restates the code and is not part of this
architecture page.

## Why it is a layer of its own

On an embedded target the debug adapter is where calls hang: the probe
stalls, the target runs while a read expects it halted, the USB link drops.
With every DAP request in one class, all of them follow the same rules:

- Every request goes through `customRequestWithTimeout()` or `withTimeout()`
  (`src/utils/timeout.ts`) and has a deadline. A timeout is a
  `HardwareTimeoutError`, and fallbacks pass it on instead of trying a slower
  route: a hung probe is reported, not hidden behind a second attempt.
  `customRequestWithTimeout()` also announces the request to the adapter
  tracker, so that its failure is journaled as the tool's own warning rather
  than as an error of VS Code's (#48).
- Every deadline comes from `Budgets` (`src/executor/common.ts`).
- Wording aimed at the agent — refusals, hints, next steps — stays out of the
  executor. The one exception is GDB's refusal of a run-control request on
  the CMSIS Debugger, which it throws as a typed error built in
  `src/core/gdbDialect.ts`.

## Which session, thread and frame

`resolveActiveSession()` (`src/utils/sessionStateTracker.ts`) picks the
session: the one VS Code has focused, else the most recently started live
session, since multi-core `gdbtarget` launches often leave none focused.
Thread and frame ids come from VS Code's focused stack item; they are not
checked against the chosen session.

Whether a target is halted is decided by the DAP `stopped` and `continued`
events, which the tracker registered at activation records for every
session. `activeStackItem` is not reliable for this on embedded targets: it
is empty while the target runs and for a moment after each stop. Only when no
event has been seen yet, as after an attach without an initial stop, does the
tracker fall back to the focused stack item.

## Deadlines

`Budgets` turns the two settings into the deadlines of a call. A tool's
`timeoutMs` arrives as `overrideMs` and replaces the setting for that one
call, never beyond 60 s.

| Budget | Default | Used for |
| ------ | ------- | -------- |
| `request()` | `dapRequestTimeoutMs`, 10 s | each DAP request |
| `operation()` | `memoryReadTimeoutMs`, 30 s | a read made of several requests: memory, registers, peripherals, DWT, fault status |
| `probe()` | the request budget, at most 3 s | the `threads` readiness probe |
| `snapshot()` | the request budget, no override | the `stackTrace` of a state snapshot |
| `stopWait()` | 60 s | a wait for the next stop event |

## What it does

The contract, `IDebuggingExecutor` in `src/executor/contract.ts`, is put
together from six interfaces, one per concern, so that the handler's tests
can fake only the part a case drives.

- **Session lifecycle.** Start a session with a configuration object, or by
  the name of a `launch.json` entry in the workspace folder that matches the
  working directory (`launchFolderFor()`); stop it; restart it. A CMSIS
  Debugger (`gdbtarget`) session is restarted through the debug API: its root
  session (the parent of a multi-core launch) is stopped, and once the tracker
  has seen it end, its launch configuration is started again, so a failure
  comes back to the caller (#13). Other adapters use VS Code's restart
  command.
- **Readiness.** `hasActiveSession()` is true when a session exists, answers
  a `threads` probe and is halted. `getSessionStatus()` classifies the session
  as `no-session`, `initializing`, `running`, `stopped` or `unresponsive`
  from the same probe and never rejects (`probeSession()` in
  `src/executor/sessionReports.ts`, which also writes the connection and
  device reports). On the CMSIS Debugger an answer is not enough:
  cdt-gdb-adapter answers every request with an empty success, without a
  body, until GDB has connected to the target and run the launch
  configuration's commands, and again while the session shuts down. A
  `threads` reply without a thread list is therefore `initializing` there,
  and `hasActiveSession()` false (`takesRequests()`); the replies of other
  adapters count as they are. Starting and shutting down are told apart by
  the session tracker, which sees the `disconnect` or `terminate` request go
  to the adapter (`endRequestOf()`): a session asked to end that gives no
  thread list, a probe timeout included, is `initializing` with
  `endRequestedForMs`, since an adapter that halts the target before it
  disconnects can wait there indefinitely (an Arm FVP ignores the halt). The
  five states stay as they are. `getDiagnostics()` adds the server version
  and the live sessions of the window.
- **Run control.** Steps, continue and pause send the DAP request (`next`,
  `stepIn`, `stepOut`, `continue`, `pause`) for the focused thread. When the
  request fails for any reason except a timeout, a CMSIS Debugger session
  throws GDB's refusal — `TARGET_RUNNING` with `pause_execution` in the hint
  when GDB says the target is running, `INTERNAL` otherwise — because VS
  Code's workbench command would repeat the refused request from the UI,
  where it becomes a toast (#13). Other adapters run the workbench command
  for the same action instead. None of them waits for the stop:
  `armStopWaiter()` and `waitForStop()` do, and the handler arms the waiter
  before it sends the request. `watchFrameFocus()`, taken at the same time,
  waits after the stop for the frame VS Code selects for it (the session
  tracker's `armFocusWatch()`, driven by `onDidChangeActiveStackItem`),
  since every frame-based read goes through VS Code's focused frame; the
  reset waits for it too when a stop event follows the reset commands.
  `watchStartFocus()` (`armStartFocusWatch()`) is its counterpart for a
  session that is about to start: taken before the start, it waits for a
  frame of whichever session is active once it came up, when the tracker
  saw it stop, and answers `running` at once for a target that runs.
- **Breakpoints.** VS Code's breakpoint model on every adapter: add, remove,
  list, clear. `breakpointBinding()` asks VS Code how the session's adapter
  bound a breakpoint (`getDebugProtocolBreakpoint`: verified, message, line,
  the adapter's id), asking again until the adapter has answered or the wait
  runs out; a removal waits, bounded by 2 s, until the adapter has answered
  VS Code's `setBreakpoints` for every file concerned. The CMSIS Debugger's
  logpoints are GDB `dprintf`s instead: MI `-dprintf-insert`, `condition`,
  `delete` with numbers (never a bare `delete`) and MI `-break-list`; the
  session tracker remembers them per session under their GDB number.
  `adoptedBreakpoints()` returns the breakpoints the tracker saw an adapter
  announce as new, which VS Code adopts without listing them in
  `vscode.debug.breakpoints` until the window reloads.
- **GDB commands.** `runGdbCommand()` (`src/executor/gdbCommand.ts`) sends a
  raw GDB command as a REPL evaluate in the prefix of the session's adapter
  (`src/core/gdbDialect.ts`, #56): `>` on the CMSIS Debugger, `-exec` and a
  space elsewhere. cdt-gdb-adapter answers a CLI command with an empty reply and
  prints its text as `output` events (category `stdout`), which a capture on
  the session tracker collects from just before the request until the output
  has been quiet for 50 ms after the reply, 250 ms at most; an MI command's
  result is the reply itself. A refusal comes back as an errored reply with
  GDB's text, and only a timeout rejects. An agent's `-exec <cmd>` or
  `><cmd>` in `evaluate_expression` is sent as `><cmd>` on the CMSIS
  Debugger, and the text GDB printed is the result.
- **Program state.** `getCurrentDebugState()` takes a snapshot
  (`captureDebugState()` in `src/executor/snapshot.ts`): session,
  configuration, focused frame and thread, a 50-frame stack of that thread,
  the current source line with a few lines of look-ahead, and the window's
  source breakpoints. The location always comes from the adapter's top frame,
  never from the editor, and a snapshot never fails. The same snapshot without
  source text is how the executor finds the focused frame before a GDB
  command or register read. Call stacks, the thread list (with the top frame
  of the first 32 threads, fetched four at a time), variables per scope,
  expression evaluation and the children of a structured value
  (`getVariableChildren()`) are plain DAP requests. A read of all scopes
  leaves out, on the CMSIS Debugger, an expensive register scope, which
  VS Code too reads only once the user opens it: cdt-gdb-adapter's
  Registers scope reads every core and FPU register over the probe. A scope
  counts as one of registers by its `presentationHint` or its name; an
  expensive scope of program variables (statics, globals) is read. The
  names left out go back to the handler; `local` and `global` read whatever
  scope matches, and other adapters keep every scope, since js-debug marks
  an ES module's top-level variables expensive (`scopesToRead()`).
- **Target access.** `readMemory()` uses DAP `readMemory` and falls back to
  reading word by word through GDB (`readWordThroughGdb()` in
  `src/executor/gdbMemory.ts` tries a watch expression, then the raw GDB read
  whose answer comes back in the reply: MI `-data-read-memory-bytes` on the
  CMSIS Debugger, `x/1xw` and `print/x` through `-exec` elsewhere). The
  bytes of a DAP reply lie where its `address` says, which need not be the
  address asked for: when the start of the range cannot be read,
  cdt-gdb-adapter answers with the first block GDB could read. So
  `readMemory()` returns its bytes with their offset from the requested
  address (`MemoryRead`, placed by `bytesInRange()`), and fewer of them when
  the end cannot be read; the `read_memory` dump labels its rows from there,
  and the stacked exception frame counts only when it begins at the
  address asked for. A one-word read needs all four bytes, so a reply that
  begins late is a short one there. A read that touches the System Control
  Space (0xE000E000–0xE000EFFF, and its Non-secure alias) goes one aligned
  word at a time (`systemControlSpaceWords()` in `src/core/memoryMap.ts`):
  its registers are words, and the Corstone FVP's GDB server answers longer
  reads there with zeros.
  `writeMemoryWord()` falls back to GDB's `set` and checks its write by
  reading it back. Core registers are
  read as `$<name>` expressions, all at once, with `<timeout>` or
  `<unavailable>` for any that fail. The cycle counter enables the DWT
  (`DEMCR.TRCENA`, `CYCCNTENA`) on first use and reports a core without one:
  Armv6-M and Armv8-M Baseline by `CPUID`, before anything is written, since
  Armv6-M has no `NOCYCCNT` bit to say so; other cores by `DWT_CTRL.NOCYCCNT`
  (`src/core/dwt.ts`).
  A peripheral register is read at the address the device SVD gives and its
  fields decoded (`src/core/peripheralReader.ts`), with the SVD of the session
  the read goes to rather than of the one VS Code has focused; the Peripheral
  Inspector extension is not asked, as its API has no register read. The
  six fault status registers are read one word each, for the same reason as
  the System Control Space above, and decoded by `src/core/faultDecoder.ts`.
- **A failed read.** A memory read that fails in every way keeps why each
  way failed (`MemoryReadFailure`, each cause cut to 200 characters). On the
  CMSIS Debugger each public read then reads DHCSR (0xE000EDF0) once — 4
  bytes, DAP `readMemory`, at most 1 s — and `explainReadFailure()` decides
  (#3): a debugger can read DHCSR whenever the debug port works, so DHCSR
  unreadable or timed out too is `PROBE_WEDGED`, and DHCSR readable means
  only the address cannot be read in this state, `INVALID_ARGUMENT`. A read
  that timed out on a port that answers keeps its timeout. The hint of
  `PROBE_WEDGED` depends on the session's `request`: an attached session
  reconnects with `cmsis_action detach` and `attach`, since the CMSIS Run
  task's pyOCD (`--persist`) outlives every detach and ends only with its
  task, after which `cmsis_action run` starts it again; a launched one owns
  its GDB server (`src/core/probeWedge.ts`). The fault registers are judged
  once, at the first word that fails.
  `probeDebugPort()` offers the same DHCSR read to the handler, which checks
  `S_LOCKUP` with it. Nothing is retried or reconnected: a reconnect replaces
  the session and must not happen as a side effect of a read.
- **Does the core answer?** The `threads` probe behind the status asks only
  the debug adapter, which answers from GDB's state while every target read
  fails. So `checkTargetConnection()` reads DHCSR once on a stopped CMSIS
  Debugger session, and every DHCSR read leaves its verdict with the session
  tracker (`noteCoreVerdict()`): a read that got no answer is kept until a
  stop event, a DHCSR read that answers or the session's end, and
  `getSessionStatus()` reports its age without reading the target.
- **Reset.** `resetTarget()` hands over to `performReset()` in
  `src/executor/targetReset.ts`. A running target is halted first; each
  method is sent as GDB monitor commands in the dialect of the GDB server
  behind the session (`src/core/resetAssist.ts`), after which GDB's register
  and memory caches are flushed, since GDB does not see a reset done by a
  monitor command (the CMSIS Solution launch templates do the same); the
  reset counts only when the PC afterwards equals the reset vector of the
  table VTOR points to. A method means the same reset on every server:
  `system` is SYSRESETREQ, `core` VECTRESET and `hardware` the reset line,
  which J-Link knows as its normal, core and reset-pin strategies, numbered
  as in the CMSIS Solution launch templates. The method `auto` escalates
  from `system` to `core` to `hardware` until one verifies, and the target
  is resumed only after a verified reset with `halt: false`. When none
  verifies, the reply (`renderResetOutcome()`) says the target is halted
  and names a next step that needs no one at the board:
  `stop_debugging`, then `cmsis_action load_and_debug`, which brings
  back J-Link targets and secure-boot parts whose core nSRST alone does not
  re-vector; power-cycling comes only after that (#20).

`SERVER_VERSION` is exported by `src/debuggingExecutor.ts` and is the
`version` of `package.json` as it was when the code was compiled or bundled,
so `npm version` (locally, or in CI from the release tag) is the only place a
version is set; `test/transport/executor-cases.js` checks the two agree.

## Known deviations

Some behaviour is known to be wrong and was kept on purpose so that the
rewrite could be reviewed as behaviour-neutral: the workbench fallbacks of
adapters other than the CMSIS Debugger act on VS Code's focused session,
which need not be the one the request went to; every frame lookup costs a
`stackTrace` request. Comments in the code number each case (`KB1`, `KB7`,
`KB8`, …); the list is in the *Known bugs to preserve* section of
`docs/provenance/specs/debuggingExecutor.md`. KB1 and KB2 (the workbench
fallbacks and restart) no longer apply to the CMSIS Debugger since #13; KB3
(the `-exec` prefix) is fixed by #56, and of KB4 only the `set` fallback of a
memory write and the reset still judge GDB's reply by its text alone.

## A failed start opens no dialog

When a launch or attach fails, VS Code shows the adapter's error as a modal
dialog ("could not connect: Operation timed out." with "Open 'launch.json'")
unless the error says `showUser: false`; the CMSIS Debugger's adapter marks
every start error for the user. Nobody may be at the screen when an agent
started the session, so the executor's starts (`startDebugging`,
`startDebuggingByName`, `restart`) and `cmsis_action load_and_debug` and
`attach` call `expectAgentStart()`: sessions that begin within the next
three minutes, and their child sessions, count as the agent's. For those,
the adapter tracker sets `showUser: false` on a failed `launch` or `attach`
response (`quietStartFailure()`), which it is handed before VS Code reads
it. The agent has the error in its tool result and the problem journal; the
user gets a plain notification. A session the user starts keeps VS Code's
dialog. That the tracker sees the response before VS Code does is how the
extension host works today, not a documented promise of the API, so a VS
Code update needs a look at this.

## Where to look

| File | Contents |
| ---- | -------- |
| `src/debuggingExecutor.ts` | `DebuggingExecutor`, `SERVER_VERSION`, the run-control table, GDB passthrough, memory, registers, DWT, peripherals, fault status, reset entry |
| `src/executor/contract.ts` | `IDebuggingExecutor` and its six parts, `HardwareTimeouts`, `SessionStatus`, `DapThread`, `MemoryRead`, `ResetOutcome` |
| `src/executor/common.ts` | `Budgets`, `DEFAULT_HARDWARE_TIMEOUTS`, DAP reply shapes, `sessionOrThrow()`, `focusedThreadId()`, `toStackFrame()` |
| `src/executor/snapshot.ts` | `captureDebugState()` |
| `src/executor/gdbCommand.ts` | `runGdbCommand()`: the adapter's prefix, output capture and settle |
| `src/core/gdbDialect.ts` | GDB prefix per adapter, the agent's passthrough spellings, MI memory results, GDB's refusal of a run-control request |
| `src/executor/gdbMemory.ts` | address helpers, `bytesInRange()` for a DAP `readMemory` reply, `readWordThroughGdb()`, `MemoryReadFailure`, the DHCSR read `probeDebugPort()`, `explainReadFailure()` |
| `src/core/probeWedge.ts` | `classifyReadFailure()`: `PROBE_WEDGED` or `INVALID_ARGUMENT` after the DHCSR read, the reconnect hint per `request`, `S_LOCKUP`; `coreVerdict()` and the texts of a core that answers or does not |
| `src/executor/sessionReports.ts` | `probeSession()`, `takesRequests()`, `connectionReport()`, `deviceReport()`, `launchFolderFor()` |
| `src/executor/targetReset.ts` | `performReset()`, `programCounterFrom()` |
| `src/utils/sessionStateTracker.ts` | session choice, stop events and waits, the wait for VS Code's frame after a stop (`armFocusWatch()`), session end, the adapter channel's problems for the problem journal (#48), GDB command output, answers to `setBreakpoints`, GDB logpoints per session, the starts an agent asked for (`expectAgentStart()`, `quietStartFailure()`), the last DHCSR read that got no answer (`noteCoreVerdict()`, `coreSilentSince()`) |
| `src/utils/timeout.ts` | `withTimeout()`, `customRequestWithTimeout()`, `HardwareTimeoutError` |

## Tests

- `test/transport/executor-cases.js`: the executor alone against scripted
  debug sessions — DAP requests and their arguments, workbench fallbacks and
  GDB refusals, restart, timeouts, the readiness probe on an adapter that
  takes no requests, reset verification, GDB command prefixes and output
  capture, breakpoint bindings, DAP `readMemory` replies that begin later or
  end sooner than asked, the GDB word-read ladder and the DHCSR read after a
  failed read
- `src/test/gdbMemory.test.ts`: the ladder's causes, `PROBE_WEDGED` and
  `INVALID_ARGUMENT` after the DHCSR read, timeouts, lockup, the hints; the
  DHCSR read of `check_target_connection` and the verdict the status keeps
- `test/transport/dap-scenarios.js`: the executor behind the handler and the
  server in scripted scenarios, mostly `gdbtarget` sessions, a wedged
  probe and an adapter that is still connecting among them
- `src/test/sessionStateTracker.test.ts`, `src/test/gdbDialect.test.ts`: the
  output capture, the `setBreakpoints` wait, the logpoint registry, the
  prefixes
- `src/test/timeout.test.ts`: the timeout helpers
- `test/realboard/run.ts`: every tool against a real board, run by hand
