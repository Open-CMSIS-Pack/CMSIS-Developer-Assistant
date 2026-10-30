# Field report: Arm Tools environment activation blocked a board build

Date: 2026-10-21
Projects: CMSIS Developer Assistant and UlinkCloud
Target: `NUCLEO-H723ZG` / `STM32H723ZGTx`, AC6, ST-Link with pyOCD

## Outcome in 2.7.0 (2026-10-27)

`cmsis_action activate_environment` now calls the Arm Tools Environment Manager's Reactivate Environment with the active manifest's URI. It waits for CMSIS Solution to rewrite `.cmsis/tools-environment.yml` and reports the tools recorded there, or returns `running` while activation is still pending. Download and licence prompts still belong to the user. See the [current action guide](../agent-resources/debug_instructions.md) and [implementation](../../src/handler/cmsisAction.ts).

The incident and suggested improvement below are preserved as recorded on 2026-10-21; the absence of an activation operation is no longer a current limitation. Any remaining environment-status query belongs in the [2026-10-28 review](../reviews/2026-10-28-knowledge-and-docs.md).

## Observed sequence

1. The UlinkCloud solution had a `vcpkg-configuration.json` requesting CMSIS-Toolbox, CMake, Ninja and Arm Compiler 6. Arm Compiler 6.24.0 was present in the vcpkg artifact cache.
2. Before activation, the CMSIS Solution extension's generated `firmware/.cmsis/tools-environment.yml` contained `environment.variables: {}` and listed only built-in tools. `cmsis_action {action: "build", target: "NUCLEO-H723ZG"}` failed during conversion with `compiler registration environment variable missing, format: AC6_TOOLCHAIN_<major>_<minor>_<patch>` and `no compiler registered`.
3. The agent could read the diagnosis and retry `cmsis_action build`, but the CMSIS Developer Assistant MCP surface had no operation to activate the Arm Tools Environment Manager or complete its download and licence prompts. Changing the agent shell environment was not a valid substitute for changing the VS Code window's task environment. The installed `cmsis-bootstrap` procedure explicitly assigns those prompts to the user.
4. The user ran **Arm Tools: Reactivate Environment** in the UlinkCloud VS Code window. The generated environment then listed CMake 4.2.1, Ninja 1.13.2 and Arm Compiler 6.24.0, including `AC6_TOOLCHAIN_6_24_0`.
5. The next `cmsis_action build` passed compiler registration and reached C compilation. It failed at `firmware/src/tls/tls_entropy.c:18` because the firmware scaffold includes CubeMX `main.h`, which has not been generated. This later error is a separate firmware bring-up issue; no new image was flashed.
6. Adding `Device:CubeMX` then produced the expected `probe.cgen.yml - cgen file was not found` error. The user subsequently chose a custom minimal board configuration for a smoke image. That image built, flashed, reached `main` and passed debugger checks without CubeMX. The full probe firmware still lacks board drivers.
7. After the hardware test, the H723 probe target was restored to `Device:CubeMX`. A fresh build again requests the CubeMX generator, while the tested smoke image remains running on the board.

## Why the agent stopped

The manifest declared the tools, but the Environment Manager had not exported them to the VS Code window that ran CMSIS Solution tasks. The agent had no CDA MCP operation for that activation step, and the workflow required a human to handle any download or licence prompt. The build failure was therefore actionable only after the user activated the environment. The successful transition from the registration error to the `main.h` compile error confirms that activation resolved the first blocker.

## Possible CDA improvement

When `cmsis_action build` sees `no compiler registered` or a missing `*_TOOLCHAIN_*` registration, return a targeted hint: check the active solution's `.cmsis/tools-environment.yml`, then run **Arm Tools: Reactivate Environment** in the selected VS Code window and complete any prompts. A read-only environment status tool could report the selected compiler, exported registration, and whether the manifest's tool is merely installed versus active. If an activation command is exposed in future, it should still leave licence and download decisions with the user.

This is a workflow and diagnostic gap, not evidence that CDA itself failed to activate the compiler. The existing [toolchain information proposal](../proposals/17-toolchain-info.md) is related because it describes how to expose the generated environment to agents.

## Reproduction and acceptance

- Reproduce with an AC6 solution and manifest while the selected VS Code window's generated tools environment has `variables: {}`; `cmsis_action build` should surface the compiler-registration error and an activation hint.
- Activate through the Environment Manager, then rebuild. The `AC6_TOOLCHAIN_6_24_0` registration should appear in `tools-environment.yml`, and the build should reach source compilation or link.
- Keep the error for a genuinely absent compiler distinct from a compiler installed on disk but not exported to the selected window.
