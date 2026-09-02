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
  GDB port forwarded. `fvp_config.txt`: headless, UART0 to stdout.
- `overlays/<scenario>/`: one planted bug per scenario, copied over the base by the
  runner. The base itself is bug-free; the agent never sees the overlay mechanism.
- The pack's `Makefile` is dropped.

Two launch-config fixes are still needed after the CMSIS Solution extension generates
`.vscode/launch.json` (it cannot be pre-generated here — it is written per machine):
set `"port": ""`, add `"serverPortRegExp": "GDBServer: Listening .*port=([0-9]+)"` and
`"portDetectionTimeout": 300000` on the `Arm-FVP@GDB (launch)` config and mark it
`"updateConfiguration": "manual"`. `../verify-launch.py` replays the adapter's launch path
and proves the handshake works. See `test/eval/README.md`.

This fixture has not been built on the machine that authored it (no `cbuild` there);
the first run on a machine with the CMSIS-Toolbox and the FVP is the validation.
