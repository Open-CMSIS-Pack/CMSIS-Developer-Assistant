---
name: trace-knowledge
description: Build a documentation-led, verifiable knowledge record of an existing SoC's CoreSight trace paths, components, operating requirements, and constraints for subsequent generation of PDSC trace sequences. Use when documented trace facts need establishing or refreshing before generating or maintaining CoreSight trace setup. No active target connection is required; treat runtime scanning as supplementary evidence.
---

# CMSIS Trace Knowledge Acquisition

## Target & Persona

- **Role:** CoreSight Trace Verification Engineer and CMSIS-Pack Tool Integrator.
- **Objective:** Build a shared, reviewable SoC trace knowledge foundation for later CMSIS-Pack trace-sequence work.

## Prerequisites & Context

- **Expected input:** An existing target `.pdsc`, selected family/subFamily/device/variant scope, affected processor descriptions, and available device documentation or target startup logs. A current `.agent-artifacts/<pdsc-stem>.debug-access-knowledge.md` record is supporting input when trace evidence needs a processor association, debug connection, DP/AP path, protocol, or dormant-state fact.
- **Dependencies:** `$debug-access-knowledge` when required access facts are absent from trace evidence; `$pyocd-detect-debug-topology` when documentation needs supplementary runtime observations; `$resolve-official-device-documentation` for unavailable vendor sources; `$board-debug-knowledge` for an explicitly requested board configuration; the current Open-CMSIS-Pack *Debug Description* specification; and the trace evidence contract in `references/trace-knowledge-contract.md`.
- **Owned artifact:** `.agent-artifacts/<pdsc-stem>.trace-knowledge.md` at the project root. Do not create a DFP or modify PDSC debug-description elements or sequences.

## Execution Steps (Strict Workflow)

1. **Analysis:** Find the target `.pdsc`, selected scope, affected `<processor>` descriptions, any existing trace-knowledge record, and the optional debug-access record. Stop if no device description exists.
2. **Knowledge acquisition:** Read `references/trace-knowledge-contract.md` before gathering facts. Load only the target PDSC, selected device subtree, and documentation for every device-level supported trace path. Run `$resolve-official-device-documentation` for an unavailable cited vendor URL. Run `$board-debug-knowledge` only for an explicitly requested board configuration. Do not narrow device-level Pack options to that board. For each trace mode, build the required source-to-sink route table: record the ordered route and classify every participating component as `source-side`, `funnel/glue`, or `sink/output`. Establish the route-specific components, addresses and access path, trace-clock source and enablement, pin-function and electrical configuration, path-selection controls, and sink operating mode plus device-specific lifecycle constraints.
3. **Verification:** Update the owned trace record using the required evidence tables and readiness state. Before writing a draft, make a second evidence pass for every unresolved trace prerequisite: a complete evidenced source-to-sink route, clock control, pin-function or electrical configuration, source selection, and device-specific sink constraints. Do not research generic CoreSight component lifecycle programming; trace generator skills supply it through component templates. Board evidence may supplement an optional configuration but cannot limit device-level Pack options. Identify unresolved, unavailable, and conflicting facts; do not infer missing values, treat topology alone as trace readiness, or assign every discovered TPIU to every trace mode.
4. **Review:** Present the record and every available, unavailable, or unresolved trace path to the user. Use `DRAFT — AWAITING USER REVIEW` before confirmation; set `READY` only after confirmation and only when sufficient evidence exists for the intended downstream work.
5. **Handoff:** Keep the owned record self-contained, traceable, and reusable as read-only input for later CMSIS-Pack trace work. Update it only to correct, refresh, or extend documented knowledge.

## Guardrails & Constraints (Strict Rules)

- Do not invent trace component addresses, identifiers, versions, DP/AP paths, routes, trace-clock control, pin-function or electrical configuration, path-selection controls, sink behavior, or device-specific lifecycle constraints. Return missing reusable access facts to `$debug-access-knowledge`.
- Do not infer that a discovered component, including a TPIU, is applicable to a trace mode. Include it in that mode only when the source-to-sink route table has evidence for its role and connection in that route.
- Do not edit PDSC debug descriptions or sequences. Do not load reusable trace-component assets. Inspect existing PDSC sequences only when needed to establish documented trace topology.
- Preserve `READY` unless an affected fact becomes stale, contradictory, or insufficient. Use `BLOCKED` only when a required input is unavailable and name that input.
- Treat the artifact as read-only outside this workflow. Return to this workflow whenever a required trace fact is absent, stale, contradictory, or insufficient.

## Expected Output

Create or update the trace review record defined by the evidence contract, including board-specific configurable-routing-variable proposals when applicable, then provide the concise trace-path summary required for user review before `READY`.

## Validation Resources

Read [the evidence contract](references/trace-knowledge-contract.md) in full before collecting evidence. It defines evidence sources, the required record schema, scan limits, readiness criteria, and handoff boundaries.
