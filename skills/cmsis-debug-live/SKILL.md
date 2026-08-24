---
name: cmsis-debug-live
description: Drive a live Arm Cortex-M debug session through the CMSIS Debugger to investigate firmware runtime bugs — HardFaults and other faults, crashes, hangs, failing tests, peripherals that do not respond, wrong/null values that are right in simulation but wrong on hardware, unexpected output, code that never reaches the line you expect, timing that does not close. Prefer it as the first investigation step whenever live inspection is practical, and use it instead of adding temporary printf/UART logging, LED toggles, or console output to diagnose firmware — halting the CPU and looking is cheaper and does not perturb the target the way a reflash with extra prints does. Pairs with the CMSIS Developer Assistant MCP server, which exposes the breakpoint / step / memory / register / peripheral tools.
license: MIT
allowed-tools:
  - get_debug_instructions
  - get_session_status
  - check_target_connection
  - get_device_info
  - cmsis_action
  - flash
  - start_debugging
  - stop_debugging
  - restart_debugging
  - reset
  - add_breakpoint
  - add_logpoint
  - remove_breakpoint
  - clear_all_breakpoints
  - list_breakpoints
  - step_over
  - step_into
  - step_out
  - continue_execution
  - pause_execution
  - wait_for_stop
  - list_variable_names
  - get_variables_values
  - get_frame_variables
  - evaluate_expression
  - get_call_stack
  - get_threads
  - read_memory
  - read_core_registers
  - read_cycle_counter
  - read_peripheral_register
  - get_fault_info
  - serial_list_ports
  - serial_open
  - serial_close
  - serial_status
  - serial_read
  - serial_write
  - serial_clear_buffer
  - serial_subscribe_monitor
  - serial_unsubscribe_monitor
  - serial_open_monitor
  - list_debug_windows
  - select_debug_window
---

# CMSIS Developer Assistant — Live Cortex-M Debugging

Embedded debugging differs from host debugging in ways that change the workflow,
not just the tool names:

- **The target is one physical thing.** There is no "run it again with a print".
  Halting the CPU stops the world — timers, DMA, and the peripherals' notion of
  time. What you observe is changed by observing it.
- **Symbols are not the whole story.** A value can be right in the debugger and
  wrong in the peripheral, because the write went to the wrong alias, was
  optimised out, or landed in a cache the peripheral cannot see.
- **The probe can wedge.** A failed read may mean the memory is inaccessible,
  or that the debug link is gone. Those need different responses.

> The `allowed-tools` list uses the tool names the CMSIS Developer Assistant server
> registers. Some runtimes namespace them (`mcp__cmsis-developer-assistant__read_memory`);
> adapt as needed.

---

## Before anything else: know your target

Do not set a breakpoint before you know what you are attached to. Read, in this
order, and stop as soon as you have the device, core, ELF path and probe:

1. `<name>.csolution.yml` — contexts, packs, board.
2. `<name>.cbuild-idx.yml` — index of built contexts. **Start here** to find the
   active artifacts.
3. `out/<context>.cbuild.yml` — device, core, ELF path, defines.
4. `out/<context>.cbuild-run.yml` — GDB server, port, flash algorithms, reset
   sequences, **SVD path**.
5. `.vscode/launch.json` — the `type: gdbtarget` entry whose `name` you would
   pass as `configurationName`.

If those files are missing, build first (`cmsis_action` with `action='build'`).
It waits for cbuild and ends with ✅ or ❌ plus the exit code — read that line
rather than polling for output files. Pack resolution or a first build can
exceed a call's 60 s cap; the reply then says the call did not complete and
the build is still running — wait, then run `build` again for the real result.
Every tool that takes `timeoutMs` accepts up to 60000 ms for that one call.
If `launch.json` is stale, the user has to regenerate it: **CMSIS Solution →
Manage Solution → Debugger → Apply**. You cannot do that step for them.

`get_debug_instructions` with `topic: 'build'` returns the full version of this,
including the pack documentation notes; without `topic` it returns a short
overview and the list of topics (`session`, `build`, `breakpoints`,
`inspection`, `faults`, `troubleshooting`).

---

## Session state gates everything

Call `get_session_status` before any session-changing tool. It never hangs and
never throws.

| State | Correct next action |
|-------|---------------------|
| `no-session` | `cmsis_action load_and_debug` for CMSIS projects — builds, flashes, attaches. `start_debugging` only for non-CMSIS targets, or to attach without reflashing. |
| `initializing` | Wait, ask again. Do **not** issue a second start. |
| `stopped` | Inspect freely. |
| `running` | Reads will be rejected. `pause_execution`, or set a breakpoint and `continue_execution`. |
| `unresponsive` | `check_target_connection`, then `restart_debugging`. More reads will only time out. |

`start_debugging` and `cmsis_action load_and_debug` refuse when a session is
already live, so checking first saves a round trip.

## Debugger first — do not start by adding prints

Do not begin a runtime investigation by editing the firmware to add `printf`
over UART or ITM, LED toggles, trace macros, or other temporary instrumentation.
On a Cortex-M that costs a rebuild, a reflash and a reset cycle per hypothesis,
it moves code and data around, and it changes the timing of exactly the thing
you are trying to observe. Instead:

1. Invoke this skill.
2. Check `get_session_status`, then set a breakpoint and inspect the live state —
   variables, registers, memory, peripherals.
3. When a hot loop or an ISR must be observed without a halt per hit, remember
   that `add_logpoint` still stops the core briefly (see below); prefer
   `read_cycle_counter` around the region, or a RAM buffer the firmware fills
   and you read back with `read_memory`.
4. Add permanent logging only when observability itself is the requested change,
   not as a substitute for investigating the current bug.

If the debugger cannot be used — no probe, no `launch.json`, a board that does
not enumerate — say what the concrete blocker is before falling back to another
method.

---

---

## Core loop

1. **Breakpoint by line number.** `add_breakpoint` takes `line`. Use
   `condition` (e.g. `i == 100`, `p != 0`) rather than stopping 99 times —
   it becomes GDB's native `if`, so the core is not halted on every hit.
2. **Run and wait.** `continue_execution`, then `wait_for_stop` when you want an
   explicit bound. If the target never stops, the response tells you where the
   PC actually is rather than leaving you guessing.
3. **Look before you read.** `list_variable_names` shows what is in scope
   without reading values. On a slow probe that turns thirty reads into one.
4. **Read what you need.** `get_variables_values` (optionally with
   `variableNames`), `get_call_stack` then `get_frame_variables` to inspect a
   caller without disturbing the active frame.
5. **Cross-check against the hardware.** A variable and the peripheral can
   disagree — see below.

### Cortex-M breakpoint budget

Breakpoints in flash use the FPB comparators: commonly **6** on Cortex-M4/M7,
**4** on Cortex-M0+. Past that, breakpoints silently fail to bind or the
adapter reports an error. `clear_all_breakpoints` between hypotheses. In RAM,
software breakpoints are unlimited.

### Logpoints are not free here

`add_logpoint` prints and resumes rather than halting — but the core still stops
on every hit while GDB formats and prints. In an ISR or a hot loop that changes
the timing you are trying to measure. For those, prefer `read_cycle_counter`
around the region, or have the firmware fill a RAM buffer you read back with
`read_memory`.

GDB infers nothing about types, so `{expr}` defaults to `%d` and you write
`{expr:%s}` / `{expr:%f}` / `{expr:%p}` when it is not an integer.

---

## When the variable and the hardware disagree

This is the characteristic embedded bug, and the reason the memory tools exist.

- **Read the peripheral, not the shadow copy.** `read_peripheral_register` goes
  through the SVD, so ask for `GPIOA`/`ODR` by name. If the SVD is missing, the
  `cbuild-run.yml` says where it should be.
- **Read the address directly.** `read_memory` on the register address tells you
  what the bus sees. A mismatch against the C variable means the write never
  landed — wrong alias, missing `volatile`, or a peripheral clock that is off.
- **Check the clock first.** A peripheral whose clock gate is closed reads back
  zeros or retains defaults and silently ignores writes. This is the single most
  common "the peripheral is broken" cause.
- **Watch for caches and write buffers** on M7 and larger parts: what the core
  wrote may not be what DMA reads.

## When it faulted

`get_fault_info` decodes CFSR/HFSR/DFSR/MMFAR/BFAR bit by bit. Read it before
theorising — it usually names the fault class outright (`PRECISERR`,
`IACCVIOL`, `STKOF`, `UNALIGNED`).

Then: `read_core_registers` for the PC and the stack pointers, and
`get_call_stack` to walk up. On a stacked exception the interesting PC is in the
exception frame, not in the current registers.

`references/cmsis-embedded-guide.md` has the SCS memory map and the decode
recipes. `references/troubleshooting/embedded.md` covers probe-not-detected,
target-not-halted, SVD-missing and wrong-core-on-multicore.

## When it did not reach your breakpoint

`continue_execution` that times out already pauses the target and reports where
it actually is. Read that before adding more breakpoints — firmware sitting in a
polling loop, an ISR, or a fault handler all look the same from the outside and
the PC tells them apart immediately.

## When the firmware prints

`serial_open` takes the port directly; `serial_read` drains a buffered ring. If
the user has the MS Serial Monitor open on the same device, the OS will not give
you the tty — use `serial_subscribe_monitor` instead, which taps the extension
rather than the kernel.

---

## Several VS Code windows open

The MCP server runs in one window and forwards each call to the window that owns
the target. It resolves from a file path when a tool has one, otherwise from the
window that has an active debug session.

When two windows are debugging at once, it refuses to guess and asks you to
choose — reading the wrong board's memory looks exactly like a firmware bug.
`list_debug_windows` shows the candidates; `select_debug_window` pins one for
the rest of the session.

---

## Root cause, not symptom

The hardware makes it tempting to stop at the first thing that looks wrong.
It usually is not the cause. And it is tempting to add a `printf` rather than
halt — do not; inspect the live state first (see *Debugger first* above).

- "The value is 0" → *why* is it 0? Which write produced it, and did that write
  reach the hardware?
- "It faults in `memcpy`" → `memcpy` is fine. Where did the bad pointer come
  from, and which frame produced it?
- "It works with a delay" → a delay that fixes something is a race or an
  uninitialised peripheral, not a fix.

You have found the root cause when you can say which line produced the wrong
state, and predict what changing it will do. Verify that prediction on the
target before you claim it.

## Clean up

`clear_all_breakpoints` when you change hypotheses — the FPB budget is small and
stale breakpoints produce confusing stops. `stop_debugging` when done, so the
probe is released.
