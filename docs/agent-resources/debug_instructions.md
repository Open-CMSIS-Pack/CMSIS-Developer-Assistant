# CMSIS Developer Assistant - Debugging Instructions Guide

⚠️  **CRITICAL INSTRUCTIONS - FOLLOW THESE STEPS:**

0. **FIRST OF ALL:** Establish target awareness — read the project's CMSIS YAMLs and `launch.json` (see "PHASE 0" below). Without this you will guess at addresses, peripheral names and the wrong launch configuration.
1. **THEN:** Call `get_session_status` to check whether a debug session is already running. Branch on the result (see "PHASE 1" below) — never blindly call `start_debugging`, it will refuse if a session is already active.
2. **THEN:** Use `add_breakpoint` to set an initial breakpoint at a starting point.
3. **THEN:** Optionally use `add_breakpoint` to set breakpoints at strategic points.
4. **THEN:** Bring up the target only when `get_session_status` returned `no-session`:
   - **CMSIS / Cortex-M solutions:** use `cmsis_action` with `action="load_and_debug"`. This is the same flow as clicking the **Debug** button in the CMSIS Solution panel — it builds (if needed), flashes the device, and attaches the debugger using the configuration the user picked in **Manage Solution → Debugger**. **Do not use `start_debugging` for CMSIS projects** — it bypasses the flash step and uses whichever debug-tab config happens to be selected.
   - **Non-CMSIS projects** (Python, Java, JS/TS, etc.): use `start_debugging` with `configurationName` from `launch.json`.
   - **Already-flashed CMSIS target, just want to attach:** use `cmsis_action` with `action="attach"` (skips programming).
5. **THEN:** Use repetitively all the other tools to navigate and inspect step by step.
6. **FINALLY:** Get to the problematic line to fully understand the root cause. If needed, restart the debug session using `restart_debugging`.

## 🔎 PHASE 1 — SESSION STATUS GATE

Always call `get_session_status` *before* any session-changing tool. The five possible states each have a different correct next action:

| State | What it means | Correct next action |
| ----- | ------------- | ------------------- |
| `no-session` | No debug session is attached. | **CMSIS solutions: always use `cmsis_action load_and_debug`** (flashes then attaches via the CMSIS Solution panel — same as clicking the panel's *Debug* button). Use `start_debugging` ONLY for non-CMSIS targets (Python, Java, JS, etc.) or when you specifically need to attach without flashing. |
| `initializing` | The adapter is starting / flashing. | Wait briefly and call `get_session_status` again — do NOT issue another start. |
| `stopped` | A session is attached and the target is paused. | Skip `start_debugging` entirely. Use inspection tools (`get_call_stack`, `get_variables_values`, `read_memory`, …) directly, or `continue_execution` to resume. |
| `running` | A session is attached and the CPU is executing. | Inspection reads will be rejected. Call `pause_execution`, set/hit a breakpoint, or call `stop_debugging` first depending on intent. |
| `unresponsive` | The probe / GDB server is hung. | Call `check_target_connection` to confirm, then `restart_debugging` or `stop_debugging`. Do NOT issue more inspection calls — they will time out. |

`start_debugging` and `cmsis_action load_and_debug` will refuse with a structured error if a session is already active, naming the existing session and pointing you at `restart_debugging` / `stop_debugging`. Save the round-trip by checking up front.

## 🛰️ PHASE 0 — TARGET AWARENESS (do this *before* any breakpoint or debug call)

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

After `start_debugging` (or `cmsis_action load_and_debug`), call `get_device_info` once to confirm the live session matches what the YAMLs said: program path, GDB server, port, `cbuildRunFile` reference. A mismatch means the user picked a different `configurationName` than the one you analysed.

### Quick checklist

- [ ] Found `<name>.cbuild-idx.yml` and identified the active context.
- [ ] Read the matching `<context>.cbuild.yml` — know the device, core, ELF path.
- [ ] Read the matching `<context>.cbuild-run.yml` — know the probe, port, SVD.
- [ ] Confirmed `launch.json` has a `gdbtarget` entry whose name to pass to `start_debugging`.
- [ ] Skimmed any pack documentation linked from the CMSIS dialog.
- [ ] (After attaching) `get_device_info` matches expectations.

## 🚨 ROOT CAUSE ANALYSIS - CRITICAL FRAMEWORK

### **NEVER STOP AT SYMPTOMS - ALWAYS FIND THE ROOT CAUSE**

When you encounter an issue during debugging (e.g., null variable, unexpected value, error), you MUST apply this systematic approach:

#### **SYMPTOM vs ROOT CAUSE - Key Distinction:**

- **SYMPTOM:** What you observe is wrong (e.g., "variable X is null")  
- **ROOT CAUSE:** WHY the symptom occurred (e.g., "variable X is null because function Y failed to initialize it due to missing parameter Z")

#### **ROOT CAUSE INVESTIGATION PROCESS:**

1. **IDENTIFY THE SYMPTOM**
   - What exactly is wrong? (null value, wrong type, unexpected behavior)
   - Record the current line and variable state

2. **ASK THE CRITICAL QUESTION: "WHY?" e.g**
   - Why is this variable null/undefined/wrong?
   - Why did this function return an unexpected value?
   - Why did this condition evaluate incorrectly?

3. **TRACE BACKWARDS TO THE SOURCE**
   - Set breakpoint at the problematic point
   - Restart the session to step in it.

4. **CONTINUE UNTIL YOU FIND THE ORIGIN**
   - Keep asking "why" until you reach the original source of the problem
   - The root cause is typically where data enters the system incorrectly or where a fundamental assumption is violated

#### **⚠️ WARNING SIGNS YOU'RE STOPPING TOO EARLY:**

- You found a null/undefined variable but didn't check why it's null
- You see an error but didn't trace where the error originates
- You identify "bad data" but didn't find why the data is bad
- You found a failed condition but didn't check why it fails

#### **✅ SIGNS YOU'VE FOUND THE ROOT CAUSE:**

- You can explain the COMPLETE chain from root cause to symptom
- Fixing this issue would prevent the symptom from occurring
- The issue is at a fundamental level (data input, configuration, logic error)
- You understand not just WHAT is wrong, but WHY it's wrong

### **🔍 PRACTICAL EXAMPLES - SYMPTOM vs ROOT CAUSE**

#### **Example 1: Null Variable**

❌ **STOPPING AT SYMPTOM:** "The user object is null on line 45"  
✅ **FINDING ROOT CAUSE:** "The user object is null because the getUserById() function returned null, which happened because the database query failed due to an incorrect connection string in the configuration file"

**Investigation Steps:**

1. Found user object is null → Set breakpoint in getUserById()
2. Found getUserById() returns null → Set breakpoint inside the function
3. Found database query fails → Check connection parameters
4. Found incorrect connection string → ROOT CAUSE IDENTIFIED

#### **Example 2: Function Exits Early**

❌ **STOPPING AT SYMPTOM:** "The processOrder() function exits early due to invalid payment status"  
✅ **FINDING ROOT CAUSE:** "The processOrder() function exits early because the payment validation fails when the payment service doesn't receive the required 'currency' field, which wasn't included in the request due to a missing form field in the UI"

**Investigation Steps:**

1. Function exits early → Set breakpoint at validation check
2. Payment status is invalid → Debug payment validation logic
3. Currency field is missing → Trace back to request formation
4. UI form missing currency field → ROOT CAUSE IDENTIFIED

#### **Example 3: Unexpected Value**

❌ **STOPPING AT SYMPTOM:** "The calculation result is NaN"  
✅ **FINDING ROOT CAUSE:** "The calculation result is NaN because one of the input parameters contains a string instead of a number, which occurs because the parseFloat() conversion fails when the input data contains currency symbols that weren't stripped by the data sanitization function"

**Investigation Steps:**

1. Result is NaN → Check input parameters
2. Parameter contains string → Find where conversion should happen
3. parseFloat() fails → Check what's being parsed
4. Currency symbols not stripped → ROOT CAUSE IDENTIFIED

#### **🎯 ROOT CAUSE INVESTIGATION CHECKLIST**

Before stopping your debug session, ensure you can answer:

- [ ] What is the immediate symptom?
- [ ] What function/code caused this symptom?
- [ ] What input/condition caused that function to behave incorrectly?
- [ ] Where did that incorrect input/condition originate?
- [ ] Can I trace this back further to a more fundamental cause?
- [ ] If I fix this root cause, will it prevent the symptom from occurring?

## 📋 DETAILED INSTRUCTIONS

- **Before debugging:** Set at least one breakpoint in a starting point of the code. Optionally add more breakpoints in points you found as strategic points.
- **Start debugging:** Launch the debug session with proper configuration (the program will immediately start on the first breakpoint)
- **During debugging:**
  - **Navigate:** Use stepping commands and continue command to move through code execution
  - **Inspect:** Check variables and evaluate expressions when needed
- **Root Cause Investigation:** If you encounter any issue - DON'T SPECULATE! Apply the systematic root cause analysis:
    1. Identify if what you found is a symptom or root cause
    2. If it's a symptom, set breakpoints to trace backwards to the source
    3. Restart the debug session to investigate the deeper cause
    4. Continue until you find the root cause

## Breakpoint Strategy Guide

🎯 **BREAKPOINT STRATEGY:**

- **Pass `line` (1-based), not `lineContent`.** `lineContent` is deprecated: it substring-matches and sets a breakpoint on *every* line containing the text. In C that routinely means dozens of lines — `}`, `return;`, `break;` — and it will exhaust the FPB comparators (see below) before you notice.
- Set breakpoints inside the function body and not on the signature or definition line itself (e.g "def" in python)
- Place breakpoints only on executable lines (avoid comments, empty lines)
- Set breakpoints before loops or conditionals  
- Set breakpoints at variable assignments you want to inspect
- Set breakpoints at error-prone areas
- Set breakpoints at the start of functions to inspect parameters
- Set breakpoints before and after critical operations

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

Software breakpoints (which Flash patches without a comparator) are *not* an option on Flash for most Cortex-M targets — only RAM-resident code can use them, which is rarely the case here.

## ⏱️ Embedded execution control: wait_for_stop, reset, cycle timing

**Never sleep blind waiting for a stop.** After `continue_execution` returned while the target was still running (timeout), or after issuing execution through `evaluate_expression` (`-exec continue`), call `wait_for_stop` — it blocks on the raw DAP `stopped` event and returns the stop reason + state, or a structured timeout. It returns immediately if the target is already stopped, and it issues no execution commands itself.

**`reset` vs `restart_debugging`.** `restart_debugging` restarts the whole VS Code session (re-launch, breakpoints re-bound). `reset` resets only the target *inside* the live session — the session and breakpoints survive — and verifies the outcome: after the reset-halt the PC must equal the reset vector, or the tool says the target did NOT appear to reset. Trust the verification, not the command echo. Methods: `auto` (escalates `system` → `core` → `hardware`), `system` (SYSRESETREQ), `core` (VECTRESET), `hardware` (nSRST — only works when the reset line is wired from probe to target; if it isn't, no software reset can recover a wedge — power-cycle).

**Cycle-accurate timing with `read_cycle_counter`.** Read the DWT cycle counter at point A, run to point B (`continue_execution` / `wait_for_stop`), read again, subtract mod 2^32. Caveats that bite: the 32-bit counter wraps (~10.7 s @ 400 MHz — accumulate over longer spans), and CYCCNT **stops while the core is halted and during WFE sleep** — it counts ACTIVE cycles only, so a delta excludes halted debug time and sleep.

## 🔬 Inspecting variables: discover, then read

`list_variable_names` reports what is in scope by **name and type only**, reading no values. `get_variables_values` then reads them — pass `variableNames` to fetch just what you need, or omit it to dump the whole scope.

- On a **slow probe or a large frame**, discover first and then request two names instead of thirty. That is one round trip instead of thirty.
- On a small frame, omitting `variableNames` is fine and usually what you want — embedded frames are small.
- Names that match nothing are reported back explicitly, so a typo does not look like "the variable does not exist".
- To inspect a **caller's** frame without disturbing the active one: `get_call_stack` → take a `frameId` → `get_frame_variables`.

### Secret redaction

Values whose name or content looks like a credential are withheld before leaving the extension (`<redacted: possible secret>`), controlled by `cmsis-developer-assistant.redactSecrets` (default on).

This is tuned for firmware and should rarely get in your way:

- **Numeric scalars are never withheld** — a `uint8_t auth`, a `token` counter, or `0xDEADBEEF` stays readable whatever it is called.
- **Raw target reads are never redacted**: `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`, and `-exec` GDB passthrough through `evaluate_expression`. Real SVDs name registers `KEY`, `KR`, `KEYR` and `UNLOCK` — the watchdog and flash unlock registers — and those are exactly what you need when the watchdog is resetting you.

## 🪟 Several VS Code windows open

The MCP server runs in one window (the router) and forwards each call to the window that owns the target. It resolves from a file path when the tool has one, otherwise from the window that has an active debug session.

When **two windows are debugging at once** it refuses to guess and names both — reading the wrong board's memory looks exactly like a firmware bug and costs far more than being asked to pick. Use `list_debug_windows` to see the candidates and `select_debug_window({ pid })` to pin one for the rest of the session.

## Common Patterns

❌ **COMMON MISTAKE:** Starting debugging without breakpoints
✅ **BEST PRACTICE:** Always set an initial breakpoint before starting debugging
❌ **COMMON MISTAKE:** Set breakpoint in a method signature/definition line like 'def func()'
✅ **BEST PRACTICE:** Set breakpoint in the method body
❌ **COMMON MISTAKE:** Set breakpoint on commented line e.g '//', '#' and ect.
✅ **BEST PRACTICE:** Set breakpoint only on executable lines.
❌ **COMMON MISTAKE:** Step over the problematic line without fully understanding why the issue occured.
✅ **BEST PRACTICE:** Stop the session, set breakpoint in the problematic line and restart the session.
❌ **COMMON MISTAKE:** Locating a breakpoint with `lineContent` — it matches every line containing that text.
✅ **BEST PRACTICE:** Pass the 1-based `line` number.
❌ **COMMON MISTAKE:** Hitting a breakpoint 500 times to reach one iteration.
✅ **BEST PRACTICE:** Pass `condition` so GDB only halts the core when it holds.
❌ **COMMON MISTAKE:** Dumping every variable in a large frame over a slow probe.
✅ **BEST PRACTICE:** `list_variable_names` first, then `get_variables_values` with `variableNames`.

## 🧹 CLEANUP AFTER ROOT CAUSE VERIFICATION

Once you have:

- ✅ Identified the ROOT CAUSE (not just the symptom)
- ✅ Verified your understanding by tracing the complete chain
- ✅ Confirmed the fix addresses the root cause

Use clean all breakpoints before concluding your debugging session. This ensures a clean slate for the next debugging task.
