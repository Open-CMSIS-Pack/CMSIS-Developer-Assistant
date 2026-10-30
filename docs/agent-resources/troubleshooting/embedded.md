# Embedded Debugging Troubleshooting

## First-line diagnostic sweep

Whenever a tool call hangs, errors out, or returns an unexpected state, run this three-call sequence **before** retrying:

1. `get_session_status` — what state is the session in? (`no-session` / `initializing` / `running` / `stopped` / `unresponsive`)
2. `check_target_connection` — is the probe / GDB server actually responsive?
3. `diagnose_fault` — did the target crash? It needs a stopped target: pause first.

The session-status output includes a hint for each state. If state is `running` and you needed `stopped`, call `pause_execution`. If state is `unresponsive`, reads answer `PROBE_WEDGED`: see [Reads Fail With PROBE_WEDGED](#reads-fail-with-probe_wedged) before you restart anything.

## Common Issues

### Debug Session Won't Start

- The GDB server comes from the CMSIS Debugger extension; `cmsis_action load_and_debug` starts it.
- Check the probe with `check_target_connection` (or `get_session_status`); do not run `pyocd list` or `JLinkExe` yourself.
- Ensure the correct device is selected in the launch configuration
- Check if another debug session is already using the probe — if so, `cmsis_action load_and_debug` will refuse with a structured message naming the existing session
- For CMSIS projects, try the intended `cmsis_action` load/run/debug action: when CMSIS tasks are missing, the active `cbuild-run.yml` names a debugger, and `cmsis-csolution.autoDebugLaunch` is enabled, it regenerates the CMSIS tasks and launch configurations once. If that cannot apply or `launch.json` is still stale, follow the refusal's hint; the user may need to enable automatic generation or select the debugger in **Manage Solution → Debugger**.

### Target Doesn't Stop at main

- Verify `"break main"` is in `initCommands` in launch.json
- Some targets require a reset before the breakpoint is hit
- Check if the program was loaded correctly: `initCommands` should include `"load"`

### `continue_execution` Returned `running`

- No stop arrived within the wait, and the target keeps running: nothing was paused. Call `wait_for_stop` to wait longer, or `pause_execution` to halt it and read where the PC is
- A step that does not stop in time is different: the step tools pause the target, and the 🩹 Recovery section of the response tells you where the firmware actually was — read the PC and frame name first
- Common causes: the breakpoint wasn't hit (wrong line / inlined / optimized out), firmware is in a polling loop, or firmware sat in an ISR waiting for something that never arrived
- Check the breakpoint with `list_breakpoints`: it shows whether the debugger bound each one. A breakpoint that is NOT verified never triggers, and the adapter's reason says why (no code on the line, a path the ELF does not know, no free comparator)

### Too Many Breakpoints

- Cortex-M cores have a fixed number of hardware comparators (M0/M0+/M23: 4, M3/M4: 6, M7/M33/M55/M85: 8) — see the FPB unit in the device's TRM
- Exceeding the limit causes silent drop or unreliable bindings
- Defensive default: keep ≤4 simultaneous breakpoints unless you know the core has more
- Use `list_breakpoints` before adding; `remove_breakpoint` for the ones you set between investigation phases (`clear_all_breakpoints` deletes the user's too)

### Tool Call Hangs or Times Out

- Most debugging tools accept a `timeoutMs` override up to 60 s; `cmsis_action`, `flash`, documentation and build-artefact tools accept up to 600 s. Tools without that parameter use internal waits, and `restart_debugging` uses the configured session-readiness wait rather than its `timeoutMs` argument. A timeout ends the call's wait; it does not prove that background work stopped
- A `cmsis_action` whose task is still going answers with status `running` and a job id; that is no hang — call `cmsis_action {action:'status'}` for the result and do not start the action again
- Causes: probe disconnect, target reset in mid-flight, GDB server crash
- Run the first-line diagnostic sweep above; a wedged probe answers `PROBE_WEDGED` (next section)

### Reads Fail With PROBE_WEDGED

- The debug port stopped answering: the failed read and a read of DHCSR (0xE000EDF0), which works on every Cortex-M while the port does, both failed. The message keeps each read strategy's cause.
- Do not retry the read, and do not start a GDB server yourself; follow the hint of the error
- Attach session (`cmsis_action attach`): the GDB server lives as long as its CMSIS Run task (pyOCD `--persist`), so `cmsis_action detach`, then `cmsis_action attach` reconnects without a reset — pyOCD lets the target run while detached and halts it on attach; then `diagnose_fault`. If attach then fails with "could not connect", the server ended with its task (window closed or reloaded, `stop_run`): `cmsis_action run` in the window that owns the board starts it again, with a reset
- Launch session (`cmsis_action load_and_debug`): it owns the GDB server. `restart_debugging` and `load_and_debug` re-flash and reset, which clears the fault status: record the fault first. To keep it, the user restarts the server without a reset (J-Link `-nohalt -noreset`, pyOCD `-O connect_mode=attach`), then `cmsis_action attach`.
- `INVALID_ARGUMENT` "the debug port answers" is different: only that address is unreadable (peripheral clock off, MPU or TrustZone, nothing mapped)

### `reset` Says the Target Did NOT Reset

- Trust the verification, not the command echo: the PC is not at the reset vector.
- `stop_debugging`, then `cmsis_action load_and_debug` — a fresh connect and reset. This is the fallback on J-Link and on secure-boot parts (Alif Ensemble), where nSRST alone does not re-vector the core.
- Only if that fails: power-cycle the board or reconnect the probe.

### HardFault on Startup

- Call `diagnose_fault` to decode the fault registers and the stacked frame
- Common cause: missing or incorrect vector table (check VTOR at 0xE000ED08)
- Check if the stack pointer is initialized correctly (first word of vector table)
- Verify the reset handler address (second word of vector table)

### Variables Show "optimized out"

- The compiler optimized the variable away. Rebuild without optimization (`-O0` or `-Og`)
- For CMSIS projects the build-type in `<name>.csolution.yml` (or the `.cproject.yml`) sets it: `optimize: debug` (or `none`) and `debug: on`

### Memory Read Returns All 0xFF or 0x00

- The memory region may not be mapped or powered
- Check if the peripheral clock is enabled (read RCC enable registers)
- Verify the address is correct for your specific device variant

### Stepping Doesn't Work / Steps to Wrong Line

- This can happen with optimized code — rebuild with `-O0 -g3` (CMSIS build-type: `optimize: debug`, `debug: on`)
- For inline functions, the debugger may jump between files unexpectedly
- Try `step_into` instead of `step_over` to see what's actually executing

### GDB Expressions for Embedded

- Read a memory-mapped register: `*(volatile unsigned int*)0x40020014`
- Read program counter: `$pc`
- Read stack pointer: `$sp`
- Read link register: `$lr`
- Exception frame: `read_memory` 32 bytes at the stack pointer `EXC_RETURN` in LR names (bit 2 set: `$psp`, clear: `$msp`), R0,R1,R2,R3,R12,LR,PC,xPSR; `diagnose_fault` decodes it, TrustZone's banked stacks and the integrity signature included
- Disassembly around PC: `evaluate_expression {expression: "-exec x/8i $pc"}` returns GDB's output. On the CMSIS Debugger the tool translates `-exec` to the adapter's `>` prefix; `>x/8i $pc` works too. `lookup_symbol` names the function at the PC

### Multi-Core Debugging (Alif AppKit)

- The Alif AppKit has dual Cortex-M55 cores (HP + HE)
- Each core gets a separate debug session
- The tools act on the active session; `get_session_status` names it, and the user switches cores in VS Code's debug session picker
- With several VS Code windows, `list_debug_windows` and `select_debug_window` choose the window, not the core

## Fault Analysis Quick Reference

| Fault Bit | Register | Meaning |
|---|---|---|
| FORCED | HFSR | Fault escalated to HardFault — check CFSR |
| DACCVIOL | MMFSR | Data access violation (null ptr, MPU) |
| IACCVIOL | MMFSR | Instruction access violation |
| PRECISERR | BFSR | Precise bus error — check BFAR for address |
| IMPRECISERR | BFSR | Imprecise bus error (buffered write) |
| UNDEFINSTR | UFSR | Undefined instruction |
| INVSTATE | UFSR | Invalid EPSR.T bit (tried ARM mode) |
| NOCP | UFSR | Coprocessor not enabled (FPU?) |
| DIVBYZERO | UFSR | Division by zero |
| UNALIGNED | UFSR | Unaligned access |
