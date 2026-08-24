[![License Apache-2.0 OR MIT](https://img.shields.io/badge/License-Apache--2.0%20OR%20MIT-green?label=LICENSE)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/main/LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/badge)](https://securityscorecards.dev/viewer/?uri=github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant)
[![CI Build and Test](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/CMSIS-Developer-Assistant/ci.yml?logo=arm&logoColor=0091bd&label=CI%20Build%20and%20Test)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/actions/workflows/ci.yml?query=branch:main)
[![Markdown Lint](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/CMSIS-Developer-Assistant/markdown.yml?logo=arm&logoColor=0091bd&label=Markdown%20Lint)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/actions/workflows/markdown.yml?query=branch:main)
[![CodeQL Analysis](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/CMSIS-Developer-Assistant/codeql.yml?logo=arm&logoColor=0091bd&label=CodeQL%20Analysis)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/actions/workflows/codeql.yml?query=branch:main)
[![Dependency Review](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/CMSIS-Developer-Assistant/dependency-review.yml?logo=arm&logoColor=0091bd&label=Dependency%20Review)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/actions/workflows/dependency-review.yml?query=branch:main)

# CMSIS Developer Assistant

> &#8505;&#65039; **About this extension**
>
> - The CMSIS Developer Assistant originated as a fork of [DebugMCP](https://github.com/microsoft/DebugMCP) by Microsoft and is now developed independently by Arm within the [Open-CMSIS-Pack](https://www.open-cmsis-pack.org/) project.
> - Version numbers were inherited from DebugMCP and continue its 2.x line; they do not start at 1.0.
> - The extension is **experimental** and published as a pre-release. Tools, parameters, and settings may change between releases.

The Arm® CMSIS Developer Assistant extension connects AI coding agents to the debugger in Visual Studio Code. It runs a local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that exposes the debug session as tools, so that an agent can drive the [Arm CMSIS Debugger](https://marketplace.visualstudio.com/items?itemName=Arm.vscode-cmsis-debugger) against Arm Cortex®-M devices the same way a developer does: build, flash, run to a breakpoint, and look at the target.

- Starts the CMSIS Solution actions (build, load, load & debug, attach) and controls execution with breakpoints, logpoints, and stepping.
- Reads memory, core registers, and device peripheral registers (from CMSIS-SVD), decodes fault status registers, and measures cycles with the DWT counter.
- Programs Flash, resets the target, and communicates over serial (UART) ports.
- Works with GitHub Copilot, Claude Code, Claude Desktop, Cline, Cursor, Codex, Roo Code, Antigravity, and any other MCP-compatible assistant.
- Runs entirely on the local machine: the MCP server binds to `localhost` only, needs no credentials, and sends nothing to an external service.
- Also debugs applications in other languages (Python, JavaScript/TypeScript, Java, C#, C/C++, Go, Rust, PHP, Ruby) through the respective VS Code debug extensions.


For Arm Cortex-M targets, use it together with these extensions (all included in the [Arm Keil® Studio pack](https://marketplace.visualstudio.com/items?itemName=Arm.keil-studio-pack)):

- [Arm CMSIS Debugger](https://marketplace.visualstudio.com/items?itemName=Arm.vscode-cmsis-debugger) provides the `gdbtarget` debug configuration and ships pyOCD and GDB. It includes the [CDT™ GDB Debug Adapter](https://marketplace.visualstudio.com/items?itemName=eclipse-cdt.cdt-gdb-vscode), the [Peripheral Inspector](https://marketplace.visualstudio.com/items?itemName=eclipse-cdt.peripheral-inspector), and the [Serial Monitor](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-serial-monitor).
- [Arm CMSIS Solution](https://marketplace.visualstudio.com/items?itemName=Arm.cmsis-csolution) generates the `launch.json` from a _csolution project_ and provides the build, load, and debug actions that the agent drives.

## Installation

Download the `cmsis-developer-assistant-<platform>-<version>.vsix` for your host from the [GitHub releases](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/releases) and install it:

```sh
code --install-extension cmsis-developer-assistant-<platform>-<version>.vsix
```

Reload the VS Code window afterwards. To build the extension from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

### Connecting an AI agent

The extension activates on startup and serves MCP at `http://localhost:3001/mcp`. GitHub Copilot in VS Code finds the server automatically through the registered `McpServerDefinitionProvider`; nothing needs to be edited.

For other agents, the extension shows a two-step setup on first activation: step 1 writes the server into the configuration of every agent you select, step 2 lets you choose the [agent skills](#agent-skills) to install. The setup can be opened again at any time with the command **CMSIS Developer Assistant: Configure Agents and Skills** from the [command palette](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette). For manual registration, see [Manual agent registration](#manual-agent-registration).

If an agent has the server registered but none of the CMSIS AI Skills has been selected, the extension offers to install them — at most once a month, with **Select Skills**, **Later** and **Don't ask again** — until a skill from the pack is added (setting `cmsis-developer-assistant.aiSkills.promptOnDetect`).

> &#128204; **TIP**
>
> Enable auto-approval for the CMSIS Developer Assistant tools in your AI assistant. A debug session is a long series of small tool calls, and confirming each one interrupts the workflow.

## Getting Started

1. Open a _csolution project_ in VS Code. The Arm CMSIS Solution extension generates a `.vscode/launch.json` with a CMSIS Debugger configuration (for example `CMSIS Debugger: pyOCD` or `CMSIS Debugger: J-LINK`).
2. Make sure your AI assistant lists the CMSIS Developer Assistant as an MCP server.
3. Ask the agent to debug, for example: _"Load and debug the application, then stop at `main`."_ The agent calls `cmsis_action` with `load_and_debug`, which builds if required, programs the device, and attaches the debugger in one step.
4. Continue in natural language: _"Why do we end up in the HardFault handler?"_, _"Show the GPIOA registers"_, _"Read 64 bytes at the stack pointer"_. The agent uses the inspection tools described below and reports what it found.

The extension also installs two agent skills into your personal skills directories: `cmsis-debug-live`, which teaches the agent a systematic workflow for firmware debugging on hardware, from target-state checks to HardFault root-cause analysis, and `cmsis-help`, which answers "what can I ask the CMSIS Developer Assistant for?" — the slash commands, VS Code commands, tools and settings. Agents that support the [agent skills](https://agentskills.io/) format pick them up automatically. More skills are available on request — see [Agent skills](#agent-skills).

> &#128221; **Note:**
>
> `cmsis_action` is the preferred way to start a Cortex-M debug session. The generic `start_debugging` tool launches a named `launch.json` configuration without the Flash download step and is meant for other languages.

## Agent Tools

Every tool that touches the hardware accepts an optional `timeoutMs` parameter (capped at 60 s by the server) and always returns within that deadline, even if the probe stalls.

### CMSIS Solution actions

| Tool | Description |
|------|-------------|
| `cmsis_action` | Runs the action buttons of the CMSIS Solution view: `build`, `load`, `erase`, `load_and_run`, `load_and_debug`, `attach`, `detach`, `stop_run`. `load_and_debug` builds (if needed), programs the device, and attaches the debugger in one step. |

### Run control

| Tool | Description |
|------|-------------|
| `start_debugging` | Starts a debug session from a named `launch.json` configuration, or from a source file for languages with auto-generated configurations. Refuses if a session is already active. |
| `stop_debugging`, `restart_debugging` | Stops the current session, or restarts it and waits until it is ready again. |
| `pause_execution` | Halts a running target without ending the session. |
| `continue_execution`, `step_over`, `step_into`, `step_out` | Resume or step. If the target does not stop within the deadline, the tool pauses it and reports where the firmware actually was. |
| `wait_for_stop` | Blocks until the target stops next (breakpoint, fault, step, pause) and returns the stop reason, or a structured timeout. Replaces blind waiting after a `continue_execution`. |
| `reset` | Resets the target inside the live session (breakpoints survive) and verifies that the program counter is at the reset vector afterwards. Selects the method (`auto`, `system`, `core`, `hardware`) and reports honestly when the target did not reset. |

### Breakpoints

| Tool | Description |
|------|-------------|
| `add_breakpoint` | Sets a breakpoint at a source line, optionally with a condition. The condition is evaluated by GDB on the target, so the core only halts when it holds. |
| `add_logpoint` | Prints a message and resumes instead of halting (GDB `dprintf`). Expressions are interpolated with `{expr}`; `{expr:%s}` overrides the format. |
| `remove_breakpoint`, `clear_all_breakpoints`, `list_breakpoints` | Breakpoint management. |

### Inspection

| Tool | Description |
|------|-------------|
| `list_variable_names` | Names and types of the variables in scope, without reading their values. |
| `get_variables_values` | Values of local, global, or all variables of the active frame, or of up to 50 named variables. |
| `evaluate_expression` | Evaluates an expression in the current frame. |
| `get_call_stack`, `get_threads` | Full call stack with frame IDs, and the thread list. With RTOS-aware GDB servers (pyOCD `--rtos`, J-Link plugin) the threads are the FreeRTOS, RTX, or ThreadX tasks. |
| `get_frame_variables` | Variables of an explicit frame without changing the active editor frame. |

### Cortex-M

| Tool | Description |
|------|-------------|
| `read_memory` | Reads a range of bytes (up to 4096) from the target as hex, ASCII, or both. |
| `read_core_registers` | Reads R0–R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, and PRIMASK. |
| `read_peripheral_register` | Reads and decodes a peripheral register, or all registers of a peripheral, using the CMSIS-SVD description of the device (via the Peripheral Inspector or a built-in SVD parser). |
| `get_fault_info` | Reads CFSR, HFSR, DFSR, MMFAR, BFAR, and AFSR and decodes them bit by bit for HardFault analysis. |
| `diagnose_fault` | One-call fault triage: decoded fault registers, the stacked exception frame (faulting PC and its caller), the top frames, the faulting address resolved against the SVD, and up to three ranked hypotheses each with the next tool call. |
| `lookup_peripheral` | Answers from the SVD without touching the target, with or without a session: the peripheral list, a peripheral's register map, or which peripheral and register sit at an address (resolve a BFAR). |
| `lookup_register` | Describes one register from the SVD: address, access, reset value, bit fields with enumerated values — which bit is the clock enable, before reading anything. |
| `read_cycle_counter` | Reads the DWT cycle counter for cycle-accurate timing between two stops. Enables the counter on first use and reports cores without one. |
| `flash` | Programs the Flash with `pyocd load --cbuild-run` outside a debug session and returns bytes programmed or the structured pyOCD error. |
| `get_device_info` | Returns device, probe, processor, GDB server, ports, and the `*.cbuild-run.yml` of the session. |

### Serial ports

| Tool | Description |
|------|-------------|
| `serial_list_ports` | Lists the serial ports (via the Serial Monitor extension, falling back to the bundled `serialport` package). |
| `serial_open`, `serial_close`, `serial_write`, `serial_read`, `serial_status`, `serial_clear_buffer` | Owns a serial connection from the MCP server. Use these when no Serial Monitor session holds the same port. |
| `serial_open_monitor` | Opens the Serial Monitor panel for the user. |
| `serial_subscribe_monitor`, `serial_unsubscribe_monitor` | Reads data through an open Serial Monitor session once the Serial Monitor extension exposes a data event in its API (see [Known Limitations](#known-limitations-and-workarounds)). |

### Session health

| Tool | Description |
|------|-------------|
| `get_session_status` | Classifies the session as `no-session`, `initializing`, `running`, `stopped`, or `unresponsive`, with a hint for each state. Never throws. |
| `check_target_connection` | Low-cost liveness check of the debug adapter and probe. |
| `get_debug_instructions` | Returns the debugging guide for agents that cannot read MCP resources (such as GitHub Copilot): a short overview with the topic list by default, or one section with `topic` (`session`, `build`, `breakpoints`, `inspection`, `faults`, `troubleshooting`). |
| `list_debug_windows`, `select_debug_window` | Shows the VS Code windows the server can reach and pins one for this session. Relevant when more than one window is open. |

### MCP resources

- `cmsis-developer-assistant://docs/debug_instructions` — general debugging workflow guide.
- `cmsis-developer-assistant://docs/cmsis-embedded-guide` — Cortex-M debugging knowledge: fault decode recipes, memory map, key system registers, RTOS tips.
- `cmsis-developer-assistant://docs/troubleshooting/embedded` — embedded-specific troubleshooting.
- `cmsis-developer-assistant://docs/troubleshooting/<language>` — troubleshooting for other languages (`python`, `java`, `csharp`, …).

### Behavior the agent can rely on

- **No tool call hangs.** Every hardware-touching tool returns within 60 s at most; every request to the debug adapter has its own timeout and fails with a `HardwareTimeoutError` instead of blocking.
- **Inspection tools report the real state.** If the target is running, the call returns an error that names the recovery tool (`pause_execution`, `add_breakpoint`, `continue_execution`) instead of a misleading "no debug session".
- **Motion tools explain overshoots.** When `continue_execution` or a step does not stop in time, the tool pauses the target and reports the program counter and active frame.
- **`reset` never claims a reset that did not happen.** The program counter is checked against the reset vector; an unverified reset is reported as such, together with the replies of the debug adapter.
- **Calls never run against the wrong board.** With two windows debugging at once, routing fails with the list of candidates instead of guessing, because memory read from the wrong target looks exactly like a firmware bug.
- **Credential-shaped values are withheld** from variable reads and `evaluate_expression` (configurable). Numeric scalars and raw target reads (memory, core and peripheral registers, GDB commands) are never withheld, so the firmware state stays readable.

## Agent Skills

Skills are `SKILL.md` workflows in the [Agent Skills](https://agentskills.io/) format that an agent loads on demand. The extension ships a catalog of them and copies the ones you select into the directories your agents read:

| Directory | Read by |
|-----------|---------|
| `~/.agents/skills/` | GitHub Copilot CLI, Codex, Cursor, Gemini CLI, VS Code Copilot Chat (the cross-agent location) |
| `~/.claude/skills/` | Claude Code (only when a `~/.claude` directory exists; `CLAUDE_CONFIG_DIR` is honoured) |
| `$COPILOT_HOME/skills/` | GitHub Copilot CLI, only when `COPILOT_HOME` is set (it then ignores `~/.agents/skills`) |

The catalog contains:

- **`cmsis-debug-live`** (always installed) — the live Cortex-M debugging workflow for the tools of this extension.
- **`cmsis-help`** (always installed) — the list of CMSIS slash commands, the member skills behind each, the VS Code commands, the MCP tool groups and the settings; generated from the catalog and `package.json` so it cannot go stale. Ask the agent `/cmsis-help`.
- **The [Open-CMSIS-Pack/cmsis-skills](https://github.com/Open-CMSIS-Pack/cmsis-skills) skills**, vendored at a pinned commit (`skills/cmsis-skills.lock.json`): project setup (`add-cmsis-target`, `identify-cmsis-board-support`, `start-zephyr-project`, …), device debug and trace knowledge (`debug-access-knowledge`, `debug-knowledge`, `trace-knowledge`, …), and CMSIS-Pack debug authoring (`generate-debug-sequences`, `generate-trace-sequences`, `manage-pdsc-debugvars`, …).
- **One entry point per category** — `cmsis-project`, `cmsis-bring-up`, `cmsis-pack`. Selecting an entry point gives the agent a single slash command for the whole category: the member skills are installed with `user-invocable: false`, so agents that honour that flag (Claude Code, VS Code, Copilot CLI) keep them out of the `/` menu while the model can still invoke them by description. Selecting an individual skill makes it visible; skills it depends on (the `$name` references in its text) are installed hidden.

The cmsis-skills skills and their entry points form the **AI Skills Pack**. Choose from it with **CMSIS Developer Assistant: Select Agent Skills** (also step 2 of **Configure Agents and Skills**) or edit the `cmsis-developer-assistant.installedSkills` setting; the extension's own `cmsis-debug-live` and `cmsis-help` are always installed and are not part of the selection. The selection is applied on every activation and whenever the setting changes, including through Settings Sync. Every directory the extension writes carries a `.cmsis-developer-assistant.json` marker; deselected skills with that marker are removed, and a skill you installed yourself is never overwritten or removed, even if it shares a name.

Turning `cmsis-developer-assistant.aiSkills.enabled` off switches the pack off: the pack skills this extension installed are removed (marker-guarded, your own skills are untouched), the skills step of the setup and the install prompt are skipped, and the two bundled skills stay. Your selection is kept, so turning it back on restores exactly what you had.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `cmsis-developer-assistant.installedSkills` | `[]` | The AI Skills Pack skills (entry points or individual skills) to install into your personal skills directories; `cmsis-debug-live` and `cmsis-help` are always installed. See [Agent Skills](#agent-skills). |
| `cmsis-developer-assistant.aiSkills.enabled` | `true` | Enable the AI Skills Pack for selected agents. Off: pack skills this extension installed are removed, the skills setup step and the install prompt are skipped, the selection is kept. |
| `cmsis-developer-assistant.aiSkills.promptOnDetect` | `true` | Prompt to install the CMSIS AI Skills for selected agents — monthly, until a pack skill is added. |
| `cmsis-developer-assistant.serverPort` | `3001` | Port of the MCP server. One window binds it and routes to the others. Changing the port requires a window reload; the extension offers to reload. |
| `cmsis-developer-assistant.timeoutInSeconds` | `180` | Timeout for debugging operations such as starting a session. |
| `cmsis-developer-assistant.dapRequestTimeoutMs` | `10000` | Per-request timeout for traffic to the debug adapter and probe. Increase for slow targets or large memory reads. |
| `cmsis-developer-assistant.memoryReadTimeoutMs` | `30000` | Overall timeout for a single `read_memory` or `read_core_registers` call. |
| `cmsis-developer-assistant.redactSecrets` | `true` | Withholds variable and expression values that look like credentials. |
| `cmsis-developer-assistant.serial.enabled` | `true` | Offer the `serial_*` tools to agents. Off drops the ten serial tools from the tool list every agent turn carries; needs a window reload. |
| `cmsis-developer-assistant.telemetry.jsonlPath` | `""` | Append one JSON line per MCP tool call — name, bytes in/out, duration, outcome; never arguments or results — to this file for offline analysis. Off when empty; `get_session_status` and the `cmsis-developer-assistant://stats` resource always show the in-memory statistics. |

### Networking and multiple windows

The MCP server binds to **`127.0.0.1` only** and rejects requests whose `Host` or `Origin` is not a loopback address. It has no authentication and can program, erase, and read the attached hardware, so it must never be exposed to a network. VS Code Remote SSH, WSL, and Codespaces forward `localhost`, so these setups work unchanged.

Several VS Code windows are supported. One window binds `serverPort` and becomes the _router_; every other window runs a token-protected loopback control server and publishes itself to a shared registry. The router forwards each tool call to the window that owns the target, so agents that read a single global configuration (Claude Code, Codex, Copilot CLI) reach every window through one URL. When the router window closes, another window takes over within about ten seconds.

The target window is selected from a file path when the tool has one (`add_breakpoint`, `start_debugging`); otherwise the window with the active debug session is used. When two windows are debugging at the same time, the call fails and names both windows. Use `list_debug_windows` and `select_debug_window` to pin one.

### Manual agent registration

The popup described in [Connecting an AI agent](#connecting-an-ai-agent) writes these entries for you. If you prefer to do it by hand, the server is reachable at `http://localhost:3001/mcp` (replace the port if you changed `serverPort`).

**GitHub Copilot** (`settings.json`):

```json
{
  "mcp": {
    "servers": {
      "cmsis-developer-assistant": {
        "type": "http",
        "url": "http://localhost:3001/mcp"
      }
    }
  }
}
```

**Cline, Cursor, Roo Code** (MCP settings):

```json
{
  "mcpServers": {
    "cmsis-developer-assistant": {
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

**Claude Code** (terminal):

```sh
claude mcp add --transport http --scope user cmsis-developer-assistant http://localhost:3001/mcp
```

**Claude Desktop** only supports stdio servers, so it gets an `mcp-remote` bridge (requires Node.js with `npx` on the `PATH`) in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cmsis-developer-assistant": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3001/mcp"]
    }
  }
}
```

## Other Languages

Besides Cortex-M targets, the extension starts and controls debug sessions for other languages through their VS Code debug extensions. Without a `launch.json`, a default configuration is synthesized from the file extension.

| Language | Extension |
|----------|-----------|
| Python | [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) |
| JavaScript/TypeScript | Built-in / [JavaScript Debugger](https://marketplace.visualstudio.com/items?itemName=ms-vscode.js-debug) |
| Java | [Extension Pack for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-pack) |
| C/C++ | [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) |
| C#/.NET | [C#](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) |
| Go | [Go](https://marketplace.visualstudio.com/items?itemName=golang.Go) |
| Rust | [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) |
| PHP | [PHP Debug](https://marketplace.visualstudio.com/items?itemName=xdebug.php-debug) |
| Ruby | [Ruby](https://marketplace.visualstudio.com/items?itemName=rebornix.ruby) |

## How It Works

![Architecture of the CMSIS Developer Assistant](assets/architecture.png)

The diagram source is [assets/architecture.mmd](assets/architecture.mmd) (Mermaid). The extension speaks to the debugger through the VS Code debug API and the Debug Adapter Protocol (DAP). It adds nothing on the target side: pyOCD or the J-Link GDB server, GDB, and the debug adapter are the same components that the Arm CMSIS Debugger uses interactively. A named `launch.json` configuration is passed to `vscode.debug.startDebugging()` unchanged, so whatever the CMSIS Solution extension generates is what the agent launches.

## Known Limitations and Workarounds

### The AI assistant does not see the tools

**Possible reasons**: The extension is not registered with the assistant, or the assistant has not been restarted since registration.

**Solution**: Run **CMSIS Developer Assistant: Configure Agents and Skills** and select the assistant, or register it by hand as described in [Manual agent registration](#manual-agent-registration). Then reload the assistant.

### Port 3001 is already in use

If the port is held by **another VS Code window** with this extension, nothing is wrong: that window is the router and serves all windows, and the extension log says `this window is a worker`.

If the port is held by an unrelated process, set `cmsis-developer-assistant.serverPort` to a free port in the **User** settings (so that all windows agree), reload, and update the MCP configuration of your assistant to match. Windows configured with different ports cannot see each other.

### Two windows are debugging at the same time

Tools without a file path (`read_memory`, `cmsis_action`, `flash`, `reset`, the serial tools) cannot tell which window is meant and return an error naming both. Ask the agent to call `select_debug_window`, or close the other debug session.

### A `gdbtarget` session fails to launch

**Possible reasons**: The named configuration does not exist in `.vscode/launch.json`, the Arm CMSIS Debugger extension is missing, the `program` file (`.axf`/`.elf`) has not been built, or the GDB server (pyOCD or J-Link) is not available.

**Solution**: Start the session once from the CMSIS Solution view by hand. The agent launches exactly the same configuration, so whatever fails interactively fails for the agent too. The error returned by `cmsis_action` and `start_debugging` includes the recent output of the debug adapter.

### Serial Monitor data is not readable through the bridge

The Serial Monitor extension API (v0.1.7) only exposes port enumeration. `serial_subscribe_monitor` therefore reports that no data event is available. Use `serial_open` and `serial_read` instead, which own the port from the MCP server, or read the output in the Serial Monitor panel.

### Claude Desktop cannot connect

Claude Desktop only supports stdio MCP servers and is connected through `mcp-remote`, which needs Node.js with `npx` on the `PATH` of the Claude Desktop process. Install Node.js and restart Claude Desktop.

## Requirements

- **Visual Studio Code** 1.109.0 or newer.
- **Arm CMSIS Debugger** extension for Cortex-M targets, together with a debug probe supported by pyOCD (CMSIS-DAP, ST-Link) or a SEGGER® J-LINK® with the J-Link software installed. The **Arm CMSIS Solution** extension generates the debug configuration.
- **An MCP-compatible AI assistant**, for example GitHub Copilot, Claude Code, Claude Desktop, Cline, Cursor, or Codex.
- **pyOCD on the `PATH`** only for the `flash` tool; `cmsis_action load` programs the device through the CMSIS Solution extension instead.
- **Node.js** with `npx` only for Claude Desktop (stdio bridge).

## Related projects

- The [Open-CMSIS-Pack](https://www.open-cmsis-pack.org/) project includes the CMSIS Developer Assistant and the [Arm CMSIS Debugger](https://github.com/Open-CMSIS-Pack/vscode-cmsis-debugger).
- [DebugMCP](https://github.com/microsoft/DebugMCP), the Microsoft project this extension originated from.
- The [Model Context Protocol](https://modelcontextprotocol.io/), the open standard that connects AI agents to tools.
- [pyOCD](https://pyocd.io/), a Python based tool and API for debugging, programming, and exploring Arm Cortex microcontrollers.
- [GDB](https://www.sourceware.org/gdb/), the debugger of the GNU Project.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test, and submit changes, and [CHANGELOG.md](CHANGELOG.md) for the release history.

## Security

See [SECURITY.md](SECURITY.md) for reporting guidance. Do not report security vulnerabilities through public GitHub issues.

## License

Dual-licensed under either of **Apache License, Version 2.0** ([LICENSE](LICENSE)) or the **MIT License** ([LICENSE-MIT](LICENSE-MIT)). See [NOTICE](NOTICE) for provenance and attribution.

Based on **DebugMCP**, originally created by **Oz Zafar**, **Ori Bar-Ilan** and **Karin Brisker** (Microsoft), used under the MIT License. CMSIS/Cortex-M embedded extensions maintained by Arm.

## Trademarks

- Arm, Cortex, and Keil are registered trademarks of Arm Limited (or its subsidiaries or affiliates) in the US and/or elsewhere.
- Windows, Visual Studio Code, VS Code, GitHub Copilot, and the Visual Studio Code icon are trademarks of Microsoft Corporation.
- Mac and macOS are trademarks of Apple Inc., registered in the U.S. and other countries and regions.
- Eclipse, CDT, and CDT.cloud are trademarks of Eclipse Foundation, Inc.
- SEGGER and J-LINK are registered trademarks of SEGGER Microcontroller GmbH.
- Node.js is a registered trademark of the OpenJS Foundation.
- GDB and GCC are part of the GNU Project and are maintained by the Free Software Foundation.
