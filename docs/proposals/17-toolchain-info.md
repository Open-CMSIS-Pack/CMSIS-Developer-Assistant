# #17 get_toolchain_info tool: resolved cbuild / cpackget / compiler paths and CMSIS_PACK_ROOT

> **2.7.0 status (2026-10-27).** The read-only toolchain query remains proposed. Environment parsing is already used by build diagnosis, and activate_environment now re-resolves the manifest and reports its tools; reuse those paths rather than starting from the old proposed parser layout. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#17](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/17) |
| Area · priority · source | Toolchain discovery · Low (P3) · studio test |
| Original release plan | Future (WP-M, with #41). The parser can land earlier with WP-H (#15) |
| Size | S |
| Depends on | #41 (the `cmsis_query` tool), #11 (`ToolReply.data`) |
| Related | #15 (the build re-run needs the same environment), #45 and #46 (bundled pyOCD), #50 (the agent searched the file system instead of asking) |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

The agent needed the compiler and ran `find /Users/… -path '*/bin/armclang' -type f`. Earlier it had also fallen back to "the repository script while locating the CLI", which bypassed the extension's environment.

No tool says which `cbuild`, `cpackget` and compiler the CMSIS Solution extension actually uses. The extension resolves them through vcpkg and the Environment Manager, not through the user's PATH.

**Still true in 2.3.10.** Two details have changed since the issue:

- `get_device_info` now also names the active CMSIS target. It still requires a debug session and returns nothing about the toolchain.
- CMSIS Solution 1.70.1 now writes exactly the data this issue asks for to `<solution dir>/.cmsis/tools-environment.yml`. That turns #17 from "reverse-engineer the environment" into "read and render one file".

## Current state (2.3.10)

- **Nothing in `src/` resolves toolchain paths.** `get_device_info` returns launch-configuration fields plus `CMSIS target` ([debuggingHandler.ts:1600-1613](../../src/debuggingHandler.ts#L1600-L1613), [debuggingExecutor.ts:1516-1539](../../src/debuggingExecutor.ts#L1516-L1539)).
- **`flash` finds pyOCD only on PATH.** `probePyocd` spawns `pyocd --version` ([flashController.ts:81-89](../../src/core/flashController.ts#L81-L89)). #45 and #46 (WP-B) add the CMSIS Debugger's bundled copy.
- **Pack root.** `CMSIS_PACK_ROOT` is already resolved through `cmsis-csolution.getPackRootPath` ([toolchainPackRoot.ts:37-54](../../src/utils/toolchainPackRoot.ts#L37-L54)).
- **Which compiler a context uses.** The `compiler:` field of the cbuild-run and cbuild files is already parsed for the build-artefact tools ([artifacts.ts:142-151](../../src/core/buildInfo/artifacts.ts#L142-L151), [:181-192](../../src/core/buildInfo/artifacts.ts#L181-L192)).
- **Precedent for a small YAML reader.** Line-based readers of CMSIS YAML already exist, without a YAML dependency ([cbuildRun.ts:143-160](../../src/core/packDocs/cbuildRun.ts#L143-L160)).
- **The new data source: CMSIS Solution 1.70.1 `ToolsEnvironment`** (bundle `dist/extension.js`).
  - The file is rewritten whenever the solution is converted (`requestConvert` → `captureAndQueueWrite`), and only if its content changed.
  - Its format is `cmsis-tools-environment: {version: 1.0.0, generated-by, solution, environment: {path[], variables{}}, tools[]}`.
  - Each `tools[]` entry has `name`, `version`, `origin` (`built-in` | `installed`), `provider` (`{type: vscode-extension | vcpkg, id}`), `directory` and `manual`.
  - The built-in entries are CMSIS-Toolbox (the extension's `tools/cmsis-toolbox/bin`), pyOCD (the CMSIS Debugger's `tools/pyocd`) and Arm GNU GDB.
  - `environment.variables` carries the compiler registrations CMSIS-Toolbox reads: `GCC_TOOLCHAIN_14_3_1`, `AC6_TOOLCHAIN_6_24_0`, `CLANG_TOOLCHAIN_22_1_0`. It also carries `CMSIS_PACK_ROOT` and `CMSIS_COMPILER_ROOT` when they are set.
- **What is on disk.** Three real files on this machine confirm the format. In one of them `variables` is empty, and the GCC registration appears only as a `tools[]` entry named `GCC_TOOLCHAIN_14_3_1`, without a `version` field. The others name vcpkg packages (`compilers.arm.armclang`, `compilers.arm.arm.none.eabi.gcc`, `compilers.arm.llvm.embedded`) with versions. So names and versions are not uniform. The corstone-blinky fixture's file lists no compiler at all, and its `Blinky.cbuild-idx.yml` warns "no compiler registered". That fixture file is git-ignored ([.gitignore:433](../../.gitignore#L433)).
- **Skills.** The vendored `check-cmsis-environment` skill (cmsis-skills `d778b91`) checks the shell. cmsis-skills PR #16 (open) switches it to this file.

## Proposed fix

1. **New pure module `src/core/toolsEnvironment.ts`.**
   - `parseToolsEnvironment(content, file): ToolsEnvironment | {error}`, a line-based reader for the fixed, versioned shape (Decision 2). It handles CRLF, quoted scalars, `{}` / `[]` and forward-slash portable paths.
   - A major version other than 1 is refused with "unsupported tools-environment version X".
   - WP-H's #15 re-run needs the same `environment.path`, and WP-B can take pyOCD from `tools[name=pyOCD]`. So this module should land with whichever comes first.
2. **Resolver `resolveToolchain()`** in the worker window.
   - **Locate the file.**
     - First `<dirname(getSolutionFile)>/.cmsis/tools-environment.yml`, using #41's runner.
     - Else exactly one `**/.cmsis/tools-environment.yml` in the workspace.
     - Several files, and none matching the active solution: `ToolError('INVALID_ARGUMENT')` listing them.
   - **CMSIS-Toolbox.** Take `version` and `directory` from its `tools[]` entry. Derive `cbuild`, `csolution` and `cpackget` (`.exe` on Windows), each checked for existence.
   - **Active compiler.**
     - Read `compiler:` from the active context's cbuild-run file (`parseCbuildRunOutputs`), for example `GCC` or `AC6@>=6.18`.
     - Find its registration, in this order:
       1. the variable `<NAME>_TOOLCHAIN_<major>_<minor>_<patch>` in `environment.variables`;
       2. a `tools[]` entry with that name;
       3. the vcpkg package: GCC ↔ `compilers.arm.arm.none.eabi.gcc`, AC6 ↔ `compilers.arm.armclang`, CLANG ↔ `compilers.arm.llvm.embedded`, with `<directory>/bin`.

       This gives the bin folder and the version.
     - Map the name to the executable: GCC → `arm-none-eabi-gcc`, AC6 → `armclang`, CLANG → `clang`, IAR → `iccarm`.
     - If nothing matches: "GCC is selected but no GCC registration is in the exported environment; cbuild reports 'no compiler registered' in that case".
   - **Other registered compilers.** Every other registration found the same way, listed by name and version.
   - **pyOCD and GDB** come from their built-in `tools[]` entries.
   - **`CMSIS_PACK_ROOT`** comes from `toolchainPackRoot()` (`getPackRootPath`), falling back to the variable in the file and then the default. The result labels which source was used.
   - **Freshness.** Report `generated-by` and the file's age. If the `*.csolution.yml`, `cdefault.yml` or `vcpkg-configuration.json` is newer than the file, add "may be stale — CMSIS Solution rewrites it on the next load or build".
   - **Fallback when there is no file** (CMSIS Solution < 1.70, or a solution never converted):
     - Look up `cbuild`, `csolution`, `cpackget`, `arm-none-eabi-gcc`, `armclang`, `clang` and `pyocd` on the extension host's PATH, without versions.
     - Label the result `source: 'PATH (extension host)'`, with "not the CMSIS environment — open the solution in CMSIS Solution ≥ 1.70 to get the resolved one".
3. **Surface.** `cmsis_query {what: 'toolchain'}` (#41) returns `ToolReply {text, data}`, so the values arrive as `structuredContent`. Cost: about 90 B on top of #41's tool (Decision 1). No session is needed.
4. **Guidance.** The `build` topic and `skills/cmsis-debug-live/SKILL.md`: "compiler, cbuild or pyOCD location → `cmsis_query {what: 'toolchain'}`; do not search the file system or PATH". The cmsis-help tool group line also gets the entry. Once cmsis-skills PR #16 is vendored, the skill and the tool read the same file and cannot disagree.

## What changes for the agent and the user

```text
"Where is the compiler this project builds with?"

2.3.10   find /Users/… -path '*/bin/armclang' -type f      (slow; may find a different version than the build uses)

new      cmsis_query {what: "toolchain"} →
         Toolchain for cmsis-executorch.csolution.yml (.cmsis/tools-environment.yml, arm.cmsis-csolution 1.70.1-63, 3 min old)
           CMSIS-Toolbox 2.14.1-64-ge745dc0  …/cmsis-toolbox/bin  (cbuild, csolution, cpackget)
           Active compiler AC6 → AC6_TOOLCHAIN_6_24_0  …/compilers.arm.armclang/6.24.0/bin/armclang
           Also registered: GCC 14.3.1, CLANG 22.1.0
           pyOCD 0.45.1 (CMSIS Debugger, tools/pyocd); Arm GNU GDB 15.2.1 (tools/gdb/bin)
           CMSIS_PACK_ROOT ~/.cache/arm/packs (cmsis-csolution.getPackRootPath)
         structuredContent: {"status":"ok","source":"tools-environment","activeCompiler":{"name":"AC6","version":"6.24.0",
           "bin":"…/6.24.0/bin","executable":"armclang"}, "cmsisToolbox":{…}, "compilers":[…], "pyocd":{…}, "packRoot":"…"}
```

The values above are from the real file of an ExecuTorch project on this machine. On the corstone-blinky fixture the answer says that GCC is selected but not registered, which is the actual reason its build warns.

## Decisions for you

- [ ] **1. Surface.** **Recommended:** fold it into #41's tool as `cmsis_query {what: 'toolchain'}` (about 90 B). One tool answers "what does the extension know", and it also delivers the #41 contract.
  - Alternative: a standalone `get_toolchain_info` with no arguments (about 420 B). Its name matches the issue and it can ship before #41, but it costs about 330 B more on every turn, and #41 would repeat part of it.
- [ ] **2. Parser.** **Recommended:** a line-based reader. The file is machine-written, versioned (`version: 1.0.0`) and flat enough; this matches `cbuildRun.ts`.
  - Alternative: add the `yaml` package. It is robust to layout changes, but adds a runtime dependency plus a TPIP and license entry.
- [ ] **3. Versions.** **Recommended:** only what the file states (CMSIS-Toolbox, vcpkg tools, pyOCD, GDB, and the compiler version from its variable name). No process is spawned.
  - Alternative: spawn `<tool> --version` for each tool. Exact even for tools without a version entry, but about six processes and up to a few seconds per call.
- [ ] **4. Timing.** **Recommended:** the parser lands with WP-H in 2.3.12, where #15's re-run needs it anyway. The tool surface ships with #41 (Future).
  - Alternative: ship `get_toolchain_info` in 2.3.12 on its own. Available sooner, but it takes budget WP-G reserved for `get_recent_problems` and `serial_capture`.

## Tests and acceptance

- **Unit, new `src/test/toolsEnvironment.test.ts`.** Fixtures are committed under `src/test/fixtures/tools-environment/`, because the corstone-blinky file is git-ignored. They are anonymised copies of the three real files: built-ins only, vcpkg with GCC/AC6/CLANG variables, and a registration only in `tools[]` without `version`. Cases:
  - An unknown major version.
  - CRLF line endings.
  - Windows paths (`C:/Users/…`, `.exe`).
  - Quoted scalars.
  - `variables: {}`.
- **Unit, resolver.**
  - `compiler: GCC` / `AC6@>=6.18` / `CLANG` / `IAR` maps to the right variable and executable.
  - A selected but unregistered compiler gives the note.
  - Several environment files give `INVALID_ARGUMENT`.
  - A missing file falls back to PATH and is labelled so.
  - A stale file gives the note.
- **Transport and routing:** covered by #41's tests with `what: 'toolchain'`.
- **Live.**
  - The corstone-blinky fixture gives the "not registered" note.
  - A vcpkg project with AC6 or GCC: `activeCompiler.bin` equals the compiler folder in its `cbuild` log.
  - Path handling is checked on the Windows CI runner.

## Out of scope and follow-ups

- Installing or activating tools. That belongs to the Environment Manager and vcpkg.
- Running `cbuild`: `cmsis_action build` does that.
- The shell-side check: that stays the `check-cmsis-environment` skill (cmsis-skills PR #16).
- Using the parser for `flash`'s pyOCD lookup: coordinate with WP-B (#45, #46).

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
