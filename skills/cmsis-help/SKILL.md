---
name: cmsis-help
description: "List what the CMSIS Developer Assistant offers and which part fits a task: the CMSIS slash commands (cmsis-bootstrap, cmsis-project, cmsis-bring-up, cmsis-pack, cmsis-debug-live, cmsis-pack-docs, add-board-layer) and the member skills behind each, the VS Code commands that register agents and select skills, the MCP tool groups for building, flashing and live Cortex-M debugging, and the settings that control the AI Skills Pack. Use when the user asks what CMSIS skills, commands or tools are available, which skill or tool to use for a CMSIS task, how to install more CMSIS skills, or how the CMSIS Developer Assistant is configured. Not a workflow itself — it points to the skill or tool that does the work."
---

# CMSIS Developer Assistant — what you can ask for

<!-- cmsis-developer-assistant:rules:begin -->
## CMSIS Developer Assistant tool rules

Only the user can lift a rule, by asking for the specific command.

- Talk to the board only through the cmsis-developer-assistant MCP tools. Never run `pyocd`, `gdb`, `JLinkExe`, `JLinkGDBServer` or `openocd` against the board from a shell, and never install pyOCD.
- Build, load, erase, run and debug with `cmsis_action`; program with `flash`. Run `cbuild`, `csolution` or `cpackget` in a shell only when the user asks for it or a CMSIS skill step names the command.
- Serial I/O only through the `serial_*` tools, not `screen`, PuTTY, a read of the port or a serial script.
- Manuals, datasheets and register meanings through the documentation tools; use the web only to find a PDF URL for `fetch_doc`, and never read a PDF into your context.
- Symbol, section, memory-usage and build-log questions through the build-artefact tools, not `nm`, `size` or a grep over the map file.
- If a tool you need is not in your tool list, name the setting that enables it (`cmsis-developer-assistant.packDocs.enabled` or `cmsis-developer-assistant.buildInfo.enabled`) instead of substituting a shell command.
- The control server and the registry files are internal: never call or read them. With several VS Code windows open, use `list_debug_windows` and `select_debug_window`.
- A running target rejects reads and steps: call `pause_execution` first.
- If a tool fails twice, call `get_session_status` and `get_recent_problems`, then stop and tell the user what to do in VS Code. Do not work around a failing tool with a shell command.
<!-- cmsis-developer-assistant:rules:end -->

## How to use this list

Answer the user from the lists below: which CMSIS slash commands, VS Code commands,
MCP tools and settings exist, and which one fits the task at hand. This skill does no
work of its own and runs no tools — it points at the skill or tool that does. A
`/name` whose `../<name>/SKILL.md` is missing next to this file is not installed; the
user adds it with **CMSIS Developer Assistant: Select Agent Skills** in VS Code or by
editing the `cmsis-developer-assistant.installedSkills` setting.

## Slash commands

| Command | What it does |
|---|---|
| `/cmsis-project` | Create, extend or retarget CMSIS csolution and Zephyr projects — one command for the whole category; its 8 member skills are listed below |
| `/cmsis-bring-up` | Establish verifiable device debug and trace facts from documentation — one command for the whole category; its 7 member skills are listed below |
| `/cmsis-pack` | Author, validate and apply PDSC debug and trace sequences and debugvars — one command for the whole category; its 7 member skills are listed below |
| `/add-board-layer` | Add a board layer to an existing CMSIS csolution by interviewing the user for the few facts that cannot be read from the repo — board/device, layer strategy, debugger, STDIO transport, memory — then generating Board.clayer.yml and its startup / retarget-stdio / regions / device-header files (reusing the BSP layer when it fits, running the DFP's configuration generator when startup only comes from it, or a minimal bare-metal layer otherwise) and wiring the target-type into the solution. |
| `/cmsis-bootstrap` | Go from an empty VS Code window to a CMSIS solution that builds and debugs |
| `/cmsis-pack-docs` | Look things up in the documentation of the current CMSIS csolution target through the CMSIS Developer Assistant documentation tools (list_target_docs, search_target_docs, read_doc_pages, fetch_doc, get_peripheral_docs) — the reference manual, datasheet, errata and board manual the packs ship or link, the Arm documents for the device's core (architecture reference manual, ADIv5/ADIv6, CoreSight and ETM specifications, core TRM), and the datasheets of third-party parts (sensors, ADCs, codecs) the user added or fetch_doc downloaded. |
| `/cmsis-debug-live` | Drive a live Arm Cortex-M debug session through the CMSIS Debugger to investigate firmware runtime bugs — HardFaults and other faults, crashes, hangs, failing tests, peripherals that do not respond, wrong/null values that are right in simulation but wrong on hardware, unexpected output, code that never reaches the line you expect, timing that does not close. |
| `/cmsis-help` | This list. |

## Member skills by category

Selecting a category entry point installs its members with `user-invocable: false`:
they stay out of the `/` menu, the model invokes them by description or through the
entry point, and the user can also select them individually to make them visible.

### Project setup (`/cmsis-project`)

- `$add-cmsis-target` — Add a verified target and packaged board layer
- `$check-cmsis-environment` — Verify CMSIS build tools and compiler toolchains
- `$check-zephyr-environment` — Verify a local Zephyr west environment
- `$cmsis-debugger-setup` — Wire the debug adapter of a csolution target and verify Load & Debug
- `$identify-cmsis-board-layer` — Find compatible packaged CMSIS board layers
- `$identify-cmsis-board-support` — Resolve one board or device and find its BSP or DFP
- `$identify-zephyr-board` — Resolve a physical board to a Zephyr target
- `$start-zephyr-project` — Create a CMSIS solution for a Zephyr board

### Device debug and trace knowledge (`/cmsis-bring-up`)

- `$board-debug-knowledge` — Document board-level debug and trace knowledge.
- `$check-pyocd-availability` — Find pyOCD or the CMSIS Debugger bundle.
- `$debug-access-knowledge` — Verify reusable CMSIS debug access facts.
- `$debug-knowledge` — Document reset and low-power debug behavior.
- `$pyocd-detect-debug-topology` — Capture supplementary CMSIS debug scan evidence.
- `$resolve-official-device-documentation` — Recover authoritative vendor device documentation.
- `$trace-knowledge` — Document SoC CoreSight trace topology

### CMSIS-Pack debug authoring (`/cmsis-pack`)

- `$apply-confirmed-pdsc-proposal` — Apply and validate a confirmed PDSC proposal
- `$generate-debug-description` — Add verified CMSIS-Pack debug definitions
- `$generate-debug-sequences` — Generate verified device debug sequences
- `$generate-trace-sequences` — Generate CoreSight trace PDSC sequences
- `$manage-pdsc-debugvars` — Design and safely integrate PDSC debug variables
- `$prepare-pdsc-sequence-change` — Prepare evidence-backed PDSC sequence proposals
- `$validate-pdsc-sequence-xml` — Validate PDSC sequence XML and block formatting

### Live debugging (selected one by one)

- `$debugger-troubleshooting` — Find out why a debug or flash session fails to start, connect or program
- `$fvp-debug-setup` — Make Load & Debug and Run work against an Arm FVP model

## VS Code commands

Open the command palette (Ctrl/Cmd+Shift+P) and type the title.

- **CMSIS Developer Assistant: Configure Agents and Skills** (`cmsis-developer-assistant.configure`) — The first-run setup, on demand: register the MCP server with the agents you pick, choose the AI Skills Pack skills to install, then add the tool rules to your agents' rule files (CLAUDE.md, AGENTS.md, …), each change shown as a diff first.
- **CMSIS Developer Assistant: Select Agent Skills** (`cmsis-developer-assistant.selectSkills`) — Pick the AI Skills Pack skills (category entry points or individual skills) to install, and where: the current project's `.agents/skills` (this workspace only — the default, so the skills cost context only where they apply) or your personal skills directories (every workspace).
- **CMSIS Developer Assistant: Select Target Window** (`cmsis-developer-assistant.selectTargetWindow`) — With several VS Code windows open, choose the default window for agent calls that name no window or file (also a click on "CDA" in the status bar), or Automatic.
- **CMSIS Developer Assistant: Release Serial Port** (`cmsis-developer-assistant.releaseSerialPort`) — Take back a serial port an agent holds in this window, so the Serial Monitor or a terminal can open it (also a click on "Serial: …" in the status bar); the agent is told why when it next uses the port.
- **CMSIS Developer Assistant: List Target Documentation** (`cmsis-developer-assistant.listTargetDocs`) — Write the current csolution target's documentation list (pack manuals, Arm documents, imported and workspace PDFs) to the output channel.
- **CMSIS Developer Assistant: Index Target Documentation** (`cmsis-developer-assistant.indexTargetDocs`) — Extract and index every PDF of the current target now, with progress, so the first search is instant.
- **CMSIS Developer Assistant: Import Document for Current Target** (`cmsis-developer-assistant.importUserDoc`) — Copy PDFs the packs do not ship (NDA manuals, portal downloads) into the user documents folder, attributed to the current pack, device, board or core, and index them.
- **CMSIS Developer Assistant: Open User Documents Folder** (`cmsis-developer-assistant.openUserDocsFolder`) — Reveal the user documents folder in the file manager.
- **CMSIS Developer Assistant: Open Pack Docs Panel** (`cmsis-developer-assistant.openPackDocsPanel`) — Open the Pack Docs panel: the resolved target, its documents and their index state, the SVD peripherals, the page store (with confirmed actions to clear the extracted text or delete the downloaded PDFs), and a runner for the documentation tools.
- **CMSIS Developer Assistant: Copy Recent Problems** (`cmsis-developer-assistant.copyRecentProblems`) — Copy the last 50 warnings and errors this window recorded (debug adapter and GDB server, failed tasks and builds, notifications, serial ports) to the clipboard, to paste into a bug report instead of a screenshot.

## MCP tools

The CMSIS Developer Assistant MCP server (`http://localhost:3001/mcp`, registered with
the agents the user selected in the setup) exposes these tool groups:

- **CMSIS Solution actions** — `cmsis_action` — build, load, erase, load_and_run, load_and_debug, attach, detach, stop_run (the CMSIS Solution panel buttons), status (the job in flight) and open_solution (open the folder of a csolution in a VS Code window and activate it; works from an empty window); `flash` — program with the CMSIS Debugger's pyOCD, with a synchronous result.
- **Run control** — `start_debugging`, `stop_debugging`, `restart_debugging`, `continue_execution`, `pause_execution`, `step_over`, `step_into`, `step_out`, `wait_for_stop`, `reset`.
- **Breakpoints** — `add_breakpoint` (by line, optional condition), `add_logpoint`, `remove_breakpoint`, `list_breakpoints`, `clear_all_breakpoints`.
- **Inspection** — `get_call_stack`, `get_threads`, `get_frame_variables`, `list_variable_names`, `get_variables_values`, `evaluate_expression`.
- **Cortex-M** — `read_memory`, `read_core_registers`, `read_peripheral_register` (SVD), `lookup_peripheral` / `lookup_register` (SVD map and bit fields, no session needed), `get_fault_info` (CFSR/HFSR decode), `diagnose_fault` (one-call triage: frame, stack, address, hypotheses), `read_cycle_counter`, `get_device_info`.
- **Board/device catalog** — `discover_board_or_device` — read-only board/device candidates and separate BSP/DFP packs through CMSIS Solution API v2, without a project or debug session. Exact literal names first; ambiguity is reported. Catalog completeness is unknown: no match does not prove no support. Catalog facts do not verify attached hardware.
- **Serial ports** — `serial_capture` (one call: open, read until a regex matches or a deadline, close), `serial_list_ports`, `serial_open`, `serial_read`, `serial_write`, `serial_close`, `serial_status`, `serial_clear_buffer`, and the Serial Monitor bridge `serial_subscribe_monitor` / `serial_unsubscribe_monitor` / `serial_open_monitor`.
- **Session health and windows** — `get_session_status`, `check_target_connection`, `get_recent_problems` (what went wrong in the window: adapter and GDB-server errors, failed tasks and builds, notifications), `get_debug_instructions`; with several VS Code windows `list_debug_windows` and `select_debug_window`.
- **Documentation (experimental, on by default — cmsis-developer-assistant.packDocs.enabled)** — `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs` — page-cited answers from the reference manuals, datasheets, errata and board manuals the target's packs ship or link, Arm documents, imported and workspace PDFs, and third-party part datasheets (sensors, ADCs) — start any part-number lookup here; fetch_doc indexes a PDF URL found on the web.
- **Build artefacts (experimental, on by default — cmsis-developer-assistant.buildInfo.enabled)** — `list_build_artifacts`, `get_memory_usage`, `lookup_symbol`, `get_section_layout`, `get_build_diagnostics` — the ELF, linker map and build log of the current target, read deterministically.

For the debugging workflow call `get_debug_instructions` (or read the
`cmsis-developer-assistant://docs/debug_instructions` resource); for a live target investigation
invoke `/cmsis-debug-live` first. The *Agent Tools* section of the extension README lists
every tool and parameter.

<!-- cmsis-developer-assistant:shell-to-tool:begin -->
## Shell commands and the tools that replace them

| Instead of | Use |
|---|---|
| `pyocd load`, `pyocd flash` | `flash`, or `cmsis_action load` |
| `pyocd reset`, `monitor reset` | `reset`, which verifies that the target did reset |
| `pyocd gdbserver`, `JLinkGDBServer`, `openocd`, `arm-none-eabi-gdb` | `cmsis_action load_and_debug`, or `cmsis_action attach` for firmware started with `cmsis_action load_and_run` |
| `pyocd commander`, `gdb -ex "x/…"` | `read_memory`, `read_core_registers`, `evaluate_expression` |
| `pyocd list`, `JLinkExe` to check the probe | `check_target_connection`, `get_session_status` |
| `pip install pyocd` | nothing to install: `flash` uses the pyOCD bundled with the CMSIS Debugger, then the one `.cmsis/tools-environment.yml` names, then PATH |
| `cbuild …` | `cmsis_action build` |
| `arm-none-eabi-nm`, `readelf -s` | `lookup_symbol` |
| `arm-none-eabi-size`, a grep over the `.map` file | `get_memory_usage`, `get_section_layout` |
| a grep over the build log | `get_build_diagnostics` |
| `screen /dev/tty…`, `cat /dev/tty…`, PuTTY or `type COM3` on Windows, a pyserial script | `serial_capture` for one read; `serial_open`, `serial_read`, `serial_write`; `serial_subscribe_monitor` while the Serial Monitor holds the port |
| `curl localhost:<port>` with the registry token | `list_debug_windows`, `select_debug_window` |
| reading a PDF, a web search for a register | `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs`, `lookup_register` |
<!-- cmsis-developer-assistant:shell-to-tool:end -->

## Settings

VS Code settings under `cmsis-developer-assistant.*` (Settings → Extensions → CMSIS Developer Assistant):

| Setting | Default | What it does |
|---|---|---|
| `cmsis-developer-assistant.installedSkills` | `[]` | The AI Skills Pack skills (entry points or individual skills) to install. As a User setting they go into your personal skills directories (every workspace), as a Workspace or Folder setting into that project's `.agents/skills` only; `cmsis-debug-live`, `add-board-layer`, `cmsis-bootstrap`, `cmsis-pack-docs` and `cmsis-help` are always installed personally. |
| `cmsis-developer-assistant.aiSkills.enabled` | `true` | Install the AI Skills Pack at all. Off: pack skills this extension installed are removed, the skills setup step and the install prompt are skipped; the selection is kept. |
| `cmsis-developer-assistant.aiSkills.promptOnDetect` | `true` | Offer to install the pack — at most once a month — when an agent has the MCP server registered but no pack skill is selected. |
| `cmsis-developer-assistant.agentRules.install` | `"ask"` | `ask`: the setup offers to add the tool rules to your agents' rule files, previewed, and keeps blocks written earlier current. `never`: no rule file is touched. |
| `cmsis-developer-assistant.packDocs.enabled` | `true` | Experimental. Offer the documentation tools (list_target_docs, search_target_docs, read_doc_pages, fetch_doc, get_peripheral_docs) to agents. On by default; off drops the five tools from the tool list; PDFs are indexed with the bundled pdf.js, nothing to install; window reload. |
| `cmsis-developer-assistant.buildInfo.enabled` | `true` | Experimental. Offer the build-artefact tools (list_build_artifacts, get_memory_usage, lookup_symbol, get_section_layout, get_build_diagnostics) to agents. On by default; off drops the five tools from the tool list; window reload. |

*Generated by `npm run skills:sync` from skills/catalog.json, package.json,
scripts/skills.config.json and docs/agent-resources/tool-contract.md; edit those, not
this file.*
