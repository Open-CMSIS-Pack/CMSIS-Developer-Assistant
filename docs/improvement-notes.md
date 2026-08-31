# CMSIS Developer Assistant improvement notes & roadmap

Field notes collected from real hardware sessions (ModelNova, Alif AppKit-E8 /
Ensemble E8) whenever the agent had to **leave the MCP tool surface** and drive
`pyocd` / `JLinkGDBServerCL` / shell tools directly. Each item records what was
bypassed, why, and the tool/feature that would have kept the workflow inside
DebugMCP. This is a living document — keep it in sync as items ship.

## Status

### Closed

| # | Item | Shipped in |
|---|------|-----------|
| 1 (build half) | Synchronous build result — `cmsis_action build` now waits for the cbuild task and returns the real exit code (✅/❌), never "check the output channel". | 1.2.1 |
| — | Attach zombie-detection — `cmsis_action attach` distinguishes a real connection (≥1 thread) from a phantom `gdbtarget` session with no target behind the port. | 1.1.7–1.1.9 |
| 1 (flash half) | Synchronous flash result — new `flash` tool wraps `pyocd load --cbuild-run` and returns bytes programmed + structured flash error; refuses under an active session. `cmsis_action load` keeps the task-exit-code path. | unreleased |
| 3 | Verified reset — new `reset` tool with method selection (auto/system/core/hardware) and PC-vs-reset-vector verification; reports honestly when the target did not reset. | unreleased |
| 4 | Cycle-accurate timing — new `read_cycle_counter` (DWT CYCCNT with enable, NOCYCCNT detection, wrap/halt/WFE caveats). | unreleased |
| 6 | Wait-for-stop — new `wait_for_stop(timeoutMs)` blocks on the raw DAP `stopped` event and returns the reason + state, or a structured timeout. | unreleased |
| 7 | Launch-failure diagnostics — recent adapter traffic (failed DAP responses, stderr/console output) is captured per session and appended to `start_debugging` / `cmsis_action` failure reports. | unreleased |

### Top remaining (priority order)

1. **pyocd-gdbserver as a documented fallback path** — when the VS Code launch
   pipeline can't spawn a server, bring one up / document the manual path
   (item 2).
2. **RTOS time / uptime** — RTOS-aware `get_kernel_time`, or document the
   inferior-call pattern (item 5).
3. **Host-side USB enumeration checks** — tiny `list_usb_devices` utility for
   bring-up (item 8).
4. **Post-mortem with broken debug access** — `reconnect_probe` or automatic
   retry-with-reconnect inside read_memory (item 9).

---

## Field notes (verbatim)

### 1. Flashing (bypassed with `pyocd load --cbuild-run <file>`)

- `cmsis_action load` is fire-and-forget ("check the CMSIS output channel")
  — an agent cannot read that channel, so success/failure is unknowable.
  *(Addressed in two steps: 1.2.1 made `load` wait for the cbuild/flash task
  and return its exit code; the new `flash` tool wraps
  `pyocd load --cbuild-run` and returns bytes programmed / a structured flash
  error synchronously.)*
- `start_debugging` with a launch config that has a `CMSIS Load` preLaunchTask
  failed opaquely; the attach config cannot flash at all.
- Suggestion: develop a status channel for flash programming

### 2. GDB server lifecycle (bypassed with manual `JLinkGDBServerCL ...`)

- When the VS Code launch pipeline fails to spawn the server (renderer error
  "Converting circular structure to JSON"), there is no MCP way to bring one
  up for the attach config.
- Suggestion: `start_gdb_server` / `stop_gdb_server` tools that read server
  command + parameters from launch.json or cbuild-run, plus a liveness probe
  (port listening, first DAP ping). Document `pyocd gdbserver` as the fallback.

### 3. Target reset (bypassed with `pyocd reset -m hw`)

- `restart_debugging` on an attach config silently stopped resetting the
  target (RTOS tick and counters survived "restarts"); nothing in the result
  said so.
- A wedged USB device controller required a hardware (nSRST) reset — no MCP
  tool can request a reset method.
- Suggestions: (a) a `reset` tool with method selection (core / hw / por,
  probe-dependent); (b) `restart_debugging` should verify the reset took
  effect (e.g. kernel tick or DWT cycle counter went backwards) and report
  "restarted but target did NOT reset" honestly.

### 4. Cycle-accurate timing (bypassed with `evaluate_expression` on 0xE0001004)

- Stage timing was measured by hand-reading DWT_CYCCNT at breakpoints.
- Suggestion: a `read_cycle_counter` / `profile_between_breakpoints` helper
  that knows the DWT (enable TRCENA if needed, warn about the 32-bit wrap at
  ~10.7 s @ 400 MHz, and that CYCCNT halts during core halt AND during WFE
  sleep - both bit us).

### 5. RTOS time / uptime (bypassed with inferior call `osKernelGetTickCount()`)

- Used as a run-time-only timebase for fps measurements.
- Suggestion: an RTOS-aware `get_kernel_time` (RTX/FreeRTOS detection), or
  document the inferior-call pattern; inferior calls from an idle-thread stop
  worked but feel fragile.

### 6. Wait-for-stop (bypassed with shell sleep + pause/status polling)

- After `continue_execution` an agent has no way to block until the next stop;
  it either sleeps blind or pauses too early (we missed a 15 s playback window
  this way once).
- Suggestion: `wait_for_stop(timeoutMs)` — returns on breakpoint/fault/stop
  with the stop reason, or timeout.

### 7. Launch failure diagnostics (bypassed by grepping VS Code logs)

- `start_debugging` failures return one opaque line; the real cause (task
  error, DAP error, config resolution) is only in the extension host /
  renderer logs.
- Suggestion: surface the underlying DAP/task error text in the tool error;
  optionally a `get_last_session_diagnostics` tool.

### 8. Host-side USB enumeration checks (bypassed with `ioreg`/`system_profiler`)

- Bring-up debugging needed "is the device enumerated on the host?" several
  times (SDSIO client, VID/PID checks). Arguably out of scope, but a tiny
  `list_usb_devices` host utility would complete the embedded bring-up story.

### 9. Post-mortem with broken debug access

- After a hard fault the fault-register and stacked-frame reads failed
  ("all GDB strategies exhausted") until probe reconnect. A `reconnect_probe`
  or automatic retry-with-reconnect inside read_memory would save the manual
  server bounce.

### 10. Documentation lookups (bypassed with a web search for a datasheet)

**Observed (2026-08-31, STM32 board with an Analog Devices AD4883 ADC):** the
agent had the documentation tools and the datasheet was already indexed as
`user/ad4883` (116 pages), yet it web-searched the part, timed out, fetched
twice more, and never called `list_target_docs`. Its own diagnosis:

- it read the tools as "what the DFP/BSP ship" — an ADC datasheet did not fit
  that category, and nothing said the user/workspace document folders are
  *for* third-party parts;
- "what is an AD4883?" pattern-matched to a web lookup, and once in web mode it
  stayed there;
- there was no cheap discovery step in its habit loop — one `list_target_docs`
  call would have answered;
- the first correct call resolved an unrelated `Blinky+MPS3` cbuild-run from a
  fixture folder in the same workspace, so it failed until `pack`/`device` were
  passed — friction that trains an agent to reach for the web.

**Shipped (unreleased):** the MCP instructions, the tool descriptions, the
`cmsis-pack-docs` / `cmsis-debug-live` / `add-board-layer` skills and the
`build` topic say that third-party parts (sensors, ADCs, codecs, radios) are
documented the same way — any part number starts at `list_target_docs`, an
unlisted datasheet is fetched by URL with `fetch_doc` (the web finds the URL,
the tools read the document), never read as a PDF — and that a document the
user provides goes into `docs/` or through *Import Document for Current
Target*. Target resolution asks the CMSIS Solution extension for the active
csolution and target-type and picks that context when the workspace holds
several solutions, so the first call works without `target`.

**Not covered here:** the agent-side habit itself. A project `CLAUDE.md` /
`AGENTS.md` line — "before any web search for a part number, run
`list_target_docs`" — is the project's call; the Claude Code `PreToolUse`
hook that denies `Read` on `*.pdf` is the hard stop for the ingest half.

### 11. Search ranking benchmark (issue #29)

`npm run bench:search -- --pages <doc.pages.jsonl> --svd <device.svd>` — gold =
manual pages whose heading names a register in parentheses; queries from the SVD
`<description>` of each register (set a: descriptions that do not contain the
register name; set b: description + name). RM0455 rev 3 (2 965 pages, 495 register
headings) × STM32H7B3.svd (Keil::STM32H7xx_DFP 4.1.3), pdftotext extraction.

Set (a), 313 queries:

| index | heading weight | post boost | R@1 | R@3 | MRR |
|---|---|---|---|---|---|
| body only (0.x) | 0 | 3 | 49.5% | 70.9% | 0.621 |
| body + heading | 3 | 1.5 | 62.9% | 81.8% | 0.734 |
| body + heading | **5** | **1.5** | **64.5%** | **81.8%** | **0.741** |

Set (b), 333 queries:

| index | heading weight | post boost | R@1 | R@3 | MRR |
|---|---|---|---|---|---|
| body only (0.x) | 0 | 3 | 78.1% | 96.7% | 0.873 |
| body + heading | 3 | 1.5 | 98.2% | 100.0% | 0.990 |
| body + heading | **5** | **1.5** | **98.8%** | **100.0%** | **0.994** |

Shipped: index version 2 with the heading field, weight 5, post boost 1.5.
The remaining set-(a) misses are registers whose SVD description is generic
("control register 1") — the SVD-driven query expansion (#29 part 2) is the
next lever.
