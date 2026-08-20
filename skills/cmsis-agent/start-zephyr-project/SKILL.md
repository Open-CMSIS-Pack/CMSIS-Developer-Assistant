---
name: start-zephyr-project
description: Create an initial CMSIS Zephyr Blinky solution for a board already supported by Zephyr. Use when the Zephyr and CMSIS environments, exact Zephyr board target, and matching CMSIS BSP or DFP must be verified and combined into a west-integrated CMSIS solution.
---

# Start Zephyr Project

## Target & Persona

- **Role:** CMSIS and Zephyr Project Integrator
- **Objective:** Create and validate one initial west-integrated CMSIS Zephyr Blinky solution from verified environment, board, and pack information.

## Prerequisites & Context

- **Expected input:** A solution directory, the physical board and exact Zephyr target, verified CMSIS and Zephyr environment results, verified CMSIS BSP/DFP identifiers, and a selected installed CMSIS compiler when more than one is available.
- **Dependencies:** The four sibling skills linked below; CMSIS-Toolbox `cbuild` 2.14.0 or later; an existing Zephyr workspace and its virtual environment; the bundled solution and Blinky assets; and publicly available CMSIS packs when `cbuild --packs` needs them.
- **Portability:** Applies to Zephyr-supported boards with verified CMSIS BSP or DFP support. It depends on CMSIS-Toolbox west integration and uses GCC-specific libc settings only when GCC is selected; it does not require the Zephyr SDK, sysbuild, or a particular debugger.

## Execution Steps (Strict Workflow)

1. **Analysis:** Reuse only current verified prerequisite results and stop when the board, support, compiler, or environment information is absent or ambiguous.
2. **Processing:** Render the bundled solution and Blinky assets using the verified identifiers and support situation.
3. **Validation:** Run the exact `cbuild setup` and `cbuild` commands below in the verified CMSIS and Zephyr environment.
4. **Formatting:** Produce the requested files and report the environment, identifiers, selected packs, setup outcome, and build outcome.

### Detailed procedure

Apply these sibling skills in order:

1. [check-zephyr-environment](../check-zephyr-environment/SKILL.md)
2. [check-cmsis-environment](../check-cmsis-environment/SKILL.md)
3. [identify-zephyr-board](../identify-zephyr-board/SKILL.md)
4. [identify-cmsis-board-support](../identify-cmsis-board-support/SKILL.md)
5. Create the Blinky solution using Zephyr as described below.
6. Validate the generated solution with `cbuild`.

Accept an existing result instead of repeating a prerequisite only when its paths,
tool versions, physical board, and other relevant inputs still describe the current
request. Stop before writing project files unless both environment checks pass, the
Zephyr board matches, and CMSIS support resolves to a BSP or DFP.

## Create the Blinky Solution

Collect:

- solution directory;
- CMSIS compiler identifier available in the verified CMSIS-Toolbox environment.

Require `check-cmsis-environment` to report an effective `cbuild` version of
2.14.0 or later. Compare the semantic version reported by `cbuild --version`.
If the version is missing, cannot be parsed, or is older than 2.14.0, report
the failed prerequisite and stop before writing project files. Continue with
the same `cbuild` executable and environment that were verified by
`check-cmsis-environment`.

If `check-cmsis-environment` finds no compiler, report the missing prerequisite
and stop before writing project files. Do not infer a compiler from Zephyr or
continue with an unverified toolchain.

If exactly one compiler is detected, select it and tell the user which compiler
will be used. If multiple compilers are detected, list their exact identifiers
and versions, ask the user to choose one, and stop until the user makes an
explicit choice. Do not select a compiler automatically when multiple
compilers are available.

Tell the user that GCC is recommended for an initial Zephyr project because
Zephyr's standard validation uses GCC and GCC matches the CMSIS-Zephyr
reference project. When GCC is unavailable or the user selects another
compiler, identify the selected compiler and warn that compiler-specific
configuration may be required.

When selecting GCC, add the reference project's libc configuration to
`blinky/prj.conf`:

```text
CONFIG_NEWLIB_LIBC=y
CONFIG_PICOLIBC=n
CONFIG_PICOLIBC_USE_MODULE=n
CONFIG_MINIMAL_LIBC=n
```

Do not add these GCC-specific settings when selecting another compiler; retain
that compiler's Zephyr libc configuration.

1. Create the solution directory when it does not exist. If
   `zephyr.csolution.yml` or a `blinky` directory already exists, inspect and
   preserve it; do not overwrite existing content without the user's approval.
2. Copy [assets/zephyr.csolution.yml](assets/zephyr.csolution.yml) to
   `<solution-directory>/zephyr.csolution.yml`. Copy
   [assets/blinky](assets/blinky) to `<solution-directory>/blinky`. Keep the
   template's fixed `created-for: CMSIS-Toolbox@2.14.0` value.
3. Replace every template token:

   | Token | Source |
   |---|---|
   | `__COMPILER__` | Selected installed CMSIS compiler identifier |
   | `__DEVICE_SUPPORT_PACK__` | Separate DFP; remove its complete `- pack:` entry when the BSP and DFP are the same pack |
   | `__BOARD_SUPPORT_PACK__` | BSP or combined BSP/DFP pack; remove its complete `- pack:` entry when no BSP exists |
   | `__TARGET_TYPE__` | Short, unique name derived from the CMSIS board or device |
   | `__CMSIS_BOARD__` | CMSIS board identifier from the BSP result |
   | `__CMSIS_DEVICE__` | CMSIS device identifier from the BSP or DFP result |
   | `__WEST_BOARD__` | Exact target from `identify-zephyr-board` |

4. Render the `packs:` list and `board:` node according to the verified support:

   | Support situation | `packs:` entries | `board:` node |
   |---|---|---|
   | BSP and DFP are the same pack | Remove the complete `__DEVICE_SUPPORT_PACK__` entry and replace `__BOARD_SUPPORT_PACK__` with the combined pack | Keep and replace `__CMSIS_BOARD__` |
   | BSP and DFP are separate packs | Replace `__DEVICE_SUPPORT_PACK__` with the DFP and `__BOARD_SUPPORT_PACK__` with the BSP | Keep and replace `__CMSIS_BOARD__` |
   | No BSP exists | Replace `__DEVICE_SUPPORT_PACK__` with the DFP and remove the complete `__BOARD_SUPPORT_PACK__` entry | Remove the complete `board:` entry and its adjacent template comment |

   List each pack once. Keep the explicit `device:` entry in all three cases.
5. Add another `- pack:` entry only for a verified additional dependency that
   must be in the solution's pack scope. Use its exact identifier.
6. Keep the `west:` project node, fixed `app-path: ./blinky`, and exact Zephyr
   target in the `west-board` variable. Keep the image context as `blinky.Debug`.
   Do not create a `.cproject.yml` for the Zephyr application.
7. Confirm that no unresolved `__TOKEN__` strings remain.

The bundled application is based on Zephyr's portable GPIO Blinky sample and
expects the selected board to define the `led0` devicetree alias. Keep
`CONFIG_GPIO=y` enabled in `blinky/prj.conf`. The initial template provides
`Debug` and `Release` build types. Add debugger, trace, and board-specific
validation only in their corresponding later workflow steps.

## Validate the Generated Project

Run the checks from the solution directory using the rendered target type from
`zephyr.csolution.yml`. Do not pass the literal `__TARGET_TYPE__` placeholder.

Before running `cbuild`, configure the verified Zephyr virtual environment in
the current shell. Activate the virtual environment for an interactive shell;
for non-interactive execution, prepend its executable directory to `PATH`.
Confirm that `west` resolves from that virtual environment and stop when it
does not. Apply this environment to both `cbuild` commands because `cbuild`
invokes `west` as a subprocess.

Pack installation, initial RTE generation, Zephyr toolchain-cache creation, and
the first build can take several minutes, especially on slower computers.
Treat limited output as normal while the process remains active. Continue
monitoring and do not terminate the process or report a timeout prematurely.
Subsequent builds are usually faster because they reuse cached data.

Run the following validation commands exactly as shown, replacing only
`<solution-name>` and `<target-type>` with their rendered values. Do not add,
remove, reorder, or replace options; pass extra west or CMake definitions; or
retry a failed check with a modified command.

1. Generate the initial west, RTE, and IDE setup information:

   ```text
   cbuild setup <solution-name>.csolution.yml --active <target-type> --packs --update-rte
   ```

   This invokes west's CMake-only setup and helps detect invalid paths, board
   targets, pack identifiers, and project contexts before compilation.
   `--update-rte` generates required RTE files, including board debug
   configuration files. This check is required. Confirm that `cbuild setup`
   exits successfully. Report the failure and stop before compilation when it
   fails.
2. Compile the bundled Blinky application:

   ```text
   cbuild <solution-name>.csolution.yml --active <target-type> --packs
   ```

   This check is required. Confirm that `cbuild` exits successfully and report
   the generated output artifacts identified by the command. Report the failure
   and stop when this build fails.
3. Keep `--packs` on both commands so `cbuild` installs missing public CMSIS
   packs into the configured `CMSIS_PACK_ROOT`. Keep `--update-rte` on the setup
   command. Report every pack installation and stop when a required pack cannot
   be obtained.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent or guess identifiers, paths, pack relationships, dependencies, compiler availability, or test results.
- **Portability:** Do not add a device-, board-, compiler-, debugger-, or RTOS-specific setting unless the verified inputs require it; retain the conditional GCC-only configuration below.
- **Critical blockers:** Stop before writing project files when a prerequisite fails, required values are absent or ambiguous, a compiler choice is unresolved, or either required validation command fails.
- **Scope:** Create and validate only the initial Blinky solution. Leave debugger, trace, board-specific validation, tool installation, and environment repair to later work.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

- Do not install, upgrade, repair, or reconfigure prerequisite tools.
- Do not require the Zephyr SDK; Keil Studio manages the development tools.
- Do not use Zephyr sysbuild; CMSIS-Toolbox west integration does not support it.
- Do not list a combined BSP/DFP pack twice or specify `board:` for a DFP-only
  target.
- Do not rename the generated `blinky` directory without updating both
  `app-path` and `project-context`.
- Do not guess identifiers, paths, dependencies, or test results.
- Do not modify either validation command or use an alternate command to recover
  from a validation failure.
- Do not report overall success unless both required `cbuild setup` and `cbuild`
  compilation checks pass.
- Stop and report the producing prerequisite when a required value is absent or
  ambiguous.

## Expected Output

Produce an initial `<solution-directory>/zephyr.csolution.yml` and self-contained
`<solution-directory>/blinky` Zephyr application without unresolved tokens.
Summarize the environment versions, exact Zephyr target, fitted device, CMSIS
match type, CMSIS identifiers, selected packs, setup status, and build status.

## Validation Resources

- [CMSIS-Toolbox west build system integration](https://open-cmsis-pack.github.io/cmsis-toolbox/build-overview/#west-build-system-integration)
- [CMSIS-Toolbox build tools](https://open-cmsis-pack.github.io/cmsis-toolbox/build-tools/)
- [CMSIS-Zephyr solution example](https://github.com/Arm-Examples/CMSIS-Zephyr/blob/main/zephyr.csolution.yml)
- [CMSIS-Zephyr Blinky configuration](https://github.com/Arm-Examples/CMSIS-Zephyr/blob/main/blinky/prj.conf)
- [CMSIS Solution extension template](https://github.com/Open-CMSIS-Pack/vscode-cmsis-solution/blob/main/templates/template.csolution.yml)
