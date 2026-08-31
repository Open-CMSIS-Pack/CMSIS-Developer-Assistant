# Changelog

All notable changes to CMSIS Developer Assistant will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Skills can be installed into the workspace instead of the user profile.** *Select Agent Skills* (and step 2 of the setup) first asks where the AI Skills Pack goes: *This workspace only* (the default — a personal skill is offered to the agent in every project and its description costs context there whether the project is CMSIS or not; a project skill is loaded only where it applies) — the project's `.agents/skills` (and `.claude/skills` when Claude Code is installed or the project already has a `.claude` directory), next to the sources, to commit with the project or ignore; *This user* — the personal skills directories as before, for every workspace. The choice is the target of the `installedSkills` setting, whose scope changes from `application` to `resource`: the User value drives the personal directories, a Workspace or Folder value the project's — each folder of a multi-root workspace from its own — so a selection that arrives in a checked-out `.vscode/settings.json` is applied on activation like one from Settings Sync, and removing it sweeps the project copies (marker-guarded, as everywhere). A project selection installs the selected pack skills and their hidden dependencies only; the extension's own skills stay personal, where every agent already finds them, and a project without a selection never gains an empty `.agents/skills`. Adding a folder to the workspace syncs it, the picker shows what each scope currently selects, and the install prompt counts a pack skill picked in either.
- **Documentation and build-artefact tools, built in** — the experimental CMSIS Pack Docs extension moved into the Assistant as-is: `src/core/packDocs` (target resolution from `*.cbuild-run.yml`, pdsc `<book>` walking, Arm document catalogue and download, user and workspace document folders, `pdftotext` extraction, the page store and BM25 index, peripheral dossiers over the SVD plus 16 shipped Cortex-M core-peripheral SVDs) and `src/core/buildInfo` (a positioned ELF32 reader, GNU ld / armlink map parser, build-log diagnostics). Ten tools: `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs` and `list_build_artifacts`, `get_memory_usage`, `lookup_symbol`, `get_section_layout`, `get_build_diagnostics` — **off by default** behind `cmsis-developer-assistant.packDocs.enabled` and `buildInfo.enabled` (fixed per window like `serial.enabled`; the enabled list is 55 tools / ~41 kB against its own 42 000-byte budget, the default list is unchanged). They route like every other op: each window builds the handler pair, the control server dispatches by op name, the router forwards, and the five documentation ops carry the ten-minute forward floor because indexing a manual takes minutes. Commands **List / Index Target Documentation**, **Import Document for Current Target** (attribute a PDF to a pack, device family, board or core, with title, category and edition, indexed at once), **Open User Documents Folder** and **Open Pack Docs Panel** (target, documents and index state, SVD peripherals, page store, in-place tool runner). Settings `packDocs.extractor` / `pdftotextPath` / `maxPdfMb` / `includeUnlisted` / `workspaceDocDirs` / `userDocsDir` (default `~/.cmsis-pack-docs/user`, kept so imported documents stay attributed) and `buildInfo.maxSymbols` / `logGlobs` apply live. The `cmsis-pack-docs` skill ships as a fourth bundled skill; `cmsis-debug-live` and `add-board-layer` point at the tools instead of an external MCP; `cmsis-help` lists them. Extracted text now lives under this extension's global storage, so pages are re-extracted once. The 22 test suites and fixtures came along; the routing test covers the dispatch, the transport test measures the all-on list and the no-build answers, and the packaged-VSIX check verifies the SVDs and the skill ship. If the standalone extension is still installed, activation warns that agents would see the tool names twice.

### Changed
- **`search_target_docs` indexes the page heading as a weighted field** (#29). A register page's body speaks of bits; only its heading names the register and says what it is, so BM25 over the body alone missed it unless the query happened to use the body's words. The heading is now a second field in the index (version 2; existing indexes are rebuilt from the persisted page text on first use, no re-extraction) scored at weight 5 on top of the body, and the old ×3 post-boost becomes a tie-breaker. Measured with the new opt-in benchmark `npm run bench:search -- --pages <doc.pages.jsonl> --svd <device.svd>` on RM0455 (2 965 pages, 495 register headings) with queries taken from the STM32H7B3 SVD rather than the manual: description-only queries R@1 49.5 % → 64.5 %, R@3 70.9 % → 81.8 %, MRR 0.621 → 0.741; description plus register name R@1 78.1 % → 98.8 %, MRR 0.873 → 0.994. The benchmark reports R@1 / R@3 / MRR per heading weight and post-boost so future ranking changes are measured, not argued.
- **The architecture diagram shows the documentation path and renders on dark themes.** The "How It Works" picture gains the documentation retrieval box (pack PDFs, user and workspace documents, `fetch_doc` downloads → pdf.js → page store → the search tools, with the SVD joined in), is rendered on an opaque background — the previous transparent PNG had black labels, invisible on the dark extension page — and `npm run diagram` regenerates it from the Mermaid source with a local Chrome. The README explains the window routing and the documentation path in two paragraphs.
- **The extension icon is the Arm logo** the other Arm extensions (CMSIS Solution, CMSIS Debugger, Keil Studio Pack, Device Manager, …) carry — the same `arm.png` — instead of the icon inherited from DebugMCP.
- **The documentation system is marked experimental.** Every `packDocs.*` and `buildInfo.*` setting carries VS Code's `experimental` tag (the Settings UI shows the badge and the "Experimental" filter finds them), the two `.enabled` descriptions say so up front, and the README and `cmsis-help` label the two tool groups the same way — the tools, their arguments and output may change between releases.
- **The VSIX drops 10 MB of unused media.** `assets/DebugMCP.webp` (9.7 MB, referenced by nothing, shipped in every package since the fork) and `assets/DebugMCP.mp4` (15 MB in the repository, never shipped) are removed, `assets/architecture.svg` (an unused rendering of the diagram the README shows as PNG) too; the extension icon is 256 px instead of 1024 (1.4 MB → a few tens of KB); the design notes under `docs/` no longer ship — only `docs/agent-resources`, which the MCP resources read, does.
- **`search_target_docs` expands identifiers from the SVD** (#29 part 2). An identifier-only query — `USART1`, `GPIOAEN` — gains the words of its SVD description at half weight: a peripheral instance brings its type synonyms and description ("universal synchronous asynchronous receiver transmitter"), a bare field name brings the register it lives in (`RCC_AHB1ENR`) and the field's description, so the manual is found even when it never spells the identifier. The result says what was expanded. Prose, quoted phrases and register names are left alone: the benchmark showed expanding register names or the acronyms inside a sentence only dilutes the ranking (−2 points on description queries, −0.3 on bare register names), while the heading field already puts register pages first (R@1 98.2 % for the bare name). With the restriction all three benchmark sets are unchanged; the gain is on the instance and field queries the benchmark cannot score against the manual's headings.
- **PDFs are extracted with a bundled pdf.js; poppler is optional** (#28). `packDocs.extractor` gains `pdfjs` and `auto` now means pdf.js (legacy build, pure JavaScript, +0.8 MB in the bundle, loaded on first use), so a machine without `pdftotext` — most Windows hosts — indexes documents too; `pdftotext` stays selectable, and switching re-extracts a document on its next use rather than mixing text sources. Lines are rebuilt from pdf.js text items by baseline, with wide horizontal gaps kept as double spaces so register-table columns stay separable, and the tokenizer applies NFKC so ligatures and full-width forms from either extractor meet on one term. Gated by the search benchmark on RM0455 with the heading field on: pdf.js R@1 65.0 % / MRR 0.739 (description-only) and 99.1 % / 0.995 (with the register name) against pdftotext's 64.5 % / 0.740 and 98.8 % / 0.994 — within noise; 2 965 pages in 3.9 s. `npm run bench:search -- --pdf <file> --extractor pdfjs|pdftotext` runs the comparison.
- **Agents are told to search the documentation, not to ask for it.** The MCP instructions now say, with the documentation tools on, to use them before asking the user for a datasheet or manual and instead of reading a PDF into context — a document the user provides goes into the workspace `docs/` folder or through *Import Document for Current Target* and is searched; with the tools off (the default) they name the `packDocs.enabled` setting so an agent suggests it rather than asking for documents. The same rule is in the `cmsis-pack-docs`, `cmsis-debug-live` and `add-board-layer` skills, and the `build` topic of `get_debug_instructions` replaces its "check the documentation in the CMSIS Solution UI" advice with the tools. The transport test asserts the default instructions carry the pointer. Prompted by a session in which an agent went to the web for an ADC datasheet that was already indexed as a user document: the instructions, the tool descriptions and the skills now say that third-party parts on the board (sensors, ADCs, codecs) are documented the same way — any part-number lookup starts at `list_target_docs`, a datasheet that is not listed is fetched by URL with `fetch_doc` (the web finds the URL, the tools read the document), and the user's `docs/` folder and the import command are where such documents belong. The same session first hit a `Blinky+MPS3` fixture in the workspace: `list_target_docs` and the build-artefact tools now ask the CMSIS Solution extension which csolution and target-type are active and pick that context when a workspace holds several solutions, noting the choice; the ambiguity error remains when nothing matches, and `target` still wins (`docs/improvement-notes.md` §10).

## [2.3.8] - 2026-08-28

### Added
- **`add-board-layer` skill** — a third extension-authored skill, always installed like `cmsis-debug-live` and `cmsis-help`: add a board layer to an existing csolution by interview. It reads the csolution, the DFP/BSP pdsc and an existing layer first and asks only the decisions they cannot settle (scope, layer strategy, probe, STDIO transport, memory), then reuses the BSP layer, integrates the DFP's configuration generator when the pack ships no `Device:Startup` and startup exists only as generator output (STM32CubeMX, MCUXpresso Config Tools, Infineon Device Configurator, Microchip MCC — the agent selects the generator components, runs the first cbuild pass and tells the user to run the generator, which it cannot do for them), or writes a minimal bare-metal layer (CMSIS C startup, `retarget_stdio.c` on the reset clock, `regions_<board>.h`, minimal device header), wires the target-type into the csolution and builds to green, then hands over to `csolution-retarget` for the hardware bring-up. Hardware facts — register offsets and bit meanings, the reset clock tree, VCP instance and pins, errata — come from the pack documentation through the CMSIS Pack Docs MCP (`list_target_docs`, `search_target_docs`, `read_doc_pages`) when it is installed, cited by document and page and cross-checked against the SVD; without it the skill says what is unverified. The `cmsis-project` router's workflow points at it and `cmsis-help` lists it.

## [2.3.7] - 2026-08-25

### AI Efficiency Optimizations

1. **Tool list −20 %** — the `tools/list` every turn carries shrank from 33.2 to 26.7 kB (single-window surface); per-call `timeoutMs` notes collapsed to one line, rationale moved to the skill; a 30 kB budget and 700-char/description cap are asserted in the transport test.
2. **`serial.enabled` setting** — off drops the ten `serial_*` tools from the list entirely.
3. **`get_debug_instructions` by topic** — ~2 kB overview + one section on request instead of one 21 kB block.
4. **Compact motion state** — step/continue/pause/`wait_for_stop` return location, frame ids, top 5 frames and the breakpoint list only when it changed; full snapshot only at session start.
5. **Capped listings** — variables: 40 per scope, 200 chars per value (uncapped with `variableNames`); call stack: 20 frames, workspace-relative paths; threads: 32; `read_memory` defaults to hex.
6. **Lighter recovery** — after a motion timeout, PC and LR are read instead of all 23 core registers.
7. **`diagnose_fault`** — one call replaces the ~6-call HardFault loop (fault registers as one 24-byte read, stacked frame, top frames, address resolution, ranked hypotheses with the next call).
8. **`lookup_peripheral` / `lookup_register`** — SVD answers with no session and no target access; unknown names get suggestions instead of the full name list.
9. **`cmsis_action` target check/switch** — every result names the target it ran on and `target` switches/verifies it, removing the wrong-target build → confused-investigation round trips.
10. **Measurement built in** — per-call telemetry (bytes in/out, ms, outcome), the `cmsis-developer-assistant://stats` resource, the `get_session_status` trailer and optional JSONL export; the eval-scenario runner scores an agent's run against tool-call, turn and time budgets.

### Added
- **`cmsis_action` checks and switches the target** — the tool used to act on whatever target-type the CMSIS Solution panel happened to have selected, and its result never said which; on a board + FVP or HE/HP solution a build or flash could go to the wrong context unnoticed. Every result now names the target it ran on (`✅ CMSIS 'build' succeeded on HP@debug …`), `get_device_info` reports the panel's `CMSIS target:`, and the new optional `target` input (`MPS3` or `HP@debug`, the csolution's own names) selects one: a differing target is switched — the selection is written to `.vscode/cmsis.json` and the solution re-activated, the mechanism the extension (1.70) itself uses since it exposes no command for it — and verified through `cmsis-csolution.getActiveTargetSet` before anything runs. An undeclared target is refused with the declared list, an unverifiable switch with what was written and what the extension still reports, and a switch under a live debug session with a pointer to `stop_debugging`. The build topic and the `cmsis-debug-live` skill say when to pass `target`; the transport test drives the refusal, switch and no-op paths against a stubbed extension.
- **Agent evaluation scenarios** — `npm run eval:scenario -- <id>` runs a real Copilot CLI session against a planted bug and reports what it cost: tool calls by name with argument and result bytes, reasoning turns, wall time, the server's per-tool byte totals (from the `cmsis-developer-assistant://stats` resource, diffed around the run), and a verdict from the final answer against the expected root cause plus tool-call, turn and time budgets; infrastructure failures are reported as such, not as agent failures. Ships the BSP Blinky example for the Corstone-300 FVP as the fixture (`test/eval/fixtures/corstone-blinky`, with the FVP shim for Docker on macOS) and five deterministic scenarios (divide by zero, undefined instruction through a corrupted function pointer, MSPLIM stack overflow, unaligned access, an LED off-by-one with no fault). Opt-in only — it needs an authenticated Copilot CLI, a VS Code window on the work directory and an FVP or board; the pure logic (scenario validation, event aggregation, verdict, mcp-config edit) is unit-tested. `scripts/test-skill-trigger.ts` shares the Copilot CLI helpers.
- **`diagnose_fault`** — one call replaces the six-call HardFault loop: the decoded fault registers (read as one 24-byte SCS block), the stacked exception frame located through EXC_RETURN (PSP or MSP, basic or FP-extended) with the PC of the faulting instruction and its caller, the top frames, the faulting address resolved against the SVD or the Cortex-M system map (an unclocked `I2C1.CR1`, a null pointer plus offset, SRAM), and up to three ranked hypotheses each with the next tool call — unclocked peripheral, null pointer, wild pointer, imprecise write, stack overflow (with MSPLIM/PSPLIM when the core has them), corrupted function pointer, missing Thumb bit, unaligned access, divide by zero, FPU off, bad VTOR. Every section after the fault registers degrades to a note instead of failing the call; with no fault flag set it returns a short stop context. `get_fault_info` now also names `STKOF` (Armv8-M stack limit) and `DEBUGEVT`, and its text is otherwise unchanged. Four long tool descriptions were shortened to keep the tool list within its byte budget.

## [2.3.6] - 2026-08-24

### Added
- **`lookup_peripheral` and `lookup_register`** — answer SVD questions without a debug session and without touching the target: the peripheral list, a peripheral's register map (offsets, absolute addresses, access), which peripheral and register sit at an address (turn a BFAR into `I2C1.CR1`), and one register's bit fields with their enumerated values (which bit is the clock enable). The SVD is resolved from an explicit `svdFile`, the active session, `out/**/*.cbuild-run.yml` (`pname` picks the core) or a single workspace `.svd`, and the failure text lists what was tried. Unknown names get suggestions instead of the full name list — `read_peripheral_register` now does the same and points at `lookup_peripheral`. The parser reads `addressBlock`s, `enumeratedValues` and `dim` register arrays, and no longer borrows a field's `access` for its register.
- **`cmsis-developer-assistant.serial.enabled`** (default on) — off leaves the ten `serial_*` tools out of the MCP tool list, which every agent turn carries. Fixed per server instance (window reload), so the tool list a client sees never changes between turns.

### Changed
- **Smaller tool results.** Step, continue, pause and `wait_for_stop` now return a compact state: the location and frame ids, the top 5 frames with the rest counted, and the breakpoint list only when it changed since the last snapshot (a count otherwise) — the full snapshot still comes back when a session starts. `read_memory` defaults to `hex` (`ascii` / `both` on request). `get_call_stack` prints workspace-relative paths and collapses frames beyond 20 unless `levels` is given; `get_threads` lists up to 32 tasks. Variable listings without `variableNames` are capped at 40 variables per scope and 200 characters per value, with a footer saying how many were left out and how to widen; with `variableNames` nothing is capped. The recovery section after a motion timeout reads PC and LR instead of all 23 core registers. Tool descriptions state the caps.
- **Smaller tool list.** The serialized `tools/list` every client receives at `initialize` — and re-sends to the model on every turn — shrank by a fifth (33.2 → 26.7 kB for the single-window surface): the per-call `timeoutMs` note is one short line per tool with the rationale once in the server instructions, and the `start_debugging`, `cmsis_action`, `reset`, `add_breakpoint`, `add_logpoint`, `flash` and `get_debug_instructions` descriptions carry the trigger and the one caveat an agent needs at call time; the reasoning moved to the `cmsis-debug-live` skill and the `get_debug_instructions` topics (`build` for the result line and long builds, `breakpoints`, `inspection` for reset methods). The transport test now asserts a byte budget for the tool list and a 700-character cap per description.
- **`get_debug_instructions` takes a `topic`** — the guide for harnesses that do not load skills (GitHub Copilot Chat) no longer arrives as one 21 KB block. Without `topic` the tool returns a ~2 KB overview (the critical steps, the debugger-first rule) plus the list of topics; `session`, `build`, `breakpoints`, `inspection`, `faults` and `troubleshooting` return one section each. The guide itself was restructured around those topics (marker comments a Markdown reader never sees), gained a `faults` section (EXC_RETURN, the stacked frame, resolving BFAR, the usual cause per flag) and a `build` section (cmsis_action result line, long builds, flash, attach), and its inherited root-cause examples about `getUserById()`, `parseFloat()` and payment forms were replaced by Cortex-M ones (stale D-cache after DMA, an unclocked peripheral, a watchdog fed from a blocking task, a stale `SystemCoreClock`). The full guide stays available as the `cmsis-developer-assistant://docs/debug_instructions` resource; shipped docs are now read once per server instance.

## [2.3.5] - 2026-08-24

### Added
- **Per-tool call telemetry** — every MCP tool call is measured at the server boundary: argument and result bytes, wall time and outcome (`ok` / `timeout` / `error`). `get_session_status` now ends with a two-line summary for the session, the new `cmsis-developer-assistant://stats` resource returns the per-tool totals as JSON (session and server instance, plus the last 50 samples) so a test driver can diff it around a run, one INFO line per call goes to the output channel, and the new **`cmsis-developer-assistant.telemetry.jsonlPath`** setting (default off) appends one JSON line per call to a file — names and sizes only, never arguments or results. `test/realboard/run.ts` writes the statistics into its report. Groundwork for measuring the response-size work and for agent evaluation runs.

## [2.3.3] - 2026-08-21

### Changed
- **The upstream skills repository is now [Open-CMSIS-Pack/cmsis-skills](https://github.com/Open-CMSIS-Pack/cmsis-skills)** (renamed from cmsis-agent) and the extension adopts the name throughout: the vendored tree is `skills/cmsis-skills/`, the lock is `skills/cmsis-skills.lock.json`, the catalog source id is `cmsis-skills`, and the pin moved to the renamed repository's current `main` (`d778b91`, documentation-only changes upstream — the 21 skills are unchanged, same content hash). Nothing changes on disk for users; installed skills are re-marked on the next sync.

## [2.3.2] - 2026-08-21

### Added
- **`cmsis-developer-assistant.aiSkills.enabled`** (default on) — enable the AI Skills Pack for selected agents: the Open-CMSIS-Pack/cmsis-agent skills and their per-category entry points. Off: the pack skills this extension installed are removed on the next sync (marker-guarded — your own skills are never touched), the skills step of the setup and the install prompt are skipped, the extension's own `cmsis-debug-live` and `cmsis-help` stay installed, and the `installedSkills` selection is kept so turning it back on restores exactly what you had. Toggling it re-syncs immediately, like a change to the selection.
- **`cmsis-developer-assistant.aiSkills.promptOnDetect`** (default on) — when an agent has the MCP server registered (detected in its config file) but no pack skill has been selected, a notification offers to install the CMSIS AI Skills: **Select Skills** opens the picker, **Later** asks again in 30 days, **Don't ask again** turns the setting off. At most once a month, recorded in `globalState` (`skillsPrompt.lastShownAt`, cleared by *Reset Popup State*); never while the first-run setup is still pending, never under Antigravity/Gemini, never with the pack disabled. The decision is a pure function with tests (`src/test/skillPrompt.test.ts`).
- **`/cmsis-help` skill** — answers "what can I ask the CMSIS Developer Assistant for?": the CMSIS slash commands, the member skills behind each entry point, the VS Code commands, the MCP tool groups and the settings. Generated by `npm run skills:sync` from the catalog, `package.json` and `scripts/skills.config.json` (`src/utils/skillHelp.ts`) and re-rendered by the tests, so a new command, setting or skill that is not reflected in the shipped file fails `npm test`. Always installed; the routers end with a pointer to it.

### Changed
- **The bundled skills are always installed.** `cmsis-debug-live` and `cmsis-help` no longer depend on the `installedSkills` selection, which now holds only picks from the pack (default `[]`; an existing value that names `cmsis-debug-live` keeps working). The picker no longer lists them. A user who had deselected `cmsis-debug-live` gets it back.
- **Extension description and keywords** widened to the extension's scope: "Enable AI coding agents to manage and extend CMSIS projects, with a set of AI skills and MCP server to interface to build and debug."

## [2.3.1] - 2026-08-20

### Fixed
- **`docs/agent-resources/troubleshooting/csharp.md` carried three unresolved merge-conflict hunks** (`<<<<<<< HEAD … >>>>>>> 251b176`) left by the rebase-merge of the 2.1.0 rename — the file ships in the VSIX and is served to agents as the `troubleshooting/csharp` MCP resource. Resolved; `SUPPORT.md` is back on LF line endings.
- **The architecture diagram on the extension page now ships inside the VSIX.** vsce rewrote the README's relative image link to `package.json`'s `repository` on GitHub, so the extension page showed whatever `assets/architecture.png` that branch held — the original DebugMCP drawing, not the diagram this build was made from. `scripts/package.ts` now generates the packaged readme with the image inlined as a `data:` URI (the only in-package source VS Code's extension page accepts) and the other relative links rewritten as before; `README.md` in the repository keeps its relative paths for GitHub.

## [2.3.0] - 2026-08-20

### Added
- **The Open-CMSIS-Pack/cmsis-agent skills ship in the extension, opt-in.** The 21 skills of [cmsis-agent](https://github.com/Open-CMSIS-Pack/cmsis-agent) (project setup, device debug/trace knowledge, CMSIS-Pack debug authoring) are vendored verbatim under `skills/cmsis-agent/` at a commit pinned in `skills/cmsis-agent.lock.json` (`npm run skills:sync`; upstream has no tags or releases), listed in a generated `skills/catalog.json`, and installed only when selected — the new setting `cmsis-developer-assistant.installedSkills` (application scope, default `["cmsis-debug-live"]`) holds the picks, the new command **Select Agent Skills** (also step 2 of the first-run setup) edits them. The selection is applied on activation and whenever the setting changes, so it follows Settings Sync.
- **One slash command per category instead of 21.** Generated router skills `cmsis-project`, `cmsis-bring-up` and `cmsis-pack` dispatch to their member skills; picking a router installs the members with `user-invocable: false`, which keeps them out of the `/` menu in Claude Code, VS Code and Copilot CLI while the model can still invoke them by description. The `$name` cross-references in each skill are recorded as dependencies and installed (hidden) alongside whatever is picked, so a skill never arrives without the skills it hands over to.
- **Skills are now written to `~/.claude/skills/` as well**, when a Claude home exists — Claude Code reads only its own directory, not `~/.agents/skills/`, so earlier releases' skill was invisible to it. `$COPILOT_HOME/skills/` is written only when that variable is set (the Copilot CLI then ignores `~/.agents/skills`); the unconditional `~/.copilot/skills/` copy is no longer written and the old one is cleaned up.
- **Skill directories are marked and replaced, not merged.** Every directory the extension installs carries `.cmsis-developer-assistant.json`; only marked directories (or the pre-marker `cmsis-debug-live`) are ever replaced or removed, a user's own skill of the same name is left alone and reported, and a re-sync replaces the directory so files dropped from the bundle do not linger. `src/test/skillCatalog.test.ts` pins the catalog to the directories on disk and the lock's content hash; `src/test/skillInstaller.test.ts` covers the marker rules in temp directories.
- **MCP `instructions` at `initialize`.** The server now tells clients up front that these tools drive a live Cortex-M session and that a runtime investigation should start by invoking the `cmsis-debug-live` Agent Skill — target awareness, the session-status gate, breakpoint strategy, step-and-inspect, fault decode, root cause — or `get_debug_instructions` in harnesses that do not load skills. `start_debugging` says the same in one sentence. (Upstream #129.)
- **Debugger-first rule** in the skill and in the `get_debug_instructions` guide. Do not start a runtime investigation by adding `printf` over UART/ITM, LED toggles or trace macros — on a Cortex-M that is a rebuild, a reflash and a reset per hypothesis, and it moves the timing you are observing. Halt and inspect instead; reach for `add_logpoint` only knowing it still stops the core per hit. The skill description gained the trigger vocabulary (runtime bugs, faults, crashes, hangs, failing tests, wrong/null values, unexpected output) so skill-aware harnesses pick it for the right prompts. (Upstream #129.)
- **Contract tests for that guidance** (`src/test/debugSkillGuidance.test.ts`): the trigger words, the debugger-first wording, and that the skill, the MCP instructions and the instructions guide stay consistent. (Upstream #130.)
- **Opt-in live trigger evaluation**, `npm run test:skill-trigger-agent`: runs a real Copilot CLI session in a scratch worktree carrying only the skill, with an embedded prompt, and asserts `cmsis-debug-live` is its first tool call. Deliberately outside `npm test` — needs an authenticated Copilot CLI, spends credits, and a model's first move is not deterministic. (Upstream #130.)

### Changed
- **Commands consolidated.** *Configure Agents and Skills* (`cmsis-developer-assistant.configure`) runs the two-step flow — agents, then skills — that the first-run prompt shows; *Select Agent Skills* runs step 2 alone. *Show Agent Selection Popup* and *Configure Agents* are removed; *Reset Popup State* stays but is hidden from the palette. The first-run flag moved to `popupShown.v3` so existing users see the skills step once.
- `scripts/**` no longer ships in the VSIX.

### Fixed
- **The first-run agent setup picker came back on every activation until something was selected.** Dismissing it (Esc, focus loss) now counts as an answer; manual setup stays available via *Configure Agents and Skills*. (Upstream #115.)

## [2.1.0] - 2026-08-18

### Changed
- **Renamed to CMSIS Developer Assistant** and relocated to the Open-CMSIS-Pack organization. The extension id, settings prefix (`cmsis-developer-assistant.*`), command namespace, MCP server name (tool namespace `mcp__cmsis-developer-assistant__*`), `mcpServerDefinitionProvider` id, resource URIs, and internal identifiers all move from `cmsis-debugmcp` to `cmsis-developer-assistant`. On activation, existing users' external agent configs (Claude Code/Desktop, Cline/Roo, Cursor, Copilot CLI, Antigravity, and the Codex TOML section) are migrated from the old key to the new one and the stale entry removed, so no dead duplicate server is left behind. Agent `autoApprove` lists pinned to the old `mcp__cmsis-debugmcp__*` tool names will need re-approving once.
- **Detached from the Microsoft DebugMCP upstream.** Syncing has stopped; the "fork of" framing is reworded and the Microsoft governance boilerplate (CONTRIBUTING / CODE_OF_CONDUCT / SUPPORT) replaced with Open-CMSIS-Pack equivalents. Microsoft's copyright notice and the MIT license text are retained.

### Added
- **Dual-licensed under Apache-2.0 OR MIT.** `LICENSE-MIT` added beside the Apache-2.0 `LICENSE`; a `NOTICE` records provenance.

## [2.0.3] - 2026-08-10

### Fixed
- **2.0.2 could not activate at all: `Cannot find module './impl/format'`.** `jsonc-parser`'s default entry is a UMD bundle that hands `require` to its factory as a parameter, so esbuild cannot trace `require("./impl/format")` and left the call in the bundle; at runtime it resolved relative to `dist/`, where `impl/` does not exist. esbuild now aliases the package to its ESM build, which uses ordinary static imports.
- **The packaged-VSIX harness never loaded the bundle**, which is how a completely dead extension passed every check and shipped. It now requires the entry point and asserts `activate`/`deactivate` are exported. Verified the check catches the original failure by rebuilding without the alias.

## [2.0.2] - 2026-08-10

### Fixed
- **The bundled agent skill is now actually installed.** It shipped inside the VSIX but was only copied to `~/.agents/skills/` from `configureAgent()` — the agent-registration dialog. Anyone who registered their agents in an earlier release never opens that dialog again, so upgrading delivered the skill to nobody. It is agent-independent by design, so it now installs on activation and overwrites, keeping it in step with the installed extension version instead of drifting behind it.

## [2.0.1] - 2026-08-10

### Changed
- **The extension is bundled with esbuild.** Ships one `dist/extension.js` plus `serialport`'s subtree instead of the whole production dependency tree: **2271 files / 14.7 MB → 246 files / 12.4 MB**. `serialport` stays external because `node-gyp-build` resolves its native `.node` relative to `__dirname` at runtime, so bundling it would break every serial tool. `test/transport/packaged-vsix.js` unpacks a built VSIX and checks the native binding really enumerates ports — that failure mode exists only in the packaged extension, never in development.

### Fixed
- **Compiled tests are no longer packaged.** `.vscodeignore` excluded `src/**` and `test/**` but not `out/test/**`, so every release up to 1.2.1 shipped compiled tests unnoticed. It surfaced when `vsce` refused to package 2.0.0: the redaction tests carry credential-shaped fixtures to prove those shapes get withheld, and the secret scanner found them in the VSIX.

## [2.0.0] - 2026-08-10

Upstream sync: the fork was based on `microsoft/DebugMCP` `4422d8c` (2026-03-14) and had cherry-picked three commits since. Upstream is 102 commits ahead at v2.3.0. This release takes what applies to Cortex-M, adapts what does not, and says which is which.

It also carries the hardware-tool work that had accumulated unreleased on `feature/hw-tools-reset-wait-flash-dwt`.

**Major, not minor.** Three things change behaviour an existing setup can depend on:

- **A window no longer always runs its own MCP server.** One window binds `serverPort` and routes to the rest; the OS-assigned fallback port is gone. Anything that discovered a per-window port, or assumed "my window = my server", has to change. This is the fix for agents driving the wrong board, so the old behaviour is not coming back.
- **The MCP transport is stateful.** Clients must carry the `mcp-session-id` from `initialize`. Every SDK client does; a hand-rolled client that POSTed bare JSON-RPC will now get a 400.
- **`add_breakpoint` prefers `line` over `lineContent`.** `lineContent` still works and is not going away this release, but it is deprecated and the response says so.

It also matches upstream's 2.x line, which this release syncs against.

### Added — hardware tools
- **`wait_for_stop` tool** — block until the target next stops (breakpoint, fault, step-complete, pause) and return the stop reason plus the current debug state, or a structured timeout. Built on raw DAP `stopped` events from the session tracker (the ground truth), not VS Code UI events. Returns immediately with the recorded reason when the target is already stopped. This replaces sleeping blind after `continue_execution` returned while the target was still running — the pattern that once missed a 15 s playback window.
- **`reset` tool** — reset the target inside the live session (breakpoints and session survive, unlike `restart_debugging`) via GDB monitor commands, and **verify the reset actually took effect**: after the reset-halt the PC must equal the reset handler read from the vector table (VTOR-based, falling back to table base 0). `method: auto` escalates `system` → `core` → `hardware` until one verifies; adapter replies that read like "unknown command" escalate instead of being trusted. Unverified resets are reported honestly ("target does NOT appear to have reset", with the adapter replies and the nSRST wiring caveat) — silent non-resets on attach configurations were a recurring field issue.
- **`read_cycle_counter` tool** — DWT CYCCNT for cycle-accurate timing: enables `DEMCR.TRCENA` and `DWT_CTRL.CYCCNTENA` when needed, reports `NOCYCCNT` cores honestly, and prints the wrap (~10.7 s @ 400 MHz), core-halt, and WFE-sleep caveats with the two-point delta recipe.
- **`flash` tool** — `pyocd load --cbuild-run <file>` as a synchronous operation: bytes programmed + rate on success, exit code + pyOCD error/output tail on failure. The cbuild-run file is auto-resolved from launch.json's `cmsis.cbuildRunFile` or a recursive `out/` scan; ambiguity is an error naming the candidates, never a silent pick. Refuses while a debug session is active (programming under a live session wedges most probes). Requires pyocd on PATH; `cmsis_action load` remains the bundled-pipeline alternative.
- **Launch-failure diagnostics passthrough.** The session tracker now keeps a bounded per-session ring of recent adapter traffic (failed DAP responses, adapter stderr/console output — `stdout` excluded so target printf can't flush real errors out). `start_debugging` failures and the `cmsis_action load_and_debug` / `attach` "did NOT survive the initial connect" report append it, instead of leaving the real cause in the extension-host log.

### Fixed — hardware tools
- **`read_peripheral_register` decoded full-word SVD fields as 0.** `decodeFields()` built its mask as `((1 << width) - 1) << bitLow`, but JS bitwise ops coerce to int32: `1 << 32` wraps to 1, so any `[31:0]` field got mask 0 and silently decoded to `0x0` for every register value; width-31 fields were corrupted by the negative `(1 << 31) - 1`, and fields touching bit 31 could print negative. The decode now shifts first (`>>>` is ToUint32) and masks with `2**width - 1` (exact for width ≤ 31), so no intermediate is ever a negative int32. Covered by new unit tests (widths 1/8/31/32, high-bit fields, negative-input normalization).
- **Parsed-SVD cache is now invalidated when a debug session ends.** `clearSvdCache()` existed but had no callers, so a session against a different device could have kept the previous device's decode.
- **Memory writes are verified.** New `writeMemoryWord` executor primitive (DAP `writeMemory` with GDB-`set` fallback) always reads the word back and throws "did not stick" on mismatch — a silently dropped write is exactly how "reset did nothing" happens in the field. Shared by `reset` and `read_cycle_counter`.

### Added — upstream sync
- **`add_logpoint` tool** — print a message and resume instead of halting, bound GDB-native via `dprintf`. Expressions interpolate as `{expr}`; GDB infers nothing about types, so `{expr}` defaults to `%d` and `{expr:%s}` / `{expr:%f}` / `{expr:%p}` override it, with `{{`/`}}` for literal braces. `dprintf` takes no inline `if`, so a `condition` is attached afterwards by breakpoint number — and the response says plainly when the adapter echoed no number to attach it to, rather than pretending the condition applied. The tool description does not claim logpoints are free here: the core still halts on every hit to format and print, which in an ISR or a hot loop distorts the timing you are usually measuring.
- **Conditional breakpoints** — `add_breakpoint` accepts `condition`, passed to GDB as its native `if` clause so the CPU is only halted when it holds. A VS Code-side condition would still stop the core on every hit and decide afterwards. Conditions, log messages, hit counts and disabled state are surfaced in `list_breakpoints` and the debug state as `file:line [when: ...]`.
- **`list_variable_names` tool** — names and types of everything in scope, reading no values. On a slow probe or a large frame that turns thirty round trips into one.
- **`variableNames` filter** on `get_variables_values` and `get_frame_variables` — read only what you asked for. Names are matched against the DAP `evaluateName` first and then the display name, with an adapter type decoration (`config [Dictionary]`) stripped from both; matching the raw display name alone leaves those variables unreachable. Requested names that match nothing are reported back rather than silently omitted. **Deliberately optional, unlike upstream**, which made it required in 2.3.0 — embedded frames are small, so the full dump is usually what you want, and making it mandatory would break every existing agent prompt for no gain.
- **Secret redaction** (`cmsis-debugmcp.redactSecrets`, default on) — values whose name or content looks like a credential are withheld before leaving the extension, on the variable views and `evaluate_expression`. Two fork-specific carve-outs, because the upstream name-only policy misfires badly on firmware: **numeric scalars are never withheld** whatever the variable is called (a `uint8_t auth`, a `token` counter and `0xDEADBEEF` all stay readable — a 32-bit integer cannot carry a credential), and **raw target reads bypass redaction entirely** (`read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`, and `-exec` GDB passthrough). Real SVDs name registers `KEY`, `KR`, `KEYR` and `UNLOCK` — the watchdog and flash unlock registers — and those are exactly what you need when the watchdog is resetting you. Strings, buffers and structures still get the full treatment.
- **Multi-window routing.** External agents get exactly one MCP URL, and until now every window ran its own server on whatever port it could get while `agentConfigurationManager` wrote whichever port that window received — so the last window to start won and the agent routinely drove a window that did not hold the board. Now one window binds the well-known port and forwards each call to the window that owns the target, over a token-gated loopback control server, using a shared file registry of live windows. Upstream routes on a file path alone, which suffices there because every one of its tools takes one; only four do here, so the resolution ladder continues past the path: an explicit pin, the session's established target, the sole window with an active debug session (the normal one-window-one-board case), then the sole window. Ties resolve to an error naming every candidate rather than a guess — reading the wrong board's memory reads as a firmware bug and costs far more than being asked to pick.
- **`list_debug_windows` and `select_debug_window` tools** — see the candidate windows and pin one for the session. Registered only when the server is actually routing.
- **Roo Code and Antigravity** added to the agent registration roster, and the selection popup is suppressed under Antigravity/Gemini, which configure MCP servers themselves.
- **`cmsis-debug-live` Agent Skill**, installed to `~/.agents/skills/` (and `~/.copilot/skills/` when present) on agent registration. Written for Cortex-M rather than adapted from upstream's host-process `debug-live`: target awareness from the CMSIS YAMLs, the five-state session gate, the FPB budget, what to do when a variable and the peripheral disagree, fault decode, and the routing tools. Named `cmsis-debug-live` so it cannot collide with upstream's skill when both extensions are installed.

### Changed — upstream sync
- **`add_breakpoint` takes a 1-based `line`.** It previously took a `lineContent` substring and set a breakpoint on *every* line containing it — in C routinely dozens (`}`, `return;`, `break;`), quietly exhausting the FPB comparators. `lineContent` remains as a deprecated optional fallback so existing agent prompts keep working, and the response says when it was used and how many lines matched.
- **MCP transport is per-session rather than per-request.** `initialize` mints an `mcp-session-id` and that session's transport serves its POSTs, its `GET` SSE stream and its `DELETE`. This is not a return to the shared-server bug that hung `get_threads` after three calls — that was one `McpServer` being closed and reconnected per request; a session-scoped server is never closed mid-flight, and `test/transport/session-lifecycle.js` asserts exactly that.
- **The MCP server no longer falls back to an OS-assigned port.** That fallback is what produced the misrouting. Losing the bind now means another window is the router, and this window becomes a worker; workers retry every 10s so closing the router promotes a survivor rather than leaving the agents' URL dead. Every window advertises the router's endpoint, including through the `McpServerDefinitionProvider`, so in-window Copilot routes exactly like an external agent.
- `deactivate()` is awaited, so a window leaves the shared registry before its extension host goes away.

### Fixed — upstream sync
- **The reported current line was read from the active text editor.** VS Code moves the editor cursor asynchronously after a stop and only for the focused editor, so the position lagged the actual stop and was simply wrong whenever focus was elsewhere — and on a `gdbtarget` session the editor may not track the target at all. It now comes from the DAP top stack frame, which is ground truth. This also removed the 300 ms settle sleep that existed only to let the cursor catch up. (Upstream PR #96.)
- **`GET /mcp` returned a bare 404.** Only `POST` was registered, so the server→client SSE stream a client opens right after `initialize` failed. Cursor's MCP client treats that as a fatal transport error and tombstones the connection as "errored" even while POST tool calls keep working. `GET` and `DELETE` are now registered at startup. (Upstream PR #96.)

### Internal
- Removed `waitForStateChange`/`hasStateChanged`, the old 1 s blind-poll loop, dead since stepping moved to the event-driven wait.
- Op dispatch across windows goes through one shared table checked against `IDebuggingHandler` and `SerialHandler` **at compile time**, so adding a tool without making it routable fails the build. Upstream hand-writes two switches; with 31 debug ops and 11 serial ops here, duplicating the list would guarantee drift, and an op that fell out would run in the router window against the wrong board.
- `test/transport/` — two harnesses that drive the real server over a real socket outside the extension host: the Streamable-HTTP session lifecycle (including the three-consecutive-`get_threads` regression gate) and two-window election, publication, pinning and router failover.
- 132 unit tests, up from 6.

### Not taken from upstream
- **The breaking `get_variables_values`** (required `variableNames`) — added as an optional filter instead.
- **`src/utils/withTimeout.ts`** — the fork's `src/utils/timeout.ts` is a superset (`customRequestWithTimeout`, `HardwareTimeoutError`).
- **`debugTestAtCursor` / VS Code Testing API test debugging** — no meaning for `gdbtarget` firmware.
- **Upstream's `debugConfigurationManager` refactor** — theirs went toward .NET/csproj auto-configuration; the fork's is CMSIS-specific and keeps `jsonc-parser`, which upstream dropped.
- **Removal of `get_debug_instructions`** — kept. Copilot Chat reads MCP tools but not `~/.agents/skills`, so removing it would leave that harness with nothing.
- **esbuild bundling** — prepared but **not enabled**; `esbuild` could not be installed in the environment where this was done, so the bundle was never built and the serial backend was never checked against a packaged VSIX. See [docs/packaging-esbuild.md](docs/packaging-esbuild.md).

## [1.2.1] - 2026-07-11

### Fixed
- **`cmsis_action build` (and `load` / `erase` / `load_and_run`) now return a terminal result instead of leaving the agent idling.** These actions were fire-and-return: the tool kicked off the `cmsis-csolution.*` command and immediately replied "issued — check the CMSIS output channel for build/flash progress." An agent has no tool to read a VS Code output channel and no completion signal, so it would wait indefinitely — in practice polling for an output artifact file that the tool never promised. The handler now listens for the cbuild/flash **VS Code task** and returns the real outcome from its process exit code: `✅ succeeded (exit 0)` with the suggested next step, or `❌ FAILED (exit N)` pointing at the compiler/linker errors to fix. If no task runs within the window it reports "nothing to build / picker open"; if the task is still running at the deadline it says so — every path is terminal and explicitly tells the agent **not** to wait for a file. `build`/`load`/`erase`/`load_and_run` now default to the full 60 s handler budget (they run a real build), while `load_and_debug` / `attach` keep their fast hand-off to `get_session_status` polling.

### Changed
- The `cmsis_action` tool description now states that build/flash actions return a terminal exit-code result, so the agent stops trying to poll for build completion.

## [1.2.0] - 2026-07-11

### Added
- **Claude Code and Claude Desktop registration.** Both now appear in the agent selection popup and the manual configuration command. Claude Code gets a user-scoped `{"type": "http", "url": ...}` entry in the top-level `mcpServers` of `~/.claude.json`; Claude Desktop (which supports only stdio servers) gets an `npx mcp-remote <url>` bridge entry in `claude_desktop_config.json`. The one-time agent popup re-appears once after upgrading so existing installs can opt in.

### Security
- **MCP server now binds the loopback interface only.** `app.listen(port)` without a host binds `0.0.0.0`, so the server — which exposes flash download, erase, memory reads, and arbitrary GDB expression evaluation without authentication — was reachable from the local network, contradicting the README's "runs 100% locally". Both the preferred-port and the OS-assigned-fallback listeners now bind `127.0.0.1`. VS Code Remote / WSL port forwarding is unaffected (it forwards localhost).
- **DNS-rebinding protection.** Requests whose `Host` header (or `Origin`, when present) is not a loopback address are rejected with 403. Without this, a malicious web page could point its own DNS name at `127.0.0.1` and drive the debugger through the victim's browser — loopback binding alone does not stop that.

### Fixed
- **Port fallback silently pointed a second VS Code window at the first window's debug server (the port-allocation bug).** `listenWithFallback()` used the `app.listen(port, host, callback)` callback as its success signal, but in Express 5 that callback is invoked unconditionally — *before* the bind result is known. On `EADDRINUSE` it fired with `server.address() === null`, the promise resolved with the dead, unbound server, and the `EADDRINUSE` handler's fallback listener resolved nothing and was leaked. `getActualPort()` then fell back to the *configured* port (3001) — the one already owned by the first window. Consequences: the second window reported "server running on :3001", registered `:3001` with Copilot and wrote it into every agent config, and its agent then drove the **first window's debug session and hardware target** — while the second window's own server accepted no connections at all. Bind success is now taken from the server's `listening` event, the port is read back from the bound socket, and `start()` fails loudly rather than guessing a port.
- A persistent `error` listener is now attached to the running HTTP server; previously a post-startup socket error would have been an unhandled `error` event and taken down the extension host.
- `stop()` clears the cached port so a stopped server can no longer report a live endpoint.
- Changing `cmsis-debugmcp.serverPort` now prompts to reload the window. Previously the setting silently had no effect until the next reload, while agent configs kept pointing at the old port.
- **Spurious "Migrated N agent configuration(s)" toast on every activation.** The migration check treated any `type: 'http'` entry as legacy, but `http` is the *correct* transport for GitHub Copilot CLI (and now Claude Code) — those entries were rewritten and re-announced on every startup. Migration now only fires when the existing transport differs from the one the agent should use.
- **Config files are never clobbered on parse failure.** Previously an unparseable agent config was silently replaced with a fresh object — catastrophic for `~/.claude.json`, which holds session history and settings beyond MCP entries. Configuration now aborts with an error message instead. All config writes go through a temp-file + rename so a crash mid-write can't truncate the file.
- **Stale endpoint refresh.** When the server starts on an OS-assigned fallback port, existing agent config entries pointing at the old port are silently updated on activation instead of being left dead.
- Removed dead code left over from the pre-stateless transport design (`isServerRunning()`, the unused `transports` map) and consolidated the four hardcoded version strings onto `SERVER_VERSION`.
- Packaged `.vsix` shrinks from 29.5 MB to 14.6 MB — the 15 MB demo video was being shipped to every user despite being referenced only from the GitHub repo.

## [1.1.9] - 2026-05-19

### Fixed
- **`cmsis_action attach` false success — real fix (bug #3, third attempt).** Previous attempts probed `getSessionStatus()`, whose DAP `threads` ping is *answered by the adapter process* even when GDB is not connected to a target — a zombie `gdbtarget` session (adapter alive, no target behind the port) kept its VS Code session object and answered the ping for several seconds, so both probes read a phantom `running`. The decisive signal is now a **non-empty thread list**: a zombie answers `threads` with `[]` (no target → no threads), a real attached Cortex-M always reports ≥1 thread. `confirmSessionSurvives()` now requires `getThreads()` to return ≥1 thread at the decisive (t+6 s) probe; an adapter with a session object but 0 threads is correctly reported as "not connected to a target".
- **Residual breakpoint-warning noise.** `add_breakpoint` / `clear_all_breakpoints` / `remove_breakpoint` no longer surface the harmless raw adapter error ("Error: could not evaluate expression") in their output. For an `unconfirmed` classification the line now reads `<no echo from adapter — normal>`; `delete`/`clear` only echo the GDB reply when it carries a real message (`Deleted…`, a rejection), staying silent otherwise.

## [1.1.8] - 2026-05-19

### Fixed
- **False-negative breakpoint warnings.** `add_breakpoint` and `clear_all_breakpoints` printed scary warnings ("⚠️ GDB did not confirm binding", "GDB delete failed") for operations that actually succeeded. Two causes: (1) the DAP `evaluate` of an `-exec break`/`delete` is not a reliable success signal — the `gdbtarget` adapter runs the command (breakpoint binds / delete happens) but frequently returns an empty or error `evaluate` response because it has no scalar result to hand back; (2) `clear`/`clearAll` issued the evaluate with no `frameId`, which the adapter rejects ("Evaluation of expression without frameId is not supported") even though the command still ran. Fixes: a shared `execGdbCommand()` helper now always supplies a `frameId` and never throws on an evaluate error; replies are classified `bound` / `rejected` / `unconfirmed`, and only a *definite* GDB rejection ("No source file", "No symbol", …) produces a warning. A missing echo is reported neutrally — "set; verify with continue_execution" — not as a failure.

## [1.1.7] - 2026-05-19

### Fixed
- **`cmsis_action attach` false "up and stable" (bug #3, second attempt).** The v1.1.6 fix probed `getSessionStatus()` once after a 3 s wait — but a `gdbtarget` session with no GDB server behind the port keeps its *adapter process* alive answering a shallow DAP `threads` ping for a few seconds before collapsing, so a single probe still caught it in the alive window and the "and stable" wording then positively asserted a stability that was false. Now `confirmSessionSurvives()` probes at **two** time points (t+3 s and t+6 s); each requires the session object to still exist *and* `getSessionStatus()` to be `running`/`stopped`. A no-target session has collapsed to `no-session` by the second probe, so it is correctly reported as "did not survive the initial connect", with guidance to start a GDB server or use `load_and_debug`.

## [1.1.6] - 2026-05-19

Fixes from the v1.1.5 full-tool-surface test report (27/30 tools passing).

### Fixed
- **Breakpoints now actually bind on the target (bug #1, the priority).** `add_breakpoint` populated VS Code's breakpoint *model* via `vscode.debug.addBreakpoints()`, but on `gdbtarget` sessions the resulting `setBreakpoints` DAP request was not reliably forwarded to the adapter — the target ran straight through. `add_breakpoint` now *also* binds GDB-native via `-exec break file:line` (exactly what a raw GDB session does, which was verified to work), and reports GDB's confirmation (`Breakpoint N at 0x…`). `remove_breakpoint` issues `-exec clear file:line`; `clear_all_breakpoints` issues `-exec delete`. The VS Code model is still updated so `list_breakpoints` and the editor gutter stay in sync.
- **`cmsis_action attach` no longer reports premature success (bug #3).** A session object appearing is not proof the session is alive — when no GDB server is behind the port, `attach` produced a session that collapsed within seconds. After the session appears, the handler now waits 3 s and re-probes; it reports success only if the session is still `running`/`stopped`, otherwise it reports the collapse and tells the agent to start a GDB server / use `load_and_debug`.
- **`start_debugging` "launch.json does not exist for passed workspace folder".** That error is thrown by VS Code core when the passed workspace folder doesn't resolve. `startDebuggingByName` now uses a robust `resolveWorkspaceFolder()` — exact API lookup → trailing-slash-normalised path-prefix match (both directions) → the sole workspace folder when there is only one — and, if nothing matches, returns a clear message listing the open workspace folders instead of letting VS Code throw the opaque core error.

### Known / not yet fixed
- `cmsis_action load_and_debug` builds + flashes but on some projects does not chain into a tracked debug session (no gdbserver/gdb spawned). Workaround: run an external GDB server and use `cmsis_action attach`. Under investigation — likely a CMSIS Solution extension launch-config interaction.

## [1.1.5] - 2026-05-18

### Changed
- **`cmsis_action` now asks the CMSIS Solution extension whether a solution is active**, instead of inferring it. Before firing any action it calls `cmsis-csolution.getSolutionFile` (which returns the extension's internal `_activeSolution` and never throws) — a truthy result means a csolution project is loaded in this VS Code window. If none is active, the tool returns a precise message naming the cause and the fixes, *without* attempting the command. This replaces the earlier guess based on `.vscode/cmsis.json` presence, which was wrong: `cmsis.json` is legitimately empty/absent for single-target solutions, so a csolution project can be perfectly active without it.

## [1.1.4] - 2026-05-18

### Changed
- **`cmsis_action` "No active solution set" is now an actionable error.** When the CMSIS Solution extension has no active solution context, the tool returns a specific message naming the cause (the VS Code window running this MCP server does not have the project's `*.csolution.yml` open) and the three concrete fixes, instead of the generic "ensure a solution context is active". Includes the `serverVersion` so a stale build is ruled out at the same time.

## [1.1.3] - 2026-05-18

### Changed
- **`cmsis_action` is now fire-and-return.** It previously blocked the whole tool call until the debug session was fully up — a multi-core flash + attach legitimately takes 20-40 s, so the call felt hung (and could report a misleading 60 s timeout). It now kicks off the CMSIS command, does one short (~8 s) opportunistic wait for a fast bring-up, then returns and tells the agent to poll `get_session_status` — matching how the CMSIS Solution panel's Debug button behaves (returns instantly, progress shown separately). Worst-case tool duration drops from ~60 s to ~12 s.

### Added
- **`get_session_status` diagnostics line.** Now reports `serverVersion`, `liveSessionsInThisWindow` (count + names), and whether `vscode.debug.activeDebugSession` is set. When state is `no-session` with `liveSessionsInThisWindow=0`, the hint explicitly calls out the two real causes: a stale extension build (reload the window), or the debug session running in a *different* VS Code window than the MCP server (each window has its own extension host — they cannot see each other). This turns a single `get_session_status` call into a definitive diagnosis instead of guesswork.

## [1.1.2] - 2026-05-18

### Fixed
- **`get_session_status` reported `no-session` while a debugger was visibly running**: the executor read `vscode.debug.activeDebugSession` directly, which only reflects the session the VS Code UI currently has *focused* — it is `undefined` whenever focus is elsewhere, which is routine for `gdbtarget` multi-core launches. The `sessionStateTracker` already saw every session via its `DebugAdapterTrackerFactory`, so it now also maintains a live-session list and exposes `resolveActiveSession()` = `activeDebugSession ?? mostRecentLiveSession`. All 20 `vscode.debug.activeDebugSession` reads in `debuggingExecutor.ts` route through it, so session status, inspection, stepping, and serial cleanup all work regardless of UI focus. (A session in a *different* VS Code window runs in a different extension host and remains genuinely invisible — that is not fixable.)

## [1.1.1] - 2026-05-18

### Fixed
- **`cmsis_action` could hang Copilot indefinitely**: `handleCmsisCommand` was the one hardware-touching handler never wrapped in `withHandlerTimeout` (it was added in v1.0.23, after the wrap was applied to the other tools). `await vscode.commands.executeCommand('cmsis-csolution.cmsisLoadAndDebug')` blocks until the CMSIS command's handler resolves — if that command surfaces a QuickPick (select context / debugger), the await waits for a UI interaction the agent cannot make, hanging the tool call forever. Now: the handler is wrapped in `withHandlerTimeout`, and the `executeCommand` is raced against an 8 s kick-off deadline — the build/flash continues in the CMSIS extension regardless, and for session-producing actions we poll for the session afterwards.
- **`cmsis_action load_and_debug` / `attach` falsely reported "no debug session became ready"**: `waitForActiveDebugSession` polled `hasActiveSession()`, which is true only when the target is *stopped*. A `load_and_debug` whose firmware runs free (no `break main`) or an `attach` to a running target left a perfectly healthy session that the poll never accepted → 60 s timeout → misleading error. `waitForActiveDebugSession` now polls `getSessionStatus()` and accepts any responsive state (`stopped` **or** `running`). Also fixes the same false timeout in `start_debugging` and `restart_debugging`.

## [1.1.0] - 2026-05-18

Ports three useful changes from upstream `microsoft/DebugMCP` (commits after the fork point `4422d8c`), adapted for the CMSIS fork.

### Added
- **Codex agent configuration support** (from upstream `5feecd4`): `AgentConfigurationManager` now writes a `[mcp_servers.cmsis-debugmcp]` block into the Codex `config.toml` (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`). TOML is upserted in place, preserving the rest of the file. Stale `/sse` endpoints are migrated.
- **GitHub Copilot CLI support** (from upstream `7cbe4f9`): writes an MCP entry into `$COPILOT_HOME/mcp-config.json` (default `~/.copilot/mcp-config.json`) with `type: 'http'` + `tools: ['*']`, the shape the Copilot CLI expects. (The Copilot *extension* in VS Code is still handled dynamically by the `McpServerDefinitionProvider` — no static config.)

### Fixed
- **launch.json parsed with `jsonc-parser`** (from upstream `9c422e5`): the previous regex-based comment stripping matched `//` inside string values — e.g. an `https://` URL in a config field — corrupting the JSON and causing parse failures. CMSIS Solution generates `launch.json` with comments, so this was a real bug for the fork. All three parse sites in `debugConfigurationManager.ts` switched to `jsonc.parse`.

### Notes
- Upstream's `6f7fa56` ("Remove extra checks in hasActiveSession()") was **not** ported — the fork already replaced that gate with a DAP-event tracker + `ensureStoppedSession` + state-aware errors, which is the better fix for embedded targets.

## [1.0.27] - 2026-05-18

First public release of the fork. Rolls up the work between v1.0.9 (initial CMSIS fork tag) and v1.0.27 into one release. Published as a GitHub release with `cmsis-debugmcp-1.0.27.vsix` attached.

### Added — CMSIS-Solution-driven workflow
- **`cmsis_action` MCP tool**: wraps the CMSIS Solution panel buttons. Actions: `build`, `load`, `erase`, `load_and_run`, `load_and_debug`, `attach`, `detach`, `stop_run`. **Preferred entry point for Cortex-M debug** over `start_debugging` — `load_and_debug` builds (if needed), flashes the device, and attaches the debugger in one step, matching the panel's "Debug" button. `load_and_debug` and `attach` wait for the session to be usable before returning.
- **Pre-check refusal on duplicate session**: `start_debugging`, `cmsis_action load_and_debug`, and `cmsis_action attach` now refuse with a structured message when a debug session is already active, naming the existing session and pointing the agent at `stop_debugging` / `restart_debugging`.
- **`start_debugging` re-scoped**: tool description rewritten to flag it as **non-CMSIS only** (Python / Java / JS / etc.). For CMSIS projects, `cmsis_action load_and_debug` is the right call.

### Added — Pause, call-stack, threads, frame variables
- **`pause_execution` MCP tool**: DAP `pause` for inspecting a running target without ending the session. State-aware: no-op if already stopped, refuses if probe is unresponsive.
- **`get_call_stack` MCP tool**: full DAP `stackTrace` with frame IDs (up to 200 levels). Agent can walk the stack and pass `frameId` to `get_frame_variables`.
- **`get_threads` MCP tool**: DAP `threads` enumeration. With RTOS-aware GDB servers (pyOCD `--rtos`, J-Link RTOS plugin), FreeRTOS / RTX / ThreadX tasks appear as threads — matching the xRTOS viewer task list.
- **`get_frame_variables` MCP tool**: inspect variables at an explicit `frameId` without changing the editor's active frame. Lets the agent walk up the call stack and examine caller-frame state.

### Added — Per-call timeouts and auto-heal
- **`timeoutMs` parameter on every hardware-touching tool**: agent-supplied deadline, server-capped to 60 000 ms regardless of input.
- **Handler-level `withHandlerTimeout` race**: every inspection tool is wrapped in an outer Promise.race so it always returns within the cap, even if the DAP layer hangs. On overshoot, returns a structured "did not complete within N ms" message with diagnostic guidance.
- **Auto-heal on motion timeout**: `continue_execution` / `step_*` automatically pause the running target on overshoot, read the PC + active frame via `read_core_registers`, and append a 🩹 Recovery section to the response — the agent knows where the firmware actually was instead of seeing a silent "still running".

### Added — Dual serial backend
- **OWNED port** via `serialport` package: `serial_open` / `serial_close` / `serial_write` / `serial_read` (from `'owned'`) / `serial_clear_buffer` / `serial_list_ports` / `serial_status`. MCP server holds the connection and buffers RX up to 1 MB. Use when no MS Serial Monitor UI session is active on the same tty.
- **MS Serial Monitor BRIDGE**: `serial_subscribe_monitor` / `serial_unsubscribe_monitor` runtime-probe `ms-vscode.vscode-serial-monitor` exports for any of `onDidReceiveData` / `onDataReceived` / `onData` / `onSerialData` / `onDidReadData` / `subscribeData`. Today the public API (v0.1.7) only exposes port enumeration; the bridge falls back with a clear "data event not available" message. Auto-lights-up when MS ships a data event — no rebuild needed.
- **`serial_status`**: reports both backends side-by-side and lists the discovered `ext.exports` keys so the agent can confirm what the installed Serial Monitor build exposes.
- **`serial_open_monitor`**: focuses the MS Serial Monitor panel for the user (does not open or read a port). Uses the correct view container ID `vscode-serial-monitor-tools`.

### Added — Stateless HTTP transport (concurrency fix)
- **Per-request `McpServer` instances**: the previous shared-server pattern (`close()` → `connect(newTransport)` on every POST) raced when two tool calls landed concurrently — request B's `close()` stripped the transport request A was about to respond on, hanging request A forever. Now each POST to `/mcp` constructs its own `McpServer` + transport pair and registers tools fresh, matching the official MCP stateless example. Eliminates the `get_threads`-after-three-calls hang.

### Added — Hardware-connection robustness
- **DAP-event-driven session state**: a global `DebugAdapterTrackerFactory` records `stopped` and `continued` events per session. `hasActiveSession()` and `get_session_status` consult this tracker instead of `vscode.debug.activeStackItem`, which is `undefined` whenever the CPU is running and during the brief race window right after a stop event. Eliminates spurious "session is not ready" / "no debug session" reports while the target is just running.
- **`get_session_status` MCP tool**: never-failing classification of the session into `no-session` / `initializing` / `running` / `stopped` / `unresponsive`, with a hint about what to do next.
- **State-aware inspection errors**: inspection tools (`get_variables_values`, `evaluate_expression`, `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`) route through `ensureStoppedSession` and report the actual session state ("running — add a breakpoint", "unresponsive — call check_target_connection") instead of a misleading "no debug session".
- **Per-DAP-request timeouts**: every `customRequest` to the debug adapter is wrapped with a deadline. A stalled probe cannot hang an MCP tool call indefinitely.
- **`HardwareTimeoutError`**: dedicated error type with actionable message.
- **`check_target_connection` MCP tool**: low-cost DAP `threads` ping with a short internal timeout. Diagnostic-grade liveness check.
- **`hasDebugSession()` / `hasActiveSession()` split**: synchronous session-existence check (for `stop_debugging` / `restart_debugging`, works even when target is running) vs. async stopped-frame check (for inspection tools).
- **Parallel core-register reads**: `read_core_registers` issues all 23 evaluates concurrently with per-request and overall deadlines. Individual register failures report `<timeout>` / `<unavailable>` instead of bringing down the whole call.
- **Bounded `read_memory`** and **`read_peripheral_register`**: total time per call capped by `memoryReadTimeoutMs`.
- **`restart_debugging` actually waits** for the session to become ready again, rather than returning after a fixed 300 ms delay.
- **`step_*` / `continue_execution` surface timeouts and session loss**: results annotate when the target failed to stop within the timeout or when the session terminated mid-operation, instead of silently returning a stale state.

### Added — Agent guidance (`debug_instructions.md`)
- **PHASE 0 — Target awareness**: agent reads `<name>.cbuild-idx.yml` → `<context>.cbuild.yml` → `<context>.cbuild-run.yml` → `.vscode/launch.json` before any debug call, and asks the user to regenerate `launch.json` via **Manage Solution → Debugger** if missing. Pointers to CMSIS-Pack documentation links from the CMSIS Solution dialog.
- **PHASE 1 — Session status gate**: 5-state decision table for `get_session_status`, telling the agent the correct next action for each (`no-session` → `cmsis_action load_and_debug`; `running` → pause first; `unresponsive` → `check_target_connection`).
- **Cortex-M hardware breakpoint limit**: documents the FPB comparator ceiling (M0/M0+/M23: 4, M3/M4: 6, M7/M33/M55/M85: 8) and recommends `list_breakpoints` before adding, iterative replacement, and `clear_all_breakpoints` between phases.

### Added — Real-board test driver
- **`test/realboard/run.ts`**: end-to-end test runner that connects to the running MCP server (Streamable HTTP) and exercises every tool. Pre-flight `estimatedMs` per test; hard timeout `min(2 × estimatedMs, 60 s)`; pauses and runs a diagnostic sweep (`get_session_status` / `check_target_connection` / `get_fault_info`) on every overshoot. Board-specific knobs (endpoint, configurationName, ELF region, peripheral name, serial path) come from `realboard.config.json`.

### Configuration
- **`cmsis-debugmcp.dapRequestTimeoutMs`** (default 10000) — per-request DAP timeout.
- **`cmsis-debugmcp.memoryReadTimeoutMs`** (default 30000) — overall cap for `read_memory` / `read_core_registers`.

### Removed
- **Static `mcp.json` write for GitHub Copilot**: superseded by the `vscode.lm.registerMcpServerDefinitionProvider` registration done at extension activation, which eliminates the startup race condition and handles dynamic port assignment automatically. Cline and Cursor static configs are still written.

## [1.0.9] - 2026-04-16

### Added — CMSIS-DebugMCP fork
- **Project rename**: `DebugMCP` → `CMSIS-DebugMCP`. Extension name, display name, MCP server name, resource URIs (`cmsis-debugmcp://docs/...`), configuration keys (`cmsis-debugmcp.*`), and command IDs updated.
- **`gdbtarget` passthrough**: when `start_debugging` is called with `configurationName`, the named entry from `launch.json` is passed directly to `vscode.debug.startDebugging()` without language detection or config rewriting. `fileFullPath` is now optional in this path.
- **Five new embedded MCP tools**: `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`, `get_device_info`.
- **Cortex-M fault decoder**: decodes CFSR (MMFSR/BFSR/UFSR), HFSR, DFSR, MMFAR, BFAR, AFSR into human-readable diagnostics.
- **Peripheral register reader**: uses the Peripheral Inspector extension API when available; falls back to SVD parsing + DAP `readMemory`.
- **CMSIS knowledge resources**: `cmsis-debugmcp://docs/cmsis-embedded-guide` and `cmsis-debugmcp://docs/troubleshooting/embedded` provide Cortex-M expertise to agents.

### Upstream history (DebugMCP)

## [1.0.8] - 2025-03-14

### Added
- Improved debug state reporting with richer context for AI agents
- Named debug configuration support via `configurationName` parameter — use specific `launch.json` configurations by name

### Fixed
- Fixed debug state consistency issues during rapid step operations

## [1.0.7] - 2025-02-XX

### Changed
- **Migrated from SSE to Streamable HTTP transport** — faster, more reliable MCP communication
- Automatic migration of existing SSE configurations to new Streamable HTTP format
- SSE backward compatibility maintained during transition period

### Fixed
- Dependency security updates (undici, express, body-parser, glob, js-yaml)

### Internal
- Migrated from `fastmcp` to official `@modelcontextprotocol/sdk`

## [1.0.6] - 2025-01-XX

### Added
- **Agent auto-configuration popup** — automatically detects and registers with AI assistants (Cline, Copilot, Cursor)
- **Comprehensive documentation** — added architecture docs, AGENTS.md, and troubleshooting guides
- Language-specific debugging tips for Python, JavaScript, Java, C#, C++, and Go

### Fixed
- Fixed failure when `launch.json` contains comments (JSONC parsing)
- Fixed C++ debug configuration issues
- Fixed string equality comparison in breakpoint matching

## [1.0.5] - 2025-01-XX

### Added
- **Debug specific test methods** — pass `testName` to debug individual unit tests
- Clear all breakpoints tool for quick cleanup
- Breakpoint listing tool to view all active breakpoints

### Changed
- Default launch configurations moved to lower priority (user configs preferred)
- Improved MCP tool descriptions for better AI agent understanding

## [1.0.4] - 2024-12-XX

### Added
- **C#/.NET debugging support**
- Keep-alive for SSE sessions to prevent timeouts

## [1.0.3] - 2024-12-XX

### Added
- Multi-language debugging support: Python, JavaScript/TypeScript, Java, C/C++, Go, Rust, PHP, Ruby
- Breakpoint management (add, remove, list, clear all)
- Step-through execution (step over, step into, step out)
- Variable inspection with scope filtering (local, global, all)
- Expression evaluation in debug context
- Automatic debug configuration generation from file extensions
- MCP server with SSE transport

## [1.0.0] - 2024-12-XX

### Added
- Initial release
- Core debugging capabilities via MCP protocol
- VS Code Debug Adapter Protocol integration
- Automatic MCP server startup on extension activation