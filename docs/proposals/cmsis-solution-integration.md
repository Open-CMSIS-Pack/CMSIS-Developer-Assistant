# Use more of the CMSIS Solution extension: its API v2 and four of its commands

> **Completed design record (2.7.0).** The five phases shipped as the implementation notes below describe. The original release plan and Current state section are retained for context; [cross-extension calls](extension-calls.md) is the current inventory. Remaining documentation and knowledge follow-ups belong in the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md).

| | |
|---|---|
| Issue | none yet |
| Area · priority · source | Integration with CMSIS Solution · Medium · review of CMSIS Solution 1.72.0 against this extension, 2026-10-18 |
| Original release plan | phase 0 in the next release (done on `fix/cmsis-solution-commands`); phases 1–2 in the release after; phase 3 with #41; phase 4 when convenient |
| Size | phase 0 XS (done), phase 1 S, phase 2 M, phase 3 M, phase 4 S |
| Depends on | nothing for phases 0–2; #41 for the tool shape of phase 3 (Decision 2) |
| Related | #41 (cross-extension commands as `cmsis_query`), [bootstrap-empty-vscode.md](bootstrap-empty-vscode.md) phase 2 (`create_solution`), [knowledge-base.md](knowledge-base.md) (pack knowledge), #21 (requests to the CMSIS Solution team) |
| Status | Phases 0–4 in 2.7.0 (pre-release, 2026-10-18) with the recommended option of every decision; checked live once on the micro:bit V2 simulator, see below |

## What the implementation did (2026-10-18)

All five phases are in 2.7.0, each decision as recommended. `npm test`, `test:transport`, `test:surface` and the three behaviour oracles pass on the merged branch. Nothing ran against CMSIS Solution itself: its behaviour is read from the 1.72.0 bundle, and the test VS Code has stubs in its place.

- **Phase 1:** `src/core/solutionAnswers.ts` interprets the getters, `src/utils/solutionQueries.ts` asks them (feature-detected, only while the extension is active, 3 s each). `resolveTarget` and `flash` take `getCbuildRunFile` first; a pack folder from `getDfpPath`/`getBspPath` counts when its PDSC matches the pack, inside or outside the pack root, and its `.knowledge/` is read.
- **Phase 2:** `cmsis_action install_pack` (`src/handler/installPack.ts`, `src/core/packInstall.ts`). It activates the extension before the command check, since a window without a csolution has not. A pack already in place is reported without installing. 388 of the 456 PDSCs in the `.Web/` cache of this machine declare a `<license>`, so most packs ask.
- **Phase 3:** `cmsis_query {what: 'boards' | 'devices' | 'examples'}` and `cmsis_action create_solution` (`src/core/solutionApi.ts`, `src/core/catalogQuery.ts`, `src/handler/createSolution.ts`). `create_solution` takes its folder from `path`. CMSIS Solution opens the created folder in the same window without asking, so the call is refused in a window with another folder open, and in an empty window for a chat inside VS Code. Filters are applied on our side (the API's are case-sensitive). Whether the web catalog was unreachable is read from `dataManager.errors`, outside the published API.
- **Phase 4:** `rebuild`, `clean` and `stop_build`. A build stopped from the panel (exit 130) counts as stopped, not failed, and no longer starts the diagnostic re-run. With no CMSIS task in `tasks.json`, `updateDebugTasks` runs once when the target's `cbuild-run.yml` names a debugger and `autoDebugLaunch` is on.
- **Budgets raised** by phase 3, measured on the merged branch: `tools/list` 32 891 of 33 000 B (was 32 000), every group on 46 482 of 47 000 B (was 46 000), routed 36 540 of 37 000 B (was 36 000). The `cmsis_action` description stays under its 700-character cap; it does not name the new actions, the enum does.
- **Checked live (2026-10-18)** in an isolated VS Code with CMSIS Solution 1.72.0, on a new project for the micro:bit V2 and its simulator (`mbsim` as the Arm-FVP model): `cmsis_query` boards and examples, `install_pack` for packs already installed (with the knowledge line), `knowledge_expand` listing the BSP's units before the project existed, `create_solution` from the BSP's Blinky, `build`, `cmsis=` in `list_debug_windows`, `load_and_debug` with breakpoints, `rebuild` and `stop_build`. Found: the first `cmsis_query` times out while CMSIS Solution loads the web catalog (a retry works); after `create_solution` the solution is not active until `open_solution`; an example that lists `select-compiler` without `compiler:` fails its first build; and the known-message line of that failed first build cannot name the pack's unit, since no `cbuild-run.yml` exists yet.
- **Still to check live:** `getCommands(true)` listing the hidden getters; the format of `getDfpPath`/`getBspPath` for a `path:` pack; `installPack` and `cmsis_query` in a window without a csolution (activating CMSIS Solution also starts the Environment Manager's default toolset); `cpackget` on the PATH there; the licence dialog; exit 130 for a stopped build; `updateDebugTasks` writing the tasks within 5 s; `createNewSolution` opening the folder, and the reply reaching the client before the reload.
- **Not done:** the knowledge-base side (a shared procedure "install the verified packs and read their knowledge", `proc-identify-cmsis-board-support` and `proc-start-cmsis-project` using `cmsis_query` and `create_solution`), and `rebuild`/`clean` in the tool contract's shell table.

## Problem

This extension works out by itself what the CMSIS Solution extension already knows, and it leaves out a public API that the other extension publishes for exactly this use. Four cases show what that costs:

- **Pack knowledge comes too late.** A pack's knowledge units (`.knowledge/`) are needed before the project is set up: bring-up, first-build errors, how to use the board's examples. The packs are installed only by the first build, after the procedure has chosen the starting point and written the files. No tool installs a verified pack earlier. A shell `cpackget add` is against the tool rules and against `proc-start-cmsis-project`, which says "Never `cpackget add`".
- **Board identification scrapes web pages.** `proc-identify-cmsis-board-support` reads the Keil Boards and Devices catalog pages and runs `csolution list boards` and `list devices`. CMSIS Solution's API returns the same catalog as data: each board with its mounted devices and its pack.
- **Examples are offered only from installed packs.** Step 3 of `proc-start-cmsis-project` runs `csolution list examples`, which sees installed packs only. The API returns the examples the Create Solution wizard shows, from the web catalog as well.
- **The active target is guessed.** The documentation, knowledge and flash tools look for `*.cbuild-run.yml` files and choose among them by heuristics. They find a pack only under the pack root, so a pack that a csolution names with `path:` (for example a BSP under development) is never found.

## Current state

### What this extension calls today

`build` and the load, erase, run, debug, attach, detach and stop commands behind `cmsis_action` ([cmsisAction.ts:102-112](../../src/handler/cmsisAction.ts#L102-L112)), `getSolutionFile`, `getActiveTargetSet`, `getPackRootPath`, `activateSolution` and `deactivateSolution`. It does not call the API.

### What CMSIS Solution 1.72.0 offers

Read from its bundle (`dist/extension.js`); nothing of it was run.

- **A public API, version 2.** `vscode.extensions.getExtension('Arm.cmsis-csolution').exports.getApi(2)`. The extension's CHANGELOG says it is "available on npm" as `@arm-software/vscode-cmsis-csolution` and "gives access to all available boards and devices, their associated examples, and the ability to copy and build a selected example for use by other Visual Studio Code extensions". `getApi` throws for an unknown version. Methods:
  - `getBoards(filter?)`: filter by `vendor`, `name` and `revision` (both regular expressions) and `mountedDevice`;
  - `getDevices(filter?)`;
  - `getDraftProjects(boardId, deviceId)`: the examples and templates of a board or device;
  - `createNewSolution({board, device, draft, folder, git})`: the wizard's creation, packs included. It needs a draft project; without one it throws `Draft project not found`;
  - `build({clean, rebuild, packs, updateRte})`.

  The data comes from two sources merged into one list: Arm's web catalog (`https://solar-search.api.keil.arm.com/`, GraphQL) and the installed packs (through `csolution rpc`). Offline, the web source fails with "Web service could not be reached".
- **`installPack(vendor, name, version?)`**, a command hidden from the palette. It runs `cpackget add -a Vendor::Name@<version or latest>` in the extension's tool queue, writes the output to the CMSIS Solution channel, and returns the pack's folder, or `undefined` on failure or bad input, with no reason. It looks up `cpackget` on the PATH. The build's own download of missing packs uses the toolbox bundled in the extension instead.
- **Today's build already accepts pack licences silently.** On convert, missing packs are downloaded with `cpackget add <pack> --force-reinstall --agree-embedded-license --no-dependencies`. `installPack`'s `-a` does the same.
- **Getters**, all string resolvers for `${command:…}` (#41 lists their quirks):
  - `getCbuildRunFile`: the `cbuild-run.yml` of the loaded solution's active target;
  - `getDfpPath`, `getBspPath`: the folder of the active target's DFP and BSP from the solution's pack list, `path:` packs included; `"<not found>"` otherwise;
  - `getDeviceName`, `getBoardName`, `getProcessorName`, `getDfpName`, `getBspName`. Some titles say "as specified in csolution.yml", but the code reads the same cbuild files this extension parses. They do not help before the first successful convert.
- **Hand-offs to the user:** `manageSolution` (Manage Solution Settings, where the debugger is chosen), `manageComponentsPacks`, `createSolution` (the wizard), `openArmExamples`, `updateDebugTasks` (Update Debug Tasks and Launch Configurations), `runGenerator`.
- **Activation:** the extension activates on `workspaceContains:**/*.csolution.yml` (and `.uvprojx`). Calling one of its commands, or `extension.activate()`, should activate it in a folder without one. Not checked.

### Where this extension guesses

- **The active target:** `resolveTarget` searches up to 50 `*.cbuild-run.yml` files and matches them against `getSolutionFile` and `getActiveTargetSet` ([targetDocs.ts:99-160](../../src/core/packDocs/targetDocs.ts#L99-L160)). `flash` resolves its file from `launch.json` or the only `out/**` match ([flashTool.ts:85-90](../../src/handler/flashTool.ts#L85-L90)).
- **The pack folder:** `locatePack` looks under the pack root only, and quietly takes another installed version when the exact one is missing ([targetDocs.ts:204-215](../../src/core/packDocs/targetDocs.ts#L204-L215)).
- **Pack knowledge:** `discoverIndexes` reads the pack root, `.Local/local_repository.pidx` and the workspace's `.cmsis/` ([packIndexes.ts:132](../../src/core/knowledge/packIndexes.ts#L132)). A `path:` pack that is not registered locally is missed.
- **Four interpretations of `getSolutionFile`:** [cmsisAction.ts:200](../../src/handler/cmsisAction.ts#L200), [cmsisBuildDiagnosis.ts:671](../../src/cmsisBuildDiagnosis.ts#L671), [packDocsHost.ts:123](../../src/packDocsHost.ts#L123), and `solutionFileOf` in [bootstrapState.ts](../../src/core/bootstrapState.ts) (phase 0).

## Proposed fix

### Phase 0: the window listing names the solution (XS, done)

`WindowCoordinator` read `exports.activeSolution` of the CMSIS Solution extension, a field that does not exist (the export is the object with `getApi`), so `cmsis=` never appeared in `list_debug_windows`, `select_debug_window`, the routing errors or the window picker. It now asks `getSolutionFile`, only while that extension is active (asking would activate it in every window), at each publish and heartbeat, and publishes a changed answer at once. `solutionFileOf` in `bootstrapState.ts` interprets the answer. Unit tests: `src/test/bootstrapState.test.ts`, `src/test/windowCoordinator.test.ts`. `npm test`, `test:transport` and `test:surface` pass; the surface is unchanged.

### Phase 1: ask instead of guessing (S)

1. **`getCbuildRunFile` first** in `resolveTarget` and in `flash`'s `chooseCbuildRun`. The scan and the `launch.json` lookup stay as the fallback when the extension is not active or answers `""`.
2. **`getDfpPath` and `getBspPath` first** where the pack of the active target is located (`locatePack`'s callers, `projectFacts`). The folder they name counts even when it lies outside the pack root. The fallback is today's lookup, and its note says when it took another version.
3. **`discoverIndexes` also reads `.knowledge/knowledge.db` in those two folders**, so a `path:` pack's knowledge is offered like an installed pack's.
4. **One pure module for the answers** (Decision 5): `getSolutionFile`, `getActiveTargetSet`, `getCbuildRunFile`, `getDfpPath`/`getBspPath` with `"<not found>"`, each with a 3 s fence. The four call sites above move to it, and #41 builds on it.

### Phase 2: `cmsis_action install_pack` (M)

1. **`cmsis_action {action: 'install_pack', pack: 'Vendor::Name@version'}`** calls `installPack`. Like `open_solution`, it needs no active solution. The version is required: the agent installs what identification verified, never `latest`.
2. **The result names the pack's knowledge** when the pack ships it, the way a failed build names the unit of a known message:

   ```text
   MicroBit::MicroBit_V2_BSP@0.1.0 installed in /…/packs/MicroBit/MicroBit_V2_BSP/0.1.0.
   It ships 12 knowledge units: knowledge_expand {id: "pack:MicroBit::MicroBit_V2_BSP", relation: "scoped_to"}
   ```

   `knowledge_expand` lists the pack's units today, although `knowledge_search` hides them until the project uses the pack: it follows `scoped_to` edges in both directions and does not apply the scope.
3. **A failure** (`undefined`) is reported with the pack id and a pointer to the CMSIS Solution output channel, and journaled. The folder is checked afterwards in either case.
4. **Licence:** see Decision 1.
5. **On the knowledge-base side** (not this repository): a shared procedure "install the verified packs and read their knowledge", required by `proc-start-cmsis-project`, `proc-add-cmsis-target` and `proc-add-board-layer` right after identification. It uses `install_pack`, so their rule "Never `cpackget add`" stays true.

### Phase 3: the catalog and the examples through API v2 (M, with #41)

1. **Catalog lookup**: boards, devices and the examples of a board or device, as data, from `getBoards`, `getDevices` and `getDraftProjects`. Each answer names its source (web or installed) and says so when the web was unreachable. Tool shape: Decision 2.
2. **`proc-identify-cmsis-board-support`** uses the lookup before the catalog pages; **`proc-start-cmsis-project` step 3** offers examples from the lookup before any pack is installed.
3. **`createNewSolution`** for the example and template path of `proc-start-cmsis-project` (step 5), as `cmsis_action create_solution` from [bootstrap-empty-vscode.md](bootstrap-empty-vscode.md) phase 2. That phase waited for a published contract; API v2 is one. The minimal project stays the procedure's own files, since the API creates only from a draft project (Decision 3).

### Phase 4: hand-offs (S)

1. **A `tasks.json` without CMSIS tasks** ([jobText.ts:193-204](../../src/handler/jobText.ts#L193-L204)): when the csolution already names a debugger, run `updateDebugTasks` and retry once; otherwise the refusal says to open **Manage Solution Settings** (`cmsis-csolution.manageSolution`) by name. What `updateDebugTasks` does without a debugger is to be checked first.
2. **`rebuild`, `clean` and `stop_build`** as `cmsis_action` actions, over the commands of the same names. Today the agent cannot stop a build that hangs.

## What changes for the agent and the user

```text
Identification done: MicroBit::MicroBit_V2_BSP@0.1.0 and NordicSemiconductor::nRF_DeviceFamilyPack@8.44.1

today    the agent writes the project, the first build installs the packs, and the
         pack's bring-up procedure and first-build fixes are hidden until then

new      cmsis_action {action: 'install_pack', pack: 'MicroBit::MicroBit_V2_BSP@0.1.0'}
         → installed; "It ships 12 knowledge units: knowledge_expand {…}"
         knowledge_get proc-microbit-v2-bring-up, ts-csolution-local-pack-path-schema, …
         → the project is written with the pack's rules already read

"Which examples does the board have?"

today    csolution list examples: none, the BSP is not installed yet
new      the catalog lookup lists the board's examples from the web catalog
```

The user sees no new prompt unless Decision 1 adds one for packs with a licence.

## Decisions for you

- [ ] **1. Licence on `install_pack`.** **Recommended:** ask the user (modal) when the pack's PDSC, in `.Web/` of the pack root, declares a `<license>`; install without asking otherwise. The agent starts the install, so the consent has to come from the user.
  - Alternative a: never ask. Today's `cmsis_action build` already accepts embedded licences silently through the CMSIS Solution extension, so this would add nothing new.
  - Alternative b: always ask. Safe, but one prompt per pack, also for packs without a licence.
- [ ] **2. Tool shape of the catalog lookup.** **Recommended:** the first slice of #41's `cmsis_query`, as `what: 'boards' | 'devices' | 'examples'` with filter arguments. One tool for everything the CMSIS Solution extension answers, and one entry in the tool-list budget.
  - Alternative a: a tool of its own (`cmsis_catalog`). It can ship before #41, but it costs a second tool description.
  - Alternative b: no tool; the procedures keep the catalog pages and `csolution list`.
- [ ] **3. `createNewSolution`.** **Recommended:** for the example and template path only; the minimal project stays the procedure's files.
  - Alternative: wait until the CMSIS Solution team adds a minimal project to the API (an ask for #21).
- [ ] **4. Hidden commands.** **Recommended:** use `installPack`, `getCbuildRunFile`, `getDfpPath` and `getBspPath`, each feature-detected (`vscode.commands.getCommands(true)`) with today's code as the fallback, and ask the CMSIS Solution team (#21) to make them part of a later API version.
  - Alternative: use API v2 only and wait for the rest.
- [ ] **5. One module for the CMSIS Solution answers.** **Recommended:** a pure `src/core/solutionAnswers.ts` now (phase 1); the four `getSolutionFile` interpretations move to it, and #41's allowlist builds on it.
  - Alternative: leave each call site as it is until #41.

## Tests and acceptance

- **Phase 0 (done):** `solutionFileOf` for a path, an object answer, `""`, `{}`, `null` and `undefined`; the coordinator publishes the named csolution and drops it when the answer becomes `""`.
- **Phase 1, unit:** with stub commands, `getCbuildRunFile` wins over the scan, and `""`, a timeout and an inactive extension each fall back to it; `getDfpPath` with `"<not found>"` falls back; a `path:` pack fixture outside the pack root yields its PDSC, its cores and its `.knowledge/` index.
- **Phase 2, unit:** `install_pack` refuses a pack id without a version; `undefined` from the command gives the failure text; the licence gate per Decision 1; the knowledge line for a pack fixture with `.knowledge/`. **Routing:** the action is forwarded like `open_solution`. **Surface:** the `cmsis_action` enum and description change; snapshot updated in the same commit.
- **Phase 2, live:** a folder with `vcpkg-configuration.json`; an empty folder (does the command activate the extension; is `cpackget` on the PATH there?); a pack with an embedded licence.
- **Phase 3:** a stub API for the unit tests; live online and with the network off (the installed source must still answer).
- **Phase 4:** the refusal text, and `updateDebugTasks` on a csolution with a debugger and no `tasks.json`.

## Found while checking

| Finding | Where | Covered by |
|---|---|---|
| The window listing read `exports.activeSolution`, which the CMSIS Solution extension does not export, so `cmsis=` never showed | `windowCoordinator.ts` | phase 0, fixed |
| `locatePack` ignores `path:` packs and takes another installed version without saying so in the result | [targetDocs.ts:204-215](../../src/core/packDocs/targetDocs.ts#L204-L215) | phase 1 |
| The `.knowledge/` of a `path:` pack that is not registered locally is never read | [packIndexes.ts:132](../../src/core/knowledge/packIndexes.ts#L132) | phase 1 |
| [bootstrap-empty-vscode.md](bootstrap-empty-vscode.md) says the programmatic `createSolution` is internal; API v2's `createNewSolution` is public | bootstrap-empty-vscode.md, current state and phase 2 | phase 3 |
| `installPack` takes `cpackget` from the PATH, while the build uses the toolbox bundled in the extension; in a folder without an environment it may fail where a build would work | CMSIS Solution 1.72.0 | phase 2 live check; an ask for #21 |
| `getDeviceName` and `getBoardName` say "as specified in csolution.yml" but read the cbuild files | CMSIS Solution 1.72.0 | none; a note for #21 |

## Out of scope and follow-ups

- Exposing the getters to agents: that is #41.
- The CMSIS Solution URI handler (`vscode://arm.cmsis-csolution/installpack?pack=…`): `installPack` does the same without leaving the window.
- `runGenerator`, `getInfoPath` (the clangd compile database) and `getBinaryFiles`: no caller needs them yet.
- `reloadPacks`: the extension watches the pack index files and reloads by itself; add it only if `install_pack` leaves stale state.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
