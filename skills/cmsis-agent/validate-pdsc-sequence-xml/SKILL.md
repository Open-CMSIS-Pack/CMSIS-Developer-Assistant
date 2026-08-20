---
name: validate-pdsc-sequence-xml
description: Validate common CMSIS-Pack PDSC sequence XML and C-like block formatting through the active conversation after a proposed or applied change. Use for debug or trace PDSC sequence edits that need XML/PDSC syntax, block layout, and complete match inspection; do not create agent-artifact records or validate device behavior.
---

# Validate PDSC Sequence XML

## Target & Persona

- **Role:** CMSIS-Pack XML Verification Engineer.
- **Objective:** Return repeatable common XML/PDSC and block-format validation results for a proposed or applied sequence change.

## Prerequisites & Context

- **Expected input:** Target PDSC, changed XML, proposed or applied change details, and available XML/PDSC toolchain.
- **Dependencies:** Current [Open-CMSIS-Pack *Debug Description* specification](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/debug_description.html); CMSIS-Toolbox `packchk` for PDSC and pack validation; `cpackget` for local-pack consumption checks; `svdconv` when an affected pack SVD also needs validation; and the available XML/PDSC validation toolchain.
- **Portability:** Support any existing CMSIS Device Family Pack with XML/PDSC validation available. Do not assume a device family, debugger, toolchain, or active target.

## Execution Steps (Strict Workflow)

1. **Analysis:** Inspect the changed PDSC scope and identify its sequence blocks and C-like content.
2. **Processing:** Validate XML/PDSC syntax with `packchk <target.pdsc>` and include every required pack through its `-i` option. Require matching XML-tag alignment. Require C-like content to start after `<block>`, be indented one level inside it, use one semicolon-terminated statement per line, and preserve XML entities.
3. **Validation:** Run and inspect every relevant match from `rg -n '<block>.*;</block>' <target.pdsc>` and `rg -n '^[[:space:]]*[^<].*;.*;' <target.pdsc>`. Resolve each C-like match; one-line block bodies and multiple statements on one line fail validation. When the requested change also affects an SVD, run `svdconv`; when pack consumption must be checked, register or install the local PDSC or pack with `cpackget`.
4. **Formatting:** Return commands, inspected matches, failures, resolutions, and `PASS` or `FAIL` in conversation.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not claim syntax, formatting, or toolchain validation passed without running and inspecting the required checks.
- **Portability:** Do not introduce a device-family, debugger, toolchain, or runtime-target dependency unless the validation environment requires it.
- **Critical blockers:** Stop when `packchk` or required XML/PDSC validation cannot run, a required match remains unresolved, or the target PDSC is unavailable.
- **Scope:** Validate common XML and block formatting only. Do not validate addresses, reset behavior, trace topology, or other device semantics.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Return the common validation result in conversation. Do not create or update workspace files.

## Validation Resources

Use the current Debug Description specification for sequence grammar; `packchk` with `-i` options for PDSC and dependency-pack validation; and the two required `rg` checks for block-format inspection. Use `cpackget` to check local-pack registration or installation when required, and `svdconv` for an affected SVD. Semantic validation is outside this skill's scope.
