# Troubleshooting C and C++ debug sessions

Notes for C and C++ programs on the host, through the C/C++ extension (`cppdbg`, with GDB or LLDB) or CodeLLDB, and for C/C++ firmware on Cortex-M through the CMSIS Debugger (`gdbtarget`: arm-none-eabi-gdb behind cdt-gdb-adapter). Probes, faults, peripherals and the memory map are covered in [embedded.md](embedded.md) (`cmsis-developer-assistant://docs/troubleshooting/embedded`) and [cmsis-embedded-guide.md](../cmsis-embedded-guide.md) (`cmsis-developer-assistant://docs/cmsis-embedded-guide`). Test each hypothesis at a stop rather than with a temporary `printf`: on firmware every print costs a rebuild, a reflash and different timing.

## Build for the debugger

- Compile with debug information (`-g`) and little optimisation (`-Og` or `-O0`). In a csolution the build-type carries both: `debug: on` and `optimize: debug` (or `none`).
- The session has to run what you just built: `stop_debugging`, `cmsis_action build`, then `cmsis_action load_and_debug` for firmware; start a host program again. A stale ELF or an unflashed board puts breakpoints and line numbers in the wrong places.
- `<optimized out>` means the variable has no home at this PC. Read it where it is computed or used, or rebuild with less optimisation.
- From `-O1` upwards, stepping jumps back and forth because the compiler interleaves the instructions of neighbouring lines and merges inlined functions into their callers. Follow the logic in a debug build; keep the optimised one for what only happens there.
- A defect that vanishes at `-O0` or under the debugger points to undefined behaviour (an uninitialised read, an out-of-bounds write, a missing `volatile`) or to timing.

## Starting a host program

- Start it from a `launch.json` entry that names the executable: `start_debugging` with `configurationName`. "Default Configuration" launches `cppdbg` with `program` set to the source path ending in `.exe` instead of `.c`, `.cc` or `.cpp`, which is rarely the program.
- `testName` does not filter C or C++ tests. Put the filter into the entry's `args` instead, such as `--gtest_filter=Parser.Empty` for GoogleTest.
- Firmware sessions start with `cmsis_action load_and_debug`, or with `start_debugging` and the `gdbtarget` entry to attach without flashing.

## Breakpoints that do not bind or never hit

- **No code on the line:** a declaration without initialiser, a comment, a lone brace, or code the optimiser removed. `evaluate_expression("-exec info line main.c:42")` reports where the line's code starts, or that it has none.
- **Different source paths:** the debug information records the paths of the build (a container, CI, another checkout), so a breakpoint on the workspace path matches nothing. Map them: `sourceFileMap` in a `cppdbg` entry, `set substitute-path <build-dir> <workspace-dir>` for GDB.
- **Another binary:** the session runs something other than the build of this source; see above.
- **Many copies:** a line in a header, an inline function or a template exists once per inlining or instantiation, so one breakpoint gets several locations and every copy stops. On Cortex-M each location takes one of the few FPB comparators. A template that is never instantiated has no code to stop in.
- **What GDB really set:** `-exec info breakpoints` lists each breakpoint with its address and hit count, `<PENDING>` when nothing matched and `<MULTIPLE>` with one sub-entry per location.
- On Cortex-M, breakpoints beyond the comparator budget do not bind; `get_debug_instructions` with topic `breakpoints` has the numbers.

## Expressions

`evaluate_expression` takes C or C++ as the debugger reads it, in the frame VS Code has in focus (normally the top frame of the stop):

- Members, elements, addresses: `cfg.mode`, `node->next->len`, `buf[7]`, `&buf[0]`, `sizeof(buf) / sizeof(buf[0])`.
- A raw address, or memory reinterpreted through a cast: `*(uint32_t *)0x20000100`, `((struct msg_hdr *)rx)->len`.
- Registers: `$pc` and `$sp` everywhere, `$lr` and `$r0` on 32-bit Arm, `$x0` on AArch64, `$rip` on x86-64.
- Hex: append `,x` (`status,x`); `cppdbg` and the CMSIS Debugger both accept it.
- Out of scope in GDB: `'uart.c'::rx_count` for a static in another file, `parse::depth` for a static inside a function. For a caller's locals, take its `frameId` from `get_call_stack` and call `get_frame_variables`.
- On GDB-based adapters a struct evaluates to `{...}` and an array to its length, like `[16]`. Ask for members and elements, or print the whole value: `-exec print cfg`, `-exec print/x *ptr@16` (16 elements behind `ptr`), `-exec x/16xb ptr` (raw bytes).
- Assignments, `++` and calls change the program: `crc(buf, 4)` executes `crc`, on firmware on the target itself. Keep inspection free of side effects unless the change is the experiment.
- On the CMSIS Debugger an expression GDB cannot evaluate comes back as `Error: could not evaluate expression`; `-exec print <expr>` reports GDB's own reason.

## Raw debugger commands

`evaluate_expression("-exec <command>")` hands a command to the debugger and returns what it prints.

- On the CMSIS Debugger the tool translates `-exec` into that adapter's own prefix, `>`; `>info breakpoints` is accepted there too. On `cppdbg`, `-exec` is the extension's own prefix: the command goes to GDB, or to LLDB when the entry sets `"MIMode": "lldb"` (then in LLDB syntax: `breakpoint list`, `register read`, `memory read`).
- CodeLLDB (`lldb`) takes console input as an LLDB command by default and prints command output only to the Debug Console. Put `?` in front of expressions there: `?count`, or `?/nat` for casts and function calls.
- Worth knowing: `-exec info breakpoints`, `-exec info line main.c:42`, `-exec x/8xw 0x20000000`, `-exec print/x flags`, `-exec ptype struct msg_hdr`, `-exec info frame`, `-exec disassemble /s`.
- Watchpoints and catchpoints have no tool: `-exec watch g_state` stops right after a store changes `g_state`, and `-exec catch throw` stops in `__cxa_throw` with the throwing function one frame up. Note the number GDB prints and remove it with `-exec delete <n>` when done, because `clear_all_breakpoints` does not know it. On Cortex-M a watchpoint takes one of the few DWT comparators.
- Leave everything else to the tools. Breakpoints belong to `add_breakpoint`, `remove_breakpoint` and `clear_all_breakpoints`: a GDB-only `-exec break` is invisible to them and duplicates what they manage. Run control belongs to `continue_execution` and the step tools, which wait for the stop; after a raw `-exec continue`, call `wait_for_stop`. Reset a target with `reset`, not with `-exec monitor reset`.

## Defects worth testing for

- **Uninitialised local:** stop on the function's first line and read the variable before its first assignment. In a debug build it often still holds the previous call's value, which looks plausible.
- **Out-of-bounds write:** a neighbour changes although no code writes it. `-exec watch neighbour` stops on the store that does; compare the index with `sizeof(buf) / sizeof(buf[0])` and `&buf[N]` with `&neighbour`.
- **Dangling pointer:** a pointer to a local of a function that has returned points into the stack below the current `$sp` (stacks grow downwards on Arm and x86). Memory behind a freed pointer changes under you; `-exec watch -l *p` stops at the store that changes it. On the host, a build with `-fsanitize=address` stops at the first invalid access.
- **Integer overflow and signed/unsigned mix-ups:** evaluate the sub-expressions in the program's own types. `len - 1` wraps to the maximum when an unsigned `len` is 0, `a * b` overflows in `int` before the result reaches a `long long`, and `-1 < sizeof(x)` is false. Plain `char` is unsigned with arm-none-eabi-gcc and signed on x86: evaluate `(int)c`.
- **Missing `volatile`:** a flag set by an interrupt handler or another thread reads 1 in `evaluate_expression`, yet the loop that polls it keeps spinning. `-exec disassemble` shows the load hoisted out of the loop, which only happens in optimised builds. ISR-shared data needs `volatile`; data shared between threads needs `_Atomic` or `std::atomic`.

## C++

- Name template instances and overloads in full: `Buffer<int>::size`; quote a name that contains parentheses, `'ns::parse(char const*)'`.
- In a member function the fields hang under `this` in the variable listing. Read them as `this->count`, or print the object with `-exec print *this`.
- Through a base-class pointer you see the static type. `-exec set print object on` followed by `-exec print *p` shows the dynamic type, and `-exec info vtbl p` its virtual table; `step_into` on a virtual call enters the override that really runs. `__cxa_pure_virtual` in `get_call_stack` means a virtual call from a constructor or destructor, or on a destroyed object.
- An uncaught exception ends in `std::terminate` and `abort`, with the throwing frame still on the stack; to see every throw, set the catchpoint described above.
- Static initialisation order: a global's constructor that reads a global from another file can find it still zero-filled. Break in the constructor: below it `get_call_stack` shows `__static_initialization_and_destruction_0` (GCC) or `__cxx_global_var_init` (Clang) and `_GLOBAL__sub_I_…`, and evaluating the other global shows whether it is built yet. On firmware these constructors run from the C library's start-up (`__libc_init_array` with GCC and newlib); start-up code that skips it leaves every global unconstructed.
- STL containers on the host: `-exec print v` prints the elements through the debugger's pretty-printers. `v[0]` in an expression can fail with "Cannot evaluate function -- may be inlined"; read the fields instead, `v._M_impl._M_start[0]` with libstdc++ or `v.__begin_[0]` with libc++.

## Conditions and logpoints

- A `condition` on `add_breakpoint` is a C expression for the debugger: `i == 100`, `p != 0 && p->len > 64`, `name[0] == 'e'`. Keep calls such as `strcmp` out of it; they run in the program at every hit.
- The debugger tests the condition after the program has stopped at the breakpoint and resumes it when the condition is false. The FPB of a Cortex-M has no condition logic, so the core halts on every hit, and in an ISR or a fast loop each of those halts costs milliseconds through the probe. On the host a busy conditional breakpoint slows the program the same way.
- `add_logpoint` prints to VS Code's Debug Console and lets the program run on. No tool returns that output: it serves a user who watches the console, and values you need yourself come from a conditional breakpoint and a read at the stop. `cppdbg` fills in `{expr}` placeholders itself; on the CMSIS Debugger the tool sets the logpoint as a GDB `dprintf`, which fills them in (`{expr:%08lx}` picks the printf conversion) and whose hits `list_breakpoints` counts. On Cortex-M each hit halts the core as well.

## Checklist

- [ ] The session runs a debug build (`-g`, `-Og` or `-O0`; `debug: on`, `optimize: debug`).
- [ ] Breakpoints on lines with code; `-exec info breakpoints` when one never stops.
- [ ] Aggregates read by member and element, or with `-exec print`.
- [ ] The wrong value traced to the store that wrote it, in the types the program uses.
- [ ] Watchpoints and catchpoints deleted by number; the breakpoints you set removed (`remove_breakpoint`) once the cause is confirmed.
