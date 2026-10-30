# Knowledge and documentation review — 28 October 2026

**Planned slot:** Wednesday 28 October, 09:00–09:45 Europe/Berlin (08:00–08:45 UTC).
**Status:** The four policy decisions were agreed on 28 October. Knowledge
corrections, migration and the additional validation remain to be implemented.

## Outcome

The review agreed the following:

1. Knowledge owns procedures; the extension keeps tool contracts and a small
   health/retrieval entry layer.
2. Existing instruction topics and resource URIs remain supported throughout
   2.7.x while their content migrates to reviewed Knowledge.
3. Completed proposals and obsolete inventories stay at their current paths with
   historical status banners.
4. Migration sign-off requires focused package/extension-host, client and FVP
   validation. The preparation checks below do not satisfy the pending checks.

## Already corrected

The 27 October audit used the 2.7.0 checkout at commit 8ec3ba3. The working changes
correct agent guidance, product/architecture references, contributor and packaging
setup, CI preparation and triggers, the feature-request form, generated TPIP,
test/evaluation documentation and historical status/link drift. The evaluation
verifier's Docker check now applies only to its own macOS fixture containers.

Completed proposals and obsolete inventories are marked historical; their
evidence remains in place. The unused markdown-link-check configuration is removed.
The pinned index, resource URIs, legal notices and provenance specifications are
retained. Knowledge ownership is agreed; consolidation has not been implemented.

## Planned agenda

| Time | Review | Decision |
| --- | --- | --- |
| 09:00–09:10 | Instruction ownership | Agree one authoring source for each content type. |
| 09:10–09:25 | Knowledge content and release pin | Review stale/draft units and define acceptance for a replacement index. |
| 09:25–09:35 | Compatibility and retirement | Decide how instruction topics/resource URIs evolve and how to archive old guidance. |
| 09:35–09:45 | Release acceptance and follow-ups | Agree remaining client/FVP checks, owners and bounded next changes. |

## 1. Agreed ownership

| Content | Owner |
| --- | --- |
| Tool scope/rules, parameters, result semantics, session/window gates and deadlines | Extension code, canonical tool contract and corresponding tests. |
| Read-only health check and finding the right procedure | Small cmsis-help and get_debug_instructions entry points. |
| Bring-up, debugging workflows, fault reasoning, troubleshooting and hardware concepts | Reviewed sources in cmsis-knowledge-base, delivered through the pinned index. |
| Human-facing product/setup reference | README and user guide; generate repeated procedural detail from the canonical source where useful. |
| Contributor build/style/testing rules and component design | AGENTS.md, CONTRIBUTING.md and docs/architecture. |

Keep a small code-versioned instruction layer and consolidate the long procedures
in Knowledge. An agent needs the entry instructions before it can
retrieve a procedure. Resource registration is a compatibility constraint, not a
reason for maintaining the same procedure independently in several places.

**Decision 1 — accepted 28 October:** Knowledge owns procedures. The extension
keeps tool contracts and a small health/retrieval entry layer. Product/setup and
contributor documentation remain in the repository. Existing instruction tools
and resource URIs remain as compatibility entry points throughout 2.7.x, as
recorded in decision 2.

## 2. Content review before updating the pin

The current index is core-2026.10.26 (7,154 units). The inspected units below are
marked draft; presence in the index does not establish review.

| Unit / area | Observed issue | Proposed action |
| --- | --- | --- |
| proc-cmsis-debug-live | Duplicates session/fault/serial/cleanup guidance, points back to the fuller Markdown guide, and repeats the obsolete user-only launch-regeneration instruction. | Correct the repair conditions and remove circular hand-offs; separate tool contract from procedure. |
| concept-cmsis-embedded-guide | Another imported guide overlaps the procedure and runtime Markdown. | Choose the concept/procedure boundary and review current tool semantics. |
| cda-guides embedded troubleshooting | An older import still uses get_fault_info where current first-pass guidance uses diagnose_fault. | Correct the canonical source/import path and remove conflicting copies. |
| Python and C++ troubleshooting imports | Coverage exists as draft snapshots of earlier repository documents. | Review the content before serving it through compatibility resources. |
| Hardware/adapter claims | Capacities, register meanings and FVP/probe behavior need source or live review. | Use documentation tools or a controlled target session where needed. |

CDA procedures/assets are authored in cmsis-knowledge-base/sources/cda-procedures.
Review the cda-guides import pipeline too, so it does not recreate a second copy.
Publish and pin a reviewed release through the normal update path; do not patch
core.db by hand.

Acceptance for a replacement pin:

- Task queries such as new project, HardFault and debug connection failure reach
  the intended procedure; known unit IDs resolve directly.
- Tool names, arguments, defaults and operation order agree with the extension.
- The confirmed launch-repair, passthrough, fault-first and timeout corrections
  appear without contradictory imported copies.
- Checks cover retrieval and applicable behavior, rather than forcing two
  independently authored documents to repeat the same sentences.
- The index lock, SOURCES.md and generated TPIP are updated and verified together.

**Implementation follow-up:** Correct and review the source text and cached
metadata before replacing the pin. This review did not approve the draft units
as reviewed content or select a replacement release. The proposed sequence below
describes the next work; its owner and execution date remain unassigned.

## 3. Compatibility and retirement

Keep get_debug_instructions and existing resource URIs throughout 2.7.x.
Back them with short routing guidance or content from the same reviewed source.
Define an actionable response when the index is unavailable; avoid preserving a
second full procedure library as a fallback.

Review consumers and snapshots before removing topic names or URIs. The current
changes correct their existing content without removing these entry points.

Keep completed proposals and obsolete inventories at their current paths with
historical status banners. Preserve backlinks, historical commit links,
provenance specifications and legal notices. Updating the Skills box in the
product illustration to reflect the agreed ownership remains a follow-up.

Proposed migration acceptance:

- Keep current tool names, topic arguments, resource URIs and the `build` alias
  through 2.7.x; map the content to stable Knowledge IDs.
- Review each mapped procedure against 2.7.0, including cached metadata; remove
  contradictory copies and circular hand-offs before making it authoritative.
- Keep a small local entry/recovery response for a missing index, incompatible
  schema or missing unit. It must explain the problem and recovery action.
- Keep core guidance available without a session. Contextual retrieval must use
  the correct window without changing the selected target.
- Preserve the overview budget and 7 KB topic limit by splitting content into
  suitable units, not by truncating procedures.
- Check mappings, aliases, missing-index behavior and window routing, then update
  the intentional surface snapshot before retiring duplicate bodies.

**Decision 2 — accepted 28 October:** Preserve existing instruction topics and
resource URIs throughout 2.7.x while migrating their content to reviewed
Knowledge. Consider removal only in a later release; no removal version has
been selected.

**Decision 3 — accepted 28 October:** Keep completed proposals and obsolete
inventories at their current paths with historical status banners. No archive
folder move is planned.

## 4. Agreed validation scope

**Decision 4 — accepted 28 October:** Use focused package/extension-host, client
and FVP validation before migration sign-off. Record each result against the
actual extension version, Knowledge pin and client/model version tested.

| Required validation | Evidence needed | Current status |
| --- | --- | --- |
| Package and extension host | Validate the final package, shipped index/resources and extension-host behavior. | Pending; preparation checks are listed below. |
| Client with skill support | Verify the health/retrieval entry point and reviewed procedure retrieval. | Pending. |
| Client without skill support | Verify the instruction-tool/resource fallback and procedure retrieval. | Pending. |
| FVP fault and recovery scenarios | Exercise a fault investigation and a failure/recovery path in the dedicated test workspace. | Pending. |

Physical-board and serial validation are outside this agreed sign-off scope.
Use the maintained transport/evaluation guides to create a current acceptance
checklist alongside the preserved historical test/acceptance-ai-efficiency.md.
Preparation evidence from 27 October is retained below; it does not establish a
pass for these additional checks. Execution owners and dates remain unassigned.

## Proposed implementation sequence

These are follow-up work items, not completed migration or release work.

1. Correct Knowledge source text and cached stop conditions together. Start with
   sources/cda-procedures/cmsis-debug-live/SKILL.md, its embedded guide and
   troubleshooting references, and stage2/out_cda/proc-cmsis-debug-live.json.
   Review shared-reference changes before refreshing compatibility.json.
2. Regenerate and review the resulting units and metadata, then build and check
   the core index. Prepare a reviewed Knowledge release; once available, update
   the extension pin, SOURCES.md and generated TPIP together.
3. Migrate launch-configuration recovery first. Keep immediate state checks and
   tool-contract details in the extension; route deeper setup/troubleshooting to
   reviewed Knowledge. Preserve all topic names, the build alias and resource
   URIs. This step depends on shipping the corrected index.
4. Verify index consistency, topic mappings and size limits, missing-index
   recovery, routing, instruction snapshots and packaged resources. Record
   extension-host, installed-client and FVP results separately from the existing
   scripted tests. Apply the agreed scope in decision 4; those additional checks
   have not yet run.

Use the existing documented native-FVP prerequisite for this validation plan.
Selecting a new native artifact pin is a separate follow-up. Keep unrelated
feature proposals outside this migration. Implementation owner and execution
date have not been assigned during the review.

## Review entry points

- [Tool contract](../agent-resources/tool-contract.md)
- [Current instruction topics](../agent-resources/debug_instructions.md)
- [Knowledge architecture](../architecture/knowledge.md)
- [User guide](../user-guide.md)
- [Proposal outcomes and remaining scope](../proposals/README.md)
- [Cross-extension inventory](../proposals/extension-calls.md)
- [Transport checks](../../test/transport/README.md)
- [Evaluation setup](../../test/eval/README.md)

## Validation of the prepared changes

- Compilation, ESLint and Markdown lint (including architecture pages) pass.
- 290 selected existing contract, knowledge, fixture and parser tests pass with
  the pinned index present, including the local download-server tests.
- Session-lifecycle and two-window routing harnesses pass; the final surface
  snapshot matches. Only initialize instructions and the three corrected
  resource bodies changed in that snapshot; tool schemas are unchanged.
- All 99 Markdown files have existing local link targets, and documented npm
  script names resolve. The 17 repaired historical targets were verified in git.
- Updated workflow/form YAML parses; the matrix index-hash step runs with Node
  and the index fetch precedes the tests. TPIP agrees with pinned SOURCES.md.
- The verifier change passes fake-process cases for native hosts without Docker,
  unrelated/owned containers and workspace-label handling. No live model, board,
  probe, serial port or paid agent run was used for these changes.

The changes are in the working tree for review; no commit or remote update was made.

## Review discussion — 28 October

The checkout remains at 8ec3ba3 (package version 2.7.0), with the prepared working
changes still uncommitted. The core pin remains core-2026.10.26. The validation
above is the preparation evidence from 27 October; it has not been rerun for this
read-only review.

The Knowledge tools were queried again during the review. Both
`proc-cmsis-debug-live` and `concept-cmsis-embedded-guide` still report `draft`.
The former still says launch regeneration always needs the user; the latter
still suggests `attach` while a session is active. These conflict with the
corrected [launch repair guidance](../agent-resources/debug_instructions.md)
and [active-session guidance](../agent-resources/cmsis-embedded-guide.md).

The user selected Knowledge-owned procedures with a small extension-owned
entry/contract layer. Record this as the agreed authoring boundary; it does not
mark any draft Knowledge unit as reviewed or retire an existing entry point.

The sibling cmsis-knowledge-base checkout is present at the pinned commit
06d55cb. The procedure text is authored under sources/cda-procedures; generated
copies live under units/cda-skills. The obsolete user-only launch-repair rule also
appears in stage2/out_cda/proc-cmsis-debug-live.json as a cached stop condition,
which rebuild_cda.sh reapplies. Correcting only the Markdown body would leave
contradictory metadata. Include that metadata and the source/contract checks in
the bounded Knowledge correction; this review has not modified that checkout.
