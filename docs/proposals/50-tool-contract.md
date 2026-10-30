# #50 Stricter rules against bypassing the MCP tools (pyocd / gdb / cbuild / curl in the shell): a tool contract that survives compaction, plus detection and evals

> **2.7.0 status (2026-10-27).** Parts 1–2 are implemented. The [current contract](../agent-resources/tool-contract.md) scopes the bans to covered targets; process detection and the hook pack remain proposals. The old skill/router distribution steps below are historical. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#50](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/50) |
| Area · priority · source | Skills & agent rules · High (proposed) · Maintainer |
| Original release plan | Split: part 1 in 2.3.11 (WP-D), part 2 in 2.3.12 (WP-L), part 3 Future |
| Size | XL overall (part 1 M, part 2 M, part 3 L) |
| Depends on | #11 (error codes and hints for the failure rule); part 2 on #48 for `get_recent_problems` |
| Related | #45, #47, #19, #20, #12, #15, #3, #48, #49, cmsis-skills PR #18 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

Agents reach the board, the build and the documents through the shell instead of the MCP tools: `pyocd`, `arm-none-eabi-gdb`, `pip install pyocd` (#45), `cbuild` (#47), `curl` against the control server with the registry token (#19), PDFs read into context, `nm`/`size` over the ELF, `screen` on the tty. Every one of these costs tokens, fights the running GDB server for the probe, and is invisible to the session state. Verified against 2.3.10: nothing in the MCP `instructions`, the skills or the guide says "do not run pyocd, gdb or cbuild yourself"; several shipped texts even point the other way (`pyocd list`, "pyocd on the PATH", "pip install pyocd"). The issue's diagnosis stands: rules only hold once the tools stop failing the agent, so this proposal is the rule half and names the tool-gap issues it depends on.

## Current state (2.3.10)

- MCP `instructions` ([debugMCPServer.ts:288-297](../../src/debugMCPServer.ts#L288-L297), plus [packDocsInstructions() :316-341](../../src/debugMCPServer.ts#L316-L341)) route to the `cmsis-debug-live` skill and describe `timeoutMs`; nothing about the shell. About 1.08 kB with the default settings. Tests pin the prose by regex on the raw source: [debugSkillGuidance.test.ts:57-72](../../src/test/debugSkillGuidance.test.ts#L57-L72), including "Invoke the "cmsis-debug-live" skill first." at [debugMCPServer.ts:380](../../src/debugMCPServer.ts#L380).
- The build-artefact tools get no sentence at all when `buildInfo.enabled` is off ([debugMCPServer.ts:336-339](../../src/debugMCPServer.ts#L336-L339) has no `else`), so a default install never learns they exist.
- Text that invites the bypass:
  - [skills/cmsis-debug-live/references/troubleshooting/embedded.md:17-18](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/references/troubleshooting/embedded.md#L17-L18) and its byte-identical MCP-resource copy [docs/agent-resources/troubleshooting/embedded.md:17-18](../../docs/agent-resources/troubleshooting/embedded.md#L17-L18): GDB server "installed and on PATH", "`pyocd list` or `JLinkExe`".
  - [debug_instructions.md:112](../../docs/agent-resources/debug_instructions.md#L112): `flash` "needs `pyocd` on the PATH"; the `flash` description says the same ([debugMCPServer.ts:949-953](../../src/debugMCPServer.ts#L949-L953)).
  - [debuggingHandler.ts:1926-1930](../../src/debuggingHandler.ts#L1926-L1930): the flash failure text says "pip install pyocd / pipx install pyocd".
  - Our own bundled `add-board-layer` skill tells the agent to run `cbuild … --packs --update-rte` in a shell ([SKILL.md:134](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/add-board-layer/SKILL.md#L134), [:226](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/add-board-layer/SKILL.md#L226)).
- Text that already agrees: the vendored [check-pyocd-availability/SKILL.md:38](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-skills/check-pyocd-availability/SKILL.md#L38) forbids installing pyOCD and prefers the CMSIS Debugger's bundled `tools/pyocd/`. [docs/improvement-notes.md:145-148](../../docs/improvement-notes.md#L145-L148) left an `AGENTS.md` line as "the project's call".
- Vendored skills that legitimately run toolbox or pyOCD commands (opt-in via `installedSkills`): `check-cmsis-environment` (`cbuild list toolchains`), `start-zephyr-project` (`cbuild setup`, `cbuild`), `pyocd-detect-debug-topology` (`pyocd gdbserver -vv`). The contract must not make them unusable.
- Packaging: `.vscodeignore` drops `docs/**` except `docs/agent-resources/**` ([.vscodeignore:58-59](../../.vscodeignore#L58-L59)); runtime Markdown is read from `docs/` next to `dist/` ([debugMCPServer.ts:1124-1134](../../src/debugMCPServer.ts#L1124-L1134)). A contract read at runtime belongs in `docs/agent-resources/`.
- Generation pattern to copy: `cmsis-help` is rendered by the pure [renderHelpSkillMarkdown (skillHelp.ts:121-238)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/src/utils/skillHelp.ts#L121-L238) from `skills/catalog.json`, `package.json` and the `help` block of [scripts/skills.config.json:22-80](../../scripts/skills.config.json#L22-L80); written by [sync-skills.ts:435-444](../../scripts/sync-skills.ts#L435-L444), which always git-fetches the pinned upstream SHA first ([:286](../../scripts/sync-skills.ts#L286)), so regenerating needs the network. [skillCatalog.test.ts:218-222](../../src/test/skillCatalog.test.ts#L218-L222) byte-compares the shipped file.
- Agent configuration: *Configure Agents and Skills* ([runSetupFlow, agentConfigurationManager.ts:264-280](../../src/utils/agentConfigurationManager.ts#L264-L280)) has two steps, agents and skills. Eight agents ([:343-411](../../src/utils/agentConfigurationManager.ts#L343-L411)); VS Code Copilot Chat comes through the `mcpServerDefinitionProviders` contribution. Nothing writes `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules` or `.clinerules`. The Cursor entry writes `…/Cursor/User/globalStorage/cursor.mcp/settings/mcp_settings.json` ([:384](../../src/utils/agentConfigurationManager.ts#L384)); Cursor documents `~/.cursor/mcp.json`, so this path is probably wrong (verification item).
- Building blocks: the idempotent TOML section upsert [upsertCodexDebugMCPConfig / stripLegacyCodexSection (:80-125)](../../src/utils/agentConfigurationManager.ts#L80-L125) (normalises CRLF to LF, so it is a model, not a drop-in), [writeFileAtomic (atomicFile.ts:49-58)](../../src/utils/atomicFile.ts#L49-L58), [rewriteJsonFile (jsonFileRewrite.ts:31-54)](../../src/utils/jsonFileRewrite.ts#L31-L54) with its re-read-before-write loop, HTML-comment markers parsed in [instructionTopics.ts:42-63](../../src/core/instructionTopics.ts#L42-L63), user and project skill roots in [skillInstaller.ts:83-134](../../src/utils/skillInstaller.ts#L83-L134) (`CLAUDE_CONFIG_DIR`, `COPILOT_HOME`).
- Evals: [aggregateEvents (evalScenario.ts:99-139)](../../src/core/evalScenario.ts#L99-L139) records every `tool.execution_start`, shell calls included; the verdict has one `forbidden.toolArgs` regex matched on name and JSON arguments ([:184-188](../../src/core/evalScenario.ts#L184-L188)), which would flag MCP arguments such as `…cbuild-run.yml`. Runs use `--allow-all-tools --no-custom-instructions` ([copilotCli.ts:69-81](../../scripts/lib/copilotCli.ts#L69-L81)), so a workspace `AGENTS.md` is ignored. No recorded run exists yet (all five reports in `test/eval/reports/` are infra errors). Copilot CLI is not installed on the maintainer's Mac.
- Budget: [session-lifecycle.js:149](../../test/transport/session-lifecycle.js#L149) allows 30 000 B for `tools/list`. Measured on the 2.3.10 build: 28 799 B single-window (45 tools), 40 527 B with every group on (limit 42 000). The routed list is larger (plan: ≈29.4 kB). `instructions` are not in `tools/list`, but clients keep them in the system prompt, so they are also a per-turn (cached) cost.

## Proposed fix

One source file, generated into every copy, a test per copy. Split as the plan does.

### Part 1, 2.3.11 (WP-D): the contract where agents look

1. **New file `docs/agent-resources/tool-contract.md`** with two sections: the rules (at most ten lines, imperative, no rationale) and the shell-to-tool table. Draft rules, 1 489 bytes:

   ```markdown
   ## CMSIS Developer Assistant tool rules

   Only the user can lift a rule, by asking for the specific command.

   - Talk to the board only through the cmsis-developer-assistant MCP tools. Never run pyocd, gdb, JLinkExe, JLinkGDBServer or openocd against the board from a shell, and never install pyOCD.
   - Build, load, erase, run and debug with cmsis_action; program with flash. Run cbuild, csolution or cpackget in a shell only when the user asks for it or a CMSIS skill step names the command.
   - Serial I/O only through the serial_* tools, not screen, cat /dev/tty* or a serial script.
   - Manuals, datasheets and register meanings through the documentation tools; use the web only to find a PDF URL for fetch_doc, and never read a PDF into your context.
   - Symbol, section, memory-usage and build-log questions through the build-artefact tools, not nm, size or a grep over the map file.
   - If a tool you need is not in your tool list, name the setting that enables it (cmsis-developer-assistant.packDocs.enabled or cmsis-developer-assistant.buildInfo.enabled) instead of substituting a shell command.
   - The control server and the registry files are internal: never call or read them. With several VS Code windows open, use list_debug_windows and select_debug_window.
   - A running target rejects reads and steps: call pause_execution first.
   - If a tool fails twice, call get_session_status, then stop and tell the user what to do in VS Code. Do not work around a failing tool with a shell command.
   ```

   Changes against the issue draft, and why:
   - "against the board" and the explicit precedence line keep `pyocd --version` (check-pyocd-availability) and a user-authorised `pyocd gdbserver` scan (pyocd-detect-debug-topology) possible.
   - `objdump` is dropped from the build-artefact line: no tool disassembles, and the #51 optimisation flow needs `llvm-objdump -d`.
   - "a CMSIS skill step names the command" covers `check-cmsis-environment` and `start-zephyr-project`.
   - The running-target line is #20's "promote to a rule"; the control-server line is #19's doc line.
2. **Shell-to-tool table** (second section of the same file):

   | Instead of | Use |
   |---|---|
   | `pyocd load`, `pyocd flash` | `flash`, or `cmsis_action load` |
   | `pyocd reset`, `monitor reset` | `reset` (verified) |
   | `pyocd gdbserver`, `arm-none-eabi-gdb`, `JLinkGDBServer` | `cmsis_action load_and_debug` or `attach` |
   | `pyocd commander`, `gdb -ex "x/…"` | `read_memory`, `read_core_registers`, `evaluate_expression` |
   | `pyocd list`, `JLinkExe` to check the probe | `check_target_connection`, `get_session_status` |
   | `pip install pyocd` | nothing to install: `flash` uses the CMSIS Debugger's pyOCD (#46/#47 work package) |
   | `cbuild …` | `cmsis_action build` |
   | `arm-none-eabi-nm`, `readelf -s` | `lookup_symbol` |
   | `arm-none-eabi-size`, grep over the `.map` | `get_memory_usage`, `get_section_layout` |
   | grep over the build log | `get_build_diagnostics` |
   | `screen /dev/tty…`, `cat /dev/tty…`, a pyserial script | `serial_open`, `serial_read`, `serial_write` |
   | `curl localhost:<port>` with the registry token | `list_debug_windows`, `select_debug_window` |
   | reading a PDF, a web search for a register | `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs`, `lookup_register` |

3. **`instructions` lead with the rules.** A pure `buildServerInstructions(rules, options)` in a new `src/core/serverInstructions.ts` returns rules + the current text + `packDocsInstructions()`. `DebugMCPServer` reads the rules section once at start (synchronous read of a 1.5 kB file from the same two candidate paths as `loadMarkdownFile`, cached); a missing file logs a warning and serves the old text. Cost: +1 489 B per session in `initialize`, about 370 tokens in every turn's (cached) system prompt. Nothing in `tools/list`.
4. **Generated copies, one marker pair everywhere**: `<!-- cmsis-developer-assistant:rules:begin -->` … `<!-- cmsis-developer-assistant:rules:end -->`, written by a new pure `src/utils/markerBlock.ts` (`upsertBlock`, `removeBlock`, `extractBlock`; idempotent, preserves the file's line endings, never touches text outside the markers). It moves here from WP-L because part 1 already needs it.
   - `skills/cmsis-debug-live/SKILL.md`: rules and table right after the H1.
   - `skills/cmsis-pack-docs/SKILL.md`, `skills/add-board-layer/SKILL.md`: rules only (see Decisions).
   - `docs/agent-resources/debug_instructions.md`: rules after the H1, so `sliceTopic` puts them first in the overview that a topic-less `get_debug_instructions` returns and in the `debug_instructions` resource; the table inside the `build` topic. No runtime change to the tool.
   - `skills/cmsis-help/SKILL.md`: `renderHelpSkillMarkdown` gains a `contract` argument and renders a "Rules" section first and the table after "MCP tools".
5. **Regeneration without the network**: `npm run skills:sync -- --offline` re-renders `cmsis-help` and the routers from the committed `skills/catalog.json` and upserts the blocks above; no `fetchUpstream`, lock untouched.
6. **Remove the contradictions**:
   - Both `embedded.md` copies, lines 17-18, become: "The GDB server comes from the CMSIS Debugger extension; `cmsis_action load_and_debug` starts it." and "Check the probe with `check_target_connection` (or `get_session_status`); do not run `pyocd list` or `JLinkExe` yourself."
   - `debug_instructions.md:112`: "needs `pyocd` on the PATH" becomes "uses the pyOCD bundled with the CMSIS Debugger, else the one on PATH; if neither exists, use `cmsis_action load`". The code change and the `flash` description are WP-B (the #46/#47 work package).
   - `add-board-layer` §4a step 2 and §6: build with `cmsis_action build { target }`, which runs the `cmsis-csolution.build` command ([debuggingHandler.ts:2073](../../src/debuggingHandler.ts#L2073)) with the extension's bundled toolbox, which §6 needs for `mlops:` nodes. The CMSIS Solution 1.70.1 task definition defaults `downloadPacks` and `updateRte` to true; verify that the command uses those defaults, since they replace `--packs --update-rte`. Keep the `cbuild` line as "only when the user builds from a terminal".
7. **Reminder in a result**: the first `get_session_status` of each MCP session appends one line, "Tool rules: board, build, serial and documentation work goes through these tools, not the shell (see the server instructions)." A closure flag in the registration ([debugMCPServer.ts:967-977](../../src/debugMCPServer.ts#L967-L977)); `createMcpServer` runs per session, so the router window holds it and no worker changes. About 115 B once per session.
8. **No "use instead of" in tool descriptions in 2.3.11** (see Decisions): `tools/list` rides on every turn and WP-A/B/C already spend the headroom.

### Part 2, 2.3.12 (WP-L): rule files and bypass evals

1. **Setup step 3**, "Add the tool rules to your agents' rule files", in *Configure Agents and Skills*, after the skills step; `POPUP_SHOWN_KEY` goes to v4 ([agentConfigurationManager.ts:190](../../src/utils/agentConfigurationManager.ts#L190)) so the first-run flow re-appears once. For each selected agent it proposes one file, shows a `vscode.diff` preview and writes only after confirmation. Files that several agents share (`AGENTS.md`) are written once. Deselecting an agent, or choosing "Remove", calls `removeBlock`. The written paths are kept in `globalState`; on activation a recorded block whose content differs from the current contract is updated in place (logged), never created.
2. **Setting** `cmsis-developer-assistant.agentRules.install`: `"ask"` (default) | `"never"`, scope `application`, like `aiSkills.enabled`.
3. **Agent-to-file map** (block content = rules section only, plus a provenance comment "Managed by the CMSIS Developer Assistant extension; edits between these markers are replaced"):

   | Agent | Workspace file | User-level file | Form |
   |---|---|---|---|
   | Codex | `AGENTS.md` | `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md`) | marker block |
   | GitHub Copilot CLI | `AGENTS.md` | `$COPILOT_HOME/copilot-instructions.md` (verify) | marker block |
   | VS Code Copilot Chat | `.github/copilot-instructions.md` (or `AGENTS.md`, verify the setting) | a user `*.instructions.md` (verify) | marker block |
   | Claude Code | `CLAUDE.md` | `$CLAUDE_CONFIG_DIR/CLAUDE.md` (`~/.claude/CLAUDE.md`) | marker block |
   | Cursor | `.cursor/rules/cmsis-developer-assistant.mdc` with `alwaysApply: true` (verify) | none (User Rules are a setting) | own file |
   | Cline | `.clinerules/cmsis-developer-assistant.md` | `~/Documents/Cline/Rules/` (verify) | own file |
   | Roo Code | `.roo/rules/cmsis-developer-assistant.md` | `~/.roo/rules/` (verify) | own file |
   | Antigravity | verify (`AGENTS.md` or `GEMINI.md`) | verify | marker block |
   | Claude Desktop | none; relies on `instructions` | none | none |

   Verification before coding: which agents read `AGENTS.md` natively (then one file covers them), each user-level path, the Cursor `.mdc` frontmatter, and the Cursor MCP config path (`~/.cursor/mcp.json` vs the `globalStorage` path we write today).
4. **Contract update**: the failure rule becomes "call get_session_status and get_recent_problems" when #48 (WP-H) ships; the serial rule names `serial_capture` when #49 (WP-K) ships. The drift test forces every copy to follow.
5. **Eval runner**:
   - `ScenarioSpec.forbidden.shell` (regex) is matched only against shell-tool events; `toolArgs` stays for MCP tools. The shell tool names come from a recorded Copilot CLI run (`bash`, `powershell` expected; verify).
   - A default deny list applies to every scenario unless it opts out: `\b(pyocd|arm-none-eabi-gdb|gdb-multiarch|JLink(Exe|GDBServer\w*)|openocd|cbuild|cpackget|pip3? install)\b|curl\s+\S*(localhost|127\.0\.0\.1)`.
   - The report adds `bypasses` per run and a bypass rate per scenario, next to tool calls and tokens.
   - `copilotBatchArgs` gains `{ customInstructions: true }`, which drops `--no-custom-instructions`; the runner then writes the rules block into the work copy's `AGENTS.md` with the same `markerBlock` code as step 3.
   - One new scenario makes a tool fail on purpose and passes only when the agent stops and reports instead of shelling out. Preferred mechanism: a fixture overlay, for example a cbuild-run file whose image is missing so `flash` fails, rather than a test hook in production code.
   - A forced compaction mid-run is added only if Copilot CLI supports it in `-p` mode (verify).
6. **Close #45; split #50** into sub-issues: contract (part 1), rule files and evals (part 2), detection and hook pack (part 3).

### Part 3, Future

- **Detection**: a foreign `pyocd`, `gdb` or `JLinkGDBServer` process that holds the probe while our session is active becomes a #48 journal record with a hint naming the tool; a control request that does not come from a router is refused (#19 makes the token router-only).
- **Hook pack** (opt-in, for harnesses with pre-tool hooks such as Claude Code and Codex): flags shell commands that match the deny list while the MCP server is registered and replies with the table row. Home: Open-CMSIS-Pack/cmsis-skills (see Decisions).
- **Eval adapters** for Claude Code (`claude -p --output-format stream-json`) and Codex (`codex exec --json`), so the #50 acceptance "Copilot, Claude Code and Codex" can be measured.

### Gaps that make the bypass attractive (tracked elsewhere)

| Gap | Issue | Release |
|---|---|---|
| Errors returned as success text | #11 | 2.3.11 (WP-A) |
| 60 s cap on builds, no job status | #12 | 2.3.11 (WP-B) |
| Task completion misdetected, parallel Run holds the probe | #47, #46 | 2.3.11 (WP-B) |
| `flash` looks for pyOCD on PATH only, says "pip install" | #45 (flash half) | 2.3.11 (WP-B) |
| Build error lines not returned | #15 | 2.3.12 (WP-H) |
| No single place for errors | #48 | 2.3.12 (WP-H) |
| Serial port held forever | #49 | 2.3.12 (WP-K) |
| Wedged probe needs a reconnect | #3 | Future (WP-N) |

## What changes for the agent and the user

```text
2.3.10  initialize.instructions: "These tools drive a live Arm Cortex-M debug session ... invoke the
        "cmsis-debug-live" Agent Skill first ..."
        flash without pyocd on PATH: "pyocd not found on PATH. Install it (pip install pyocd / pipx install pyocd) ..."
        troubleshooting: "Check that the debug probe is connected and detected (`pyocd list` or `JLinkExe`)"

2.3.11  initialize.instructions: "## CMSIS Developer Assistant tool rules / Only the user can lift a rule ... /
        - Talk to the board only through the cmsis-developer-assistant MCP tools. Never run pyocd ... / ... /
        These tools drive a live Arm Cortex-M debug session ..."
        first get_session_status: "... state: stopped ...
        Tool rules: board, build, serial and documentation work goes through these tools, not the shell (see the server instructions)."
        get_debug_instructions (no topic), cmsis-debug-live, cmsis-help: the same rules first; the table in the skill and the build topic

2.3.12  Configure Agents and Skills, step 3/3: "Add the tool rules to: [x] ~/.claude/CLAUDE.md  [x] AGENTS.md (this workspace) ..."
        -> diff preview -> <!-- cmsis-developer-assistant:rules:begin --> ... <!-- cmsis-developer-assistant:rules:end -->
        failure rule: "If a tool fails twice, call get_session_status and get_recent_problems, then stop ..."
```

## Decisions for you

- [ ] **How strict on `cbuild`?** **Recommended:** shell builds only when the user asks or a CMSIS skill step names the command, as drafted. The vendored `check-cmsis-environment` and `start-zephyr-project` skills and cmsis-skills PR #18 (christophe0606, a command-line `cbuild` skill) keep working, and the default path stays `cmsis_action build`. Alternatives: an absolute ban breaks those skills; no rule leaves #47's bypass in place.
- [ ] **Rule-file default: workspace or user level?** **Recommended:** offer both, with the user-level file preselected where the agent has one (Claude Code, Codex, Copilot CLI). The MCP server registration is user-level too, so the rules follow it and do not end up committed into team repositories for colleagues who do not have the extension. The workspace file stays the only choice for Copilot Chat, Cursor, Cline and Roo. Alternative: workspace default, which is what #45's reporter did; it is visible in reviews but reaches teammates too.
- [ ] **Where does the hook pack live?** **Recommended:** Open-CMSIS-Pack/cmsis-skills, opt-in, documented from `cmsis-help`. It polices the user's own shell, so it should not be part of the default extension install. Alternative: this extension installs it in setup step 3; that is simpler for users but ships behaviour-changing hooks from a debug extension.
- [ ] **Which bundled skills get the rules block?** **Recommended:** all three hand-written bundled skills plus the generated `cmsis-help`. The table goes only into `cmsis-debug-live` and `cmsis-help`, and `add-board-layer` switches its builds to `cmsis_action build`. A skill body loads only when the skill is invoked, so the cost (about 1.5 kB) is paid where the rules matter; `add-board-layer` is exactly where `cbuild` runs today. Alternative (the plan): `cmsis-debug-live` and `cmsis-help` only; this leaves the `add-board-layer` contradiction in place.
- [ ] **"Use instead of …" in tool descriptions?** **Recommended:** not in 2.3.11. The table and `instructions` carry the mapping at no per-turn `tools/list` cost; revisit after WP-G frees budget. Alternative: add it to `flash` and `cmsis_action` only (about 70 B).
- [ ] **Eval coverage in 2.3.12.** **Recommended:** Copilot CLI only, run on a machine that has it; the Claude Code and Codex adapters go to Future. Alternative: all three now, which roughly doubles WP-L.

## Tests and acceptance

- New `src/test/toolContract.test.ts`:
  - the rules section has at most ten non-empty lines after its heading and stays under 1 600 bytes;
  - every tool name in the rules and the table is registered: snake_case tokens are checked against `registeredTools()` from [skill.test.ts:41-86](../../src/test/skill.test.ts#L41-L86), with `serial_*` as a prefix;
  - each generated block (three bundled skills, `debug_instructions.md`) equals `renderContractBlock(…)`, byte for byte;
  - `buildServerInstructions()` output starts with the rules;
  - the overview from `sliceTopic(debug_instructions)` carries the rules block right after the H1, before the CRITICAL INSTRUCTIONS list.
- `debugSkillGuidance.test.ts` calls `buildServerInstructions()` instead of grepping `debugMCPServer.ts`; the existing phrase pins stay.
- `skillCatalog.test.ts` keeps byte-comparing `cmsis-help`, which now contains the rules and the table.
- `markerBlock.test.ts`: missing file, empty file, file without a block, older block replaced, CRLF file stays CRLF, text outside the markers unchanged, `removeBlock` leaves no blank-line residue, and a second upsert is a no-op.
- `session-lifecycle.js`: the `initialize` result's `instructions` start with "## CMSIS Developer Assistant tool rules"; the first `get_session_status` carries the reminder and the second does not; `tools/list` bytes are unchanged by part 1.
- Part 2: `agentRules` unit tests with a fake file system (preview declined writes nothing; a shared `AGENTS.md` is written once; removal); `evalScenario.test.ts` for `forbidden.shell` (a shell `pyocd load` fails the run; an MCP `flash` call whose arguments contain `cbuild-run.yml` passes).
- Acceptance, 2.3.11: grep of shipped text finds no `pip install pyocd`, `pyocd list` or "on PATH" advice; `npm run skills:sync -- --offline` works without network; the drift tests pass.
- Acceptance, 2.3.12: the setup step inserts and removes the block cleanly in a real workspace; the bypass scenarios pass with Copilot CLI with and without the rule file; the bypass rate and tokens are recorded in `test/acceptance-ai-efficiency.md`.

## Out of scope and follow-ups

- Comment on cmsis-skills PR #18 with a suggested paragraph: "When the CMSIS Developer Assistant MCP tools are available (`cmsis_action` in your tool list), build with `cmsis_action build`: it uses the environment the CMSIS Solution extension resolved and the extension sees the result. Use `cbuild` in a shell for CI, scripts, or when the user asks."
- Upstream issue on cmsis-skills: `pyocd-detect-debug-topology` should ask the user before the scan and check that no debug session or CMSIS Run task holds the probe (`get_session_status`, `cmsis_action` `status` from #12).
- Zephyr flows (`west flash`, `west debug`) drive the probe through the same tools; decide once the Zephyr path goes through `cmsis_action`.
- The cap each client puts on server `instructions` is unknown (verify for Claude Code, Codex, Copilot Chat and Copilot CLI). Leading with the rules is what makes a truncating client keep them.
- Rule-file removal on extension uninstall (`vscode:uninstall` has no VS Code API) is not attempted; the block says how to remove it.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
