# Device debug behavior knowledge evidence contract

Use the current [Open-CMSIS-Pack *Debug Description* specification](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/debug_description.html) as the grammar authority. Collect device-debug behavior evidence only; do not edit PDSC debug descriptions or sequences. Reuse the current `.agent-artifacts/<pdsc-stem>.debug-access-knowledge.md` record from `$debug-access-knowledge` for processor association, connection topology, DP/AP paths, protocols, and dormant-state decisions.

## Debug behavior inventory and evidence

The Pack scope is device-level: device/SoC documentation establishes supported options, while board documentation can support an explicitly requested board-specific debug configuration but must not remove or limit device-level options. Use `$board-debug-knowledge` to establish board alternatives before copying an evidenced candidate into this record.

Map the selected PDSC device subtree and affected processors from the access record. For the requested debug work, establish documented reset behavior and any required debug unlock, authentication, boot, flash, processor-control, and low-power behavior. Record reset source and type, reset scope, effects on the processor and debug connection, availability during reset, required recovery or reconnect action, and any required sequencing. Record an authoritative `not applicable` decision for a requested behavior that the device does not support.

Search linked and local documentation first:

- Datasheets, reference manuals, implementation guides, SDFs, SVDs, and vendor packs.
- Debug scripts and relevant source code.
- A named board's manual or design guide, connector pin maps, and jumper settings only for an explicitly requested board-specific debug configuration.

When a cited vendor documentation URL is unreachable, run `$resolve-official-device-documentation` before recording the source as unavailable. Copy its failed URL, retrieval result, search terms, and replacement official URL or precise unavailable reason into this record.

For each item, cite the document edition/revision and section/page when known; for source, cite repository/version, path, and symbol or line. Do not infer device-debug behavior from a part name or similar device.

If documentation does not establish a device-debug behavior, keep that behavior unresolved. Return a missing processor, connection, DP/AP, protocol, or dormant-state fact to `$debug-access-knowledge`. Do not treat runtime detection as evidence of reset, unlock, authentication, boot, flash, processor-control, or low-power behavior.

## Required review record

Create or update `.agent-artifacts/<pdsc-stem>.debug-knowledge.md` at the project root:

```markdown
# CMSIS-Pack device debug behavior knowledge review

PDSC: `<path>`
Device / processor: `<name>`
Selected scope: `<family | subFamily | device | variants>`
Debug access knowledge input: `<path and status>`
Last updated: `<ISO 8601 date and time>` (Model: `<name> <version> <reasoning-level>`)
Status: `DRAFT — AWAITING USER REVIEW` | `READY` | `BLOCKED`

## Evidence
| Item | Value | Evidence type | Source | Location | Confidence |
|---|---|---|---|---|---|

## Reset and device debug behavior
| Behavior / mode | Processors | Reset or access impact | Required action / recovery | Evidence | Status |
|---|---|---|---|---|---|

## Optional board debug configuration and candidate runtime choices
| Board / connector / jumper | Debug choice | Candidate runtime choice | Valid values and default | Evidence | Status |
|---|---|---|---|---|---|

## Completion checklist
| Intended downstream work | READY debug access input | Reset and required device behavior | Retrieval attempt and precise blocker | Complete |
|---|---|---|---|---|

## Open questions
- `<question or none>`

## Documents requiring user download
| Title | Failed URL | Retrieval issue and search terms | Replacement official URL | Requested workspace path |
|---|---|---|---|---|
```

- Update `Last updated` on every change; copy model details exactly from the execution environment. Use `not reported` for unavailable values; do not infer them.
- Only this skill may update the artifact. Treat it as read-only elsewhere; return to this workflow if a required device-debug behavior is absent, stale, contradictory, or insufficient.
- Before writing or presenting a draft, make a second evidence pass for each unresolved prerequisite of the intended downstream work.

## Readiness state

- The user's first review confirmation, or a follow-up that clearly authorizes completing the requested debug work, is sufficient to set `READY` when the evidence requirements are met; do not require a separate conversational confirmation.
- Create and update the artifact without confirmation. Before confirmation, use exactly `DRAFT — AWAITING USER REVIEW` and present it for corrections.
- Set `READY` only after confirmation, a `READY` access record, and sufficient evidence for the intended downstream work. Debug sequences require documented reset behavior and every requested device behavior, including any relevant low-power access and recovery behavior. Leave the record non-READY when a required fact is unknown, unavailable, or contradictory.
- Preserve `READY` unless an affected fact becomes stale, contradictory, or insufficient. Use `BLOCKED` only for an unavailable required input, and name it.

Keep verified device debug behavior as reusable CMSIS-Pack input.
