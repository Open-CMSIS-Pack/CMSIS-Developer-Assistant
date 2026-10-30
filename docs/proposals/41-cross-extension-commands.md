# #41 Proposal: expose selected cross-extension VS Code commands to AI agents through MCP

> **2.7.0 status (2026-10-27).** cmsis_query exists for boards, devices and examples; the context/toolchain query shapes below remain proposed. The new-tool checklist below predates the knowledge-source move and is not current wiring guidance. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#41](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/41) |
| Area · priority · source | Cross-extension API for agents · Medium · external proposal (brondani, CMSIS Solution team) |
| Original release plan | Future (WP-M) |
| Size | L (our part M; the owner-side contract is separate) |
| Depends on | #11 (`ToolReply.data`, `structuredContent`, envelope v2) |
| Related | #17 (folds in as `what: 'toolchain'`), #48 phases 3–4 (sibling `getRecentProblems` contract), #21 (requests to owners), #50 (fewer reasons to leave the MCP path) |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

Agents rebuild state that our extensions have already resolved: the active solution and target, device, board, packs, generated paths and toolchain. They do it by reading YAML, globbing `out/` and searching PATH. That costs calls and tokens, and it can disagree with what the extension actually uses.

**What the proposer asks for:**

- The CMSIS Developer Assistant MCP server becomes the agent-facing bridge to selected `vscode.commands.executeCommand` queries of our own extensions.
- The bridge is an **explicit allowlist**, not a generic `execute_vscode_command`.
- Each command has stable IDs, defined argument and return types, JSON-serialisable values, documented errors and clear read-only or state-changing semantics.
- Results stay structured (`structuredContent`, with text as a fallback) all the way through the router.
- Optionally, a shared TypeScript package holds the IDs and types.

Verified in 2.3.10: the mechanism works, we use it in five places, but only with strings. The control envelope and every handler seam carry strings only. No tool exposes these values.

## Current state (2.3.10)

- **Where we already call CMSIS Solution:**
  - `getSolutionFile` with a 5 s fence in [debuggingHandler.ts:1741-1765](../../src/debuggingHandler.ts#L1741-L1765).
  - `getActiveTargetSet` in [:1772-1784](../../src/debuggingHandler.ts#L1772-L1784).
  - `deactivateSolution` / `activateSolution` for target switching in [:1835-1839](../../src/debuggingHandler.ts#L1835-L1839).
  - `getSolutionFile` and `getActiveTargetSet` with a 3 s fence in [packDocsHost.ts:94-99](../../src/packDocsHost.ts#L94-L99).
  - `getPackRootPath` with a 3 s fence, memoised, in [toolchainPackRoot.ts:43-54](../../src/utils/toolchainPackRoot.ts#L43-L54).
  - Each call site has its own fence and its own parsing. Two of them guess whether `getSolutionFile` returns a string or an object.
- **What CMSIS Solution 1.70.1 offers.** It contributes 16 `get*` commands. Read from its bundle (`dist/extension.js`), they are string resolvers built for `${command:…}` substitution in `launch.json`; its debug templates use `${command:cmsis-csolution.getCbuildRunFile}`. Their behaviour:
  - Every command returns a string, and `""` when no solution is loaded.
  - `getDfpPath` and `getBspPath` return the sentinel `"<not found>"`.
  - `getBinaryFiles` returns a **JSON-encoded string** of an array.
  - `getSolutionPath` is registered to the same handler as `getSolutionFile`, so it returns the file, not the folder.
  - `getInfoPath` returns the output folder of the clangd context, not the active target.
  - `getTargetPack` equals `getDfpName`.
- **No structured results yet.** Structured results need #11: `ToolReply.data` → `structuredContent`, and envelope v2 through the router ([controlServer.ts:119-126](../../src/controlServer.ts#L119-L126), [routingDebuggingHandler.ts:175-183](../../src/routingDebuggingHandler.ts#L175-L183) are string-only today).
- **The closest tool needs a session.** `get_device_info` throws without one and returns launch-configuration fields plus the CMSIS target ([debuggingHandler.ts:1600-1613](../../src/debuggingHandler.ts#L1600-L1613), [debuggingExecutor.ts:1516-1539](../../src/debuggingExecutor.ts#L1516-L1539)).
- **Budget.** The compiled 2.3.10 single-window server lists 45 tools in 28 799 B against the 30 000 B limit ([session-lifecycle.js:149](../../test/transport/session-lifecycle.js#L149)). About 1.2 kB is left, and WP-G plans to free about 2.5 kB for 2.3.12's own additions.
- **An unrestricted command path of our own.** The documentation panel runs any command ID its webview posts ([packDocsPanel.ts:247-251](../../src/packDocsPanel.ts#L247-L251)). The webview is CSP- and nonce-protected, but it is exactly the kind of unrestricted bridge the proposal rules out. Allowlist it (step 5).

## Proposed fix

**Phase 0: answer the proposer** with the reply in Decision 5, once Decisions 1–4 are settled.

**Phase 1: our part, in this repo (Future, WP-M, after #11).**

1. **Pure allowlist `src/core/agentCommands.ts`** (no `vscode` import, unit-testable). Each entry is:

   ```ts
   { key, command, args?, timeoutMs, readOnly: true, normalise(raw: unknown): JsonValue }
   ```

   - The first set covers the snapshot `what: 'context'`: `solution` (`getSolutionFile`), `targetSet`, `device`, `board`, `processor`, `dfp` (`getDfpName` plus `getDfpPath`), `bsp` (name plus path), `packRoot`, `cbuildRun`, and `images` (`getBinaryFiles`, JSON-decoded).
   - `normalise` maps `""` and `"<not found>"` to `null`, rejects non-string values, and caps sizes.
   - `getSolutionPath`, `getInfoPath` and `getTargetPack` are left out: they are an alias, have a different meaning, or duplicate another entry.
2. **Runner in the target window.**
   - New op `handleCmsisQuery(args: {what?: 'context' | 'toolchain'})` on `IDebuggingHandler`. It is routed like every op, so the answer comes from the window that owns the solution.
   - It runs the allowlisted commands in parallel, each behind its own 3 s fence.
   - A command that is missing or slow yields `null` plus a note. No active solution, or no CMSIS Solution extension, yields `ToolError('CMSIS_NO_SOLUTION')` with the existing three-step hint.
   - The existing query call sites (`queryActiveCmsisSolution`, `queryActiveTargetSet`, `packDocsHost.activeContext`, `toolchainPackRoot`) switch to this runner, so there is one fence and one parser for the whole repo. `activateSolution` / `deactivateSolution` are writes and stay where they are.
3. **Tool `cmsis_query {what?: 'context' | 'toolchain'}`**, default `'context'`, annotated read-only, no session needed.
   - It returns `ToolReply {text: ≤10-line summary, data: {…}}`, so the values arrive as `structuredContent` (#11).
   - `what: 'toolchain'` is #17.
   - Cost: about 750 B in `tools/list`, so it needs WP-G's freed budget or an equal trim elsewhere.
   - It follows the new-tool checklist: `IDebuggingHandler` → `DEBUG_OPS` → router forward → `registerTool` → `allowed-tools` in `skills/cmsis-debug-live/SKILL.md` → `help.toolGroups` in `scripts/skills.config.json` → regenerated `skills/cmsis-help` → README tables, `docs/architecture`, `CHANGES-VS-UPSTREAM.md`, CHANGELOG.
4. **Guidance.** The build and session topics and `SKILL.md` say: "for solution, target, device, packs or toolchain call `cmsis_query` before reading YAML or searching PATH".
5. **Tighten `packDocsPanel`'s `command` message** to the one command its webview posts (`cmsis-developer-assistant.importUserDoc`, [packDocsPanel.ts:493](../../src/packDocsPanel.ts#L493)).

**Phase 2: owner side (CMSIS Solution team, proposed to brondani).**

1. **One typed, versioned query command,** for example `cmsis-csolution.getAgentContext`. It returns `{version: 1, solution, targetSet, device, board, processor, packs: {dfp, bsp}, packRoot, cbuildRun, images, toolsEnvironment}` as a JSON object instead of strings and sentinels. It is documented in their README as public API, with defined behaviour when no solution is loaded. `cmsis_query` prefers it when present and falls back to the string getters.
2. **Keep the string getters stable** for `${command:}` use. Fix or document `getSolutionPath`.

**Phase 3: later, only if a second provider appears** (CMSIS Debugger, Environment Manager).

- **Provider-declared allowlist.** A provider lists its agent queries in its own `package.json` (for example a top-level `cmsisAgentQueries` array: id, command, description, `readOnly`). We read it through `vscode.extensions.all` and add the IDs to `what`. The shared TypeScript package for IDs and types comes at this point, once two sides consume it.

Write commands stay dedicated tools with guards, like `cmsis_action`. They never go through the query bridge.

## What changes for the agent and the user

```text
"Which device, board and DFP does the active target use?"

2.3.10   read *.csolution.yml → glob out/**/*.cbuild-run.yml → read cbuild.yml → maybe get_device_info
         (needs a session): 3–6 calls, and the answer may not match the CMSIS panel

new      cmsis_query {} →
         text: "Solution Blinky.csolution.yml, target MPS3, device SSE-300-MPS3 (DFP ARM::V2M_MPS3_SSE_300_BSP@1.5.0) …"
         structuredContent: {"status":"ok","solution":"/w/Blinky.csolution.yml","targetSet":"MPS3",
           "device":"SSE-300-MPS3","board":"ARM::V2M-MPS3-SSE-300-FVP","dfp":{"id":"ARM::V2M_MPS3_SSE_300_BSP@1.5.0",
           "path":"/…/packs/ARM/V2M_MPS3_SSE_300_BSP/1.5.0"}, "cbuildRun":"/w/build/GCC/outdir/Blinky+MPS3.cbuild-run.yml", …}
```

The values above are illustrative, taken from the corstone-blinky fixture. The user gets answers that match the CMSIS Solution panel, because they come from it.

## Decisions for you

- [ ] **1. Tool shape.** **Recommended:** one `cmsis_query` with a snapshot `what: 'context'` plus `'toolchain'` (about 750 B). All getters are in-memory reads, so one call returns everything.
  - Alternative A: one `what` value per command (about 12 values, about 900 B). Finer control, but more calls.
  - Alternative B: add `what` to `get_device_info` (about 300 B). Cheaper, but that tool is tied to a debug session and to the debugger, and it would be harder to find.
- [ ] **2. Where the contract comes from.** **Recommended:** ask the CMSIS Solution team for the typed `getAgentContext` (phase 2, step 1), and ship v1 on the existing string getters meanwhile.
  - Alternative: formalise the 16 string getters as the contract. No owner work, but the strings, the `"<not found>"` sentinel and the `getSolutionPath` alias become permanent API.
- [ ] **3. Scope of v1.** **Recommended:** read-only queries only.
  - Alternative: also allowlisted write commands. The proposal allows it, but every write needs its own guards (probe busy, live session), which `cmsis_action` already models.
- [ ] **4. Shared TypeScript package.** **Recommended:** later (phase 3). With one provider and one consumer, the allowlist file plus the owner's README is enough.
  - Alternative: now. It stops drift early, but adds a package with release overhead for a single contract.
- [ ] **5. How to answer brondani.** **Recommended** reply (post once 1–4 are decided):

  > Agreed on the principles: an allowlist, no generic `execute_vscode_command`, and structured results. On our side, #11 adds `structuredContent` and a structured control envelope. After that we add one read-only tool, `cmsis_query`, that returns a snapshot of the active solution (solution, target set, device, board, processor, DFP/BSP, pack root, cbuild-run, images) and the toolchain (#17). The allowlist lives in this repo for v1.
  >
  > Your getters are `${command:}` string resolvers today (`""`, `"<not found>"`, a JSON-encoded array, `getSolutionPath` aliased to `getSolutionFile`). Would CMSIS Solution add one typed, versioned `getAgentContext` command that returns a JSON object, documented as public API? We would switch to it and keep the getters as a fallback.
  >
  > We would add write commands and a shared types package once a second provider joins.

  - Alternative: reply now with the principles only, and ask for `getAgentContext` once v1 has shipped. Less to commit to up front, but the owner-side work starts a release later.

## Tests and acceptance

- **Unit, new `src/test/agentCommands.test.ts`:**
  - `normalise` for `""`, `"<not found>"`, a JSON-array string, a malformed JSON string, a non-string and an oversize value.
  - Every allowlist key is unique, and every command matches `^cmsis-csolution\.get`.
- **Unit, runner** (with `test/transport/vscode-stub.js` `commandHandlers`):
  - All commands answer → the full snapshot.
  - One command never settles → its field is `null` with a note, within about 3 s.
  - `getSolutionFile` returns `""` → `CMSIS_NO_SOLUTION`.
  - No handlers installed (extension absent) → `CMSIS_NO_SOLUTION`.
- **Unit, `src/test/routing.test.ts`:** `handleCmsisQuery` routes to the owning window, and its `ToolReply.data` survives envelope v2.
- **Transport, `test/transport/session-lifecycle.js`:**
  - `cmsis_query` is listed, read-only, and without `outputSchema`.
  - Its `structuredContent` carries `status`.
  - The `tools/list` budget still holds.
- **Unit, `src/test/skill.test.ts`:** `allowed-tools` includes `cmsis_query`.
- **Live** (corstone-blinky fixture, CMSIS Solution 1.70.1): every value equals what the CMSIS Solution panel and `launch.json` show. Switch the target with `cmsis_action {target}`, and `cmsis_query` follows.

## Out of scope and follow-ups

- A generic `execute_vscode_command`: rejected by the proposer and by us.
- Write commands through the bridge (Decision 3).
- Queries into other extensions until they ask (phase 3).
- `outputSchema` per tool (see #11).
- The sibling `getRecentProblems` contract (#48 phases 3–4). It could follow the same pattern and be asked for in the same reply.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
