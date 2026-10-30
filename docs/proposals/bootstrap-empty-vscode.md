# Bootstrap: from an empty VS Code window to a debugged board

> **2.7.0 status (2026-10-27).** open_solution, catalog-based create_solution, install_pack and activate_environment are available. The original bundled-skill plan and creation argument shape below are historical: procedures now come from the pinned knowledge index. The environment/context query, standalone open_folder action and empty-directory evaluation remain proposals for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md).

| | |
|---|---|
| Issue | none yet (see Decision 6) |
| Area · priority · source | Agent setup · Medium · maintainer |
| Original release plan | phases 0–1 in the next 2.5.x, phase 2 with #41 |
| Size | phase 0 XS, phase 1 M, phase 2 M, phase 3 S |
| Depends on | nothing for phases 0–1; #41 (cross-extension commands) for phase 2 |
| Related | #17 (toolchain info), #20 (docs gaps), #45/#50 (tool contract: which shell commands a skill may name), #21 (asks to the CMSIS Solution team) |
| Original status | Phases 0 and 1 implemented in 2.5.9 (2026-09-30), see below; phase 2 stays with #41; phase 3 open |

## What 2.5.9 did with this proposal

Decided on 2026-09-30: no single large bootstrap skill, because most steps already have one.

- **Phase 0 is in:** the error code `NO_WORKSPACE` (Decision 1a), `cmsis_action` saying which part of an active solution is missing, the `Workspace:` and `Extensions:` lines of `get_session_status`, the `bootstrap` topic of the guide, the README section.
- **`cmsis_action open_solution` came forward from phase 2**, as the link from the agent to the window: a folder that is open is activated there, any other opens in a new window and the router moves the session to it (Decision 2a). `cmsis_query` and `create_solution` stay with #41.
- **Phase 1 is split.** `cmsis-bootstrap` (bundled) only finds out what is missing, asks, and hands over. The creation of the project is `start-cmsis-project`, written for Open-CMSIS-Pack/cmsis-skills (Decision 3b first); see [cmsis-skills-start-cmsis-project-pr.md](cmsis-skills-start-cmsis-project-pr.md). `cmsis-debugger-setup`, `fvp-debug-setup` and `debugger-troubleshooting` moved into the repository as selectable skills.
- **Decision 4** became: an example of the board's pack, a template of the pack, or the minimal project, chosen by the user. **Decision 5a** holds. **Decision 6** (an upstream issue) is still open.
- **Tested** in a VS Code of its own with CMSIS Solution 1.72.0: empty window, `open_solution`, the new window registers after 1.5 s and the session follows, the solution is activated, `cmsis_action build` ends ✅. Not tested: `load_and_debug` on a board after a bootstrap, the Environment Manager fetching tools on a machine that has none, Windows.

## Problem

Every workflow the extension documents starts in the middle: "Open a csolution
project in VS Code" is step 1 of the README's Getting Started, the agent guide's
target-awareness checklist reads the csolution YAMLs and `launch.json`, and
`cmsis_action` operates on whatever solution the CMSIS Solution extension has
active. Nothing covers the state a new user, a tester or an evaluation run starts
from: VS Code just installed, no folder open, no project on disk, perhaps no
Arm extensions and no toolchain.

What happens today in that state (2.5.2, verified in the code and the sibling
extension manifests):

- **Our extension activates** (`onStartupFinished`), the MCP server listens on
  3001, the window registers itself with `workspaceFolders: []`, shown as
  `(no folder open)` by `list_debug_windows`. Agent registration is user-level
  (`~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`), so an
  agent started in any directory sees the server. The four bundled skills are
  always personal; pack skills go personal too, since there is no folder to
  hold `.agents/skills`. Rule files: only the user-level ones can be offered.
- **Every CMSIS tool refuses**, each with a different text. `cmsis_action`
  answers `CMSIS_NO_SOLUTION` ("open the folder containing the project's
  `*.csolution.yml` …", [cmsisAction.ts:686](../../src/handler/cmsisAction.ts#L686)),
  `flash` says "No workspace folder open and no cbuildRunFile argument given"
  ([flashTool.ts:100](../../src/handler/flashTool.ts#L100)), `start_debugging`
  finds no `launch.json` and synthesizes nothing useful. None of them says
  what to do *before* a folder exists. `get_session_status` has no notion of
  "no workspace" or "sibling extension missing".
- **The CMSIS Solution extension activates only on `workspaceContains:**/*.csolution.yml`**
  (and `.uvprojx`). In an empty window its commands, including
  `cmsis-csolution.createSolution` ("Create Solution…", a wizard fed from
  `templates/template.csolution.yml`, `template.cproject.yml`, `c/main.c`,
  `debug/*.adapter.json`), `openArmExamples` and `installPack`, exist but the
  extension is not active until a solution file is in the workspace. The
  wizard is UI-only; its programmatic entry (`createSolution({solutionLocation,
  solutionFolder, solutionName, projects, draftProject})`) is internal.
- **The toolchain is per workspace.** The Arm Tools Environment Manager reads
  `vcpkg-configuration.json` of the open folder; with no folder there is no
  environment. The CMSIS Solution extension ships `tools/cmsis-toolbox` (cbuild,
  csolution, cpackget) and the CMSIS Debugger ships `tools/pyocd` and
  `tools/gdb`, so the tools exist on disk before any environment is activated.
  A compiler (GCC, AC6, CLANG) only comes from a vcpkg artifact.
- **No skill creates a csolution from nothing.** `cmsis-project` routes to
  `check-cmsis-environment` (verifies, never installs), `identify-cmsis-board-support`
  (needs `cpackget`/`csolution list`), `add-cmsis-target` and `add-board-layer`
  (both need an existing `*.csolution.yml`) and `start-zephyr-project` (Zephyr
  only, needs `west`). Upstream cmsis-skills has since added `devops/create-csolution-github-action`
  and `ethos-u/evaluate-ethos-u-variants` (our pin is `d778b91`, 2026-08-21), still
  nothing that starts a plain csolution.
- **The tool contract** lets a skill step name `cbuild`, `csolution` or
  `cpackget` for the shell; nothing else may. A bootstrap skill is exactly the
  place where those steps have to be named, one by one.

So a user who says "I have an STM32H735G-DK on the desk, get Blinky running and
stop at main" to an agent in an empty window gets a refusal, and an agent
that improvises reaches for `pip install pyocd`, a hand-written `launch.json`
or `cbuild` from the wrong toolbox, which is what #45 and #50 are about.

## The bootstrap, as it has to work

The target sequence, whoever performs each step (user, agent, extension):

| # | Step | Who can do it today | Evidence of success |
|---|---|---|---|
| B1 | Install the extensions: Keil Studio Pack (`arm.keil-studio-pack` = CMSIS Solution, Environment Manager, CMSIS Debugger, clangd) and this extension | user (Marketplace or `code --install-extension`); an agent with a shell can run `code --install-extension` | `code --list-extensions` shows `arm.cmsis-csolution`, `arm.environment-manager`, `arm.vscode-cmsis-debugger`, `arm.cmsis-developer-assistant` |
| B2 | Register the agent, install the skills, write the rules | our setup flow (three steps), or the `configure` command | the agent lists the MCP server; `get_session_status` answers |
| B3 | Choose a folder for the project | user; an agent can `mkdir` | a path |
| B4 | Identify the board: exact CMSIS board name, DFP, BSP | skill `identify-cmsis-board-support` (needs `cpackget`/`csolution list boards`, which need the toolbox on PATH and an initialised pack root) | one board id, its packs |
| B5 | Pack root: `cpackget init` and `update-index` once, then the DFP/BSP | skill step naming `cpackget`, or CMSIS Solution `installPack` once the extension is active | packs present under `CMSIS_PACK_ROOT` |
| B6 | Create the solution: `*.csolution.yml`, `*.cproject.yml`, `main.c`, `vcpkg-configuration.json`, `.vscode/` | nobody automated. Options: the wizard (UI), a skill writing the files from the toolbox or the extension templates, `csolution list examples` + copy of a Blinky from the BSP | `csolution list contexts` works in the folder |
| B7 | Open the folder in VS Code | user; an agent with a shell: `code <folder>` (same window: extension host restarts) or `code -n <folder>` (new window) | a window with the folder in `list_debug_windows` |
| B8 | Activate the tools environment (vcpkg: toolbox, compiler, cmake, ninja) | Environment Manager on open, or `environment-manager.activate` | `cbuild list toolchains` shows the compiler; `.cmsis/tools-environment.yml` exists |
| B9 | Let CMSIS Solution activate and generate `.vscode/launch.json` and `tasks.json`; select the target set | the extension on activation; `cmsis_action {target}` switches | `cmsis-csolution.getSolutionFile` answers; `launch.json` has a `gdbtarget` configuration |
| B10 | Build, flash, debug | `cmsis_action build`, `load_and_debug` | the usual ✅ line, a stopped session at `main` |

Steps B1–B3 and B7 are the ones no tool covers and where the agent has to
leave the MCP path, by design. Steps B4–B6 and B8 are the ones where an agent
improvises today.

## Proposed fix

### Phase 0: write it down (XS, next 2.5.x)

1. **README: a section "Starting from an empty VS Code"** before Getting
   Started: the ten steps above in prose, what the user does by hand (B1, B3,
   B7) and what to ask the agent for afterwards. One paragraph on the two
   window choices in B7 (same window vs new window, see Decision 2).
2. **Agent guide: a `bootstrap` topic** in `debug_instructions.md`
   (`<!-- topic: bootstrap | … -->`), served by `get_debug_instructions
   {topic:'bootstrap'}`: the state machine "no folder → folder without solution
   → solution without environment → solution without launch.json → ready",
   the check for each state and the next step. The size tests in
   `instructionTopics.test.ts` and `debugSkillGuidance.test.ts` pin the overview,
   so the topic body lives outside the overview.
3. **One refusal shape for the empty window.** `cmsis_action`, `flash`,
   `start_debugging` and the build-artefact and documentation tools answer
   `NO_WORKSPACE` (new code, or reuse `CMSIS_NO_SOLUTION` with a "no folder
   open" variant, Decision 1) with the same hint: "No folder is open in this
   window. See get_debug_instructions {topic:'bootstrap'}". `get_session_status`
   gains one line for it, and one when the CMSIS Solution or CMSIS Debugger
   extension is missing (`vscode.extensions.getExtension`), since an agent
   cannot tell "no solution" from "extension not installed" today.
4. `docs/architecture/agentConfigurationManager.md`: state what the setup does
   without a folder (personal skills only, user-level rule files only).

### Phase 1: a bootstrap skill (M, next 2.5.x)

A bundled skill `cmsis-bootstrap` (always installed like the other four, or a
member of the `cmsis-project` router, Decision 3) that drives B1–B9 by
interview, the way `add-board-layer` does:

- **Checks first, then acts.** `code --list-extensions` (B1), the toolbox on
  disk (B5/B8: the CMSIS Solution extension's `tools/cmsis-toolbox/bin`, or the
  vcpkg artifact named by an existing `vcpkg-configuration.json`, reproduced
  in-process exactly as `check-cmsis-environment` describes), the pack root
  (`cpackget list` or the index file), the board (hand over to
  `identify-cmsis-board-support`).
- **Names every shell command it allows**, so the tool contract holds:
  `code --install-extension`, `code -n <folder>`, `cpackget init|update-index|add`,
  `csolution list boards|examples|contexts`. Never `cbuild` (that is
  `cmsis_action build` once the folder is open), never `pyocd`, never `pip`.
- **Creates the solution from a template** (B6): the skill carries a minimal
  `Blinky` template (csolution with `select-compiler`, one target-type from the
  board id, `Debug`/`Release` build types, one cproject with `main.c`, the
  `vcpkg-configuration.json` the Environment Manager expects), and asks for the
  compiler, the debugger (`CMSIS-DAP@pyOCD`, `ST-Link@pyOCD`, `J-Link`,
  `Arm-FVP`) and, when the BSP has a Blinky example, offers to copy that
  instead (`csolution list examples`, Decision 4). The `debugger:` node in the
  target-set is what makes CMSIS Solution write a `gdbtarget` launch
  configuration, so the skill sets it.
- **Opens the folder** (B7) and then waits: `list_debug_windows` until a window
  lists the folder, `get_session_status` until the CMSIS Solution extension
  reports the solution, then `cmsis_action build`. Decision 2 fixes which
  window.
- **Hands over** to `cmsis-debug-live` for B10.

Tests: a config scenario in `test/transport/config-scenarios.js` for the
no-folder activation (registry entry, refusals, status line), a skill test in
`src/test/skill.test.ts` for the allowed-tools and the named commands, and an
eval scenario `bootstrap-empty-window` for `scripts/eval-scenario.ts` counting
shell bypasses (the #50 metric) from an empty temp directory.

### Phase 2: tool support that removes the shell from B4–B8 (M, with #41)

- `cmsis_query {what:'environment'}` (the #17 / #41 allowlist): installed
  sibling extensions and versions, the toolbox path and version, pack root,
  vcpkg state, compilers found. Read-only, no session needed.
- `cmsis_action create_solution {folder, board, compiler, debugger, template}`
  only if the CMSIS Solution team publishes `createSolution` as a contract
  (#41, an ask for #21). Until then the skill writes the files.
  (2026-10-18: CMSIS Solution's public API v2 has `createNewSolution`, from an
  example or template only; see [cmsis-solution-integration.md](cmsis-solution-integration.md) phase 3.)
- `cmsis_action open_folder {path, newWindow}` around `vscode.openFolder`.
  It is the one action whose result the caller may never see (same-window open
  restarts the extension host and the MCP server), so its text says so and the
  new-window form is the default.

### Phase 3: bootstrap in the evaluation loop (S)

`test/eval` gets a scenario that starts from an empty directory and ends at a
stopped session on the Corstone-300 FVP fixture, so the whole chain is measured
(calls, bytes, bypasses) on every release, without hardware.

## Decisions for you

1. **Refusal code for the empty window.** (a, recommended) a new `NO_WORKSPACE`
   error code, distinct from `CMSIS_NO_SOLUTION` (a folder is open but holds no
   solution); (b) one code with two texts.
2. **Which window the bootstrap opens the folder in.** (a, recommended) a new
   window (`code -n`): the empty window stays the router, the new window joins
   as a worker and becomes the default target, the agent's MCP session
   survives; (b) the same window: simpler for the user, but the extension host
   restarts, the server comes back after the reload, and the agent has to
   re-initialize (the 404 path from #14).
3. **Where the skill lives.** (a, recommended) a bundled `cmsis-bootstrap`
   skill in this repo, always installed, listed in `cmsis-help`; (b) a
   `create-csolution` skill contributed upstream to cmsis-skills under
   `project`, then vendored. (a) first, (b) once it has worked for a few boards.
4. **Solution source.** (a, recommended) a minimal template the skill owns,
   with the board's Blinky example offered when the BSP ships one; (b) examples
   only; (c) the wizard, by telling the user to click.
5. **Installing extensions and compilers.** (a, recommended) the skill may run
   `code --install-extension`, but never installs a compiler: it writes
   `vcpkg-configuration.json` and lets the Environment Manager fetch the
   artifact on open; (b) the agent only tells the user what to install.
6. **Track it.** (a, recommended) file an upstream issue "Bootstrap from an
   empty VS Code window: documentation, skill, tool support", Area *Agent
   setup*, Version *Future* for phase 2, and put it on the board; (b) keep it
   in this folder only.

## How to test

- Phase 0: `npm test` (topic parser, guide size pins, surface snapshot updated
  for the new refusal texts and status line), `npm run test:surface`,
  `node test/transport/config-scenarios.js` with the new no-folder scenario.
- Phase 1: the skill test; then by hand on this Mac: quit VS Code, move
  `~/.vcpkg` and the pack root aside, open an empty window, run the skill from
  Claude Code against the STM32H735G-DK (the tester's board) and against the
  Corstone-300 FVP fixture; count the shell commands the agent ran against the
  ones the skill names.
- Phase 2: `dap-scenarios` for `cmsis_query`, the routed `tools/list` budget
  (34 000 B routed, 32 000 single-window, 44 000 all groups).

## Review

- [ ] Accept as proposed
- [ ] Accept with the changes noted below
- [ ] Rework

Notes:
