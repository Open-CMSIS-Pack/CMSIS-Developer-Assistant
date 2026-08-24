# CMSIS Embedded Debugging Guide

## Debugging Workflow for Cortex-M Targets

### Starting a Debug Session

**For CMSIS projects (preferred):** call `cmsis_action` with `action="load_and_debug"`. This is the same flow as the **Debug** button in the CMSIS Solution panel — it builds (if needed), flashes the target, and attaches in one step, using the configuration the user selected via *Manage Solution → Debugger*.

```text
cmsis_action {"action": "load_and_debug", "timeoutMs": 45000}
```

**Pre-check first**: call `get_session_status`. If a session is already active, `cmsis_action load_and_debug` will refuse — use `restart_debugging` or `cmsis_action attach` instead.

**For non-CMSIS / direct gdbtarget configs:** `start_debugging` with `configurationName` matching the launch.json entry (e.g. "CMSIS Debugger: pyOCD", "CMSIS Debugger: J-LINK").

Wait for the session to stop at `main` (the default initCommand sets `break main`). After attach, call `get_device_info` to confirm the live session matches what the YAMLs say.

### Pause and Inspect a Running Target

If the firmware is in a free run and you need to know where it is:

1. `pause_execution` — DAP pause, halts the CPU without ending the session.
2. `get_call_stack` — full frames with `frameId` per entry.
3. `read_core_registers` for PC / LR / SP, then `get_frame_variables` for a specific frame.
4. `continue_execution` to resume — or set a breakpoint at the location of interest and continue.

### When the Target Hits a HardFault

1. Call `diagnose_fault` for the whole first pass (or `get_fault_info` for the decoded registers alone).
2. Check the call stack with `get_call_stack` to find where the fault occurred. Capture a `frameId` of interest.
3. `get_frame_variables` at that `frameId` to see locals at the fault site.
4. Common causes:
   - DACCVIOL/IACCVIOL: Null pointer dereference or MPU violation
   - PRECISERR with BFARVALID: Read/write to invalid peripheral address (check BFAR)
   - UNDEFINSTR: Corrupted function pointer or stack overflow overwrote code
   - NOCP: FPU instruction but FPU not enabled (check CPACR at 0xE000ED88)
   - DIVBYZERO: Only faults if DIV_0_TRP is set in CCR (0xE000ED14)

### Inspecting Peripheral State

- Use `read_peripheral_register` with the peripheral name (e.g., "GPIOA")
- Peripheral names come from the SVD file; common ones: GPIOx, UART, SPI, I2C, TIM, RCC, NVIC
- To check if a clock is enabled: read RCC registers (RCC.AHBxENR, RCC.APBxENR)
- To check interrupt configuration: read NVIC registers (NVIC.ISER, NVIC.ISPR, NVIC.IPR)

### Memory Layout (Cortex-M typical)

- 0x00000000 - 0x1FFFFFFF: Code (Flash)
- 0x20000000 - 0x3FFFFFFF: SRAM
- 0x40000000 - 0x5FFFFFFF: Peripheral registers
- 0xE0000000 - 0xE00FFFFF: System (SCS, NVIC, SysTick, MPU, FPU)

### Key System Registers

- VTOR (0xE000ED08): Vector Table Offset Register
- AIRCR (0xE000ED0C): Application Interrupt and Reset Control
- SCR (0xE000ED10): System Control Register
- CCR (0xE000ED14): Configuration and Control Register
- CPACR (0xE000ED88): Coprocessor Access Control (FPU enable)
- ICSR (0xE000ED04): Interrupt Control and State Register
- SHCSR (0xE000ED24): System Handler Control and State Register

### Stack Overflow Detection

1. Read MSP and PSP with `read_core_registers`
2. Compare against known stack boundaries (from linker script / .map file)
3. If SP is outside the valid stack region, stack overflow occurred
4. Check if stack canary value at bottom of stack is corrupted

### Debugging Tips

- After a fault, the stacked PC (at SP+24 for basic frame, SP+104 for FP frame) shows the faulting instruction
- Use `evaluate_expression` with GDB commands: e.g., `info registers`
- For RTOS-aware debugging: `get_threads` enumerates FreeRTOS / RTX / ThreadX tasks (when the GDB server has an RTOS plugin); pass any thread's id to `get_call_stack` to inspect a specific task
- `read_memory` at the stack pointer shows the exception frame: R0,R1,R2,R3,R12,LR,PC,xPSR

### Timeout strategy

Every hardware-touching tool accepts `timeoutMs` (capped to 60 s). Estimate before you call: a `read_core_registers` is ~5–15 s, a single `read_memory` (≤4 KB) is ~1–5 s, `continue_execution` until a known breakpoint is the wild card. If you don't supply `timeoutMs` the server picks a sensible default.

When `continue_execution` or `step_*` times out, the server **auto-heals**: it pauses the target, reads the PC, and tells you where the firmware actually was. Read the 🩹 Recovery section of the response — you may not have set the breakpoint you thought you did.

### Available Tools (Cortex-M focus)

| Tool | Description |
|---|---|
| `cmsis_action` | ⭐ Drive the CMSIS Solution panel buttons (build/load/erase/load_and_debug/attach/…) |
| `get_session_status` | 5-state classifier (no-session/initializing/running/stopped/unresponsive) |
| `check_target_connection` | Fast DAP `threads` liveness probe |
| `pause_execution` | DAP pause — halt a running target without ending the session |
| `read_memory` | Read a range of bytes from target memory (hex/ASCII dump) |
| `read_core_registers` | Read all Cortex-M core registers (R0–R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK) |
| `read_peripheral_register` | Read peripheral registers via SVD data or memory fallback |
| `get_fault_info` | Decode CFSR/HFSR/BFAR/MMFAR/DFSR/AFSR |
| `diagnose_fault` | One-call triage: fault registers, stacked frame, top frames, resolved address, hypotheses |
| `lookup_peripheral` / `lookup_register` | SVD queries without a session or target access: register map, address → register, bit fields |
| `get_device_info` | Debug session info (target, GDB server, program, cbuild-run reference) |
| `get_call_stack` | Full DAP stackTrace with frame IDs |
| `get_threads` | DAP threads / RTOS tasks |
| `get_frame_variables` | Variables at a specific frame ID (walk the stack without changing the active editor frame) |
