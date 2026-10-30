# Proposal records and 2.7.0 follow-ups

This index separates the current disposition from the original release plans retained below. The implementation was checked against the 2.7.0 checkout on 2026-10-27; GitHub issue and external PR states were not checked, so a shipped feature here does not imply that its issue is closed.

The [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md) is planned for **2026-10-28, 09:00–09:45 Europe/Berlin**. Use it to decide the remaining ownership, maintenance and retirement questions. No evidence files have been moved or deleted.

## Current disposition

| Scope | 2.7.0 disposition |
|---|---|
| [#11 typed results](11-typed-tool-results.md), [#12 long jobs](12-long-builds-as-jobs.md), [#13 running-target guards](13-target-running-toasts.md), [#14 watchdog](14-control-channel-watchdog.md), [#15 build errors](15-build-error-lines.md), [#16 window picker](16-window-selection-ui.md), [#19 registry permissions](19-registry-token-exposure.md), [#20 guidance](20-skill-docs-gaps.md), [#45 tool bypass](45-pyocd-called-directly.md), [#46 probe guards](46-probe-busy-parallel-run-tasks.md), [#47 task completion](47-task-completion-detection.md), [#49 serial release](49-serial-port-release.md) | Implemented. Keep the proposals as historical design records; current behavior belongs in the architecture and agent guides. |
| [#53 independent rewrite](53-ms-derived-core-rewrite.md) | Source rewrite complete; retain [provenance evidence](../provenance/README.md). The separate license review is not settled by this result. |
| [#3 reconnect](03-reconnect-probe.md), [#48 error feed](48-error-feed.md), [#50 tool contract](50-tool-contract.md) | Partly implemented: probe-wedge diagnosis, the problem journal and rule installation shipped. Automatic reconnect, further provider integrations and the process-detection/hook-pack proposals need separate decisions. |
| [#17 toolchain query](17-toolchain-info.md), [#41 cross-extension queries](41-cross-extension-commands.md) | Catalog queries exist; the proposed context/toolchain queries remain open design work. Reuse current environment parsing and activation paths. |
| [#44 SBOM](44-spdx-sbom.md), [#51 optimization](51-performance-optimization-workflow.md), [#52 profiling](52-statistical-profiler.md) | Workflow proposals remain. Local skill vendoring/category steps are obsolete; the knowledge base owns procedure sources and imports cmsis-skills. The cycle-counter annotation fix in #51 has shipped. |
| [#21 sibling-tool findings](21-sibling-tool-findings.md) | Historical findings and draft external requests. Verify what was sent and the owners' current responses before following up. |
| [Bootstrap](bootstrap-empty-vscode.md), [CMSIS Solution integration](cmsis-solution-integration.md) | open_solution, catalog-based create_solution, install_pack, rebuild/clean/stop_build and environment activation are available. All five integration phases shipped; the wider bootstrap query/open_folder/evaluation proposals remain separate. |
| [Knowledge base](knowledge-base.md) | Always-on tools and a pinned shipped index supersede the experimental flags. Only cmsis-help is installed here; source ownership and current behavior are described in [knowledge architecture](../architecture/knowledge.md). |
| [Prepared cmsis-skills PR](cmsis-skills-start-cmsis-project-pr.md), [prepared 2.5.9 PR](upstream-pr-2.5.9.md) | Retain as dated drafts, not current submission instructions or proof of remote status. |
| [Cross-extension calls](extension-calls.md), [storage overview](pack-docs-storage-overview.md), [storage requirements](pack-docs-storage.md) | Keep as current reference/integration material. The storage-provider interface remains a proposal, not an exposed API. |

## Reading the historical record

The original release plan, measurements and dated status notes follow unchanged in substance. Old Current state sections and unchecked decisions describe their recorded baseline, not today's code. Removed skill/source references that were broken now point to the verified 2.3.10 commit they discussed. For current instructions use the [agent guide](../agent-resources/debug_instructions.md), [user guide](../user-guide.md) and [architecture](../architecture/debugMCPServer.md).

## Original planning record

This folder has one proposal for each open issue: the 21 on the [CMSIS Developer Assistant board](https://github.com/orgs/Open-CMSIS-Pack/projects/26), plus #53, which is not on the board. They were written on 2026-09-23 against release 2.3.10 (`upstream/main` `b37a526`). Each proposal covers four things:

- the problem as it stands in the current code (the issues cite 2.1.0 line numbers, which are all re-checked here);
- the proposed fix;
- the decisions that need an owner;
- how to test it.

## How to review

- Each file ends with a **Review** section. Tick one box and add notes there, or edit the proposal text directly.
- **Decisions for you** lists the real choices, each with a recommended option. Tick the ones you accept, or write the alternative you want.
- The shared vocabulary is defined in [11-typed-tool-results.md](11-typed-tool-results.md): error codes, `ToolError`, `ToolReply` and control envelope v2. Most other proposals build on it, so review it first.
- Work-package letters (WP-A …) refer to the overall release plan. Within a release, the order follows the dependencies.
- The tool-list sizes quoted in the proposals were measured on the 2.3.10 build:
  - 45 tools in the single-window list: 28 799 of 30 000 B;
  - 47 tools in the routed list: 29 987 B, not tested today;
  - all groups on: 40 527 of 42 000 B.

## 2.3.11: tools that tell the truth

| Issue | Proposal | WP | Size | Depends on | Decisions |
|---|---|---|---|---|---|
| #11 | [Typed tool results: isError, error codes, status](11-typed-tool-results.md) | A | L | none | 5 |
| #47 | [Task completion detection and job tracking](47-task-completion-detection.md) | B | M | #11 | 4 |
| #46 | [Probe busy: parallel CMSIS Run tasks, bundled pyOCD for flash](46-probe-busy-parallel-run-tasks.md) | B | M | #11, #47 | 4 |
| #12 | [Long builds as jobs instead of a 60 s cap](12-long-builds-as-jobs.md) | B | M | #11, #47 | 4 |
| #13 | ["Target is running" toasts: UI fallbacks and ungated breakpoint ops](13-target-running-toasts.md) | C | M | #11 | 4 |
| #50 | [Tool contract against bypassing the MCP tools](50-tool-contract.md): part 1 (part 2 is in 2.3.12) | D | M | #11 | 6 |
| #20 | [Skill and docs gaps: reset fallback](20-skill-docs-gaps.md) | D | XS | none | 3 |
| #19 | [Registry file exposes the control token](19-registry-token-exposure.md) | E | S | none | 5 |
| #49 | [Serial port release](49-serial-port-release.md): honest port state only | F | XS | none | see 2.3.12 |

## 2.3.12: errors you can see, handles for humans

| Issue | Proposal | WP | Size | Depends on | Decisions |
|---|---|---|---|---|---|
| (budget) | Tool-list budget groundwork. No issue; the costs are itemised in #48, #49 and #16 | G | S | none | none |
| #48 | [One problem journal for agents](48-error-feed.md) (phases 1–2) | H | L | #11, #47 | 6 |
| #15 | [Build error lines in the cmsis_action result](15-build-error-lines.md) | H | M | #47 | 4 |
| #3 | [Probe reconnect after a wedge](03-reconnect-probe.md): phase 1, honest `PROBE_WEDGED` diagnosis | H | S | #11 | 4 |
| #14 | [Control-channel watchdog](14-control-channel-watchdog.md) | I | M | #11 | 5 |
| #16 | [Window selection for humans](16-window-selection-ui.md) | J | M | #11, #19, WP-G | 6 |
| #49 | [Serial port release and serial_capture](49-serial-port-release.md) | K | L | #11, #48, WP-G | 6 |
| #50 | [Tool contract](50-tool-contract.md): part 2, rule files and bypass evals | L | M | #48 | see 2.3.11 |
| #45 | [pyocd called directly](45-pyocd-called-directly.md): closes with the rule files | D, B, L | S | #50, #46 | 3 |

## Future: enabling hooks and proposals owned by others

| Issue | Proposal | WP | Size | Depends on | Decisions |
|---|---|---|---|---|---|
| #41 | [Cross-extension commands for agents](41-cross-extension-commands.md) | M | L (our part M) | #11 | 5 |
| #17 | [Toolchain information](17-toolchain-info.md) as `cmsis_query {what: 'toolchain'}` | M | S | #41 | 4 |
| #3 | [Probe reconnect](03-reconnect-probe.md): phase 2, `cmsis_action reconnect` | N | M | #14, #48 | see 2.3.12 |
| #44 | [SPDX SBOM from build information](44-spdx-sbom.md) | O | M (our part XS) | none | 4 |
| #51 | [Performance optimization workflow](51-performance-optimization-workflow.md) | P | XXL (our part M) | none | 4 |
| #52 | [Statistical PC profiler](52-statistical-profiler.md) | P | XXL (our part M) | none | 4 |
| #50 | [Tool contract](50-tool-contract.md): part 3, process detection and hook pack | none | L | #48 | see 2.3.11 |

## Across releases: owning the codebase

Issue #53 is not on the board; it was added here on 2026-09-23. Its phases are placed so that each group of Microsoft-derived files is rewritten just before the proposals above change it.

| Issue | Proposal | Phases | Size | Depends on | Decisions |
|---|---|---|---|---|---|
| #53 | [Rewrite the remaining MS-derived core (drop MIT lineage)](53-ms-derived-core-rewrite.md) | 0–1 with 2.3.11, 2 in the 2.3.12 cycle, 3–5 after 2.3.12, done as 2.4.0 | XXL | OSPO sign-off | 6 |

## Not release-bound

| Issue | Proposal | WP | Size | Decisions |
|---|---|---|---|---|
| #21 | [Forward sibling-tool findings to their owners](21-sibling-tool-findings.md), with draft issue texts | Q | S | 3 |

## Found while writing these proposals

These are defects in 2.3.10 that no board issue names. Some are fixed inside a proposal above; the rest need an issue of their own.

| Finding | Where | Covered by |
|---|---|---|
| **GDB commands never reach GDB on `gdbtarget`.** `execGdbCommand` sends `-exec <cmd>`, but cdt-gdb-adapter 2.9.1 (the adapter behind the CMSIS Debugger) treats REPL input as a GDB command only when it starts with `>` (`GDBDebugSessionBase.js:1982`). Affected: GDB-native breakpoints and dprintf, `monitor reset` in `reset`, memory-read strategies 2–3, the peripheral reader, and the `-exec` passthrough the agent docs recommend. One live check confirms it. | [debuggingExecutor.ts:432-451](../../src/debuggingExecutor.ts#L432-L451) | **none, needs its own issue**; see #13 and #3 |
| `add_logpoint` sets a model logpoint and a GDB `dprintf`, so a hit may print twice once the finding above is fixed | `debuggingHandler.ts` add_logpoint | none, fix together with the above |
| Every handler error reaches the agent as "Could not reach the VS Code window …", and the router drops its target. Routing is always on, even to the router's own window | [routingDebuggingHandler.ts:123-141](../../src/routingDebuggingHandler.ts#L123-L141) | #11 |
| `flash` cannot find the bundled pyOCD. The CMSIS Debugger adds it to PATH only for terminals and tasks | [flashController.ts](../../src/core/flashController.ts) | #46 |
| The task waiter matches `cbuild setup` runs. A second `build` reports the first build's result. `load` on Arm Debugger adapters waits 57 s for nothing. The fence can fire before the waiter after a target switch | [debuggingHandler.ts](../../src/debuggingHandler.ts) cmsis_action | #47, #12 |
| An unknown MCP session id gets 400 instead of the spec's 404, so clients cannot re-initialize after a failover | [debugMCPServer.ts:1236-1241](../../src/debugMCPServer.ts#L1236-L1241) | #14 |
| `start_debugging` without `configurationName` opens a quick-pick with no timeout, invisible in a worker window | `debugConfigurationManager.ts:100-123` | #14 |
| `WorkspaceRegistry.list()` deletes stale entries while their pid is alive, which hides a wedged router | [workspaceRegistry.ts:168-172](../../src/utils/workspaceRegistry.ts#L168-L172) | #14 |
| Registry directory and files are world-readable on this Mac too (`TMPDIR` folder 0755, files 0644) | `workspaceRegistry.ts`, `atomicFile.ts` | #19 |
| `npm run skills:sync -- --update` fails: upstream cmsis-skills added the `ethos-u` category, which `SkillCategory` rejects | [sync-skills.ts:163-166](../../scripts/sync-skills.ts#L163-L166) | none, small fix; prerequisite for #44 and #51 |
| `read_cycle_counter` is annotated `readOnlyHint: true` but writes DEMCR and DWT_CTRL | [debugMCPServer.ts:631](../../src/debugMCPServer.ts#L631) | #51 (hook H5) |
| The Serial Monitor bridge tells agents to use `serial_read_owned`, which does not exist | [serialMonitorBridge.ts:165](../../src/core/serialMonitorBridge.ts#L165) | none, one-line fix |
| The Pack Docs panel runs any command id its webview posts. The panel is CSP-protected, so the risk is low, but the ids should be allowlisted | `packDocsPanel.ts:247-251` | none, small fix |
| `armDocs.ts` points to `test/transport/arm-catalogue-check.js`, which does not exist | [armDocs.ts:117-123](../../src/core/packDocs/armDocs.ts#L117-L123) | none |
| The `ensureStoppedSession` hints say "start_debugging" for CMSIS projects and never name `pause_execution` | [debuggingHandler.ts:378-384](../../src/debuggingHandler.ts#L378-L384) | #20 |
| Stale counts in comments: the `opTable.ts` header, and the `session-lifecycle.js` "42/44 tools" | `opTable.ts`, `session-lifecycle.js` | WP-G |

## Added 2026-09-28: bootstrap from an empty VS Code window

No issue yet. [bootstrap-empty-vscode.md](bootstrap-empty-vscode.md) covers the state every other document skips: VS Code with no folder open and no project on disk. Phases: 0 documentation and one refusal shape (XS), 1 a bundled `cmsis-bootstrap` skill (M), 2 `cmsis_query`/`open_folder`/`create_solution` with #41 (M), 3 an eval scenario from an empty directory (S). Six decisions.

## Status of the proposals above on 2026-09-28 (fork 2.5.2 + `1e4c50a`)

Nothing has landed upstream since 2.3.10 (`b37a526`); the board still shows every item in Backlog or Triage. On the fork (`pr/2.5.2-tester-feedback`, 69 commits ahead of `upstream/main`):

| Done on the fork, closable once merged | Partly done | Not started |
|---|---|---|
| #11, #12, #13, #14, #15, #16, #19, #20, #45, #46, #47, #49, #53, #56 | #3 (phase 1), #48 (phases 1–2), #50 (parts 1–2), #21 (one upstream ask written, nothing filed) | #17, #41, #44, #51, #52, #54 (license review, OSPO), #55 (guide review) |

## Status on 2026-09-30 (fork 2.5.9)

[bootstrap-empty-vscode.md](bootstrap-empty-vscode.md) phases 0 and 1 are in 2.5.9, with `cmsis_action open_solution`. The skill for creating a project waits as a prepared pull request for cmsis-skills: [cmsis-skills-start-cmsis-project-pr.md](cmsis-skills-start-cmsis-project-pr.md). The issue table above is unchanged.

## Added 2026-10-04: knowledge base

No issue yet. [knowledge-base.md](knowledge-base.md) covers the handover of the knowledge-base prototype (units in Markdown, one SQLite index, `knowledge_search` / `knowledge_get` / `knowledge_expand`): how the index is read inside the extension, behind a flag and parallel to the skills. Phases: 0 what the index has to guarantee (S, knowledge-base side), 1 the three tools (M), 2 the build result names the unit of a known message (S), 3 delivery in the VSIX and in packs (L), 4 benchmarks and retiring skills (M). Eight decisions.

## Added 2026-10-18: CMSIS Solution integration

No issue yet. [cmsis-solution-integration.md](cmsis-solution-integration.md) is a review of CMSIS Solution 1.72.0 against this extension: its public API v2 (boards, devices, examples, `createNewSolution`, `build`) and the commands `installPack`, `getCbuildRunFile`, `getDfpPath` and `getBspPath`. Phases: 0 the window listing names the solution (XS, done), 1 ask the extension instead of guessing the target and the pack folder, `path:` packs included (S), 2 `cmsis_action install_pack`, whose result names the pack's knowledge (M), 3 the catalog and the examples through API v2, with #41 (M), 4 hand-offs and `rebuild`/`clean`/`stop_build` (S). Five decisions. All five phases are in 2.7.0 with the recommended options, checked live once on the micro:bit V2 simulator; the knowledge-base side is open (see the proposal's implementation section).

## Added 2026-10-19: the core knowledge index in CI

No issue yet. [knowledge-index-ci.md](knowledge-index-ci.md): the v2.7.0 CI built VSIX files without `resources/knowledge/core.db`, and the index could only be built on one Mac. Phases: 1 pin the index by version and sha256 (`core.lock.json`, `knowledge:fetch`) and make packaging fail without it (S), 2 a reproducible build recipe, `info` table and licence gate in the knowledge-base repository (S), 3 a release workflow there (M), 4 the extension checks the index version (XS), 5 keeping both repositories in step (S). Phases 1–3 and the schema check of phase 4 are in 2.7.0; phase 5 is open.

## Added 2026-10-21: cross-extension call inventory

Related: #41. [extension-calls.md](extension-calls.md) is an inventory, not a proposal: every call this extension makes into CMSIS Solution, the CMSIS Debugger, the Serial Monitor and VS Code's debug API, with the exact command IDs, arguments, fences and fallbacks, checked against 2.7.0 (`bc23732`). It is the current-state baseline for the commands #41 proposes. The Peripheral Inspector is no longer called (17d9111), and the note says so.

## Added 2026-10-21: Pack Docs document storage

No issue yet. [pack-docs-storage.md](pack-docs-storage.md) describes where Pack Docs keeps originals and derived data today and what an external document manager would have to preserve: the storage classes, the functions it could wrap, document identity, publication and invalidation, and eight acceptance checks before a provider API is exposed. [pack-docs-storage-overview.md](pack-docs-storage-overview.md) is its one-page map. No API is proposed yet; the note is the requirements side.

## Added 2026-10-28: GDB port conflicts

No issue yet. [gdb-port-conflicts.md](gdb-port-conflicts.md) narrows the K04 guard to ports that are certain. Those are `target.port`, a port set on the command line, and the cbuild-run file a `gdbserver` passes; 2.7.0 already does this. Revised 30 October: a custom or user debug setup whose port is unknown is the user's or another extension's to get right. The debug adapter makes its bind failure visible, and a troubleshooting unit of the knowledge base guides the fix; the extension adds no code for it.
