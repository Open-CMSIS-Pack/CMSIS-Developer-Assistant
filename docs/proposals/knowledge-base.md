# Knowledge base: `knowledge_search`, `knowledge_get`, `knowledge_expand` next to the skills

> **Historical proposal; 2.7.0 outcome (2026-10-27).** The three tools are always on and the pinned core index ships in the extension; the feature flags and local-experiment state below are superseded. Procedure sources, assets and routing now belong to cmsis-knowledge-base/sources/cda-procedures; this repository installs only cmsis-help. See [knowledge architecture](../architecture/knowledge.md) for the implementation and the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md) for remaining content and maintenance choices.

| | |
|---|---|
| Issue | none yet (see Decision 8) |
| Area · priority · source | Agent knowledge · Medium · handover of the knowledge-base prototype, 2026-10-04 |
| Original release plan | phases 1–2 in the next pre-release after 2.5.9, flag off by default; phase 3 once reviewed units exist; phase 4 is decided by the benchmarks |
| Size | phase 0 S (knowledge-base side), phase 1 M, phase 2 S, phase 3 L, phase 4 M |
| Depends on | nothing in this repository for phases 1–2; phase 3 on the legal review and the license of the tooling (handover, open decisions 4 and 6) |
| Related | #48 (problem journal), #15 (build error lines), #50 (tool contract: which shell commands a step may name), #17 (reads the same project files), Pack Docs ([docs/architecture/packDocs.md](../architecture/packDocs.md)) |
| Original status | Proposed, awaiting review (2026-10-04). Phases 1 and 2 exist as a local experiment, see below |

## What the local experiment did (2026-10-04)

Phases 1 and 2 are implemented behind `knowledge.enabled`, as the recommendations of Decisions 1 to 5 say; [docs/architecture/knowledge.md](../architecture/knowledge.md) describes the code. Nothing of phase 0 is done: the prototype's `knowledge.db` is read as it is.

- **Runtime (Decision 1):** `node:sqlite`, read-only. Not checked on VS Code 1.109.
- **Entities (Decision 2):** the cores come from the device pack's PDSC on disk, so a knowledge-only index would work; the full index is read too and its entities are used when it has them. The family of a device is taken from the index only.
- **Drafts (Decision 4):** an incomplete unit is recognised by a Cause or body that is one italic line, since the units carry no `cause: missing` yet. `knowledge.includeIncomplete` shows them.
- **Different from the prototype:** a search with a project context but without `tools` does not mark every troubleshooting unit `unverified`. All 402 `applies_to` edges name a tool, and a project has none.
- **Not done:** the clause in the tool contract (the instructions carry the sentence while the gate is on), the `cmsis-help` and guide texts, the entry in the problem journal, the link to Pack Docs (Decision 6), the README.
- **Checked:** for twelve queries the result ids equal those of `kb_lib.py` without vectors. A search with a project context takes about 6 ms on the prototype's index.

## Added 2026-10-06: several indexes

The extension now reads a set of indexes as one: the base file of the setting, the `.knowledge/knowledge.db` of every installed pack (pack root and `.Local/local_repository.pidx`; its units only for projects that use the pack) and `.cmsis/knowledge.db` of the workspace. Ranked lists are merged by rank; a hit names the index it came from. The knowledge base builds a core index and a documentation index (`scripts/build_split.sh`), the latter installed as the test pack `Local::CMSIS_Knowledge@1.0.0`. This is phase 3 without the bundling.

## Problem

The extension gives agents two kinds of knowledge today:

- **What**: the documentation tools over the target's manuals and SVDs (Pack Docs), on by default since 2.5.3.
- **How**: Agent Skills, 22 of them vendored from cmsis-skills at `d778b91`, plus the extension's own, plus three router skills. A skill is loaded whole or not at all, by its description.

Three things do not fit into skills:

- **Error messages.** `cmsis_action build` shows the csolution message of a failed build (#15), and nothing says what causes it or how to fix it. packchk and svdconv messages have a documented cause in their READMEs that no agent finds.
- **Knowledge that depends on the project**: a rule that holds for Cortex-M55 with AC6 only, a procedure for one device family. A skill description cannot filter on the active target.
- **Small local models.** The skill descriptions alone are several kilobytes per turn, and a skill body arrives in full. The handover's requirement is: summaries first, full text on request.

The prototype in `cmsis-knowledge-base` (handover of 2026-10-04) answers these with knowledge units in Markdown, one SQLite index and three MCP tools. Its next step 3 asks for the index to be wired into this extension behind a feature flag, parallel to the skills. This proposal says how.

## Current state

### The prototype (checked on 2026-10-04, in the handed-over folder)

- **Content.** 550 knowledge units, all `status: draft`: 397 troubleshooting, 120 rules, 24 procedures, 8 concepts, 1 pattern. Their bodies total 288 kB. 26 903 entities from the pack index and the PDSC files.
- **Index.** `build/knowledge.db`, 26.2 MB. Edges and their indexes take 17.3 MB, nodes 6.7 MB, the vectors 1.6 MB, the FTS5 index 0.6 MB. So about 24 MB are the entity graph.
- **What the entity graph is used for today.** All 402 `applies_to` edges point at a `tool:` entity. No unit targets a device, core, family or component yet; the filter by device is proven only by the fixtures in `tests/`.
- **Server.** `tools/kb_server.py`, Python, MCP over stdio, with `pyyaml`, `sqlite-vec`, `fastembed` (model download of about 130 MB on first start) and `mcp`. `KB_NO_VEC=1` gives BM25 only.
- **Tests.** With the system Python 3.13 and no venv, every check of `tests/test_kb.py` passes except the MCP round trip, which did not run: the `mcp` module is not installed, and I installed nothing.
- **The folder is not a Git repository.** Decision 2 of the handover puts the units in Git; where is open (Decision 7 below).

### This extension

- **A tool group is a known shape.** Serial, documentation and build-artefact tools each have a setting read at activation, an op list in [opTable.ts](../../src/core/opTable.ts#L98-L131), a handler without `vscode`, a dispatch and a registration in [debugTools.ts:775-779](../../src/debugTools.ts#L775-L779). Ops are forwarded to the window that owns the workspace.
- **The project context is already resolved here.** Pack Docs reads the active `*.cbuild-run.yml` and the pack's PDSC ([cbuildRun.ts:143](../../src/core/packDocs/cbuildRun.ts#L143), `targetDocs.ts`); the build diagnosis reads `cbuild-idx.yml` and each context's `cbuild.yml` ([buildFailure.ts:318-350](../../src/core/buildFailure.ts#L318-L350)). No tool of ours takes a file path for the target.
- **The tool list is budgeted**: 32 000 B single-window, 34 000 B routed, 44 000 B with every group on (`test/transport/session-lifecycle.js`, `two-window-routing.js`).
- **The VSIX is 3.3 MB.** `serialport` is the only native dependency.
- **SQLite is available without a dependency.** Measured with `ELECTRON_RUN_AS_NODE` on VS Code 1.137 (Electron 42.10, Node 24.18.1, SQLite 3.53.1) and on Node 22.23.2: `node:sqlite` opens `knowledge.db` read-only, and the prototype's FTS5 query with `bm25()` and the `porter` tokenizer returns the same five ids in 0.5 ms. `json_extract` works. `nodes_vec` fails with "no such module: vec0", as expected without the sqlite-vec binary. **Not checked:** VS Code 1.109, the minimum in `engines`.

## Proposed fix

### Phase 0: what the index has to guarantee (knowledge-base side)

Before any agent reads the units through this extension:

1. **English unit text.** 400 unit bodies carry German placeholders that an agent would read as content: `_offen, im Review ergänzen_`, `_siehe Cause_`, `## Trigger im Quelltext`, `_Kanonischer Text: wird von Hand geschrieben._`. A unit without a cause says so in a frontmatter field (`cause: missing`), not in the body.
2. **An index contract.** The `info` table gains `schema_version`, the build date and the source revisions (cmsis-skills, devtools, pack index). The extension refuses another major version with a typed error.
3. **`symptom_regex` must compile as a JavaScript `RegExp`.** `build_index.py` checks Python's `re` only; the two differ.
4. **A knowledge-only build**, see Decision 2.

### Phase 1: the three tools behind a flag

1. **Setting `cmsis-developer-assistant.knowledge.enabled`**, default `false`, read at activation like `packDocs.enabled`, with the same reload offer. **`knowledge.indexPath`** names the `knowledge.db`; nothing is bundled while every unit is a draft.
2. **Pure core `src/core/knowledge/`**, no `vscode` import:
   - `store.ts` opens the file read-only with `node:sqlite`, loaded on first use. If the module is missing, the tools answer with a `ToolError` that names the VS Code version needed.
   - `search.ts` ports `kb_lib.py`: the exact-symptom match per line of tool output, BM25 with the prototype's column weights, the `applies_to` filter (AND across dimensions, OR within one, `unverified` when the context does not cover a dimension), `refines`, and the token budget. No vectors (Decision 3).
   - `context.ts` builds the entity set of the active target: device, board, compiler and components from the cbuild files the extension already parses, core and family from the PDSC of the installed or local pack. This replaces the `cbuild` argument and makes `overlay.py` the rule instead of the exception (Decision 2).
3. **`KnowledgeHandler`** with `handleKnowledgeSearch`, `handleKnowledgeGet`, `handleKnowledgeExpand`, under the fence and trace of `src/core/toolRun.ts`. `KNOWLEDGE_OPS` joins the op table and is forwarded like the Pack Docs ops.
4. **Tool surface**, trimmed against the budget:
   - `knowledge_search {query, tools?, types?, domain?, k?}`. The project context is applied automatically and named in the reply; `device`, `components`, `compiler`, `cbuild` and `budget_tokens` are not arguments.
   - `knowledge_get {id}`: the whole unit, never clipped (handover decision 5).
   - `knowledge_expand {id, relation?}`: one hop, with a cap and a count of what was left out. The prototype returns up to 200 neighbours without a budget, which a pack entity reaches.
   - Replies are `ToolReply {text, data}` like every other tool: a compact text for the model, the prototype's JSON as `structuredContent`. Every hit carries its `status`.
5. **Tool contract.** The rule "Run `cbuild`, `csolution` or `cpackget` in a shell only when … a CMSIS skill step names the command" ([tool-contract.md:26](../agent-resources/tool-contract.md#L26)) has to cover a procedure read through `knowledge_get` as well. One clause, inside the ten lines and 1 600 bytes.
6. **Guidance.** One sentence in the server instructions when the flag is on, a `knowledge` line in `cmsis-help`, and a paragraph in the `troubleshooting` topic of `debug_instructions.md`.

### Phase 2: the build result names the unit

A failed `cmsis_action build` already lists the csolution messages. For each message the diagnosis runs the exact-symptom match and appends one line, for example `known message: knowledge_get {id: "ts-csolution-board-mounted-device"}`. The same goes into the entry of the problem journal. Only units that have a cause are named. This is where the knowledge base pays first, and it costs the agent no search.

### Phase 3: delivery

- **Baseline index in the VSIX**, built from reviewed units at a pinned revision, in the way `skills/cmsis-skills.lock.json` pins the skills.
- **Packs with a `knowledge/` folder** (handover decision 6): indexed on first use into `globalStorage`, next to the Pack Docs page store, for the packs of the active target.
- **`kb-entities.yml`** for devices that only have documentation; its `docs` entries are handed to Pack Docs as workspace documents, so their text is indexed there (handover, known issue 9).

### Phase 4: benchmarks and the skills

- The retrieval benchmark of the handover runs in the knowledge-base repository on every index build. The agent-task benchmark compares no help, today's skills and the knowledge base.
- When a skill's procedure wins, the skill becomes a stub that points to `knowledge_get`, then goes. The three router skills stay and name the tools. Skills of the extension itself (`cmsis-debug-live`, `cmsis-bootstrap`, the debugger setup skills) are not in the knowledge base and stay skills until someone migrates them.

## What changes for the agent and the user

```text
cmsis_action build fails: "error csolution: board mounted device STM32U585AIIx not found"

2.5.9    the message, and the agent guesses or searches the web

new      … board mounted device STM32U585AIIx not found
         known message: knowledge_get {id: "ts-csolution-board-mounted-device"}

         knowledge_get → Symptom, Cause (the STM32U5 DFP is not installed, or packs: lists only the BSP), Fix

"How do I add debug sequences for this device?"

new      knowledge_search {query: "debug sequences"} →
         context: STM32U585AIIx, Cortex-M33, GCC (active target)
         proc-generate-debug-sequences  procedure  draft  about 1 100 tokens
           Adds evidence-backed, device-specific non-trace debug sequences to an existing DFP …
         … 4 more, 525 tokens in all
```

The cause text in the first example exists only in the handover, not in the unit: all 134 csolution units are without cause and fix.

## Decisions for you

- [ ] **1. Runtime.** **Recommended:** in-process, `node:sqlite`, read-only. No Python, no native module, no second MCP server; 0.5 ms per query; routed and typed like every other tool. Needs a check on VS Code 1.109 or a raised `engines.vscode`.
  - Alternative a: start `kb_server.py` as a child process. Keeps one implementation, but needs Python, a venv and four packages on the user's machine, which the tool rules ("never install") and the handover's own `rule-no-install` argue against.
  - Alternative b: no SQLite; a JSON index over the units with the existing `bm25Index.ts` and tokenizer. 550 units fit easily, and nothing depends on an experimental Node module. It departs from handover decision 3 (one SQLite file).
- [ ] **2. Entities.** **Recommended:** the shipped index holds the units, their edges and the small closed entity sets (tools, toolchains, cores). Device, family, pack and component of the *active target* are resolved at run time from the PDSC files on disk, which the extension reads anyway. About 2 MB instead of 26 MB, no pack index that ages inside a VSIX, and unreleased devices need no special path.
  - Alternative: ship the full graph. Answers questions about devices that are not installed, with 26 MB uncompressed next to today's 3.3 MB VSIX, and with an index build for every pack release.
- [ ] **3. Embeddings.** **Recommended:** BM25 and exact symptoms only, until the golden set shows what vectors add in Recall@5. Vectors need the sqlite-vec binary per platform and an embedding model in Node (130 MB in the prototype).
  - Alternative: ship both from the start, as in the prototype.
- [ ] **4. Drafts.** **Recommended:** with the flag on, drafts are searchable and labelled `draft`; units without a cause are left out of search results and never named by the build result. The flag stays off by default until the pilot domain is reviewed.
  - Alternative: reviewed units only. Nothing would be visible today.
- [ ] **5. Tools.** **Recommended:** the three tools of handover decision 4, with the trimmed arguments above. Measure the list before raising a budget.
  - Alternative: one tool `knowledge {action: search | get | expand}`, about a third of the bytes, and less obvious to small models.
- [ ] **6. Link to Pack Docs** (handover, open decision 2). **Recommended:** a unit's `references` use the document ids that `list_target_docs` prints, without a pack version, and `knowledge_expand` renders each as a ready `search_target_docs` or `read_doc_pages` call (the pattern of `toolLinks.ts`). The prototype's hashed ids (`doc:2bee825a9e80`) cannot be joined.
  - Alternative: keep the hashed ids and add a lookup table to the index.
- [ ] **7. Repository.** **Recommended:** a repository of its own for units and Python tooling; this extension consumes a released index at a pinned revision, and that revision's cmsis-skills commit must equal the one in `skills/cmsis-skills.lock.json` while both ship (today `25c2085` against `d778b91`).
  - Alternative: units and tooling in this repository. One pin fewer, but Python tooling, German design documents and a license still to be decided would enter an Apache-2.0 TypeScript repository.
- [ ] **8. Issue.** **Recommended:** one issue on the board for phases 1–2, a second for delivery (phase 3).

## Tests and acceptance

- **Unit, new `src/test/knowledge*.test.ts`**, on a fixture index of a few units built from `tests/fixtures/units` of the prototype and committed as a file:
  - the cases of `tests/test_kb.py` that concern retrieval: exact symptom first, also with the `error csolution:` prefix and two lines; `M302` ambiguous without `tools` and resolved with it; AND across dimensions; `refines`; `unverified` and `context_unresolved`; the budget; `knowledge_get` unclipped;
  - an unknown schema version, a missing file and a missing `node:sqlite` each give a typed error;
  - `knowledge_expand` caps and counts.
- **Parity.** A script runs the same queries through `kb_lib.py` (`use_vec=False`) and the TypeScript port and compares the ids. It runs where Python is at hand, not in CI.
- **Routing.** `src/test/routing.test.ts`: the three ops are in the op table and reach the knowledge handler of the right window.
- **Surface.** With the flag off, `tools/list` and the instructions are unchanged, byte for byte. With it on, exactly three tools more, inside the all-on budget or with the budget raised in the same commit; `surface.snapshot.json` updated.
- **Build link.** `dap-scenarios` or a diagnosis unit test: a `cbuild-idx.yml` with a known message yields the `known message` line; a unit without a cause yields none.
- **Live.** The corstone-blinky fixture with a pack removed from `packs:`.

## Found while checking the handover

| Finding | Where | Covered by |
|---|---|---|
| "Cause/fix from READMEs for 214" counts the `documented` flag. Only 136 bodies have a cause (packchk 85, svdconv 51); 78 svdconv units are `documented: true` with an open cause. 261 of 397 units are open | `tools/errcat.py`, `units/troubleshooting/` | Phase 0; Decision 4 hides them |
| German placeholder text in 400 unit bodies | `errcat.py`, `stage2_merge.py` | Phase 0 |
| The three canonical rules have no text; the two extracted units are named `x-add-cmsis-target-1` and `-2` | `units/canonical/`, `units/extracted/` | handover, open decision 3 |
| The handover's table gives the stage 1 counts (117 rules, 7 concepts); the index holds 120 rules, 8 concepts and 1 pattern after the stage 2 merge | `HANDOVER.md` | none, a note |
| `requirements.txt` has lower bounds only, so the index build is not reproducible | `requirements.txt` | Decision 7 |

## Out of scope and follow-ups

- Writing cause and fix for the csolution units, stage 2 for the remaining 20 procedures, the canonical rule texts, the NPU entity type, the vendor-spelling check: all knowledge-base work from the handover.
- Migrating this extension's own skills and guides into units.
- The legal review and the license of the tooling. Until both are settled, nothing from the knowledge base ships in a VSIX.
- Opt-in usage data as a source of real questions.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
