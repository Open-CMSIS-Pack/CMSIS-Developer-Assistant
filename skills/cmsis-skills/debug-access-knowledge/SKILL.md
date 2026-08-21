---
name: debug-access-knowledge
description: "Build a documentation-led, verifiable record of an existing SoC's reusable CMSIS debug access topology: processor association, debug port and access-port path, protocol, and dormant-state decision. Use before work that needs those access facts, including debug-definition, debug-behavior, or CoreSight trace knowledge; no active target connection is required."
---

# Debug Access Knowledge

## Target & Persona

- **Role:** Verification Engineer and CMSIS-Pack Tool Integrator.
- **Objective:** Establish one reviewable source of truth for a selected SoC scope's reusable debug access facts.

## Prerequisites & Context

- **Expected input:** An existing target `.pdsc`, selected family/subFamily/device/variant scope, affected processor descriptions, and available device documentation or startup logs.
- **Dependencies:** The current Open-CMSIS-Pack *Debug Description* specification; `$resolve-official-device-documentation` when a cited vendor source is unavailable; and `$pyocd-detect-debug-topology` when documentation needs supplementary runtime observations.
- **Owned artifact:** `.agent-artifacts/<pdsc-stem>.debug-access-knowledge.md` at the project root. Do not modify PDSC debug-description elements or sequences.
- **Portability:** Support any existing CMSIS Device Family Pack. Do not assume a device family, debug probe, toolchain, or active target.

## Execution Steps (Strict Workflow)

1. **Analysis:** Locate the target PDSC, selected device subtree, affected processors, inherited/local debug definitions, and any existing owned access record. Stop if no device description exists.
2. **Processing:** Collect only documented processor associations, connection models, DP/AP/APID paths, protocols, required non-sequence access definitions, and dormant-state decisions. When a cited vendor URL is unavailable, run `$resolve-official-device-documentation` and retain its returned resolution. Treat board evidence as out of scope; use `$board-debug-knowledge` for an explicitly requested board configuration.
3. **Validation:** Cite each fact with document edition/revision and section/page when known, or repository/version, path, and symbol/line for source. When documentation does not establish a required access observation, run `$pyocd-detect-debug-topology` and cite its result as supplementary evidence. Record unknown, conflicting, and unavailable facts without inference.
4. **Formatting:** Create or update the owned record, present it for review as `DRAFT — AWAITING USER REVIEW`, and set `READY` only after user confirmation and sufficient evidence for the intended downstream work.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent addresses, identifiers, protocols, core associations, DP/AP paths, dormant-state requirements, patches, or access definitions.
- **Portability:** Do not introduce a device-family, debugger, toolchain, or runtime-target dependency unless authoritative inputs require it.
- **Critical blockers:** Stop when the target PDSC, selected scope, processor association, or an access fact required by the intended downstream work is unavailable, contradictory, or insufficiently evidenced.
- **Scope:** Establish access topology only. Return reset, unlock, authentication, boot, flash, processor-control, low-power, trace-routing, clock, pin, electrical, and sink facts to their domain knowledge skills.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Create or update this record:

```markdown
# CMSIS-Pack debug access knowledge review

PDSC: `<path>`
Device / processor: `<name>`
Selected scope: `<family | subFamily | device | variants>`
Last updated: `<ISO 8601 date and time>` (Model: `<name> <version> <reasoning-level>`)
Status: `DRAFT — AWAITING USER REVIEW` | `READY` | `BLOCKED`

## Evidence
| Item | Value | Evidence type | Source | Location | Confidence |
|---|---|---|---|---|---|

## PDSC scope and inherited access definitions
| Scope / processor | Inherited or local definition | Verified fact | Evidence | Status |
|---|---|---|---|---|

## Debug access topology
| Connection model | Processor | DP / AP / APID path | Protocol | Dormant-state decision | Evidence | Status |
|---|---|---|---|---|---|---|

## Non-sequence access-definition requirements
| Definition / property | Applicability | Verified value or decision | Evidence | Status |
|---|---|---|---|---|

## Completion checklist
| Intended downstream work | Processor association | Connection topology | Dormant-state decision | Retrieval attempt and precise blocker | Complete |
|---|---|---|---|---|---|

## Open questions
- `<question or none>`

## Documents requiring user download
| Title | Failed URL | Retrieval issue and search terms | Replacement official URL | Requested workspace path |
|---|---|---|---|---|
```

Use `not reported` for unavailable values. Preserve `READY` unless an affected fact becomes stale, contradictory, or insufficient; use `BLOCKED` only for an unavailable required input and name it. Only this skill may update the record.

## Validation Resources

Use the current Debug Description specification to distinguish explicit access definitions from standard defaults. Re-read the selected PDSC subtree and inspect every evidence-table row before marking the record `READY`; downstream skills treat the record as read-only.
