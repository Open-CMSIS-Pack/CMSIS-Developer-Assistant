---
name: cmsis-help
description: "Health check and entry point for the CMSIS Developer Assistant, and the first skill for any CMSIS or Cortex-M task. Use when firmware misbehaves on a board: faults, crashes, hangs, failing tests, wrong/null values, unexpected output, runtime bugs, a board that does not respond or a debug session that will not start. Also use to check whether the board, the debug session, the build or a serial port is ready, and for any other CMSIS task. It checks the session read-only, reads recent problems and names the debug topic or knowledge procedure that fits. Use it whenever live inspection is practical, instead of adding temporary printf/UART logging, LED toggles, or console output: halting the CPU and looking is cheaper and does not perturb the target."
when_to_use: "First, before any work on a board's firmware; when a board, a probe or a debug session does not respond; to check that the board, the debug session, the build or a serial port is ready; instead of adding printf/UART logging; and when the cmsis-developer-assistant tools seem to be missing."
allowed-tools:
  - get_session_status
  - list_debug_windows
  - check_target_connection
  - get_recent_problems
  - get_debug_instructions
  - knowledge_search
  - knowledge_get
  - list_target_docs
  - search_target_docs
---

# CMSIS Developer Assistant — health check and where to look

<!-- cmsis-developer-assistant:rules:begin -->
## CMSIS Developer Assistant tool rules

These rules cover Arm Cortex-M targets of the CMSIS Debugger (`gdbtarget` launch configurations, CMSIS solutions). A host program or a board of another toolchain is not covered: use your usual tools there. For a covered target only the user lifts a rule, by asking for the specific command.

- Talk to the board only through the cmsis-developer-assistant MCP tools: never run `pyocd`, `gdb`, `JLinkExe`, `JLinkGDBServer` or `openocd` against it from a shell, and never install pyOCD.
- Build, load, erase, run and debug with `cmsis_action`; program with `flash`. Run `cbuild`, `csolution` or `cpackget` in a shell only when the user asks or a procedure from `knowledge_get` or a CMSIS skill names it.
- Serial I/O only through the `serial_*` tools, not `screen`, PuTTY, a read of the port or a serial script.
- Manuals, datasheets and register meanings through the documentation tools; use the web only to find a PDF URL for `fetch_doc`, and never read a PDF into your context.
- Firmware symbol, section, memory-usage and build-log questions through the build-artefact tools, not `nm`, `size` or a grep of the map file.
- When a call fails twice the same way, follow the hints of `get_session_status` and `get_recent_problems`, never a shell command; a value GDB cannot read is an answer, not a failure. Leave the target running when you finish, and ask the user only for what no tool can do.
<!-- cmsis-developer-assistant:rules:end -->

<!-- cmsis-developer-assistant:shell-to-tool:begin -->
## Shell commands and the tools that replace them

| Instead of | Use |
|---|---|
| `pyocd load`, `pyocd flash` | `flash`, or `cmsis_action load` |
| `pyocd reset`, `monitor reset` | `reset`, which verifies that the target did reset |
| `pyocd gdbserver`, `JLinkGDBServer`, `openocd`, `arm-none-eabi-gdb` | `cmsis_action load_and_debug`; or `cmsis_action run` (the GDB server without programming) followed by `cmsis_action attach` |
| `pyocd commander`, `gdb -ex "x/…"` | `read_memory`, `read_core_registers`, `evaluate_expression` |
| `pyocd list`, `JLinkExe` to check the probe | `check_target_connection`, `get_session_status` |
| `pip install pyocd` | nothing to install: `flash` uses the pyOCD bundled with the CMSIS Debugger, then the one `.cmsis/tools-environment.yml` names, then PATH |
| `cbuild …` | `cmsis_action build` |
| `cbuild … --update-rte`, *CMSIS: Refresh* by hand | `cmsis_action refresh` |
| `vcpkg activate`, *Arm Tools: Activate Environment* by hand | `cmsis_action activate_environment` |
| `arm-none-eabi-nm`, `readelf -s` | `lookup_symbol` |
| `arm-none-eabi-size`, a grep over the `.map` file | `get_memory_usage`, `get_section_layout` |
| a grep over the build log | `get_build_diagnostics` |
| `screen /dev/tty…`, `cat /dev/tty…`, PuTTY or `type COM3` on Windows, a pyserial script | `serial_capture` for one read; `serial_open`, `serial_read`, `serial_write` |
| `curl localhost:<port>` with the registry token | `list_debug_windows`, `select_debug_window` |
| reading a PDF, a web search for a register | `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs`, `lookup_register` |
<!-- cmsis-developer-assistant:shell-to-tool:end -->

## Health check (read-only)

Run these in order and stop as soon as an answer decides the next step:

1. `get_session_status`: the session state and its hint. Follow the `session` topic of `get_debug_instructions` for the state it reports.
2. `check_target_connection`: only when a session exists. It says whether the probe answers.
3. `list_debug_windows`: only when several VS Code windows are open. Say which window holds the target; do not select another window without the user's go-ahead.
4. `get_recent_problems`: what went wrong in this window since the last check (adapter and GDB-server errors, failed builds, notifications).

Report the answer in five short lines: session, target, windows, problems, next step. Name the next tool; do not run a tool that changes the board, the session or a file unless the user asks for it.

## When the tools are missing

No `get_session_status` in your tool list means this agent session is not connected to the CMSIS Developer Assistant. Its MCP server runs inside VS Code while a window has the extension active, and the command *CMSIS Developer Assistant: Configure Agent* in that window registers it with the agent. Most agents connect to their MCP servers only when a session starts: once VS Code serves, ask the user to start a new agent session (Kimi Code: restart `kimi`, `/reload` does not reconnect; in Kimi's VS Code extension, Developer: Reload Window once the status bar shows the CDA robot with R). A sub-agent has no tools its parent lacks, so do not hand the board to one. Meanwhile do not reach the board another way: no pyOCD or GDB in a shell.

## Where a task's procedure is

| Task | Where it comes from |
|---|---|
| A new project, a board or device, the toolchain, the environment | `knowledge_search` with the task's name in two or three words (`new project`, `board layer`), then `knowledge_get`; the `route-project` unit says the order |
| The project's files, which target, `launch.json` | `get_debug_instructions` topic `target` |
| Build, load, run or attach; a build error, a long build | topic `cmsis-action` |
| `flash`, `PROBE_BUSY`, `start_debugging` | topic `flash` |
| Breakpoints, logpoints, the breakpoint budget | topic `breakpoints` |
| Variables, registers, memory, peripherals, run control | topic `inspection` |
| A HardFault or another fault | topic `faults`: its first step is `diagnose_fault` (`get_fault_info` for the registers alone); `knowledge_search HardFault` for the live-debugging procedure (`proc-cmsis-debug-live`) |
| A hang, a breakpoint that never hits, a wrong value | topic `troubleshooting` |
| An error text from a build, csolution, packchk or svdconv | `knowledge_search` with the exact text |
| A datasheet, reference manual or register meaning | `list_target_docs`, then `search_target_docs`; never read the PDF yourself |

Agents that do not load skills get the same topics from `get_debug_instructions`.
