# Second-pass verification — codebase review 2026-09

> **Historical review record.** Findings and line references below describe the September 2026 checkout, not open defects in 2.7.0. Later fixes and the independent rewrite supersede parts of the implementation plan. Preserve the original evidence; review any remaining work through the [2026-10-28 review](reviews/2026-10-28-knowledge-and-docs.md) and current [architecture](architecture/debugMCPServer.md).

Date: 2026-09-07. Branch: `fix/pdfjs-timeout-race` (including the uncommitted pack-root diff).

This is an independent read-only verification of `docs/codebase-review-2026-09.md`
("the review"): every HIGH finding, all fifteen MEDIUM findings, and a sample of
the LOW / clean-up / test / documentation claims were re-checked by hand against
the source. Nothing was changed. Lint and type-check were not re-run (the review
reports them clean); runtime behaviour was reasoned from code, not exercised live.

## Verdict

**The review is accurate.** Of 24 A/B findings, 24 confirmed with file and line.
Of the sampled C/D/E/F claims, all confirmed. The proposed fixes point at the
right root causes. Corrections are limited to one overstated rationale (P0.2)
and a few plan-level adjustments listed at the end.

## A. Bugs — HIGH: 9/9 confirmed

| # | Confirmed | Evidence |
|---|---|---|
| A1 | ✅ | `src/debuggingHandler.ts:1167` subscribes `onDidChangeActiveStackItem` (fires on clear-on-resume); `handleContinue` subscribes only after the DAP continue response (`:425`). `waitForStopEvent` exists at `src/utils/sessionStateTracker.ts:173` and is DAP `stopped` ground truth. The review is also right that `executor.waitForStop` is unsuitable (already-stopped short-circuit). |
| A2 | ✅ | `src/core/flashController.ts:129`: `if (!child.killed)` — `killed` is set when SIGTERM is *sent*; a wedged pyOCD is never SIGKILLed. |
| A3 | ✅ | `body += chunk` on Buffers at `src/controlServer.ts:81` and `src/routingDebuggingHandler.ts:161`; no size cap on either side. |
| A4 | ✅ | `src/core/packDocs/xmlLite.ts:42`: `Number.isFinite(99999999)` passes, `String.fromCodePoint` throws `RangeError` outside the `XmlParseError` contract. |
| A5 | ✅ | `src/core/packDocs/webFetch.ts:227` creates the stream; the only `'error'` listener is attached at `:250`, after the write loop. A mid-loop stream error is an unhandled `'error'`; an error during the `drain` wait (`:247`) hangs the call. |
| A6 | ✅ | `Promise.race([body(...), timeout])` at `src/packDocsHandler.ts:754` and the byte-identical fence at `src/buildInfoHandler.ts:305-328`; a body rejecting after the timer wins is unobserved. |
| A7 | ✅ | Plain `writeFileSync` at `src/utils/workspaceRegistry.ts:103`; `list()` unlinks any file that fails to parse (`:147-149`); same RMW in `heartbeat()` (`:112-114`). |
| A8 | ✅ | `src/utils/skillInstaller.ts:313-318` removes every `.${name}.tmp-*` with no pid liveness check. |
| A9 | ✅ | Fixed temp name `${filePath}.cmsis-developer-assistant.tmp` at `src/utils/agentConfigurationManager.ts:424`; Codex TOML written with plain `fs.promises.writeFile` at `:494` and `:641`. |

## B. Bugs — MEDIUM: 15/15 confirmed

| # | Confirmed | Evidence |
|---|---|---|
| B1 | ✅ | Serial teardown lives in `DebugMCPServer.stop()` (`src/debugMCPServer.ts:~1364-1372`), which exists only in the router window; serial ops run in the forwarded-to window. |
| B2 | ✅ | `server.close()` without `closeAllConnections()`/`closeIdleConnections()` at `src/controlServer.ts:66` and `src/debugMCPServer.ts:1380`. |
| B3 | ✅ | `src/core/serialController.ts:126-135`: state is cleared only after the awaited close; a rejecting close (unplugged USB) leaves `this.port` set and `open()` refuses forever. |
| B4 | ✅ | `src/debuggingExecutor.ts:1198-1200` prints "trying the next method" unconditionally (also on the last method); `:1224-1226` resumes only when verified, silently ignoring `halt:false` otherwise. |
| B5 | ✅ | `src/debuggingExecutor.ts:174-179` `coreclr` branch fires `testing.debugCurrentFile` unawaited and returns `true`. |
| B6 | ✅ | `src/core/peripheralReader.ts:30` `PERIPHERAL_DAP_TIMEOUT_MS = 10000` hard-coded; the configured `dapRequestTimeoutMs` never reaches `readWord`. |
| B7 | ✅ | `src/debugMCPServer.ts:1213-1238`: a fresh transport/`McpServer` pair that throws before `onsessioninitialized` is neither registered nor closed; the catch only answers 500. |
| B8 | ✅ | `handleReadDocPages` (`src/packDocsHandler.ts:255-260`) and `indexDocument` (`:587-588`) call `store.ensure` with no `maxPdfMb` check. |
| B9 | ✅ | `findKnown` (`src/packDocsHandler.ts:717-719`) returns the first `endsWith`/`includes` match in Map order, silently. |
| B10 | ✅ | `src/core/packDocs/userDocs.ts:157`: `id: user/${fileSlug(e.name)}` ignores the scope folder. |
| B11 | ✅ | `directPdfResolver.matches` (`src/core/packDocs/webFetch.ts:180`) accepts any `https?://` URL; all four network calls use `redirect: 'follow'`; no host validation anywhere on the path. |
| B12 | ✅ | `src/buildInfoHandler.ts:195`: absolute `args.file` used as-is; no workspace containment, no `looksLikeBuildLog` sniff. Arbitrary-file-read primitive via MCP. |
| B13 | ✅ | `src/utils/agentConfigurationManager.ts:664-684`: read → mutate → `writeFileAtomic` whole-file RMW of `~/.claude.json` with no re-read or lock. |
| B14 | ✅ | All four sub-items: fixed 3 s+3 s sleeps in `confirmSessionSurvives` (`src/debuggingHandler.ts:1904-1910`); uncapped per-thread `stackTrace` fan-out (`src/debuggingExecutor.ts:1433`); partially started server rethrown without `stop()` on non-`PortInUseError` (`src/windowCoordinator.ts:141-146`); no `req.on('error')` at `src/controlServer.ts:80`. |
| B15 | ✅ | The uncommitted diff does exactly what the review describes: `resolveTarget` builds a local host copy that never leaves the function (`targetDocs.ts:66-71`); production works only via the getter-over-closure in `src/packDocsHost.ts`, and spread copies snapshot it; `src/core/svdParser.ts:227-229` got the Windows default via `defaultPackRoot()` but not the toolchain hook. |

## C/D/E/F — sampled claims, all confirmed

- **C (LOW):** `elf.ts:263,292` unbounded `entSize × shnum/phnum` `readAt`; `buildLog.ts:196-200` tail read ignores the `fs.readSync` byte count; `mapFile.ts:154` `parseHex` wraps ≥ 2³² via `>>> 0`; `pdscBooks.ts:326` `path.resolve(packDir, name)` with no containment (`<book name="../..">` escapes); `skillInstaller.ts:257-259` `entry.name` joined into destination/staging paths unvalidated (bundled catalog, so LOW is fair); `extension.ts:41` defaults `timeoutInSeconds` to 60.
- **D (clean-up):** `src/core/textBudget.ts` vs `src/core/packDocs/textBudget.ts` duplication confirmed (packDocs copy adds `formatBytes`); dead code confirmed — `DebugState.reset/clone/hasValidContext/hasLocationInfo/hasFrameName` (`debugState.ts:76-168`), `DebuggingHandler.getCurrentDebugState/isDebuggingActive` (`debuggingHandler.ts:1082,1089`), `DebugMCPServer.getDebuggingHandler/isInitialized` (`debugMCPServer.ts:1404,1411`); 12 `console.*` sites in `agentConfigurationManager.ts`; `dist/extension.js.map` tracked and stale (Aug 20 vs Sep 3 bundle).
- **E (missing tests):** no `timeout`, `headings`, `peripheralReader`, `windowCoordinator`, `serialController`, `agentConfigurationManager`, or `debugMCPServer` test files exist.
- **F (docs):** AGENTS.md:73 says "tabs for indentation" while the tree uses 4 spaces; `docs/architecture/packDocs.md:42` lists a `headings` test file that does not exist; tool count is 57 registered (47 + 5 + 5 across `debugMCPServer.ts`, `packDocsTools.ts`, `buildInfoTools.ts`), matching the review.

Not verified line-by-line: the remaining C-list items, the per-row F doc-drift
items beyond the sample above, and any live runtime behaviour. The confirmed
sample is broad and uniformly accurate, so confidence in the unverified
remainder is high.

## Corrections and clarifications to the review

1. **P0.2 rationale is overstated.** "A 3 s `withTimeout` wait per call when the
   extension is absent" is not what happens: `executeCommand` on an unregistered
   command rejects immediately, so the absent-extension cost is a fast failure,
   not a 3 s stall. The 3 s timeout only bites when the command is registered
   but never settles (extension activating or wedged). The caching fix is still
   right — the real cost is one `executeCommand` round trip per `resolveTarget`
   and the misleading log line — but the motivation should be restated.
2. **`express.json()` — not an inconsistency.** A3 says MCP requests are "capped
   at 100 kB" while C says "no `limit`". Both are true: `app.use(express.json())`
   (`debugMCPServer.ts:1190`) inherits body-parser's 100 kB default; no explicit
   limit is configured. When A3 lands, set the limit explicitly and add a
   transport-level test pinning the 413 (see R6 below).

## Assessment of the fix plan

The phasing is sound: Phase 0 finishes the in-flight diff on this branch in the
correct dependency order (hygiene → cache → svdParser hook → consumer
threading); the atomic-file cluster (A7 → A9 → A8) correctly lands the shared
helper first; A1 is rightly last among the HIGH bugs with its own PR and a live
FVP gate, since it is the largest behaviour change. Recommended adjustments:

- **R1 — pull B12 forward.** It is the highest-impact security item (arbitrary
  file read through an MCP tool), small and self-contained, and independent of
  the rest of Phase 2. Move it from PR 6 into PR 3 with the other independent
  bugs. B11 (SSRF) is a larger change and can stay in PR 6.
- **R2 — restate the P0.2 motivation** per correction 1 before implementing.
- **R3 — two additions to A1.** (a) The recovery-path test should also assert
  `arm` precedes `pause` in the recorded calls (the plan asserts the sequence
  `['arm','continue','arm','pause']`; make the ordering claim explicit).
  (b) Before merging, grep the transport tests for assertions on
  continue/step *output* wording — `formatAfterExecution` gains a "Target
  stopped (reason: …)" header, and the review only checks the tool-description
  byte budget.
- **R4 — confirm the issue target before P0.5's `gh issue create`.** Five
  issues are created from `notes.md`; decide first whether they belong on the
  fork or upstream, and finalise wording. Do not run this step unattended.
- **R5 — isolate the `testName` schema removal.** Phase 3 removes `testName`
  from `start_debugging` — a public tool-surface change. Land it as its own
  commit marked "potentially breaking" in the CHANGELOG, separate from the
  dead-code sweep it currently rides with.
- **R6 — pin the MCP-side body cap.** A3 caps the control channel and makes
  the express limit explicit; add one cheap 413 assertion to
  `test/transport/session-lifecycle.js` so the MCP side is covered too.
- **R7 — no change needed, noted for the implementer:** B2 and B14c both touch
  server teardown (`ControlServer.stop`, `windowCoordinator` catch). The plan
  sequences B14c after A3 and B2 before B1; keep that order to avoid rebase
  churn in the same lines.

## Risk notes for implementation

- **A1** changes user-visible output for every motion tool; the live gate
  (`continue_execution` without a breakpoint must report timeout, not stop) is
  the right acceptance test — keep it blocking for PR 5.
- **A7** must not change the on-disk registry format (peer windows on older
  builds read the same directory); the planned change preserves it.
- **B11** will cut off intranet PDF hosts (10.x etc.); the error message naming
  the workspace docs folder is the right mitigation — keep that wording.
- **Phase 3.4** (GDB read-ladder dedupe) touches every hardware read path; the
  planned real-board/FVP gate is mandatory, not optional.

## Bottom line

Approve the review's recommended scope (Phases 0–2) with adjustments R1–R6.
The findings are verified, the root causes are correctly identified, and the
fix sequence is implementable as written. Phase 3–5 can proceed as follow-up
PRs once Phase 0–2 land.
