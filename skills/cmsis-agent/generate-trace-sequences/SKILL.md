---
name: generate-trace-sequences
description: Add modular, evidence-backed CoreSight trace sequences to an existing CMSIS Device Family Pack PDSC. Use after `$trace-knowledge` has produced a READY trace knowledge record that evidences available trace paths, when assembling per-component trace snippets into TraceStart, TraceCapture, TraceFlush, and TraceStop sequences, or when maintaining trace setup with device-specific extension placeholders; use the shared PDSC preparation, debugvars, application, and XML-validation skills for their respective integration work. Consult `$debug-access-knowledge` only when a required access fact is not self-contained in the trace record.
---

# Generate Trace Sequences

## Target & Persona

- **Role:** CMSIS-Pack Tool Integrator and CoreSight Trace Verification Engineer.
- **Objective:** Generate complete, evidence-backed device-level CoreSight trace setup for every selected available trace path.

## Prerequisites & Context

- **Expected input:** Existing target `.pdsc`, selected family/subFamily/device/variant scope, a READY `.agent-artifacts/<pdsc-stem>.trace-knowledge.md` record, and documentation for the selected CoreSight topology. Use `.agent-artifacts/<pdsc-stem>.debug-access-knowledge.md` only for a required processor, connection, DP/AP path, protocol, or dormant-state fact absent from the trace record.
- **Dependencies:** `$trace-knowledge`; `$debug-access-knowledge` when required; `$prepare-pdsc-sequence-change`; `$manage-pdsc-debugvars`; `$apply-confirmed-pdsc-proposal`; `$validate-pdsc-sequence-xml`; current [Open-CMSIS-Pack *Debug Description* specification](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/debug_description.html); `references/trace-sequence-contract.md`; `references/component-index.md`; selected component assets; `assets/scaffolds/full-trace.xml`; and `references/legacy-to-full-migration.md` when migrating legacy setup.
- **Portability:** Support any existing CMSIS Device Family Pack with documented CoreSight paths. Do not assume a device family, debug probe, toolchain, active target, or trace transport.

## Execution Steps (Strict Workflow)

1. **Analysis:** Read the READY trace knowledge record and run `$prepare-pdsc-sequence-change` with `domain=trace`, passing verified facts in conversation. Verify every selected trace path, component instance, address, DP/AP path, placement scope, and explicit debug definition. Return missing trace facts to `$trace-knowledge`; consult `$debug-access-knowledge` only for a needed reusable access fact absent from the trace record.
2. **Processing:** Read `references/trace-sequence-contract.md` and `references/component-index.md`, select only required component assets, and assemble complete full-mode trace setup from `assets/scaffolds/full-trace.xml`. When an existing PDSC uses `traceSetup="legacy"` or omits `traceSetup`, also apply `references/legacy-to-full-migration.md`. Add concise comments that explain each command or logical command group's verified purpose in every newly authored C-like expression and each functionally modified copied template snippet, including affected register names and modified or read bit-field names whenever the verified sources identify them; preserve unmodified copied template snippets without adding or altering their comments. For every documented user runtime choice, run `$manage-pdsc-debugvars` with prepared placement context and merge its returned definition and sequence use into this skill's private record.
3. **Validation:** Create or update `.agent-artifacts/<pdsc-stem>.trace-sequences.md` as this skill's private proposal record. Record scope, trace paths, component instances, placement, proposed debugvars, proposed XML, extension placeholders, evidence, `.dbgconf` proposals, unresolved items, and `PROPOSED` status. Present it with selected assets and proposed XML, then obtain confirmation. Run `$apply-confirmed-pdsc-proposal` with `$validate-pdsc-sequence-xml` as the common validation step, then complete trace-specific scaffold, routing, asset-fidelity, marker, and lifecycle gates. Set `APPLIED` only after all checks pass.
4. **Formatting:** Report trace paths, component instances, emitted sequences, placement, extension placeholders, sources, `.dbgconf` proposals, unresolved items, and validation results. Do not provide the private proposal record as input to a helper or another skill.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent addresses, values, routes, component order, trace-clock behavior, trace mode, timestamps, formatter settings, or dormant-state requirements.
- **Portability:** Do not introduce a device-family, debugger, toolchain, runtime-target, or trace-transport dependency unless authoritative inputs require it. Identify every required dependency in the output.
- **Critical blockers:** Stop when the trace record is not READY or is insufficient, a required debug record is absent or insufficient, required assets or documentation are missing, confirmation is absent, or validation fails.
- **Scope:** Generate only full-mode CoreSight trace configuration. Preserve unrelated PDSC content; do not create legacy setup, omit verified paths, or modify `.dbgconf` without explicit confirmation.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Create or update the private `.agent-artifacts/<pdsc-stem>.trace-sequences.md` proposal record, including proposed debugvars; apply the confirmed trace XML; and report trace paths, component instances, sequence names, placement, placeholders, sources, `.dbgconf` proposals, and validation results.

## Validation Resources

Read [the trace-sequence contract](references/trace-sequence-contract.md) and [component index](references/component-index.md) in full before assembly. Use `$validate-pdsc-sequence-xml` for common PDSC checks and the trace contract for scaffold, routing, asset-fidelity, marker, and lifecycle validation.
