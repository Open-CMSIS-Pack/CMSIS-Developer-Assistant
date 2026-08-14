# Embedded Debugging Troubleshooting

## First-line diagnostic sweep

Whenever a tool call hangs, errors out, or returns an unexpected state, run this three-call sequence **before** retrying:

1. `get_session_status` — what state is the session in? (`no-session` / `initializing` / `running` / `stopped` / `unresponsive`)
2. `check_target_connection` — is the probe / GDB server actually responsive?
3. `get_fault_info` — did the target crash?

The session-status output includes a hint for each state. If state is `running` and you needed `stopped`, call `pause_execution`. If state is `unresponsive`, call `restart_debugging` or stop and start again.

## Common Issues

### Debug Session Won't Start
- Verify the GDB server (pyOCD or J-Link) is installed and on PATH
- Check that the debug probe is connected and detected (`pyocd list` or `JLinkExe`)
- Ensure the correct device is selected in the launch configuration
- Check if another debug session is already using the probe — if so, `cmsis_action load_and_debug` will refuse with a structured message naming the existing session
- For CMSIS projects: `launch.json` should have a `gdbtarget` entry produced by the **Manage Solution → Debugger** dialog. If missing, ask the user to (re)generate it there.

### Target Doesn't Stop at main
- Verify `"break main"` is in `initCommands` in launch.json
- Some targets require a reset before the breakpoint is hit
- Check if the program was loaded correctly: `initCommands` should include `"load"`

### `continue_execution` Timed Out
- The 🩹 Recovery section of the response tells you where the firmware actually was — read the PC and frame name first
- Common causes: the breakpoint wasn't hit (wrong line / inlined / optimized out), firmware is in a polling loop, or firmware sat in an ISR waiting for something that never arrived
- Verify the breakpoint location with `list_breakpoints` after the next stop; on Flash-resident code, an "unbound" hardware breakpoint silently never triggers

### Too Many Breakpoints
- Cortex-M cores have a fixed number of hardware comparators (M0/M0+/M23: 4, M3/M4: 6, M7/M33/M55/M85: 8) — see the FPB unit in the device's TRM
- Exceeding the limit causes silent drop or unreliable bindings
- Defensive default: keep ≤4 simultaneous breakpoints unless you know the core has more
- Use `list_breakpoints` before adding; `clear_all_breakpoints` between investigation phases

### Tool Call Hangs or Times Out
- The server caps every call to 60 s; if you hit the cap, the response includes a structured "handler-level cap" message — the underlying request was abandoned, not actually stuck
- Causes: probe disconnect, target reset in mid-flight, GDB server crash
- Run the first-line diagnostic sweep above; `restart_debugging` if probe is wedged

### HardFault on Startup
- Call `get_fault_info` to decode the fault registers
- Common cause: missing or incorrect vector table (check VTOR at 0xE000ED08)
- Check if the stack pointer is initialized correctly (first word of vector table)
- Verify the reset handler address (second word of vector table)

### Variables Show "optimized out"
- The compiler optimized the variable away. Rebuild with `-O0` (no optimization)
- For CMSIS projects, set optimization in the `.cproject` or `csolution.yml`

### Memory Read Returns All 0xFF or 0x00
- The memory region may not be mapped or powered
- Check if the peripheral clock is enabled (read RCC enable registers)
- Verify the address is correct for your specific device variant

### Stepping Doesn't Work / Steps to Wrong Line
- This can happen with optimized code — rebuild with `-O0 -g3`
- For inline functions, the debugger may jump between files unexpectedly
- Try `step_into` instead of `step_over` to see what's actually executing

### GDB Expressions for Embedded
- Read a memory-mapped register: `*(volatile unsigned int*)0x40020014`
- Read program counter: `$pc`
- Read stack pointer: `$sp`
- Read link register: `$lr`
- Disassemble around PC: `-exec disassemble $pc-16,$pc+16`
- Show exception frame: `-exec x/8xw $sp` (R0,R1,R2,R3,R12,LR,PC,xPSR)

### Multi-Core Debugging (Alif AppKit)
- The Alif AppKit has dual Cortex-M55 cores (HP + HE)
- Each core gets a separate debug session
- Use VS Code's debug session picker to switch between cores
- The active tools operate on whichever session is currently selected

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
