# Trace knowledge evidence contract

Use the current [Open-CMSIS-Pack *Debug Description* specification](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/debug_description.html) as the grammar authority. Collect trace hardware and topology evidence only; do not edit PDSC debug descriptions or sequences.

## Trace inventory and evidence

The Pack scope is device-level: device/SoC documentation establishes supported options, while board documentation can support optional board-specific configurations but must not remove or limit device-level options.

Map the selected device subtree, including inheritance and leaf variants. Inspect relevant PDSC trace definitions—ports, DP/APs, variables, patches, and sequences—and record inherited and local trace facts without prescribing PDSC XML. Identify every documented SWO, synchronous, and trace-buffer path.

Use a current `.agent-artifacts/<pdsc-stem>.debug-access-knowledge.md` record from `$debug-access-knowledge` only when it supplies a required processor, debug connection, DP/AP path, protocol, or dormant-state decision. Cite it as a supporting source; do not update it. If the trace evidence cannot establish a required reusable access fact and no sufficient access record exists, return to `$debug-access-knowledge`.

For each trace mode, build a source-to-sink route table before selecting components for that mode. Record the ordered route and classify every participating component as `source-side`, `funnel/glue`, or `sink/output`; a component may be recorded in more than one mode only with route-specific evidence. Record the configuration that makes the route operable: trace-clock source and enablement, pin-function and electrical configuration, path-selection controls, and the sink operating mode plus device-specific lifecycle constraints. Consider mux or function registers (including PFS where that is the vendor term), pad control, drive strength, slew rate, pull configuration, and voltage-domain settings when documented as relevant; record an authoritative `not applicable` decision when they are not required. Do not research generic CoreSight component lifecycle programming here; trace generator skills supply it from component templates. Do not select every discovered TPIU, funnel, or other trace component for every mode: include it only when the route table evidences its role and connection from that mode's source to its sink or output.

Search linked and local documentation first:

- Datasheets, reference manuals, implementation guides, SDFs, SVDs, and vendor packs.
- Trace scripts and relevant source code.
- When available, a named board's manual or design guide, connector pin maps, and jumper settings as supporting evidence for optional board-specific configurations.

When a cited vendor documentation URL is unreachable, run `$resolve-official-device-documentation` before recording it as unavailable. Copy its failed URL, retrieval result, search terms, and replacement official URL or the precise reason no official replacement was found into this record.

For each item, cite the document edition/revision and section/page when known; for source, cite repository/version, path, and symbol or line. An authoritative vendor SDK header or source file may evidence a generated pin-function-register encoding when the hardware manual omits that encoding; cite the matching device, SDK version, path, and symbol. Do not infer from a part name or similar device: component addresses, identifiers, core associations, trace routing, clock control, pin configuration, or sink behavior.

If documentation does not establish a required CoreSight topology observation, run `$pyocd-detect-debug-topology` for an accessible target or a supplied complete startup log. Cite its result as supplementary evidence; do not treat an absent observation as evidence that a component does not exist. The detector requires documented unlock or power-up steps before relying on a repeat scan.

## Required review record

Create or update `.agent-artifacts/<pdsc-stem>.trace-knowledge.md` at the project root:

```markdown
# CMSIS-Pack trace knowledge review

PDSC: `<path>`
Device / processor: `<name>`
Selected scope: `<family | subFamily | device | variants>`
Debug access knowledge input: `<path and status | not required>`
Last updated: `<ISO 8601 date and time>` (Model: `<name> <version> <reasoning-level>`)
Status: `DRAFT — AWAITING USER REVIEW` | `READY` | `BLOCKED`

## Evidence
| Item | Value | Evidence type | Source | Location | Confidence |
|---|---|---|---|---|---|

## Trace components
| CoreSight component instance | Product / variant / version (optional) | Base address | DP / AP path | Evidence | Status |
|---|---|---|---|---|---|

## Source-to-sink routes
| Path / mode | Route order | Component instance | Role (`source-side` / `funnel/glue` / `sink/output`) | Route connection or interface | Evidence | Status |
|---|---:|---|---|---|---|---|

## Available trace paths
| Path / mode | Processor | Source-to-sink route | DP / AP path | Availability | Evidence |
|---|---|---|---|---|---|

## Trace operating requirements
| Path / mode | Trace-clock source and enablement | Pin-function and electrical configuration | Path-selection controls | Sink mode and device-specific constraints | Evidence | Status |
|---|---|---|---|---|---|---|

## Optional board configuration and candidate runtime choices
| Board / connector / jumper | Routing choice | Candidate runtime choice | Valid values and default | Evidence | Status |
|---|---|---|---|---|---|

## Completion checklist
| Path / mode | Source-to-sink route | Clock control | Pin-function and electrical configuration | Source selection | Device-specific sink constraints | Retrieval attempt and precise blocker | Complete |
|---|---|---|---|---|---|---|---|

## Open questions
- `<question or none>`

## Documents requiring user download
| Title | Failed URL | Retrieval issue and search terms | Replacement official URL | Requested workspace path |
|---|---|---|---|---|
```

- Update `Last updated` on every change; copy model details exactly from the execution environment. Use `not reported` for unavailable values; do not infer them.
- Only this skill may update the artifact. Treat it as read-only elsewhere; return here if a required trace fact is absent, stale, contradictory, or insufficient.
- For user review, outline every available, unavailable, or unresolved trace path and its reason, even when trace was not requested. After confirmation, configure every evidenced path by default; do not require per-path selection.
- For a board-specific request, run `$board-debug-knowledge` and copy every documented connector or jumper routing choice and its evidenced candidate runtime choice. Treat these as optional alternatives and preserve all device-level Pack options. This skill does not edit PDSC `debugvars`.
- Before writing or presenting a draft, make a second evidence pass for every unresolved trace prerequisite: a complete source-to-sink route with each participating component classified, clock control, pin-function or electrical configuration, source selection, and device-specific sink constraints. Mark the completion checklist complete only when every path has all required facts or records a concrete retrieval attempt and precise blocker.

## Readiness state

- The user's first review confirmation, or a follow-up that clearly authorizes completing trace work, is sufficient to set `READY` when the evidence requirements are met; do not require a separate conversational confirmation.
- Create and update the artifact without confirmation. Before confirmation, use exactly `DRAFT — AWAITING USER REVIEW` and present it for corrections.
- Set `READY` only after confirmation and sufficient evidence for the intended downstream work. Trace assembly requires an evidenced processor, CoreSight addresses, and every available trace path; for each path, it also requires an evidenced source-to-sink route table whose ordered components are classified as source-side, funnel/glue, or sink/output, plus evidenced trace-clock source and enablement, pin-function and electrical configuration, path-selection controls, and sink mode plus device-specific lifecycle constraints. Obtain a reusable access fact from `$debug-access-knowledge` only when it is required and not self-contained in this record. Trace generator skills supply generic component lifecycle programming from templates. Record an authoritative `not applicable` decision where a control does not apply. Leave the record non-READY for trace assembly when a route is incomplete or any required control is unknown, unavailable, or contradictory.
- Preserve `READY` unless an affected fact becomes stale, contradictory, or insufficient. Use `BLOCKED` only for an unavailable required input, and name it.

Keep verified trace knowledge as reusable CMSIS-Pack input.
