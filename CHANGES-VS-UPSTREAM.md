# CMSIS-DebugMCP — Changes vs. Upstream

This fork of [microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) adapts the MCP debugger server for **Arm Cortex-M targets driven through the CMSIS Debugger VS Code extension**. Upstream DebugMCP is language-agnostic; it assumes a `vscode.debug.startDebugging(...)` call against a standard `launch.json` of type `python`, `node`, `cppdbg`, etc. It has no concept of a GDB target server, no memory or register reads, no fault decoding, no SVD awareness, no per-call timeouts, and no resilience to a wedged probe. Everything in this document exists because that is the gap to close before an AI agent can debug real embedded hardware (pyOCD / J-Link / CMSIS-DAP + `gdbtarget`).

Upstream baseline: forked at [`4422d8c`](https://github.com/microsoft/DebugMCP/commit/4422d8c) (2026-03-14), last synced against [`4051049`](https://github.com/microsoft/DebugMCP/commit/4051049) (upstream v2.3.0, 2026-08-05) in fork v2.0.0. See [§9](#9-upstream-work-deliberately-not-taken) for what was deliberately left behind.

Current fork release: **v2.0.3** (2026-08-10) — see [CHANGELOG.md](CHANGELOG.md) for the per-version detail.

---

## 1. Why the changes are needed

| Upstream assumption | Reality for CMSIS / Cortex-M debugging | What the fork does |
|---|---|---|
| Debug session is started from a source file path (`fileFullPath`) | CMSIS Solution generates `launch.json` entries of `type: "gdbtarget"` that reference a `.cmsis/*.cbuild-run.yml` and a compiled `.elf` — the debugger is driven by a named configuration | `start_debugging` accepts `configurationName` and routes it straight to `vscode.debug.startDebugging(workspaceFolder, name)`; `fileFullPath` becomes optional |
| Debug-tab pipeline is the only way to start a session | The CMSIS Solution panel's **Debug** button orchestrates **build → flash → attach**; the standard debug tab skips the flash step and is the wrong tool for embedded | New `cmsis_action` tool wraps the panel buttons (`build` / `load` / `erase` / `load_and_run` / `load_and_debug` / `attach` / `detach` / `stop_run`). `start_debugging` is demoted to non-CMSIS use |
| No memory inspection | First question for any Cortex-M bug: "what's actually at `0x2000_0000`?" | New `read_memory` tool (DAP `readMemory` request with multi-strategy GDB fallback) |
| No core register inspection | R0–R15 / xPSR / MSP / PSP / CONTROL / FAULTMASK / BASEPRI / PRIMASK are mandatory for crash analysis, stack walking, and processor-mode reasoning | New `read_core_registers` tool (parallel evaluates with overall + per-request deadlines) |
| No peripheral awareness | Embedded bugs are frequently peripheral-config bugs; the value of `GPIOA->ODR` or `RCC->CR` is load-bearing | New `read_peripheral_register` tool backed by SVD — primary path is the **Peripheral Inspector** extension API, with a standalone SVD parser fallback |
| No fault-state decoder | A HardFault tells you nothing without CFSR/HFSR/DFSR/MMFAR/BFAR decode | New `get_fault_info` tool that reads the SCS registers and decodes bit-by-bit (STKOF, UNALIGNED, PRECISERR, IACCVIOL, …) |
| No probe / target introspection | Agents need to know which device, which probe, which GDB server before they can reason about anything | New `get_device_info` tool summarizing session type, program, GDB path, GDB server, port, CMSIS config |
| No way to inspect a *running* target | Embedded firmware often sits in main loops; the agent needs to halt mid-flight to ask "where are we right now?" | New `pause_execution` tool (DAP `pause`), state-aware (no-op when already stopped) |
| Stack trace only exposes the active frame | Cortex-M crash analysis means walking up to the caller(s), not just the top frame | New `get_call_stack` (full frames with `frameId`), `get_threads` (RTOS tasks via DAP threads with pyOCD/J-Link plugins), `get_frame_variables` (inspect any frame by id without changing the active editor frame) |
| Stepping via `workbench.action.debug.stepOver` UI commands | Flaky under `gdbtarget` — races with DAP state, and does not give a threadId back | `DebuggingExecutor` prefers DAP `next` / `stepIn` / `stepOut` custom requests with the active threadId; falls back to the UI command only on non-timeout failure |
| `vscode.debug.activeStackItem` is the only source of truth for "is the target stopped?" | `activeStackItem` is `undefined` while the CPU is running and during the brief race window right after a stop event, leading to spurious "session is not ready" errors | Global `DebugAdapterTrackerFactory` records DAP `stopped` / `continued` events per session; `isSessionStopped(session)` consults this tracker |
| Single classification of "session ready" or not | Agent needs to distinguish: no session vs. initializing vs. running (DAP reads will be rejected) vs. stopped (full inspection ok) vs. unresponsive (probe wedged) | New `get_session_status` tool — never-failing 5-state classifier with a hint per state. Drives state-aware errors in every inspection tool |
| DAP requests have no timeout — a wedged probe hangs the MCP call indefinitely | Embedded probes routinely stall on bad connections or reset glitches | `customRequestWithTimeout` wraps every DAP request. `HardwareTimeoutError` with actionable message. `check_target_connection` for a fast liveness probe |
| No per-call deadline; the agent can't tell the server "give up sooner" | Agents have runtime estimates and want to bound their waits | Every hardware-touching tool accepts `timeoutMs` (server-capped to 60 s). Handler-level `withHandlerTimeout` race ensures the tool always returns within the cap, even if the DAP layer hangs |
| Continue / step return silently after their internal wait, even when the target never reached a breakpoint | "Did the target stop? where is it now?" is the agent's next question | Auto-heal on motion timeout: `continue_execution` / `step_*` pause the running target on overshoot, read the PC + active frame, append a 🩹 Recovery section to the response |
| Shared `McpServer` instance is closed and re-connected on every HTTP request | Two concurrent tool calls trample each other's transport — request A's response goes to nowhere when request B's `close()` strips its transport | Per-request `McpServer` + `StreamableHTTPServerTransport` pair, matching the official MCP stateless example. Eliminates the `get_threads`-after-three-calls hang |
| No serial monitor integration | Embedded firmware prints to UART; agents need to capture that | Dual serial backend: **OWNED** port via `serialport` (`serial_open`/`read`/`write`/`close`) for headless use, **BRIDGE** that runtime-probes the MS Serial Monitor extension's exports for any of `onDidReceiveData`/`onDataReceived`/etc. and auto-lights-up when MS ships a data event |
| Embedded-specific guidance absent from agent docs | AI agents pick up bad habits (e.g. `info registers` passed to an expression evaluator, setting more breakpoints than the FPB has comparators, not reading `cbuild-run.yml` before debug) | Agent guide `debug_instructions.md` rewritten: PHASE 0 (target awareness from `cbuild-idx.yml`/`cbuild.yml`/`cbuild-run.yml`/`launch.json`), PHASE 1 (5-state session-status decision table), Cortex-M FPB limit documented. Plus `cmsis-debugmcp://docs/cmsis-embedded-guide` and `cmsis-debugmcp://docs/troubleshooting/embedded` resources |
| GitHub Copilot needs a static `mcp.json` entry | Startup race + port collision when multiple VS Code windows fight for port 3001 | Extension registers a `vscode.lm.registerMcpServerDefinitionProvider` at activation — Copilot picks up the *current* server URL dynamically, including OS-assigned fallback ports |
| Publisher / identifiers tied to the Microsoft / upstream author | Private distribution without collision | Full rename: extension id, config section, command namespace, output channel, MCP server name, resource URIs |

---

## 2. File-by-file change list

All paths are relative to the extension root (`DebugMCP/`).

### New files (features that did not exist upstream)

| File | Purpose |
| -- | --- |
| [`src/core/faultDecoder.ts`](src/core/faultDecoder.ts) | Cortex-M fault register decoder. CFSR/HFSR/DFSR/MMFAR/BFAR/AFSR → human-readable analysis. Exports `FAULT_REGISTER_ADDRESSES` (SCS memory-mapped addresses at `0xE000ED28` …). |
| [`src/core/peripheralReader.ts`](src/core/peripheralReader.ts) | Peripheral register reader. Strategy 1: call the Peripheral Inspector extension's public API (`eclipse-cdt.peripheral-inspector`). Strategy 2: locate the SVD referenced by the active CMSIS `cbuild-run.yml`, parse it, and read via DAP `readMemory` / GDB `evaluate`. Per-call timeout via `withTimeout`. |
| [`src/core/svdParser.ts`](src/core/svdParser.ts) | Minimal SVD XML parser. Resolves `derivedFrom`, computes field ranges, exposes `listPeripheralNames()` / `findPeripheral()` / `findRegister()` / `decodeFields()`. |
| [`src/core/serialController.ts`](src/core/serialController.ts) | OWNED serial backend. `SerialPort` (from the `serialport` package) wrapped in a singleton with a 1 MB RX ring. Powers `serial_open` / `serial_close` / `serial_read` / `serial_write` / `serial_list_ports`. |
| [`src/core/serialMonitorBridge.ts`](src/core/serialMonitorBridge.ts) | MS Serial Monitor BRIDGE. Probes `vscode.extensions.getExtension('ms-vscode.vscode-serial-monitor').exports` for any of `onDidReceiveData` / `onDataReceived` / `onData` / `onSerialData` / `onDidReadData` / `subscribeData`. Today the public API (v0.1.7) only exposes port enumeration; bridge falls back with a clear "data event not available" message and **auto-lights-up** when MS ships a data event. |
| [`src/core/resetAssist.ts`](src/core/resetAssist.ts) | Pure reset-command mapping: pyOCD OpenOCD-style vs J-Link numeric `monitor reset` dialects, server-kind detection, unsupported-reply classification. No vscode imports — unit-testable. |
| [`src/core/dwt.ts`](src/core/dwt.ts) | DWT register map (DEMCR/DWT_CTRL/DWT_CYCCNT + TRCENA/CYCCNTENA/NOCYCCNT bits) for `read_cycle_counter`. |
| [`src/core/flashController.ts`](src/core/flashController.ts) | `pyocd load --cbuild-run` process control + output parsing (bytes programmed, rate, error lines, tail). Node builtins only — testable outside the extension host. |
| [`src/serialHandler.ts`](src/serialHandler.ts) | Routes the `serial_*` MCP tools to either the OWNED controller or the BRIDGE depending on `from` argument. |
| [`src/utils/sessionStateTracker.ts`](src/utils/sessionStateTracker.ts) | `DebugAdapterTrackerFactory` that records DAP `stopped` / `continued` events per session, exposed via `isSessionStopped(session)` and `getStoppedReason(session)`. The authoritative "is the target paused?" signal. Also: `waitForStopEvent(session, timeoutMs)` (awaitable stop events with reason + threadId) and a bounded per-session ring of recent adapter traffic (`getRecentDiagnostics()`) for launch-failure reporting. |
| [`src/utils/timeout.ts`](src/utils/timeout.ts) | `withTimeout(operation, timeoutMs, task)` + `customRequestWithTimeout(session, command, args, timeoutMs)`. `HardwareTimeoutError` class with actionable message. |
| [`docs/agent-resources/cmsis-embedded-guide.md`](docs/agent-resources/cmsis-embedded-guide.md) | Agent-facing guide on Cortex-M fault-decode recipes, SCS memory map, common register layouts, RTOS tips. Exposed as MCP resource `cmsis-debugmcp://docs/cmsis-embedded-guide`. |
| [`docs/agent-resources/troubleshooting/embedded.md`](docs/agent-resources/troubleshooting/embedded.md) | Embedded troubleshooting checklist (probe not detected, target not halted, SVD missing, wrong core selected on multi-core parts). Exposed as MCP resource. |
| [`test/realboard/run.ts`](test/realboard/run.ts) | Real-board end-to-end test driver. Connects to the running MCP server (Streamable HTTP), exercises every tool, enforces `estimatedMs` pre-flight + 60 s hard cap, pauses and runs a diagnostic sweep on every overshoot. Reports PASS/FAIL/SKIP with per-call duration. |
| [`test/realboard/README.md`](test/realboard/README.md) | How to run the real-board driver, config field reference, exit codes. |
| [`test/realboard/realboard.config.example.json`](test/realboard/realboard.config.example.json) | Sample config (endpoint, configurationName, breakpoint, memory/peripheral/evaluate probes, serial). |

### Heavily modified files

| File | What changed |
| ---- | ------------ |
| [`src/debugMCPServer.ts`](src/debugMCPServer.ts) | Registers **all** new tools (`cmsis_action`, `pause_execution`, `get_call_stack`, `get_threads`, `get_frame_variables`, `serial_*`, `get_session_status`, `check_target_connection` + the original 5 embedded tools). Per-request `McpServer` + transport pair (was: shared instance with `close`/`reconnect` race). `setupTools(mcpServer)` and `setupResources(mcpServer)` take the per-request server as a parameter. `serialController.close()` + `serialMonitorBridge.unsubscribe()` on shutdown. |
| [`src/debuggingHandler.ts`](src/debuggingHandler.ts) | Handlers for every new tool. `ensureStoppedSession(operation)` gates all inspection tools and surfaces state-aware errors. `handleStartDebugging` and `handleCmsisCommand` pre-check for an active session and refuse duplicates. `withHandlerTimeout` wraps every hardware-touching handler so it returns within the requested cap. `attemptRecoveryAfterTimeout` powers the 🩹 auto-heal on motion timeout. |
| [`src/debuggingExecutor.ts`](src/debuggingExecutor.ts) | `startDebuggingByName()` for `gdbtarget`. New DAP-backed methods: `pause`, `getThreads`, `getCallStack`, `getVariablesForFrame`, `waitForStop`, `writeMemoryWord` (DAP `writeMemory` + read-back verify), `resetTarget` (monitor-command reset with PC-vs-reset-vector verification), `readCycleCounter`, plus the original `readMemory` / `readCoreRegisters` / `readPeripheralRegister` / `getFaultInfo` / `getDeviceInfo`. Per-method `timeoutMs` parameter capped to 60 s. Stepping via DAP `next` / `stepIn` / `stepOut` with UI fallback. `getSessionStatus()` 5-state classifier. `checkTargetConnection()` for the lightweight liveness probe. |
| [`src/debugState.ts`](src/debugState.ts) | `StackFrame.frameId` added so `get_call_stack` can pass `frameId` back to `get_frame_variables`. |
| [`src/extension.ts`](src/extension.ts) | Registers the `sessionStateTracker`. Calls `vscode.lm.registerMcpServerDefinitionProvider` for Copilot dynamic discovery. Renamed config section `debugmcp` → `cmsis-debugmcp`. New config keys `dapRequestTimeoutMs` and `memoryReadTimeoutMs`. Default timeout changed 180 → 60 s. Clears the parsed-SVD cache on debug-session termination. |
| [`src/utils/agentConfigurationManager.ts`](src/utils/agentConfigurationManager.ts) | Dropped the static Copilot `mcp.json` write (superseded by `McpServerDefinitionProvider`). `updatePort()` so the actual OS-assigned port is reflected in Cline/Cursor configs. |
| [`docs/agent-resources/debug_instructions.md`](docs/agent-resources/debug_instructions.md) | PHASE 0 (target awareness from CMSIS YAMLs + launch.json), PHASE 1 (5-state session-status gate decision table), Cortex-M hardware breakpoint limit guidance. CMSIS-first workflow steers agents to `cmsis_action load_and_debug` over `start_debugging`. |
| [`package.json`](package.json) | `name`, `displayName`, `publisher`, `author`, `homepage`, `bugs`, `repository`, command ids, config section. Added `serialport` dependency. Keywords added: `embedded`, `cortex-m`, `cmsis`, `arm`, `gdbtarget`. |
| [`README.md`](README.md) | Rewritten around the Cortex-M workflow with the current full tool list and CMSIS-first quick start. |
| [`CHANGELOG.md`](CHANGELOG.md) | v1.0.27 release entry. |

---

## 3. Renames (reference table)

| Kind | Upstream | Fork |
| ---- | -------- | ---- |
| npm `name` | `debugmcpextension` | `cmsis-debugmcp` |
| `displayName` | `DebugMCP` | `CMSIS-DebugMCP` |
| `publisher` | `ozzafar` | `mather01` |
| Config section | `debugmcp.*` | `cmsis-debugmcp.*` |
| Command ids | `debugmcp.showAgentSelectionPopup` etc. | `cmsis-debugmcp.showAgentSelectionPopup` etc. |
| Output channel | `DebugMCP` | `CMSIS-DebugMCP` |
| MCP server `name` | `debugmcp` | `cmsis-debugmcp` |
| MCP resource URIs | `debugmcp://docs/…` | `cmsis-debugmcp://docs/…` |
| globalState key | `debugmcp.popupShown` | `cmsis-debugmcp.popupShown` |
| Generated launch-config prefix | `DebugMCP:` | `CMSIS-DebugMCP:` |

---

## 4. New MCP surface (what an agent sees that wasn't upstream)

### Tools

**CMSIS Solution panel control:**

- `cmsis_action(action, timeoutMs?)` — `build` / `load` / `erase` / `load_and_run` / `load_and_debug` / `attach` / `detach` / `stop_run`. ⭐ Preferred entry point for embedded.
- `flash(cbuildRunFile?, timeoutMs?)` — `pyocd load --cbuild-run` as a synchronous operation: bytes programmed + structured flash error; refuses under an active session.

**Session lifecycle & state:**

- `pause_execution(timeoutMs?)` — DAP pause, state-aware
- `wait_for_stop(timeoutMs?)` — block on the raw DAP `stopped` event; returns stop reason + state, or a structured timeout
- `reset(method?, halt?, timeoutMs?)` — in-session target reset via GDB monitor commands, verified PC-vs-reset-vector; honest "did NOT reset" reporting
- `get_session_status()` — 5-state classifier (`no-session` / `initializing` / `running` / `stopped` / `unresponsive`), never throws
- `check_target_connection()` — fast DAP `threads` liveness probe

**Inspection:**

- `read_memory(address, length, format, timeoutMs?)` — DAP `readMemory` with GDB fallback
- `read_core_registers(timeoutMs?)` — R0–R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK
- `read_cycle_counter(timeoutMs?)` — DWT CYCCNT with trace/counter enable, NOCYCCNT detection, wrap/halt/WFE caveats
- `read_peripheral_register(peripheral, register?, timeoutMs?)` — SVD-backed, names like `GPIOA`/`ODR`
- `get_fault_info(timeoutMs?)` — decoded CFSR/HFSR/DFSR/MMFAR/BFAR/AFSR
- `get_device_info()` — probe, device, GDB server, port, CMSIS config
- `get_call_stack(threadId?, levels?, timeoutMs?)` — full frames with `frameId`
- `get_threads(timeoutMs?)` — DAP threads, RTOS tasks with pyOCD/J-Link RTOS plugins
- `get_frame_variables(frameId, scope?, timeoutMs?)` — inspect any frame by id

**Serial:**

- `serial_list_ports()` — MS Serial Monitor API → `serialport` fallback
- `serial_open(path, baudRate?, dataBits?, parity?, stopBits?, rtscts?)` — OWNED port
- `serial_close()` / `serial_status()` / `serial_clear_buffer(from?)` / `serial_write(data, encoding?, appendNewline?)` / `serial_read(maxBytes?, waitMs?, consume?, format?, from?)`
- `serial_subscribe_monitor()` / `serial_unsubscribe_monitor()` — BRIDGE
- `serial_open_monitor()` — focus the panel for the user

### Resources

- `cmsis-debugmcp://docs/cmsis-embedded-guide` — Cortex-M fault decode, SCS memory map, RTOS tips
- `cmsis-debugmcp://docs/troubleshooting/embedded` — probe / target / SVD troubleshooting

### Existing tools modified

- `start_debugging` — `fileFullPath` is now optional; `configurationName` is the primary entry point for `gdbtarget`; refuses duplicates; demoted to non-CMSIS use cases in tool description; failures append recent adapter traffic (failed DAP responses, adapter stderr/console) instead of one opaque line.
- `step_over` / `step_into` / `step_out` / `continue_execution` — accept `timeoutMs`, auto-heal on overshoot by issuing DAP `pause` and reporting PC.
- `get_variables_values` / `evaluate_expression` — accept `timeoutMs`, state-aware errors.
- `restart_debugging` — actually waits for session readiness instead of fixed 300 ms.

---

## 5. Operational guarantees (engineering invariants)

- **No MCP tool call exceeds 60 s.** Every hardware-touching handler is wrapped in `withHandlerTimeout`, which races the work against a fixed deadline. The deadline is `min(agent-supplied timeoutMs, 60_000)`.
- **No DAP request hangs the call.** Every `customRequest` goes through `customRequestWithTimeout` which rejects with `HardwareTimeoutError` past its deadline. The underlying promise is left to settle on its own (we cannot cancel a DAP request mid-flight) but the caller regains control.
- **Inspection tools never lie about state.** If the target is running or the probe is unresponsive, the call returns a structured state-aware error pointing at the correct recovery tool — not a misleading "no debug session".
- **Concurrent tool calls don't trample each other.** Per-request `McpServer` instances, no shared mutable transport state.
- **Motion timeouts always produce actionable output.** `continue_execution` / `step_*` either return the new stop location or auto-heal: pause + read PC + report where the firmware actually was.

---

## 6. End-to-end validation

All registered tools were exercised in a single session against an **Alif AppKit-E8** (dual Cortex-M55, CPUID `0x411FD220` = r1p2) attached via CMSIS-DAP through pyOCD, using a launch configuration generated by the CMSIS Solution dialog. Reads of `0xE000ED00` returned the correct CPUID; Alif peripherals enumerated via SVD; `get_fault_info` correctly reported `DFSR=0x2` (BKPT) with all other fault banks clear when halted at a breakpoint; `get_threads` enumerated the FreeRTOS tasks via the pyOCD RTOS plugin; `get_call_stack` returned frame IDs that fed cleanly into `get_frame_variables`. The bundled `test/realboard/run.ts` driver covers this end-to-end and is reusable for other boards.

---

## 7. Known schema gaps for AI agents

Tool schemas that differ from names agents commonly guess — worth documenting for prompt-level hints:

- `read_memory` uses `length` (not `count`)
- `add_breakpoint` uses `fileFullPath` + `lineContent` (not `filePath` + `lineNumber`)
- `read_peripheral_register` uses `peripheral` + `register` (not `peripheralName` + `registerName`)
- `cmsis_action` uses `action` with the literal strings `load_and_debug` etc. — not separate tool names per button

---

## 8. Relationship to upstream

This fork is **not** intended to be merged back as-is — the embedded surface (CMSIS pipeline, fault decoder, SVD reader, hardware-timeout layer, dual serial backend) would be dead code for the 95% of upstream users debugging Python/TypeScript. The clean path for upstreaming would be factoring `src/core/*`, `src/utils/timeout.ts`, and `src/utils/sessionStateTracker.ts` into an optional "embedded" feature module gated on the presence of the CMSIS Debugger extension, and making the timeout layer + state-aware errors available generically while keeping the SVD / fault decoder / CMSIS panel controls gated. That refactor is out of scope for this evaluation build.

---

## 9. Upstream work deliberately not taken

Synced against upstream v2.3.0. These are the changes that were considered and rejected, with the reason — so the next sync does not re-litigate them.

| Upstream change | Why not |
| --- | --- |
| **`get_variables_values` requires `variableNames`** (2.3.0, breaking) | Taken as an *optional* filter instead, alongside the new `list_variable_names`. Embedded frames are small, so the full dump is usually what you want; making it mandatory would break every existing agent prompt for no gain here. |
| **`src/utils/withTimeout.ts`** | The fork's `src/utils/timeout.ts` is a strict superset — it also carries `customRequestWithTimeout` and `HardwareTimeoutError`. Porting it would mean two timeout utilities. |
| **`debugTestAtCursor` / VS Code Testing API test debugging** | No meaning for `gdbtarget` firmware. There is no test runner on the target. |
| **`debugConfigurationManager` refactor** (`-396` lines) | Upstream's went toward .NET/csproj auto-configuration. The fork's version is CMSIS-specific and keeps `jsonc-parser` (which upstream dropped) because CMSIS Solution generates `launch.json` *with comments*. |
| **Removal of `get_debug_instructions` and its doc** | Kept. Upstream replaced them with the `debug-live` Agent Skill, but GitHub Copilot Chat reads MCP tools and not `~/.agents/skills` — removing the tool would leave that harness with no guidance at all. The fork ships *both*: the tool and the `cmsis-debug-live` skill. |
| **The `debug-live` skill name** | The fork's skill is `cmsis-debug-live`. Both extensions can be installed at once and would otherwise fight over the same directory, leaving whichever registered last in place with a workflow written for the wrong kind of target. For the same reason the fork does no legacy-name cleanup — removing a `debug-live` directory would delete upstream's skill. |
| **`6f7fa56` "Remove extra checks in hasActiveSession()"** | Not ported (since v1.1.9). The fork replaced that gate with a DAP-event tracker plus `ensureStoppedSession` and state-aware errors, which is the better fix for embedded targets. |

### Taken, but adapted

| Upstream change | How it differs here |
|---|---|
| **Multi-window routing** (PR #104) | Same router/registry/control-server shape, but upstream resolves targets from a file path alone — fine there, since every one of its tools takes one. Only four do here, so the ladder continues: explicit pin → session target → the sole window with an active debug session → the sole window. Ties error out naming every candidate instead of guessing. Adds `list_debug_windows` / `select_debug_window`. Dispatch uses one compile-time-checked op table rather than two hand-written switches, because 42 ops duplicated twice would drift. |
| **Secret redaction** (PR #119) | Module ported nearly verbatim, policy adapted. Numeric scalars are never withheld whatever the variable is called — in firmware `auth`, `token` and `secret` are overwhelmingly `uint8_t` flags and parser tags, and a 32-bit integer cannot carry a credential. Raw target reads bypass redaction entirely, because real SVDs name registers `KEY`, `KR`, `KEYR` and `UNLOCK`. |
| **Logpoints** (issue #15) | Bound GDB-native via `dprintf`, with explicit printf specifiers (`{expr}` → `%d`, `{expr:%s}` to override) since GDB infers nothing about types. A condition is attached afterwards by breakpoint number, because `dprintf` takes no inline `if`. The tool description states plainly that the core still halts per hit — logpoints are not free on a Cortex-M. |
| **`add_breakpoint` by line** (issue #18) | Taken, but `lineContent` is retained as a deprecated fallback so existing agent prompts keep working. |
| **Stateful session transport** (PR #96) | Taken. Note this replaced the fork's *per-request* model, which existed to fix a concurrency bug — the regression is guarded by `test/transport/session-lifecycle.js`. |
| **esbuild bundling** | Script prepared, **packaging not switched over** — see [docs/packaging-esbuild.md](docs/packaging-esbuild.md). `serialport` must stay external regardless: `node-gyp-build` resolves its native `.node` relative to `__dirname` at runtime. |
