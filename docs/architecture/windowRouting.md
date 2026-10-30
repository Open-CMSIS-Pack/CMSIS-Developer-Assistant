# Multi-window routing

Each VS Code window runs its own extension host, with its own debug sessions,
its own probe connection and its own CMSIS solution. A debug session in one
window is invisible to the extension in another. Agents, however, are given
one URL, `http://localhost:<serverPort>/mcp` (port 3001 by default). The
routing layer connects the two:
exactly one window serves MCP, and every tool call runs in the window that
owns the workspace or the board the call is about.

## Roles

- **Router.** The window that bound the MCP port. Its `DebugMCPServer`
  accepts the MCP sessions and forwards every tool call.
- **Worker.** Every other window. It executes calls forwarded to it and
  retries the port every 10 s, so that one of the workers takes over when the
  router window closes and the agents' URL keeps working. A retry first asks
  whether anything accepts a connection on the port (`portAnswers()`); only
  a free port gets a `DebugMCPServer`, so a worker does not build and discard
  a server every 10 s. The new router
  answers the clients' old session ids with 404, which tells a client to
  open a new session (#14). When the router window stops running without
  closing, the workers tell their users (#14).
- Every window, the router included, runs a `ControlServer` and executes its
  own calls through it. Routing to itself costs one loopback hop and keeps a
  single code path; a local shortcut would be a second path that only the
  router exercises.
- Every window advertises the router's URL, also to Copilot in the editor
  (the MCP server definition in `src/extension.ts`), so in-editor and
  external agents agree on which window owns a board.
- Every window publishes its role in its registry entry (`role`, since
  2.5.1) and shows it in the status bar (see
  [Window selection for people](#window-selection-for-people)).

The log tells state, not routine: a window says once that it is a worker or
the router, one line names a window that joins or leaves the registry (seen
by the heartbeat), and the bids for the port, their usual failure and the
release after it are debug lines.

## The pieces

| File | Responsibility |
| ---- | -------------- |
| `src/windowCoordinator.ts` | `WindowCoordinator`: starts the control server, publishes the window, tries to become router (`tryBecomeRouter()`), polls for promotion, gives each MCP session a new `RoutingDebuggingHandler` (`sessionHandlers()`), and owns the window's status-bar item |
| `src/utils/workspaceRegistry.ts` | `WorkspaceRegistry`: the machine-wide list of windows, one JSON file per window, and the default target |
| `src/routingDebuggingHandler.ts` | `RoutingDebuggingHandler`: picks the target window for a call and forwards it; answers `list_debug_windows` and `select_debug_window` |
| `src/controlServer.ts` | `ControlServer`: receives a forwarded call and runs it against this window's handlers |
| `src/core/opTable.ts` | the names of every op that may cross a window boundary, shared by both ends, the internal ops, the channel's timings and budgets; `targetHintOf()` |
| `src/core/windowHealth.ts` | what a window knows about its own health: the busy table, the event-loop lag, the notice gate; the router watch, and `probeLoopback()`, the one-request probe behind the health check and the port check |
| `src/windowStatus.ts`, `src/core/windowStatus.ts` | the status-bar item and Select Target Window: the wiring, and the pure rendering |
| `assets/icons/cda-robot.svg`, `assets/icons/cda-icons.woff` | the robot artwork and its one-glyph font, contributed by `package.json` as the product icon `cda-robot` |
| `src/utils/loopback.ts` | the `Host` and `Origin` checks, shared by the control server and the MCP endpoint |
| `src/core/gdbServerPorts.ts`, `src/core/gdbPortGuard.ts`, `src/core/gdbPortReservations.ts` | the GDB ports a window publishes, the atomic cross-process startup reservations, and the existing-owner/bind preflight |

## The registry

Each window keeps `window-<pid>.json` in a directory under `os.tmpdir()`: the
control port and token, the workspace folders, the window name, whether a
debug session is active and with which configuration, the CMSIS solution
path when the CMSIS Solution extension reports one (its `getSolutionFile`
command, asked only while that extension is active, since running it would
activate it; a changed answer is published at once), and its role (`router`
or `worker`; windows of 2.5.0 and earlier write none). Since 2.5.1 it also
holds the extension `version`, and from the first heartbeat on `lagMs`, the
event-loop delay of the last 20 s, and `busy`, the agent calls running there
for more than 10 s (#14). Since 2.7.0 it lists `gdbPorts`, the local GDB
ports the window's live debug sessions and CMSIS Run tasks use (see
[GDB ports](#gdb-ports)). The file is written atomically, refreshed every
20 s, and rewritten at once when a debug session starts or ends, VS Code's
focused session changes, or the folders change — the session state is what
routes every call that names no file. `hasActiveSession` comes from the
session tracker's live sessions, not from `vscode.debug.activeDebugSession`
alone, which still names a session while `onDidTerminateDebugSession`
announces its end (VS Code moves the focus afterwards); the configuration
is the focused session's while it is live, else the most recent live
session's (`registrySession()` in `src/utils/sessionStateTracker.ts`). The
heartbeat takes a patch, so it brings `busy` and `lagMs` up to date as it
refreshes the time. Readers drop the files of processes that no
longer exist and of other windows not refreshed for 60 s, with one
exception: the router's entry stays, skipped, while its process lives (up to
an hour), because it names the window that holds the MCP port when that
window has stopped running (`findStaleRouter()`, see
[A router that stopped running](#a-router-that-stopped-running)).
Unreadable files and leftover temporary files go once they are a minute old,
since a peer may still be writing a younger one. Windows of different
extension versions read each other's files, so the format stays stable and
readers ignore fields they do not know. The first field, `_note`, is for
whoever opens the file: it says the file is internal and names the tools
agents use instead.

Beside the window files lies `default-target.json`, written 0600 by
Select Target Window: `{pid, workspaceFolder, name, setAt}`. Readers of every
version pass it by, since its name does not start with `window-`. Whoever
can write it steers path-less agent calls, so it is read only from a
directory this user trusts, like the window files.

A token in the registry is enough to flash or erase that window's board, so
only its user may read the registry (#19):

- **Where.** `resolveRegistryDir()` keeps the name
  `cmsis-developer-assistant-registry` where the temp directory is private to
  the user (macOS `$TMPDIR`, Windows `%TEMP%`, a folder in the home
  directory), so windows of 2.5.0 and earlier stay visible there. Where every
  user may write to the temp directory (Linux `/tmp`, macOS without
  `TMPDIR`), it appends the uid, so another user cannot take the one name all
  windows of this user look for. `os.tmpdir()` is the same in every extension
  host of the user, so all windows agree.
- **Modes.** `ensureRegistryDir()`, called by `register()` and `heartbeat()`,
  creates the directory 0700 and narrows an existing one of this user that
  others may enter (0755 before 2.5.1). The files are written 0600
  (`writeFileAtomicSync(…, { mode })`), and the heartbeat replaces an older
  0644 file within 20 s. Windows has no modes; the ACL of `%TEMP%` applies.
  There a rename onto the file fails for a moment while a virus scanner
  holds it; the writer tries again for up to 310 ms, so a session's end is
  not lost and the window does not stay "debugging".
- **Refusal.** A directory that is a symbolic link, not a directory, or owned
  by another user is not written and not read. The window logs an error,
  shows one warning (`onRefused`), and `list()` returns only its own entry,
  so its tool calls still reach it while the other windows stay out of
  reach. Each heartbeat looks again and registers once the directory is fit.
- **Not solved here.** A process of the same user can read the files; that
  case is for agents to leave alone (the tool contract), not for file modes.
  The token is not rotated: a router caches a window's entry, token
  included, and checks only pid and port, so a new token would turn its next
  forward into a 403.

## Choosing the target window

`RoutingDebuggingHandler.resolveTarget()` walks a fixed ladder; the first rung
that applies decides:

1. **Window argument.** The tools in `WINDOW_ARGUMENT_TOOLS` take `window`
   in a routed session (#16): all digits is a process id, anything else a
   path inside the window's workspace (`targetHintOf()`). For `cmsis_action`,
   `flash`, `reset`, `serial_open` and `serial_capture`, it re-aims the
   session: the calls after it go to the same window, unless the session is
   pinned. `knowledge_search` uses it only to choose that search's project
   context and leaves the session's target unchanged (see below).
2. **Path.** A call that carries `fileFullPath` or `workingDirectory` goes to
   the window whose workspace folder contains it most deeply. A pin does not
   override the path of `start_debugging`: a file is launched in the window
   that holds it. The breakpoint ops (`add_breakpoint`, `add_logpoint`,
   `remove_breakpoint`) of a pinned session are the exception
   (`resolveForBreakpoint()`): a breakpoint acts on the debug session that
   binds it, and the program a session debugs may be built from sources in
   another window's folder, so they go to the pinned window whatever file
   they name, unless only the file's own window has a debug session. A file
   outside the pinned window's folders adds one line to the answer. A file
   that no window's folders contain, such as a pack source the firmware is
   built from, does not end the ladder: the call takes the rungs below, as a
   call without a path would, and the answer says where it went. Only when
   they find no window either is it refused, as a tie that names the file.
3. **Pin.** The window chosen with `select_debug_window`, by process id or by a
   path inside its workspace, for the rest of the MCP session. A reload gives
   the window a new pid: the pin keeps the window's folders and moves to the
   one window that has them (`followPin()`), and the next answer says so once.
4. **Cache.** The window this MCP session reached last, while it is still
   registered on the same control port.
5. **Default target.** The window the user chose with Select Target Window,
   found by its pid, or by its folder once a reload gave it a new pid.
6. **The only debugging window.** The one window with an active debug
   session.
7. **The only window.** The one registered window.

`cmsis_action open_solution` is routed by the path it carries, because its
job is to bring a window into being (`resolveForOpen()`): it goes to the
window that has that folder open, else through the ladder, and where the
ladder would refuse a tie it runs in the router's own window, since any
window can open a folder. When the worker opened a new window (its reply
carries `data.newWindow`), the router waits up to 30 s for a window with that
folder to register (`followOpened()`), makes it the session's target and says
so in the result; a pin stays, and the result then says how to reach the new
window. For a CLI client a window without any folder opens the folder in
itself and reloads (`data.reloads`); when that window is the router, every
session is gone for a few seconds and the clients reconnect to the same
port once it is back, which Claude Code does without the agent noticing. A
client inside the window never gets the reload (`src/core/clientHosting.ts`).

`cmsis_action install_pack` carries no path. It goes through the ladder like
any call, and a tie it would refuse runs in the router's own window
(`resolveAnyWindow()`, shared with `open_solution`) without becoming the
session's target: a pack is installed into the machine's pack root, whichever
window runs the command.

`cmsis_action create_solution` is routed by its path as well
(`resolveForCreate()`), first to a window whose only folder is that path:
CMSIS Solution opens the project it created in the window that created it,
and only such a window stays as it is. Without one the call goes where
`open_solution` would, and the worker refuses a window that would lose its
folder; nothing is followed afterwards. `cmsis_query` reads CMSIS Solution's
catalog, which every window answers alike, so it takes the ladder and, where
the ladder would refuse a tie, the router's own window
(`resolveAnyWindow()`, which `open_solution` uses for its tie too).
`serial_list_ports` goes the same way: the serial ports belong to the
machine, and every window lists the same ones. The other serial tools keep
the ladder, since a port is opened and read in one window.

`get_session_status` is the call agents make when another one failed, and
its description promises that it never fails. On a tie it is therefore
answered, not refused (`resolveForStatus()`, `statusWithoutTarget()`): with
idle windows `State: no-session`, why there is no target, and the windows;
with several debugging windows `State: no target window`, and each of them
with the state line its own status gives within 5 s, asked all at once
(`State: stopped`, or `State: unknown` with why); then the same ways to
choose as the refusal (`tieOf()`). Nothing becomes the session's target. An
empty registry and a pinned window that is gone still fail as below.

The knowledge ops are routed with the documentation ops, because the
project context of a `knowledge_search` is the active target of one window;
but the index needs no window. So they take the ladder, and where it would
refuse — a tie of idle windows, or no window it can name — they run in the
router's own window, scoped by that window's project if it has one, without
making it the session's target (`resolveForKnowledge()`). The reply of
`knowledge_search` says on its `Indexes:` line whose context was used
(`withKnowledgeWindow()`), and in the fallback case how to search with
another project's context: `knowledge_search` is one of the
`WINDOW_ARGUMENT_TOOLS`, so `window` names the window whose project scopes
the search, without making it the session's target. The documentation ops
keep refusing the tie: their manuals belong to one window's target.

The default target comes after the cache so that a path the agent named
keeps its window within the session. For a click in the status bar to take
effect at once all the same, every session remembers the `setAt` of the
default it last saw (`followDefault()`): a new one drops the session's cache,
never its pin. Removing the default leaves each session where it is.

Otherwise the call — except for the ones above, which any window can
answer, and `get_session_status` — is refused with the list of windows and
the ways to pick one — when two windows are debugging, reading memory from the wrong board
would look exactly like a firmware bug, so the router never guesses. The
refusal is `AMBIGUOUS_WINDOW`, and its `data.candidates` lists every
registered window (`pid`, `name`, `workspaceFolders`, `hasActiveSession`,
`isDefault`, and `role` for windows that publish one); its hint names
`select_debug_window` and the status bar, and a default target whose window
is not open. An empty registry and a pinned window that is gone, with no
single window of the same folders to follow, are `WINDOW_UNREACHABLE`; a path inside no workspace, a `window` argument that
matches nothing (with the same candidates in `data`), and a
`select_debug_window` without a selector or without a match are
`INVALID_ARGUMENT`. `list_debug_windows` shows every registered window, marks
the router, the current target, the pin and the default target, and the
reply of `select_debug_window` says when the pin overrides a default. Its
lines (`describeWindow()`) also name the calls busy in a window, with their
age and whether they are past their fence, and an event-loop lag above 1 s:
`pid=4711 | … | router | busy: cmsis_action 240 s | event-loop lag 4.2 s`.

## GDB ports

Routing keeps each call in its own window, but GDB servers share the
machine's ports, and CMSIS Solution gives its pyOCD, J-Link and FVP set-ups
the same one, 3333. A live test showed what follows. Window A's CMSIS Run task (pyOCD) listened on
127.0.0.1:3333; an FVP launch in window B, whose container Docker publishes
on `*:3333`, connected GDB to pyOCD before the model was up, halted A's
board, and the launch still read as a success with an empty stack. And the
FVP shim's `docker rm -f` of the container on its port ended a session of
another window. Neither window could tell, since a debug session in one
extension host is invisible to the others.

So every window publishes the ports it uses, and a launch reserves before
it looks:

- **Publishing.** `WindowCoordinator` lists, as `GdbPortClaim`s in its
  entry's `gdbPorts`, the port of each live CMSIS Debugger session
  (`target.port`, or for a launch the port its GDB server's parameters set,
  such as the FVP's `GDBServer.port`, else for pyOCD the ports of the
  cbuild-run file it reads, `sessionGdbPorts()`) and of each live CMSIS Run task (the
  port its command line sets, else for pyOCD's `gdbserver` the ports of the
  cbuild-run file it reads, else the server's default) — with the
  configuration or task name and the server (`windowGdbPorts()` in
  `src/core/gdbServerPorts.ts`). It looks again when a session or a task
  starts or ends, and on the heartbeat, and republishes only a change. The
  field is optional: older windows write none and ignore it, and readers
  take it through `gdbPortClaimsOf()`, which drops what it does not know.
  `describeWindow()` names the ports in the window listing.
- **Reserving.** A free-port check alone races another window's start.
  `GdbPortReservations` therefore atomically publishes a complete owner
  record in the user-private registry before any asynchronous check or
  launch. A contender gets `PROBE_BUSY` even before the winner's server
  listens. The reservation does not bind the port. It has no timeout:
  programming or a picker may outlast the tool call. The coordinator
  adopts it when a session/task claims its port, or a handler confirms the
  session/run is live, and releases it when that owner ends; alternative
  launch ports acquired together end as one batch. A debug session takes
  the reservation of its port when its adapter starts
  (`onSessionBegins()` of the session tracker, `adoptPort()`): VS Code
  announces a session only once its launch succeeded, so a failed launch
  after an early reply would otherwise leave the port reserved.
  A confirmed completed Run releases its batch even when it ended before a
  port sample saw it. A sample captured before acquisition, or superseded
  by a newer state-change notification, cannot adopt a pending reservation.
  Confirmed startup failures and window shutdown release only their own
  unique records; another window can reclaim a dead process's record.
  Unknown or malformed owners fail closed. The registry root and the
  reservation directory have the same ownership and symlink checks.
- **Checking.** After reserving, `cmsis_action load_and_debug` (for each launch
  configuration of the active target that fixes a port: those of its
  cbuild-run debugger, FVP or not, on that file's GDB ports,
  `activeLaunchConfigurations()`), `run` and `load_and_run` (for the ports
  of the CMSIS Run task in `tasks.json`), and `start_debugging` of a launch
  configuration with a fixed port, the handler asks
  `HandlerHost.gdbPortHolder()`: the other windows' claims first, which the
  coordinator hands its `DebuggingHandler` from the registry; else a bind
  test (`portInUse()` in `src/core/gdbPortGuard.ts`) on 127.0.0.1, ::1 and
  the wildcard, each closed at once. A claimed or taken port refuses the
  start with `PROBE_BUSY` (`gdbPortRefusal()`): the port, the window and
  what holds it there, or that another program listens, and the way out —
  stop it there, or another port.
- **Never a connection.** A GDB server takes any connection as a client,
  and pyOCD halts its target for one, so the check binds, never connects.
  The binds run one after the other: on Linux our own open loopback probe
  would make the wildcard bind fail. On macOS a bind notices only a
  listener on the same address, which is why all three are tried: pyOCD
  listens on 127.0.0.1, Docker on the wildcard.
- **Limits.** `attach` connects to a server that is meant to listen.
  Reservations cover fixed local ports that the configuration or task
  resolves before launch, and cooperating windows of this version. They
  cannot reserve an unresolved/dynamic port or stop an unrelated program
  or an older extension from starting after the bind check.
  A listener that is no window's — a GDB server started by hand, or a model
  an earlier session left behind — is refused as "another program": the
  check cannot tell which of them it is, only that GDB would reach it.

## Forwarding

The router POSTs `{op, args}` to `/op` on the target window's control port,
with the window's token in the `x-cmsis-developer-assistant-token` header,
and returns the `result` as the tool's answer. Both ends take the op names
from `src/core/opTable.ts`: the debugging ops (the `IDebuggingHandler`
method names), the serial ops and the documentation and build-artefact ops.
The table is checked at compile time against the handler interfaces, and the
router's forwarding methods are generated from it, so a new tool is routable
without further code. The `window` argument is the router's alone: it is
taken out of the arguments before they are sent.

- The router gives a forward a budget of the tool's timeout plus 15 s, so
  the worker's own, more specific timeout answer arrives first. `cmsis_action`,
  `flash` and the documentation ops, which can take minutes, get at least ten
  minutes (`forwardTimeoutMs()`). The budget is wall-clock time, and the
  envelope names it to the worker, whose fence answers 5 s before it runs
  out (see [Fences and health checks](#fences-and-health-checks)). A window
  that stays silent longer ends the call with `WORKER_TIMEOUT`; it is busy,
  not gone, so the session keeps it as its target, as long as it answered
  its last health check.
- Requests above 1 MiB and responses above 16 MiB are cut off; they only
  guard against runaways. The first reaches the router as a 413 and becomes
  `INVALID_ARGUMENT`, the second is `INTERNAL`; either way the window
  answered and stays the target.
- The worker's own failure comes back with its code and hint, and the
  session keeps its target (#11). Only a failed channel — nothing listening,
  a dropped connection, a 403 for a stale token, a 404, an answer that is not
  a control reply — makes the session forget the window, with
  `WINDOW_UNREACHABLE` and a pointer to `list_debug_windows`. Before #11
  every handler error crossed the channel as a 500 that the router reported
  as an unreachable window, dropping the target on the way.

### The envelope

The request carries the header `x-cmsis-developer-assistant-envelope: 2`
(`CONTROL_ENVELOPE_HEADER` in `src/core/opTable.ts`). A worker that knows it
answers typed and sets the same header on its reply: 200 `{result}` with the
`ToolText` as it is, or 500 `{error: {message, code, hint, data}}`. Without
the header — a router of 2.3.10 in a window not yet reloaded — the worker
answers in the old shapes, `{result: string}` and `{error: string}` with the
hint on the error's second line. The other way round, the router reads a
string without the header as a 2.3.10 result (`upgradeLegacyText()`): the
old fence failure `Error in '<tool>': …` becomes a classified `ToolError`,
the old fence cap a `timeout` reply; an `{error: string}` is classified the
same way. Both ends ignore fields they do not know, in the request body and
in the reply, so later additions need no new version.

Two such additions carry the problem journal (#48). The request names the
call it belongs to: `{op, args, callId, sessionId}`, from the call context
`MeasuredMcpServer` set, and the control server runs the op inside the same
context, so the target window's journal stamps its records with the id, and
`serial_open` records the MCP session as the holder of the port (#49). A typed reply carries the
target window's journal counters, `journalSeq` (the newest record) and
`journalErrors` (errors ever recorded), next to `result` or `error`. The
session's `ProblemNotices` keep a baseline per window pid: the first answer
sets it and `get_recent_problems` moves it. While errors lie beyond it,
`get_session_status` ends with a count line, and one successful result per
new batch ends with a note naming the `get_recent_problems` call to make. A
2.5.0 worker sends no counters, and then there is neither; a 2.3.10 router
gets no counters at all.

A third addition is the forward's budget, `budgetMs` (#14): how long the
router waits for this answer. A worker of 2.5.0 ignores it; a router of
2.5.0 sends none, and the worker then takes the budget its own router would
give the op, from its own `timeoutInSeconds`.

## Fences and health checks

A forwarded op that never settled used to hold the agent's call for the
whole budget — 195 s by default, ten minutes for `cmsis_action` — while
nothing told the worker, and nothing noticed an extension host that had
stopped running. `start_debugging` without a configuration name waited for
a person in a picker the agent could not see. The channel is now watched
from both ends (#14):

- **The worker's fence.** `ControlServer.dispatch()` races every op
  against a timer of the budget minus 5 s, at least 1 s
  (`workerFenceMs()`). When it fires, the router is answered
  `WORKER_TIMEOUT` — the tool, the window, and that it still runs there —
  and the window journals a warning with that code. The hint depends on
  what the op can wait for: a picker or dialog only for the ops that can
  open one (`USER_WAIT_OPS` in `src/core/opTable.ts`: `start_debugging`,
  `restart_debugging`, `cmsis_action`), the debug adapter or GDB for the
  other debugging ops, the op's own work for the rest. Nothing is
  cancelled: no API withdraws a DAP request, a task or a picker. The op
  stays in the busy table (`BusyTable`) until its promise settles; only
  then does the op hook hear its end, and its late result is logged and
  dropped. A router that gives up and closes the request is logged too.
- **What the user sees.** The op hook's `fenced` phase turns the window's
  status-bar item to the warning background while the call runs on. For an
  op that can wait for a picker or dialog, the coordinator also shows a
  warning, at most one per tool in ten minutes (`NoticeGate`), through
  `notifyWarning`, which journals it: the user is the only one who can
  close the picker or dialog. Any other op gets no warning, since the user
  cannot answer a debug adapter that is slow; the fence's journal record
  stays.
- **`health`.** An internal op (`INTERNAL_OPS` in `src/core/opTable.ts`):
  no tool, answered by the control server itself at once, never queued
  behind an op, never journaled or shown in the status bar. It answers the
  window's pid, version, role, uptime, event-loop lag since the last
  heartbeat (`LagMonitor`, from `perf_hooks.monitorEventLoopDelay`) and busy
  ops. A 2.5.0 window answers it 500, which counts as alive: any answer
  shows that the extension host runs.
- **The router's checks.** Before a call to a window it has not heard from
  for 30 s (or never), `RoutingDebuggingHandler` asks `health`, on a
  connection of its own, and allows 2 s. While a forward is pending it asks
  again every 15 s, and two misses in a row end the call. A window that
  misses is `WINDOW_UNREACHABLE` and forgotten as the session's target: its
  extension host is blocked, or it closed. A window that is busy but
  answers keeps its whole budget, however long a build takes. When the
  budget runs out, `WORKER_TIMEOUT` keeps the target only if the last check
  passed. The sessions of one router window share when each window last
  answered (`RoutingOptions.heard`).
- **Receiving.** A whole request may take 10 s to arrive and its headers
  5 s, where Node allows 300 s and 60 s: requests come over loopback and
  hold at most 1 MiB. These limits bound the receiving only, never the op.
- **Timings.** Every figure is in `CHANNEL_TIMINGS` and can be injected —
  `forwardTimeoutMs()`, `RoutingOptions`, `ControlServerOptions`,
  `CoordinatorOptions.timings` — so the tests of fences and checks run in
  milliseconds.

| Call | Router budget | Worker fence |
| ---- | ------------- | ------------ |
| `start_debugging` without `timeoutMs` | 195 s | 190 s |
| `cmsis_action`, `flash`, documentation ops | 600 s (floor) | 595 s |
| `read_memory { timeoutMs: 5000 }` | 20 s | 15 s (the handler's own cap answers at 5 s) |

### A router that stopped running

A router whose extension host is blocked keeps the MCP port bound, so no
other window can take over, and every agent's call waits in vain. No
extension can take a bound port or reload another window; what a worker can
do is tell its user. Each promotion poll that fails to bind
(`WindowCoordinator.pollPromotion()`, every 10 s) looks at two things:

- **The registry.** A `role: 'router'` entry not refreshed for 60 s whose
  process lives (`findStaleRouter()`). A router of 2.5.1 that runs keeps its
  entry fresh, and then nothing else is asked.
- **The port.** Whether `GET /mcp`, without a session, stays unanswered for
  2 s (`portSilent()`). A running router of any version answers it with a
  400 at once.

`RouterWatch` in `src/core/windowHealth.ts` decides: a stale router entry
and a silent port give one warning per episode, which names the window —
"the router window (pid 4711, CDA-Testdrive) has not responded for 75 s, so
agents cannot reach any window. Reload or close that window; another window
takes over automatically." — with **Show Log**. A router of 2.5.0 writes no
role; when no entry says it is the router and the port has stayed silent
for a minute, the warning names "the window serving port 3001" instead. The
episode ends when the port answers again or the window takes the port.
Every worker window warns, since each one polls.

## The control server

`ControlServer` listens on an ephemeral port on `127.0.0.1`. The ops include
flashing and erasing the target, so a request passes three checks, in this
order, before its body is read:

1. `POST /op`, else 404.
2. A loopback `Host` (`isLoopbackHostHeader()`) and no `Origin` header at
   all, else 403. The router sends `Host: 127.0.0.1:<port>` and never an
   `Origin`; a browser page always sends one, so this keeps DNS-rebinding
   pages out even though they cannot read a token.
3. The window's token, compared with `crypto.timingSafeEqual` after a length
   check on the bytes, else 403. A header sent twice never matches, and
   nothing in the comparison can throw.

The 403 and 404 bodies are JSON that names `list_debug_windows` and
`select_debug_window`, for an agent that found the port by itself. Routers
read only the status of a 403 or 404, so the body changes nothing for them.

The server then answers an internal op itself (see
[Fences and health checks](#fences-and-health-checks)), and checks any other
op name against the op table before looking up any method, dispatches it to
the debugging handler, the serial handler, or the documentation or
build-artefact handler inside its fence, and answers `{result}` with 200 or
`{error}` with 500, in the envelope the request asked for (see above). An
unknown op, a method the window lacks and absent documentation handlers are
`TOOL_DISABLED`.

Before the op table come the internal ops (`INTERNAL_OPS`), which are no
tools: the server answers them itself, outside the op hook of the status bar
and the problem journal. `sessionEnded {sessionId}` (#49) is one: the router
posts it, fire-and-forget with 2 s, to every window an MCP session forwarded
to once the session ended (`RoutingDebuggingHandler.sessionEnded()`, which
remembers those pids per session), and the window releases the serial port
and the Serial Monitor subscription the session held there (see
[serial.md](serial.md)). A window of an earlier version answers "not a known
operation", which the router ignores.

All other ops run through `runJournaled()`: registered in the window's
problem journal while they run, and when they fail or their wait runs out,
up to five records they produced ride along in `data.problems`. Their trace
lines log the size of the result's text. Agents never see the token:
`describeWindow()` leaves port and token out of every listing.

## Window selection for people

Agents have `list_debug_windows`, `select_debug_window` and the `window`
argument; the user has the status bar (#16). Without it, two idle windows
were a tie that only the agent could settle, and nothing showed which window
was the router or which window an agent was driving.

- **The item.** Every started window shows one status-bar item,
  `cmsis-developer-assistant.window`, named "CMSIS Developer Assistant" so the
  status bar's own menu can hide it: `$(cda-robot) R` (router) or
  `$(cda-robot) W` (worker), `· default` on the default target, and a spinner while
  an agent call runs in the window. Its tooltip gives the MCP endpoint, the
  default target under "Default target windows:", the calls running and the
  last one; in the router window also every open MCP session with the window
  it drives and the rung that chose it. While a call runs on past its fence
  it has the warning background (#14). The item shows with a single window
  too: it confirms the server runs.
- **Its sources.** `ControlServer.onOp()` tells the window when an op starts,
  outlives its fence and ends, with a ticket per run; every call arrives
  that way, the router's own included. The
  router asks its `DebugMCPServer` for `describeSessions()`, which reads each
  session's `RoutingDebuggingHandler.describeTarget()` from memory. The
  default target is read again on the 20 s heartbeat, and at once in the
  window where the user chose it, so other windows show a new choice within
  20 s while routing follows it on the next call. A 5 s tick keeps the times
  in the tooltip current.
- **The command.** `cmsis-developer-assistant.selectTargetWindow`, the item's
  click, offers the registered windows (name, folders, role, debug session,
  solution) and **Automatic**; the choice is written to `default-target.json`
  (see [The registry](#the-registry)), Automatic removes the file. The
  command is registered in every window, and says so when no coordinator
  runs (the test runner).
- **Where to look.** `renderWindowStatus()`, `targetChoices()` and
  `toolNameOf()` in `src/core/windowStatus.ts` are pure; `WindowStatus` in
  `src/windowStatus.ts` holds the item, the tick and the quick pick; the
  coordinator creates it at the end of `start()` and re-renders it when the
  window becomes router.
- **The serial item.** A second item, apart from this one, shows only while
  an agent holds a serial port in the window, and its click releases the
  port (#49, see [serial.md](serial.md)).

The default target is honoured by routers of 2.5.1 and later; a router of
2.5.0 in a window that was not reloaded ignores the file.

## Shutdown

`WindowCoordinator.dispose()` first disposes the status-bar item and removes
the window from the registry, so no other window forwards into a closing
extension host, then stops the MCP server and the control server, then
releases the window's serial ports, giving that step at most two seconds.

## Tests

- `src/test/routing.test.ts`: the ladder, pins, refusals and a control-server
  round trip; the breakpoint ops of a pinned session; `serial_list_ports` and `get_session_status` on a tie (the
  router's own window; the status across idle and debugging windows, a
  window that does not answer); typed outcomes — a worker error with its code and the target
  kept, a dead port, a silent window, 2.3.10 replies, both envelopes; the
  gate — wrong, doubled and non-ASCII tokens, `Origin`, a foreign `Host`; the
  default target, the `window` argument, the candidates' `isDefault` and
  `role`, and the op hook (#16); the problem journal — the call id in the
  envelope, the counters in the reply, a worker failure with its problems,
  the note once per batch and after `get_recent_problems` none, no note from
  a worker without counters; the end of a session — `sessionEnded` only to
  the windows it reached, once, an old or silent window passed by, and the
  control server's own answer without the op hook; fences and health checks
  (#14) — a handler that never answers, a late settle, a budget from the
  window's own timeout, `health` while an op hangs, the receive limits, a
  blocked window, a window that stops answering mid-call, a budget that ends
  after a missed check, a 500 as alive, the quiet rule
- `src/test/windowHealth.test.ts`: the busy table, the notice gate, the
  event-loop lag, seconds in messages; the busy calls and the lag as the
  registry lists them; the router watch's episodes and the port probe
- `src/test/workspaceRegistry.test.ts`: registration, pruning and path
  matching; the directory name, modes, and refused directories; the default
  target file and how its window is found again; a stale router entry
  skipped but kept, a stale worker entry pruned, the heartbeat's patch, and
  the busy calls, lag and GDB ports in `describeWindow()`
- `src/test/gdbServerPorts.test.ts`, `src/test/gdbPortGuard.test.ts`: the
  GDB port of a configuration, a session and a CMSIS Run, the cbuild-run
  file's ports, the claims a window publishes and what readers admit; the
  bind test against servers on 127.0.0.1 and the wildcard without a client,
  the holder, the refusal texts
- `src/test/windowStatus.test.ts`: the item's text and tooltip in every state,
  the Select Target Window entries, and a tool name for every op
- `src/test/atomicFile.test.ts` and `src/test/loopback.test.ts`: the writers'
  `mode` option and the loopback checks
- `src/test/windowCoordinator.test.ts`: the serial teardown on dispose; the
  role and version the window publishes; the debug session it publishes — a
  session that ends while still focused, the one that remains of two, a
  change of focus; the GDB ports it publishes, again on a change, and the
  other windows' ports it gives its handler; the warning about a router that
  stopped running, once per episode, none for a healthy router, and by
  port for a router of 2.5.0 (injected notifier and clock)
- `src/test/opTable.test.ts`: the op table and `targetHintOf()`
- `test/transport/two-window-routing.js`: two coordinators against one
  registry — one router, one worker, the same advertised endpoint, pinning,
  republishing on session start, `AMBIGUOUS_WINDOW` with two candidates when
  both debug, promotion when the router closes; roles and status-bar items,
  `window` on exactly the listed tools, `cmsis_action {window}`, a default
  chosen through the quick pick resolving the tie of two idle windows;
  problem records and the count of new errors from the target window only; a
  worker whose handler never answers, with `WORKER_TIMEOUT` inside the
  budget, one notice and the warning background (#14)
