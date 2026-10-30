# #53 Rewrite the remaining MS-derived core to fully own the codebase (drop MIT lineage)

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** The independent source rewrite is complete; [provenance records](../provenance/README.md) retain the evidence. The separate license review is not resolved by that source-code result. The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#53](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/53) (not on the project board yet) |
| Area · priority · source | Provenance (no board area fits; proposed "Agent setup" or a new "Codebase" area) · Medium (proposed) · Maintainer |
| Original release plan | Spread over three releases: phases 0–1 alongside 2.3.11, phase 2 in the 2.3.12 cycle, phases 3–5 after 2.3.12; completion proposed as 2.4.0 |
| Size | XXL (phase 0 M, phase 1 L, phase 2 L, phase 3 XL, phase 4 S, phase 5 XS) |
| Depends on | Arm OSPO/legal sign-off on the method (Decision 2) and on the outbound licence (Decision 3) |
| Related | #11, #13, #14, #16, #19, #47, #49, #50 (all change the files in scope); codebase review items 3.3, 3.4, 3.5 and 5.1 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

About 8.6 k lines in 20 TypeScript files still descend from [microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) (MIT). They carry the Microsoft copyright line, keep `LICENSE-MIT` and the NOTICE attribution in the product, and keep the project formally a derivative work. Upstream sync stopped at v2.3.1 (`148cbb9a`, 2026-08-20), so the lineage no longer brings merges in, only obligations.

Measured against `148cbb9a`, 1 319 of the 6 540 code lines in those files (20 %) are still identical. The rest has been rewritten over 2.1–2.3.10, but the architecture is still DebugMCP's: the handler / executor / server split and its method names. A clean provenance story therefore needs independent reimplementation, not more editing.

Corrections to the issue text:

- The scope misses non-TypeScript files that are 50–100 % identical: architecture docs, the language troubleshooting guides, `eslint.config.mjs`, `.gitignore`, `tsconfig.json`, `esbuild.js` and `AGENTS.md`. It also misses `scripts/test-skill-trigger.ts`, a TypeScript port of DebugMCP's `test-debug-skill-trigger.js`.
- `TPIP.md` already has no DebugMCP entry; its only Microsoft line is the `jsonc-parser` dependency, which stays. The attribution to remove sits in `NOTICE`.
- The product is not "Apache-2.0" today: `package.json` declares `"Apache-2.0 OR MIT"`. Dropping the MIT *lineage* and dropping the MIT *outbound option* are two separate decisions (Decision 3).
- This issue is the only open issue that is not on the project board, so the release plan did not include it.

## Current state (2.3.10)

- **Files with the Microsoft header.** Share of non-trivial code lines identical to DebugMCP `148cbb9a`, compared with a line-sequence match (`difflib.SequenceMatcher`, comments and brace-only lines excluded):

  | File | Lines | Code lines | Identical | % |
  |---|---:|---:|---:|---:|
  | [src/utils/logger.ts](../../src/utils/logger.ts) | 114 | 70 | 65 | 92.9 |
  | [src/utils/secretRedaction.ts](../../src/utils/secretRedaction.ts) | 204 | 126 | 106 | 84.1 |
  | [src/test/secretRedaction.test.ts](../../src/test/secretRedaction.test.ts) | 243 | 158 | 117 | 74.1 |
  | [src/debugState.ts](../../src/debugState.ts) | 266 | 183 | 134 | 73.2 |
  | [src/utils/workspaceRegistry.ts](../../src/utils/workspaceRegistry.ts) | 283 | 189 | 89 | 47.1 |
  | [src/controlServer.ts](../../src/controlServer.ts) | 174 | 115 | 43 | 37.4 |
  | [src/utils/agentConfigurationManager.ts](../../src/utils/agentConfigurationManager.ts) | 1 118 | 735 | 193 | 26.3 |
  | [src/test/debugSkillGuidance.test.ts](../../src/test/debugSkillGuidance.test.ts) | 92 | 58 | 13 | 22.4 |
  | [src/extension.ts](../../src/extension.ts) | 308 | 169 | 32 | 18.9 |
  | [src/debuggingExecutor.ts](../../src/debuggingExecutor.ts) | 1 540 | 1 023 | 190 | 18.6 |
  | [src/routingDebuggingHandler.ts](../../src/routingDebuggingHandler.ts) | 361 | 229 | 35 | 15.3 |
  | [src/debugMCPServer.ts](../../src/debugMCPServer.ts) | 1 419 | 928 | 102 | 11.0 |
  | [src/debuggingHandler.ts](../../src/debuggingHandler.ts) | 2 337 | 1 550 | 147 | 9.5 |
  | [src/utils/debugConfigurationManager.ts](../../src/utils/debugConfigurationManager.ts) | 453 | 291 | 22 | 7.6 |
  | [src/test/workspaceRegistry.test.ts](../../src/test/workspaceRegistry.test.ts) | 250 | 165 | 9 | 5.5 |
  | [src/test/routing.test.ts](../../src/test/routing.test.ts) | 479 | 335 | 8 | 2.4 |
  | [src/test/debuggingHandler.test.ts](../../src/test/debuggingHandler.test.ts) | 227 | 151 | 2 | 1.3 |
  | [src/index.ts](../../src/index.ts), [src/test/extension.test.ts](../../src/test/extension.test.ts) | 29 | 12 | 12 | 100 |
  | [scripts/test-skill-trigger.ts](../../scripts/test-skill-trigger.ts) | 73 | 53 | 0 | port of `scripts/test-debug-skill-trigger.js` |
  | **Total** | | **6 540** | **1 319** | **20.2** |

- **Other files with DebugMCP content** (same method, blank lines excluded):
  - Architecture docs: [debuggingExecutor.md](../architecture/debuggingExecutor.md) 100 %, [debuggingHandler.md](../architecture/debuggingHandler.md) 95 %, [debugState.md](../architecture/debugState.md) 90 %, [debugMCPServer.md](../architecture/debugMCPServer.md) 50 %, [debugConfigurationManager.md](../architecture/debugConfigurationManager.md) 29 %.
  - Language troubleshooting guides, 86–94 %: `csharp.md`, `cpp.md`, `java.md`, `go.md`, `javascript.md`, `python.md` in [docs/agent-resources/troubleshooting/](../agent-resources/troubleshooting/), plus the `cpp.md` copy in [skills/cmsis-debug-live/references/troubleshooting/](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/tree/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/references/troubleshooting).
  - Build and repo files: [eslint.config.mjs](../../eslint.config.mjs) 100 %, [.gitignore](../../.gitignore) 93 % (its inherited `[Bb]uild[Ll]og.*` pattern swallowed `buildLog.ts` in the 2.3.9 incident), [tsconfig.json](../../tsconfig.json) 67 %, [esbuild.js](../../esbuild.js) 52 %, [AGENTS.md](../../AGENTS.md) 60 %.
  - Low overlap, rewrite with the rest: [README.md](../../README.md) 11 %, [skills/cmsis-debug-live/SKILL.md](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/SKILL.md) 10 %.
- **Licence and attribution:**
  - [LICENSE-MIT](../../LICENSE-MIT) is Microsoft's MIT text ("Copyright (c) Microsoft Corporation").
  - [NOTICE:15-22](../../NOTICE#L15-L22) carries the DebugMCP attribution.
  - [package.json:7](../../package.json#L7) declares `"Apache-2.0 OR MIT"`.
  - [CHANGES-VS-UPSTREAM.md](../../CHANGES-VS-UPSTREAM.md) records provenance; §9 says secret redaction was "ported nearly verbatim" ([:212](../../CHANGES-VS-UPSTREAM.md#L212)).
- **The header rule is stale.** [AGENTS.md:48-54](../../AGENTS.md#L48-L54) tells every agent to put `// Copyright (c) Microsoft Corporation.` into *each* source file. The Arm-original files use the Arm Apache block instead ([src/core/toolRun.ts:1-4](../../src/core/toolRun.ts#L1-L4)). An agent following AGENTS.md literally spreads the Microsoft line into new Arm files.
- **Conflict with the release plan.** The 2.3.11 and 2.3.12 proposals change most of these files:

  | File | Changed by |
  |---|---|
  | `debuggingHandler.ts` | #11, #12, #13, #46, #47, #15, #20, #3 |
  | `debuggingExecutor.ts` | #13, #3, the `-exec` finding in the [index](README.md) |
  | `debugMCPServer.ts` | #11, #12, #50, #48, #49, #16, #14 (404) |
  | `routingDebuggingHandler.ts`, `controlServer.ts` | #11 (envelope v2), #14, #16, #19, #49 |
  | `workspaceRegistry.ts` | #19, #14, #16 |
  | `agentConfigurationManager.ts` | #50 part 2 (rule files) |
  | `debugConfigurationManager.ts` | #14 (picker fence) |
  | `extension.ts` | #16, #49 (status-bar items) |
  | `logger.ts`, `debugState.ts`, `secretRedaction.ts`, `index.ts` | none |

## Proposed fix

The principle from the issue stays: the rewrite changes no behaviour, each PR is behaviour-neutral and reviewable as such, and the fixes on the board stay separate PRs. What this proposal adds is the order, so that no file is rewritten twice and no fix is written into code that is about to be replaced.

1. **Phase 0, now, alongside 2.3.11 (M).** Nothing here conflicts with the board.
   - Fix the header rule in AGENTS.md: new files get the Arm Apache header only; the Microsoft line is kept only on files still in the allowlist below.
   - Offline guard test `src/test/provenance.test.ts`: the set of files containing `Copyright (c) Microsoft Corporation` must be a subset of a recorded allowlist. Each phase removes its files from the list; the list must be empty at the end. This also stops new files from picking up the line.
   - Opt-in `npm run provenance:check` (`scripts/provenance-check.ts`): clones DebugMCP at the pinned `148cbb9a` into a cache directory and prints the per-file table above. It needs network, so it is not part of CI. It is the acceptance tool for every rewrite PR.
   - Rewrite the four files the board does not touch: `index.ts`, `logger.ts`, `debugState.ts`, and `secretRedaction.ts` with its test. Secret redaction goes first because §9 records it as ported nearly verbatim; reimplement it from its policy and its test cases, not from the file.
2. **Phase 1, after 2.3.11 ships and before the 2.3.12 transport work (L).** Rewrite `controlServer.ts`, `utils/workspaceRegistry.ts` and `routingDebuggingHandler.ts` with `routing.test.ts` and `workspaceRegistry.test.ts`.
   - The #11 envelope v2 and the #19 file modes will have landed by then; the rewrite carries them as existing behaviour, pinned by their tests.
   - #14 (watchdog, health op), #16 (ladder, default pin) and #49 (`sessionEnded`) are then implemented on the new code.
3. **Phase 2, early in the 2.3.12 cycle (L).** Rewrite `utils/debugConfigurationManager.ts`, `utils/agentConfigurationManager.ts` and `extension.ts`.
   - `agentConfigurationManager.ts` goes before #50 part 2 adds the rule-file step; `extension.ts` goes before #16 and #49 add status-bar items.
   - Add the characterization tests the issue asks for first: launch-config generation and parsing, the eight agent config writers, and the Codex TOML upsert (codebase review item 4.1).
4. **Phase 3, after 2.3.12 (XL).** Rewrite `debuggingExecutor.ts`, `debuggingHandler.ts` and `debugMCPServer.ts`.
   - By then #11 (`core/toolResult.ts`), #47 (`core/cmsisTasks.ts`, `CmsisJobTracker`) and #13 have moved result handling, task tracking and run-state gating into Arm-authored modules, which shrinks what is left.
   - Use a new module layout as the target instead of the old three classes: codebase review 3.5 (tool registration into `src/debugTools.ts`, then per-area modules) and 3.4 (the GDB word-read ladder into `src/core/gdbMemory.ts`). The MCP surface stays byte-identical: tool names, schemas, descriptions, resource URIs, setting ids.
   - Fix the `-exec` finding from the [index](README.md) before this phase, so the characterization tests pin the corrected GDB passthrough rather than the broken one.
5. **Phase 4, any time after the file it describes is rewritten (S).**
   - Rewrite the architecture docs (codebase review 5.1); `debuggingExecutor.md`, `debuggingHandler.md` and `debugState.md` after phase 3.
   - Language troubleshooting guides: see Decision 4.
   - Write `eslint.config.mjs`, `tsconfig.json`, `esbuild.js` and `.gitignore` fresh. For `.gitignore`, list only what this repo produces; that also removes the pattern class behind the 2.3.9 incident.
   - Rewrite `AGENTS.md` and the README's "fork of microsoft/DebugMCP" wording.
6. **Phase 5, close-out (XS, after OSPO sign-off).**
   - Empty the allowlist.
   - Apply Decision 3 to `LICENSE-MIT`, `package.json` and the NOTICE licence lines.
   - Reduce NOTICE:15-22 to one historical line, or remove it, as legal advises.
   - Archive `CHANGES-VS-UPSTREAM.md` as a short history note and rename `docs/DebugMCP-brief-feature-inventory.md`.
   - Delete the git `upstream` habit for DebugMCP from the status notes.

**How each rewrite PR is made (Decision 2).**

- Write a short behaviour spec for the file from its tests, the docs and the tool descriptions, not from the old source.
- Implement from the spec in a new file without the old file open. Internal names and module boundaries are free to change.
- Run `npm test`, `npm run test:transport`, `test/realboard/run.ts` for anything on the DAP path, and `npm run provenance:check`. Target: no identical non-trivial lines beyond unavoidable API boilerplate such as `import * as vscode from 'vscode';`.
- Drop the Microsoft line and the allowlist entry in the same PR.

## What changes for the agent and the user

```text
Agents and users: nothing. Same tools, schemas, descriptions, settings and behaviour in every phase.

Repository, 2.3.10                              after phase 5
  20 files with "Copyright (c) Microsoft"        0
  LICENSE-MIT (Microsoft text)                   removed, or replaced by an Arm MIT text (Decision 3)
  NOTICE: "derived from DebugMCP …"              one historical line, or nothing
  CHANGES-VS-UPSTREAM.md, 219 lines              short history note
  AGENTS.md: "Microsoft header in each file"     "Arm Apache header"
```

## Decisions for you

- [ ] **1. Order relative to the board fixes.** **Recommended:** interleave by file group as in phases 0–3. The P1 fixes (#11, #12, #13, #46, #47) land first on the three core files, and the smaller groups are rewritten just before the proposals that touch them. The fixes' new tests then become the behavioural contract for the rewrite.
  - Alternative: rewrite first. This delays the P1 fixes by weeks and rewrites code the fixes then change again.
  - Alternative: let the rewrite carry the fixes. Saves some work, but mixes behaviour changes into PRs that should be reviewable as behaviour-neutral, which weakens the provenance record.
- [ ] **2. How independent the rewrite must be.** **Recommended:** spec-first reimplementation as described above, with internal names and module layout free to change, the MCP surface fixed, and the method confirmed by Arm OSPO before phase 0 starts.
  - Alternative: refactor in place until `provenance:check` shows near-zero identical lines. Cheaper, but the class structure stays DebugMCP's, which is the weaker story if provenance is ever questioned.
- [ ] **3. Outbound licence afterwards.** *(2026-09-23: moved to the license review, issue #54; the license files stay unchanged until then.)* **Recommended:** decide it explicitly with OSPO, separately from the rewrite. Apache-2.0 only matches the rest of Open-CMSIS-Pack and the issue's intent.
  - Alternative: keep `Apache-2.0 OR MIT` for users who rely on the MIT option. `LICENSE-MIT` then needs an Arm MIT text instead of Microsoft's.
- [ ] **4. The non-embedded language troubleshooting guides.** **Recommended:** delete `python.md`, `javascript.md`, `java.md`, `go.md` and `csharp.md` (codebase review 3.3), and fold the useful part of `cpp.md` into `embedded.md`. The product is Cortex-M focused and these guides are almost entirely DebugMCP text.
  - Alternative: rewrite all six. This keeps the general multi-language guidance AGENTS.md still promises, at the cost of maintaining text nobody tests.
- [ ] **5. Release marker.** **Recommended:** ship phase 5 as 2.4.0, the first even-minor (non-pre-release) version, with "fully Arm-authored" in the notes.
  - Alternative: no marker; the last phase goes out in whatever 2.3.x is next.
- [ ] **6. Board placement.** **Recommended:** add #53 to the board with area "Agent setup" (or a new "Codebase" area), Version "Future", Size XXL, and one sub-issue per phase so each phase can take its own Version.
  - Alternative: keep it off the board as a standing maintainer task.

## Tests and acceptance

- The acceptance criteria from the issue, corrected:
  - No file under `src/`, `scripts/` or `test/` contains `Copyright (c) Microsoft Corporation`. This is enforced by `src/test/provenance.test.ts` with an empty allowlist.
  - `LICENSE-MIT`, `package.json` `license` and `NOTICE` follow Decision 3. The TPIP criterion is dropped, because `TPIP.md` never listed DebugMCP; the `jsonc-parser` dependency line stays.
  - `CHANGES-VS-UPSTREAM.md` archived as a history note.
  - All existing tests and `test/realboard` pass unchanged; lint and compile are clean.
- Per rewrite PR:
  - `npm test`, `npm run test:transport`, `node test/transport/packaged-vsix.js <vsix>`.
  - `test/realboard/run.ts` on a probe board for anything on the DAP path (executor, handler, control channel).
  - `npm run provenance:check` output attached to the PR.
- MCP surface check per phase: `tools/list` from the transport test is byte-identical before and after. Add this as an assertion that compares against a snapshot committed in phase 0 and updated only by the board proposals, never by a rewrite PR.
- Live after phase 3, on the FVP corstone-blinky fixture and one probe board: the 2.3.11 live checklist from the release plan passes unchanged.

## Out of scope and follow-ups

- Behaviour changes of any kind: they stay with their own issues (#11 … #50).
- Past releases and git history stay as they are. They were published under the old licence terms and remain valid.
- The vendored cmsis-skills content is Arm's and needs nothing.
- Dependencies from Microsoft, such as `jsonc-parser` and `@types/vscode`, are ordinary third-party components and stay in `TPIP.md`.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
