# CMSIS Embedded Debugging Guide

## Debugging Workflow for Cortex-M Targets

### Starting a Debug Session

**For CMSIS projects (preferred):** call `cmsis_action` with `action="load_and_debug"`. This is the same flow as the **Debug** button in the CMSIS Solution panel — it builds (if needed), flashes the target, and attaches in one step, on the target-type / target-set the panel has selected. The reply names that target (`… on HP@debug`); on a multi-target solution pass `target` to select it — a differing target is switched and verified first, an undeclared one is refused with the declared list.

```text
cmsis_action {"action": "load_and_debug", "timeoutMs": 45000}
cmsis_action {"action": "load_and_debug", "target": "HP@debug"}
```

**Pre-check first**: call `get_session_status`. If a session is already active, both `cmsis_action load_and_debug` and `cmsis_action attach` refuse. Inspect or continue that session, use `restart_debugging` when a restart is intended, or `stop_debugging` before starting another. `attach` connects to a GDB server when there is no active debug session.

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

- After a fault, the stacked PC shows the faulting instruction: at SP+24 in the basic and the FP-extended frame alike (the FP registers follow xPSR), at SP+64 when TrustZone stacked the integrity signature and R4–R11 first (EXC_RETURN bit 6 set, bit 0 or bit 5 clear)
- Core registers: `read_core_registers`, or GDB's own listing with `evaluate_expression("-exec info registers")`. Every GDB command needs that `-exec` prefix; a bare `info registers` is evaluated as a C expression and fails
- For RTOS-aware debugging: `get_threads` enumerates FreeRTOS / RTX / ThreadX tasks (when the GDB server has an RTOS plugin); pass any thread's id to `get_call_stack` to inspect a specific task
- `read_memory` at the stack pointer shows the exception frame: R0,R1,R2,R3,R12,LR,PC,xPSR, 40 bytes higher in that TrustZone case

### Timeout strategy

Use `timeoutMs` where the tool schema exposes it: most debugging tools accept up to 60 s; `cmsis_action`, `flash`, documentation and build-artefact tools accept up to 600 s. Breakpoint tools and `stop_debugging` use internal waits; `restart_debugging` uses the configured session-readiness wait rather than its `timeoutMs` argument. A CMSIS job still running at the end of a call's wait answers with status `running`: call `cmsis_action {action:'status'}`, never start it again to learn its status. Estimate the wait from the work: a memory or register read depends on probe speed, and `continue_execution` depends on when a breakpoint is reached. Omit `timeoutMs` to use the tool's default.

When a `step_*` does not stop in time, the server tries a recovery pause and reports the location if the target stops. Read the 🩹 Recovery section of the response. On an Arm FVP this recovery pause is skipped because the running model ignores it; a breakpoint must stop the model. A `continue_execution` whose wait runs out leaves the target running and answers `running`; follow the reply's next step (`wait_for_stop`, or `pause_execution` on a target that supports it).

### Available Tools (Cortex-M focus)

| Tool | Description |
|---|---|
| `cmsis_action` | ⭐ Drive the CMSIS Solution panel buttons (build/load/erase/load_and_debug/attach/…) |
| `get_session_status` | 5-state classifier (no-session/initializing/running/stopped/unresponsive) |
| `check_target_connection` | Fast DAP `threads` liveness probe; on a stopped target also reads DHCSR: does the core answer, halted, in lockup |
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
