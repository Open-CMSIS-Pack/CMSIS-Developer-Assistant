# #15 cmsis_action build returns only the exit code — surface compiler/ninja error lines

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** Build diagnosis and the diagnostic rerun are implemented; see [handler architecture](../architecture/debuggingHandler.md). The provider-side build-log follow-up remains a separate integration choice. The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#15](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/15) |
| Area · priority · source | Build & flash · Medium · Studio test |
| Original release plan | 2.3.12 (WP-H, item 7) |
| Size | M |
| Depends on | #47 (`CmsisJobTracker`: the failed build's execution, its task definition and its start time). #11 is used for the error shape but not required. |
| Related | #48 (the journal takes these lines as source `build`), #21 (ask CMSIS Solution for a build log), #12, #47 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

A failed `cmsis_action build` says only "task '…' exited with code 2", then sends the agent to a terminal it cannot read and to a Problems panel that stays empty. 2.3.9 added `get_build_diagnostics`, which parses a cbuild log with file:line. That half is done, but it is opt-in (`buildInfo.enabled`) and needs a log that the CMSIS Solution extension never writes.

Verified against CMSIS Solution 1.70.1:

- The build runs as a `CustomExecution` pseudoterminal, so its output is not readable through the VS Code API.
- The extension contributes no `problemMatchers`.
- The `cmsis-csolution.build` task definition has no log property.
- The extension calls cbuild without `--log`.

The `cmsis_action` result therefore has no source for the error lines today; this proposal adds two.

## Current state (2.3.10)

- **The failure text** ([debuggingHandler.ts:2193-2198](../../src/debuggingHandler.ts#L2193-L2198)) carries only the exit code and points to "the CMSIS/cbuild terminal or the Problems panel". The waiter keeps no other data about the task ([:2244-2284](../../src/debuggingHandler.ts#L2244-L2284)). By contrast, `flash` returns pyOCD's own error lines ([flashController.ts:55-75](../../src/core/flashController.ts#L55-L75)).
- **The parser is reusable.** `get_build_diagnostics` is [buildInfoHandler.ts:191-226](../../src/buildInfoHandler.ts#L191-L226). The parser and renderer it uses are pure and work without `buildInfo.enabled`:
  - `parseBuildLog` ([buildLog.ts:84](../../src/core/buildInfo/buildLog.ts#L84)) reads GCC, Clang, armclang, armlink, ld, CMake, ninja `FAILED:` and cbuild lines, and folds duplicates;
  - `readBuildLog` ([:191-206](../../src/core/buildInfo/buildLog.ts#L191-L206)) and `looksLikeBuildLog` ([:209-221](../../src/core/buildInfo/buildLog.ts#L209-L221));
  - `renderDiagnostics` ([render.ts:359-389](../../src/core/buildInfo/render.ts#L359-L389)).
- **No log to find.** Without a log, `renderNoLog` ([render.ts:391-395](../../src/core/buildInfo/render.ts#L391-L395)) asks the user to rebuild with `--log`. The default log globs are `**/out/**/*.log` and `**/build*.log` ([host.ts:54](../../src/core/buildInfo/host.ts#L54)).
- **How CMSIS Solution 1.70.1 builds** (`dist/extension.js`):
  - `cbuildArgsFromTaskDefinition` assembles `[setup] <solution> [--clean] [--quiet|--verbose|--debug] [--generator g] [--intdir d] [--outdir d] [--target t] [--rebuild] --active <ctx> [--update-rte] --schema [--toolchain t] [--packs] [--jobs n] [--output <solutionDir>/<cmsis-csolution.outputDirectory>] [--skip-convert]`.
  - It runs cbuild under its own tool mutex.
  - The task definition, including `solution`, `active`, `toolchain`, `jobs` and `downloadPacks`, is visible to us on `onDidStartTask` as `execution.task.definition`.
- **The tool environment.** The extension writes `.cmsis/tools-environment.yml` next to the solution:
  - `environment.path`: the CMSIS-Toolbox, compiler, CMake, Ninja, pyOCD and GDB directories;
  - `environment.variables`: for example `GCC_TOOLCHAIN_14_3_1`, `AC6_TOOLCHAIN_6_24_0`, `cmake` and `ninja`;
  - `tools`: name, version, origin and `directory` of each tool (CMSIS-Toolbox 2.14.1 bundled in the extension).

  `CMSIS_PACK_ROOT` is not in it; `effectiveToolchainPackRoot()` ([toolchainPackRoot.ts:84-86](../../src/utils/toolchainPackRoot.ts#L84-L86)) supplies it.
- **cbuild supports what we need.** cbuild 2.14 has `--log <file>` and `--skip-convert`.
- **csolution already records its own errors.** Its errors land in `<solution>.cbuild-idx.yml` under `cbuilds[].messages.errors`. The fixture's `test/eval/fixtures/corstone-blinky/Blinky.cbuild-idx.yml` (written by a build, not in the repository) showed "component 'Compiler:CORE' not found in included packs". Missing components, packs and schema errors (the #21 B1 class) are therefore readable without any re-run.

## Proposed fix

A new pure module `src/core/buildFailure.ts` does the parsing; a small vscode-side runner `src/cmsisBuildDiagnosis.ts` runs the process. Both are triggered by `CmsisJobTracker.onDidFinishJob` (#47) when a `build` job ends with a non-zero exit code. The work belongs to the job, so the result reaches the failing `cmsis_action` call if it arrives within the call's deadline, and `cmsis_action {action:'status'}` (#12) otherwise.

1. **Stage A: csolution messages, instant.**
   - Find the `*.cbuild-idx.yml` of the solution: in the solution directory, or under the `--output` prefix.
   - If its mtime is at or after the job's start, `idxMessages(text)` returns `messages.errors` and `messages.warnings` per context.
   - If there are errors, report them (labelled "from csolution") and skip stage B.
2. **Stage B: a diagnostic re-run with a log.**
   - **Arguments.** `cbuildDiagnosticArgs(definition, { output, logFile })` mirrors 1.70.1's argument builder with changes: no `setup`, `--clean`, `--rebuild`, `--packs`, `--update-rte` or `--schema`, and `--log <file>` added. So the re-run never downloads packs, never rewrites RTE files and never wipes outputs. `--skip-convert` is added when stage A found a fresh cbuild-idx.yml, so the csolution YAMLs are not rewritten and the extension's watchers stay quiet.
   - **When the idx is not fresh.** An idx older than the job means the build failed before convert, for example in a pack download. The re-run then includes convert, and csolution reports the missing pack.
   - **Environment.** Take PATH and variables from `.cmsis/tools-environment.yml`, `CMSIS_PACK_ROOT` from `effectiveToolchainPackRoot()`, and cbuild from the `CMSIS-Toolbox` entry's `directory`. The file is read line by line, like the cbuild parsers; there is no YAML dependency.
   - **Guards.**
     - Run only when no `cmsis-csolution.build` execution (build or setup) is alive.
     - Kill the child if the tracker sees one start.
     - Spawn without a shell, with a 120 s cap.
     - The build is incremental: the translation units that compiled before are up to date, and the failing one fails again.
   - **Parsing.** `readBuildLog(logFile)` and `parseBuildLog`, reused.
   - **Log location.** `<solutionDir>/out/cmsis-developer-assistant/build-diagnostic.log`, overwritten each time. It is inside `out/`, which the generated CMSIS `.gitignore` excludes (`**/out`), and it matches the default log glob, so `get_build_diagnostics` returns the full list without arguments.
   - **Skip conditions.** No stage B when `tools-environment.yml` is missing (CMSIS Solution before 1.70.1), when cbuild cannot be found, or when the setting is off. The result then says why and names `get_build_diagnostics`.
3. **Result.** Built with `renderBuildFailure(summary, { limit: 10, maxChars: 3_000 })` over `renderDiagnostics`, errors first, each with file:line. It becomes the message of `ToolError('TASK_FAILED', hint)`:

   ```text
   ❌ CMSIS 'build' FAILED on MPS3 — task 'cbuild Blinky.csolution.yml --active MPS3 …' exited 2 after 48 s.
   2 errors (from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 1):
     Blinky/main.c:42:5 error: 'ledx' undeclared (first use in this function)
     ninja FAILED: CMakeFiles/Blinky.dir/Blinky/main.c.o
   Full log: out/cmsis-developer-assistant/build-diagnostic.log (get_build_diagnostics reads it).
   Hint: fix the first error, then cmsis_action build.
   ```

   - **Warning count.** It is labelled honestly. A re-run recompiles only what failed, so warnings from earlier translation units are not repeated; the count says so.
   - **Other failed actions.** For `load`, `erase` and `load_and_run` the ❌ hint adds "flash returns pyOCD's own error lines". Their terminals stay unreadable, and there is no re-run.
4. **Journal.** Once #48 exists, each diagnostic also goes into the problem journal as source `build`, with `location` set to file:line. #15 does not wait for #48: the result text above stands on its own.
5. **Setting.** `cmsis-developer-assistant.build.diagnosticRerun` (boolean, default `true`, window scope) switches stage B off. Stage A always runs, since it only reads a file.
6. **Budget.** No new tool and no new parameter, so no bytes in `tools/list`. The fix changes result text only. `get_build_diagnostics` stays opt-in.
7. **Retirement.** Stage B is interim. It is replaced when CMSIS Solution offers a `log` task-definition property or a "last build output" command; that request goes to the owners through #21 (WP-Q).

## What changes for the agent and the user

```text
Before:
  ❌ CMSIS 'build' FAILED on MPS3 — task 'cbuild …' exited with code 2. Open the CMSIS/cbuild terminal or the
  Problems panel to read the compiler/linker errors …
  → the agent reruns cbuild in a shell to see the error (#50's bypass)
After:
  ❌ … exited 2 after 48 s.
  2 errors (from a diagnostic re-run …): Blinky/main.c:42:5 error: 'ledx' undeclared …
  → the agent opens main.c:42
```

The user sees one extra `cbuild` process for a few seconds after a failed build. It does not appear in the terminal, and its log is in `out/`.

## Decisions for you

- [ ] **Diagnostic re-run on by default.** **Recommended:** yes. It runs only after a failure, it is incremental, and it removes the main reason agents run cbuild in a shell. Alternative: off by default, like `buildInfo.enabled`; that is safer on slow machines, but most agents would never see an error line.
- [ ] **Re-run arguments.** **Recommended:** mirror the task definition minus `--packs`, `--update-rte`, `--clean` and `--rebuild`, and add `--skip-convert` when csolution already ran. Alternative: the exact same arguments plus `--log`, which reproduces faithfully but may download packs and rewrite RTE files a second time.
- [ ] **Log location.** **Recommended:** `<solutionDir>/out/cmsis-developer-assistant/build-diagnostic.log`, which is git-ignored by the generated `.gitignore` and found by `get_build_diagnostics`. Alternative: the extension's `globalStorage`, which never touches the workspace but cannot be read by `get_build_diagnostics`, whose reads are limited to the workspace.
- [ ] **Stage A without stage B.** **Recommended:** ship both together in 2.3.12. Alternative: ship stage A (cbuild-idx messages, no process) in 2.3.11 with WP-B, since it is small and pure. It covers pack, component and schema errors, but not compile errors.

## Tests and acceptance

- **Unit tests** in `src/test/buildFailure.test.ts`:
  - `idxMessages` on the corstone-blinky `Blinky.cbuild-idx.yml` (two errors, four warnings);
  - `cbuildDiagnosticArgs` against a table of task definitions, including `outputDirectory` and `toolchain`, with and without `--skip-convert`;
  - `readToolsEnvironment` on a fixture copied from a real `.cmsis/tools-environment.yml`, with paths anonymised, including a Windows variant;
  - `renderBuildFailure` on a failing GCC plus ninja fixture log added under `src/test/fixtures/buildinfo/`.
- **Runner tests** in `src/test/cmsisBuildDiagnosis.test.ts`:
  - with a fake spawn: a build start kills the child, and the 120 s cap is enforced;
  - no re-run without the environment file.
- **Spike first.** Confirm that `cbuild … --skip-convert --log <file>` still runs cbuild2cmake, CMake and ninja, and that the log carries the compiler lines. Confirm that the environment from `tools-environment.yml` plus `CMSIS_PACK_ROOT` reproduces the extension's build on macOS and Windows.
- **Live, FVP corstone-blinky.** Introduce a compile error: the `cmsis_action build` result shows file:line within the call. Remove a pack from `CMSIS_PACK_ROOT`: stage A reports the missing component without a re-run.
- **Live, probe board.** The Alif E8 ExecuTorch example with its model-export venv missing reproduces the issue's `FAILED: … model_pte.h` ninja line.

## Out of scope and follow-ups

- **Reading the terminal.** A pseudoterminal is not readable, and `onDidWriteTerminalData` is a proposed API that marketplace extensions cannot use.
- **Problem matchers.** CMSIS Solution's missing problem matchers (#21 B2 and B8) are the owner's to fix. With them, the Problems panel and #48's `problems` source would carry the same lines.
- **Load, Erase and Run output.** It would need a log option in the CMSIS task templates.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
