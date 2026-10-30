# corstone-blinky — evaluation fixture

The `Blinky` example from `ARM::V2M_MPS3_SSE_300_BSP@1.5.0` (Apache-2.0, Arm Limited),
vendored so an agent evaluation run has a known, small csolution that builds for the
Corstone-300 FVP (`FVP_Corstone_SSE-300_Ethos-U55`, Cortex-M55) and can be opened in a
VS Code window with the CMSIS Developer Assistant.

What was changed against the pack example:

- `Blinky.csolution.yml`: a `target-set` with `debugger: name: Arm-FVP` pointing at
  `.vscode/fvp.sh`, so the CMSIS Solution extension's Run/Debug buttons drive the model
  through its built-in GDBServer plugin (MDK FVP models 11.32.23+).
- `.vscode/fvp.sh` / `.vscode/fvp.Dockerfile`: the model shim — resolves
  `plugins/GDBServer.so` when `$AVH_FVP_PLUGINS` is unset, line-buffers the model's
  stdout so the readiness banner is seen, and on macOS runs the model in Docker with the
  GDB port forwarded. There it refuses a GDB port that another folder's model (container
  label `cmsis.fvp.folder`) or any other program listens on — GDB would otherwise reach
  that server, a board's pyOCD for instance, and halt it — and removes only its own
  leftover container. The container runs in the background with `--sig-proxy=false`: the
  adapter's stop becomes one `docker rm -f`, and the container also goes when the adapter
  disappears without a signal. `fvp_config.txt`: headless, UART0 to stdout.
- `overlays/<scenario>/`: one planted bug per scenario, copied over the base by the
  runner. The base itself is bug-free; the agent never sees the overlay mechanism.
  `overlays/flash-image-missing/` plants a cbuild-run file whose image does not exist,
  so that `flash` fails; `.gitignore` lets that one cbuild-run file in.
- The pack's `Makefile` is dropped.

- `.vscode/launch.json` ships ready for the model: the `Arm-FVP@GDB (launch)` config has
  `"port": ""`, `"serverPortRegExp": "GDBServer: Listening .*port=([0-9]+)"` and
  `"portDetectionTimeout": 300000`, so the debug adapter waits for the GDB server's banner
  instead of connecting before the model listens (it then fails with "Connection reset by
  peer"), and both configs say `"updateConfiguration": "manual"`, so CMSIS Solution keeps
  them. `../verify-launch.py` replays the adapter's launch path and proves the handshake.
  The launch config also says `"verbose": true` and
  `"logFile": "${workspaceFolder}/tmp/gdb-adapter.log"` (git-ignored), so a launch or a
  stop that hangs leaves the adapter's log of GDB's traffic.
- `Blinky.cproject.yml` names the retarget components `CMSIS-Compiler:CORE` and
  `CMSIS-Compiler:STDOUT:Custom` (the Cclass of `ARM::CMSIS-Compiler` 2.x), and
  `vcpkg-configuration.json` pins `arm:tools/kitware/cmake ^3.31.5`: cbuild2cmake needs
  CMake 3.27 or later.
- The component configuration files under `Blinky/RTE/Device/SSE-300-MPS3/` (with their
  `.base@<version>` copies, from the BSP) and `.cmsis/Blinky+MPS3.dbgconf` are committed:
  without them a clean checkout fails to build with "file … not found; use --update-rte".
  What csolution writes at every convert — `RTE/_Debug_MPS3/`, the regions header, the
  linker script template — and `.cmsis/tools-environment.yml` stay git-ignored.

The FVP's GDB server ignores GDB's interrupt while the model runs, so `pause_execution`
cannot halt it: a fault scenario stops in the fault only with a breakpoint on
`HardFault_Handler` (`Blinky/RTE/Device/SSE-300-MPS3/startup_SSE300MPS3.c`; `lookup_symbol`
finds it) set after `load_and_debug` and before `continue_execution` — the reply of
`load_and_debug` says so on an FVP. The launch config uses `tbreak main` to stop once at entry, and sets no persistent
`break` in `initCommands`: VS Code adopts persistent breakpoints GDB announces and
keeps them in the workspace, where they confuse the next session and `list_breakpoints`.

The `.vscode` files are kept against a global `**/.vscode` ignore by the repository's
`.gitignore`; the files CMSIS Solution writes there per machine stay out. See
`test/eval/README.md` for running a scenario.
