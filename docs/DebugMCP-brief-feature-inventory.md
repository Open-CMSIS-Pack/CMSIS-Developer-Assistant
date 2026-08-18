# CMSIS Developer Assistant — Feature Inventory & Agent-Usage Priority

## Product brief: Arm Keil MDK integration

The MCP debug surface selected for direct integration into the Keil MDK toolchain — what it inherits from Microsoft's DebugMCP, what the CMSIS fork adds for Cortex-M, and which tools an AI agent actually reaches for, derived from a simulated driver-bring-up debug run.

---

## A. Inherited from Microsoft DebugMCP

The upstream base is a language-agnostic bridge from an MCP client to the VS Code debug adapter (DAP). It drives a standard `launch.json` session — Python, Node, C++, etc. — with the generic debugger verbs every debug session needs. These 14 tools ship unchanged in the fork.

| Tool | Category | What it does |
|------|----------|--------------|
| `get_debug_instructions` | Guidance | Returns the debugging playbook (best practices, root-cause framework) for clients without MCP resources. |
| `start_debugging` | Session | Launch a debug session from a source file or named `launch.json` configuration. |
| `stop_debugging` | Session | Terminate the active debug session. |
| `restart_debugging` | Session | Restart the session from the beginning with the same configuration. |
| `continue_execution` | Flow | Resume until the next breakpoint or program end. |
| `step_over` | Flow | Execute the current line without descending into calls. |
| `step_into` | Flow | Descend into the call on the current line. |
| `step_out` | Flow | Run to the return of the current function. |
| `add_breakpoint` | Breakpoints | Set a breakpoint by file + line content. |
| `remove_breakpoint` | Breakpoints | Remove a single breakpoint. |
| `clear_all_breakpoints` | Breakpoints | Clear every breakpoint at once. |
| `list_breakpoints` | Breakpoints | Enumerate all set breakpoints across files. |
| `get_variables_values` | Inspect | Read local / global variables at the current stop. |
| `evaluate_expression` | Inspect | Evaluate an arbitrary expression in the live debug context. |

---

## B. Added by CMSIS Developer Assistant

Upstream has no concept of a GDB target server, hardware memory or registers, fault decoding, SVD awareness, or a wedged probe. The fork closes exactly that gap so an agent can debug real Cortex-M silicon over pyOCD / J-Link / CMSIS-DAP + `gdbtarget`. Two layers: **new tools** (22) and **always-on infrastructure** that hardens every call.

### Build · flash · attach pipeline

| Tool | Category | Why it exists for embedded |
|------|----------|----------------------------|
| `cmsis_action` | CMSIS | Drives the CMSIS-Solution panel: `build / load / erase / load_and_run / load_and_debug / attach / detach / stop_run`. Build & flash actions return a **synchronous exit-code result** (v1.2.1). The preferred entry point for embedded. |

### Hardware inspection — Cortex-M

| Tool | Category | Why it exists for embedded |
|------|----------|----------------------------|
| `read_memory` | Memory | Read a byte range from SRAM / Flash / peripherals via DAP `readMemory` with multi-strategy GDB fallback. |
| `read_core_registers` | Registers | R0–R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK — crash state & stack analysis. |
| `read_peripheral_register` | Peripheral | Named peripheral/register reads backed by SVD (Peripheral Inspector API, with a standalone SVD-parser fallback). |
| `get_fault_info` | Fault | Read & decode CFSR / HFSR / DFSR / MMFAR / BFAR / AFSR bit-by-bit for HardFault / BusFault / MemManage / UsageFault. |
| `get_device_info` | Introspect | Device, probe, processor, GDB server + port, program path, cbuild-run reference. |

### Execution control & stack

| Tool | Category | Why it exists for embedded |
|------|----------|----------------------------|
| `pause_execution` | Flow | DAP `pause` — halt a running target so inspection becomes valid. No-op if already stopped. |
| `get_call_stack` | Stack | Full stack trace with a `frameId` per frame for caller-frame inspection. |
| `get_threads` | RTOS | DAP threads — with RTOS-aware GDB servers, lists FreeRTOS / RTX / ThreadX tasks. |
| `get_frame_variables` | Inspect | Variables of a specific `frameId` without changing the editor's active frame. |

### Session health & resilience

| Tool | Category | Why it exists for embedded |
|------|----------|----------------------------|
| `get_session_status` | Health | Never-throwing 5-state classifier: `no-session / initializing / running / stopped / unresponsive`, with a next-step hint. |
| `check_target_connection` | Health | Fast, short-timeout DAP ping — is the probe / GDB server alive? |

### Serial / UART — dual backend

| Tool | Category | Why it exists for embedded |
|------|----------|----------------------------|
| `serial_open` · `close` · `read` · `write` · `status` · `clear_buffer` | Serial | OWNED backend: the server holds a `serialport` connection and buffers RX. |
| `serial_subscribe_monitor` · `unsubscribe` · `read(monitor)` · `open_monitor` | Serial | BRIDGE backend: taps the MS Serial Monitor extension so the agent reads the user's live UART session — no port fight. |
| `serial_list_ports` | Serial | Enumerate ports (friendly names via the monitor API, else `serialport`). |

### Always-on infrastructure (not called — load-bearing every step)

| Feature | Category | What it does |
|---------|----------|--------------|
| Per-call timeouts | Reliability | Every hardware tool accepts `timeoutMs` (60 s cap); handler-level deadlines guarantee a call never hangs the agent. |
| Auto-heal on motion timeout | Reliability | `continue` / `step_*` pause the target on overshoot, read PC + frame, and report where the firmware actually was. |
| Session-state tracking | Reliability | A DAP tracker records `stopped`/`continued` events, curing spurious "session not ready" errors under `gdbtarget`. |
| GDB-native breakpoint binding | Reliability | Binds via `-exec break file:line` so breakpoints actually take on `gdbtarget` sessions. |
| Per-request server + concurrency | Reliability | A fresh MCP server/transport per HTTP request — concurrent tool calls no longer trample each other. |
| Loopback-only bind + DNS-rebind guard | Security | Binds `127.0.0.1` only and rejects non-local Host/Origin — no unauthenticated flash/erase access from the network. |
| Auto-registration & dynamic discovery | Integration | Registers with Copilot (dynamic port), Cline, Cursor, Codex, Copilot CLI, Claude Code & Claude Desktop; embedded-specific agent guidance docs. |

---

## C. Agent-usage priority — simulated debug run

Priority is derived, not asserted. Below is a representative agent trace for a real bring-up bug, then the usage tiers that fall out of it. The task: **an I²C driver that won't initialize** — the sensor never answers.

### Task · fix "I²C driver not initializing"

The application calls `I2C_Init()`; the sensor stays silent. The agent must locate the fault and propose the fix on live Cortex-M hardware.

> **Root cause the run surfaces:** the peripheral clock-enable bit for I²C1 was never set in **RCC → APB1ENR**, so every access to the I²C register block bus-faults — init silently wedges. This is invisible to generic variable inspection; it lives in a **peripheral register**.

### The trace

| # | Agent reasoning | Tool(s) called | |
|---|-----------------|----------------|---|
| 1 | "What am I attached to?" — establish the target. | `get_device_info` | |
| 2 | "Get fresh firmware on the chip and attach." | `cmsis_action · load_and_debug` | |
| 3 | "Is the session actually up?" | `get_session_status` | |
| 4 | "Break at driver init and run to it." | `add_breakpoint` · `continue_execution` | |
| 5 | "Inspect the init config & handle state." | `get_variables_values` · `evaluate_expression` | |
| 6 | "Step into the HAL init to watch the setup." | `step_into` · `step_over` | |
| 7 | **"Is the I²C peripheral even clocked, enabled, and pin-muxed?"** | `read_peripheral_register · RCC.APB1ENR` · `read_peripheral_register · I2C1.CR1` | **← root cause** (the clock-enable bit reads 0) |
| 8 | **"Did touching the un-clocked block fault, and where?"** | `get_fault_info` · `read_core_registers` · `get_call_stack` | **← root cause** (BusFault PRECISERR → PC/LR + caller chain) |
| 9 | "Read a raw register the SVD didn't name; check the UART log." | `read_memory` · `serial_read` | |
| 10 | "Fix code → reflash → verify the clock bit is now set." | `cmsis_action · load_and_debug` · `read_peripheral_register · RCC` · `clear_all_breakpoints` | |

### Usage tiers that fall out of the run

Ranked by how often an agent reaches for each tool across this class of bug. Origin marked **[fork]** / **[base]**.

**Critical — the loop's spine** _(every run · often repeated)_

`cmsis_action` [fork] · `get_session_status` [fork] · `read_peripheral_register` [fork] · `add_breakpoint` [base] · `continue_execution` [base] · `get_variables_values` [base] · `evaluate_expression` [base]

> 4 of 7 are fork-added — including the two most-called tools in the run, `cmsis_action` and `read_peripheral_register`.

**High — root-cause & iterate** _(most driver bugs)_

`get_fault_info` [fork] · `read_core_registers` [fork] · `read_memory` [fork] · `get_call_stack` [fork] · `get_device_info` [fork] · `step_into` [base] · `step_over` [base] · `restart_debugging` [base] · `get_debug_instructions` [base]

> The embedded root-cause cluster (fault + core registers + raw memory) is entirely fork-added.

**Medium — situational** _(some runs)_

`serial_open` [fork] · `serial_read` [fork] · `check_target_connection` [fork] · `pause_execution` [fork] · `get_frame_variables` [fork] · `get_threads` [fork] · `step_out` [base] · `remove_breakpoint` [base] · `clear_all_breakpoints` [base] · `list_breakpoints` [base] · `stop_debugging` [base]

**Low — other workflows** _(rare for this bug class)_

`serial_write` [fork] · `serial_status` [fork] · `serial_subscribe_monitor` [fork] · `serial_unsubscribe_monitor` [fork] · `serial_open_monitor` [fork] · `serial_clear_buffer` [fork] · `serial_list_ports` [fork]

**Always-on infrastructure** _(not called · active every step)_

per-call timeouts [fork] · handler deadlines [fork] · auto-heal on timeout [fork] · session-state tracking [fork] · GDB-native breakpoints [fork] · loopback bind + DNS-rebind guard [fork]

> Invisible to the agent, but the reason the run above doesn't stall on a wedged probe or a phantom session.

---

## The takeaway

The inherited base delivers **generic step / breakpoint / variable debugging** — necessary, but not where embedded bugs are found.

For "driver not initializing" — and most bring-up bugs — the root cause lives in a **peripheral register** (clock / enable / pin-mux bit) or in **fault state**. Both are surfaced **only by the fork**. In the simulated run, the two most-used tools (`cmsis_action`, `read_peripheral_register`) and the entire root-cause cluster are fork additions.

**Integration implication:** the inherited 14 tools are table stakes; the differentiated value that justifies embedding this in Keil MDK concentrates in the 22 fork tools plus the always-on reliability layer that keeps an agent from stalling on real hardware.

---

### Notes & caveats

- The inherited-vs-fork split is derived from the actual codebase: the 36 registered tools in `src/debugMCPServer.ts`, against the upstream base commit `4422d8c` the fork is built on.
- The scenario uses an **I²C clock-enable** bug as representative. A different driver (UART, SPI, DMA setup) shifts the exact tool mix slightly, but the tier ranking holds.
- The usage tiers are a reasoned estimate from one simulated run, **not telemetry**. Real agent-call logs from a few debug sessions would turn the estimate into data.
