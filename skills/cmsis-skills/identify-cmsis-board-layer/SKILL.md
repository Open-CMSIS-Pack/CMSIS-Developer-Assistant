---
name: identify-cmsis-board-layer
description: Identify packaged CMSIS board layers compatible with an existing solution target and its required connections. Use after a board or device target and its verified DFP/BSP entries exist, before selecting or copying a layer into the project.
---

# Identify CMSIS Board Layer

## Target & Persona

- **Role:** CMSIS Software Layer Integrator
- **Objective:** Return the packaged board layers that are compatible with one existing CMSIS solution target and satisfy its active connection requirements, or establish that none are available.

## Prerequisites & Context

- **Expected input:** An existing `*.csolution.yml`, the exact target-type name to inspect, and verified board, device, DFP, and optional BSP identifiers from `identify-cmsis-board-support`.
- **Dependencies:** CMSIS-Toolbox commands `csolution` and `cpackget`; access to install the verified DFP and BSP when absent.
- **Portability:** Applies across MCU and SoC vendors when packs describe software layers and connections. It has no compiler, RTOS, debugger, or probe dependency beyond requirements already present in the solution or candidate layer.

Use the [CMSIS-Toolbox software-layer format](https://open-cmsis-pack.github.io/cmsis-toolbox/YML-Input-Format/#auto-select-layers) and [Reference Applications workflow](https://open-cmsis-pack.github.io/cmsis-toolbox/ReferenceApplications/) as authoritative guidance.

## Execution Steps (Strict Workflow)

1. **Analysis:** Inspect the target, referenced projects and layers, active `connections:`, and verified pack identifiers.
2. **Processing:** Ensure the exact DFP and BSP are installed and use `csolution list layers` for the selected target context.
3. **Validation:** Accept only tool-reported candidates whose target constraints and provided connections satisfy the active project requirements.
4. **Formatting:** Return a structured candidate list or `NO MATCH` with the exact command evidence and unresolved connections.

### Detailed procedure

1. Confirm that the requested target type exists in the solution and that its unqualified `board:` or `device:` value matches the verified identification result. Stop on any mismatch or ambiguity.
2. Inspect all projects active in the target context. Collect active `connections.consumes` requirements and identify the board-layer variable and `type: Board` layer slot, if any. If the context does not use a board layer, return `NOT REQUIRED` rather than searching for one.
3. Confirm the exact verified DFP and optional BSP appear under the solution's `packs:` and are installed. Use `cpackget list`; install a missing verified pack with `cpackget add <vendor>::<pack>[@<verified-version>]`. Update the public index only when necessary. Do not install or substitute a similarly named pack.
4. Record the active CMSIS-Toolbox version with `csolution --version` and inspect `csolution list layers -h`. Require the installed command to support `--active` and `--verbose`; stop if either option is unavailable.
5. Query the supplied solution with the exact target type and required verbose output:

   ```text
   csolution list layers <solution>.csolution.yml --active "<target-type>" --verbose
   ```

   Do not omit or replace either option and do not replace target selection with context-pattern selection. If this or any other `csolution` command in this workflow reports a command-line syntax or option-parsing error, stop immediately and report the command and error; do not retry with altered syntax. Do not pass `--version` to `list layers`; it prints the tool version and exits.
6. Start with only layers that `csolution` reports as compatible for the selected context. For each candidate, verify:
   - `for-board:` or `for-device:` matches the exact target;
   - its active `connections.provides` satisfies every applicable project or layer `connections.consumes` entry;
   - any candidate `connections.consumes` requirements are also satisfied;
   - the reported source pack version, `path`, `file`, and optional `copy-to` exist.
7. Do not rank candidates by guesswork. If several candidates remain, return all of them so the caller can ask the user which one to use.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent a target, pack, version, layer, path, file, connection, compatibility result, or command result.
- **Exact packs:** Install only the DFP and BSP already verified for the target. Pack installation does not authorize changing the solution.
- **Compatibility:** A matching board or device name alone is insufficient; the active required connections must also be satisfied.
- **Target selection:** Use `--active <target-type>` to select the target. Do not use context-pattern selection.
- **Command integrity:** Require `csolution list layers` to support and use `--verbose`. Stop on any `csolution` command-line syntax or option-parsing error; do not retry with modified options.
- **No selection or copy:** Identify candidates only. Do not choose one, copy pack content, bind a layer variable, edit project YAML, or create a replacement layer.
- **Portability:** Do not add a device-family, toolchain, debugger, build-system, or RTOS assumption beyond the verified target, input project, or candidate metadata.
- **Critical blockers:** Stop on a missing target, mismatch with the verified identity, unavailable required pack, unsupported required `csolution` option, `csolution` syntax or option-parsing error, failed layer query, missing candidate source, or ambiguous active context that cannot be resolved from the project.
- **Scope:** Report compatible packaged board layers for one target context. Leave selection and integration to the caller.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Return one of:

- `MATCHES`: each compatible layer's description, pack and version, source `path`, layer `file`, optional `copy-to`, matching `for-board:` or `for-device:`, provided connections, and any additional requirements;
- `NO MATCH`: the exact target, searched packs, required connections, command used, and the missing or incompatible requirements;
- `NOT REQUIRED`: evidence that the target context has no board-layer slot or requirement.

Also report the `csolution` version, whether packs were already installed or added, and the exact failed command and error when a required option is unsupported or a syntax error occurs.

## Validation Resources

- [CMSIS-Toolbox CSolution Project Format: Auto-select Layers](https://open-cmsis-pack.github.io/cmsis-toolbox/YML-Input-Format/#auto-select-layers)
- [CMSIS-Toolbox Reference Applications](https://open-cmsis-pack.github.io/cmsis-toolbox/ReferenceApplications/)
- `csolution --version`, `csolution list layers -h`, and `csolution list layers`.
- `cpackget list` and `cpackget add`.
