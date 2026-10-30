# #45 pyocd called directly

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** Bundled pyOCD discovery and tool-rule installation shipped; current policy is the [tool contract](../agent-resources/tool-contract.md). The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#45](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/45) |
| Area · priority · source | Skills & agent rules · High (proposed) · Internal test (christophe0606) |
| Original release plan | 2.3.12 closes it (WP-L); 2.3.11 ships the instructions (WP-D) and the flash fix (WP-B) |
| Size | S (the work is counted in #50 and in the #46/#47 work package) |
| Depends on | #50 (the contract and the rule-file step), #46/#47 work package (flash resolves the bundled pyOCD) |
| Related | #50 (parent), #46, #47, #19, cmsis-skills PR #18 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

Agents call `pyocd` or `gdb` directly and even install pyOCD from PyPI. The reporter stopped it with four lines in the workspace `AGENTS.md` and observes that skill text is lost on context compaction while `AGENTS.md` survives; they ask that the extension add a few mandatory rules to `AGENTS.md` at install. Verified against 2.3.10: no shipped text forbids calling pyOCD or GDB, three places recommend the shell route, and `flash` itself only finds pyOCD on PATH and tells the agent to `pip install` it. The full design lives in [50-tool-contract.md](50-tool-contract.md); this file maps #45 onto it.

## Current state (2.3.10)

- No rule: the MCP `instructions` ([debugMCPServer.ts:288-297](../../src/debugMCPServer.ts#L288-L297)) and [skills/cmsis-debug-live/SKILL.md](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/SKILL.md) say nothing about running pyOCD or GDB in a shell.
- Text that pushes the agent to the shell:
  - [debuggingHandler.ts:1926-1930](../../src/debuggingHandler.ts#L1926-L1930), the `flash` failure: "pyocd not found on PATH. Install it (pip install pyocd / pipx install pyocd), or use cmsis_action load …".
  - [debugMCPServer.ts:949-953](../../src/debugMCPServer.ts#L949-L953), the `flash` description: "needs pyocd on PATH".
  - [debug_instructions.md:112](../../docs/agent-resources/debug_instructions.md#L112): "needs `pyocd` on the PATH".
  - Both copies of `troubleshooting/embedded.md`, lines 17-18 ([skill](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/references/troubleshooting/embedded.md#L17-L18), [MCP resource](../../docs/agent-resources/troubleshooting/embedded.md#L17-L18)): "installed and on PATH", "`pyocd list` or `JLinkExe`".
- `flash` resolves pyOCD by spawning `pyocd --version` from PATH only ([flashController.ts:77-104](../../src/core/flashController.ts#L77-L104)), although the CMSIS Debugger ships it: `~/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-darwin-arm64/tools/pyocd/pyocd` exists on the maintainer's Mac.
- The vendored [check-pyocd-availability/SKILL.md:38](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-skills/check-pyocd-availability/SKILL.md#L38) already says "Do not install pyOCD" and prefers the bundled `tools/pyocd/`, but it is an opt-in pack skill.
- Nothing writes `AGENTS.md` or any other rule file; [docs/improvement-notes.md:145-148](../../docs/improvement-notes.md#L145-L148) left such a line as "the project's call".

## Proposed fix

How each of the reporter's `AGENTS.md` lines is covered by the #50 contract:

| Reporter's line | Contract rule (#50) | Also needs |
|---|---|---|
| "NEVER install pyOCD. Use the one from the CMSIS vscode extension." | "… never install pyOCD." | `flash` finds the bundled pyOCD, so the agent is never told to install it |
| "Use the CMSIS developer assistant MCP server to interact with the board." | "Talk to the board only through the cmsis-developer-assistant MCP tools." | none |
| "Don't try to use pyOCD or gdb directly to interact with the board." | "Never run pyocd, gdb, JLinkExe, JLinkGDBServer or openocd against the board from a shell …" | shell-to-tool table (`pyocd load` → `flash`, `gdb -ex` → `read_memory` …) |
| "If the MCP server is returning errors and retrying is not solving the issue, tell the user that an action is required in vscode." | "If a tool fails twice, call get_session_status, then stop and tell the user what to do in VS Code. Do not work around a failing tool with a shell command." | #11 error codes and hints; #48 `get_recent_problems` in 2.3.12 |

Delivery in three steps:

1. **2.3.11, WP-D (#50 part 1).** The rules lead the MCP `instructions`, which most clients keep in the system prompt for the whole session. They also sit at the top of `cmsis-debug-live`, `cmsis-help` and the `get_debug_instructions` overview. The first `get_session_status` of a session carries a one-line reminder. The contradicting lines above are rewritten (exact text in #50, part 1, item 6).
2. **2.3.11, WP-B (the #46/#47 work package), the flash half.**
   - `flash` looks up `vscode.extensions.getExtension('Arm.vscode-cmsis-debugger')` and uses `<extensionPath>/tools/pyocd/pyocd` (`pyocd.exe` on Windows) first, then PATH. The extension path is passed into `flashController.ts`; `probePyocd` takes the resolved executable.
   - The failure text drops "pip install": "No pyOCD found (neither the CMSIS Debugger's bundled one nor on PATH). Use cmsis_action load, which flashes through the CMSIS Solution extension; do not install pyOCD."
   - The `flash` description changes from "needs pyocd on PATH" to "uses the CMSIS Debugger's pyOCD": about +12 B in `tools/list`.
3. **2.3.12, WP-L (#50 part 2), the reporter's actual ask.** *Configure Agents and Skills* gets a third step that writes the rules, between `<!-- cmsis-developer-assistant:rules:begin -->` / `:end -->` markers, into `AGENTS.md` (and `CLAUDE.md`, `.github/copilot-instructions.md`, … per selected agent), after a diff preview. The step runs in the first-run setup, so for a new install it is effectively "at install", but with consent. The bypass evals (a shell `pyocd` or `pip install` fails the scenario) confirm it. **#45 closes with 2.3.12.**

A direct answer for christophe0606 once 2.3.11 is out: please re-test with your `AGENTS.md` lines removed. If the `instructions` alone hold, that is useful data for the rule-file default in 2.3.12.

## What changes for the agent and the user

```text
2.3.10  flash (no pyocd on PATH): "pyocd not found on PATH. Install it (pip install pyocd / pipx install pyocd) ..."
        -> agent runs pip install pyocd, then pyocd load in the shell

2.3.11  initialize.instructions start with the tool rules ("never install pyOCD", "talk to the board only through ...")
        flash: uses <CMSIS Debugger>/tools/pyocd/pyocd; if even that is missing:
        "No pyOCD found ... Use cmsis_action load ...; do not install pyOCD."

2.3.12  Configure Agents and Skills, step 3/3 writes the same rules into AGENTS.md between markers (asked, previewed)
```

## Decisions for you

- [ ] **"Mandatory at install" or asked?** **Recommended:** asked, in the first-run setup with a diff preview, default on for new installs through `agentRules.install: "ask"`. Workspace files belong to the user and are often committed, so writing them silently is not acceptable. Alternative: write silently at activation; that is closest to the literal request but surprises users and teams.
- [ ] **When does #45 close?** **Recommended:** with 2.3.12, when the rule file (the reporter's ask) exists and the evals pass. Alternative: close with 2.3.11 if the reporter's re-test without their `AGENTS.md` shows the `instructions` suffice, and track the rule files only under #50.
- [ ] **Order of the flash lookup.** **Recommended:** the bundled pyOCD first, then PATH. The bundled one matches the CMSIS Debugger that runs the debug session, the same order check-pyocd-availability uses. Alternative: PATH first, which keeps a user's own newer pyOCD but can mix versions between `flash` and the debug session.

## Tests and acceptance

- Resolver unit tests (in the #46/#47 work package): bundled path on macOS and Linux, `pyocd.exe` on Windows, the CMSIS Debugger extension missing, a bundled path that is not executable, then the PATH fallback.
- The #50 drift and grep checks: no `pip install pyocd`, `pyocd list` or "pyocd on PATH" in shipped text.
- Live, 2.3.11: `flash` succeeds with nothing on PATH (plan verification list).
- 2.3.12: an eval scenario whose deny list contains `pyocd` and `pip install` passes with Copilot CLI, with and without the rule block in `AGENTS.md`.
- Closing comment on #45 links the 2.3.11 and 2.3.12 releases and the #50 sub-issues.

## Out of scope and follow-ups

- christophe0606 also authored cmsis-skills PR #18 (a command-line `cmsis-toolbox` skill). The suggested "prefer `cmsis_action build` when the MCP tools are available" paragraph (see #50, follow-ups) keeps that skill and this rule consistent.
- Detecting a foreign pyOCD process that holds the probe is #50 part 3 (Future).
- Board hygiene: make #45 a sub-issue of #50 and move it from Triage to Backlog (plan, board hygiene).

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
