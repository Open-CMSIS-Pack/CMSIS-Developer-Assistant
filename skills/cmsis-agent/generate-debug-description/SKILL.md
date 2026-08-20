---
name: generate-debug-description
description: Add or review non-sequence CMSIS-Pack Debug Description content in an existing Device Family Pack PDSC. Use for debug, debugconfig, dbg_datapatch, debug-port, or access-port definitions after `$debug-access-knowledge` has established the required access facts. Do not collect knowledge, generate or update debugvars, implement device debug sequences, or generate CoreSight trace sequences.
---

# Generate Debug Description

## Target & Persona

- **Role:** CMSIS-Pack Tool Integrator and Verification Engineer.
- **Objective:** Apply every verified non-sequence debug-description definition to the selected existing DFP scope.

## Prerequisites & Context

- **Expected input:** An existing target `.pdsc`, selected family/subFamily/device/variant scope, affected `<processor>` descriptions, and a current `.agent-artifacts/<pdsc-stem>.debug-access-knowledge.md` record.
- **Dependencies:** `$debug-access-knowledge`; `$validate-pdsc-sequence-xml` for common PDSC/XML and block-format validation; the current [Open-CMSIS-Pack *Debug Description* specification](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/debug_description.html); and `references/description-contract.md`.
- **Portability:** Support any existing CMSIS Device Family Pack whose selected scope and debug topology are documented. Do not assume a device family, debug probe, toolchain, or runtime target.

## Execution Steps (Strict Workflow)

1. **Analysis:** Locate the target PDSC, selected scope, affected processors, and read-only debug-access knowledge record. Require a current record covering the selected connection and non-sequence definitions; return to `$debug-access-knowledge` when it is absent, blocked, stale, contradictory, or insufficient.
2. **Processing:** Read `references/description-contract.md` before editing. Translate only verified facts into correctly inherited or local `debugconfig`, `debug`, `debug-port`, `access-port`, and `dbg_datapatch` definitions. Present the debug-access knowledge record and proposed XML, then apply only user-confirmed changes.
3. **Validation:** Run `$validate-pdsc-sequence-xml` after applying the confirmed change. For a non-sequence-only change, inspect its file-wide block-format matches and record that the change introduced no C-like block content; resolve every relevant validation failure.
4. **Formatting:** Report emitted definitions, placement and applicability, sources, confidence, unresolved items, and validation results.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent topology facts, addresses, protocols, patches, values, or applicability. Return missing or contradictory hardware facts to `$debug-access-knowledge`.
- **Portability:** Do not introduce a device-family, debugger, toolchain, or runtime-target dependency unless authoritative inputs require it. Identify each required dependency in the output.
- **Critical blockers:** Stop when no existing device description exists, the knowledge record is inadequate, user confirmation is absent, or XML/PDSC validation fails.
- **Scope:** Generate only non-sequence definitions. Preserve `debugvars`, debug sequences, trace sequences, and unrelated PDSC content; direct runtime choices to the appropriate sequence skill.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Apply the confirmed non-sequence PDSC definitions and report their XML placement, applicability, evidence, unresolved items, and validation results.

## Validation Resources

Read [the debug-description contract](references/description-contract.md) in full before editing. It defines grammar authority, placement rules, confirmation requirements, and the required `$validate-pdsc-sequence-xml` handoff.
