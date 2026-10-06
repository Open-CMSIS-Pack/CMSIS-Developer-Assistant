---
name: cmsis-project
description: "Set up and extend CMSIS csolution projects and Zephyr-based CMSIS solutions: verify the CMSIS-Toolbox, CMake, Ninja and compiler environment or a Zephyr west workspace; resolve a fuzzy board or device name to its exact CMSIS identity and BSP/DFP, or to its Zephyr board target; add a verified target to an existing *.csolution.yml; find compatible packaged board layers; or create an initial west-integrated CMSIS Zephyr Blinky solution. Use when the user wants to create, extend or retarget a csolution, check their build tools, or identify board, device and pack identifiers; this skill routes to the specialised project skills installed next to it. Not for debugging a running target (cmsis-debug-live) or for PDSC authoring (cmsis-pack)."
---

# CMSIS project setup (entry point)

This skill does no work of its own. It selects one of the member skills below and hands
over to it. Every `$name` is a skill installed next to this one — `../<name>/SKILL.md`
relative to this file — and the member skills are the source of truth for their own
prerequisites, steps and guardrails.

## Pick the skill

| If the user wants to… | Hand over to |
|---|---|
| Add a verified target and packaged board layer | `$add-cmsis-target` |
| Verify CMSIS build tools and compiler toolchains | `$check-cmsis-environment` |
| Verify a local Zephyr west environment | `$check-zephyr-environment` |
| Wire the debug adapter of a csolution target and verify Load & Debug | `$cmsis-debugger-setup` |
| Find compatible packaged CMSIS board layers | `$identify-cmsis-board-layer` |
| Resolve one board or device and find its BSP or DFP | `$identify-cmsis-board-support` |
| Resolve a physical board to a Zephyr target | `$identify-zephyr-board` |
| Create a CMSIS solution for a Zephyr board | `$start-zephyr-project` |

## Typical workflow

1. No folder open or no solution yet: `/cmsis-bootstrap` first; it creates or opens the project and comes back here.
2. `$check-cmsis-environment` (or `$check-zephyr-environment`) to confirm the toolchain before anything is created or built.
3. `discover_board_or_device` when available for CMSIS catalog identities and BSP/DFP packs; `$identify-cmsis-board-support` for unresolved details or fallback (`$identify-zephyr-board` for Zephyr).
4. `$add-cmsis-target` to extend the solution, then `$identify-cmsis-board-layer` for a packaged board layer — or `$start-zephyr-project` for a new west-integrated solution.
5. `$add-board-layer` when no packaged layer fits: interview for the few open decisions, then author Board.clayer.yml with its startup, stdio and memory files — or integrate the DFP's configuration generator — and build to green.
6. `$cmsis-debugger-setup` once the solution builds: set the debug adapter of the target set, let the CMSIS Solution extension write launch.json, and verify Load & Debug on the target.

## How to hand over

- Invoke the chosen skill through your harness's skill mechanism (a Skill tool, `$name`,
  `/name`). If it is not offered, read `../<name>/SKILL.md` and follow it verbatim.
- Honour its *Prerequisites* — if it names another `$skill`, run that one first — and apply
  its *Guardrails*. Do not merge, reorder or paraphrase steps across member skills.
- If `../<name>/SKILL.md` is missing, say so instead of improvising: the skill was not
  installed. The user can add it with **CMSIS Developer Assistant: Select Agent Skills** in VS Code or by editing the
  `cmsis-developer-assistant.installedSkills` setting.

## Member skills

- `$add-cmsis-target` — Add a verified board or device target to an existing CMSIS solution, declare its support packs, and offer compatible packaged board layers when the project uses them.
- `$check-cmsis-environment` — Verify CMSIS-Toolbox, its CMake and Ninja build environment, and the available compiler toolchains with cbuild.
- `$check-zephyr-environment` — Verify an existing Zephyr workspace, its Python virtual environment, and the venv-local west installation.
- `$cmsis-debugger-setup` — Wire the debug adapter of a CMSIS csolution target so that Load & Debug works, and prove it on the target: choose the adapter (CMSIS-DAP@pyOCD, ST-Link@pyOCD, ULINKplus@pyOCD, J-Link Server, …) from csolution list debuggers, set the debugger node of the target set, let the CMSIS Solution extension write launch.json and tasks.json, then verify with cmsis_action load_and_debug, a breakpoint and the serial console.
- `$identify-cmsis-board-layer` — Identify packaged CMSIS board layers compatible with an existing solution target and its required connections.
- `$identify-cmsis-board-support` — Resolve a supplied board or device to exactly one verified CMSIS identity, identify its BSP or DFP, and ask the user when multiple candidates remain.
- `$identify-zephyr-board` — Resolve a user-supplied physical board to its exact Zephyr board target and fitted MCU or SoC using the installed west board catalog.
- `$start-zephyr-project` — Create an initial CMSIS Zephyr Blinky solution for a board already supported by Zephyr.

Need the full list of CMSIS slash commands, VS Code commands, MCP tools and settings?
Invoke `/cmsis-help`.

*Generated by `npm run skills:sync` from the category "project" of
Open-CMSIS-Pack/cmsis-skills and the extension's own skills of that category; edit
`scripts/skills.config.json`, not this file.*
