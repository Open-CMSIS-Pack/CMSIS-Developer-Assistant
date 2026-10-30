# AgentConfigurationManager

## Purpose

Onboards AI coding agents onto the CMSIS Developer Assistant: registers the
MCP server in each agent's own configuration file, installs the `cmsis-help`
Agent Skill into the personal skills directories those agents read, and writes
the tool rules into the agents' rule files the user confirms. Registration
and the rule files are opt-in through one two-step setup flow; the help skill
is installed at activation and again when the agents are configured. Other
CMSIS procedures come from the knowledge index.

## Motivation

For an agent to use the extension it needs things it cannot discover on its
own: the MCP endpoint (in its config file), the entry point to workflow
knowledge (`cmsis-help` and the knowledge tools), and the rule to use the
tools rather than `pyocd`, `gdb` or `cbuild` in a shell (#45, #50). The server
instructions and the help skill carry that rule, but an agent may lose both
when it compacts its context, while its rule file
is loaded in every session. Rather than sending users to edit JSON/TOML,
copy directories and write rule files by hand, the manager does all three —
but only for the agents and files the user picked, because these files live
next to things the extension does not own. The help skill is the exception:
it goes into directories made for skills and carries a marker file. There
is no skill picker; earlier releases offered a selection of installed
procedures, which now live in the knowledge index.

## Responsibility

- Know the supported agents, their config file paths per platform, and the
  MCP entry shape each expects (`supportedAgents()`, `entryFor()` with
  `ENTRY_SHAPES`).
- Merge the server entry into an existing config without disturbing the rest
  of the file (`registerServer()`); migrate entries written by earlier
  versions (`migrateExistingConfigurations()`).
- Drive the first-run setup and its on-demand re-run (`runSetupFlow()`),
  remembering in `globalState` that it was shown.
- Install the one installed skill of the catalog, `cmsis-help`, into the
  personal skills directories and sweep the rest
  (`syncSkills()`), at activation and after the agents step of the setup,
  using the pure helpers in `skillCatalog.ts` (what is visible, what is
  hidden) and `skillInstaller.ts` (how to write it safely).
- Offer the agents' rule files for the tool rules in step 2 of the setup,
  preview and write each change the user confirms, and offer at activation
  to bring the blocks it wrote up to date (`refreshAgentRules()`), using
  `core/agentRules.ts` (which file, what text) and `agentRuleFiles.ts` (the
  step and the refresh, over an injected file system).

## Key Concepts

### Supported agents

Home-directory config files only; the GitHub Copilot *extension* in VS Code
is served by the `McpServerDefinitionProvider` registered in `extension.ts`
and needs no file. The roster: Roo Code, Antigravity, Cline, GitHub Copilot
CLI, Cursor, Codex (TOML), Kimi Code, Claude Code, Claude Desktop (stdio
bridge via `mcp-remote`). Paths under the platform's application-data
directory follow `%APPDATA%`, `~/Library/Application Support` or
`$XDG_CONFIG_HOME`; `CODEX_HOME`, `COPILOT_HOME` and `KIMI_CODE_HOME` move
those three agents' files. Cursor reads `~/.cursor/mcp.json` and Kimi Code
`~/.kimi-code/mcp.json` on every platform. Roo Code, Antigravity and Cline
share one `streamableHttp` entry shape; Copilot CLI, Cursor (`url` only, as
its documentation shows a remote server), Kimi Code, Claude Code and Claude
Desktop have their own (`ENTRY_SHAPES`). Kimi Code's entry is `url` and
`toolTimeoutMs`: without it Kimi ends every tool call after 60 s, while
`cmsis_action` and `flash` may wait 600 s; and nothing else goes in, since
one entry its schema rejects disables every server of the file. Each path
carries the vendor source it was checked against in a code comment.

### Migration of earlier entries

`migrateExistingConfigurations()` visits only agents whose file exists. In
JSON files it moves an entry from the pre-2.1.0 key `cmsis-debugmcp` to
`cmsis-developer-assistant` and replaces an entry that still uses SSE,
another transport or another endpoint by the current shape, keeping its
`autoApprove` list (`migrateServers()`). A Kimi Code entry that is current
but has no `toolTimeoutMs` gets it and keeps everything else, so an entry
written by hand stops failing at 60 s. Next to our entry, any other entry
that reaches this server, a loopback URL on our port at `/mcp` or `/sse`
(or such a URL as an mcp-remote argument), is removed and its `autoApprove`
list merged into ours where the shape has one (`dropDuplicates()`); Configure
Agent does the same when it writes the entry. A hand-written "CMSIS Developer
Assistant" next to ours made Kimi Code list every tool twice, and its model
called the copy without `toolTimeoutMs`. An entry on another port, and a
hand-written entry with no entry of ours beside it, stay. In Codex's TOML it drops the legacy
table and points ours at the current endpoint when that table existed or ours
still uses SSE (`migrateCodexAgent()`, with the text helpers
`stripLegacyCodexSection()` and `upsertCodexDebugMCPConfig()`).

Releases before 2.5.1 wrote Cursor's entry to
`…/Cursor/User/globalStorage/cursor.mcp/settings/mcp_settings.json`, a file
Cursor never reads. `moveCursorEntry()` moves such an entry to
`~/.cursor/mcp.json` first — the only migration that creates a file, because
the user asked for Cursor back then — keeps an entry the user already has
there, and deletes the old file when nothing but our entry was in it.

### Safety rules for config files

Atomic write (temp file + rename, per-process unique temp name —
`src/utils/atomicFile.ts`, for JSON and Codex TOML alike); a file that is a
symbolic link, often one into a dotfiles repository, is written through it
as a plain write would be (the rename replaces the linked file, from a temp
file beside that file, and the link stays; where a plain write would fail,
so does this one); JSON files are
re-read immediately before the write and the update retried when another
process changed the file in between (`src/utils/jsonFileRewrite.ts` —
`~/.claude.json` is rewritten by Claude Code all the time); never recreate an
unparseable file; merge only the `cmsis-developer-assistant` key; per-agent
try/catch so one failure does not abort the rest.

### The skill catalog

The generated skills/catalog.json contains cmsis-help alone. scripts/sync-skills.ts reads the installation config and the help frontmatter, validates its hand-overs against the pinned core index, and copies the canonical tool rules into the help and debugging guide.

Procedure authoring belongs to cmsis-knowledge-base/sources/cda-procedures: eight procedure directories, their assets/references and metadata, and the routing definitions. The extension consumes the released index. Its runtime does not need the knowledge source tree. The knowledge-base rebuild checks procedure/tool compatibility against an extension checkout, while offline builds use its recorded contract.

installSet() selects the installed catalog entries. The installer still understands older vendored/router entries and sweeps obsolete marker-owned skills out of personal directories. Removing the old source entries from today's catalog does not remove that upgrade behavior. See skills/README.md for authoring and synchronization.

### A window without a folder

The extension activates in a VS Code window that has no folder open, and the
setup runs there as anywhere: the server is registered in the agents'
user-level configuration files, so an agent started in any directory finds
it, and `cmsis-help` goes to the personal skills directories; the bootstrap
procedure for exactly this window is a unit of the knowledge index, which
needs no folder either. What depends on a folder is left
out: only the agents' user-level rule files can be offered in step 2; an agent
that reads a workspace file only (Copilot Chat, Cursor, Cline, Roo Code) gets
its rules once a folder is open.

### Install roots and the marker file

`getSkillInstallRoots()` (user): `~/.agents/skills` always; `~/.claude/skills`
when a Claude home exists (`CLAUDE_CONFIG_DIR` is honoured; Claude Code does
not read `~/.agents`);
`$COPILOT_HOME/skills` only when that variable is set. `~/.copilot/skills`,
which earlier releases wrote, is only swept.
Releases 2.5.1 to 2.5.10 could also install a selection into a workspace
folder (`getProjectSkillInstallRoots(folder)`: `<folder>/.agents/skills`,
`<folder>/.claude/skills`); `skillRoots()` now lists those roots of every
open local folder as sweep-only, so a copy a project selection left behind
goes away at the next activation, and nothing is written there. A folder that is the home directory names the personal roots a second time; `withoutInstallRoots()` keeps them off the sweep list, compared by canonical path, or the sync would remove what it had just written. The
installer takes the roots per `sync()` call and creates a root only when
something is to be installed into it. Every directory the installer writes carries
`.cmsis-developer-assistant.json`; only directories with that marker (or the
pre-marker `cmsis-debug-live` whose frontmatter name matches) are ever
replaced or removed. Anything else in those roots belongs to the user or
the project.

### Tool rules in agents' rule files

The rules section of the tool contract (`docs/agent-resources/tool-contract.md`,
read from the extension's `docs/` folder) goes between the
`<!-- cmsis-developer-assistant:rules:begin/end -->` markers of
`markerBlock.ts`, led by one comment line that says the extension manages
the block and how to take it out. Everything outside the block stays as it
was, byte for byte.

*Which file.* `ruleFileTargets()` maps each agent to the file it reads, from
the vendors' documentation (the sources sit next to the map in
`core/agentRules.ts`). Claude Code, Codex, Copilot CLI, Antigravity and Kimi
Code have a user-level file, which is preselected: the MCP registration is per user too,
and a workspace file ends up in the repository for colleagues who may not have
the extension. VS Code Copilot Chat, Cursor, Cline and Roo Code get their
workspace file only. Most agents read the workspace `AGENTS.md`; a file several
agents read is offered and written once. For Kimi Code the rule file is the
only way the rules reach the model: it does not pass the server
instructions on. Cursor, Cline and Roo Code get a file
of their own (`own` form) in their rule folder, which a removal deletes. The
map never picks a file whose creation would hide one the project uses: Claude
Code writes into the project's `CLAUDE.md` only when there is one (a new
`CLAUDE.md` would stop it reading `AGENTS.md`), Roo Code into `.roorules`
while that is the file it reads, Codex into a non-empty `AGENTS.override.md`.

*Which agents.* Step 2 covers the agents picked in step 1, the agents whose
configuration registers the server already, and Copilot Chat; files recorded
earlier are listed too, so that they can be unchecked.

*Consent.* A file that has the rules opens checked. Accepting the picker
plans one change per file (`planRuleChanges()`): create, add, update, or
remove. Each change opens `vscode.diff` between the file as it is — or an
empty document — and the proposed text, served by a content provider for the
`cmsis-developer-assistant-rules` scheme, then a modal dialog; only *Write* or
*Remove* changes the file. The file is read again right before the write,
which is atomic and, through a symbolic link, changes the linked file.

*Records.* `globalState` key `cmsis-developer-assistant.agentRules.files`
lists each file written, whether it was created for the rules and which
directories were made for it. A removal restores the file to its earlier
bytes, or deletes a file (and its empty directories) that was made for the
rules or is the extension's own. At activation `refreshAgentRules()`
finds every recorded block whose text differs from the current contract and
offers, in one toast, to review the update; each file then gets the same
diff and modal *Write* as the setup step. The rule files are the user's —
hand-edited, versioned, sometimes symlinked from a dotfiles repository — so a
release never rewrites them unasked. The toast comes once per version of the
rules (a digest in `globalState`), and not while the setup is due, whose
rules step offers the update itself; a declined update is offered again by
*Configure Agent*. Activation does not wait for the answer. A recorded file
that is gone, or whose block the user deleted, is forgotten, never
recreated. Activation under the extension test runner skips it, like the
skill sync and the migration.

*Setting.* `agentRules.install`: `ask` (default) or `never`, which skips
step 2 and the refresh.

### Popup state

Two `globalState` keys, cleared by *Reset Popup State*:

- `cmsis-developer-assistant.popupShown.v5` — the first-run setup. Accepting
  or dismissing any step marks it shown. The version suffix is bumped when
  the flow changes so existing users see it once more (v4: the tool rules
  step; v5: the skills step gone, the catalog installed with the agents).
- `cmsis-developer-assistant.agentRules.updateOffered` — the SHA-256 of the
  rules whose update activation last offered.

`cmsis-developer-assistant.skillsPrompt.lastShownAt`, the time of the monthly
skills prompt of earlier releases, is cleared by the same command and never
read.

## Key Code Locations

- Class: `src/utils/agentConfigurationManager.ts`
  - agents: `supportedAgents()`, `entryFor()`, `registerServer()`, `migrateExistingConfigurations()` (`migrateServers()`, `migrateCodexAgent()`), `agentConfigHasServer()`, Codex TOML text: `upsertCodexDebugMCPConfig()`, `stripLegacyCodexSection()`
  - setup flow: `shouldShowPopup()`, `runSetupFlow()`, `pickAndConfigureAgents()`, `installForAgents()`, `offerAgentRules()`, `resetPopupState()`
  - rule files: `offerAgentRules()` (picker, `previewRuleChange()`), `refreshAgentRules()`
  - skills: `syncSkills()` / `installCatalog()`, `skillRoots()`
- Atomic and concurrent-safe writes: `src/utils/atomicFile.ts`, `src/utils/jsonFileRewrite.ts`
- Catalog model and the install set: `src/utils/skillCatalog.ts` (`installSet()`: the entries marked `installed`, today `cmsis-help`)
- Copying, hiding, marker-guarded removal: `src/utils/skillInstaller.ts`
- Rule files: `src/core/agentRules.ts` (the agent-to-file map with its vendor sources, the block text, `withRules()` / `withoutRules()`, the records), `src/utils/agentRuleFiles.ts` (`runRuleStep()`, `planRuleChanges()`, `applyRuleChange()`, `refreshRecordedRules()`, the node file system)
- Generator: `scripts/sync-skills.ts` (never fetches; legacy `--offline` is a no-op), hand-authored input `scripts/skills.config.json` and `docs/agent-resources/tool-contract.md`; marker blocks: `src/utils/markerBlock.ts`
- Tests: `src/test/skillCatalog.test.ts` (catalog ↔ disk ↔ lock ↔ help skill, the install set), `src/test/skillInstaller.test.ts` (temp-dir behaviour, the sweep of 2.5.x project roots), `src/test/agentRules.test.ts` (the rule-file map and the step against an in-memory file system), `src/test/atomicFile.test.ts` (the atomic writers: kept permission bits, symbolic links written through), `test/transport/config-scenarios.js` (the files written for each agent per platform, migration, popup state, the setup with its skill install, the rule-file step with its previews, `syncSkills()`, against `config-scenarios.snapshot.json`)

## User Flow

1. Extension activates; `syncSkills('activation')` installs `cmsis-help` into
   the personal skills directories and sweeps the project roots of 2.5.x.
   After the migration, `refreshAgentRules()` offers to bring recorded rule
   blocks up to date.
2. If the setup was never shown (for this version of the flow) and the host
   does not manage MCP itself, after 2 s: step 1 multi-select of agents →
   config files written, then the skills installed again and a toast that
   says how many went where; step 2 (skipped while `agentRules.install` is
   `never`) multi-select of rule files → per file a diff and a dialog → the
   confirmed files written.
3. A later release with another catalog: the next activation installs what
   the catalog marks `installed` and removes the directories this extension
   wrote that are no longer in that set (marker-guarded).

## Commands

- `cmsis-developer-assistant.configure` — *Configure Agent*: the two-step flow, skills installed with the agents
- `cmsis-developer-assistant.resetPopupState` — hidden from the palette; re-arms the first-run flow for testing
