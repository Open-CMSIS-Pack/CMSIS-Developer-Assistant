---
name: add-cmsis-target
description: Add a verified board or device target to an existing CMSIS solution, declare its support packs, and offer compatible packaged board layers when the project uses them. Use when the supplied hardware name may be fuzzy and an existing *.csolution.yml must be extended.
---

# Add CMSIS Target

## Target & Persona

- **Role:** CMSIS Solution and Pack Integrator
- **Objective:** Add one verified board or device target to an existing CMSIS solution and, when the project requires a board layer, either integrate a user-selected compatible packaged layer or report that no compatible layer is available.

## Prerequisites & Context

- **Expected input:** An existing `*.csolution.yml` project and a user-supplied board or device name. The name may be fuzzy; manufacturer, revision, and fitted MCU or SoC information improve identification.
- **Dependencies:** The `check-cmsis-environment`, `identify-cmsis-board-support`, and `identify-cmsis-board-layer` skills; CMSIS-Toolbox commands `cbuild`, `csolution`, and `cpackget`; catalog access and pack-download access when the required DFP or BSP is not installed.
- **Portability:** Applies to CMSIS solution projects across MCU and SoC vendors. It has no compiler, RTOS, debugger, or probe dependency beyond requirements already present in the input project or selected layer.

Use the [CMSIS-Toolbox project format](https://open-cmsis-pack.github.io/cmsis-toolbox/YML-Input-Format/) and [Reference Applications workflow](https://open-cmsis-pack.github.io/cmsis-toolbox/ReferenceApplications/) as authoritative format guidance.

## Execution Steps (Strict Workflow)

1. **Analysis:** Verify the selected CMSIS environment before editing. Then inspect the solution and every referenced project or layer needed to understand `packs:`, `target-types:`, `layers:`, variables, and `connections:`, and resolve the fuzzy hardware name with `identify-cmsis-board-support`.
2. **Processing:** Add the verified target and packs. If other targets use a board layer, install the verified packs, list compatible packaged layers, and ask the user to select one before copying anything.
3. **Validation:** Run `csolution convert` for the new context; its default processing validates the YAML against the schemas supplied by the active CMSIS-Toolbox and performs semantic project checks.
4. **Formatting:** Preserve the existing YAML style and report the exact identifiers, files, commands, layer choice, and unresolved requirements.

### 1. Verify the CMSIS environment

Complete this preflight before changing any project file:

1. Invoke `check-cmsis-environment` with the solution workspace root. Require `PASS`; on `FAIL`, stop without editing and report the environment setup or activation that is missing.
2. From that skill's process-local environment, resolve `cbuild`, `csolution`, and `cpackget`. Require all three executables to come from the same selected CMSIS-Toolbox `bin` directory. Use their resolved absolute paths for later commands, or reapply the reported process-local environment in every new shell process; do not fall back to a different ambient `PATH`. Do not combine executables or `CMSIS_COMPILER_ROOT` content from different installations.
3. Run `cbuild --version`, `csolution --version`, and `cpackget --version`; record the executable paths and versions. Confirm through command help that this `csolution` provides `list contexts`, `list packs`, `list layers`, `convert`, and target selection with `--active`, and that this `cpackget` provides `list` and `add`.
4. Read the solution's `created-for: CMSIS-Toolbox@<version>` value when present. The active `csolution` version must not be older than that version and must support every input node already used by the solution. Treat an older version as incompatible even if it can process simpler solution files. When `created-for` is absent, use the CMSIS-Toolbox selected by the workspace environment and let the final `csolution convert` establish schema compatibility.
5. Do not download, install, upgrade, or temporarily substitute CMSIS development tools in this skill. Ask the user to activate or repair the intended workspace environment, then restart the complete preflight.

### 2. Inspect and identify

1. Locate the intended `*.csolution.yml`; do not choose among multiple plausible solutions without user direction.
2. Inspect its `packs:` and `target-types:` plus referenced `*.cproject.yml` and relevant `*.clayer.yml` files. Preserve ordering, indentation, version policy, access-sequence style, and unrelated target settings.
3. Determine whether other target types use a board layer. Evidence includes a project `layers:` entry of `type: Board`, a variable reference such as `$Board-Layer$`, or target-specific variables that bind that reference to a `*.clayer.yml` file. Do not infer a board-layer requirement merely from a directory named `Board`.
4. Invoke `identify-cmsis-board-support` with the supplied name and all locally or authoritatively available manufacturer, revision, and fitted-device evidence. Require exactly one verified board model/revision and one exact device `Dname` for board input, or exactly one device `Dname` for device-only input. Use only its verified exact board, device, BSP, and DFP identifiers. On `AMBIGUOUS`, present the exact candidates returned by that skill and ask the user to choose; do not select the first, closest, or installed-only result. On `NO MATCH`, stop and report the missing identity. Do not edit any project file until the exactly-one requirement is satisfied.

### 3. Add the target and packs

1. Derive the new `type:` from the verified board name for a BSP result or device name for a DFP-only result. Remove only the leading `vendor::` qualifier. The result must be unique in this solution and satisfy the target-type syntax: letters, digits, dash, or underscore, with at most 32 characters. If the exact unqualified name is not valid or collides with an existing target type, ask the user for a valid target-type name rather than silently rewriting it.
2. Add one target under `target-types:`:
   - For a verified BSP, use the exact unqualified `board:` name, including a verified revision when required. A board selects its fitted device indirectly; add an explicit `device:` only when the input project consistently does so or the verified board definition must be overridden.
   - For a DFP-only result, use the exact unqualified `device:` name, including a verified processor name when required.
3. Add the verified DFP and BSP identifiers under solution-level `packs:`. For a BSP result, add both unless the identification result proves that one pack provides both roles. For a DFP-only result, add the DFP. Do not duplicate an existing equivalent entry or invent a version constraint; follow the solution's existing version policy using only verified available versions.
4. Do not copy debugger, `target-set:`, memory, compiler, processor, or layer settings from another target unless authoritative input proves they apply to the new hardware.

### 4. Find compatible board layers when required

Skip this section when the inspection proves that existing targets do not use a board layer. Otherwise:

1. Invoke `identify-cmsis-board-layer` with the edited solution, new target type, and verified board, device, DFP, and BSP identifiers. Let that skill install the exact missing packs, run the version-appropriate layer query with the requested filter, and verify target and connection compatibility.
2. For a `MATCHES` result, present every returned candidate and ask the user which one to add. Do not copy or bind a layer before the user selects it.
3. For `NO MATCH`, state that the board-layer requirement cannot be resolved. Do not create, adapt, or infer a new layer. Treat an unexpected `NOT REQUIRED` result as a reason to recheck the initial board-layer analysis before continuing.

### 5. Copy a selected packaged layer

After the user selects one reported candidate:

1. Resolve its source exclusively from the pack version and `path` reported by `csolution`. Copy all files from that `path`, not just the `*.clayer.yml` file, so relative references remain intact.
2. Copy into the solution workspace, normally `Board/<exact-board-name>/`. The subfolder name must be the verified board name without `vendor::`. If there is no verified board name, stop and ask for direction rather than inventing a folder name. Do not overwrite a non-empty destination without explicit user approval.
3. Remove the read-only attribute from every copied file recursively using the host operating system's native file-attribute mechanism.
4. In the new target's `variables:`, bind the same board-layer variable consumed by the project to the copied layer file. Use a portable `$SolutionDir()$` path and document the exact source directory with `copied-from:`. For example:

   ```yaml
   variables:
     - Board-Layer: $SolutionDir()$/Board/<board-name>/<layer-file>.clayer.yml
       copied-from: ${CMSIS_PACK_ROOT}/<vendor>/<pack>/<version>/<reported-path>/
   ```

   Preserve the actual variable key, filename, pack path, and version reported for the selected candidate. Never refer the active layer variable directly to `${CMSIS_PACK_ROOT}`.

### 6. Validate the result

1. Run `csolution list contexts <solution>.csolution.yml` and confirm that the new target type is present.
2. Run `csolution list packs <solution>.csolution.yml` and confirm that the exact DFP and BSP resolve to installed versions.
3. Run `csolution convert <solution>.csolution.yml --active "<new-target-type>" --no-update-rte` without `--no-check-schema`. This is the schema and semantic validation step; do not run a separate schema validator. Require no schema error, undefined variable, incompatible layer, unresolved pack, or connection error. If the installed version lacks `--no-update-rte`, use its documented non-mutating validation option or clearly report any generated files.
4. When a layer was copied, verify that its local YAML path and every relative file reference exist and that no copied file remains read-only.
5. Review the final diff. Confirm that only the intended solution, selected copied layer content, and tool-generated files explicitly accepted by the user changed.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent board, device, pack, version, layer, connection, path, configuration field, command result, or schema result. Use catalog, pack, project, and tool output or report what is missing.
- **No invented layer:** A missing or incompatible packaged layer is an unresolved requirement. Never synthesize a replacement as part of this skill.
- **Pack copy invariant:** Copy the selected layer into the project and reference the local copy; never bind the project to a layer inside the installed pack.
- **User choice:** Listing compatible layers does not authorize selecting one. Ask before copying a candidate or overwriting an existing destination.
- **Hardware identity:** A target may be added only after each required board/device identity resolves to exactly one verified choice. Installed-pack results alone cannot prove uniqueness because they may omit online catalog candidates. Ask the user to resolve an `AMBIGUOUS` candidate list before editing.
- **Schema integrity:** Use `csolution convert` with its default schema checking. Do not pass `--no-check-schema`, run a redundant schema-validation step, or alter a schema to make invalid project YAML pass.
- **Target selection:** Select the new target with `--active <target-type>` for layer discovery and conversion. Do not use context-pattern selection for this workflow.
- **Tool integrity:** Do not edit the project unless `check-cmsis-environment` passes and the required `cbuild`, `csolution`, and `cpackget` commands resolve from the same compatible CMSIS-Toolbox installation.
- **Portability:** Do not introduce a device-family, toolchain, debugger, build-system, or RTOS dependency unless the verified target, selected layer, or existing project requires it. Identify every such dependency in the output.
- **Critical blockers:** Stop on a failed CMSIS environment check, mixed or incompatible CMSIS-Toolbox executables, an active `csolution` older than `created-for`, a board/device identity with zero choices, an `AMBIGUOUS` identity awaiting the user's choice, an invalid or duplicate required target-type name, unavailable required packs, no compatible layer when the project requires one, a conflicting destination, or failed schema/semantic validation.
- **Scope:** Add one target and, if selected, its existing compatible packaged board layer. Do not redesign projects, generate a new BSP/DFP, or repair unrelated project errors.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Report:

- the `check-cmsis-environment` result plus effective `cbuild`, `csolution`, and `cpackget` paths and versions;
- the edited `*.csolution.yml` and new target type;
- exact board and device identifiers and whether the result used a BSP or DFP only;
- when identification is ambiguous, the exact candidates shown to the user and the choice required before any edit;
- DFP and BSP entries added or already present, with installed versions;
- whether the existing project requires a board layer;
- the compatible layer candidates and the user's selection, or the unresolved missing-layer result;
- copied files, local layer path, `copied-from` source, and read-only cleanup when a layer was selected;
- the `csolution convert` schema/semantic validation command and its result;
- any remaining blocker without claiming the project is complete.

## Validation Resources

- [CMSIS-Toolbox CSolution Project Format](https://open-cmsis-pack.github.io/cmsis-toolbox/YML-Input-Format/): target types, packs, variables, `copied-from`, layers, and connections.
- [CMSIS-Toolbox Reference Applications](https://open-cmsis-pack.github.io/cmsis-toolbox/ReferenceApplications/): DFP/BSP setup, compatible layer discovery, `path`, `file`, `copy-to`, and local layer copying.
- `check-cmsis-environment` for workspace-selected CMSIS-Toolbox, build tools, and compiler verification.
- `csolution --version`, `csolution list layers -h`, `csolution list contexts`, `csolution list packs`, and `csolution convert`.
- `cpackget list` and `cpackget add`.
