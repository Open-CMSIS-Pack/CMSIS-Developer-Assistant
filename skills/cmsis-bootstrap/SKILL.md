---
name: cmsis-bootstrap
description: "Get from an empty VS Code window (no folder open, no project on disk) to a CMSIS solution that builds, flashes and debugs: check the CMSIS extensions and the tools environment, choose the project folder, create the solution for the board or device with $start-cmsis-project or open an existing one with cmsis_action open_solution, wait for the CMSIS Solution extension to load it, build, wire the debugger and hand over to cmsis-debug-live. Use when the user wants to start a new CMSIS project for a board, when get_session_status says that no folder is open, or when cmsis_action answers NO_WORKSPACE or CMSIS_NO_SOLUTION. Not for extending an existing solution (cmsis-project) and not for debugging a running target (cmsis-debug-live)."
---

# From an empty VS Code window to a debugged board

<!-- cmsis-developer-assistant:rules:begin -->
## CMSIS Developer Assistant tool rules

Only the user can lift a rule, by asking for the specific command.

- Talk to the board only through the cmsis-developer-assistant MCP tools. Never run `pyocd`, `gdb`, `JLinkExe`, `JLinkGDBServer` or `openocd` against the board from a shell, and never install pyOCD.
- Build, load, erase, run and debug with `cmsis_action`; program with `flash`. Run `cbuild`, `csolution` or `cpackget` in a shell only when the user asks for it or a CMSIS skill step names the command.
- Serial I/O only through the `serial_*` tools, not `screen`, PuTTY, a read of the port or a serial script.
- Manuals, datasheets and register meanings through the documentation tools; use the web only to find a PDF URL for `fetch_doc`, and never read a PDF into your context.
- Symbol, section, memory-usage and build-log questions through the build-artefact tools, not `nm`, `size` or a grep over the map file.
- If a tool you need is not in your tool list, name the setting that enables it (`cmsis-developer-assistant.packDocs.enabled` or `cmsis-developer-assistant.buildInfo.enabled`) instead of substituting a shell command.
- The control server and the registry files are internal: never call or read them. With several VS Code windows open, use `list_debug_windows` and `select_debug_window`.
- A running target rejects reads and steps: call `pause_execution` first.
- If a tool fails twice, call `get_session_status` and `get_recent_problems`, then stop and tell the user what to do in VS Code. Do not work around a failing tool with a shell command.
<!-- cmsis-developer-assistant:rules:end -->

## Goal and method

Goal: a CMSIS solution that is open in a VS Code window, builds with
`cmsis_action build`, and reaches `main` with `cmsis_action load_and_debug`.

This skill does little work of its own. It finds out what is missing, asks the user
for the few things only they can decide or do, and hands over to the skill that owns
each step. Every `$name` is a skill installed next to this one
(`../<name>/SKILL.md`). When one is missing, say so: the user adds it with
**CMSIS Developer Assistant: Select Agent Skills** in VS Code. Do not improvise its
steps.

## 1. Find out where you are

Call `get_session_status`, and `list_debug_windows` when more than one window may be
open. Read the result against this table and start at the first row that applies.

| Sign | State | Go to |
|---|---|---|
| `Extensions: … not installed` | The CMSIS Solution or CMSIS Debugger extension is missing | Step 2 |
| `Workspace: no folder is open`, or `[NO_WORKSPACE]` from a tool | No project is open in the window | Step 3 |
| `[CMSIS_NO_SOLUTION]` with "contains no *.csolution.yml" | A folder without a solution | Step 5 |
| `[CMSIS_NO_SOLUTION]` with "A solution file exists" | The solution is not loaded | Step 6 |
| A solution is active | Nothing to bootstrap | Step 7 |

## 2. Extensions

Ask the user to install the **Keil Studio Pack** (`Arm.keil-studio-pack`) from the
Extensions view and to reload the window. It brings the CMSIS Solution extension, the
CMSIS Debugger and the Arm Tools Environment Manager. When the user agrees and the
`code` command is available in your shell, you may run
`code --install-extension Arm.keil-studio-pack` instead. Then call
`get_session_status` again.

## 3. An existing project, or a new one?

Ask, unless the request already says:

- **An existing project.** Ask for its folder or its `*.csolution.yml`, then go to
  step 6.
- **A new project.** Ask for
  - the board, or the device when there is no board: the name printed on it, the
    manufacturer, and the revision when known;
  - the parent folder and a project name (letters, digits, dash, underscore);
  - the compiler, when the user has a preference: `GCC`, `AC6`, `CLANG` or `IAR`;
  - how it will be debugged: the probe on the board or on the desk (CMSIS-DAP,
    ST-Link, J-Link, ULINKplus, …), or an Arm FVP simulation model.

Do not guess the board from a vague name and do not pick a folder yourself.

## 4. The project folder and its tools

1. Create `<parent>/<project-name>` when it does not exist. Never write into a folder
   that already holds a `*.csolution.yml`; go to step 6 with it instead.
2. When neither the folder nor a parent has a `vcpkg-configuration.json`, copy
   [assets/vcpkg-configuration.json](assets/vcpkg-configuration.json) into the
   folder. It names CMSIS-Toolbox, CMake, Ninja and GCC from the Arm tools registry.
   For another compiler replace the GCC line:

   | Compiler | Line in `requires` |
   |---|---|
   | `AC6` | `"arm:compilers/arm/armclang": "^6.24.0"` |
   | `CLANG` | `"arm:compilers/arm/llvm-embedded": "^17.0.1"` |
   | `IAR` | none: remove the line, the user provides the compiler |

   The file only names the tools. The Arm Tools Environment Manager fetches them when
   the folder is opened in VS Code.
3. Run `$check-cmsis-environment` from the folder.
   - `PASS`: go to step 5.
   - `FAIL` because a tool the manifest names is not installed yet: open the folder
     with `cmsis_action {action:'open_solution', path:'<folder>'}`, and ask the user
     to answer the prompts of the Arm Tools Environment Manager in the new window
     (download, licence). When the user confirms that the environment is active, run
     `$check-cmsis-environment` again. Do not download or install a compiler, CMake,
     Ninja or CMSIS-Toolbox yourself.
   - Any other `FAIL`: report it and stop.

## 5. Create the solution

Use `discover_board_or_device` when available to resolve the board/device and BSP/DFP
packs. Pass its report to the creation skill; settle any reported choice first.

Hand over to `$start-cmsis-project` with the folder, the project name, the board or
device, the compiler and the debug adapter. It resolves the board with
`$identify-cmsis-board-support`, installs the packs, lets the user choose between an
example of the board's pack, a template of the pack, and a minimal project, and
builds once with `cbuild setup` and `cbuild`. Those two builds are the only ones you
run in a shell.

When the board has no BSP example and its DFP has no startup component,
`$start-cmsis-project` reports that the minimal project cannot be created. Tell the
user, and offer `$add-board-layer` after a solution exists, or a template of the
pack.

`$start-cmsis-project` is part of the AI Skills Pack (entry point `cmsis-project`).
While it is not installed, only this fallback is allowed: list the examples of the
board's pack with `csolution list examples --filter "<board>" --verbose`, let the
user choose one, copy its `folder:` into the project folder, make the copies writable
and continue with step 6. When the board has no example, ask the user to run
**CMSIS: Create Solution** in VS Code or to install the skill. Do not write
csolution, cproject, startup or linker files from memory.

## 6. Open the solution in VS Code

```text
cmsis_action { action: 'open_solution', path: '<folder or *.csolution.yml>' }
```

- A folder that a window already has open is used there, and the solution is made
  the active one.
- Any other folder opens in a new window. The window you started in stays as it is;
  this session's later calls go to the new window. `list_debug_windows` shows both.
- A window needs some seconds after it opens. Call `get_session_status`. When
  `cmsis_action build` still answers `[CMSIS_NO_SOLUTION]` with "A solution file
  exists", wait ten seconds and try again, at most three times; then read
  `get_recent_problems` and report what the extension said.

## 7. Build

`cmsis_action { action: 'build' }`. The first build resolves packs and can take
minutes: a result with status `running` is not a failure, `cmsis_action
{ action: 'status' }` waits for it. A failed build shows its error lines; fix the
cause, do not run cbuild yourself.

## 8. The debugger

`cmsis_action load_and_debug` needs a `debugger:` node in the active target set and
the `launch.json` the CMSIS Solution extension writes from it.

- Hardware probe: `$cmsis-debugger-setup`.
- Arm FVP: `$fvp-debug-setup`.
- Neither skill installed: ask the user to choose the debug adapter in the CMSIS
  view under **Manage Solution Settings**.

Skip this step when `$start-cmsis-project` already set the adapter, or the copied
example has one.

## 9. Flash, debug, hand over

Ask the user to connect the board. Then `cmsis_action { action: 'load_and_debug' }`
and continue with `cmsis-debug-live`. When the session does not start, read the
hint of the result and `get_recent_problems`; for a probe or connection failure
continue with `$debugger-troubleshooting`.

## 10. Report

State the folder, the solution file, the board or device and its packs, the compiler,
the debug adapter, the result of the build and of the first debug start, and every
step that is still open, with who has to do it.

## Shell commands this skill allows

Only these, and only for the step named:

| Command | Step |
|---|---|
| `code --install-extension Arm.keil-studio-pack` | 2, when the user agrees |
| `mkdir`, copying the manifest | 4 |
| the commands of `$check-cmsis-environment` | 4 |
| the commands of `$start-cmsis-project` and `$identify-cmsis-board-support` (`csolution list …`, `cpackget list`, `cpackget add`, `cbuild setup`, `cbuild`) | 5 |

Everything after step 6 goes through the MCP tools.

## What stays with the user

- Installing extensions, unless they ask you to run the command.
- The download and licence prompts of the Arm Tools Environment Manager.
- The choice of board, folder, compiler and debug adapter.
- Connecting the board and its probe.

Ask for each when its step comes, in one short question, and wait for the answer.
