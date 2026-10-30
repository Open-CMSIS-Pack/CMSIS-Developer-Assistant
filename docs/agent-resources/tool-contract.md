# CMSIS Developer Assistant tool contract

The rules that keep agents on the MCP tools instead of pyOCD, GDB, cbuild or a
serial terminal in the shell, and the shell commands with the tool that
replaces each (#50). This file is the only place they are written:

- The MCP server starts its `instructions` with the rules block.
- `npm run skills:sync` copies the blocks between their markers
  into the installed `cmsis-help` skill and `debug_instructions.md`.
  The knowledge-base procedure sources carry no generated rule blocks.
  `src/test/toolContract.test.ts` fails when a copy differs.
- *Configure Agent* offers to write the rules block into the
  agents' rule files (`CLAUDE.md`, `AGENTS.md`, …), each change previewed,
  and activation brings the blocks it wrote up to date
  (`src/core/agentRules.ts`).

Edit the text between the markers here, then run that command. The rules
stay at ten lines and under 1 600 bytes: clients keep them in every turn, and
the user-level rule files carry them into every project. So the block holds
only what must survive there: the scope (the targets of the CMSIS Debugger,
not a host program or another toolchain's board) and the bans. What a tool
reply or the server instructions say at the moment it matters — the
`TARGET_RUNNING` hint, `list_debug_windows` on `NO_SESSION`, the setting that
enables a missing tool group, the control server — is not a rule.

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
