# Changelog

All notable changes to CMSIS Developer Assistant will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.5.10] - 2026-09-30

### Added
- **An agent can start in an empty VS Code window: no folder open, no project on disk.**
  - Every document and every tool assumed an open csolution project. In a window without a folder, `cmsis_action` answered "no active solution", `flash` "No workspace folder open", each in its own words, and none said what to do before a folder exists.
  - **`cmsis_action open_solution`** with `path` (the absolute path of a `*.csolution.yml` or of its folder) opens a project. A folder that a window already has open is used there, and the solution is made the CMSIS Solution extension's active one (verified; refused under a live debug session). Any other folder opens in a **new** VS Code window, so the window that answers keeps running, the MCP server with it, and the agent's session is not cut. It is the one action that needs no open project.
  - With several windows, the router sends `open_solution` to the window that has the folder open, else to the session's target, and on a tie to its own window, since any window can open a folder. After a new window was opened it waits up to 30 s for that window to register, makes it the session's target and says so in the result: "The window registered as pid 4711 (Blinky); this session's calls now go to it." A pin from `select_debug_window` stays, and the result then says how to reach the new window.
  - **New error code `NO_WORKSPACE`.** `cmsis_action` and `flash` answer it when no folder is open, with one hint: `open_solution` for an existing project, the `bootstrap` topic for a new one. A window of an earlier version reads the code as `INTERNAL`, message and hint intact.
  - **Without an active solution, `cmsis_action` says which part is missing**, each `CMSIS_NO_SOLUTION` with its own next step: the CMSIS Solution extension is not installed (install the Keil Studio Pack); the open folder has no `*.csolution.yml` (create the solution, or open the right folder); a csolution exists but the extension has not loaded it (`open_solution` activates it, `get_recent_problems` shows what the extension reported). Before, all three read "no active solution" with the same three fixes.
  - **`get_session_status`** adds, while no debug session runs in a window without a folder, a `Workspace:` line and, when the CMSIS Solution or the CMSIS Debugger extension is missing, an `Extensions:` line. A window with a folder gets neither.
  - **`get_debug_instructions { topic: 'bootstrap' }`** is a new topic of the guide: what each missing part looks like and the next step for it, how `open_solution` behaves, what stays with the user (installing extensions, the prompts of the tools environment, connecting the board), and which shell commands a bootstrap may use. The overview's own text may now be 3 300 bytes (3 200 before), for the topic's line in the list.
  - `tools/list` grows by 280 bytes for the action, its `path` argument and the topic name: 31 566 of 32 000 in one window, 33 374 of 34 000 routed, 43 316 of 44 000 with every group on.
- **Skill `cmsis-bootstrap` (always installed): from an empty VS Code window to a CMSIS solution that builds and debugs.**
  - It reads `get_session_status` to find out what is missing, asks for the board, the folder, the compiler and the probe, writes a starter `vcpkg-configuration.json` for the Arm Tools Environment Manager, hands the project creation to `start-cmsis-project`, opens the folder with `cmsis_action open_solution`, builds, and hands over to the debugger setup and to `cmsis-debug-live`.
  - It names every shell command it allows (`code --install-extension` when the user agrees, and the commands of the environment and project skills), so the tool rules hold during a bootstrap. Installing a compiler, and the download and licence prompts of the tools environment, stay with the user.
  - `start-cmsis-project` is proposed to [Open-CMSIS-Pack/cmsis-skills](https://github.com/Open-CMSIS-Pack/cmsis-skills) and reaches the AI Skills Pack from there. Until it is installed, `cmsis-bootstrap` copies an example of the board's pack (`csolution list examples`), or asks the user to run **CMSIS: Create Solution**.
  - It is bundled because an empty window has no project to install skills into. `/cmsis-help` lists it, and the `cmsis-project` entry point names it as the first step when no solution exists.
- **Three skills of this extension to select in the AI Skills Pack.**
  - `cmsis-debugger-setup` (in `cmsis-project`): choose the debug adapter from `csolution list debuggers`, set the `debugger:` node of the target set, let the CMSIS Solution extension write `launch.json` and `tasks.json`, and verify on the target with `cmsis_action load_and_debug`, a breakpoint and the serial console.
  - `fvp-debug-setup`: make **Load & Debug** and **Run** work against an Arm FVP through the model's GDBServer plugin: the `Arm-FVP` debugger node, the two readiness fixes of the generated launch configuration, a model shim that finds the plugin and line-buffers the model, and a Docker image for macOS, where Arm ships no FVP build. Verified through `cmsis_action`; a script replays the adapter's launch path when asked.
  - `debugger-troubleshooting`: the checks for a session that does not start, connect or program, in order, through the tools first (`get_recent_problems`, `cmsis_action status`, `diagnose_fault`, `get_section_layout`). Steps that need a probe vendor's command-line tool are marked as the user's.
  - They are selectable, not bundled, so they cost an agent's context only where the user wants them. In the catalog their source is `extension`; `scripts/skills.config.json` marks them `optional`, and the sync script makes them members of their category's entry point.

### Changed
- **The serial rule of the tool rules holds on Windows too.** It named `screen` and `cat /dev/tty*`, which do not exist there. It now reads "Serial I/O only through the `serial_*` tools, not `screen`, PuTTY, a read of the port or a serial script", and the table of shell commands adds "PuTTY or `type COM3` on Windows". The rules are 1 568 of 1 600 bytes. The server instructions, the guide, the skills that carry the rules and `/cmsis-help` follow, and a rules block the setup wrote into an agent's rule file (`AGENTS.md`, `CLAUDE.md`, …) is brought up to date at the next activation.
- **Pack Docs panel: a tool call named in a reply is a link.** `Next: read_doc_pages { doc: 'p/rm', pages: '3' }`, `fetch_doc { doc }` or `Call list_target_docs` in the Tools tab's output loads that call — tool and arguments, or the tool's template for a bare name — into the runner, ready to run after a look at the arguments.
- **A documentation reply with nothing found says where else to look.** `search_target_docs` without a hit and `list_target_docs` without documents end with: the missing manual or datasheet may be on the vendor's site; with the user's consent, find its PDF URL on the web and `fetch_doc { url }` to make it searchable — register meanings are not taken from web snippets.

## [2.5.3] - 2026-09-28

### Changed
- **The documentation and build-artefact tools are on by default.**
  - `cmsis-developer-assistant.packDocs.enabled` and `cmsis-developer-assistant.buildInfo.enabled` now default to `true`: `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs`, `list_build_artifacts`, `get_memory_usage`, `lookup_symbol`, `get_section_layout` and `get_build_diagnostics` are in every agent's tool list without a settings change, and the server instructions describe them instead of pointing at the settings. Both groups stay experimental.
  - Nothing is indexed or parsed until an agent calls one of the tools; activation only reads the settings. `false` plus a window reload drops a group again.

### Fixed
- **A refused or failed `fetch_doc` download leaves no `.part` file behind.** The write stream opens its file asynchronously, and the cleanup could run before the open had completed; the download now waits for the stream to close before removing the partial file.
- **A debug start an agent asked for no longer opens VS Code's modal dialog when it fails.**
  - A failed launch or attach, such as GDB's "could not connect: Operation timed out." when no GDB server listens, made VS Code open a modal dialog with "Open 'launch.json'". With nobody at the screen it blocked the window until someone closed it.
  - For sessions that `start_debugging`, `restart_debugging` or `cmsis_action load_and_debug` / `attach` start, and their child sessions, the error goes to the agent (tool result and problem journal) and to the user as a plain notification. A session the user starts keeps VS Code's dialog.
  - This relies on the adapter tracker seeing the failed response before VS Code reads it, which is how the extension host works today but is not a documented API promise.
- **`cmsis_action attach` without a GDB server is refused at once.** When no CMSIS Run task is alive and nothing listens on the port of the attach configurations in `.vscode/launch.json`, it answers `NO_SESSION` naming the port, with `load_and_run` or `load_and_debug` as the next step, instead of waiting for GDB's 15 s connect timeout.

## [2.5.2] - 2026-09-24

### Changed
- **Build results no longer send the agent to cbuild in a shell (part of #15).**
  - `get_build_diagnostics` without a log, the no-lines footer of a failed build, the `get_build_diagnostics` description, and the "build first" hints of the build-artefact and documentation tools told the agent to capture a log with `cbuild … --log`. A tester's agent did so, against the tool rules. They now point to `cmsis_action build`, whose diagnostic re-run writes the log `get_build_diagnostics` reads, and say "do not run cbuild yourself".
  - After a failed build without error lines, the hint names `get_recent_problems` for what the Problems panel shows, or asking the user, instead of a terminal the agent cannot open.
- **`evaluate_expression` on a struct, an array or a pointer shows its fields.**
  - It answered `Result: {...}`, and the agent then read the fields one call at a time.
  - Below the `Evaluated:`, `Result:` and `Type:` lines, `Fields:` lists each child as `name: value (type)`, one level deep; the new optional `depth` (1–3) opens nested structs, indented. At most 32 children per level, the rest counted; values over 200 characters are cut; at most 16 `variables` requests per call.
  - Fields are redacted like variables: by their own name and value, with the notice when one is withheld. A withheld field, and every field of an expression that is itself a credential name, is never opened. GDB commands (`-exec …`, `>…`) have no fields.
  - `depth` adds 109 bytes to `tools/list` (31 286 of 32 000 in one window).

- **The output channel is quiet in normal operation.**
  - The problem journal's `[problem #N] …` lines are written at debug level, so they appear only when the _CMSIS Developer Assistant_ channel's log level is Debug (**Set Log Level…** in the Output view). The journal, `get_recent_problems` and **Copy Recent Problems** are unchanged.
  - The line per tool call (`tool=… ms=… outcome=…`), per forwarded op and per routed call are debug entries too, as are a stop wait that ran out, the waits for a session to come up, a serial buffer that is full (logged for every chunk before), a promotion bid that lost and a session transport that did not close cleanly.
  - Expected outcomes are info rather than warnings: a configuration picker nobody answered, a missing or unreadable `launch.json` with the configuration synthesized instead, an unreachable window (the agent gets `WINDOW_UNREACHABLE`), a call the router gave up on, a result discarded after its fence, a probe that did not answer the status check, unknown or foreign skills left alone.
  - The logger passes debug entries to the channel, which applies the level the user picked; before, they were dropped whatever the level. Real failures stay warnings and errors.

### Fixed
- **`cmsis_action build` no longer reports ✅ for a build that failed to compile (part of #15).**
  - CMSIS Solution 1.70.1 closes its build task with exit code 0 whatever cbuild returned: its build runner drops the exit code, and the task's pseudoterminal then closes with 0. A tester got "✅ CMSIS 'build' succeeded … exited 0 after 3 s" four times while cbuild failed with `call to undeclared function '__disable_irq'`, and the image stayed 37 minutes old. The job tracker bound the right execution; the 0 came from CMSIS Solution.
  - A build whose task exits 0 is now checked before it answers. Errors in a fresh `cbuild-idx.yml` fail it. Images all written since the build started confirm it. Otherwise the diagnostic re-run of #15 decides: a build that fails there answers `TASK_FAILED` with its error lines ("exited 0 after 3 s, but the build failed"), and one that succeeds is reported as up to date.
  - When an image was not rewritten and the re-run cannot run (setting off, no `.cmsis/tools-environment.yml`, another build running), the result is a ⚠️ warning that exit 0 does not confirm the build, with the reason, instead of ✅. `status` and `get_session_status` show `❌ build errors (exit 0)` or `⚠️ exit 0, not confirmed`; `data.diagnosis.check` carries `rebuilt`, `up-to-date`, `failed` or `unverified`.
  - A check still going when the call's wait ends answers with status `running`; `cmsis_action {action:'status'}` gives the result.
- **Every `structuredContent` carries the text of its result, so a client that shows the model that object instead of the text loses nothing (part of #11, #48).**
  - Some MCP clients hand the model `structuredContent` and not `content`. An ok reply with data carried only `{status: 'ok', ...data}`, so `get_recent_problems` reached such an agent as `{"status":"ok","nextSeq":27,"returned":2,"omitted":0}`, without a single record.
  - An ok reply with data now carries its text as `message`, as the timeout, running and error shapes already did.
  - `get_recent_problems` also returns its records as JSON in `structuredContent.records`, the same records as its lines. The lines and the records each stay within 8 kB; what does not fit counts as omitted.
  - The surface and DAP oracles fail any reply whose `structuredContent` leaves out a line of its text.
- **`continue_execution` no longer halts the target when its wait runs out.**
  - A continue that saw no stop within its wait went down the steps' recovery path, which paused the target to report where it was. An agent that continued to let the firmware run, with a short `timeoutMs`, found it halted afterwards.
  - It now answers with status `running` and leaves the target running: "Target is running: no stop within 500 ms of 'continue_execution', and it keeps running; nothing was paused. Call wait_for_stop …, or pause_execution …".
  - The steps keep their recovery pause and its report of PC, LR and source line.
  - The timeout texts of the steps and of `restart_debugging` give the wait the call really had (`600 ms`, `60 s`), not the `timeoutInSeconds` setting ("within 180s" for a 500 ms wait).
  - The guide, the troubleshooting pages, the `cmsis-debug-live` skill and the README describe the new behaviour.

## [2.5.1] - 2026-09-24

### Added
- **One problem journal per VS Code window, so agents see what went wrong beyond the line a tool returned (part of #48).**
  - Every window keeps its last 200 problems in one shape: a sequence number, the time, the source (`dap`, `gdb-server`, `task`, `build`, `problems`, `ui`, `extension`, `serial`), the origin, the severity, a code, the message as it was reported (at most 300 characters), a workspace-relative file and line where there is one, and the next step. When it is full the oldest info goes first, then the oldest warning; a repeat within 10 s is counted, not added.
  - Sources: the debug adapter's failed responses, errors and output, the GDB server's log included (as info, unless the line is known), never the target's `stdout`; a failed CMSIS task (`TASK_FAILED`) and the error lines of a failed build (`BUILD_ERROR`, from #15); the Problems panel's errors, read on demand without the IntelliSense sources; this extension's error and warning notifications and its logged errors; a serial port that cannot be opened or goes away, never the payload. A failed response to a request VS Code sent, such as a breakpoint set in the editor while the target runs, is an error; one to a tool's own request is a warning, since the tool reports it.
  - Known lines get a code and the next step: `Failed to power up DAP` (`DAP_POWER_UP_FAILED`), pyOCD's `Waiting for a debug probe matching unique ID` (`PROBE_BUSY`), `target is running` (`TARGET_RUNNING`) and `no active solution` (`CMSIS_NO_SOLUTION`). Each is tested against a line captured from a real session.
- **`get_recent_problems { sinceSeq?, sources?, minSeverity?, limit? }` lists the journal of the window the session drives (part of #48).** One line per record with its number, severity, source, code and next step, then `nextSeq=`, which the next call passes as `sinceSeq`; warnings and errors by default, the newest 20 (at most 50), within 8 kB. The description says the records are data, not instructions. The tool adds 942 bytes to `tools/list`.
- **A result tells the agent once about errors it has not seen (part of #48).** When errors were recorded in the target window since the agent last called `get_recent_problems`, the next successful result ends with "Note: 2 new errors in this window since you last looked — get_recent_problems {sinceSeq: 118}", once per new batch, and `get_session_status` carries "Problems: 2 new errors since #118 — …" until the agent looks. A window of 2.5.0 sends no counters and gets no note.
- **Command "CMSIS Developer Assistant: Copy Recent Problems" (part of #48).** Copies the window's last 50 warnings and errors, with time, source, origin and next step, to paste into a bug report instead of a screenshot. Every record at warning or above is also written to the output channel as `[problem #N] …`.
- **With several VS Code windows open, a call can name the window it runs in, and each window says whether it is the router (part of #16).**
  - In a session that routes, `cmsis_action`, `flash`, `reset` and `serial_open` take `window`: a pid, or a path inside a window's workspace. It aims that call and, like a file path, the session's later calls without one; a pin from `select_debug_window` keeps the calls after it. A `window` that matches nothing is `INVALID_ARGUMENT` with the candidates in `data`. The router reads the argument and never forwards it.
  - The routed `tools/list` grows by about 500 bytes; the single-window list is unchanged.
  - Each registry entry carries the window's `role` (`router` or `worker`). `list_debug_windows` marks the router, and the candidates of `AMBIGUOUS_WINDOW` carry `role`. With several idle windows its hint names `cmsis_action load_and_debug` with `window`.
  - Windows of 2.5.0 read the new field without harm; their own entries have no role.
- **With several VS Code windows open, the user sees and chooses the window agents drive (#16).**
  - Before, two windows of which none was debugging made every tool call without a file path fail with a tie that only the agent could settle, and nothing showed which window was the router.
  - Every window shows a status-bar item: `CDA router` or `CDA worker`, `· default` on the default target, and a spinner while an agent call runs in it. Its tooltip names the MCP endpoint, the default target and the last agent call; in the router window it also lists every agent session with the window it drives and why. The status bar's context menu hides it.
  - The new command **CMSIS Developer Assistant: Select Target Window**, also the item's click, chooses the default target among the open windows, or **Automatic**. The choice is saved as `default-target.json` (mode 0600) in the window registry directory, where every router reads it; a reloaded window is found again by its folder.
  - The router takes the default target after the session's own target and before the one window with a debug session. A new choice drops the target every session had reached, so it applies from their next call; a pin from `select_debug_window` stays.
  - `list_debug_windows` marks the default target, `select_debug_window` says when its pin overrides one, and the candidates of `AMBIGUOUS_WINDOW` carry `isDefault`. Its hint names the status bar, and a default target whose window is not open.
  - A router of 2.5.0 ignores the default target, and windows of every version pass the new file by.
- **`list_debug_windows` says what each window is busy with, and the other windows warn when the router window stops responding (part of #14).**
  - Each window's registry entry now carries the extension version, the event-loop delay of the last 20 s, and the agent calls that have run there for more than 10 s. The 20 s heartbeat refreshes them. `list_debug_windows` shows them: `pid=4711 | … | router | busy: cmsis_action 240 s | event-loop lag 4.2 s`, the lag only above 1 s. Windows of 2.5.0 read the new fields without harm.
  - A router window whose extension host is blocked keeps the MCP port, so no other window can take over and every agent call waits. Its registry entry is no longer deleted when it goes stale while its process lives. A worker whose bid for the port fails finds that entry and asks the port `GET /mcp`. When the port stays silent for 2 s, the worker shows one warning per episode: "CMSIS Developer Assistant: the router window (pid 4711, CDA-Testdrive) has not responded for 75 s, so agents cannot reach any window. Reload or close that window; another window takes over automatically."
  - A router of 2.5.0 writes no role. When no window says it is the router and the port has stayed silent for a minute, the warning names the port instead.
- **A serial port an agent forgot is released, so the Serial Monitor can have it again (part of #49).**
  - On Windows a COM port has a single holder. A port an agent left open kept the Serial Monitor and terminals out with "Access denied" until the window was reloaded.
  - `serial_open` holds the port for the agent's MCP session. It is released after `cmsis-developer-assistant.serial.idleCloseSeconds` without a serial tool call and when that session ends. The new setting is 300 s by default, 0 turns the idle release off, and it is read at each open (window scope, no reload).
  - Only the agent's calls count as use: `serial_read`, `serial_write`, `serial_status` and `serial_clear_buffer`, and a read that waits holds the port meanwhile. Bytes from the board do not.
  - `serial_open` takes `releaseOn`: `idle` (the default), `debug-session-end` (released when a debug session in the window ends, not for idle time) or `manual` (only `serial_close`; it outlives the session, for soak tests). Its answer and `serial_status` say who holds the port and when it goes.
  - After a release, `serial_read` returns the bytes received before with the reason, such as "COM7 released at 10:47:07 after 300 s without a serial call", and `serial_write` fails with `PORT_CLOSED`. A Serial Monitor subscription follows the same rules and drops its buffer when it ends.
  - An MCP session ends when its client sends `DELETE`, and now also after 30 minutes without a request while it holds no GET stream open. The router then tells every window the session reached with the internal op `sessionEnded`; a window of 2.5.0 answers that it does not know the op, which is ignored.
  - Every release writes one line to the output channel and one record to the problem journal (source `serial`, never the payload): a warning for an unplug and for a release by the user, info for the idle, session and debug-session rules.
- **`serial_capture { path, durationMs, baudRate?, until?, write? }` shows what the board prints in one call (part of #49).**
  - It opens the port in the window's slot, sends `write`, reads until the regex `until` matches or `durationMs` (100 ms to 60 s) runs out, and closes the port again, also when a read fails or the port goes away. It never leaves a port held, and it does not reset the target.
  - The answer is at most 16 kB: the first and the last 8 kB with "… N bytes omitted …" between, why it stopped ("matched /READY/", "deadline") and how long it took, such as "Captured 412 B from COM7 in 1.2 s (matched /READY/). Port closed." A capture whose `until` never matched answers with status `timeout`; `structuredContent` carries the numbers.
  - An invalid regex is `INVALID_ARGUMENT` before any port is touched. `PORT_HELD` when the window holds a port already (the hint points to `serial_read {waitMs}`) or another program holds this one.
  - In a routed session it takes `window`. The router waits at least `durationMs`, and now also the `waitMs` of `serial_read`, whatever the tool timeout.
  - The tool adds about 1 kB to `tools/list`; the serial group has eleven tools. The `serial_open` description says to prefer `serial_capture` for one-off reads, and the tool rules' table names it for `cat /dev/tty…`.
- **The user sees which serial port an agent holds and can take it back (#49).**
  - While an agent holds a port, the status bar shows "Serial: COM7 (agent)", as an item of its own next to the window's role. Its tooltip gives the baud rate, since when, the agent's session, and when the port will be released.
  - A click runs the new command **CMSIS Developer Assistant: Release Serial Port**, which releases the port whatever its `releaseOn` and confirms it. The agent's next `serial_read` says "released … by the user in VS Code" and to ask before reopening it; the release is a warning in the problem journal.
  - `get_session_status` adds "Serial: COM7 open (this session, idle 42 s of 300 s)", or why the port was released.
  - `flash` and `cmsis_action load`, `erase` and `load_and_run` add one line when the window holds a port: the probe's virtual COM port may re-enumerate while the target is programmed, so the agent may need to reopen it. They do not release it: nothing ties the port to the probe, and a second board's UART would go too.
  - The `cmsis-debug-live` skill and the `inspection` topic of the guide say to prefer `serial_capture`, to read the output around a reset with `serial_open`, `reset`, `serial_read {waitMs}` and `serial_close`, and to close a port as soon as it is read.
- **Tool rules keep agents on the MCP tools instead of the shell (part of #50, part of #45).**
  - `docs/agent-resources/tool-contract.md` holds the tool rules, ten lines, and a table of shell commands with the tools that replace them. Talk to the board only through the tools; never run pyocd, gdb, JLinkExe, JLinkGDBServer or openocd against it, and never install pyOCD. Build and flash with `cmsis_action` and `flash`; run cbuild, csolution or cpackget in a shell only when the user asks or a CMSIS skill step names the command. Serial I/O through the `serial_*` tools, documents through the documentation tools. After a tool failed twice, call `get_session_status`, then stop and tell the user what to do in VS Code instead of working around it in a shell.
  - The server `instructions` start with the rules, about 1.5 kB per session. `tools/list` is unchanged to the byte.
  - The first `get_session_status` of each MCP session repeats them in one line: "Tool rules: board, build, serial and documentation work goes through these tools, not the shell (see the server instructions)."
  - The bundled skills `cmsis-debug-live`, `cmsis-pack-docs`, `add-board-layer` and `cmsis-help`, and the overview of `get_debug_instructions`, carry the rules below their title. `cmsis-debug-live`, `cmsis-help` and the `build` topic of the guide also carry the table.
- **The setup offers to add the tool rules to your agents' rule files, with your consent (#45, part of #50).**
  - *Configure Agents and Skills*, also the first-run setup, gains step 3. It lists the rule files of the agents set up in step 1, of the agents that have the server registered already, and of VS Code Copilot Chat: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.copilot/copilot-instructions.md` and `~/.gemini/AGENTS.md` (Antigravity), preselected, and per workspace folder `AGENTS.md`, the project's `CLAUDE.md`, and files of their own for Cursor (`.cursor/rules/cmsis-developer-assistant.mdc`, `alwaysApply: true`), Cline and Roo Code. Each path follows the agent's documentation, with the source next to it in the code.
  - A file several agents read, such as a workspace `AGENTS.md`, is listed and written once. The step never creates a file that hides one the project uses: without a project `CLAUDE.md`, Claude Code gets `AGENTS.md`, which it reads as long as there is no `CLAUDE.md`.
  - Every change opens a diff of the file as it is against the file with the rules, then a dialog; nothing is written unless you choose **Write**. The rules go between `cmsis-developer-assistant:rules` marker comments, led by a comment that says the extension manages them; the rest of the file does not change.
  - Unchecking a file and choosing **Remove** takes the rules out again: the file is back to its bytes, and a file created for the rules is deleted with its empty folders.
  - The files written are recorded. On activation, a recorded block whose rules are older than the extension's is updated in place and logged; a block is never added to a file then. Activation under the extension test runner skips this, like the skill sync.
  - The new setting `cmsis-developer-assistant.agentRules.install` is `ask` by default; `never` skips the step and leaves every rule file alone. The setup key moves to `popupShown.v4`, so the setup appears once more.
- **The agent evaluations catch shell commands that bypass the MCP tools (#45, part of #50).**
  - A scenario run fails when a shell tool runs `pyocd`, `arm-none-eabi-gdb`, `gdb-multiarch`, `JLinkExe`, `JLinkGDBServer…`, `openocd`, `cbuild`, `cpackget`, `pip install`, or `curl` against `localhost`. A scenario adds patterns with `forbidden.shell` and switches the default list off with `"defaultShellDenyList": false`.
  - `forbidden.toolArgs` now applies to MCP and other non-shell tool calls only, so an MCP `flash` call whose arguments name a `cbuild-run.yml` is no bypass.
  - Each run in the report lists its `bypasses`; each scenario gets a `bypassRate`, the share of judged runs with at least one.
  - `--rules` writes the tool rules into the work copy's `AGENTS.md`, with the code of the setup step, and lets Copilot CLI read it, to compare runs with and without the rule file.
  - The new scenario `flash-image-missing` makes `flash` fail through a fixture overlay and passes only when the agent stops and reports the failure.
- `npm run skills:sync -- --offline` regenerates the routers, the catalog, `cmsis-help` and the rule blocks without a network fetch, and leaves the vendored skills and the lock alone.
- `src/utils/markerBlock.ts` inserts, replaces, extracts and removes text between marker comments without touching the rest of a file, line endings included. The step that writes the rules into agents' rule files uses it too.

### Changed
- **A failed call carries what the adapter and the GDB server reported during it (part of #48).**
  - Up to five problem records of the call, warnings and errors, ride along with a failure or a wait that ran out, as `structuredContent.problems`, and are listed under the text as "Recent problems:", each with its code and next step. Records that only restate the failure are left out.
  - They replace the "Recent adapter traffic" lines that `start_debugging` and `cmsis_action` appended. Those came from the newest session whatever the call was, so a start that never reached an adapter showed an earlier session's lines; now it shows none.
  - The tool rule for failures reads "If a tool fails twice, call `get_session_status` and `get_recent_problems`, then stop …". The bundled skills and the guide carry it, and their "Reading results" sections, like the README's, name `structuredContent.problems`.
- **Every tool call has an id, and the window that runs it knows it (part of #48).** The id is the MCP session's first eight characters and a count; the call runs in a context that carries it and the session id, which the control envelope passes to the target window as `callId` and `sessionId`. A typed reply of a window carries its journal counters, `journalSeq` and `journalErrors`. Windows of 2.5.0 and 2.3.10 still route to and from this version.
- This extension's error and warning notifications go through one helper, which also journals them; modal confirmations are unchanged.
- **Serial failures carry their own codes (part of #49).** `serial_open` answers `PORT_HELD` when another program holds the port (Windows "Access denied", POSIX `EBUSY`, "Cannot lock port"), with a hint naming the Serial Monitor and `serial_subscribe_monitor`, and when the window already holds a port. A write without an open port is `PORT_CLOSED` instead of `INTERNAL`; windows of 2.5.0 read the new code as `INTERNAL`. A `serial_read` with `waitMs` returns at once when no port is open, and as soon as the port it waits on goes away.
- **Shipped texts no longer send agents to the shell (part of #45, part of #50).**
  - The embedded troubleshooting guide, as resource and in the skill, no longer says the GDB server must be "installed and on PATH" or that the probe is checked with `pyocd list` or `JLinkExe`. The GDB server comes from the CMSIS Debugger, `cmsis_action load_and_debug` starts it, and `check_target_connection` checks the probe.
  - `add-board-layer` builds with `cmsis_action build { target }` instead of `cbuild … --packs --update-rte` in a shell; the `cbuild` line stays for users who build from a terminal. The CMSIS Solution extension downloads missing packs for that build (setting `cmsis-csolution.downloadPacks`) and updates the RTE when it re-reads the solution.
  - `cmsis-help` no longer says the documentation tools need pdftotext (poppler): they use the bundled pdf.js.
- The step list of the agent guide and the opening text of the bundled skills get a heading of their own, so they no longer sit under the rules heading.
- **For contributors: `npm test` leaves the developer's machine alone, and more of the repository is checked.**
  - Under the extension test runner, activation no longer installs the bundled skills into the developer's own skill folders, rewrites agent configurations or rule files, offers the setup, or starts an MCP server beside their VS Code windows. Before, a test run replaced the installed skills with the checkout's work in progress.
  - `npm run lint:md` now lints every Markdown file; its unquoted pattern had reached only files one folder deep, so the README, the skills and the agent guide were never linted. It also skips a symlinked `node_modules`.
  - The transport tests also budget the routed `tools/list`, the list agents see: 34 000 bytes; the single-window budget is 32 000 bytes and the all-groups budget 44 000 bytes. The two-window harness takes its port from `CDA_ROUTER_TEST_PORT`.

### Fixed
- **A failed `cmsis_action build` shows its error lines (#15).**
  - Before, the result carried only the exit code and sent the agent to a terminal it cannot read: CMSIS Solution runs cbuild in a pseudoterminal and keeps no log.
  - The errors csolution records in the solution's `cbuild-idx.yml`, such as a missing pack or component, are read first; when that file names no error, cbuild runs once more with `--log` and its log is parsed. The re-run leaves out pack downloads, RTE updates and cleaning, adds `--skip-convert` after a fresh index, stops after 120 s or when another build starts, and writes `out/cmsis-developer-assistant/build-diagnostic.log` next to the solution, where `get_build_diagnostics` finds it.
  - The result shows at most 10 lines, errors first with file and line, and says that a re-run's warnings are only those of the files it recompiled. It also carries the errors and warnings in `data`. When the lines take longer than the call's wait, the result says so and `cmsis_action {action:'status'}` returns them.
  - The new setting `cmsis-developer-assistant.build.diagnosticRerun` (default on) switches the re-run off; the csolution messages are always read. Without `.cmsis/tools-environment.yml` (CMSIS Solution before 1.70.1) there is no re-run, and the result says why.
- **A wedged probe is named as such, with the way to reconnect (#3, phase 1).**
  - Before, a fault read on a probe that had stopped answering failed with "all GDB strategies exhausted" and no cause, which looked the same as a bad address.
  - A failed memory read now keeps why each strategy failed, at most 200 characters each. On the CMSIS Debugger it then reads DHCSR (0xE000EDF0) once, within 1 s. If that fails or times out too, the read answers `PROBE_WEDGED`; if DHCSR answers, it is `INVALID_ARGUMENT` ("the debug port answers, the address is not readable in this state"). A timed-out read on a port that answers keeps its `TIMEOUT`.
  - The hint follows the session: an attach session reconnects with `cmsis_action detach` and `attach`, without a reset. A launch session owns its GDB server, so the hint asks the user to restart the server without a reset (J-Link `-nohalt -noreset`, pyOCD `-O connect_mode=attach`) before `cmsis_action attach`, and names `load_and_debug` for when the fault state does not matter. It never tells the agent to start a server itself.
  - `get_fault_info` and `diagnose_fault` answer the `PROBE_WEDGED` error itself instead of a diagnosis built on registers that were not read, and add a note when DHCSR says the core is in lockup. The state gate's `unresponsive` refusal is `PROBE_WEDGED` too, with the same hint. Nothing is retried or reconnected automatically; a one-call reconnect is phase 2.
- **A tool call that hangs in another VS Code window ends in time, and a blocked window is noticed within seconds (part of #14).**
  - Before, a forwarded call that never finished held the agent's call for the whole budget: 195 s, or ten minutes for `cmsis_action`, `flash` and the documentation tools. Examples are `start_debugging` waiting in a configuration picker that nobody saw, or a stop that did not return. The window that ran the call was never told. A window whose extension host was blocked cost every call that budget too.
  - The router now names its budget in the control envelope (`budgetMs`). The window that runs the call answers `WORKER_TIMEOUT` 5 s before the budget runs out: "'start_debugging' did not finish within 190 s in window pid 4711 (CDA-Testdrive); it is still running there". The hint says that a picker or dialog may wait for the user. The call runs on in that window, and its late result is logged and dropped. A router of 2.5.0 names no budget; the window then takes the one its own `timeoutInSeconds` gives.
  - That window records the timeout in its problem journal and shows a warning with **Show Log**, at most one per tool in ten minutes. Its status-bar item has the warning background while the call runs on.
  - Before a call to a window it has not heard from for 30 s, the router asks the window for its health (`health`, an internal op of the control channel, not a tool) and allows 2 s. While a call is pending it asks every 15 s, and gives up after two misses in a row. A window that does not answer is `WINDOW_UNREACHABLE`: "The VS Code window pid 4711 (CDA-Testdrive) did not answer a health check within 2 s — its extension host is blocked, or the window closed." A busy window that answers keeps its whole budget. A window of 2.5.0 answers `health` with an error, which counts as alive.
  - The control server allows 10 s to receive a request and 5 s for its headers, instead of Node's 300 s and 60 s.
  - The `session` topic of `get_debug_instructions` and the `cmsis-debug-live` skill say what to do on `WORKER_TIMEOUT` and `WINDOW_UNREACHABLE`. `tools/list` is unchanged.
- **`start_debugging` without a configuration name no longer waits for a picker nobody sees, and `stop_debugging` answers within 10 s (part of #14).**
  - Without `configurationName`, `start_debugging` asks the user in a quick pick in the VS Code window that runs the call, which the agent cannot see. It waited there until the router gave up. The picker now closes after the call's `timeoutMs`, 30 s without one and 60 s at most. The call then fails with `INVALID_ARGUMENT`, "No debug configuration was chosen within 30 s: …", and its hint names the `launch.json` entries to pass as `configurationName`, the derived `Default Configuration`, and `cmsis_action load_and_debug` for a CMSIS solution.
  - `stop_debugging` waits at most 10 s for VS Code to end the session. A session that is still listed by then gets an answer with status `timeout`: "Stop requested, but the debug session did not end within 10 s and is still listed. Call get_session_status to see whether it ends; stop_debugging may be called again."
- **After another window takes over the MCP port, agents can open a new session instead of staying stuck (#14).**
  - A request that names an MCP session id the server does not know, such as one the previous router window had opened, is now answered 404 with the JSON-RPC error -32001 "Session not found", on `POST`, `GET` and `DELETE`. That is what the MCP SDK's own transport and the MCP specification prescribe, and it is the answer that tells a client to initialize a new session. Before, it was 400, and clients kept sending the dead session id until they were restarted.
  - A request without a session id that is not an initialize request is still answered 400.
- **A serial port that goes away by itself is reported as closed, with the reason (part of #49).**
  - Previously the port's `close` and `error` events were only logged. After an unplug, `serial_status` still showed the old path, baud rate and open time, and `serial_write` said only "No serial port open".
  - The owned port is now forgotten when it closes by itself, or fails after closing; a late event of a port already replaced changes nothing. The bytes received before stay readable.
  - `serial_status` reports `closed (COM7 disconnected at 10:42:07)`, and `serial_read`, `serial_write` and `serial_close` name the same reason and point to `serial_open`.
  - The Serial Monitor bridge no longer sends agents to `serial_read_owned`, a tool that does not exist, but to `serial_open` and `serial_read`.
- **Refusals say what to do next, and failures read without a stray `Error: ` (#20, #11).**
  - Without a session, the hint of an inspection or step refusal is "No active debug session: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise." While the target runs it is "The target is running: call pause_execution first, or set a breakpoint and wait_for_stop."
  - `pause_execution`, `get_device_info`, `reset` and `wait_for_stop` without a session give the same advice: "Start a session first: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise."
  - A step or continue whose debug session ends while it waits now fails with `NO_SESSION` ("Debug session ended during 'continue_execution' — …") and a hint naming `get_session_status`, `cmsis_action load_and_debug` and `start_debugging`, as `pause_execution` and `wait_for_stop` already did. Before, it answered as a success with a ⚠️ note.
  - A refusal of the state gate is no longer wrapped a second time: `[NO_SESSION] Cannot step over: session state is 'no-session'.` instead of `[NO_SESSION] Step over failed: Error: Cannot step over: …`. The same holds for "Nothing to restart", `get_device_info` without a session, and breakpoint changes refused by the session state.
  - Other wrapped failures drop the `Error: ` of a plain error (`Error adding breakpoint: Could not find any lines containing: …`) and keep a class name that says something (`HardwareTimeoutError: …`).
  - `get_call_stack` with a thread id the target does not have is `INVALID_ARGUMENT` with the hint to call `get_threads`, not `INTERNAL`.
  - An inspection that finds no focused stack frame is `TARGET_RUNNING` with the hint `wait_for_stop` or `pause_execution`, not `INTERNAL`.
  - The README explains how to read a result (`isError`, the `[CODE]` prefix and hint, `structuredContent`).
- **A reset that did not take now names the way out (#20).**
  - When `reset` cannot verify the reset, its reply names the next step instead of sending the user to power-cycle the board: `stop_debugging`, then `cmsis_action load_and_debug`, a fresh connect and reset. That is the working fallback on J-Link and on secure-boot parts such as Alif Ensemble, where nSRST alone does not re-vector the core. Power-cycling comes only if that fails too. The text is the same for every GDB server, and `tools/list` is unchanged.
  - The `cmsis-debug-live` skill lists the tools a running target rejects, with `pause_execution` as the first step, and gives the same reset fallback. The embedded troubleshooting notes get a section on it, and the guide's `inspection` topic puts power-cycling after the fallback. "A running target rejects reads and steps: call `pause_execution` first." is one of the tool rules.
  - A test keeps the skill's copy of the embedded troubleshooting notes byte-identical to the MCP resource.
- **Setting up Cursor now registers the server where Cursor reads it (part of #50).**
  - The setup wrote Cursor's entry to `…/Cursor/User/globalStorage/cursor.mcp/settings/mcp_settings.json`, a file Cursor never reads, so Cursor did not see the server. Cursor reads `~/.cursor/mcp.json` on every platform, and that is where the entry goes now, as `{ "url": … }`, the shape Cursor documents for a remote server.
  - On activation an entry found in the old file moves to `~/.cursor/mcp.json`; an entry already there is kept. The old file is deleted when nothing else was in it.
- **The Pack Docs panel runs only the command its own page offers.** A message from its webview naming any other command id is ignored and logged. The page is CSP-protected, so the risk was low, but it shows text taken from PDFs and pdsc files.
- **`read_cycle_counter` is no longer annotated read-only.** Its first call enables the DWT cycle counter by writing DEMCR and DWT_CTRL; it is now marked not read-only, not destructive and idempotent.
- **`npm run skills:sync -- --update` accepts the `ethos-u` category that upstream cmsis-skills added** (label "Ethos-U NPU", listed after the CMSIS-Pack skills). A category without skills at the pinned commit adds no router, picker heading or help section, so the generated files are unchanged; the sync warns about a category that has skills but no router.

### Security
- **The window registry and the control servers are closed to other local users (#19).**
  - Every VS Code window publishes its control port and token in the registry, and the token is enough to flash or erase that window's board. The directory was created 0755 and the files 0644, so on Linux, where it sits in the shared `/tmp`, any local user could read every token.
  - The directory is now 0700 and each window file 0600. An existing 0755 directory of the user is narrowed on first start, and each window rewrites its file 0600 within 20 s.
  - Where every user may write to the temp directory (Linux `/tmp`, macOS with `TMPDIR` unset), the directory name carries the uid: `cmsis-developer-assistant-registry-<uid>`. The per-user temp directories of macOS and Windows keep the old name.
  - A registry directory that is a symbolic link or belongs to another user is neither written nor read. The window logs an error, shows one warning, and keeps serving its own tool calls; only the other windows are out of reach.
  - The control server refuses a request whose `Host` is not loopback or that carries an `Origin` at all, before it looks at the token, and compares the token in constant time. Its 403 and 404 answers, and a new `_note` field first in each registry file, tell an agent that found them to use `list_debug_windows` and `select_debug_window`.
  - The registry format and the protocol between windows stay compatible with 2.5.0 and 2.3.10.
  - **Linux: reload every VS Code window after updating.** A window that was not reloaded keeps using the old registry directory and is invisible to updated windows until it is reloaded. On macOS and Windows the directory name does not change.
- **Agent configuration files keep their permissions when the setup rewrites them.** The atomic writers created a new file with the default mode, so a `~/.claude.json` or other agent configuration that its owner had narrowed to 0600 came back readable by every local user after the server was registered in it. A replaced file now keeps its permission bits.

## [2.5.0] - 2026-09-23

### Changed
- **The code that still derived from microsoft/DebugMCP is replaced by independently written code (#53).** The files are the MCP server, the debugging handler and executor, the debug state, secret redaction, the logger, the multi-window control server, registry and router, both configuration managers, extension activation, the esbuild/ESLint/test-runner configs and the skill-trigger scripts. Each was rewritten from a behaviour specification by an implementer who did not see the previous version. [docs/provenance/](docs/provenance/README.md) records the method, the specifications and the per-file result: at most five lines of any rewritten file occur anywhere in DebugMCP's history, and those are declarations the exported names dictate. No source file carries the Microsoft copyright line any more.
- **Behaviour is unchanged, including the known bugs, which are fixed separately.** Four recorded oracles replay identically:
  - the agent-visible surface: tools, schemas, instructions, resources and every reply without a session;
  - 28 scripted debug sessions, with their DAP requests and replies;
  - 85 configuration scenarios, with every agent config file written byte for byte;
  - 124 executor cases.
  The wire protocol between windows and the registry format are unchanged, so windows on 2.3.10 and on this version still route to each other.
- **New module layout.** The tool registrations, resources and instructions move from `src/debugMCPServer.ts` to `src/debugTools.ts`. The executor splits into `src/executor/` (contract, snapshot, GDB memory ladder, reset, session reports), and the handler into `src/handler/` (fence, `cmsis_action`, flash, GDB and target texts, test hooks).
- **Texts that still matched DebugMCP are reworded, with the same meaning.**
  - The first two sentences of the server instructions.
  - The descriptions of `stop_debugging`, `step_over`, `step_into`, `step_out`, `continue_execution`, `restart_debugging`, `remove_breakpoint`, `clear_all_breakpoints`, `list_breakpoints`, `list_variable_names`, `get_variables_values` and `evaluate_expression`, the skill sentence of `start_debugging`, and six field descriptions (tools/list: 28 890 bytes).
  - Replies of the stop, restart, step, continue and breakpoint tools and the root-cause checkpoint on stop. `evaluate_expression` now reports the type on its own line: `Evaluated: …`, `Result: …`, `Type: …`.
  - The redaction notice, the setup and migration notifications, the launch-configuration picker and the resource names.
- **Documentation and configuration written anew.**
  - The architecture docs of the rewritten components, plus a new `docs/architecture/windowRouting.md`.
  - `AGENTS.md`, with stale facts corrected: 4-space indentation, Streamable HTTP only (`/sse` answers 410), `pdftotext` optional since pdf.js is bundled.
  - The root-cause part and the opening step list of the agent guide (`get_debug_instructions`).
  - `tsconfig.json`, with the same effective configuration.
  - A 39-line `.gitignore` in place of the inherited Visual Studio template, whose `[Bb]uild[Ll]og.*` pattern once swallowed `buildLog.ts`. What git tracks and ignores is unchanged, except that a root `.vscode/` folder is now ignored as a whole.
- **The Python and C/C++ troubleshooting guides are written anew, and the C/C++ guide is now served.** It is available as `cmsis-developer-assistant://docs/troubleshooting/cpp`; before, it shipped but was never registered. It covers host programs and C/C++ firmware, and leaves target topics to the embedded guides. The resource descriptions now name the language, for example "Advice for debugging C/C++ programs".

### Fixed
- **Failed tool calls are reported as failures (#11).**
  - Previously, 28 tools could never set MCP `isError`: the debugging tools behind the handler fence, plus the documentation and build-artefact tools. Refusals such as "no active solution" or "Refusing to flash" came back as success text.
  - A failed call is now `isError`, and its text starts with an error code and puts the next step on its own line, for example `[NO_SESSION] Cannot read memory: …⏎No active debug session. …`.
  - `structuredContent` carries `status`, `error_code`, `message`, `hint` and, for several matching windows, the candidate list. A wait that ran out, or a build still running, is not a failure: it carries status `timeout` or `running`.
  - The codes are `NO_SESSION`, `TARGET_RUNNING`, `TIMEOUT`, `AMBIGUOUS_WINDOW`, `WINDOW_UNREACHABLE`, `WORKER_TIMEOUT`, `CMSIS_NO_SOLUTION`, `TASK_FAILED`, `PROBE_BUSY`, `PROBE_WEDGED`, `PORT_HELD`, `TOOL_DISABLED`, `INVALID_ARGUMENT` and `INTERNAL`.
  - The server instructions, the skill and the agent guide explain how to read them. `tools/list` is unchanged.
- **A tool error in another VS Code window is no longer reported as "Could not reach the VS Code window … It may have been closed".**
  - The router now tells a failed call from a lost connection, and keeps its target window after a handler error or a worker timeout.
  - The control channel between windows carries typed results. It uses envelope version 2, negotiated by a request header, and windows on 2.3.10 still interoperate.

- **`cmsis_action` follows the CMSIS task it started, and refuses when the probe is busy (#47, #46, #12).**
  - Build and flash tasks are tracked as jobs, bound to the task execution they started. Load+Run counts as done when Load exited 0 and CMSIS Run has stayed up for 2 s.
  - A task still running when the wait ends returns status `running`. `cmsis_action {action: "status"}` reports the jobs and live CMSIS tasks of the window, and a repeated `build` attaches to the one in flight instead of starting a second.
  - `timeoutMs` for `cmsis_action` and `flash` goes up to 600 s. The default wait stays 60 s, because some clients cut longer calls.
  - load, erase, load_and_run, load_and_debug and `flash` refuse with `PROBE_BUSY` while a debug session or a CMSIS Run task holds the probe. `attach` to a running Run task stays allowed. `stop_run` waits until the CMSIS tasks have ended and terminates leftovers itself.
  - Previously, task names such as "CMSIS Load" did not match the case-sensitive filter, and the end of any task counted as the end of the action.
  - A missing task label fails at once with `INVALID_ARGUMENT`. `get_session_status` names the CMSIS jobs and tasks. A `load_and_debug` whose session has no threads yet is `running`, not "did not survive".
- **`flash` uses the CMSIS Debugger's bundled pyOCD,** then the one in `.cmsis/tools-environment.yml`, then PATH. It no longer advises `pip install pyocd` (part of #45).

- **GDB commands reach GDB in CMSIS Debugger sessions (#56).**
  - We sent them as `-exec …`. That is the Microsoft C/C++ adapter's prefix; the CMSIS Debugger's adapter (cdt-gdb-adapter) takes `>` and evaluated `-exec …` as a C expression.
  - As a result, `monitor reset`, the GDB memory-read fallbacks and agents' own `evaluate_expression("-exec …")` did nothing, and `reset` on J-Link often reported "did NOT appear to have reset".
  - Commands now use each adapter's own prefix. On `gdbtarget` the console output is collected and returned. `evaluate_expression` accepts `-exec <command>` and `>command`, and neither is secret-redacted. The memory fallbacks use expressions and MI `-data-read-memory-bytes`, and `reset` flushes GDB's register cache before it verifies.
- **Breakpoints go through VS Code's model only, and logpoints on `gdbtarget` are GDB dprintfs.**
  - Previously, `add_breakpoint` also sent GDB `break` and `clear_all_breakpoints` sent GDB `delete`. Once commands reach GDB, that would duplicate every breakpoint and delete the adapter's own.
  - Binding is now reported from the adapter's `verified` state and message, and `list_breakpoints` shows it.
  - On `gdbtarget`, logpoints are GDB dprintfs (MI `-dprintf-insert`), so `{expr:%08lx}` is filled in and a condition really applies. They are tracked by number, removed and cleared by number (never a bare `delete`), and listed with their hit counts. Other adapters keep VS Code logpoints.
- **Breakpoint changes and restarts are safe while a CMSIS target runs (#13).**
  - `add_breakpoint`, `add_logpoint`, `remove_breakpoint` and `clear_all_breakpoints` pause a running `gdbtarget` target, apply the change, check it and resume, and say how long the target was paused.
  - `restart_debugging` pauses, then stops the session and starts its launch configuration again through the debug API, instead of the UI's restart command.
  - On `gdbtarget`, a step, continue or pause refused with GDB's "target is running" returns `TARGET_RUNNING` instead of retrying through VS Code's UI, where the refusal appeared as a toast.
- The agent guides no longer claim that a breakpoint condition keeps the core from halting (the FPB has no condition logic; GDB evaluates the condition and resumes), and no longer advise `-exec break` / `-exec condition`.

### Added
- Provenance tooling for #53:
  - `src/test/provenance.test.ts` keeps any file from gaining the Microsoft copyright line.
  - `npm run provenance:check` measures each file against every commit of DebugMCP up to the last synced one; `--gate` fails on rewritten or new files above the limit.
  - `npm run test:surface`, `test/transport/dap-scenarios.js`, `test/transport/config-scenarios.js` and `test/transport/executor-cases.js` record and replay behaviour for refactorings.

### Removed
- `dist/extension.js.map` and `dist/pdfWorker.js` are no longer tracked. `dist/` has been ignored since 2026-09-03, both files are build output, and the source map embedded the pre-rewrite sources.
- `vsc-extension-quickstart.md`, the extension generator's template.
- The JavaScript, Java, Go and C# troubleshooting guides, and the `troubleshooting/javascript`, `java` and `csharp` resources (`go.md` was never served). Those languages can still be debugged through the same tools.

## [2.3.10] - 2026-09-07

### Added
- Tests for the DNS-rebinding guard (`isLoopbackHostHeader` / `isLoopbackOrigin`), the hardware timeout wrapper, and the pdf.js worker's positive timeout, restart, idle retirement and dispose-while-pending paths (through an injectable stand-in worker).
- **The Pack Docs panel can clear its store — in two separate steps, each behind a confirmation.** *Clear extracted text…* removes every document's extracted pages, metadata and search index (`*.pages.jsonl`, `*.meta.json`, `*.idx.json`) across the store and prunes the emptied directories; downloaded PDFs and fetch records stay, so fetched documents remain fetched and every document is extracted and indexed again on its next use. *Delete downloaded PDFs…* removes what `fetch_doc` downloaded — the `arm/` and `web/` trees with their PDFs, fetch records and extraction — so those documents are offered as "not fetched" again. The modal confirmation names the document count, file count and size it is about to remove; the in-memory page, index and chapter caches are dropped with the files. `PageStore` gains `storeUsage()`, `clearExtracted()` and `clearDownloads()`, tested.

### Changed
- **The Pack Docs panel is laid out by what each tab shows.** The target picker — a cbuild-run context or pack + device — moved into a header shared by every tab, with the resolution and core under it, since it drives them all. The former *Target* tab, which stacked the SVD browser above the document list, is split into **Documents** (every document the tools see for the target, its state and the fetch / index / browse / search actions) and **Peripherals** (the device SVD, the Arm core peripherals and the NPU as groups, instances and bit views); *Store* is **Page store** (what is extracted and indexed on disk, across all targets) and *Tools* stays. Each tab carries a count and a tooltip, opens with a one-line description of what it shows, and the panel no longer refers to "the Target tab" in the other tabs. A saved tab from the old layout opens as Documents.

### Changed
- **User-document ids name their scope folder** (`user/keil/stm32u5xx-dfp/rm0456`, `user/devices/stm32u5/errata`, `user/boards/b-u585i-iot02a/schematic`), so the same file name attributed to two scopes no longer collides or swaps ids between calls; a document at the root of the user folder keeps `user/<name>`. `read_doc_pages` and the `docs` filter still accept the bare file name when it is unique. Extracted text and indexes are unaffected. Tested.
- **A short document id that matches several documents is reported as ambiguous** by `read_doc_pages` and `fetch_doc` — `Document id 'rm' is ambiguous — it matches …` — instead of silently reading pages of whichever the listing yielded first. A unique trailing segment (`test-rm` for `stm32f7xx-dfp/test-rm`) and a case difference still resolve. Tested.
- **`reset` tells the truth about the end state.** When the last (or only) reset method is unsupported the result no longer says "trying the next method"; when the reset could not be verified the result says the target is halted, that it was running before when the tool halted it, and that `halt: false` was not applied — an unverified target is never resumed. `ResetOutcome` gains `resumed`; the rendering moved to `resetAssist.ts`. Tested.
- **`get_threads` reads top frames for the first 32 threads in batches of four** instead of one `stackTrace` request per RTOS task fired at once — a GDB server serialises DAP requests, so a 60-task build made every request wait on the others and hit the deadline together.
- **`cmsis_action`'s post-connect session check fits its advertised window.** The two thread probes after `load_and_debug` / `attach` were fixed at t+3 s and t+6 s with 5 s each, up to 16 s past an "opportunistic" 8 s wait; they are now scheduled at 35 % and 75 % of that window. `probeSchedule` is exported and tested.

### Fixed
- **`fetch_doc` no longer reaches local or private addresses.** A pdsc `<book url>` or a `fetch_doc { url }` pointing at loopback, link-local, RFC 1918, CGNAT, multicast or cloud-metadata addresses (`127.0.0.1`, `localhost`, `169.254.169.254`, `10.x`, `192.168.x`, `fe80::`, …) is refused before any request is made, and redirects are followed one hop at a time with the same check on every target, so a public URL cannot bounce the download onto the MCP or control port. The error names the workspace docs folder as the way to use such a document. A public name that resolves to a private address is not caught (no DNS lookup). `PackDocsHost.allowPrivateHosts` lets a loopback fixture through in tests. Tested.
- **`packDocs.maxPdfMb` applies to `read_doc_pages` and to imported documents too**, not only to search and the index command; an oversize document is reported with the setting to raise instead of being extracted anyway. Tested.
- **A window that opened a serial port through `serial_open` releases it when the window closes, whether or not it was the router.** Serial teardown moved from the MCP server (router window only) to the per-window coordinator, bounded to two seconds so a wedged tty cannot hold `deactivate`. Tested.
- **Closing a window no longer waits on open MCP or control connections.** The HTTP servers close idle sockets at once and destroy the rest after two seconds, so an in-flight tool call or an open notification stream cannot hold the extension host in `deactivate`; a window that failed to bind the router port releases the partially started server. Tested.
- **`serial_close` after the adapter was unplugged no longer wedges `serial_open` with "already open".** The controller forgets the port even when closing it fails. Tested.
- **`read_peripheral_register` honours `dapRequestTimeoutMs` and the call's `timeoutMs`** instead of a fixed 10 s per DAP request, and the GDB evaluate fallbacks used by `read_memory` forward the same deadline as the DAP attempt. Tested.
- **An MCP session whose `initialize` failed mid-way no longer leaks its transport and server objects.**
- **Agent configuration files (`~/.claude.json`, …) are re-read immediately before they are written** and the update is retried when another process changed the file in between, so a Claude Code write during setup is no longer lost; an unchanged file is not rewritten at all. `src/utils/jsonFileRewrite.ts`, tested.
- Removed an upstream `coreclr` special case in `start_debugging` that opened the program file and fired the test-explorer debug command without awaiting it.
- **`continue_execution`, `step_over`, `step_into`, `step_out` and `pause_execution` no longer report a stop with an empty location while the target is still running.** They settled on VS Code's active-stack-item change, which also fires when the frame is *cleared* on resume, and the `continued` event of the request just sent usually arrived after the listener was attached. They now wait for the DAP `stopped` event — the signal `wait_for_stop` and `reset` already use — armed before the request goes out so a stop that lands during the round trip is not missed, and the result opens with the stop reason (`Target stopped (reason: breakpoint)`). The timeout recovery pauses the same way. `IDebuggingExecutor` gains `armStopWaiter`. Tested with a scripted executor.
- **A pyOCD flash run that ignored SIGTERM at the deadline was never killed and `flash` hung.** The SIGKILL escalation checked `child.killed`, which is true as soon as the SIGTERM was *sent*; it now checks that the process has not exited. `flashWithPyocd` takes an injectable `spawn` and grace period. Tested with a child that ignores SIGTERM.
- **Tool results forwarded between VS Code windows could arrive with `�` in place of emoji or CJK text.** The router and each window's control server appended body chunks to a string, so a multibyte UTF-8 sequence split across two chunks was decoded in halves; both now collect the raw bytes and decode once. They also refuse bodies above 1 MiB (requests) or 16 MiB (results) instead of buffering without limit, the MCP endpoint's body limit is an explicit 1 MiB, and a client that aborts mid-request no longer leaves the control server's response open. Tested with a request and a reply split inside a four-byte character.
- **A pdsc containing an out-of-range numeric character reference (`&#99999999;`) made `list_target_docs` fail with "Invalid code point".** Such references are now left as written, like unknown named entities. Tested.
- **A disk error while `fetch_doc` was writing a download (full disk, unwritable page store) crashed the extension host or left the call hanging.** The write stream's error is observed from the first byte and raced against the back-pressure wait, so it becomes the tool's error and the partial file is removed. Tested with an unwritable `.part` path.
- **A documentation or build-artefact call that failed after its timeout had already been reported left an unhandled promise rejection in the extension host.** The two handlers' identical timeout fences are now one helper (`src/core/toolRun.ts`) that keeps observing the call and logs its late outcome. Tested.
- **A VS Code window could lose its entry in the multi-window registry while another window was reading it.** Registrations were written in place and any file that failed to parse was deleted; they are now written to a temp file and renamed (`src/utils/atomicFile.ts`), the heartbeat rewrites the window's own copy instead of re-reading the file, and an unparsable file is only removed once it is older than the staleness window. Tested.
- **Two VS Code windows syncing skills at the same time could delete each other's in-progress copy, failing the install in one of them.** The stale-staging sweep removed every `.<skill>.tmp-<pid>` directory; it now skips those whose process is still alive. Tested.
- **Two VS Code windows writing an agent configuration at the same time could clobber each other's temp file, and the Codex `config.toml` was written in place rather than atomically.** Every agent configuration write goes through the same temp-file-plus-rename helper with a per-process unique temp name.
- **`get_build_diagnostics { file }` reads build logs inside the open workspace only.** An absolute or `..` path outside every workspace folder is refused, and a file that carries no compiler or cbuild output is reported as "does not look like a build log" instead of being rendered — the tool was an arbitrary-file read for the agent. Tested.
- **A zero or negative pdf.js timeout is decided synchronously instead of on a zero timer.** A zero timer still raced the worker's reply: a warm thread answers a small document within one Windows scheduler tick, so the "timed out" rejection the page-store test expects was missing on the windows-11-arm runner. A timeout of zero or less now rejects and terminates the worker right after the request is posted.
- **On Windows the documentation tools looked for packs under `%USERPROFILE%\.cache\arm\packs`, so `list_target_docs` reported every pack as "not installed".** The CMSIS-Toolbox default pack root is `%LOCALAPPDATA%\Arm\Packs` on Windows and `~/.cache/arm/packs` only on Linux and macOS; `defaultPackRoot` now follows the platform (falling back to `<home>\AppData\Local\Arm\Packs` when `LOCALAPPDATA` is unset), and `CMSIS_PACK_ROOT` still overrides it. The `${CMSIS_PACK_ROOT}` expansion in `svdFile` paths shares the same resolution instead of its own copy of the Linux path. Tested for all three platforms. Next to the CMSIS Solution extension the tools no longer guess at all: before every target resolution they ask it for its pack root (`cmsis-csolution.getPackRootPath`, the same `CMSIS_PACK_ROOT`-or-OS-default the panel builds with) and adopt the answer, so both extensions look in the same directory and a "not installed" note names the one the panel would install into. `PackDocsHost` gains the optional `packRootFromToolchain` hook; an absent, slow, empty or failing answer keeps the platform default. The extension is asked once per window (again after an extension or settings change; an unanswered ask is retried after a minute) and the output channel reports which root was adopted. Every consumer — the document list, the SVD lookup, the CMSIS-Core and NPU headers — reads the root the resolution was made under (`TargetResolution.packRoot`), so the first call in a window no longer looks in the platform default while the answer is still in flight; and `lookup_peripheral`, `read_peripheral_register` and `diagnose_fault` expand `${CMSIS_PACK_ROOT}` in `svdFile` and cbuild-run entries with that same root. Tested.
- **Document indexing failed next to the CMSIS csolution extension: "The `Array.prototype` contains unexpected enumerable property "groupedBy"".** pdf.js refuses to start on a realm whose `Array.prototype` or `Object.prototype` has an enumerable property, and VS Code's extension host is one process shared by every extension — the csolution extension assigns `Array.prototype.groupedBy`, so every PDF was skipped and `search_target_docs` found nothing indexed. pdf.js now runs on a `worker_threads` worker of its own (`dist/pdfWorker.js`, a second esbuild entry point): a fresh realm no other extension can patch. The thread is started on the first document, kept for the next, retired after a minute idle, and terminated when an extraction times out — which now actually stops pdf.js mid-document instead of waiting for the next page. The bundled `pdf.worker.min.mjs` still ships for the thread's fake worker; `itemsToPageText` moved to `pdfText.ts`. Tested with a patched `Array.prototype`, a timeout followed by a fresh extraction, and a missing file.

## [2.3.9] - 2026-08-31

### Added
- **Skills can be installed into the workspace instead of the user profile.** *Select Agent Skills* (and step 2 of the setup) first asks where the AI Skills Pack goes: *This workspace only* (the default — a personal skill is offered to the agent in every project and its description costs context there whether the project is CMSIS or not; a project skill is loaded only where it applies) — the project's `.agents/skills` (and `.claude/skills` when Claude Code is installed or the project already has a `.claude` directory), next to the sources, to commit with the project or ignore; *This user* — the personal skills directories as before, for every workspace. The choice is the target of the `installedSkills` setting, whose scope changes from `application` to `resource`: the User value drives the personal directories, a Workspace or Folder value the project's — each folder of a multi-root workspace from its own — so a selection that arrives in a checked-out `.vscode/settings.json` is applied on activation like one from Settings Sync, and removing it sweeps the project copies (marker-guarded, as everywhere). A project selection installs the selected pack skills and their hidden dependencies only; the extension's own skills stay personal, where every agent already finds them, and a project without a selection never gains an empty `.agents/skills`. Adding a folder to the workspace syncs it, the picker shows what each scope currently selects, and the install prompt counts a pack skill picked in either.
- **Documentation and build-artefact tools, built in** — the experimental CMSIS Pack Docs extension moved into the Assistant as-is: `src/core/packDocs` (target resolution from `*.cbuild-run.yml`, pdsc `<book>` walking, Arm document catalogue and download, user and workspace document folders, `pdftotext` extraction, the page store and BM25 index, peripheral dossiers over the SVD plus 16 shipped Cortex-M core-peripheral SVDs) and `src/core/buildInfo` (a positioned ELF32 reader, GNU ld / armlink map parser, build-log diagnostics). Ten tools: `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs` and `list_build_artifacts`, `get_memory_usage`, `lookup_symbol`, `get_section_layout`, `get_build_diagnostics` — **off by default** behind `cmsis-developer-assistant.packDocs.enabled` and `buildInfo.enabled` (fixed per window like `serial.enabled`; the enabled list is 55 tools / ~41 kB against its own 42 000-byte budget, the default list is unchanged). They route like every other op: each window builds the handler pair, the control server dispatches by op name, the router forwards, and the five documentation ops carry the ten-minute forward floor because indexing a manual takes minutes. Commands **List / Index Target Documentation**, **Import Document for Current Target** (attribute a PDF to a pack, device family, board or core, with title, category and edition, indexed at once), **Open User Documents Folder** and **Open Pack Docs Panel** (target, documents and index state, SVD peripherals, page store, in-place tool runner). Settings `packDocs.extractor` / `pdftotextPath` / `maxPdfMb` / `includeUnlisted` / `workspaceDocDirs` / `userDocsDir` (default `~/.cmsis-pack-docs/user`, kept so imported documents stay attributed) and `buildInfo.maxSymbols` / `logGlobs` apply live. The `cmsis-pack-docs` skill ships as a fourth bundled skill; `cmsis-debug-live` and `add-board-layer` point at the tools instead of an external MCP; `cmsis-help` lists them. Extracted text now lives under this extension's global storage, so pages are re-extracted once. The 22 test suites and fixtures came along; the routing test covers the dispatch, the transport test measures the all-on list and the no-build answers, and the packaged-VSIX check verifies the SVDs and the skill ship. If the standalone extension is still installed, activation warns that agents would see the tool names twice.

### Changed
- **`search_target_docs` indexes the page heading as a weighted field** (#29). A register page's body speaks of bits; only its heading names the register and says what it is, so BM25 over the body alone missed it unless the query happened to use the body's words. The heading is now a second field in the index (version 2; existing indexes are rebuilt from the persisted page text on first use, no re-extraction) scored at weight 5 on top of the body, and the old ×3 post-boost becomes a tie-breaker. Measured with the new opt-in benchmark `npm run bench:search -- --pages <doc.pages.jsonl> --svd <device.svd>` on RM0455 (2 965 pages, 495 register headings) with queries taken from the STM32H7B3 SVD rather than the manual: description-only queries R@1 49.5 % → 64.5 %, R@3 70.9 % → 81.8 %, MRR 0.621 → 0.741; description plus register name R@1 78.1 % → 98.8 %, MRR 0.873 → 0.994. The benchmark reports R@1 / R@3 / MRR per heading weight and post-boost so future ranking changes are measured, not argued.
- **The architecture diagram shows the documentation path and renders on dark themes.** The "How It Works" picture gains the documentation retrieval box (pack PDFs, user and workspace documents, `fetch_doc` downloads → pdf.js → page store → the search tools, with the SVD joined in), is rendered on an opaque background — the previous transparent PNG had black labels, invisible on the dark extension page — and `npm run diagram` regenerates it from the Mermaid source with a local Chrome. The README explains the window routing and the documentation path in two paragraphs.
- **The extension icon is the Arm logo** the other Arm extensions (CMSIS Solution, CMSIS Debugger, Keil Studio Pack, Device Manager, …) carry — the same `arm.png` — instead of the icon inherited from DebugMCP.
- **The documentation system is marked experimental.** Every `packDocs.*` and `buildInfo.*` setting carries VS Code's `experimental` tag (the Settings UI shows the badge and the "Experimental" filter finds them), the two `.enabled` descriptions say so up front, and the README and `cmsis-help` label the two tool groups the same way — the tools, their arguments and output may change between releases.
- **The VSIX drops 10 MB of unused media.** `assets/DebugMCP.webp` (9.7 MB, referenced by nothing, shipped in every package since the fork) and `assets/DebugMCP.mp4` (15 MB in the repository, never shipped) are removed, `assets/architecture.svg` (an unused rendering of the diagram the README shows as PNG) too; the extension icon is 256 px instead of 1024 (1.4 MB → a few tens of KB); the design notes under `docs/` no longer ship — only `docs/agent-resources`, which the MCP resources read, does.
- **`search_target_docs` expands identifiers from the SVD** (#29 part 2). An identifier-only query — `USART1`, `GPIOAEN` — gains the words of its SVD description at half weight: a peripheral instance brings its type synonyms and description ("universal synchronous asynchronous receiver transmitter"), a bare field name brings the register it lives in (`RCC_AHB1ENR`) and the field's description, so the manual is found even when it never spells the identifier. The result says what was expanded. Prose, quoted phrases and register names are left alone: the benchmark showed expanding register names or the acronyms inside a sentence only dilutes the ranking (−2 points on description queries, −0.3 on bare register names), while the heading field already puts register pages first (R@1 98.2 % for the bare name). With the restriction all three benchmark sets are unchanged; the gain is on the instance and field queries the benchmark cannot score against the manual's headings.
- **PDFs are extracted with a bundled pdf.js; poppler is optional** (#28). `packDocs.extractor` gains `pdfjs` and `auto` now means pdf.js (legacy build, pure JavaScript, +0.8 MB in the bundle, loaded on first use), so a machine without `pdftotext` — most Windows hosts — indexes documents too; `pdftotext` stays selectable, and switching re-extracts a document on its next use rather than mixing text sources. Lines are rebuilt from pdf.js text items by baseline, with wide horizontal gaps kept as double spaces so register-table columns stay separable, and the tokenizer applies NFKC so ligatures and full-width forms from either extractor meet on one term. Gated by the search benchmark on RM0455 with the heading field on: pdf.js R@1 65.0 % / MRR 0.739 (description-only) and 99.1 % / 0.995 (with the register name) against pdftotext's 64.5 % / 0.740 and 98.8 % / 0.994 — within noise; 2 965 pages in 3.9 s. `npm run bench:search -- --pdf <file> --extractor pdfjs|pdftotext` runs the comparison.
- **Agents are told to search the documentation, not to ask for it.** The MCP instructions now say, with the documentation tools on, to use them before asking the user for a datasheet or manual and instead of reading a PDF into context — a document the user provides goes into the workspace `docs/` folder or through *Import Document for Current Target* and is searched; with the tools off (the default) they name the `packDocs.enabled` setting so an agent suggests it rather than asking for documents. The same rule is in the `cmsis-pack-docs`, `cmsis-debug-live` and `add-board-layer` skills, and the `build` topic of `get_debug_instructions` replaces its "check the documentation in the CMSIS Solution UI" advice with the tools. The transport test asserts the default instructions carry the pointer. Prompted by a session in which an agent went to the web for an ADC datasheet that was already indexed as a user document: the instructions, the tool descriptions and the skills now say that third-party parts on the board (sensors, ADCs, codecs) are documented the same way — any part-number lookup starts at `list_target_docs`, a datasheet that is not listed is fetched by URL with `fetch_doc` (the web finds the URL, the tools read the document), and the user's `docs/` folder and the import command are where such documents belong. The same session first hit a `Blinky+MPS3` fixture in the workspace: `list_target_docs` and the build-artefact tools now ask the CMSIS Solution extension which csolution and target-type are active and pick that context when a workspace holds several solutions, noting the choice; the ambiguity error remains when nothing matches, and `target` still wins (`docs/improvement-notes.md` §10).

### Fixed
- **A skill sync interrupted mid-copy no longer leaves a `.<skill>.tmp-<pid>` directory behind** in the skills directories — Claude Code and VS Code listed such leftovers as skills. The installer removes stale staging of a skill before staging it again. The paths in the build-artefact and documentation tool results use forward slashes on Windows too.

## [2.3.8] - 2026-08-28

### Added
- **`add-board-layer` skill** — a third extension-authored skill, always installed like `cmsis-debug-live` and `cmsis-help`: add a board layer to an existing csolution by interview. It reads the csolution, the DFP/BSP pdsc and an existing layer first and asks only the decisions they cannot settle (scope, layer strategy, probe, STDIO transport, memory), then reuses the BSP layer, integrates the DFP's configuration generator when the pack ships no `Device:Startup` and startup exists only as generator output (STM32CubeMX, MCUXpresso Config Tools, Infineon Device Configurator, Microchip MCC — the agent selects the generator components, runs the first cbuild pass and tells the user to run the generator, which it cannot do for them), or writes a minimal bare-metal layer (CMSIS C startup, `retarget_stdio.c` on the reset clock, `regions_<board>.h`, minimal device header), wires the target-type into the csolution and builds to green, then hands over to `csolution-retarget` for the hardware bring-up. Hardware facts — register offsets and bit meanings, the reset clock tree, VCP instance and pins, errata — come from the pack documentation through the CMSIS Pack Docs MCP (`list_target_docs`, `search_target_docs`, `read_doc_pages`) when it is installed, cited by document and page and cross-checked against the SVD; without it the skill says what is unverified. The `cmsis-project` router's workflow points at it and `cmsis-help` lists it.

## [2.3.7] - 2026-08-25

### AI Efficiency Optimizations

1. **Tool list −20 %** — the `tools/list` every turn carries shrank from 33.2 to 26.7 kB (single-window surface); per-call `timeoutMs` notes collapsed to one line, rationale moved to the skill; a 30 kB budget and 700-char/description cap are asserted in the transport test.
2. **`serial.enabled` setting** — off drops the ten `serial_*` tools from the list entirely.
3. **`get_debug_instructions` by topic** — ~2 kB overview + one section on request instead of one 21 kB block.
4. **Compact motion state** — step/continue/pause/`wait_for_stop` return location, frame ids, top 5 frames and the breakpoint list only when it changed; full snapshot only at session start.
5. **Capped listings** — variables: 40 per scope, 200 chars per value (uncapped with `variableNames`); call stack: 20 frames, workspace-relative paths; threads: 32; `read_memory` defaults to hex.
6. **Lighter recovery** — after a motion timeout, PC and LR are read instead of all 23 core registers.
7. **`diagnose_fault`** — one call replaces the ~6-call HardFault loop (fault registers as one 24-byte read, stacked frame, top frames, address resolution, ranked hypotheses with the next call).
8. **`lookup_peripheral` / `lookup_register`** — SVD answers with no session and no target access; unknown names get suggestions instead of the full name list.
9. **`cmsis_action` target check/switch** — every result names the target it ran on and `target` switches/verifies it, removing the wrong-target build → confused-investigation round trips.
10. **Measurement built in** — per-call telemetry (bytes in/out, ms, outcome), the `cmsis-developer-assistant://stats` resource, the `get_session_status` trailer and optional JSONL export; the eval-scenario runner scores an agent's run against tool-call, turn and time budgets.

### Added
- **`cmsis_action` checks and switches the target** — the tool used to act on whatever target-type the CMSIS Solution panel happened to have selected, and its result never said which; on a board + FVP or HE/HP solution a build or flash could go to the wrong context unnoticed. Every result now names the target it ran on (`✅ CMSIS 'build' succeeded on HP@debug …`), `get_device_info` reports the panel's `CMSIS target:`, and the new optional `target` input (`MPS3` or `HP@debug`, the csolution's own names) selects one: a differing target is switched — the selection is written to `.vscode/cmsis.json` and the solution re-activated, the mechanism the extension (1.70) itself uses since it exposes no command for it — and verified through `cmsis-csolution.getActiveTargetSet` before anything runs. An undeclared target is refused with the declared list, an unverifiable switch with what was written and what the extension still reports, and a switch under a live debug session with a pointer to `stop_debugging`. The build topic and the `cmsis-debug-live` skill say when to pass `target`; the transport test drives the refusal, switch and no-op paths against a stubbed extension.
- **Agent evaluation scenarios** — `npm run eval:scenario -- <id>` runs a real Copilot CLI session against a planted bug and reports what it cost: tool calls by name with argument and result bytes, reasoning turns, wall time, the server's per-tool byte totals (from the `cmsis-developer-assistant://stats` resource, diffed around the run), and a verdict from the final answer against the expected root cause plus tool-call, turn and time budgets; infrastructure failures are reported as such, not as agent failures. Ships the BSP Blinky example for the Corstone-300 FVP as the fixture (`test/eval/fixtures/corstone-blinky`, with the FVP shim for Docker on macOS) and five deterministic scenarios (divide by zero, undefined instruction through a corrupted function pointer, MSPLIM stack overflow, unaligned access, an LED off-by-one with no fault). Opt-in only — it needs an authenticated Copilot CLI, a VS Code window on the work directory and an FVP or board; the pure logic (scenario validation, event aggregation, verdict, mcp-config edit) is unit-tested. `scripts/test-skill-trigger.ts` shares the Copilot CLI helpers.
- **`diagnose_fault`** — one call replaces the six-call HardFault loop: the decoded fault registers (read as one 24-byte SCS block), the stacked exception frame located through EXC_RETURN (PSP or MSP, basic or FP-extended) with the PC of the faulting instruction and its caller, the top frames, the faulting address resolved against the SVD or the Cortex-M system map (an unclocked `I2C1.CR1`, a null pointer plus offset, SRAM), and up to three ranked hypotheses each with the next tool call — unclocked peripheral, null pointer, wild pointer, imprecise write, stack overflow (with MSPLIM/PSPLIM when the core has them), corrupted function pointer, missing Thumb bit, unaligned access, divide by zero, FPU off, bad VTOR. Every section after the fault registers degrades to a note instead of failing the call; with no fault flag set it returns a short stop context. `get_fault_info` now also names `STKOF` (Armv8-M stack limit) and `DEBUGEVT`, and its text is otherwise unchanged. Four long tool descriptions were shortened to keep the tool list within its byte budget.

## [2.3.6] - 2026-08-24

### Added
- **`lookup_peripheral` and `lookup_register`** — answer SVD questions without a debug session and without touching the target: the peripheral list, a peripheral's register map (offsets, absolute addresses, access), which peripheral and register sit at an address (turn a BFAR into `I2C1.CR1`), and one register's bit fields with their enumerated values (which bit is the clock enable). The SVD is resolved from an explicit `svdFile`, the active session, `out/**/*.cbuild-run.yml` (`pname` picks the core) or a single workspace `.svd`, and the failure text lists what was tried. Unknown names get suggestions instead of the full name list — `read_peripheral_register` now does the same and points at `lookup_peripheral`. The parser reads `addressBlock`s, `enumeratedValues` and `dim` register arrays, and no longer borrows a field's `access` for its register.
- **`cmsis-developer-assistant.serial.enabled`** (default on) — off leaves the ten `serial_*` tools out of the MCP tool list, which every agent turn carries. Fixed per server instance (window reload), so the tool list a client sees never changes between turns.

### Changed
- **Smaller tool results.** Step, continue, pause and `wait_for_stop` now return a compact state: the location and frame ids, the top 5 frames with the rest counted, and the breakpoint list only when it changed since the last snapshot (a count otherwise) — the full snapshot still comes back when a session starts. `read_memory` defaults to `hex` (`ascii` / `both` on request). `get_call_stack` prints workspace-relative paths and collapses frames beyond 20 unless `levels` is given; `get_threads` lists up to 32 tasks. Variable listings without `variableNames` are capped at 40 variables per scope and 200 characters per value, with a footer saying how many were left out and how to widen; with `variableNames` nothing is capped. The recovery section after a motion timeout reads PC and LR instead of all 23 core registers. Tool descriptions state the caps.
- **Smaller tool list.** The serialized `tools/list` every client receives at `initialize` — and re-sends to the model on every turn — shrank by a fifth (33.2 → 26.7 kB for the single-window surface): the per-call `timeoutMs` note is one short line per tool with the rationale once in the server instructions, and the `start_debugging`, `cmsis_action`, `reset`, `add_breakpoint`, `add_logpoint`, `flash` and `get_debug_instructions` descriptions carry the trigger and the one caveat an agent needs at call time; the reasoning moved to the `cmsis-debug-live` skill and the `get_debug_instructions` topics (`build` for the result line and long builds, `breakpoints`, `inspection` for reset methods). The transport test now asserts a byte budget for the tool list and a 700-character cap per description.
- **`get_debug_instructions` takes a `topic`** — the guide for harnesses that do not load skills (GitHub Copilot Chat) no longer arrives as one 21 KB block. Without `topic` the tool returns a ~2 KB overview (the critical steps, the debugger-first rule) plus the list of topics; `session`, `build`, `breakpoints`, `inspection`, `faults` and `troubleshooting` return one section each. The guide itself was restructured around those topics (marker comments a Markdown reader never sees), gained a `faults` section (EXC_RETURN, the stacked frame, resolving BFAR, the usual cause per flag) and a `build` section (cmsis_action result line, long builds, flash, attach), and its inherited root-cause examples about `getUserById()`, `parseFloat()` and payment forms were replaced by Cortex-M ones (stale D-cache after DMA, an unclocked peripheral, a watchdog fed from a blocking task, a stale `SystemCoreClock`). The full guide stays available as the `cmsis-developer-assistant://docs/debug_instructions` resource; shipped docs are now read once per server instance.

## [2.3.5] - 2026-08-24

### Added
- **Per-tool call telemetry** — every MCP tool call is measured at the server boundary: argument and result bytes, wall time and outcome (`ok` / `timeout` / `error`). `get_session_status` now ends with a two-line summary for the session, the new `cmsis-developer-assistant://stats` resource returns the per-tool totals as JSON (session and server instance, plus the last 50 samples) so a test driver can diff it around a run, one INFO line per call goes to the output channel, and the new **`cmsis-developer-assistant.telemetry.jsonlPath`** setting (default off) appends one JSON line per call to a file — names and sizes only, never arguments or results. `test/realboard/run.ts` writes the statistics into its report. Groundwork for measuring the response-size work and for agent evaluation runs.

## [2.3.3] - 2026-08-21

### Changed
- **The upstream skills repository is now [Open-CMSIS-Pack/cmsis-skills](https://github.com/Open-CMSIS-Pack/cmsis-skills)** (renamed from cmsis-agent) and the extension adopts the name throughout: the vendored tree is `skills/cmsis-skills/`, the lock is `skills/cmsis-skills.lock.json`, the catalog source id is `cmsis-skills`, and the pin moved to the renamed repository's current `main` (`d778b91`, documentation-only changes upstream — the 21 skills are unchanged, same content hash). Nothing changes on disk for users; installed skills are re-marked on the next sync.

## [2.3.2] - 2026-08-21

### Added
- **`cmsis-developer-assistant.aiSkills.enabled`** (default on) — enable the AI Skills Pack for selected agents: the Open-CMSIS-Pack/cmsis-agent skills and their per-category entry points. Off: the pack skills this extension installed are removed on the next sync (marker-guarded — your own skills are never touched), the skills step of the setup and the install prompt are skipped, the extension's own `cmsis-debug-live` and `cmsis-help` stay installed, and the `installedSkills` selection is kept so turning it back on restores exactly what you had. Toggling it re-syncs immediately, like a change to the selection.
- **`cmsis-developer-assistant.aiSkills.promptOnDetect`** (default on) — when an agent has the MCP server registered (detected in its config file) but no pack skill has been selected, a notification offers to install the CMSIS AI Skills: **Select Skills** opens the picker, **Later** asks again in 30 days, **Don't ask again** turns the setting off. At most once a month, recorded in `globalState` (`skillsPrompt.lastShownAt`, cleared by *Reset Popup State*); never while the first-run setup is still pending, never under Antigravity/Gemini, never with the pack disabled. The decision is a pure function with tests (`src/test/skillPrompt.test.ts`).
- **`/cmsis-help` skill** — answers "what can I ask the CMSIS Developer Assistant for?": the CMSIS slash commands, the member skills behind each entry point, the VS Code commands, the MCP tool groups and the settings. Generated by `npm run skills:sync` from the catalog, `package.json` and `scripts/skills.config.json` (`src/utils/skillHelp.ts`) and re-rendered by the tests, so a new command, setting or skill that is not reflected in the shipped file fails `npm test`. Always installed; the routers end with a pointer to it.

### Changed
- **The bundled skills are always installed.** `cmsis-debug-live` and `cmsis-help` no longer depend on the `installedSkills` selection, which now holds only picks from the pack (default `[]`; an existing value that names `cmsis-debug-live` keeps working). The picker no longer lists them. A user who had deselected `cmsis-debug-live` gets it back.
- **Extension description and keywords** widened to the extension's scope: "Enable AI coding agents to manage and extend CMSIS projects, with a set of AI skills and MCP server to interface to build and debug."

## [2.3.1] - 2026-08-20

### Fixed
- **`docs/agent-resources/troubleshooting/csharp.md` carried three unresolved merge-conflict hunks** (`<<<<<<< HEAD … >>>>>>> 251b176`) left by the rebase-merge of the 2.1.0 rename — the file ships in the VSIX and is served to agents as the `troubleshooting/csharp` MCP resource. Resolved; `SUPPORT.md` is back on LF line endings.
- **The architecture diagram on the extension page now ships inside the VSIX.** vsce rewrote the README's relative image link to `package.json`'s `repository` on GitHub, so the extension page showed whatever `assets/architecture.png` that branch held — the original DebugMCP drawing, not the diagram this build was made from. `scripts/package.ts` now generates the packaged readme with the image inlined as a `data:` URI (the only in-package source VS Code's extension page accepts) and the other relative links rewritten as before; `README.md` in the repository keeps its relative paths for GitHub.

## [2.3.0] - 2026-08-20

### Added
- **The Open-CMSIS-Pack/cmsis-agent skills ship in the extension, opt-in.** The 21 skills of [cmsis-agent](https://github.com/Open-CMSIS-Pack/cmsis-agent) (project setup, device debug/trace knowledge, CMSIS-Pack debug authoring) are vendored verbatim under `skills/cmsis-agent/` at a commit pinned in `skills/cmsis-agent.lock.json` (`npm run skills:sync`; upstream has no tags or releases), listed in a generated `skills/catalog.json`, and installed only when selected — the new setting `cmsis-developer-assistant.installedSkills` (application scope, default `["cmsis-debug-live"]`) holds the picks, the new command **Select Agent Skills** (also step 2 of the first-run setup) edits them. The selection is applied on activation and whenever the setting changes, so it follows Settings Sync.
- **One slash command per category instead of 21.** Generated router skills `cmsis-project`, `cmsis-bring-up` and `cmsis-pack` dispatch to their member skills; picking a router installs the members with `user-invocable: false`, which keeps them out of the `/` menu in Claude Code, VS Code and Copilot CLI while the model can still invoke them by description. The `$name` cross-references in each skill are recorded as dependencies and installed (hidden) alongside whatever is picked, so a skill never arrives without the skills it hands over to.
- **Skills are now written to `~/.claude/skills/` as well**, when a Claude home exists — Claude Code reads only its own directory, not `~/.agents/skills/`, so earlier releases' skill was invisible to it. `$COPILOT_HOME/skills/` is written only when that variable is set (the Copilot CLI then ignores `~/.agents/skills`); the unconditional `~/.copilot/skills/` copy is no longer written and the old one is cleaned up.
- **Skill directories are marked and replaced, not merged.** Every directory the extension installs carries `.cmsis-developer-assistant.json`; only marked directories (or the pre-marker `cmsis-debug-live`) are ever replaced or removed, a user's own skill of the same name is left alone and reported, and a re-sync replaces the directory so files dropped from the bundle do not linger. `src/test/skillCatalog.test.ts` pins the catalog to the directories on disk and the lock's content hash; `src/test/skillInstaller.test.ts` covers the marker rules in temp directories.
- **MCP `instructions` at `initialize`.** The server now tells clients up front that these tools drive a live Cortex-M session and that a runtime investigation should start by invoking the `cmsis-debug-live` Agent Skill — target awareness, the session-status gate, breakpoint strategy, step-and-inspect, fault decode, root cause — or `get_debug_instructions` in harnesses that do not load skills. `start_debugging` says the same in one sentence. (Upstream #129.)
- **Debugger-first rule** in the skill and in the `get_debug_instructions` guide. Do not start a runtime investigation by adding `printf` over UART/ITM, LED toggles or trace macros — on a Cortex-M that is a rebuild, a reflash and a reset per hypothesis, and it moves the timing you are observing. Halt and inspect instead; reach for `add_logpoint` only knowing it still stops the core per hit. The skill description gained the trigger vocabulary (runtime bugs, faults, crashes, hangs, failing tests, wrong/null values, unexpected output) so skill-aware harnesses pick it for the right prompts. (Upstream #129.)
- **Contract tests for that guidance** (`src/test/debugSkillGuidance.test.ts`): the trigger words, the debugger-first wording, and that the skill, the MCP instructions and the instructions guide stay consistent. (Upstream #130.)
- **Opt-in live trigger evaluation**, `npm run test:skill-trigger-agent`: runs a real Copilot CLI session in a scratch worktree carrying only the skill, with an embedded prompt, and asserts `cmsis-debug-live` is its first tool call. Deliberately outside `npm test` — needs an authenticated Copilot CLI, spends credits, and a model's first move is not deterministic. (Upstream #130.)

### Changed
- **Commands consolidated.** *Configure Agents and Skills* (`cmsis-developer-assistant.configure`) runs the two-step flow — agents, then skills — that the first-run prompt shows; *Select Agent Skills* runs step 2 alone. *Show Agent Selection Popup* and *Configure Agents* are removed; *Reset Popup State* stays but is hidden from the palette. The first-run flag moved to `popupShown.v3` so existing users see the skills step once.
- `scripts/**` no longer ships in the VSIX.

### Fixed
- **The first-run agent setup picker came back on every activation until something was selected.** Dismissing it (Esc, focus loss) now counts as an answer; manual setup stays available via *Configure Agents and Skills*. (Upstream #115.)

## [2.1.0] - 2026-08-18

### Changed
- **Renamed to CMSIS Developer Assistant** and relocated to the Open-CMSIS-Pack organization. The extension id, settings prefix (`cmsis-developer-assistant.*`), command namespace, MCP server name (tool namespace `mcp__cmsis-developer-assistant__*`), `mcpServerDefinitionProvider` id, resource URIs, and internal identifiers all move from `cmsis-debugmcp` to `cmsis-developer-assistant`. On activation, existing users' external agent configs (Claude Code/Desktop, Cline/Roo, Cursor, Copilot CLI, Antigravity, and the Codex TOML section) are migrated from the old key to the new one and the stale entry removed, so no dead duplicate server is left behind. Agent `autoApprove` lists pinned to the old `mcp__cmsis-debugmcp__*` tool names will need re-approving once.
- **Detached from the Microsoft DebugMCP upstream.** Syncing has stopped; the "fork of" framing is reworded and the Microsoft governance boilerplate (CONTRIBUTING / CODE_OF_CONDUCT / SUPPORT) replaced with Open-CMSIS-Pack equivalents. Microsoft's copyright notice and the MIT license text are retained.

### Added
- **Dual-licensed under Apache-2.0 OR MIT.** `LICENSE-MIT` added beside the Apache-2.0 `LICENSE`; a `NOTICE` records provenance.

## [2.0.3] - 2026-08-10

### Fixed
- **2.0.2 could not activate at all: `Cannot find module './impl/format'`.** `jsonc-parser`'s default entry is a UMD bundle that hands `require` to its factory as a parameter, so esbuild cannot trace `require("./impl/format")` and left the call in the bundle; at runtime it resolved relative to `dist/`, where `impl/` does not exist. esbuild now aliases the package to its ESM build, which uses ordinary static imports.
- **The packaged-VSIX harness never loaded the bundle**, which is how a completely dead extension passed every check and shipped. It now requires the entry point and asserts `activate`/`deactivate` are exported. Verified the check catches the original failure by rebuilding without the alias.

## [2.0.2] - 2026-08-10

### Fixed
- **The bundled agent skill is now actually installed.** It shipped inside the VSIX but was only copied to `~/.agents/skills/` from `configureAgent()` — the agent-registration dialog. Anyone who registered their agents in an earlier release never opens that dialog again, so upgrading delivered the skill to nobody. It is agent-independent by design, so it now installs on activation and overwrites, keeping it in step with the installed extension version instead of drifting behind it.

## [2.0.1] - 2026-08-10

### Changed
- **The extension is bundled with esbuild.** Ships one `dist/extension.js` plus `serialport`'s subtree instead of the whole production dependency tree: **2271 files / 14.7 MB → 246 files / 12.4 MB**. `serialport` stays external because `node-gyp-build` resolves its native `.node` relative to `__dirname` at runtime, so bundling it would break every serial tool. `test/transport/packaged-vsix.js` unpacks a built VSIX and checks the native binding really enumerates ports — that failure mode exists only in the packaged extension, never in development.

### Fixed
- **Compiled tests are no longer packaged.** `.vscodeignore` excluded `src/**` and `test/**` but not `out/test/**`, so every release up to 1.2.1 shipped compiled tests unnoticed. It surfaced when `vsce` refused to package 2.0.0: the redaction tests carry credential-shaped fixtures to prove those shapes get withheld, and the secret scanner found them in the VSIX.

## [2.0.0] - 2026-08-10

Upstream sync: the fork was based on `microsoft/DebugMCP` `4422d8c` (2026-03-14) and had cherry-picked three commits since. Upstream is 102 commits ahead at v2.3.0. This release takes what applies to Cortex-M, adapts what does not, and says which is which.

It also carries the hardware-tool work that had accumulated unreleased on `feature/hw-tools-reset-wait-flash-dwt`.

**Major, not minor.** Three things change behaviour an existing setup can depend on:

- **A window no longer always runs its own MCP server.** One window binds `serverPort` and routes to the rest; the OS-assigned fallback port is gone. Anything that discovered a per-window port, or assumed "my window = my server", has to change. This is the fix for agents driving the wrong board, so the old behaviour is not coming back.
- **The MCP transport is stateful.** Clients must carry the `mcp-session-id` from `initialize`. Every SDK client does; a hand-rolled client that POSTed bare JSON-RPC will now get a 400.
- **`add_breakpoint` prefers `line` over `lineContent`.** `lineContent` still works and is not going away this release, but it is deprecated and the response says so.

It also matches upstream's 2.x line, which this release syncs against.

### Added — hardware tools
- **`wait_for_stop` tool** — block until the target next stops (breakpoint, fault, step-complete, pause) and return the stop reason plus the current debug state, or a structured timeout. Built on raw DAP `stopped` events from the session tracker (the ground truth), not VS Code UI events. Returns immediately with the recorded reason when the target is already stopped. This replaces sleeping blind after `continue_execution` returned while the target was still running — the pattern that once missed a 15 s playback window.
- **`reset` tool** — reset the target inside the live session (breakpoints and session survive, unlike `restart_debugging`) via GDB monitor commands, and **verify the reset actually took effect**: after the reset-halt the PC must equal the reset handler read from the vector table (VTOR-based, falling back to table base 0). `method: auto` escalates `system` → `core` → `hardware` until one verifies; adapter replies that read like "unknown command" escalate instead of being trusted. Unverified resets are reported honestly ("target does NOT appear to have reset", with the adapter replies and the nSRST wiring caveat) — silent non-resets on attach configurations were a recurring field issue.
- **`read_cycle_counter` tool** — DWT CYCCNT for cycle-accurate timing: enables `DEMCR.TRCENA` and `DWT_CTRL.CYCCNTENA` when needed, reports `NOCYCCNT` cores honestly, and prints the wrap (~10.7 s @ 400 MHz), core-halt, and WFE-sleep caveats with the two-point delta recipe.
- **`flash` tool** — `pyocd load --cbuild-run <file>` as a synchronous operation: bytes programmed + rate on success, exit code + pyOCD error/output tail on failure. The cbuild-run file is auto-resolved from launch.json's `cmsis.cbuildRunFile` or a recursive `out/` scan; ambiguity is an error naming the candidates, never a silent pick. Refuses while a debug session is active (programming under a live session wedges most probes). Requires pyocd on PATH; `cmsis_action load` remains the bundled-pipeline alternative.
- **Launch-failure diagnostics passthrough.** The session tracker now keeps a bounded per-session ring of recent adapter traffic (failed DAP responses, adapter stderr/console output — `stdout` excluded so target printf can't flush real errors out). `start_debugging` failures and the `cmsis_action load_and_debug` / `attach` "did NOT survive the initial connect" report append it, instead of leaving the real cause in the extension-host log.

### Fixed — hardware tools
- **`read_peripheral_register` decoded full-word SVD fields as 0.** `decodeFields()` built its mask as `((1 << width) - 1) << bitLow`, but JS bitwise ops coerce to int32: `1 << 32` wraps to 1, so any `[31:0]` field got mask 0 and silently decoded to `0x0` for every register value; width-31 fields were corrupted by the negative `(1 << 31) - 1`, and fields touching bit 31 could print negative. The decode now shifts first (`>>>` is ToUint32) and masks with `2**width - 1` (exact for width ≤ 31), so no intermediate is ever a negative int32. Covered by new unit tests (widths 1/8/31/32, high-bit fields, negative-input normalization).
- **Parsed-SVD cache is now invalidated when a debug session ends.** `clearSvdCache()` existed but had no callers, so a session against a different device could have kept the previous device's decode.
- **Memory writes are verified.** New `writeMemoryWord` executor primitive (DAP `writeMemory` with GDB-`set` fallback) always reads the word back and throws "did not stick" on mismatch — a silently dropped write is exactly how "reset did nothing" happens in the field. Shared by `reset` and `read_cycle_counter`.

### Added — upstream sync
- **`add_logpoint` tool** — print a message and resume instead of halting, bound GDB-native via `dprintf`. Expressions interpolate as `{expr}`; GDB infers nothing about types, so `{expr}` defaults to `%d` and `{expr:%s}` / `{expr:%f}` / `{expr:%p}` override it, with `{{`/`}}` for literal braces. `dprintf` takes no inline `if`, so a `condition` is attached afterwards by breakpoint number — and the response says plainly when the adapter echoed no number to attach it to, rather than pretending the condition applied. The tool description does not claim logpoints are free here: the core still halts on every hit to format and print, which in an ISR or a hot loop distorts the timing you are usually measuring.
- **Conditional breakpoints** — `add_breakpoint` accepts `condition`, passed to GDB as its native `if` clause so the CPU is only halted when it holds. A VS Code-side condition would still stop the core on every hit and decide afterwards. Conditions, log messages, hit counts and disabled state are surfaced in `list_breakpoints` and the debug state as `file:line [when: ...]`.
- **`list_variable_names` tool** — names and types of everything in scope, reading no values. On a slow probe or a large frame that turns thirty round trips into one.
- **`variableNames` filter** on `get_variables_values` and `get_frame_variables` — read only what you asked for. Names are matched against the DAP `evaluateName` first and then the display name, with an adapter type decoration (`config [Dictionary]`) stripped from both; matching the raw display name alone leaves those variables unreachable. Requested names that match nothing are reported back rather than silently omitted. **Deliberately optional, unlike upstream**, which made it required in 2.3.0 — embedded frames are small, so the full dump is usually what you want, and making it mandatory would break every existing agent prompt for no gain.
- **Secret redaction** (`cmsis-debugmcp.redactSecrets`, default on) — values whose name or content looks like a credential are withheld before leaving the extension, on the variable views and `evaluate_expression`. Two fork-specific carve-outs, because the upstream name-only policy misfires badly on firmware: **numeric scalars are never withheld** whatever the variable is called (a `uint8_t auth`, a `token` counter and `0xDEADBEEF` all stay readable — a 32-bit integer cannot carry a credential), and **raw target reads bypass redaction entirely** (`read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`, and `-exec` GDB passthrough). Real SVDs name registers `KEY`, `KR`, `KEYR` and `UNLOCK` — the watchdog and flash unlock registers — and those are exactly what you need when the watchdog is resetting you. Strings, buffers and structures still get the full treatment.
- **Multi-window routing.** External agents get exactly one MCP URL, and until now every window ran its own server on whatever port it could get while `agentConfigurationManager` wrote whichever port that window received — so the last window to start won and the agent routinely drove a window that did not hold the board. Now one window binds the well-known port and forwards each call to the window that owns the target, over a token-gated loopback control server, using a shared file registry of live windows. Upstream routes on a file path alone, which suffices there because every one of its tools takes one; only four do here, so the resolution ladder continues past the path: an explicit pin, the session's established target, the sole window with an active debug session (the normal one-window-one-board case), then the sole window. Ties resolve to an error naming every candidate rather than a guess — reading the wrong board's memory reads as a firmware bug and costs far more than being asked to pick.
- **`list_debug_windows` and `select_debug_window` tools** — see the candidate windows and pin one for the session. Registered only when the server is actually routing.
- **Roo Code and Antigravity** added to the agent registration roster, and the selection popup is suppressed under Antigravity/Gemini, which configure MCP servers themselves.
- **`cmsis-debug-live` Agent Skill**, installed to `~/.agents/skills/` (and `~/.copilot/skills/` when present) on agent registration. Written for Cortex-M rather than adapted from upstream's host-process `debug-live`: target awareness from the CMSIS YAMLs, the five-state session gate, the FPB budget, what to do when a variable and the peripheral disagree, fault decode, and the routing tools. Named `cmsis-debug-live` so it cannot collide with upstream's skill when both extensions are installed.

### Changed — upstream sync
- **`add_breakpoint` takes a 1-based `line`.** It previously took a `lineContent` substring and set a breakpoint on *every* line containing it — in C routinely dozens (`}`, `return;`, `break;`), quietly exhausting the FPB comparators. `lineContent` remains as a deprecated optional fallback so existing agent prompts keep working, and the response says when it was used and how many lines matched.
- **MCP transport is per-session rather than per-request.** `initialize` mints an `mcp-session-id` and that session's transport serves its POSTs, its `GET` SSE stream and its `DELETE`. This is not a return to the shared-server bug that hung `get_threads` after three calls — that was one `McpServer` being closed and reconnected per request; a session-scoped server is never closed mid-flight, and `test/transport/session-lifecycle.js` asserts exactly that.
- **The MCP server no longer falls back to an OS-assigned port.** That fallback is what produced the misrouting. Losing the bind now means another window is the router, and this window becomes a worker; workers retry every 10s so closing the router promotes a survivor rather than leaving the agents' URL dead. Every window advertises the router's endpoint, including through the `McpServerDefinitionProvider`, so in-window Copilot routes exactly like an external agent.
- `deactivate()` is awaited, so a window leaves the shared registry before its extension host goes away.

### Fixed — upstream sync
- **The reported current line was read from the active text editor.** VS Code moves the editor cursor asynchronously after a stop and only for the focused editor, so the position lagged the actual stop and was simply wrong whenever focus was elsewhere — and on a `gdbtarget` session the editor may not track the target at all. It now comes from the DAP top stack frame, which is ground truth. This also removed the 300 ms settle sleep that existed only to let the cursor catch up. (Upstream PR #96.)
- **`GET /mcp` returned a bare 404.** Only `POST` was registered, so the server→client SSE stream a client opens right after `initialize` failed. Cursor's MCP client treats that as a fatal transport error and tombstones the connection as "errored" even while POST tool calls keep working. `GET` and `DELETE` are now registered at startup. (Upstream PR #96.)

### Internal
- Removed `waitForStateChange`/`hasStateChanged`, the old 1 s blind-poll loop, dead since stepping moved to the event-driven wait.
- Op dispatch across windows goes through one shared table checked against `IDebuggingHandler` and `SerialHandler` **at compile time**, so adding a tool without making it routable fails the build. Upstream hand-writes two switches; with 31 debug ops and 11 serial ops here, duplicating the list would guarantee drift, and an op that fell out would run in the router window against the wrong board.
- `test/transport/` — two harnesses that drive the real server over a real socket outside the extension host: the Streamable-HTTP session lifecycle (including the three-consecutive-`get_threads` regression gate) and two-window election, publication, pinning and router failover.
- 132 unit tests, up from 6.

### Not taken from upstream
- **The breaking `get_variables_values`** (required `variableNames`) — added as an optional filter instead.
- **`src/utils/withTimeout.ts`** — the fork's `src/utils/timeout.ts` is a superset (`customRequestWithTimeout`, `HardwareTimeoutError`).
- **`debugTestAtCursor` / VS Code Testing API test debugging** — no meaning for `gdbtarget` firmware.
- **Upstream's `debugConfigurationManager` refactor** — theirs went toward .NET/csproj auto-configuration; the fork's is CMSIS-specific and keeps `jsonc-parser`, which upstream dropped.
- **Removal of `get_debug_instructions`** — kept. Copilot Chat reads MCP tools but not `~/.agents/skills`, so removing it would leave that harness with nothing.
- **esbuild bundling** — prepared but **not enabled**; `esbuild` could not be installed in the environment where this was done, so the bundle was never built and the serial backend was never checked against a packaged VSIX. See [docs/packaging-esbuild.md](docs/packaging-esbuild.md).

## [1.2.1] - 2026-07-11

### Fixed
- **`cmsis_action build` (and `load` / `erase` / `load_and_run`) now return a terminal result instead of leaving the agent idling.** These actions were fire-and-return: the tool kicked off the `cmsis-csolution.*` command and immediately replied "issued — check the CMSIS output channel for build/flash progress." An agent has no tool to read a VS Code output channel and no completion signal, so it would wait indefinitely — in practice polling for an output artifact file that the tool never promised. The handler now listens for the cbuild/flash **VS Code task** and returns the real outcome from its process exit code: `✅ succeeded (exit 0)` with the suggested next step, or `❌ FAILED (exit N)` pointing at the compiler/linker errors to fix. If no task runs within the window it reports "nothing to build / picker open"; if the task is still running at the deadline it says so — every path is terminal and explicitly tells the agent **not** to wait for a file. `build`/`load`/`erase`/`load_and_run` now default to the full 60 s handler budget (they run a real build), while `load_and_debug` / `attach` keep their fast hand-off to `get_session_status` polling.

### Changed
- The `cmsis_action` tool description now states that build/flash actions return a terminal exit-code result, so the agent stops trying to poll for build completion.

## [1.2.0] - 2026-07-11

### Added
- **Claude Code and Claude Desktop registration.** Both now appear in the agent selection popup and the manual configuration command. Claude Code gets a user-scoped `{"type": "http", "url": ...}` entry in the top-level `mcpServers` of `~/.claude.json`; Claude Desktop (which supports only stdio servers) gets an `npx mcp-remote <url>` bridge entry in `claude_desktop_config.json`. The one-time agent popup re-appears once after upgrading so existing installs can opt in.

### Security
- **MCP server now binds the loopback interface only.** `app.listen(port)` without a host binds `0.0.0.0`, so the server — which exposes flash download, erase, memory reads, and arbitrary GDB expression evaluation without authentication — was reachable from the local network, contradicting the README's "runs 100% locally". Both the preferred-port and the OS-assigned-fallback listeners now bind `127.0.0.1`. VS Code Remote / WSL port forwarding is unaffected (it forwards localhost).
- **DNS-rebinding protection.** Requests whose `Host` header (or `Origin`, when present) is not a loopback address are rejected with 403. Without this, a malicious web page could point its own DNS name at `127.0.0.1` and drive the debugger through the victim's browser — loopback binding alone does not stop that.

### Fixed
- **Port fallback silently pointed a second VS Code window at the first window's debug server (the port-allocation bug).** `listenWithFallback()` used the `app.listen(port, host, callback)` callback as its success signal, but in Express 5 that callback is invoked unconditionally — *before* the bind result is known. On `EADDRINUSE` it fired with `server.address() === null`, the promise resolved with the dead, unbound server, and the `EADDRINUSE` handler's fallback listener resolved nothing and was leaked. `getActualPort()` then fell back to the *configured* port (3001) — the one already owned by the first window. Consequences: the second window reported "server running on :3001", registered `:3001` with Copilot and wrote it into every agent config, and its agent then drove the **first window's debug session and hardware target** — while the second window's own server accepted no connections at all. Bind success is now taken from the server's `listening` event, the port is read back from the bound socket, and `start()` fails loudly rather than guessing a port.
- A persistent `error` listener is now attached to the running HTTP server; previously a post-startup socket error would have been an unhandled `error` event and taken down the extension host.
- `stop()` clears the cached port so a stopped server can no longer report a live endpoint.
- Changing `cmsis-debugmcp.serverPort` now prompts to reload the window. Previously the setting silently had no effect until the next reload, while agent configs kept pointing at the old port.
- **Spurious "Migrated N agent configuration(s)" toast on every activation.** The migration check treated any `type: 'http'` entry as legacy, but `http` is the *correct* transport for GitHub Copilot CLI (and now Claude Code) — those entries were rewritten and re-announced on every startup. Migration now only fires when the existing transport differs from the one the agent should use.
- **Config files are never clobbered on parse failure.** Previously an unparseable agent config was silently replaced with a fresh object — catastrophic for `~/.claude.json`, which holds session history and settings beyond MCP entries. Configuration now aborts with an error message instead. All config writes go through a temp-file + rename so a crash mid-write can't truncate the file.
- **Stale endpoint refresh.** When the server starts on an OS-assigned fallback port, existing agent config entries pointing at the old port are silently updated on activation instead of being left dead.
- Removed dead code left over from the pre-stateless transport design (`isServerRunning()`, the unused `transports` map) and consolidated the four hardcoded version strings onto `SERVER_VERSION`.
- Packaged `.vsix` shrinks from 29.5 MB to 14.6 MB — the 15 MB demo video was being shipped to every user despite being referenced only from the GitHub repo.

## [1.1.9] - 2026-05-19

### Fixed
- **`cmsis_action attach` false success — real fix (bug #3, third attempt).** Previous attempts probed `getSessionStatus()`, whose DAP `threads` ping is *answered by the adapter process* even when GDB is not connected to a target — a zombie `gdbtarget` session (adapter alive, no target behind the port) kept its VS Code session object and answered the ping for several seconds, so both probes read a phantom `running`. The decisive signal is now a **non-empty thread list**: a zombie answers `threads` with `[]` (no target → no threads), a real attached Cortex-M always reports ≥1 thread. `confirmSessionSurvives()` now requires `getThreads()` to return ≥1 thread at the decisive (t+6 s) probe; an adapter with a session object but 0 threads is correctly reported as "not connected to a target".
- **Residual breakpoint-warning noise.** `add_breakpoint` / `clear_all_breakpoints` / `remove_breakpoint` no longer surface the harmless raw adapter error ("Error: could not evaluate expression") in their output. For an `unconfirmed` classification the line now reads `<no echo from adapter — normal>`; `delete`/`clear` only echo the GDB reply when it carries a real message (`Deleted…`, a rejection), staying silent otherwise.

## [1.1.8] - 2026-05-19

### Fixed
- **False-negative breakpoint warnings.** `add_breakpoint` and `clear_all_breakpoints` printed scary warnings ("⚠️ GDB did not confirm binding", "GDB delete failed") for operations that actually succeeded. Two causes: (1) the DAP `evaluate` of an `-exec break`/`delete` is not a reliable success signal — the `gdbtarget` adapter runs the command (breakpoint binds / delete happens) but frequently returns an empty or error `evaluate` response because it has no scalar result to hand back; (2) `clear`/`clearAll` issued the evaluate with no `frameId`, which the adapter rejects ("Evaluation of expression without frameId is not supported") even though the command still ran. Fixes: a shared `execGdbCommand()` helper now always supplies a `frameId` and never throws on an evaluate error; replies are classified `bound` / `rejected` / `unconfirmed`, and only a *definite* GDB rejection ("No source file", "No symbol", …) produces a warning. A missing echo is reported neutrally — "set; verify with continue_execution" — not as a failure.

## [1.1.7] - 2026-05-19

### Fixed
- **`cmsis_action attach` false "up and stable" (bug #3, second attempt).** The v1.1.6 fix probed `getSessionStatus()` once after a 3 s wait — but a `gdbtarget` session with no GDB server behind the port keeps its *adapter process* alive answering a shallow DAP `threads` ping for a few seconds before collapsing, so a single probe still caught it in the alive window and the "and stable" wording then positively asserted a stability that was false. Now `confirmSessionSurvives()` probes at **two** time points (t+3 s and t+6 s); each requires the session object to still exist *and* `getSessionStatus()` to be `running`/`stopped`. A no-target session has collapsed to `no-session` by the second probe, so it is correctly reported as "did not survive the initial connect", with guidance to start a GDB server or use `load_and_debug`.

## [1.1.6] - 2026-05-19

Fixes from the v1.1.5 full-tool-surface test report (27/30 tools passing).

### Fixed
- **Breakpoints now actually bind on the target (bug #1, the priority).** `add_breakpoint` populated VS Code's breakpoint *model* via `vscode.debug.addBreakpoints()`, but on `gdbtarget` sessions the resulting `setBreakpoints` DAP request was not reliably forwarded to the adapter — the target ran straight through. `add_breakpoint` now *also* binds GDB-native via `-exec break file:line` (exactly what a raw GDB session does, which was verified to work), and reports GDB's confirmation (`Breakpoint N at 0x…`). `remove_breakpoint` issues `-exec clear file:line`; `clear_all_breakpoints` issues `-exec delete`. The VS Code model is still updated so `list_breakpoints` and the editor gutter stay in sync.
- **`cmsis_action attach` no longer reports premature success (bug #3).** A session object appearing is not proof the session is alive — when no GDB server is behind the port, `attach` produced a session that collapsed within seconds. After the session appears, the handler now waits 3 s and re-probes; it reports success only if the session is still `running`/`stopped`, otherwise it reports the collapse and tells the agent to start a GDB server / use `load_and_debug`.
- **`start_debugging` "launch.json does not exist for passed workspace folder".** That error is thrown by VS Code core when the passed workspace folder doesn't resolve. `startDebuggingByName` now uses a robust `resolveWorkspaceFolder()` — exact API lookup → trailing-slash-normalised path-prefix match (both directions) → the sole workspace folder when there is only one — and, if nothing matches, returns a clear message listing the open workspace folders instead of letting VS Code throw the opaque core error.

### Known / not yet fixed
- `cmsis_action load_and_debug` builds + flashes but on some projects does not chain into a tracked debug session (no gdbserver/gdb spawned). Workaround: run an external GDB server and use `cmsis_action attach`. Under investigation — likely a CMSIS Solution extension launch-config interaction.

## [1.1.5] - 2026-05-18

### Changed
- **`cmsis_action` now asks the CMSIS Solution extension whether a solution is active**, instead of inferring it. Before firing any action it calls `cmsis-csolution.getSolutionFile` (which returns the extension's internal `_activeSolution` and never throws) — a truthy result means a csolution project is loaded in this VS Code window. If none is active, the tool returns a precise message naming the cause and the fixes, *without* attempting the command. This replaces the earlier guess based on `.vscode/cmsis.json` presence, which was wrong: `cmsis.json` is legitimately empty/absent for single-target solutions, so a csolution project can be perfectly active without it.

## [1.1.4] - 2026-05-18

### Changed
- **`cmsis_action` "No active solution set" is now an actionable error.** When the CMSIS Solution extension has no active solution context, the tool returns a specific message naming the cause (the VS Code window running this MCP server does not have the project's `*.csolution.yml` open) and the three concrete fixes, instead of the generic "ensure a solution context is active". Includes the `serverVersion` so a stale build is ruled out at the same time.

## [1.1.3] - 2026-05-18

### Changed
- **`cmsis_action` is now fire-and-return.** It previously blocked the whole tool call until the debug session was fully up — a multi-core flash + attach legitimately takes 20-40 s, so the call felt hung (and could report a misleading 60 s timeout). It now kicks off the CMSIS command, does one short (~8 s) opportunistic wait for a fast bring-up, then returns and tells the agent to poll `get_session_status` — matching how the CMSIS Solution panel's Debug button behaves (returns instantly, progress shown separately). Worst-case tool duration drops from ~60 s to ~12 s.

### Added
- **`get_session_status` diagnostics line.** Now reports `serverVersion`, `liveSessionsInThisWindow` (count + names), and whether `vscode.debug.activeDebugSession` is set. When state is `no-session` with `liveSessionsInThisWindow=0`, the hint explicitly calls out the two real causes: a stale extension build (reload the window), or the debug session running in a *different* VS Code window than the MCP server (each window has its own extension host — they cannot see each other). This turns a single `get_session_status` call into a definitive diagnosis instead of guesswork.

## [1.1.2] - 2026-05-18

### Fixed
- **`get_session_status` reported `no-session` while a debugger was visibly running**: the executor read `vscode.debug.activeDebugSession` directly, which only reflects the session the VS Code UI currently has *focused* — it is `undefined` whenever focus is elsewhere, which is routine for `gdbtarget` multi-core launches. The `sessionStateTracker` already saw every session via its `DebugAdapterTrackerFactory`, so it now also maintains a live-session list and exposes `resolveActiveSession()` = `activeDebugSession ?? mostRecentLiveSession`. All 20 `vscode.debug.activeDebugSession` reads in `debuggingExecutor.ts` route through it, so session status, inspection, stepping, and serial cleanup all work regardless of UI focus. (A session in a *different* VS Code window runs in a different extension host and remains genuinely invisible — that is not fixable.)

## [1.1.1] - 2026-05-18

### Fixed
- **`cmsis_action` could hang Copilot indefinitely**: `handleCmsisCommand` was the one hardware-touching handler never wrapped in `withHandlerTimeout` (it was added in v1.0.23, after the wrap was applied to the other tools). `await vscode.commands.executeCommand('cmsis-csolution.cmsisLoadAndDebug')` blocks until the CMSIS command's handler resolves — if that command surfaces a QuickPick (select context / debugger), the await waits for a UI interaction the agent cannot make, hanging the tool call forever. Now: the handler is wrapped in `withHandlerTimeout`, and the `executeCommand` is raced against an 8 s kick-off deadline — the build/flash continues in the CMSIS extension regardless, and for session-producing actions we poll for the session afterwards.
- **`cmsis_action load_and_debug` / `attach` falsely reported "no debug session became ready"**: `waitForActiveDebugSession` polled `hasActiveSession()`, which is true only when the target is *stopped*. A `load_and_debug` whose firmware runs free (no `break main`) or an `attach` to a running target left a perfectly healthy session that the poll never accepted → 60 s timeout → misleading error. `waitForActiveDebugSession` now polls `getSessionStatus()` and accepts any responsive state (`stopped` **or** `running`). Also fixes the same false timeout in `start_debugging` and `restart_debugging`.

## [1.1.0] - 2026-05-18

Ports three useful changes from upstream `microsoft/DebugMCP` (commits after the fork point `4422d8c`), adapted for the CMSIS fork.

### Added
- **Codex agent configuration support** (from upstream `5feecd4`): `AgentConfigurationManager` now writes a `[mcp_servers.cmsis-debugmcp]` block into the Codex `config.toml` (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`). TOML is upserted in place, preserving the rest of the file. Stale `/sse` endpoints are migrated.
- **GitHub Copilot CLI support** (from upstream `7cbe4f9`): writes an MCP entry into `$COPILOT_HOME/mcp-config.json` (default `~/.copilot/mcp-config.json`) with `type: 'http'` + `tools: ['*']`, the shape the Copilot CLI expects. (The Copilot *extension* in VS Code is still handled dynamically by the `McpServerDefinitionProvider` — no static config.)

### Fixed
- **launch.json parsed with `jsonc-parser`** (from upstream `9c422e5`): the previous regex-based comment stripping matched `//` inside string values — e.g. an `https://` URL in a config field — corrupting the JSON and causing parse failures. CMSIS Solution generates `launch.json` with comments, so this was a real bug for the fork. All three parse sites in `debugConfigurationManager.ts` switched to `jsonc.parse`.

### Notes
- Upstream's `6f7fa56` ("Remove extra checks in hasActiveSession()") was **not** ported — the fork already replaced that gate with a DAP-event tracker + `ensureStoppedSession` + state-aware errors, which is the better fix for embedded targets.

## [1.0.27] - 2026-05-18

First public release of the fork. Rolls up the work between v1.0.9 (initial CMSIS fork tag) and v1.0.27 into one release. Published as a GitHub release with `cmsis-debugmcp-1.0.27.vsix` attached.

### Added — CMSIS-Solution-driven workflow
- **`cmsis_action` MCP tool**: wraps the CMSIS Solution panel buttons. Actions: `build`, `load`, `erase`, `load_and_run`, `load_and_debug`, `attach`, `detach`, `stop_run`. **Preferred entry point for Cortex-M debug** over `start_debugging` — `load_and_debug` builds (if needed), flashes the device, and attaches the debugger in one step, matching the panel's "Debug" button. `load_and_debug` and `attach` wait for the session to be usable before returning.
- **Pre-check refusal on duplicate session**: `start_debugging`, `cmsis_action load_and_debug`, and `cmsis_action attach` now refuse with a structured message when a debug session is already active, naming the existing session and pointing the agent at `stop_debugging` / `restart_debugging`.
- **`start_debugging` re-scoped**: tool description rewritten to flag it as **non-CMSIS only** (Python / Java / JS / etc.). For CMSIS projects, `cmsis_action load_and_debug` is the right call.

### Added — Pause, call-stack, threads, frame variables
- **`pause_execution` MCP tool**: DAP `pause` for inspecting a running target without ending the session. State-aware: no-op if already stopped, refuses if probe is unresponsive.
- **`get_call_stack` MCP tool**: full DAP `stackTrace` with frame IDs (up to 200 levels). Agent can walk the stack and pass `frameId` to `get_frame_variables`.
- **`get_threads` MCP tool**: DAP `threads` enumeration. With RTOS-aware GDB servers (pyOCD `--rtos`, J-Link RTOS plugin), FreeRTOS / RTX / ThreadX tasks appear as threads — matching the xRTOS viewer task list.
- **`get_frame_variables` MCP tool**: inspect variables at an explicit `frameId` without changing the editor's active frame. Lets the agent walk up the call stack and examine caller-frame state.

### Added — Per-call timeouts and auto-heal
- **`timeoutMs` parameter on every hardware-touching tool**: agent-supplied deadline, server-capped to 60 000 ms regardless of input.
- **Handler-level `withHandlerTimeout` race**: every inspection tool is wrapped in an outer Promise.race so it always returns within the cap, even if the DAP layer hangs. On overshoot, returns a structured "did not complete within N ms" message with diagnostic guidance.
- **Auto-heal on motion timeout**: `continue_execution` / `step_*` automatically pause the running target on overshoot, read the PC + active frame via `read_core_registers`, and append a 🩹 Recovery section to the response — the agent knows where the firmware actually was instead of seeing a silent "still running".

### Added — Dual serial backend
- **OWNED port** via `serialport` package: `serial_open` / `serial_close` / `serial_write` / `serial_read` (from `'owned'`) / `serial_clear_buffer` / `serial_list_ports` / `serial_status`. MCP server holds the connection and buffers RX up to 1 MB. Use when no MS Serial Monitor UI session is active on the same tty.
- **MS Serial Monitor BRIDGE**: `serial_subscribe_monitor` / `serial_unsubscribe_monitor` runtime-probe `ms-vscode.vscode-serial-monitor` exports for any of `onDidReceiveData` / `onDataReceived` / `onData` / `onSerialData` / `onDidReadData` / `subscribeData`. Today the public API (v0.1.7) only exposes port enumeration; the bridge falls back with a clear "data event not available" message. Auto-lights-up when MS ships a data event — no rebuild needed.
- **`serial_status`**: reports both backends side-by-side and lists the discovered `ext.exports` keys so the agent can confirm what the installed Serial Monitor build exposes.
- **`serial_open_monitor`**: focuses the MS Serial Monitor panel for the user (does not open or read a port). Uses the correct view container ID `vscode-serial-monitor-tools`.

### Added — Stateless HTTP transport (concurrency fix)
- **Per-request `McpServer` instances**: the previous shared-server pattern (`close()` → `connect(newTransport)` on every POST) raced when two tool calls landed concurrently — request B's `close()` stripped the transport request A was about to respond on, hanging request A forever. Now each POST to `/mcp` constructs its own `McpServer` + transport pair and registers tools fresh, matching the official MCP stateless example. Eliminates the `get_threads`-after-three-calls hang.

### Added — Hardware-connection robustness
- **DAP-event-driven session state**: a global `DebugAdapterTrackerFactory` records `stopped` and `continued` events per session. `hasActiveSession()` and `get_session_status` consult this tracker instead of `vscode.debug.activeStackItem`, which is `undefined` whenever the CPU is running and during the brief race window right after a stop event. Eliminates spurious "session is not ready" / "no debug session" reports while the target is just running.
- **`get_session_status` MCP tool**: never-failing classification of the session into `no-session` / `initializing` / `running` / `stopped` / `unresponsive`, with a hint about what to do next.
- **State-aware inspection errors**: inspection tools (`get_variables_values`, `evaluate_expression`, `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`) route through `ensureStoppedSession` and report the actual session state ("running — add a breakpoint", "unresponsive — call check_target_connection") instead of a misleading "no debug session".
- **Per-DAP-request timeouts**: every `customRequest` to the debug adapter is wrapped with a deadline. A stalled probe cannot hang an MCP tool call indefinitely.
- **`HardwareTimeoutError`**: dedicated error type with actionable message.
- **`check_target_connection` MCP tool**: low-cost DAP `threads` ping with a short internal timeout. Diagnostic-grade liveness check.
- **`hasDebugSession()` / `hasActiveSession()` split**: synchronous session-existence check (for `stop_debugging` / `restart_debugging`, works even when target is running) vs. async stopped-frame check (for inspection tools).
- **Parallel core-register reads**: `read_core_registers` issues all 23 evaluates concurrently with per-request and overall deadlines. Individual register failures report `<timeout>` / `<unavailable>` instead of bringing down the whole call.
- **Bounded `read_memory`** and **`read_peripheral_register`**: total time per call capped by `memoryReadTimeoutMs`.
- **`restart_debugging` actually waits** for the session to become ready again, rather than returning after a fixed 300 ms delay.
- **`step_*` / `continue_execution` surface timeouts and session loss**: results annotate when the target failed to stop within the timeout or when the session terminated mid-operation, instead of silently returning a stale state.

### Added — Agent guidance (`debug_instructions.md`)
- **PHASE 0 — Target awareness**: agent reads `<name>.cbuild-idx.yml` → `<context>.cbuild.yml` → `<context>.cbuild-run.yml` → `.vscode/launch.json` before any debug call, and asks the user to regenerate `launch.json` via **Manage Solution → Debugger** if missing. Pointers to CMSIS-Pack documentation links from the CMSIS Solution dialog.
- **PHASE 1 — Session status gate**: 5-state decision table for `get_session_status`, telling the agent the correct next action for each (`no-session` → `cmsis_action load_and_debug`; `running` → pause first; `unresponsive` → `check_target_connection`).
- **Cortex-M hardware breakpoint limit**: documents the FPB comparator ceiling (M0/M0+/M23: 4, M3/M4: 6, M7/M33/M55/M85: 8) and recommends `list_breakpoints` before adding, iterative replacement, and `clear_all_breakpoints` between phases.

### Added — Real-board test driver
- **`test/realboard/run.ts`**: end-to-end test runner that connects to the running MCP server (Streamable HTTP) and exercises every tool. Pre-flight `estimatedMs` per test; hard timeout `min(2 × estimatedMs, 60 s)`; pauses and runs a diagnostic sweep (`get_session_status` / `check_target_connection` / `get_fault_info`) on every overshoot. Board-specific knobs (endpoint, configurationName, ELF region, peripheral name, serial path) come from `realboard.config.json`.

### Configuration
- **`cmsis-debugmcp.dapRequestTimeoutMs`** (default 10000) — per-request DAP timeout.
- **`cmsis-debugmcp.memoryReadTimeoutMs`** (default 30000) — overall cap for `read_memory` / `read_core_registers`.

### Removed
- **Static `mcp.json` write for GitHub Copilot**: superseded by the `vscode.lm.registerMcpServerDefinitionProvider` registration done at extension activation, which eliminates the startup race condition and handles dynamic port assignment automatically. Cline and Cursor static configs are still written.

## [1.0.9] - 2026-04-16

### Added — CMSIS-DebugMCP fork
- **Project rename**: `DebugMCP` → `CMSIS-DebugMCP`. Extension name, display name, MCP server name, resource URIs (`cmsis-debugmcp://docs/...`), configuration keys (`cmsis-debugmcp.*`), and command IDs updated.
- **`gdbtarget` passthrough**: when `start_debugging` is called with `configurationName`, the named entry from `launch.json` is passed directly to `vscode.debug.startDebugging()` without language detection or config rewriting. `fileFullPath` is now optional in this path.
- **Five new embedded MCP tools**: `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`, `get_device_info`.
- **Cortex-M fault decoder**: decodes CFSR (MMFSR/BFSR/UFSR), HFSR, DFSR, MMFAR, BFAR, AFSR into human-readable diagnostics.
- **Peripheral register reader**: uses the Peripheral Inspector extension API when available; falls back to SVD parsing + DAP `readMemory`.
- **CMSIS knowledge resources**: `cmsis-debugmcp://docs/cmsis-embedded-guide` and `cmsis-debugmcp://docs/troubleshooting/embedded` provide Cortex-M expertise to agents.

### Upstream history (DebugMCP)

## [1.0.8] - 2025-03-14

### Added
- Improved debug state reporting with richer context for AI agents
- Named debug configuration support via `configurationName` parameter — use specific `launch.json` configurations by name

### Fixed
- Fixed debug state consistency issues during rapid step operations

## [1.0.7] - 2025-02-XX

### Changed
- **Migrated from SSE to Streamable HTTP transport** — faster, more reliable MCP communication
- Automatic migration of existing SSE configurations to new Streamable HTTP format
- SSE backward compatibility maintained during transition period

### Fixed
- Dependency security updates (undici, express, body-parser, glob, js-yaml)

### Internal
- Migrated from `fastmcp` to official `@modelcontextprotocol/sdk`

## [1.0.6] - 2025-01-XX

### Added
- **Agent auto-configuration popup** — automatically detects and registers with AI assistants (Cline, Copilot, Cursor)
- **Comprehensive documentation** — added architecture docs, AGENTS.md, and troubleshooting guides
- Language-specific debugging tips for Python, JavaScript, Java, C#, C++, and Go

### Fixed
- Fixed failure when `launch.json` contains comments (JSONC parsing)
- Fixed C++ debug configuration issues
- Fixed string equality comparison in breakpoint matching

## [1.0.5] - 2025-01-XX

### Added
- **Debug specific test methods** — pass `testName` to debug individual unit tests
- Clear all breakpoints tool for quick cleanup
- Breakpoint listing tool to view all active breakpoints

### Changed
- Default launch configurations moved to lower priority (user configs preferred)
- Improved MCP tool descriptions for better AI agent understanding

## [1.0.4] - 2024-12-XX

### Added
- **C#/.NET debugging support**
- Keep-alive for SSE sessions to prevent timeouts

## [1.0.3] - 2024-12-XX

### Added
- Multi-language debugging support: Python, JavaScript/TypeScript, Java, C/C++, Go, Rust, PHP, Ruby
- Breakpoint management (add, remove, list, clear all)
- Step-through execution (step over, step into, step out)
- Variable inspection with scope filtering (local, global, all)
- Expression evaluation in debug context
- Automatic debug configuration generation from file extensions
- MCP server with SSE transport

## [1.0.0] - 2024-12-XX

### Added
- Initial release
- Core debugging capabilities via MCP protocol
- VS Code Debug Adapter Protocol integration
- Automatic MCP server startup on extension activation