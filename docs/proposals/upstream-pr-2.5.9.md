# Prepared PR text for 2.5.9

> **Historical draft.** This is the prepared release/PR text for 2.5.9, retained as evidence of its intended scope. Its checklists, UI labels and issue references are not current 2.7.0 instructions or proof of remote issue closure. See the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md) for current follow-up choices.

## Fixes

Fixes #11
Fixes #12
Fixes #13
Fixes #14
Fixes #15
Fixes #16
Fixes #19
Fixes #20
Fixes #45
Fixes #46
Fixes #47
Fixes #49
Fixes #53
Fixes #56

Partly, and left open: #3 (phase 1: a wedged probe is named `PROBE_WEDGED` with the way to reconnect), #48 (phases 1–2: the problem journal and `get_recent_problems`), #50 (parts 1–2: the tool rules, and the agents' rule files).

Not touched: #17, #41, #44, #51, #52. #54 (license review) and #55 (review of the Python and C/C++ guides) stay open on purpose, see below.

## Changes

78 commits on `main`, versions **2.5.0 to 2.5.9** — please cut as a **pre-release** (odd minor). Same content as [v2.5.9 on the fork](https://github.com/MatthiasHertelArm/CMSIS-Developer-Assistant/releases/tag/v2.5.9) with CI-built VSIX; the detail per version is in [CHANGELOG.md](https://github.com/MatthiasHertelArm/CMSIS-Developer-Assistant/blob/pr/2.5.9-bootstrap/CHANGELOG.md).

- **2.5.0: the code that came from microsoft/DebugMCP is rewritten (#53).** The server, the handler and the executor are written anew from specifications, with a gate that fails when a file shares more than five lines with DebugMCP's history (`npm run provenance:check -- --gate`, method in `docs/provenance/README.md`). New layout: `src/debugTools.ts`, `src/handler/`, `src/executor/`. `LICENSE-MIT`, `NOTICE` and the license field are unchanged; that decision is #54.
- **2.5.0: tools that tell the truth.** Typed results for every tool: `isError`, an error code, a hint, `structuredContent` (#11). CMSIS tasks are followed as jobs: the right task's exit code, a probe guard against parallel Run tasks, waits up to 600 s, a `status` action (#47, #46, #12). Breakpoint and run-state operations that are safe while the target runs, and GDB commands that reach GDB on `gdbtarget` (#13, #56).
- **2.5.1: errors an agent can see, handles for people.** One problem journal per window with `get_recent_problems` (#48). Build error lines in the `cmsis_action` result (#15). Fences and health checks on the control channel, a warning when the router window is stuck (#14). Status-bar item, **Select Target Window**, a `window` argument (#16). Serial ports released after idle time or when the agent's session ends, and `serial_capture` (#49). Registry and control server closed to other users (#19). The tool rules, in the server instructions, the skills and, after a previewed confirmation, the agents' rule files (#50, #45).
- **2.5.2 and 2.5.3: tester feedback.** A build that CMSIS Solution closes with exit code 0 is checked before it is reported as a success. `continue_execution` no longer halts the target when its wait runs out. `evaluate_expression` shows the fields of a struct. A failed debug start that an agent asked for no longer opens VS Code's modal dialog. The documentation and build-artefact tools are on by default.
- **2.5.9: start in an empty VS Code window.** `cmsis_action open_solution`, the error code `NO_WORKSPACE`, the guide topic `bootstrap`, the always-installed skill `cmsis-bootstrap`, and three selectable skills of the extension (`cmsis-debugger-setup`, `fvp-debug-setup`, `debugger-troubleshooting`).
- The Python and C/C++ troubleshooting guides are new, the other language guides are removed; their review is #55.
- No dependency changes.

Known gap: the skill that creates a new project, `start-cmsis-project`, is written for Open-CMSIS-Pack/cmsis-skills and is not part of this pull request. Until it is vendored, `cmsis-bootstrap` copies an example of the board's pack or asks for **CMSIS: Create Solution**.

## Screenshots

The status-bar item (`CDA router` / `CDA worker`, `Serial: COM7 (agent)`) and the **Select Target Window** pick are the UI changes; screenshots to follow if wanted.

## Checklist

- [x] 🤖 1103 unit tests, both transport suites, four behaviour baselines (tool surface, scripted `gdbtarget` sessions, agent configuration, executor), the provenance gate, the packaged-VSIX check; fork CI green on five platforms for every release.
- [ ] 🤹 2.5.1 and 2.5.2 were used by a tester on an STM32H735G-DK, and their feedback is in 2.5.2 to 2.5.9. The empty-window sequence of 2.5.9 ran in a VS Code of its own with CMSIS Solution 1.72.0, through `cmsis_action build`. Not yet on hardware: the modal-dialog fix of 2.5.3, `load_and_debug` after a bootstrap, the Windows COM-port handover.
- [x] 🛡️ Registry directory 0700 and files 0600, a per-user directory on a shared temp folder, Host and Origin checks and a constant-time token compare on the control server. The server still binds `localhost` only. The rule-file writer changes a file only after the user confirmed its diff.
- [x] 📖 CHANGELOG, README, the architecture pages (new: `windowRouting.md`, `serial.md`), the agent guide, `AGENTS.md`, `docs/provenance/`.
- [x] 🧠 No dependency changes; `TPIP.md` regenerated.
