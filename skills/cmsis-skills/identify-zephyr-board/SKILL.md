---
name: identify-zephyr-board
description: Resolve a user-supplied physical board to its exact Zephyr board target and fitted MCU or SoC using the installed west board catalog. Use when a project, build, or support lookup needs a version-matched Zephyr board identifier.
---

# Identify Zephyr Board

## Target & Persona

- **Role:** Zephyr Project Integrator
- **Objective:** Resolve one physical board to its exact target in the installed Zephyr board catalog and identify its fitted MCU or SoC.

## Prerequisites & Context

- **Expected input:** The physical board manufacturer, model, relevant revision, and a verified Zephyr workspace with its venv-local west executable.
- **Dependencies:** An installed Zephyr workspace, its venv-local west executable, local board metadata and documentation, and the Zephyr supported-boards page for comparison.
- **Portability:** Applies to boards represented by the installed Zephyr version. It depends on Zephyr board metadata but has no CMSIS-pack, compiler, debugger, or RTOS configuration assumption beyond Zephyr itself.

Require:

- physical board manufacturer and model;
- board revision when it affects the device or Zephyr configuration;
- verified Zephyr workspace and venv-local west executable.

Do not select a board on the user's behalf or infer it solely from a connected
debug probe or directory name.

## Execution Steps (Strict Workflow)

1. **Analysis:** Verify the supplied physical-board facts and use the installed west catalog as the version-matched source of candidates.
2. **Processing:** Search candidates, inspect their metadata and local documentation, and construct an exact target only from confirmed data.
3. **Validation:** Confirm the marketing name, vendor, fitted device, revision, and qualifiers; compare with the current online board listing without overriding local installed data.
4. **Formatting:** Return the defined `MATCH` or `NO MATCH` report with local evidence, URLs, and unresolved choices.

### Detailed procedure

1. From the verified Zephyr workspace, run the venv-local `west boards` command.
   Treat this version-matched catalog, generated from the installed `board.yml`
   files, as authoritative for the installed Zephyr version.
2. Find candidates with `west boards --fuzzy-match "<candidate>"`. Normalize
   punctuation and capitalization only for searching; do not confirm a fuzzy
   result without checking its metadata.
3. For each candidate, run:

   ```text
   west boards --board <board-name> --cmakeformat "{NAME}|{VENDOR}|{SOCS}|{QUALIFIERS}|{REVISION_DEFAULT}|{REVISIONS}|{DIR}"
   ```

4. Read the referenced `board.yml` and board documentation. Confirm the marketing
   name, vendor, fitted SoC, revision, and qualifiers against the physical board.
5. Construct the exact target as `board-name[@revision][/qualifiers]`. Request the
   intended target when multiple SoCs, CPU clusters, or variants remain possible.
6. Identify the exact fitted MCU or SoC from the board metadata, devicetree files,
   and documentation. Do not derive it solely from a board-name substring.
7. Compare the result with the latest [Zephyr Supported Boards and Shields](https://docs.zephyrproject.org/latest/boards/index.html)
   page. Report differences; keep the installed board data authoritative for the
   installed Zephyr version.

Stop when the physical board, exact target, or fitted device remains ambiguous.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent a Zephyr target, fitted device, revision, qualifier, or board match from a probe, directory name, or fuzzy search alone.
- **Portability:** Keep the installed Zephyr board catalog authoritative for its version; do not introduce CMSIS-pack, toolchain, debugger, or hardware assumptions.
- **Critical blockers:** Stop when the physical board, exact target, fitted device, or a required variant choice remains ambiguous.
- **Scope:** Resolve board identity only; do not create a project, build firmware, or configure a debug connection.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Report:

- status: `MATCH` or `NO MATCH`;
- physical board manufacturer, model, and revision;
- Zephyr board name and exact board target;
- vendor, default revision, revisions, and qualifiers from west;
- fitted MCU or SoC;
- installed board directory;
- supporting local files and documentation URLs;
- unresolved choice or mismatch when status is `NO MATCH`.

## Validation Resources

- [Zephyr Supported Boards and Shields](https://docs.zephyrproject.org/latest/boards/index.html)
- Installed Zephyr `board.yml`, devicetree, and board documentation files
