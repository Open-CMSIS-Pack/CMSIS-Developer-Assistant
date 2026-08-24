# CMSIS Developer Assistant - Debugging Instructions Guide

⚠️  **CRITICAL INSTRUCTIONS - FOLLOW THESE STEPS:**

0. **FIRST OF ALL:** Establish target awareness — read the project's CMSIS YAMLs and `launch.json` (topic `build`); otherwise you guess at addresses, peripheral names and the launch configuration.
1. **THEN:** Call `get_session_status` and branch on the result (topic `session`). `start_debugging` and `cmsis_action load_and_debug` refuse while a session is active.
2. **THEN:** Set an initial breakpoint with `add_breakpoint` (`line`, optionally `condition`), then a few strategic ones within the FPB budget (topic `breakpoints`).
3. **THEN:** Bring the target up only from `no-session`: `cmsis_action load_and_debug` for CMSIS solutions (builds, flashes, attaches — the panel's *Debug* button), `attach` for an already-flashed target, `start_debugging` only for non-CMSIS launch configurations.
4. **THEN:** Run, wait, look, read: `continue_execution` / `wait_for_stop`; `list_variable_names` before `get_variables_values`; cross-check variables against the hardware with `read_peripheral_register` / `read_memory` (topic `inspection`). On a fault, `get_fault_info` first (topic `faults`).
5. **FINALLY:** Trace back to the root cause, not the symptom (topic `troubleshooting`), then `clear_all_breakpoints`.

## 🐞 DEBUGGER FIRST — do not start by adding prints

Do not begin a runtime investigation by editing the firmware to add `printf` over UART/ITM, LED toggles or trace macros. On a Cortex-M that costs a rebuild, a reflash and a reset per hypothesis, moves code and data around, and changes the timing of the thing you are observing. Set a breakpoint and inspect the live state instead (variables, registers, memory, peripherals). Use `add_logpoint` only knowing it still halts the core per hit (topic `breakpoints`); for hot paths prefer `read_cycle_counter` or a RAM buffer read back with `read_memory`. Add permanent logging only when observability itself is the requested change. If the debugger cannot be used, state the concrete blocker before falling back to another method.

<!-- topic: session | The five session states and the right next action for each, several VS Code windows, leaving the session clean -->
## 🔎 Session status gate

Always call `get_session_status` *before* any session-changing tool. The five possible states each have a different correct next action:

| State | What it means | Correct next action |
| ----- | ------------- | ------------------- |
| `no-session` | No debug session is attached. | **CMSIS solutions: `cmsis_action load_and_debug`** (flashes then attaches via the CMSIS Solution panel — the panel's *Debug* button). `start_debugging` ONLY for non-CMSIS launch configurations or to attach without flashing. |
| `initializing` | The adapter is starting / flashing. | Wait briefly and call `get_session_status` again — do NOT issue another start. |
| `stopped` | A session is attached and the target is paused. | Skip `start_debugging` entirely. Use inspection tools (`get_call_stack`, `get_variables_values`, `read_memory`, …) directly, or `continue_execution` to resume. |
| `running` | A session is attached and the CPU is executing. | Inspection reads, breakpoint changes and stepping are rejected. Call `pause_execution`, or `wait_for_stop` if a breakpoint is expected to hit, or `stop_debugging`. |
| `unresponsive` | The probe / GDB server is hung. | Call `check_target_connection` to confirm, then `restart_debugging` or `stop_debugging`. Do NOT issue more inspection calls — they will time out. |

`start_debugging` and `cmsis_action load_and_debug` refuse with a structured error if a session is already active, naming the existing session and pointing you at `restart_debugging` / `stop_debugging`. Save the round-trip by checking up front.

Every tool call is measured; `get_session_status` ends with the session's tool-call totals (calls, bytes returned, time in tools, timeouts, errors) so you can see what an investigation is costing.

## 🪟 Several VS Code windows open

The MCP server runs in one window (the router) and forwards each call to the window that owns the target. It resolves from a file path when the tool has one, otherwise from the window that has an active debug session.

When **two windows are debugging at once** it refuses to guess and names both — reading the wrong board's memory looks exactly like a firmware bug and costs far more than being asked to pick. Use `list_debug_windows` to see the candidates and `select_debug_window({ pid })` to pin one for the rest of the session.

## 🧹 Clean up

Once the root cause is identified and verified, call `clear_all_breakpoints` before concluding — a clean slate for the next task, and free FPB comparators for it.
<!-- /topic -->

<!-- topic: build | Target awareness from the CMSIS YAMLs and launch.json; build, flash and attach with cmsis_action / flash / start_debugging; long builds and the result line -->
## 🛰️ Target awareness (do this *before* any breakpoint or debug call)

Embedded debugging without target context is guesswork. Before issuing any debug command, gather the following from the workspace. After a successful build these files exist; if any are missing, build first (`cmsis_action` with `action='build'`).

### Files to read, in this order

| Step | File pattern (relative to workspace root) | What you learn |
| ---- | ----------------------------------------- | -------------- |
| 1 | `<name>.csolution.yml` | The top-level solution: which target / build types and contexts exist, packs required, target board. |
| 2 | `<name>.cbuild-idx.yml` | Index of every built context. Lists `<context>.cbuild.yml` paths and the `<context>.cbuild-run.yml` for each context. **Start here** to find the active build artifacts. |
| 3 | `out/<context>.cbuild.yml` (or wherever `cbuild-idx.yml` points) | Per-context build details: **device** (e.g. `AlifSemiconductor::AE822F4055U7AE_RTSS_HE`), processor core, **ELF / output paths**, used CMSIS packs, components, source files, defines. |
| 4 | `out/<context>.cbuild-run.yml` | Debug runtime: GDB server (pyOCD / J-Link), port, programming algorithms, reset / debug sequences, SVD path. This is what the CMSIS Debugger extension hands to the gdbtarget config. |
| 5 | `.vscode/launch.json` | The actual VS Code debug configurations. Look for `type: gdbtarget` entries — their `name` field is what you pass as `configurationName` to `start_debugging`. Should be auto-generated/refreshed by the user from the **CMSIS Solution → Manage Solution → Debugger** dialog. |

### If `launch.json` is missing or out of date

Ask the user to:

> Open the **CMSIS Solution** panel → **Manage Solution** → **Debugger** tab → select the debug probe / GDB server → **Apply**. This regenerates `.vscode/launch.json` to match the current `cbuild-run.yml`.

You cannot do this for the user — it is a UI-driven step in the CMSIS Solution extension.

### Documentation links from CMSIS packs

Some projects expose **documentation links** in the CMSIS Solution dialog (board datasheets, MCU reference manuals, BSP/DFP READMEs). These come from the installed CMSIS-Packs (DFP, BSP) or external URLs declared in the pack manifest. Before assuming peripheral semantics, addresses, or fault behavior:

- Check the pack documentation surfaced in the CMSIS Solution UI.
- The SVD shipped with the DFP is the authoritative source for peripheral names and bit fields used by `read_peripheral_register`.

### Cross-check with `get_device_info`

After `cmsis_action load_and_debug` (or `start_debugging`), call `get_device_info` once to confirm the live session matches what the YAMLs said: program path, GDB server, port, `cbuildRunFile` reference. A mismatch means the user picked a different `configurationName` than the one you analysed.

### Quick checklist

- [ ] Found `<name>.cbuild-idx.yml` and identified the active context.
- [ ] Read the matching `<context>.cbuild.yml` — know the device, core, ELF path.
- [ ] Read the matching `<context>.cbuild-run.yml` — know the probe, port, SVD.
- [ ] Confirmed `launch.json` has a `gdbtarget` entry whose name to pass to `start_debugging`.
- [ ] Skimmed any pack documentation linked from the CMSIS dialog.
- [ ] (After attaching) `get_device_info` matches expectations.

## 🔨 Build, flash, attach

`cmsis_action` drives the CMSIS Solution extension on the currently active csolution context — the same as clicking the panel's buttons. For embedded debugging it is the entry point; `start_debugging` uses the plain VS Code debug tab and skips the build / flash pipeline.

| Action | What it does | What comes back |
| ------ | ------------ | --------------- |
| `build` | Build the active context. | Waits for the cbuild task. |
| `load` | Flash the built image. | Waits for the flash task. |
| `erase` | Erase target flash. | Waits for the task. |
| `load_and_run` | Flash and run without a debug session. | Waits for the task. |
| `load_and_debug` | Flash and start a debug session (the *Debug* button). | Returns when the session is up, with its state. |
| `attach` | Attach to an already-flashed target (skips programming). | Returns when the session is up. |
| `detach` / `stop_run` | Detach the debugger / stop a previous `load_and_run`. | Immediate. |

**Read the result line.** `build`, `load`, `erase` and `load_and_run` end with a terminal ✅ success / ❌ failure and the task's exit code. On ❌ fix the source and build again — do not poll for an output file and do not call `get_session_status` to find out whether a build worked. `load_and_debug` and `attach` verify that the session really has a target behind it (a phantom session with no threads is reported as such).

**Long builds.** Pack resolution or a first build can take longer than a tool call's 60 s cap. If the reply says the call did not complete within its cap, the build is still running in the terminal, not failed: wait, then run `cmsis_action build` again — the incremental build finishes quickly and returns the real result. `timeoutMs` (max 60000) widens or tightens the wait of one call; for `load_and_debug` / `attach` it bounds the session-readiness wait.

**`flash`** programs the target with `pyocd load --cbuild-run` and returns synchronously: bytes programmed and rate, or the exit code with pyOCD's error lines. It programs every image listed under `output:` in the cbuild-run file (multi-core safe), auto-resolves that file from `launch.json` / `out/` when `cbuildRunFile` is omitted, and needs `pyocd` on the PATH. It **refuses while a debug session is active** — programming under a live session wedges most probes — so the sequence is `stop_debugging` → `flash` → `cmsis_action attach` (or `load_and_debug`). `cmsis_action load` is the alternative that uses the CMSIS extension's own flash pipeline.

**`start_debugging`** launches a `launch.json` configuration through the normal VS Code pipeline (`configurationName` = the `name` of a `gdbtarget` entry; `workingDirectory` is required). Use it for non-CMSIS projects, or to attach to an already-flashed CMSIS target without reprogramming. It refuses while a session is active.
<!-- /topic -->

<!-- topic: breakpoints | Where to put breakpoints, conditions, logpoints and their cost on Cortex-M, the FPB comparator budget -->
## 🎯 Breakpoint strategy

- **Pass `line` (1-based), not `lineContent`.** `lineContent` is deprecated: it substring-matches and sets a breakpoint on *every* line containing the text. In C that routinely means dozens of lines — `}`, `return;`, `break;` — and it will exhaust the FPB comparators (see below) before you notice.
- Set breakpoints inside the function body, on an executable line — not on the signature, a comment, an empty line or a lone brace.
- Set breakpoints before loops or conditionals, at assignments you want to inspect, at the start of functions to inspect parameters, and before and after critical operations (peripheral init, DMA start, a mutex handover).
- Set at least one breakpoint before bringing the target up: the program then stops at a place you chose instead of somewhere in a busy loop.

### Conditional breakpoints

Pass `condition` to `add_breakpoint` (e.g. `i == 100`, `p != 0`, `state == FSM_ERROR`) instead of hitting a breakpoint hundreds of times. The condition becomes GDB's native `if` clause, so **the core is only halted when it holds** — a host-side condition would still stop the CPU on every hit and decide afterwards, which wrecks timing in a hot loop or an ISR. `list_breakpoints` shows conditions as `file:line [when: ...]`.

### Logpoints — useful, but not free on Cortex-M

`add_logpoint` prints a message and resumes instead of pausing. Embed expressions in braces: `"adc={sample} state={fsm}"`.

GDB infers nothing about types, so specifiers are explicit:

- `{expr}` → `%d` (the common embedded case)
- `{expr:%s}` / `{expr:%f}` / `{expr:%p}` / `{expr:%08lx}` → that specifier
- `{{` and `}}` → literal braces

⚠️ **The core still halts on every hit** while GDB formats and prints, then resumes. In an ISR or a hot loop this distorts the very timing you are usually trying to observe. For high-rate tracing prefer `read_cycle_counter` around the region, or have the firmware fill a RAM buffer that you read back with `read_memory`.

### ⚠️ Cortex-M hardware breakpoint limit

Cortex-M cores have a small **fixed number of hardware breakpoint comparators** (FPB unit). When the limit is reached, additional breakpoints are silently dropped, fail to bind, or — depending on the GDB stub — make the *whole* set unreliable. **Never set more simultaneous breakpoints than the core supports.**

Typical limits (verify against the device's TRM / cbuild.yml):

| Core              | Comparators (typical) |
|-------------------|-----------------------|
| Cortex-M0 / M0+   | 4                     |
| Cortex-M23        | 4                     |
| Cortex-M3 / M4    | 6                     |
| Cortex-M7         | 8                     |
| Cortex-M33 / M55 / M85 | 8                |

Defensive defaults:

- Treat **4 simultaneous breakpoints** as the safe upper bound unless you have confirmed the core supports more (check `cbuild.yml` for the processor name).
- Before adding a breakpoint, call `list_breakpoints` to see the current count.
- When you have to investigate a wider area, work iteratively: set 2–3 well-chosen breakpoints, hit one, learn what you need, remove or replace it before adding the next.
- After concluding an investigation phase, call `clear_all_breakpoints` to free comparators.

Software breakpoints (which patch Flash without a comparator) are *not* an option on Flash for most Cortex-M targets — only RAM-resident code can use them, which is rarely the case here.

### Common mistakes

❌ Starting the target without a breakpoint → ✅ set the initial breakpoint first.
❌ Locating a breakpoint with `lineContent` → ✅ pass the 1-based `line`.
❌ Hitting a breakpoint 500 times to reach one iteration → ✅ pass `condition` so GDB only halts the core when it holds.
❌ Stepping over the problematic line without understanding why → ✅ break *on* it, restart, and inspect before it executes.
❌ Leaving six breakpoints bound on a Cortex-M4 → ✅ stay within the comparator budget, `clear_all_breakpoints` between phases.
<!-- /topic -->

<!-- topic: inspection | Run-and-wait, reset vs restart, cycle-accurate timing, reading variables, registers, memory and peripherals, secret redaction -->
## ⏱️ Execution control: wait_for_stop, reset, cycle timing

**Never sleep blind waiting for a stop.** After `continue_execution` returned while the target was still running (timeout), or after issuing execution through `evaluate_expression` (`-exec continue`), call `wait_for_stop` — it blocks on the raw DAP `stopped` event and returns the stop reason + state, or a structured timeout. It returns immediately if the target is already stopped, and it issues no execution commands itself.

**A motion tool that timed out has already paused the target** and reports where it actually is. Read that PC before adding more breakpoints — firmware sitting in a polling loop, an ISR, or a fault handler all look the same from the outside and the PC tells them apart immediately.

**`reset` vs `restart_debugging`.** `restart_debugging` restarts the whole VS Code session (re-launch, breakpoints re-bound). `reset` resets only the target *inside* the live session — the session and breakpoints survive — and verifies the outcome: after the reset-halt the PC must equal the reset vector read from the vector table, or the tool says the target did NOT appear to reset (silent non-resets are common on attach configurations). Trust the verification, not the command echo. A running target is halted first. Methods: `auto` (escalates `system` → `core` → `hardware` until one verifies), `system` (SYSRESETREQ), `core` (VECTRESET), `hardware` (nSRST — only works when the reset line is wired from probe to target; if it isn't, no software reset can recover a wedge — power-cycle). `halt: true` (default) leaves the target at the reset vector; `halt: false` resumes after verification. When `reset` reports no reset on a J-Link / secure-boot part, the fallback is `stop_debugging` and `cmsis_action load_and_debug` again.

**Cycle-accurate timing with `read_cycle_counter`.** Read the DWT cycle counter at point A, run to point B (`continue_execution` / `wait_for_stop`), read again, subtract mod 2^32. Caveats that bite: the 32-bit counter wraps (~10.7 s @ 400 MHz — accumulate over longer spans), and CYCCNT **stops while the core is halted and during WFE sleep** — it counts ACTIVE cycles only, so a delta excludes halted debug time and sleep.

## 🔬 Inspecting variables: discover, then read

`list_variable_names` reports what is in scope by **name and type only**, reading no values. `get_variables_values` then reads them — pass `variableNames` to fetch just what you need, or omit it to dump the whole scope.

- On a **slow probe or a large frame**, discover first and then request two names instead of thirty. That is one round trip instead of thirty.
- On a small frame, omitting `variableNames` is fine and usually what you want — embedded frames are small. Without `variableNames` a listing is capped at 40 variables per scope and 200 characters per value, with a footer saying how many were left out; with `variableNames` nothing is capped.
- Step, continue, pause and `wait_for_stop` return a compact state: the location, the top 5 frames (the rest counted — `get_call_stack` has them all, workspace-relative, 20 inline unless you pass `levels`), and the breakpoint list only when it changed.
- Names that match nothing are reported back explicitly, so a typo does not look like "the variable does not exist".
- To inspect a **caller's** frame without disturbing the active one: `get_call_stack` → take a `frameId` → `get_frame_variables`.
- `evaluate_expression` evaluates C expressions in the current frame; `-exec …` passes a GDB command through (`-exec x/8xw $sp`, `-exec info registers`).

## 🔌 When the variable and the hardware disagree

This is the characteristic embedded bug, and the reason the memory tools exist.

- **Read the peripheral, not the shadow copy.** `read_peripheral_register` goes through the SVD, so ask for `GPIOA` / `ODR` by name; without a register name it lists the peripheral's registers. If the SVD is missing, the `cbuild-run.yml` says where it should be.
- **Ask the SVD before you read.** `lookup_register { peripheral, register }` shows the bit fields and enumerated values, `lookup_peripheral { name }` the register map, `lookup_peripheral { address }` what sits at an address — none of them needs a session or touches the target.
- **Read the address directly.** `read_memory` on the register address tells you what the bus sees (hex by default; `format: 'ascii'` or `'both'` on request, up to 4096 bytes). A mismatch against the C variable means the write never landed — wrong alias, missing `volatile`, or a peripheral clock that is off.
- **Check the clock first.** A peripheral whose clock gate is closed reads back zeros or retains defaults and silently ignores writes — `RCC.AHBxENR` / `RCC.APBxENR` or the vendor's equivalent. This is the single most common "the peripheral is broken" cause.
- **Watch for caches and write buffers** on M7 and larger parts: what the core wrote may not be what DMA reads, and what DMA wrote may not be what the core reads until the D-cache line is invalidated.
- `read_core_registers` gives R0–R12, SP, LR, PC, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK in one call; `get_threads` lists RTOS tasks with their top frame.

### Secret redaction

Values whose name or content looks like a credential are withheld before leaving the extension (`<redacted: possible secret>`), controlled by `cmsis-developer-assistant.redactSecrets` (default on).

This is tuned for firmware and should rarely get in your way:

- **Numeric scalars are never withheld** — a `uint8_t auth`, a `token` counter, or `0xDEADBEEF` stays readable whatever it is called.
- **Raw target reads are never redacted**: `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`, and `-exec` GDB passthrough through `evaluate_expression`. Real SVDs name registers `KEY`, `KR`, `KEYR` and `UNLOCK` — the watchdog and flash unlock registers — and those are exactly what you need when the watchdog is resetting you.
<!-- /topic -->

<!-- topic: faults | Decode a HardFault, BusFault, MemManage or UsageFault: get_fault_info, the stacked exception frame, resolving the faulting address, the usual causes -->
## 💥 When it faulted

1. **`get_fault_info` first.** It reads and decodes CFSR / HFSR / DFSR / MMFAR / BFAR / AFSR bit by bit and usually names the fault class outright. `FORCED` in HFSR means a configurable fault escalated to HardFault because its own handler was disabled — the CFSR bits still say which one.
2. **`read_core_registers`** for PC, LR, MSP, PSP and xPSR. Halted inside the handler, LR holds `EXC_RETURN` (`0xFFFFFFxx`): bit 2 set → the exception frame was pushed on **PSP**, clear → on **MSP**; bit 4 clear → an FP-extended frame (26 words) instead of the basic 8. The low nine bits of xPSR are the active exception number (3 HardFault, 4 MemManage, 5 BusFault, 6 UsageFault).
3. **`read_memory` 32 bytes at that stack pointer**: R0, R1, R2, R3, R12, LR, PC, xPSR in that order. The stacked **PC is the faulting instruction** for a precise fault; the stacked LR is its caller. `get_call_stack` walks up from there; `get_frame_variables` on a `frameId` shows the locals at the fault site.
4. **Resolve the address.** BFAR (when `BFARVALID`) or MMFAR (when `MMARVALID`): `lookup_peripheral { address }` names the peripheral and register at it from the SVD without touching the target. `0x4000_0000`–`0x5FFF_FFFF` is a peripheral → check its clock gate with `read_peripheral_register` before anything else; the `0x2000_0000` range is SRAM → pointer arithmetic or an overflowed buffer; `0xE000_0000` is the PPB; anything outside the device's memory map is a wild pointer.

| Flag | Usual cause |
| ---- | ----------- |
| BFSR `PRECISERR` + BFAR | Access to an unclocked, disabled or nonexistent peripheral, or beyond the end of RAM |
| BFSR `IMPRECISERR` | A buffered write that faulted later — look one store back from the stacked PC |
| BFSR `IBUSERR`, MMFSR `IACCVIOL` | Jumped through a corrupted function pointer, or returned into garbage after a stack overflow |
| MMFSR `DACCVIOL` | MPU violation, or a null-pointer dereference with region 0 unmapped |
| `STKERR` / `MSTKERR`, UFSR `STKOF` | Stack overflow while pushing the frame — compare SP with the stack bounds from the linker script / `.map` |
| UFSR `UNDEFINSTR`, `INVSTATE` | Executing data, or a branch to an even address — Thumb needs bit 0 set |
| UFSR `UNALIGNED` | Unaligned access with `UNALIGN_TRP` set — a packed struct or a cast pointer |
| UFSR `DIVBYZERO` | Integer division by zero with `DIV_0_TRP` set in CCR (`0xE000ED14`) |
| UFSR `NOCP` | FPU instruction with the FPU off — check CPACR (`0xE000ED88`) |
| HFSR `VECTTBL` | Vector table fetch failed — VTOR points at the wrong image |

**Stack overflow without a fault flag:** `read_core_registers`, compare MSP / PSP with the stack region; a canary at the bottom of the stack tells you whether it was crossed. On Armv8-M, `MSPLIM` / `PSPLIM` turn this into a `STKOF` fault instead.
<!-- /topic -->

<!-- topic: troubleshooting | Root cause, not symptom: the investigation loop, embedded examples, breakpoints that never hit, warning signs and the closing checklist -->
## 🚨 ROOT CAUSE ANALYSIS - CRITICAL FRAMEWORK

### **NEVER STOP AT SYMPTOMS - ALWAYS FIND THE ROOT CAUSE**

When you encounter an issue during debugging (a wrong value, a fault, a peripheral that does not respond), apply this systematic approach:

#### **SYMPTOM vs ROOT CAUSE**

- **SYMPTOM:** what you observe is wrong ("the ADC buffer is all zeros")
- **ROOT CAUSE:** *why* it is wrong ("the buffer is in cacheable SRAM and the driver never invalidates the D-cache after the DMA transfer")

#### **ROOT CAUSE INVESTIGATION PROCESS**

1. **Identify the symptom** — what exactly is wrong; record the current line, the variable state and, on a fault, the decoded flags.
2. **Ask why** — why is this value wrong, why did this function return early, why did this condition fail.
3. **Trace backwards** — set a breakpoint where the wrong value is produced (with `condition` to stop only when it is wrong), restart or reset, step into it. Cross-check every "the hardware should have done X" against the hardware: `read_peripheral_register`, `read_memory`.
4. **Continue until the origin** — keep asking why until you reach where data enters the system incorrectly or a fundamental assumption (clock enabled, cache coherent, initialisation order, stack size) is violated.

#### **⚠️ WARNING SIGNS YOU'RE STOPPING TOO EARLY**

- You found a wrong value but did not check who last wrote it.
- You decoded a fault but did not resolve BFAR / the stacked PC to a line and a reason.
- You saw the peripheral register was wrong but did not check the clock gate and the init order.
- You have an explanation that the FVP / simulation would contradict.

#### **✅ SIGNS YOU'VE FOUND THE ROOT CAUSE**

- You can explain the complete chain from root cause to symptom.
- Fixing it would prevent the symptom, and you can verify that on the target (reflash, run to the same breakpoint, read the same register).
- It sits at a fundamental level: initialisation order, clock tree, memory attributes, a violated hardware assumption, a wrong constant.

### **🔍 PRACTICAL EXAMPLES - SYMPTOM vs ROOT CAUSE**

#### **Example 1: `adc_buffer[0]` reads 0 on the board, correct on the FVP**

❌ **STOPPING AT SYMPTOM:** "the DMA does not fill the buffer on hardware"
✅ **FINDING ROOT CAUSE:** breakpoint after the transfer-complete flag → `get_variables_values adc_buffer` shows zeros → `read_memory` at `&adc_buffer` shows the samples → the core is reading a stale D-cache line: the buffer lives in cacheable SRAM and the driver never invalidates after DMA. The FVP models no cache, so it "works" there.

#### **Example 2: HardFault a few seconds after boot**

❌ **STOPPING AT SYMPTOM:** "HardFault_Handler is reached"
✅ **FINDING ROOT CAUSE:** `get_fault_info` → BusFault `PRECISERR`, BFAR `0x40005400` (the I2C1 block) → stacked PC in `i2c_init` → `read_peripheral_register RCC APB1ENR` shows `I2C1EN = 0` → the sensor driver's init runs before the clock tree is configured. Root cause: initialisation order in `main`, not the I2C driver.

#### **Example 3: the firmware restarts every few seconds, no fault flags**

❌ **STOPPING AT SYMPTOM:** "it crashes"
✅ **FINDING ROOT CAUSE:** `read_peripheral_register RCC CSR` shows the independent-watchdog reset flag → breakpoint in the loop that kicks the watchdog with `condition` on the loop counter → the kick sits behind a semaphore wait that blocks for longer than the timeout. Root cause: the watchdog is fed from a task that can block.

#### **Example 4: UART prints garbage after the clock switch**

❌ **STOPPING AT SYMPTOM:** "the UART is misconfigured"
✅ **FINDING ROOT CAUSE:** `read_peripheral_register` on the UART's baud register matches the divisor the driver computed → `get_variables_values SystemCoreClock` is still the reset-clock value → `SystemCoreClockUpdate()` was never called after the PLL switch. Root cause: a stale clock variable, not the UART.

### When it did not reach your breakpoint

`continue_execution` that times out already pauses the target and reports where it actually is — read that before adding more breakpoints. Firmware sitting in a polling loop, an ISR, or a fault handler all look the same from the outside and the PC tells them apart immediately. If the PC is in a fault handler, switch to `get_fault_info`. If the breakpoint never bound, `list_breakpoints` shows it unverified: the line has no code (optimised away, wrong file), or the FPB comparators are exhausted.

#### **🎯 ROOT CAUSE INVESTIGATION CHECKLIST**

Before stopping your debug session, ensure you can answer:

- [ ] What is the immediate symptom?
- [ ] What code produced it, and what did the hardware (registers, memory) say at that point?
- [ ] What input, state or hardware condition made that code misbehave?
- [ ] Where did that incorrect input or condition originate?
- [ ] If I fix this root cause, will it prevent the symptom — and did I verify that on the target?
<!-- /topic -->
