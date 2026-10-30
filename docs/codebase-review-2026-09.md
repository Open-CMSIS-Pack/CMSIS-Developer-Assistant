# Codebase review — CMSIS Developer Assistant (branch fix/pdfjs-timeout-race)

> **Historical review record.** Findings and line references below describe the September 2026 checkout, not open defects in 2.7.0. Later fixes and the independent rewrite supersede parts of the implementation plan. Preserve the original evidence; review any remaining work through the [2026-10-28 review](reviews/2026-10-28-knowledge-and-docs.md) and current [architecture](architecture/debugMCPServer.md).
>
> **Status 2026-09-07:** Phases 0, 1 and 2 are implemented on this branch (uncommitted), with the verification's adjustments R1–R3, R5 (not yet relevant), R6 and R7 applied; R4 (the five issues from `notes.md`) is left for the user — `notes.md` is git-ignored in the meantime. `npm test` 491 passing, both transport scripts green, lint and type-check clean. Phases 3–5 remain as follow-up PRs.

## Context

The user asked for a review of the current codebase with recommendations on clean-up, potential bugs, missing tests and documentation. Lint (`eslint src`) and type-check (`tsc --noEmit`) are clean. Three read-only review passes covered (1) the debug core, (2) the packDocs/buildInfo subsystem including the uncommitted pack-root diff, and (3) utils, tooling, skills, docs and tests. The top findings in each area were verified by hand against the source. Nothing has been changed yet. The second half of this file is the proposed fix sequence; approving it means implementing Phase 0–2 first, with 3–5 as follow-up PRs.

---

## Findings

### A. Bugs — HIGH (verified)

| # | Where | Problem | Fix |
|---|---|---|---|
| A1 | `src/debuggingHandler.ts:1167` | `waitForTargetStopped` settles on `onDidChangeActiveStackItem`, which also fires when the item is *cleared* on resume. `handleContinue` (`:422`) awaits only the DAP `continue` response, so the `continued` event often lands after subscription → tool reports "stopped" with an empty state while the target runs. | Use `waitForStopEvent()` (`src/utils/sessionStateTracker.ts`, DAP `stopped` ground truth, already used by `executor.waitForStop` and `resetTarget`). Minimum: ignore the event unless `vscode.debug.activeStackItem` has a `frameId`. |
| A2 | `src/core/flashController.ts:129` | SIGKILL escalation guarded by `child.killed`, which is true as soon as SIGTERM is *sent*; a wedged pyOCD is never killed. | Check `child.exitCode === null && child.signalCode === null`. |
| A3 | `src/routingDebuggingHandler.ts:161`, `src/controlServer.ts:81` | `body += chunk` on Buffers → multibyte UTF-8 split across chunks becomes U+FFFD (tool results carry emoji). No body-size cap either side. | `setEncoding('utf8')` or collect Buffers + `Buffer.concat`; add a size cap. |
| A4 | `src/core/packDocs/xmlLite.ts:42` | `Number.isFinite(code)` passes 99999999; `String.fromCodePoint` throws `RangeError`, escaping the `XmlParseError` contract → `list_target_docs failed: Invalid code point`. | Guard `0 <= code <= 0x10FFFF`, else return `whole`. |
| A5 | `src/core/packDocs/webFetch.ts:247-250` | `out.on('error')` attached only after the write loop; a stream error mid-download (ENOSPC/EACCES) is an unhandled `'error'` → uncaught exception in the extension host; an error during the `drain` wait hangs `fetch_doc`. | Attach the error listener right after `createWriteStream`, race it against `drain`. |
| A6 | `src/packDocsHandler.ts:754`, `src/buildInfoHandler.ts:317` | `Promise.race([body, timeout])`: when the timer wins, a later rejection of `body` is unhandled. | `body(...).catch(e => log.debug(...))` before racing. |
| A7 | `src/utils/workspaceRegistry.ts:103,140-149` | Registry file written with plain `writeFileSync`; `list()` unlinks any file that fails to parse → a peer window reading mid-write deletes a live window's registration. Same RMW hazard in `heartbeat()` (`:110-118`). | Write `${file}.tmp-${pid}` + `rename`; unlink only on repeated parse failure. |
| A8 | `src/utils/skillInstaller.ts:307-319` | `removeStaleStaging` removes every `.${name}.tmp-*`, including another live window's in-flight copy (two windows sync at login). | Skip `.tmp-${process.pid}` and any pid that `isProcessAlive` (workspaceRegistry) reports alive. |
| A9 | `src/utils/agentConfigurationManager.ts:424,494,641` | `writeFileAtomic` uses one fixed temp name (two windows collide on rename); Codex TOML written with plain `writeFile`, contradicting the documented atomic-write rule. | pid/uuid suffix; route TOML through `writeFileAtomic`. |

### B. Bugs — MEDIUM

- **B1** `debugMCPServer.ts:1364` serial teardown only runs in the router window; a *worker* window owning the tty never closes it. Move to `WindowCoordinator.dispose()`.
- **B2** `debugMCPServer.ts:1380`, `controlServer.ts:66` `server.close()` without `closeAllConnections()` can block `deactivate` (keep-alive sockets; `extension.ts:296` awaits dispose).
- **B3** `serialController.close()` leaves state set when the port close rejects (unplugged USB) → `open()` refuses forever. Clear in `finally`.
- **B4** `debuggingExecutor.ts:1198,1220` `resetTarget`: "trying the next method" printed when the *last* method was unsupported; `halt:false` silently ignored when unverified; `haltedByUs` never surfaced.
- **B5** `debuggingExecutor.ts:178` floating promise in dead coreclr branch → delete branch.
- **B6** `peripheralReader.ts:28` hard-codes 10 s instead of `dapRequestTimeoutMs`; `evaluateMemoryWord` (`:1022`) doesn't forward `timeoutMs` to GDB fallbacks.
- **B7** `debugMCPServer.ts:1227` per-session `McpServer`/transport leaked when session setup throws.
- **B8** `packDocsHandler.ts:259,588` `maxPdfMb` not enforced on `read_doc_pages`/`indexDocument` (only in `ensureAll`/`indexTarget`).
- **B9** `packDocsHandler.ts:717-719` `findKnown` substring fallback returns the first `includes()` match silently; return an ambiguity error when >1 candidate.
- **B10** `userDocs.ts:157,240` user-doc ids ignore the folder → `user/rm0456` collides across scopes; id unstable between calls.
- **B11** `webFetch.ts:180,213` `fetch_doc` follows any http(s) URL incl. loopback/RFC1918/169.254.169.254 with redirects → SSRF/port-scan surface driven by prompt-injected content. Block private literals, re-check after redirect.
- **B12** `buildInfoHandler.ts:195` `get_build_diagnostics { file }` reads any absolute path; no workspace containment, `looksLikeBuildLog` not applied. Arbitrary-file-read primitive.
- **B13** `agentConfigurationManager.ts:481-577,654-684` whole-file RMW of `~/.claude.json` with no lock; re-read immediately before write at minimum.
- **B14** `debuggingHandler.ts:1904,2151` `confirmSessionSurvives` fixed 3 s+3 s sleeps blow the advertised 8 s window; `debuggingExecutor.ts:1433` `getThreads` fans out one `stackTrace` per thread uncapped; `windowCoordinator.ts:134-147` partially started server leaked on non-PortInUse error; `controlServer.ts:80` no `req.on('error')`.
- **B15** Uncommitted diff: `effectivePackRoot` is only applied in `resolveTarget`; `collectTargetDocs`, `resolveSvd`, `resolveCoreHeader/NpuHeader` (`targetDocs.ts:198,200,309`, `packDocsHandler.ts:410,484,545,567`) read `host.packRoot` directly and only work because the production host has a getter over a mutated closure; host copies (`{ ...this.host, log }`) snapshot it. `svdParser.ts:226` got the Windows default but not the toolchain hook. One `executeCommand` round trip per `resolveTarget` (several per panel interaction). Log line at `packDocsHost.ts:182` never confirms the outcome.

### C. Bugs — LOW

`elf.ts:263,292` unbounded `shentsize×shnum` allocation and `:318-327` symtab over-read on bad `entsize` (no truncated-ELF test); `buildLog.ts:196-200` tail `toString` ignores byte count; `mapFile.ts:154` `parseHex` wraps ≥2³²; `svdLite.ts:143-149` shared `fields` array across register-array members; `tokenizer.ts:34-38` `0x____` yields empty token; `render.ts:212` `parsePageRange` silently truncates at 50 pages; `peripheralDocs.ts:467,477` + `buildInfo/render.ts:229,342,388` budget clipping removes the trailing `Next:` hint; `packDocsHandler.ts:155` `refreshSettings` replaces the extractor without `dispose()` and `PackDocsHandler` has no dispose in `context.subscriptions`; `pdscBooks.ts:326` `<book name="../..">` escapes the pack dir; `userDocs.ts safeName` allows `..`; `svdParser.ts:134-217` sync fs inside async; `svdParser.ts:327` `extractTag` breaks on `<` in text; `express.json()` no `limit`; `extension.ts:42` defaults `timeoutInSeconds` to 60 vs 180 in package.json; `sessionStateTracker.ts:207-211` LRU prune exits early; `logger.ts:16` `debug` level unreachable (`setLogLevel` never called); `skillInstaller.ts:257-259` catalog `entry.name` unvalidated before `rm -rf`; `agentConfigurationManager.ts:723` agent matched by `displayName`.

### D. Clean-up

- **Duplicated modules**: `src/core/textBudget.ts` vs `src/core/packDocs/textBudget.ts` (diverged: different clip suffix strings, missing `<=0` guard; already flagged in packDocs.md §Follow-ups) → keep `core/textBudget.ts`, move `formatBytes` there, delete the copy. Duplicated `run()` timeout fence in `packDocsHandler.ts:742-765` / `buildInfoHandler.ts:311-334`; `unquote` (`cbuildRun.ts:135`, `artifacts.ts`); `GROUP_OF` (`coreHeader.ts:47`, `coreSvd.ts:37`); two glob→regex (`userDocs.ts:110`, `buildInfo/glob.ts:27`); GDB word-read ladder (`evaluateMemoryWord` vs `peripheralReader.readWord`, `parseGdbIntResult` vs `parseGdbInt`); GDB reply sniff regex (`debuggingHandler.ts:326,916`); `0x` normalisation (4 sites); `serialController.read` ≡ `serialMonitorBridge.read`.
- **Dead code**: `DebugState.reset/clone/hasValidContext/hasLocationInfo/hasFrameName`; `DebuggingHandler.getCurrentDebugState/isDebuggingActive`; `DebugMCPServer.isInitialized` + the `initialized` flag and `getDebuggingHandler()` (note: `initialize/getOptions/getMetrics` ARE used by `windowCoordinator.ts:135` and `test/transport/session-lifecycle.js` — keep them); `ResetOutcome.haltedByUs` (unless B4 surfaces it); `debugConfigurationManager.ts` `validateWorkspace/hasLaunchJson/getAvailableConfigurations/getAutoLaunchConfigName` + Jest/Mocha/JUnit/xUnit branches (`:332-445`) + php/rb/go/rs map; `chapters.ts:54` identity replace; `getRootCauseAnalysisCheckpointMessage()` (`debuggingHandler.ts:1265-1291`, upstream text appended to every `stop_debugging`, contradicts CMSIS workflow); python/javascript/java/csharp troubleshooting resources (`debugMCPServer.ts:1047`).
- **Oversized**: `DebugMCPServer.setupTools` (~660 lines → split as `registerPackDocsTools` already does), `DebugMCPServer.start` (~160), `handleCmsisCommand` (~220), `packDocsHandler.inspectTarget` (4 near-identical blocks), `mapFile.parseGnu`, `packDocsCommands.importUserDocuments`.
- **Convention drift**: `console.*` in `agentConfigurationManager.ts` (12 sites), `debugConfigurationManager.ts` (7), `debugMCPServer.ts:1154`, `debuggingExecutor.ts:573,634,676`; `any` (~47 in debug core: `IDebuggingExecutor` returns, express handlers, `SerialMonitorBridge`; `agentConfigurationManager.ts:501,650`; `packDocsHost.ts:99`). AGENTS.md says tabs + Microsoft header; tree uses 4 spaces + Apache/Arm block → fix AGENTS.md. Orphaned JSDoc at `debugMCPServer.ts:304`, `debuggingHandler.ts:592,954,1640`. Typo `packDocsHost.ts:12` "produced or implied". `agentConfigurationManager.ts:143` RegExp per line.
- **Repo hygiene**: `.gitignore` misses cbuild output under `test/eval/fixtures/corstone-blinky/` (`.cmsis/`, `Blinky/RTE/`, `build/`, `*.cbuild-idx.yml`, `*.cbuild-pack.yml`; only `build/MPS3/` ignored) and `notes.md` (5 open questions → issues). `dist/extension.js.map` tracked and stale (Aug 20 vs Sep 3 bundle) — at minimum stop tracking the `.map`; `dist/` tracking itself is deliberate per project memory, leave unless user says otherwise. `@types/express` in `dependencies`. `package.json` `test` duplicates `.vscode-test.mjs` coverage flags. ci.yml Lint/Compile steps duplicate `pretest`. tsconfig has `noFallthroughCasesInSwitch`/`noImplicitReturns`/`noUnusedParameters` commented out. eslint has no `no-console` / `no-explicit-any`. No `test:realboard` script.

### E. Missing tests

Modules with **no test file**: `debuggingExecutor.ts`, `debugMCPServer.ts` (**`isLoopbackHostHeader`/`isLoopbackOrigin` exported for testing, untested** — the DNS-rebinding defence), `windowCoordinator.ts`, `serialHandler/serialController/serialMonitorBridge` (10 tools), `peripheralReader.ts`, `memoryMap.ts`, `dwt.ts`, `measuredMcpServer.ts`, `agentConfigurationManager.ts` (pure exports `upsertCodexDebugMCPConfig`, `stripLegacyCodexSection`, `agentConfigHasServer` explicitly exported for testability), `debugConfigurationManager.ts`, `sessionStateTracker.ts`, `timeout.ts` (`withTimeout` on every hardware path), `treeHash.ts`, `skillHelp.ts`, `logger.ts`, `pdfText.ts`, `bm25Index.ts`, `headings.ts` (packDocs.md claims `headings.test.ts` exists — it does not), both `render.ts`, `peripheralAliases.ts`, `buildInfo/glob.ts`, `buildInfo/usage.ts`, `packDocsHost.ts`, `packDocsPanel.ts`, `packDocsCommands.ts`.

Highest-value new tests (each pins a bug above): A1 stack-item-cleared must not settle; A2 kill escalation; A3 multibyte body round-trip; A4 out-of-range char ref; A5 write-stream error; A6 body rejects after timer; A7/A8 two-pid concurrency; PdfjsExtractor *positive* timeout mid-extraction + restart + idle retirement + dispose-while-pending (only `timeoutMs: -1` covered today); `effectivePackRoot` seen by `collectTargetDocs`/`resolveSvd`/`resolveCoreHeader` on a plain host; truncated ELF / bad `entsize`; `maxPdfMb` on `read_doc_pages`; `get_build_diagnostics` path outside workspace; `debuggingHandler` `withHandlerTimeout`, `classifyGdbBreakpointReply`, `resolveBreakpointLines`, `resolveCbuildRunFile`, `ensureStoppedSession` hints; `routing.test.ts` `post()` malformed/timeout; `parseQuery('')`/stop-words-only/CJK.

### F. Documentation

- `docs/architecture/debugMCPServer.md`: says stateless per-request transport; code is stateful sessions (`:1197`); `/sse` is a 410 stub; ~15 tools missing from table.
- `docs/architecture/debuggingHandler.md`: documents `waitForStateChange/hasStateChanged/formatDebugState` (don't exist); before/after polling replaced by events; no routing, `withHandlerTimeout`, `cmsis_action`, `flash`, `reset`, `diagnose_fault`.
- `docs/architecture/debuggingExecutor.md`: activeTextEditor state and `workbench.action.debug.*` stepping both superseded; readiness = DAP `threads` probe.
- `docs/architecture/debugState.md`: lists the five dead methods.
- `docs/architecture/agentConfigurationManager.md`: 2 bundled skills (there are 4); atomic-write claim false for TOML.
- `docs/architecture/packDocs.md`: `headings.test.ts` doesn't exist; §Follow-ups stale (pdfjs extractor shipped; textBudget merge still open and diverged).
- **No doc** for `WindowCoordinator`, `ControlServer`, `RoutingDebuggingHandler`; AGENTS.md diagram lacks the routing hop.
- AGENTS.md: `packDocs.enabled` "needs pdftotext" (false since pdf.js bundled); config table omits 13/20 settings; command table omits `build`, `package`, `test:transport`, `bench:search`, `eval:scenario`; tabs/header conventions wrong.
- `docs/DebugMCP-brief-feature-inventory.md`: "14 tools"/"22 fork tools" vs 57 registered; predates 2.3.5–2.3.9.
- `docs/improvement-notes.md:16-22`: five items "Shipped in: unreleased" that shipped long ago.
- `CHANGES-VS-UPSTREAM.md:197` names `src/utils/withTimeout.ts` — that is *upstream's* file contrasted with the fork's `timeout.ts`; correct as written, only prefix "upstream's" for clarity. `test/realboard/README.md:24` `cd DebugMCP` (pre-fork name).
- CHANGELOG [Unreleased] doesn't mention commit aa401c7.
- JSDoc gaps: `SerialHandler` entry points, `IDebuggingHandler` members, `getActualPort()` contradicts `:1281`; `parseXml`, `parseSvd`, `buildIndex`, `tokenize`, `parseQuery`, `readElf`, `parseMapFile`, `parseBuildLog`, `computeRegionUsage`, `PackDocsHandler.getStore/getExtractor/dropCaches`.

---

## Recommended fix sequence

Each phase is one PR-sized change with its own tests and CHANGELOG entry. Phases 0–2 are the recommended immediate scope.

### Summary — Phase 0 — finish the in-flight pack-root diff (this branch)

- Thread the resolved root instead of relying on the getter: put `packRoot` on `TargetResolution` (or have `resolveTarget` return the effective host) and make `collectTargetDocs`, `resolveSvd`, `resolveCoreHeader/NpuHeader` use it. Cache `packRootFromCsolution()` as a one-shot promise invalidated on `onDidChangeConfiguration`. Log the outcome either way at `packDocsHost.ts:182-185`.
- `svdParser.resolvePackRoot`: accept the toolchain root (share the cached promise via `packDocsHost` or an injected hook).
- Tests: plain-object host → `collectTargetDocs` and `resolveSvd` see the hook's root; `svdParser` expansion uses it.
- Add `.gitignore` rules for the corstone-blinky cbuild output and `notes.md`; move notes.md items to issues. Add aa401c7 to CHANGELOG [Unreleased].

### Summary — Phase 1 — HIGH bugs (A1–A9), one commit each with a regression test

Files: `debuggingHandler.ts`, `flashController.ts`, `routingDebuggingHandler.ts` + `controlServer.ts`, `xmlLite.ts`, `webFetch.ts`, `packDocsHandler.ts` + `buildInfoHandler.ts` (extract the shared `run()` fence while touching it), `workspaceRegistry.ts`, `skillInstaller.ts`, `agentConfigurationManager.ts`. New test files: `debuggingExecutor.test.ts`? no — A1 lives in handler: extend `debuggingHandler.test.ts`; `flashController.test.ts` exists; `controlServer.test.ts` (new, spin up on port 0); `xmlLite.test.ts`, `webFetch.test.ts`, `workspaceRegistry.test.ts`, `skillInstaller.test.ts` exist → extend.

### Summary — Phase 2 — security/containment and MEDIUM bugs (detailed plan in Part II below)

### Summary — Phase 3 — clean-up

Merge `textBudget`; delete dead code and upstream leftovers (DebugState methods, checkpoint message, language resources, debugConfigurationManager test-framework branches); dedupe GDB read ladder / `unquote` / `GROUP_OF` / glob / serial read; split `setupTools`; replace `console.*` with `logger`; type the `any` contracts with `DapScope`/`DapVariable`/`MCPServerConfig`; move `@types/express` to devDependencies; enable `noFallthroughCasesInSwitch`; add `no-console` and `no-explicit-any` (warn) to eslint; stop tracking `dist/extension.js.map`.

### Summary — Phase 4 — tests for untested modules

`agentConfigurationManager` pure exports, `serial*`, `peripheralReader`, `memoryMap`/`dwt`, `measuredMcpServer`, `windowCoordinator` election, truncated ELF, `headings`, `bm25Index`, `parseQuery` edge cases.

### Summary — Phase 5 — documentation

Rewrite the four stale `docs/architecture/*.md`; add `docs/architecture/windowRouting.md` covering WindowCoordinator/ControlServer/RoutingDebuggingHandler; fix AGENTS.md (conventions, settings table, commands, diagram); refresh `DebugMCP-brief-feature-inventory.md` and `improvement-notes.md`; fix the two broken path references; add JSDoc to the listed exports.

## Verification

- `nvm use 22 && npm run lint && npm run check-types && npm test` (Node 22 required; registry blocked → `--registry=https://registry.yarnpkg.com/` if installs are needed).
- `npm run test:transport` for A3/B2 (router↔worker hop; add an emoji-bearing payload).
- Live check for A1: `cmsis_action load_and_debug` on the corstone-blinky FVP fixture, then `continue_execution` with no breakpoint must report a timeout, not a stop.
- A2: run `flash` against a pyOCD stub that ignores SIGTERM; expect SIGKILL after 2 s.
- Phase 0: with the CMSIS Solution extension active and `CMSIS_PACK_ROOT` unset, `list_target_docs` and `lookup_peripheral` must name the same pack root.

---

## Part II — Detailed implementation plan

Conventions for every item: 4-space indent, Apache/Arm header on new files, `logger` from `src/utils/logger` (never `console`), Mocha `suite`/`test` under `src/test` run by `vscode-test` (tests may import `vscode`). One commit per item, each with its test and its CHANGELOG bullet under `[Unreleased]`. Verify with `nvm use 22 && npm run lint && npm run check-types && npm test`.

Note: nothing under `src/core/` may import `vscode`; `src/utils/timeout.ts` does, so `withTimeout` cannot be used from `core/`.

## Phase 0 — finish the in-flight pack-root diff (this branch)

Sequencing: P0.5 first (clean `git status`), then P0.2 → P0.3 → P0.1 as one commit "finish the pack-root diff".

### P0.1 Thread the effective pack root through every consumer

**Root cause.** Only `resolveTarget` (`src/core/packDocs/targetDocs.ts:66-71`) calls `effectivePackRoot(given)` and builds a local `{ ...given, packRoot }` that never leaves the function. `locatePack` (`:197-208`) reads `host.packRoot` from the caller's host; `collectTargetDocs` (`:238`), `resolveSvd` (`:306`) and `PackDocsHandler` (`this.host.packRoot` at `src/packDocsHandler.ts:410, 462, 484, 545, 567`; spread copies at `:404, 539, 562, 724`; `hostWith` at `:734`) all pass the original. It works in production only because `makePackDocsHost` exposes `get packRoot()` over a closure, and a spread copy snapshots the getter, so the first call in a window still looks in the platform default.

**Decision: put `packRoot` on `TargetResolution` and have consumers read it.** The resolution is what every consumer already receives, the pure functions stay synchronous, and no extra `executeCommand` round trip is needed.

**Change.**

- `targetDocs.ts`: `TargetResolution` gains `packRoot: string` ("the pack root the resolution was made under"). `resolveTarget` keeps `const packRoot = await effectivePackRoot(given)`, drops the host copy, uses the local `packRoot` in `pickInstalledVersion` and the "not installed under" text, and sets `packRoot` on both return objects (`:85-90`, `:157-164`). `locatePack(host, id, notes)` → `locatePack(packRoot: string, id, notes)`; callers `collectTargetDocs.visit` and `resolveSvd` pass `res.packRoot`. Update the `PackDocsHost.packRoot` doc comment.
- `packDocsHandler.ts`: `resolveCoreHeader(target.packRoot, …)` at `:410, 462, 545`; `resolveNpuHeader(target.packRoot, n)` at `:484, 567`. Spread copies stay (they only carry `log` now).
- `src/core/cmsisTarget.ts` has an unrelated `TargetResolution`; leave it. Verify `grep -rn locatePack src` shows only `targetDocs.ts`.

**Tests** (`src/test/packDocsHandler.test.ts`, after the existing hook test): plain-object host `{ ...world.host, packRoot: '/nowhere', packRootFromToolchain: async () => world.packRoot }`; `resolveTarget` → `res.packRoot === world.packRoot`; `collectTargetDocs(host, res)` has the Test Reference Manual under `world.packRoot`, `processors.length > 0`, no note containing `/nowhere`; `resolveSvd(host, res).exists === true`; end to end `new PackDocsHandler(host, …).handleListTargetDocs({})` contains the manual and not `/nowhere`; `inspectTarget({})` has `svd.exists` and a computed core header; negative: no hook → `res.packRoot === '/nowhere'`.

**CHANGELOG.** Fold into the existing unreleased Windows/pack-root bullet: every consumer (document list, SVD lookup, CMSIS-Core and NPU headers) reads the root the resolution was made under, so the first call in a window no longer looks in the platform default while the CMSIS Solution extension's answer is in flight.

**Risk.** `TargetResolution` is constructed only by `resolveTarget`; adding a required field breaks nothing.

### P0.2 Cache `packRootFromCsolution()` as a one-shot promise

**Root cause.** `src/packDocsHost.ts:132-139` calls `packRootFromCsolution()` on every `packRootFromToolchain()`: one `executeCommand` per `resolveTarget`, and a 3 s `withTimeout` wait per call when the extension is absent. The activation log (`:182`) says "until the CMSIS Solution extension answers" forever; `:135` logs only on change.

**Change.** New `src/utils/toolchainPackRoot.ts` (imports `vscode`, `withTimeout`, `defaultPackRoot`, `logger`):

- `toolchainPackRoot(): Promise<string | undefined>` — memoised `packRootFromCsolution()` (moved verbatim from `packDocsHost.ts:116-124`). A positive answer is kept until invalidated; a negative one (`undefined`) is retried after `NEGATIVE_TTL_MS = 60_000`. Logs the outcome once: `Pack root <answer> (cmsis-csolution.getPackRootPath)` or `Pack root <default> (CMSIS_PACK_ROOT | platform default; the CMSIS Solution extension is not active or did not answer)`.
- `effectiveToolchainPackRoot(): Promise<string>` → `(await toolchainPackRoot()) ?? defaultPackRoot()`.
- `invalidateToolchainPackRoot()`; `registerToolchainPackRootInvalidation(context)` pushes `vscode.extensions.onDidChange(invalidate)` and `onDidChangeConfiguration` for `cmsis-csolution` / `cmsis-developer-assistant.packDocs`.
- `packDocsHost.ts`: delete `packRootFromCsolution`; `packRootFromToolchain = async () => { const r = await toolchainPackRoot(); if (r) { packRoot = r; } return r; }`; log line `:182` becomes `default pack root … (CMSIS_PACK_ROOT | platform default)`; keep the warm-up call.
- `src/extension.ts`: call `registerToolchainPackRootInvalidation(context)` next to `registerSessionStateTracker(context)` (`:65`).

**Tests.** New `src/test/toolchainPackRoot.test.ts` (vscode-test host has no csolution extension, so `vscode.commands.registerCommand('cmsis-csolution.getPackRootPath', …)` is free; dispose in `finally`): three concurrent calls → one command invocation, all `/from/csolution`; empty answer → `undefined` twice with one call, `invalidate()` → second call; no command registered → `effectiveToolchainPackRoot() === defaultPackRoot()` (set mocha timeout for the 3 s wait, or register a throwing command); settings change via `getConfiguration(...).update('packDocs.includeUnlisted', …)` invalidates (restore in teardown).

**CHANGELOG.** Extend the same bullet: asked once per window, again after an extension or settings change, unanswered asks retried after a minute; the output channel reports the adopted root.

### P0.3 `svdParser.resolvePackRoot` shares the cached root

**Root cause.** `src/core/svdParser.ts:227-232` expands `${CMSIS_PACK_ROOT}` with `defaultPackRoot()` via `String.replace` (first occurrence, braces form only). Callers: `resolveSvdPath` (`:133`) and `findSvdInCbuildRun` (`:220`); entry points `findSvdFile()` (`:263`, via `peripheralReader`) and `resolveSvdForLookup()` (`:274`, via `debuggingHandler.svdForLookup` `:1533` and `diagnose_fault` `:1504`), both built from `workspaceContext()` (`:245`).

**Change.** `SvdResolveContext` gains `packRoot?: string | (() => Promise<string>)`. `resolveSvdPath` resolves it first (`defaultPackRoot()` fallback) and passes it to `resolvePackRoot` and `findSvdInCbuildRun`. `resolvePackRoot(filePath, packRoot)` becomes `expandPackRoot(filePath, packRoot)` from `src/core/packDocs/cbuildRun.ts:184` (also handles `$CMSIS_PACK_ROOT` and repeated occurrences). `workspaceContext()` returns `packRoot: effectiveToolchainPackRoot` (svdParser already imports `vscode`; the memo never throws so the headless transport stub stays safe).

**Tests** (`src/test/svdParser.test.ts`, suite `SVD path resolution`): `${CMSIS_PACK_ROOT}/dev.svd` with string and async `packRoot` → resolved; cbuild-run entry under `${CMSIS_PACK_ROOT}` with injected root → hit, and with `process.env.CMSIS_PACK_ROOT` set (restore in finally) → hit; `$CMSIS_PACK_ROOT` without braces accepted.

**CHANGELOG.** Extend the same bullet: `lookup_peripheral`, `read_peripheral_register` and `diagnose_fault` expand `${CMSIS_PACK_ROOT}` with that same root.

### P0.4 Verification

Covered per item. Live check: with the csolution extension active and `CMSIS_PACK_ROOT` unset, `list_target_docs` and `lookup_peripheral` name the same root.

### P0.5 Repo hygiene

**Change.** Append to `.gitignore` after the `test/eval/reports/` block:

```gitignore
# cbuild output in the agent-evaluation fixture (built locally, never vendored)

test/eval/fixtures/corstone-blinky/.cmsis/
test/eval/fixtures/corstone-blinky/build/
test/eval/fixtures/corstone-blinky/**/RTE/
test/eval/fixtures/corstone-blinky/*.cbuild-idx.yml
test/eval/fixtures/corstone-blinky/*.cbuild-pack.yml
test/eval/fixtures/corstone-blinky/**/*.cbuild.yml
test/eval/fixtures/corstone-blinky/**/*.cbuild-run.yml
# personal scratch notes

/notes.md
```

Scoped to the fixture so `src/test/fixtures/**/*.cbuild-run.yml` stays trackable. `notes.md`: open five issues (`gh issue create`: "fetch_doc: download web PDFs into the user documents folder"; "User documents: do not search documents of other devices"; "Per-core context in the documentation graph"; "Debug: error dialogs popping up during agent-driven sessions"; "Boards without out-of-the-box debugging — issue for CMSIS-Debugger"), then delete the file. CHANGELOG `[Unreleased] / Fixed`: "A zero or negative pdf.js timeout is now decided synchronously instead of on a zero timer" (aa401c7: a warm worker answered a small document within one Windows scheduler tick, so the expected rejection was missing on the windows-11-arm runner).

Verify: `git status --porcelain --untracked-files=all test/eval/fixtures/corstone-blinky | wc -l` → 0.

## Phase 1 — HIGH bugs

Sequencing: A7 (introduces `atomicFile.ts`, exports `isProcessAlive`) → A9 → A8; then A4, A5, A6, A2 independently; A3 (both sides + transport script); A1 last (largest behaviour change, run the live FVP check).

### A1 `waitForTargetStopped` settles on the wrong signal

**Root cause.** `src/debuggingHandler.ts:1167-1169` subscribes `onDidChangeActiveStackItem`, which also fires when VS Code *clears* the item on resume. `handleContinue` (`:425`) awaits only the DAP `continue` response, then subscribes; the clear lands after, so the tool returns "stopped" with an empty state. The helper also serves `handleStepOver/Into/Out` (`:384/398/412`), `handlePause` (`:475`) and `attemptRecoveryAfterTimeout` (`:1219`). `waitForStopEvent(session, ms)` in `src/utils/sessionStateTracker.ts:173` resolves on the next DAP `stopped`, `{ kind: 'ended' }` on termination, `{ kind: 'timeout' }` otherwise. `executor.waitForStop` (`src/debuggingExecutor.ts:347`) is *not* suitable: its `isSessionStopped` short-circuit (`:350`) returns `already-stopped` before the `continued` event arrives. The waiter must be armed **before** the request is sent.

**Change.**

- `IDebuggingExecutor`: add `armStopWaiter(timeoutMs: number): Promise<StopWaitResult>` — subscribe to the NEXT DAP stopped event, never short-circuits; implementation `waitForStopEvent(resolveActiveSession(), timeoutMs)` (throw "No active debug session" if none).
- Handler: replace `waitForTargetStopped` with

```ts
private async issueAndWaitForStop(issue: () => Promise<void>, overrideMs?: number)
    : Promise<{ state: DebugState; timedOut: boolean; sessionEnded: boolean; reason: string | null }> {
    const timeoutMs = Math.min((overrideMs && overrideMs > 0) ? overrideMs : this.timeoutInSeconds * 1000, 60_000);
    const pending = this.executor.armStopWaiter(timeoutMs);   // armed first
    await issue();
    const outcome = await pending;
    if (outcome.kind === 'timeout') { logger.warn(`target did not stop within ${timeoutMs}ms`); }
    let state: DebugState;
    try { state = await this.executor.getCurrentDebugState(this.numNextLines); } catch { state = new DebugState(); }
    return { state, timedOut: outcome.kind === 'timeout', sessionEnded: outcome.kind === 'ended',
             reason: outcome.kind === 'stopped' ? outcome.reason : null };
}
```

- Callers: `handleContinue` → `issueAndWaitForStop(() => this.executor.continue(args?.timeoutMs), args?.timeoutMs)`; same for the three steps; `handlePause` → pause; `attemptRecoveryAfterTimeout` → `issueAndWaitForStop(() => this.executor.pause(5_000), 5_000)` (replaces the pause + wait pair at `:1217-1219`). Delete `waitForTargetStopped` and its doc comment. `handleWaitForStop` keeps `executor.waitForStop` (there "already stopped" is correct).
- `formatAfterExecution`: when `reason` is non-null prefix `Target stopped (reason: ${reason}).\n\n` (same phrasing as `wait_for_stop` at `:521`).
- If `issue()` throws, the armed waiter times out on its own (≤ 60 s, removes itself from `stopWaiters`); add a comment. Optional: `AbortSignal` on `waitForStopEvent`.
- `docs/architecture/debuggingHandler.md`: "DAP stopped event, armed before the request".

**Tests** (`src/test/debuggingHandler.test.ts`, new suite): fake executor cast `as unknown as IDebuggingExecutor` with `hasDebugSession`, `hasActiveSession`, `getSessionStatus: running`, `continue/stepOver/stepInto/stepOut/pause` pushing their name to `calls`, `armStopWaiter` pushing `'arm'` and returning `waiters.shift()`, `getCurrentDebugState` returning a `DebugState` (`main.c:42`, `main`), `readCoreRegisters` returning `pc/lr`. `new DebuggingHandler(fake, {} as IDebugConfigurationManager, 5)`.

- waiter armed before the request: `calls` deep-equals `['arm', 'continue']`, result matches `/reason: breakpoint/` and `/main\.c:42/`; parametrise over the steps.
- a cleared stack item cannot settle: waiter pending forever; `Promise.race([handleContinue(), sleep(100).then(() => 'still waiting')])` → `'still waiting'`.
- timeout then recovery: waiters `[timeout, stopped(pause)]` → `/did not complete within/`, `/Recovery attempt/`, `/Paused successfully\. PC = 0x08000100/`; `calls` `['arm','continue','arm','pause']`.
- session end → `/Debug session ended during 'continue_execution'/`.
- `handlePause` → `['arm','pause']`, `/Target paused/`.

**CHANGELOG.** `continue_execution`, `step_*` and `pause_execution` no longer report a stop with an empty location while the target runs; they wait for the DAP `stopped` event armed before the request and name the stop reason.

**Risk.** Output gains a "Target stopped (reason: …)" header line. Live check on the FVP fixture: `continue_execution` with no breakpoint → timeout, not stop.

### A2 `flashController` SIGKILL escalation never fires

**Root cause.** `src/core/flashController.ts:129` guards on `child.killed`, set when SIGTERM was *sent*.

**Change.** `flashWithPyocd(cbuildRunFile, timeoutMs, deps: { spawn?: typeof spawn; killGraceMs?: number } = {})`; escalation `if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }` after `deps.killGraceMs ?? 2_000`. Callers in `debuggingHandler.ts` unchanged.

**Tests** (`src/test/flashController.test.ts`, new suite): (skip on win32) real child `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'` with `timeoutMs: 200, killGraceMs: 300` → `timedOut`, `exitCode === null`, elapsed ≥ 500 ms < 5 s; fake child honouring SIGTERM → `signals` `['SIGTERM']`; fake that only sets `killed = true` and emits `close` only on SIGKILL → `['SIGTERM','SIGKILL']`.

**CHANGELOG.** A pyOCD flash run that ignored SIGTERM at the deadline was never killed and `flash` hung.

### A3 Control channel body handling and size cap

**Root cause.** `routingDebuggingHandler.ts:160-161` and `controlServer.ts:80-81` do `body += chunk` per Buffer chunk. No size cap; no `req.on('error')`. `express.json()` (`debugMCPServer.ts:1190`) caps MCP requests at 100 kB; control responses carry tool results (`read_doc_pages` up to ~240 KB).

**Change.**

- `src/core/opTable.ts`: `CONTROL_REQUEST_MAX_BYTES = 1 MiB`, `CONTROL_RESPONSE_MAX_BYTES = 16 MiB`.
- `controlServer.onRequest`: collect `Buffer[]`, count `size`; over the cap → `413` JSON `{ error }` and `req.destroy()`; `req.on('error', warn)`; decode once with `Buffer.concat(chunks).toString('utf8')` in `'end'`.
- `routingDebuggingHandler.post`: same on `res`; over the cap → `req.destroy(new Error('control response above N bytes from pid …'))`; add `res.on('error', reject)`.
- Optional: `express.json({ limit: '1mb' })` in `debugMCPServer.ts`.

**Tests** (`src/test/routing.test.ts`): chunked raw `http.request` splitting a `😀` inside the JSON body across two `write()` calls → handler sees `😀`, no `�`; a raw server that splits the response inside `😀` across `write`/`end` → `router().handleGetSessionStatus()` returns `'ok 😀'`; oversize request → 413 and the server keeps serving; oversize response → `assert.rejects(/above .* bytes/)`. `test/transport/two-window-routing.js`: add an emoji-bearing argument and assert round-trip.

**CHANGELOG.** Tool results forwarded between windows could arrive with `�` in place of emoji or CJK; both sides now collect raw bytes and decode once, and refuse bodies above 1 MiB / 16 MiB.

### A4 `decodeEntities` throws on out-of-range code points

**Change** (`src/core/packDocs/xmlLite.ts:42`): `const valid = code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff); return valid ? String.fromCodePoint(code) : whole;`

**Tests** (`src/test/xmlLite.test.ts`): `decodeEntities('&#99999999; &#x110000; &#xD800; &#x41; &#65;') === '&#99999999; &#x110000; &#xD800; A A'`; `parseXml('<a>&#99999999;</a>').text` does not throw.

**CHANGELOG.** A pdsc with an out-of-range numeric character reference made `list_target_docs` fail with "Invalid code point".

### A5 `downloadPdf` write-stream error handling

**Change** (`src/core/packDocs/webFetch.ts:247-250`): right after `createWriteStream(part)`: `const failed = new Promise<never>((_, reject) => out.once('error', reject)); failed.catch(() => undefined);`; in the loop `await Promise.race([drainPromise, failed])`; replace line 250 with `await Promise.race([new Promise<void>(resolve => out.end(resolve)), failed])`. The existing catch (destroy, unlink `.part`, rethrow) handles it.

**Tests** (`src/test/webFetch.test.ts`): `fs.mkdirSync(path.join(dir, 'e.pdf.part'))` so the stream fails with EISDIR → `assert.rejects(downloadPdf(...), /download of .* failed: .*EISDIR/)` and no `e.pdf`. Mocha fails on an uncaught exception, which is the pre-fix behaviour.

**CHANGELOG.** A disk error while `fetch_doc` was writing a download crashed the extension host or left the call hanging.

### A6 One shared `run()` fence that keeps observing the body

**Root cause.** `packDocsHandler.ts:742-765` and `buildInfoHandler.ts:305-328` are identical apart from `TIMEOUT_NOTE`; `BuildInfoLog` is `PackDocsLog` (`src/core/buildInfo/host.ts:28`).

**Change.** New `src/core/toolRun.ts`: `runTool(tool, call, args, log, { defaultTimeoutMs, timeoutNote }, body)`. Same body as today plus `const work = body(scoped, deadline); work.catch(e => scoped.debug('finished after the timeout: …'));` before `Promise.race([work, timeout])`. Both handlers' `run` delegate to it; clamping (`100..600_000`), the `→`/`←` log lines and the 30-line trace move unchanged. Add `src/core/toolRun.ts` to the packDocs.md file table.

**Tests.** New `src/test/toolRun.test.ts`: `process.on('unhandledRejection', spy)` in setup; body rejecting 40 ms after a 20 ms default timeout → result `/timed out after 20 ms/`, spy not called after 80 ms, log has `finished after the timeout: late`; rejection before the timer → `x failed: boom`; success → `← \d+ ms, \d+ bytes`; clamping of `timeoutMs: 5` → 100 and `10_000_000` → 600 000. Existing handler timeout tests stay as integration pins.

**CHANGELOG.** A documentation or build-artefact call failing after its timeout was reported left an unhandled rejection.

### A7 `workspaceRegistry` atomic write and tolerant read

**Change.** New `src/utils/atomicFile.ts`: `writeFileAtomicSync` / `writeFileAtomic` — temp `${filePath}.${pid}.${random hex}.tmp`, write, rename; unlink temp and rethrow on failure. `workspaceRegistry.ts`: keep `this.current`; `register()` uses the atomic write; `heartbeat()` rewrites `this.current` with a fresh `updatedAt` without reading (heals a mistaken prune); `list()` considers only `window-*.json`, on parse failure unlinks only if `mtime` is older than `STALE_MS`, else skips; sweeps `*.tmp` older than `STALE_MS`. Export `isProcessAlive`.

**Tests** (`src/test/workspaceRegistry.test.ts`): replace the corrupt-file test with "fresh unparsable file is skipped, not deleted" and "unparsable file older than a minute is pruned" (`fs.utimesSync`); "heartbeat rewrites without reading" (delete file, heartbeat, list shows it); "stale temp file swept". New `src/test/atomicFile.test.ts`: two concurrent 1 MB writers → exactly one whole file, no `*.tmp`; failed write (missing dir) leaves no temp; sync variants.

**CHANGELOG.** A window could lose its multi-window registry entry while another window read it.

### A8 `removeStaleStaging` deletes a live window's staging

**Change** (`src/utils/skillInstaller.ts:313-318`): constructor gains `isAlive: (pid: number) => boolean = isProcessAlive`; in the sweep, `const pid = Number(entry.slice(prefix.length)); if (pid === process.pid || (Number.isInteger(pid) && this.isAlive(pid))) { continue; }`.

**Tests** (`src/test/skillInstaller.test.ts`): `installer()` helper passes `() => false` so the existing interrupted-sync test (`:233`) can't go flaky; new test with `pid => pid === 12345`: `.gen.tmp-12345` kept, `.gen.tmp-67890` removed, `gen/SKILL.md` installed, `report.failed` empty.

**CHANGELOG.** Two windows syncing skills at once could delete each other's in-progress copy.

### A9 `writeFileAtomic` unique temp name; TOML through the atomic path

**Change** (`src/utils/agentConfigurationManager.ts`): delete the private `writeFileAtomic` (`:418-427`), import from `./atomicFile`; replace `this.writeFileAtomic(` at `:529, :574, :681`; replace the TOML `fs.promises.writeFile` at `:494` and `:641` with `writeFileAtomic(agent.configPath, …)`. Update the sentence in `docs/architecture/agentConfigurationManager.md` to name `src/utils/atomicFile.ts`.

**Tests.** Do **not** instantiate `AgentConfigurationManager` in tests (it resolves and writes the real `~/.claude.json`). Add a source-grep guard in `atomicFile.test.ts`: `!/fs\.promises\.writeFile\(\s*agent\.configPath/.test(src)`.

**CHANGELOG.** Two windows writing an agent configuration at the same time could clobber each other's temp file; Codex `config.toml` is now written atomically.

## Phase 2 — security / containment and MEDIUM bugs

Sequencing: B11 → B12 → B8 → B9 → B10 (B10's tests rely on B9's suffix rule) → B3 → B2 → B1 (B1 relies on B2's bounded close) → B7 → B6 → B5 → B4 → B13 (after A9) → B14 (after A3) → the three test files (any time).

### B11 — `fetch_doc` follows any URL, including loopback / private / metadata addresses

**Root cause.** `directPdfResolver.matches` (`src/core/packDocs/webFetch.ts:180`) accepts every `https?://` URL, and all four network calls (`getJson` :115, HEAD :187, ranged GET :199, `downloadPdf` :232) pass `redirect: 'follow'`, so neither the initial host nor any redirect target is inspected. A prompt-injected `<book url>` reaches `http://127.0.0.1:<port>/` or `169.254.169.254`, and the error text leaks status and content type per port.

**Change.**

1. New exported helpers in `webFetch.ts`:
   - `blockedHostReason(hostname: string): string | undefined` — input is `new URL(url).hostname` (WHATWG already normalises `2130706433`, `0x7f.1`, `017700000001`). Block `localhost` / `*.localhost`; IPv4 `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `100.64/10`, `224/4`, `255.255.255.255`; IPv6 `::`, `::1`, `fe80::/10`, `fc00::/7`, `::ffff:a.b.c.d` re-checked as IPv4; names `metadata.google.internal`, `metadata`, `instance-data`. No DNS lookup in this phase.
   - `MAX_REDIRECTS = 5`.
   - `fetchGuarded(url, init, ctx)`: loop ≤ MAX_REDIRECTS: parse, refuse non-http(s), if `!ctx.allowPrivateHosts && blockedHostReason(hostname)` throw `` `${url} points at a local or private address (${reason}); fetch_doc downloads public documents only — copy the PDF into the workspace docs folder instead` ``; `fetchFn(url, { ...init, redirect: 'manual' })`; on 301/302/303/307/308 with `location`, resolve against `url`, log at debug, continue; after loop throw `too many redirects`. If `res.url` differs from `url` (a fetchFn that followed anyway), re-check its hostname.
2. `ResolveContext` gains `allowPrivateHosts?: boolean` (tests / loopback fixtures only); `PackDocsHost` mirrors it; `PackDocsHandler.fetchContext` (`packDocsHandler.ts:674`) does not set it in production.
3. Replace the four `ctx.fetchFn(url, {..., redirect: 'follow'})` with `fetchGuarded`. In `directPdfResolver.resolve` check the blocked reason once up front and return `{ error }` directly so the HEAD/GET fallbacks don't spam the log. `downloadPdf`'s catch wraps as `download of ${url} failed: …`.

**Tests** (`src/test/webFetch.test.ts`, existing `fakeFetch` with hosts `x` / arm.com keeps working): `blockedHostReason` table (blocked: `127.0.0.1`, `localhost`, `foo.localhost`, `10.1.2.3`, `172.16.0.1`, `172.31.255.255`, `192.168.1.1`, `169.254.169.254`, `0.0.0.0`, `::1`, `fe80::1`, `fd00::1`, `::ffff:127.0.0.1`, `metadata.google.internal`; allowed: `172.32.0.1`, `x`, `documentation-service.arm.com`, `8.8.8.8`, `2606:4700::1`); direct private URL refused with zero fetch calls; 302 to `169.254.169.254` refused after one call; 302 `https://x/r.pdf → https://x/a.pdf` resolves `kind: 'pdf'`; 6 self-redirects → `/too many redirects/`; `allowPrivateHosts: true` lets 127.0.0.1 through; `downloadPdf` with a 302 to a private host rejects and leaves no `.part`.

**CHANGELOG.** `fetch_doc` no longer reaches local or private addresses: loopback, link-local, RFC 1918, CGNAT and cloud-metadata targets are refused before any request, and redirects are followed one hop at a time with the same check on every target.

**Risk.** Intranet 10.x PDF hosts lose `fetch_doc` (message names the workspace docs folder). Public names resolving to private addresses are not caught (documented limitation).

### B12 — `get_build_diagnostics { file }` reads any absolute path

**Root cause.** `src/buildInfoHandler.ts:194-197` resolves `args.file` (absolute as-is, relative against `this.root() ?? process.cwd()`), checks existence and hands it to `readBuildLog`. The glob path applies `looksLikeBuildLog` (:294); the explicit path applies neither containment nor the sniff.

**Change.**

1. `src/core/buildInfo/glob.ts` (exported via `core/buildInfo/index.ts`): `isInsideAny(file: string, roots: string[]): boolean` — `realpathSync.native` both sides when they exist (fallback `path.resolve`), `path.relative(root, file)` must not start with `..` nor be absolute; lower-case compare on win32.
2. In `handleGetBuildDiagnostics`: `roots = [this.root(), ...this.host.workspaceFolders()].filter(Boolean)` (the host already exposes `workspaceFolders()`; see `src/packDocsHost.ts:75` for the same source). No roots → `'No workspace folder is open; file must be inside a workspace folder.'`. Resolve relative paths against `this.root()` only (drop `process.cwd()`). Outside → `` `${args.file} is outside the workspace (${roots}); get_build_diagnostics reads build logs inside the open workspace only.` `` (do not reveal existence). Then `existsSync`, then `looksLikeBuildLog` → `does not look like a build log (no compiler, cbuild or cmake output in its first 64 kB)`.

**Tests** (`src/test/buildInfoHandler.test.ts` near :319): tmpdir `outside.log` → `/outside the workspace/`; `'../../outside.log'` → same; in-workspace `notes.txt` with `hello` → `/does not look like a build log/`; second root via `{ ...world.host, workspaceFolders: () => [world.workspace, otherRoot] }` with a real log → renders. Unit-test `isInsideAny` (prefix trap `/ws2/x` vs `/ws`; symlink pointing out).

**CHANGELOG.** `get_build_diagnostics { file }` reads build logs inside the open workspace only; a file with no compiler or cbuild output is reported as not a build log.

**Risk.** Logs in scratch dirs outside the workspace must be added to the workspace or `buildInfo.logGlobs`.

### B1 — serial teardown only runs in the router window

**Root cause.** `DebugMCPServer.stop()` (`src/debugMCPServer.ts:1364-1372`) closes `serialController` and unsubscribes `serialMonitorBridge`, but the server only exists in the router. Serial ops execute in the forwarded-to window (`ControlServer.dispatch` → `serialHandler`), and `WindowCoordinator.dispose()` (`src/windowCoordinator.ts:228-246`) only stops servers.

**Change.** Delete the block from `stop()`. `CoordinatorOptions` gains `serialTeardown?: () => Promise<void>` (injectable), defaulting in `windowCoordinator.ts` to `async () => { await serialController.close(); serialMonitorBridge.unsubscribe(); }` with static imports. In `dispose()`, after `controlServer.stop()`: `await Promise.race([teardown(), delay(2_000)]).catch(err => logger.warn(...))` so a wedged tty cannot hang `deactivate` (`src/extension.ts:296` awaits dispose).

**Tests.** New `src/test/windowCoordinator.test.ts`: coordinator with `port: 0`, tmp registry, counting `serialTeardown`; `dispose()` without `start()` → called once; never-resolving teardown → `dispose()` settles < 2.5 s.

**CHANGELOG.** A window that opened a serial port releases it on close whether or not it was the router.

### B2 — `server.close()` can block `deactivate`

**Root cause.** `debugMCPServer.ts:1380` and `controlServer.ts:66` await `server.close()`, which waits for every open connection (in-flight forwarded op, MCP GET SSE stream, idle keep-alive socket).

**Change.** New `src/utils/closeHttpServer.ts`: `closeHttpServer(server, graceMs = 2_000)` — `server.close(cb)`, `server.closeIdleConnections?.()`, timer at `graceMs` calling `server.closeAllConnections()`; resolve on the close callback. Use in `DebugMCPServer.stop()` (after the transports loop) and `ControlServer.stop()`.

**Tests** (`src/test/routing.test.ts`, which already starts real `ControlServer`s): op that never settles, fire a request, wait 100 ms, `stop()` returns < 3 s and the client sees `socket hang up`.

**CHANGELOG.** Closing a window no longer waits on open MCP or control connections.

### B3 — `serialController.close()` leaves state set when close rejects

**Root cause.** `src/core/serialController.ts:129-135`: the awaited `p.close(cb)` rejects (unplugged USB → EIO) before `this.port = null; …`, so `open()` throws "already open" forever.

**Change.** Wrap the await in `try { … } finally { this.port = null; this.openedAt = null; this.currentPath = null; this.currentBaud = null; }`; still rethrow.

**Tests.** New `src/test/serialController.test.ts`: inject a fake port whose `close` calls back with `EIO`; `assert.rejects(close(), /EIO/)`, then `isOpen() === false`, `status().path === null`; a succeeding fake gives the same cleared state.

**CHANGELOG.** `serial_close` after the adapter was unplugged no longer wedges `serial_open`.

### B4 — `resetTarget` messaging and `halt:false`

**Root cause.** `src/debuggingExecutor.ts:1198-1200` sets "…trying the next method" and `continue`s even on the last method. `:1224-1226` resumes only `if (outcome.verified && !leaveHalted)`; an unverified reset with `halt:false` leaves the target halted silently; `haltedByUs` (set at :1178) is never read; `handleReset` (`src/debuggingHandler.ts:583-598`) renders inline.

**Change.**

1. `src/core/resetAssist.ts`: `unsupportedResetDetail(method, remaining)` — with remaining > 0 keep the current text, else `adapter did not recognize the ${method} reset command; no further method to try`. Executor switches to an indexed loop to know `remaining`.
2. `ResetOutcome` gains `resumed: boolean`; keep `haltedByUs`. After the loop: `if (!leaveHalted && outcome.verified) { await this.continue(dapMs); outcome.resumed = true; }` (never resume an unverified target).
3. Move `ResetOutcome` and rendering into `renderResetOutcome(outcome, halt)` in `resetAssist.ts`; `handleReset` calls it. Unverified branch appends `The target is halted${haltedByUs ? ' (it was running before the reset)' : ''}${halt === false ? '; halt=false was not applied because the reset could not be verified' : ''} — use continue_execution to run.`; verified + `halt===false` prints "Target resumed" only when `resumed`.

**Tests** (`src/test/resetAssist.test.ts`): `unsupportedResetDetail('hardware', 0)` has no "next method"; `('system', 2)` does; `renderResetOutcome` for unverified+haltedByUs+halt:false, verified+resumed, verified default.

**CHANGELOG.** `reset` tells the truth about the end state.

**Risk.** Behaviour unchanged (unverified stays halted) but now reported.

### B5 — dead `coreclr` branch with a floating promise

**Root cause.** `debuggingExecutor.ts:174-179` opens `config.program` and fires `testing.debugCurrentFile` unawaited, returning `true`. `grep -rn coreclr src/` first: `debugConfigurationManager.ts` only *generates* a coreclr config (Phase 3 removes it).

**Change.** Delete the block; all types go through `vscode.debug.startDebugging`. Type-check + lint only.

### B6 — hard-coded 10 s DAP timeout in `peripheralReader`; `evaluateMemoryWord` ignores the caller's timeout

**Root cause.** `src/core/peripheralReader.ts:30` `PERIPHERAL_DAP_TIMEOUT_MS = 10000` used by `readWord` (:268, :286, :302); the user's `dapRequestTimeoutMs` (`src/extension.ts:44` → `HardwareTimeouts.dapRequestMs`) never reaches it. `debuggingExecutor.ts:1027` calls `evaluateMemoryWord(session, addr)` after computing `dapMs` at :999, but its three strategies (:1038, :1054, :1074) use `this.timeouts.dapRequestMs`.

**Change.** Thread `dapTimeoutMs` through `readPeripheralViaMemory → readAllRegisters → readWord` (delete the constant); executor `readPeripheralRegister` (:1373) passes `capTimeout(timeoutMs, this.timeouts.dapRequestMs)`. `evaluateMemoryWord(session, hexAddr, dapMs, frameOpt?)` uses `dapMs` in all three strategies; update every caller (grep `evaluateMemoryWord(`). Export `readWord` for tests.

**Tests.** New `src/test/peripheralReader.test.ts`: fake session with hanging `customRequest` → `readWord(..., 50)` rejects with `HardwareTimeoutError { timeoutMs: 50 }`; a session whose `readMemory` throws and `evaluate` answers `'0x12345678'` returns that value.

**CHANGELOG.** `read_peripheral_register` honours `dapRequestTimeoutMs` and the call's `timeoutMs`; GDB evaluate fallbacks forward the same deadline.

### B7 — per-session McpServer/transport leaked when session setup throws

**Root cause.** `debugMCPServer.ts:1213-1228`: transport + `createMcpServer()` built, then `connect`; if `connect` or the first `handleRequest` (:1238) throws before `onsessioninitialized`, the pair is never registered nor closed; the catch at :1239 only answers 500.

**Change.** Track `fresh: { transport, server }` in the handler; in the catch, if `fresh` is not in `this.transports`, `await fresh.transport.close().catch(() => {}); await fresh.server.close().catch(() => {});` and warn.

**Tests.** Cover in `test/transport/session-lifecycle.js`: malformed `initialize` body, assert `process._getActiveHandles().length` doesn't grow; mark manual if flaky.

### B13 — whole-file read-modify-write of `~/.claude.json`

**Root cause.** `agentConfigurationManager.ts:664-684` and `:481-577` read, mutate, and `writeFileAtomic` possibly seconds later (after `getSupportedAgents()` and user prompts). Claude Code rewrites `~/.claude.json` constantly; a write in between is lost.

**Change (minimal, no lock).** New `src/utils/jsonFileRewrite.ts`: `rewriteJsonFile(file, mutate: (config) => boolean | Promise<boolean>, { attempts = 3 })` → `'written' | 'unchanged' | 'unparseable'`. Read text, parse, call `mutate` on a fresh parse, `false` → `'unchanged'`; re-read immediately before writing; if the text differs from what was parsed, retry from the top (≤ attempts, then throw `changed underneath the write three times`); write via `${file}.${pid}.${Date.now()}.tmp` + `rename` (shares A9's unique temp name). Use it for the JSON branches of both methods; keep the "refuse to overwrite unparseable" message.

**Tests.** New `src/test/jsonFileRewrite.test.ts`: unrelated keys preserved; a `mutate` that on first call writes a different file (simulated concurrent writer) → final file has both changes and `mutate` called twice; unparseable → `'unparseable'` untouched; 4 consecutive concurrent changes → rejects.

**CHANGELOG.** Agent configuration files are re-read immediately before they are written and the update retried when another process changed the file in between.

### B14 — four small items (one CHANGELOG bullet)

- **`confirmSessionSurvives` budget** (`src/debuggingHandler.ts:1900-1912`, called at :2151 after an 8 s wait): two fixed 3 s sleeps plus two 5 s `getThreads` probes → up to 16 s. Give it `budgetMs` from the remaining handler deadline (`withHandlerTimeout` knows `deadline - Date.now()`), probes at 35 % and 75 % of budget, each `getThreads` capped at `min(5_000, budget/4)`; keep current constants as default. Extract pure `probeSchedule(budgetMs)` and assert its sum ≤ budget.
- **`getThreads` fan-out** (`src/debuggingExecutor.ts:1433`): one `stackTrace` per thread via `Promise.all`. Fetch top frames for the first 32 threads only (the handler lists 32), in sequential batches of 4; `topFrame` undefined beyond the cap.
- **`tryBecomeRouter` cleanup** (`src/windowCoordinator.ts:134-147`): in the catch, `await server.stop().catch(() => {})` before rethrowing (safe for PortInUseError; `stop()` is a no-op when `httpServer` is null).
- **`controlServer` `req.on('error')`** (`src/controlServer.ts:80-82`): add `req.on('error', err => { logger.warn(...); if (!res.headersSent) { res.writeHead(400).end(); } })`. Lands after A3's edit of the same lines. Test in `routing.test.ts`: write half a body then `req.destroy()`; the server survives and the next request succeeds.

### B8 — `maxPdfMb` not enforced on `read_doc_pages` and `indexDocument`

**Root cause.** The size check is duplicated in `ensureAll` (`packDocsHandler.ts:611,621`) and `indexTarget` (:693,696) but absent from `handleReadDocPages` (:255-260 → `store.ensure`) and `indexDocument` (:587-588).

**Change.** One private helper `oversize(doc: DocRef): string | undefined` returning `` `${MB} MB exceeds maxPdfMb ${maxMb} (cmsis-developer-assistant.packDocs.maxPdfMb)` ``. `ensureAll` pushes it to `skipped`; `indexTarget` `continue`s; `handleReadDocPages` (only when not already extracted) returns `` `${doc.id} is not indexed and will not be extracted: ${why}.` ``; `indexDocument` throws it (`packDocsCommands.ts:154` already reports "indexing failed — …"). `fetchContext` keeps the download-side `maxBytes`.

**Tests** (`packDocsHandler.test.ts`): handler over `{ ...world.host, settings: () => ({ ...defaultSettings, maxPdfMb: 0.0001 }) }` → `handleReadDocPages({ doc: 'test-rm', pages: '1' })` matches `/will not be extracted: .*exceeds maxPdfMb/` and no `.pages.jsonl` is written; default handler then reads page 1. `userDocs.test.ts`: `indexDocument` with the tiny limit rejects `/exceeds maxPdfMb/`.

**CHANGELOG.** `packDocs.maxPdfMb` applies to `read_doc_pages` and imported documents too.

### B9 — `findKnown` returns the first substring match silently

**Root cause.** `packDocsHandler.ts:717-719` returns the first `endsWith('/'+lower) || includes(lower)` hit in Map order.

**Change.** `lookupKnown(id): { doc?: DocRef; ambiguous?: DocRef[] }`: exact → case-insensitive exact → suffix `/${lower}` (unique → doc, several → ambiguous) → `includes` (same). Keep `findKnown = lookupKnown(id).doc` for `handleFetchDoc`'s arm-id path (:280); `handleReadDocPages` (:237, :242) and `handleFetchDoc` (:292, :297) return `` `Document id '${id}' is ambiguous — it matches ${ids}. Pass one of these ids.` `` on `ambiguous`. `handleSearchTargetDocs` keeps its multi-match filter (:181-186).

**Tests** (`packDocsHandler.test.ts`, after `handleListTargetDocs({})` populates `knownDocs`): `{ doc: 'rm' }` → `/ambiguous — it matches .*stm32f7xx-dfp\/test-rm.*workspace\/vendor-rm/`; `'test-rm'` unique suffix → page text; `'TEST-RM'` → page text; `handleFetchDoc({ doc: 'rm' })` → same ambiguity line.

### B10 — user-document ids collide across scope folders

**Root cause.** `userDocs.ts:157` and `:240` build `user/${fileSlug(name)}` ignoring the folder; `dedupeIds` (`pdscBooks.ts:350`) renames the second to `-2` depending on sort/enumeration order, so ids swap between calls. `packDocsCommands.ts:139` recomputes the id independently of `importUserDoc`.

**Change.** `userDocId(root, file)` in `userDocs.ts` → `'user/' + [...relative dir segments mapped through slug, fileSlug(basename)].join('/')`; root-level files stay `user/<file>`. Use in `pdfsIn` and `importUserDoc`; `packDocsCommands.ts:139` uses `r.id`. `PageStore.paths` (`pageStore.ts:185-186`) keys by `shortHash(dirname)` + slug, so extracted text and indexes stay valid. Update the id table in `docs/architecture/packDocs.md` and the `userDocs.ts` header comment.

**Tests.** `src/test/userDocs.test.ts` expectations become `user/keil/stm32u5xx-dfp/sub/an-deep`, `user/devices/stm32u5/errata-prelim`, `user/everyone`, `user/keil/stm32u5xx-dfp/rm0456-nda`, `user/boards/b-u585i-iot02a/schematic`, `user/cores/cortex-m33/trm-notes`, `user/keil/vendor-wide`; handler-level regex at :131/:133/:135 → `user\/keil\/stm32f7xx-dfp\/nda-manual`. New: same `RM0456.pdf` under two scopes → two distinct, stable ids across two `collectUserDocs` calls and after `dedupeIds`; `userDocId(root, root/x.pdf) === 'user/x'`.

**CHANGELOG.** User-document ids name their scope folder; bare file names still work in `docs` filters and `read_doc_pages` when unique.

### Phase 2 test additions

- **`isLoopbackHostHeader` / `isLoopbackOrigin`** — new `src/test/debugMCPServer.test.ts` (both exported at `debugMCPServer.ts:40,56`). Host: `localhost`, `localhost:3001`, `127.0.0.1:3001`, `[::1]:3001`, `LOCALHOST` → true; `undefined`, `''`, `attacker.com`, `127.0.0.1.attacker.com`, `localhost.attacker.com`, `10.0.0.1:3001` → false. Origin: `http://localhost:5173`, `https://127.0.0.1`, `http://[::1]:3001` → true; `null`, `http://attacker.com`, `http://localhost.attacker.com`, `not a url` → false.
- **`withTimeout`** — new `src/test/timeout.test.ts`: hanging promise under 20 ms rejects `HardwareTimeoutError { operation: 'op', timeoutMs: 20 }`; fast resolve clears the timer; `0` and `-1` return the task untouched (race against a 50 ms sentinel); thunk form invoked once; early task rejection propagates unwrapped; `customRequestWithTimeout` with hanging `customRequest` rejects `/DAP threads/`.
- **`PdfjsExtractor` positive timeout / restart / idle / dispose** — `src/test/pageStore.test.ts` after :285. Add constructor `(idleMs = 60_000, entry?: string)` so `spawn()` uses `this.entry ?? workerEntry()`, plus `isRunning()`. New fixture `src/test/fixtures/packdocs/slowPdfWorker.js`: answers `version`; never answers `extract` for basename `hang.pdf`; otherwise returns `pages: [String(threadId)]`. Tests: positive timeout rejects `/timed out after 100 ms/` in < 1 s, `isRunning() === false`, next two extracts share a new thread id; concurrent second `hang.pdf` rejects `/worker terminated/`; `idleMs: 50` retires after 200 ms and restarts on demand with a new id; `dispose()` while pending rejects `/disposed/` within 100 ms and the extractor stays usable. Keep the existing `timeoutMs: -1` assertion.

## Phase 3 — clean-up

Two corrections found while planning: `DebugMCPServer.initialize/getOptions/getMetrics` are used by `windowCoordinator.ts:135` and `test/transport/session-lifecycle.js:99,282,300` — only `isInitialized()`, the `initialized` field and `getDebuggingHandler()` are dead. `CHANGES-VS-UPSTREAM.md:197` is correct as written.

### 3.1 Merge the two `textBudget` modules

**What.** `src/core/textBudget.ts` (canonical: `clipValue` with `maxChars <= 0` guard, suffix `… (+N chars)`; `truncateList` with guard; `shortenPath`) vs `src/core/packDocs/textBudget.ts` (no guards, suffix `… (N more chars)`, plus `formatBytes(n | undefined)` → `'?'`, `'12 B'`, `'2 kB'`, `'3.0 MB'`). Importers of the packDocs copy: `src/core/packDocs/render.ts:26`, `src/core/packDocs/peripheralDocs.ts:39`, `src/core/packDocs/index.ts:40` (`export *`), `src/core/buildInfo/render.ts:24`. A *third* `formatBytes` in `src/core/toolMetrics.ts:82` renders differently and is pinned by `toolMetrics.test.ts:90-93`; leave it.

**How.** Append the packDocs `formatBytes` to `src/core/textBudget.ts`; delete the packDocs copy; fix the four import paths (`index.ts` → `export * from '../textBudget'`). Remove the "drop `core/packDocs/textBudget.ts`" sentence from `docs/architecture/packDocs.md` §Follow-ups.

**Tests.** `src/test/buildInfoHandler.test.ts:253` and `src/test/search.test.ts:170` pin the old suffix → change to `/\(\+\d+ chars\)$/`. Add to `textBudget.test.ts`: `formatBytes(undefined) === '?'`, `formatBytes(1536) === '2 kB'`, `clipValue('abc', 0) === 'abc'`.

**Risk.** Low; only `maxChars: 0` callers change, and none exist.

### 3.2 Delete dead code

**Verified zero callers** (grep `src`, `scripts`, `test`, `docs`):

- `src/debugState.ts:76-152` `reset/clone/hasValidContext/hasLocationInfo/hasFrameName` — only `docs/architecture/debugState.md` names them (5.4).
- `src/debuggingHandler.ts:1082` `getCurrentDebugState()`, `:1089` `isDebuggingActive()` — not in `IDebuggingHandler`; the other hits are `this.executor.getCurrentDebugState`.
- `src/debugMCPServer.ts:192` `initialized`, `:1411` `isInitialized()`, `:1404` `getDebuggingHandler()` — delete; keep `initialize()` (make it a documented no-op if its body is empty after removing the flag).
- `ResetOutcome.haltedByUs` (`debuggingExecutor.ts:116`, set at `:1167,1178`) — keep if B4 lands, else delete.
- `src/utils/debugConfigurationManager.ts`: `validateWorkspace` (:241), `getAvailableConfigurations` (:254), `hasLaunchJson` (:279), `getAutoLaunchConfigName` (:450). `createTestDebugConfig` (:332-445) *is* reachable through `start_debugging { testName }` (`debugMCPServer.ts:385` → `handleStartDebugging` → `getDebugConfig`). Decision: CMSIS firmware has no test runner (CHANGES-VS-UPSTREAM §9 rejects test debugging) → remove `testName` from the tool schema, `IDebuggingHandler.handleStartDebugging` and `IDebugConfigurationManager.getDebugConfig`; delete `createTestDebugConfig`, `extractPythonClassName`, `formatPythonTestName`. Language map (:143-158): drop `.go/.rs/.php/.rb` (no matching `configs` entries at :180-236, so they fall through to undefined); keep the entries that have configs. Delete the `coreclr` executor branch (B5).
- `src/core/packDocs/chapters.ts:54` identity `.replace(/^x|x$/g, m => m)`.

**Tests.** Existing suites compile unchanged. New `debugConfigurationManager.test.ts` case: `detectLanguageFromFilePath('x.rs')` returns the default (recommend `'cppdbg'` for this extension).

**Risk.** Medium only for the `testName` schema removal (public tool surface); transport tests assert names, not schemas. Mention in CHANGELOG.

### 3.3 Remove upstream leftovers

**What.** `getRootCauseAnalysisCheckpointMessage()` (`src/debuggingHandler.ts:1265-1291`, appended at `:301` to every `stop_debugging`). Language resources loop `src/debugMCPServer.ts:1047-1074` registers `python/javascript/java/csharp`; `docs/agent-resources/troubleshooting/` holds `cpp, csharp, embedded, go, java, javascript, python` (`cpp.md`, `go.md` already unregistered). Checked: `instructionTopics.test.ts:119` asserts `ROOT CAUSE` in debug_instructions.md's topic, not this string; `skill.test.ts:95` checks the skill's copy; the transport test reads only `stats`; `.vscodeignore` ships `docs/agent-resources/**`; nothing links `troubleshooting/<lang>`.

**How.** `handleStopDebugging` returns a one-line CMSIS hint ("clear_all_breakpoints if you set any; cmsis_action load_and_debug to start again"). Delete the method, the `languages`/`languageTitles` loop, and `git rm` the six non-embedded troubleshooting files. Remove the `troubleshooting/<lang>` row from AGENTS.md and `docs/architecture/debugMCPServer.md`.

**Tests.** `debuggingHandler.test.ts` with a fake executor (`hasDebugSession: () => true, stopDebugging: async () => {}`): result does not match `/ROOT CAUSE ANALYSIS CHECKPOINT/`.

### 3.4 Deduplicate

- **run() fence** — done by A6 (`src/core/toolRun.ts`); nothing remains.
- **`unquote`** — `src/core/packDocs/cbuildRun.ts:135` and `src/core/buildInfo/artifacts.ts:106` identical; export from `cbuildRun.ts`, import in `artifacts.ts` (buildInfo already depends on packDocs via `render.ts`).
- **`GROUP_OF`** — `coreHeader.ts:47` and `coreSvd.ts:37` agree on shared keys; coreSvd adds `EWIC_ISA, BPU, CTI` + six memory-system names, coreHeader adds `CoreDebug, ETM, MTB`. One exported `CORE_PERIPHERAL_GROUP` in `coreSvd.ts` as the union; `coreHeader.ts` imports it. Existing tests pin group strings that don't change.
- **glob→regex** — `userDocs.ts:90` is a *name* glob (`*` → `.*`, case-insensitive); `buildInfo/glob.ts:27` is a *path* glob (`*` → `[^/]*`, `**/`, case-sensitive). Do **not** merge into one function. Optional: `src/core/glob.ts` with `nameGlobToRegExp` and `pathGlobToRegExp` sharing the escape helper; otherwise drop the item.
- **GDB word-read ladder** — new `src/core/gdbMemory.ts` exporting `parseGdbInt(raw)` and `readWordViaGdb(session, hexAddr, frameOpt, timeoutMs)` (watch → `-exec x/1xw` → `-exec print/x`; `HardwareTimeoutError` rethrown immediately). `peripheralReader.readWord` becomes DAP readMemory → `readWordViaGdb` with `timeoutMs` threaded from `readPeripheralViaMemory` (completes B6); `evaluateMemoryWord` keeps only its frame-id lookup and delegates, forwarding `dapMs`. Delete `parseGdbIntResult`/`parseGdbInt` duplicates.
- **GDB reply sniff regex** — hoist `/Deleted|Breakpoint|No source|No symbol/i` (`debuggingHandler.ts:326, 916`) to a module constant `GDB_BREAKPOINT_REPLY` next to `classifyGdbBreakpointReply` (`:604`).
- **`0x` normalisation** — `ensureHexPrefix(address)` in `src/core/memoryMap.ts` (already houses `formatAddress`); use at `debuggingExecutor.ts:951, 998, 1116` and `debuggingHandler.ts:1307`.
- **Serial read** — `serialController.ts:153-186` and `serialMonitorBridge.ts:219-244` identical (`read`, `clearBuffer`, `appendToBuffer` with cap + warn). Extract `src/core/rxBuffer.ts` `class RxBuffer { append(chunk); read({ maxBytes, waitMs, consume }); clear(); get length }` (25 ms poll, `MAX_BUFFER_BYTES`); both own one instance and delegate.

**Tests.** `gdbMemory.test.ts` and `rxBuffer.test.ts` (Phase 4); `memoryMap.test.ts` gains `ensureHexPrefix('40020000') === '0x40020000'`, `'0X1'` unchanged.

**Risk.** The ladder move touches every hardware read path — run `test:realboard` or the FVP fixture after it.

### 3.5 Split `DebugMCPServer.setupTools` and `start`

**Constraint.** `src/test/skill.test.ts:42` greps `registerTool('name'` literals from `debugMCPServer.ts`, `packDocsTools.ts`, `buildInfoTools.ts` — add any new file to that list.

**How.** New `src/debugTools.ts` modelled on `src/packDocsTools.ts` (`text()` helper, one `TIMEOUT_DESC`, exported `register*`):

- `registerCoreDebugTools(mcpServer, handler, metrics)` — 22 tools: `get_debug_instructions, start_debugging, stop_debugging, step_over, step_into, step_out, pause_execution, continue_execution, wait_for_stop, restart_debugging, add_breakpoint, add_logpoint, remove_breakpoint, clear_all_breakpoints, list_breakpoints, list_variable_names, get_variables_values, evaluate_expression, get_call_stack, get_threads, get_frame_variables, get_session_status` (the last needs `metrics.formatTotals()`).
- `registerEmbeddedTools(mcpServer, handler)` — 13: `reset, read_memory, read_core_registers, read_cycle_counter, read_peripheral_register, get_fault_info, diagnose_fault, lookup_peripheral, lookup_register, get_device_info, check_target_connection, cmsis_action, flash`.
- `registerSerialTools(mcpServer, serial)` — the ten `serial_*` (gating comment at `:790-802` moves with them).
- `registerRoutingTools(mcpServer, router)` — `list_debug_windows, select_debug_window`.

`setupTools` shrinks to the gates (always core + embedded; `serialEnabled !== false`; `packDocsEnabled`; `buildInfoEnabled`; `isRoutingHandler(handler)`). Delete the orphaned JSDoc at `:302-309`. `start()` → `installLoopbackGuard(app)`, `installMcpRoutes(app)` (POST/GET/DELETE `/mcp`, `/sse` 410; the per-session creation at `:1205-1250` becomes `openSession(req, res)` and hosts B7's cleanup), then the existing `listenOnce`.

**Tests.** Update `skill.test.ts:42`; `test/transport/session-lifecycle.js` (tool count > 30, six named tools, 30 000-byte budget) and `two-window-routing.js` must pass unchanged — they catch accidental description edits.

### 3.6 `console.*` → `logger`, then lint rules

**Sites.** `src/debugMCPServer.ts:1154` (error); `src/debuggingExecutor.ts:573,634,676` (→ `debug`, they fire on every ROM/asm stop); `src/utils/debugConfigurationManager.ts:65,69,97,132,246,271,301` (four vanish with 3.2); `src/utils/agentConfigurationManager.ts:273,304,339,496,562,584,587,646,662,686,689,1138` (`:273,587,662,689,1138` → `error`, `:304` → `warn`, "Successfully…" → `info`). `src/packDocsPanel.ts:682` is webview-side: replace with `vscode.postMessage({ type: 'panel.error', message })` and add `case 'panel.error'` in `PackDocsPanel.onMessage` (`:97`) → `logger.warn`.

**eslint.config.mjs.** `@typescript-eslint/eslint-plugin` ^8.56 is installed and wired as `typescriptEslint`; add `"no-console": "error"`, `"@typescript-eslint/no-explicit-any": "warn"`, plus `{ files: ["src/test/**"], rules: { "no-console": "off" } }`.

### 3.7 `any` removal

- `IDebuggingExecutor.getVariables`/`getVariablesForFrame` (`debuggingExecutor.ts:69,92`) → `Promise<{ scopes: DapScope[] }>`; `evaluateExpression` (`:70`) → `Promise<DapEvaluateResponse>` (new interface in `src/core/variableView.ts`: `result, type?, variablesReference?, memoryReference?`). The handler casts at `debuggingHandler.ts:980` and `:1721` go.
- Express handlers `debugMCPServer.ts:1176,1205,1257,1273` → `import type { Request, Response, NextFunction } from 'express'` (type-only; fine with `@types/express` in devDependencies). Prefix unused `req` at `:1273` with `_`.
- `SerialMonitorBridge` (`:65,71,91,170,171,190,202`): `type SerialMonitorApi = Record<string, unknown>`; `findDataEvent(api: unknown)`, `onData(evt: unknown)`, `coerceToBuffer(evt: unknown)` with `Buffer.isBuffer` / `typeof` / `ArrayBuffer.isView` guards.
- `agentConfigurationManager.ts:501,650` → `Record<string, unknown>` with the server entry typed `MCPServerConfig` (`:46`).
- `packDocsHost.ts:99` and `windowCoordinator.ts:221` → `Record<string, unknown>` plus a `pathFrom(record)` helper in `src/core/cmsisTarget.ts` (`solutionFile ?? fsPath ?? path ?? uri.fsPath` with `typeof` checks) — both read the same command result.
- `logger.ts:33,43,53,63` `error?: any` → `unknown` (`formatError` already takes `unknown`).
- Remaining `customRequestWithTimeout<any>` in the executor: minimal response interfaces (`{ data?: string; unreadableBytes?: number }`, `{ stackFrames }`, `{ threads }`); `peripheralReader.ts:77-117` gets a peripheral/register shape.

### 3.8 Tooling

- `package.json`: `@types/express` → `devDependencies`. `test` script → `"vscode-test --coverage"` (`.vscode-test.mjs` already sets reporters and output). Add `"test:realboard": "tsx test/realboard/run.ts"`.
- `tsconfig.json`: measured with `tsc --noEmit`: `noFallthroughCasesInSwitch` 0 errors, `noImplicitReturns` 0, `noUnusedParameters` 4 (`peripheralReader.ts:329`, `debuggingExecutor.ts:599`, `debugMCPServer.ts:1273`, `debugConfigurationManager.ts:168`). Enable all three; `_`-prefix or drop the four.
- `git rm --cached dist/extension.js.map`; add `dist/*.map` to `.gitignore` (keep `dist/extension.js`, `dist/pdfWorker.js` tracked — deliberate per project memory).
- `.github/workflows/ci.yml`: delete the linux-only "Lint" and "Compile TypeScript" steps (duplicated by `pretest` and `build`).
- AGENTS.md: Formatting → 4 spaces; File Header → new files carry the Apache-2.0 block (`Copyright 2026 Arm Limited`), inherited files keep the Microsoft line plus the Arm line. Fix `src/packDocsHost.ts:12` "either produced or implied" → "either express or implied".

### 3.9 LOW bugs folded in

- `elf.ts:263,292`: cap `entSize * shnum` / `phnum` at `MAX_TABLE_BYTES` (`:117`) before `readAt`; `:318` if `entsize < SYMBOL_SIZE` treat the symtab as malformed (skip, push a note).
- `buildLog.ts:196-200`: use the byte count from `fs.readSync` (`buf.subarray(0, n)`), drop the partial first line.
- `packDocs/render.ts:212`: return `{ pages, note: 'capped at 50 pages' }`; `handleReadDocPages` appends the note.
- `clipKeepingTail(body, tail, maxChars)` in `src/core/textBudget.ts`; use at `peripheralDocs.ts:467,477` and `buildInfo/render.ts:229,342,388` so the `Next:` hint survives clipping.
- `packDocsHandler.ts:155` `refreshSettings()` calls `this.extractor.dispose?.()` before replacing; add `dispose()` (extractor + `dropCaches`) registered from `createPackDocsHandlers` (`packDocsHost.ts:175`) into `context.subscriptions`.
- `pdscBooks.ts:326`: require the resolved book path to start with `path.resolve(packDir) + sep`, else `missing = true`.
- `userDocs.ts:96` `safeName`: map `/^\.+$/` to `'_'`.
- `extension.ts:42`: default 180.
- `logger.ts`: delete `logLevel`, `shouldLog`, `setLogLevel`, the enum (`LogOutputChannel` applies the user's channel level).
- `skillInstaller.ts:257`: reject `entry.name` not matching `/^[a-z0-9][a-z0-9._-]{0,63}$/` or containing `..`; push to `report.failed`.
- `agentConfigurationManager.ts:723`: items typed `vscode.QuickPickItem & { agent: AgentInfo }`; use `selectedItem.agent`.

**Tests.** Truncated ELF (4.7); `buildInfoLog.test.ts` with a 1 kB `maxBytes` asserting a complete first line; `userDocs.test.ts` `safeName('..')`; `pdscBooks.test.ts` `<book name="../../x.pdf">` → `missing`.

## Phase 4 — tests for untested modules

Pattern: suites run inside the extension host (`.vscode-test.mjs`, `files: 'out/src/test/**/*.test.js'`, mocha timeout 20 s); `vscode` is real and never stubbed; modules needing a `DebugSession` get `{ customRequest: async (cmd, args) => … } as unknown as vscode.DebugSession` (as `routing.test.ts` / `flashController.test.ts` do). Temp dirs via `fs.mkdtempSync(path.join(os.tmpdir(), 'cda-'))`; ports via `listen(0)`. Every file: Apache header, `suite`/`test`, `assert`.

- **4.1 `agentConfigurationManager.test.ts`** — `upsertCodexDebugMCPConfig('', url)` → exactly `[mcp_servers.cmsis-developer-assistant]\nurl = "…"\n`; existing section with `url` replaced, sibling `[mcp_servers.other]` untouched; section without `url` → inserted after the header; CRLF normalised; `"` and `\` escaped. `stripLegacyCodexSection`: removes up to the next `[…]` header only, `removed: true`; absent → unchanged, `false`. `agentConfigHasServer`: JSON with the key → true; legacy key only → false; invalid JSON / array root → false; TOML header with trailing comment → true.
- **4.2 Serial** (`rxBuffer.test.ts`, `serialHandler.test.ts`) — after 3.4: append beyond `MAX_BUFFER_BYTES` keeps newest bytes; `read({ waitMs: 200 })` resolves early on append at 30 ms; `consume: false` leaves the buffer; `maxBytes` slices; `clear()` returns the count. `SerialHandler` gets a constructor `(owned = serialController, monitor = serialMonitorBridge)` for fakes; `handleRead({ format: 'both' })` renders `0000: 48 65 …` and `<no data>`; `from: 'monitor'` hits the bridge fake. `SerialController.close()` clears state when `close` rejects (B3) via an injected port factory.
- **4.3 `gdbMemory.test.ts`** — fake session counting calls: readMemory rejects → watch `'0x12345678'` → value, one evaluate; garbage watch, `x/1xw` `'0x20000000:\t0x000000ff'` → 255; only `print/x` `'$1 = 0x10'` → 16; `HardwareTimeoutError` from the first strategy propagates with no further calls; all fail → `/all GDB strategies exhausted/`; `parseGdbInt` cases.
- **4.4 `memoryMap.test.ts` / `dwt.test.ts`** — `regionOf(0x20000000).kind === 'sram'`; `0x1FFFFFFF` → code; `0xE000ED00` → ppb; `0xFFFFFFFF` and `-1` → vendor; custom regions override; `formatAddress` padding. DWT constants equal the Armv7-M values.
- **4.5 `measuredMcpServer.test.ts`** — `registerTool` with schema: callback records `argBytes === Buffer.byteLength(JSON.stringify(args))`, `outcome 'ok'`, `sessionId` from `extra`; no schema → `argBytes 0`; thrown error → `'error'` and rethrows; `isError: true` → `'error'`; timeout-fence text → `'timeout'`.
- **4.6 `windowCoordinator.test.ts`** — mirror `two-window-routing.js` in mocha: shared registry dir, distinct fake pids, `listen(0)` port, `start({ subscriptions: [] })`; exactly one `isRouter()`; equal `getEndpoint()`; `registry.list().length === 2`; router `dispose()` then worker `tryBecomeRouter()` → promoted; `publish()` writes `hasActiveSession: false`; plus B1's teardown tests. Always dispose both.
- **4.7 Truncated ELF** (extend `buildInfoElf.test.ts` using the synthetic builder at `:130`) — `shnum = shentsize = 0xFFFF` → no throw, bounded; file cut mid table → partial, no throw; `shoff` past EOF → none; symtab `entsize = 4` → no symbols, no `RangeError`.
- **4.8 `headings.test.ts`** — move the two `detectHeading` cases from `tokenizer.test.ts:53,60`; add TOC `.....` line ignored; heading after line 25 → running header; first line > 80 chars → `''`; `12.3.4.5 Title` accepted; `3 42` rejected.
- **4.9 `bm25Index.test.ts`** — `buildIndex` `version 2`, postings `[page, tf, …]`, `lengths`, `headingPostings` only for heading pages; `scorePages`: heading-only hit outranks body-only at `headingWeight 5` not at `0`; `allTermsBoost` only when every weight-1 term matched; expansion term (`0.5`) doesn't withhold it; `limit`; empty → `[]`.
- **4.10 `parseQuery` edge cases** (extend `tokenizer.test.ts`) — `''`; stop-words only; `'レジスタ'` → `terms []` (pin the ASCII-only limitation); `'0x____'`/`'___'` no empty token; unbalanced `'"abc'`.
- **4.11 `timeout.test.ts`** — as specified in Phase 2.
- **4.12 `treeHash.test.ts`** — same tree twice equal; one byte changes the digest; creation order irrelevant; nested path hashed with `/` separators; `listFilesRecursive` lists nested and dot files.

## Phase 5 — documentation

- **5.1 `docs/architecture/debugMCPServer.md`** — rewrite "Streamable HTTP Transport": stateful sessions (`POST /mcp` + `initialize` creates a transport with `sessionIdGenerator: randomUUID` and a per-session `McpServer` via `createMcpServer` `:268`; `mcp-session-id` on later requests; `GET` SSE, `DELETE` closes; `/sse` 410; loopback Host/Origin guard; no port fallback). "Key Code Locations" → the `register*` functions from 3.5. Full tool table: 22 core, 13 embedded, 10 serial, 2 routing (routing only), 5 docs, 5 build, with gates. Drop `troubleshooting/*` from resources.
- **5.2 `debuggingHandler.md`** — delete "State Change Detection", "Exponential Backoff", "Meaningful State Changes", "Root Cause Analysis" and the three non-existent method references. State: motion tools await the DAP stopped event (A1) and return `toCompactString`; every hardware tool wrapped in `withHandlerTimeout` (`:46`; default 30 s, cap 60 s, fence string); `ensureStoppedSession` gate (`:347`); breakpoints via VS Code and GDB (`classifyGdbBreakpointReply`, `resolveBreakpointLines`, logpoint translation); `cmsis_action` (target switching, `confirmSessionSurvives`), `flash`, `reset`, `diagnose_fault`; per-window handler with `RoutingDebuggingHandler` implementing the same interface (link 5.7).
- **5.3 `debuggingExecutor.md`** — stepping via DAP with `threadId` and `capTimeout`, `workbench.action.debug.*` only as non-timeout fallback (`:264-336`); readiness = `resolveActiveSession()` + `threads` probe ≤ 3 s + tracker state (`:789`); location from the DAP top frame, never `activeTextEditor`; remove ".NET Debugging"; add the embedded surface (`readMemory` ladder via `gdbMemory.ts`, `readCoreRegisters`, `resetTarget`, `readCycleCounter`, `getThreads`/`getCallStack`) and `HardwareTimeouts`.
- **5.4 `debugState.md`** — drop the five deleted methods and the clone/immutability notes; "Usage Pattern" → snapshot after a stop event.
- **5.5 `agentConfigurationManager.md`** — four bundled skills (`cmsis-debug-live`, `add-board-layer`, `cmsis-pack-docs`, `cmsis-help`); atomic write applies to JSON and TOML via `src/utils/atomicFile.ts` (A9).
- **5.6 `packDocs.md`** — §Tests: `headings.test.ts` after 4.8; §Follow-ups: remove the shipped pdfjs item and the textBudget merge (3.1); §Layout: pdf.js default, pdftotext optional; file table gains `src/core/toolRun.ts`; user-doc id table (B10).
- **5.7 New `docs/architecture/windowRouting.md`** — Purpose (one URL, many windows); Roles (router binds `serverPort`, workers poll every `PROMOTION_POLL_MS` = 10 s); `WorkspaceRegistry` (per-pid JSON, 20 s heartbeat, 60 s staleness, `controlToken`, atomic writes after A7); `ControlServer` (loopback ephemeral port, token-gated, ops from `src/core/opTable.ts`, body caps after A3); `RoutingDebuggingHandler` (five-step resolution ladder at `:51`, `list_debug_windows`/`select_debug_window`, `forwardTimeoutMs`, ten-minute floor for doc ops); "the router routes to itself"; Lifecycle (`start`, `publish`, `dispose` unregisters first, serial teardown after B1); Tests. Add a Key Components row in AGENTS.md.
- **5.8 AGENTS.md** — diagram gains `DebugMCPServer → RoutingDebuggingHandler → ControlServer (owning window) → DebuggingHandler`; conventions per 3.8; commands table adds `build`, `check-types`, `package`, `test:transport`, `test:realboard`, `bench:search`, `eval:scenario`, `lint:md`, `diagram`; configuration table lists all 20 settings from `contributes.configuration` (`timeoutInSeconds 180`, `serverPort 3001`, `installedSkills`, `aiSkills.enabled/promptOnDetect`, `redactSecrets true`, `dapRequestTimeoutMs 10000`, `memoryReadTimeoutMs 30000`, `telemetry.jsonlPath ""`, `serial.enabled true`, `packDocs.enabled false`, `.extractor auto`, `.pdftotextPath`, `.maxPdfMb 150`, `.includeUnlisted true`, `.workspaceDocDirs`, `.userDocsDir`, `buildInfo.enabled false`, `.maxSymbols 20`, `.logGlobs`); fix "needs `pdftotext`"; drop the `troubleshooting/<lang>` resource row.
- **5.9 `docs/DebugMCP-brief-feature-inventory.md`** — 14 inherited, 43 fork-added (57 registered, 45 in a single window); add rows for the 2.3.5–2.3.9 tools.
- **5.10 `docs/improvement-notes.md`** — rows marked "unreleased" → the versions from CHANGELOG (`flash`, `reset`, `read_cycle_counter`, `wait_for_stop`, launch diagnostics); convert "Top remaining" into issues.
- **5.11 Path references** — `test/realboard/README.md:24` → `cd CMSIS-Developer-Assistant`; `CHANGES-VS-UPSTREAM.md:197` prefix "upstream's".
- **5.12 JSDoc** — `SerialHandler` class and ten `handle*` (`src/serialHandler.ts:36-153`); every `IDebuggingHandler` member (`debuggingHandler.ts:80-115`); `getActualPort()` (`debugMCPServer.ts:1390`: differs only when `port` is 0); `parseXml`, `parseSvd`, `buildIndex`, `tokenize`, `parseQuery`, `readElf`, `parseMapFile`, `parseBuildLog`, `computeRegionUsage`, `PackDocsHandler.getStore/getExtractor/dropCaches`. Delete the orphaned doc blocks at `debugMCPServer.ts:302`, `debuggingHandler.ts:592, 954, 1640`.

---

## PR grouping and order

| PR | Contents | Gate |
|---|---|---|
| 1 | Phase 0 (P0.5 hygiene, then P0.2 → P0.3 → P0.1) on this branch | `npm test`; live pack-root check |
| 2 | A7 → A9 → A8 (atomic files, multi-window races) | `npm test` |
| 3 | A4, A5, A6, A2 (independent, one commit each) | `npm test` |
| 4 | A3 + B14 controlServer error handler | `npm test`, `npm run test:transport` |
| 5 | A1 | `npm test`; live FVP check (`continue_execution` without breakpoint → timeout) |
| 6 | B11, B12 (containment) + Phase 2 test additions | `npm test` |
| 7 | B8, B9, B10 (packDocs correctness) | `npm test` |
| 8 | B3, B2, B1, B7, B6, B5, B4, B13, rest of B14 | `npm test`, `test:transport`; real-board smoke |
| 9 | Phase 3 (3.1–3.9) | `npm run lint` with new rules, `npm test`, `test:transport`, real-board or FVP after 3.4 |
| 10 | Phase 4 tests | `npm test` |
| 11 | Phase 5 docs | `npm run lint:md` |

Each PR gets its own CHANGELOG `[Unreleased]` bullets as specified per item. Commits are authored by the user alone (no AI attribution, per the user's global instructions).
