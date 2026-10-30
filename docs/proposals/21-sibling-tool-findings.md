# #21 Tracking: studio-test findings that belong to sibling CMSIS tools (CMSIS Solution, CMSIS Debugger, rtos-views, SDS, Toolbox, example)

> **2.7.0 status (2026-10-27).** These are historical findings and draft messages, not evidence that requests were sent or remain open. External issue and owner status must be checked before any follow-up. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#21](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/21) |
| Area · priority · source | Sibling tools · Low (proposed) · Studio test |
| Original release plan | none, do now (WP-Q) |
| Size | S |
| Depends on | none |
| Related | #15, #48, #41, #13, #11 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

Issue #21 parks studio-test findings (2026-08-21) that are not in this extension's code, so they can be forwarded and #21 closed. Nothing has been forwarded yet. Every owner has a public GitHub tracker; the example project belongs to the maintainer. Two findings have moved since the test: SDS-Framework released v3.1.0 on 2026-08-27, and the `sdsio_server_usb.py` script named in B7 is no longer on SDS `main`. The "fix" is: re-check each item on the current sibling version, file one short issue per owner, link them on #21, close #21.

## Current state (2.3.10)

- Trackers, all checked with `gh repo view` (public, issues enabled):

  | Owner | Tracker | How verified |
  |---|---|---|
  | CMSIS Solution (Arm.cmsis-csolution) | [Open-CMSIS-Pack/vscode-cmsis-solution](https://github.com/Open-CMSIS-Pack/vscode-cmsis-solution/issues) | `bugs.url` in the 1.70.1 `package.json`; `gh repo view` |
  | CMSIS Debugger (Arm.vscode-cmsis-debugger) | [Open-CMSIS-Pack/vscode-cmsis-debugger](https://github.com/Open-CMSIS-Pack/vscode-cmsis-debugger/issues) | `bugs.url` in the 1.8.0 `package.json` |
  | cdt-gdb-adapter (under the CMSIS Debugger) | [eclipse-cdt-cloud/cdt-gdb-adapter](https://github.com/eclipse-cdt-cloud/cdt-gdb-adapter/issues) | `gh repo view` |
  | rtos-views (mcu-debug.rtos-views 0.0.16) | [mcu-debug/rtos-views](https://github.com/mcu-debug/rtos-views/issues) | `gh repo view` |
  | SDS-Framework | [ARM-software/SDS-Framework](https://github.com/ARM-software/SDS-Framework/issues) | `gh repo view`; tags v3.1.0 (2026-08-27), v3.0.0 |
  | CMSIS-Toolbox | [Open-CMSIS-Pack/cmsis-toolbox](https://github.com/Open-CMSIS-Pack/cmsis-toolbox/issues) | `gh repo view` |
  | Example (cmsis-executorch-simple) | [MatthiasHertelArm/cmsis-executorch-simple](https://github.com/MatthiasHertelArm/cmsis-executorch-simple) | `gh search repos`; Corstone-320 only |
  | Example test copy (CDA-Testdrive) | [MatthiasHertel80/CDA-Testdrive](https://github.com/MatthiasHertel80/CDA-Testdrive) | local clone's `origin`; carries `board/Alif-E8` and SDS |

- Re-checked facts:
  - B2/B8 still hold on CMSIS Solution 1.70.1 (the build installed here, `1.70.1-63-20260910`): `contributes.problemMatchers` is absent, and the `cmsis-csolution.build` task definition has only `solution`, `clean`, `downloadPacks`, `schemaCheck`, `buildOutputVerbosity`, `intermediateDirectory`, `outputDirectory`, `cmakeTarget`, `generator`, `rebuild`, `setup`, `jobs`, `updateRte`, `toolchain` and `active`, with no log property. That is the #15 ask.
  - C2: this extension still issues no DAP `disconnect`; it calls `vscode.debug.stopDebugging` once ([debuggingExecutor.ts:258-267](../../src/debuggingExecutor.ts#L258-L267)).
  - C1: our UI fallbacks run `workbench.action.debug.*` commands ([debuggingExecutor.ts:282-387](../../src/debuggingExecutor.ts#L282-L387)), whose errors VS Code shows as notifications; #13 (WP-C, 2.3.11) removes them for `gdbtarget`, so our share of the toasts goes away. The truncated text itself remains a CMSIS Debugger (or cdt-gdb-adapter) presentation issue.
  - No duplicates found by `gh search issues` in the CMSIS Solution, CMSIS Debugger or rtos-views trackers. Closest: vscode-cmsis-solution #251 "Improve Problems output" (closed) and #483 "Provide `.cmsis/tools-environment.yml`" (closed, the data source #17 uses).

## Proposed fix

1. **Re-check** B1, C6 on CMSIS Solution 1.70.1, C1/C2 on CMSIS Debugger 1.8.0 and B7/D1-D3 on SDS v3.1.0 with the CDA-Testdrive project, and drop what no longer reproduces.
2. **File** the issues below. The texts are short on purpose; each gets the reproduction data (versions, project, log excerpt) the owner's template asks for.
3. **Fix the example directly**: both example repositories are the maintainer's, so B4, B9 and D4 are commits, not issues.
4. **Comment on #21** with the links (draft at the end) and close it. B7 is dropped if the re-check shows v3.1.0 fixed it.

### CMSIS Solution: Open-CMSIS-Pack/vscode-cmsis-solution

| Item | Summary |
|---|---|
| B1 | One root cause in `*.cproject.yml` gives three Problems markers (`cproject not parsed`, `yaml-schema: connections:`, `schema check failed, verify syntax` at Ln 37 Col 7), none naming the offending key |
| B2 / B8 | cbuild, ninja and compiler errors and warnings never reach Problems: no problem matcher for the `cmsis-csolution.build` task |
| B6 | Scatter / memory-region overflow arrives as a raw linker error |
| C6 | Problems count grows 3 → 4 during a session; stale markers survive rebuilds |
| #15 ask | A way for other extensions to read the build output: a `log` property on the task definition, or a `cmsis-csolution.getLastBuildOutput` command |
| #48 ask | A `cmsis-csolution.getRecentProblems` command returning recent errors and warnings (the record format of #48) |

Draft issue 1 (bug):

```markdown
Title: Build errors never reach the Problems panel; schema errors are reported three times; stale markers

Seen with CMSIS Solution 1.70.x on macOS, CMSIS-Toolbox 2.x, project <link>.
- cbuild/ninja/compiler errors and "N warnings generated." appear only in the terminal. The extension contributes no
  problemMatchers for the `cmsis-csolution.build` task, so Problems stays empty for build errors.
- A linker memory-region / scatter overflow appears as the raw linker message; a short diagnostic naming the region
  and the overflow would help.
- One YAML mistake in a *.cproject.yml gave three markers (cproject not parsed; yaml-schema: connections:; schema
  check failed, verify syntax at Ln 37 Col 7); none names the offending key.
- The Problems count grew 3 -> 4 across rebuilds; markers of fixed errors stayed.
```

Draft issue 2 (feature request):

```markdown
Title: Commands for tool integrations: last build output and recent problems

CMSIS Developer Assistant runs builds through `cmsis-csolution.build` for AI agents and cannot read their output:
the task is a CustomExecution pseudoterminal with no problem matcher and no log option, and VS Code offers no API to
read another extension's terminal or notifications. Two small commands would close this:
1. `cmsis-csolution.getLastBuildOutput` (or a `log: <path>` property on the build task definition): the last build's
   exit code, error and warning lines with file:line, and the log path.
2. `cmsis-csolution.getRecentProblems`: recent errors and warnings the extension showed (build, pack resolution,
   schema), as {time, severity, code?, message, location?}.
Both are read-only. Context: Open-CMSIS-Pack/CMSIS-Developer-Assistant#15 and #48.
```

### CMSIS Debugger: Open-CMSIS-Pack/vscode-cmsis-debugger

| Item | Summary |
|---|---|
| C2 | Two `disconnect` / `Ending remote debugging.` pairs per teardown in the Debug Console, although the client stops the session once |
| C1 | The "Cannot execute this command while the target is running. Use the …" notification is cut off, so the remedy is unreadable |
| #48 ask (optional) | `cmsis-debugger.getRecentProblems`, same shape as the CMSIS Solution command |

```markdown
Title: Double disconnect on teardown; "target is running" notification truncated

CMSIS Debugger 1.8.0, gdbtarget with pyOCD, macOS.
- One vscode.debug.stopDebugging() call produces two "disconnect" / "Ending remote debugging." pairs in the Debug
  Console. (If this comes from cdt-gdb-adapter, please move it there.)
- GDB's multi-line "Cannot execute this command while the target is running. Use the "interrupt" command ..." is
  shown as a notification cut after the first line, so the remedy is not visible.
Optional, for Open-CMSIS-Pack/CMSIS-Developer-Assistant#48: a read-only `cmsis-debugger.getRecentProblems` command.
```

### rtos-views: mcu-debug/rtos-views

| Item | Summary |
|---|---|
| C4 | "RTX5 detected." followed at once by "No RTX5 threads detected …" in the XRTOS panel; the table fills later |

```markdown
Title: RTX5: "No RTX5 threads detected" shown right after "RTX5 detected", table fills later

rtos-views 0.0.16, CMSIS Debugger (gdbtarget), RTX5 application halted at a breakpoint. The panel first prints
"RTX5 detected." and immediately "No RTX5 threads detected ...", then populates the thread table on a later refresh.
Looks like a refresh/timing issue: the thread list is read before the RTX5 symbols/memory are available.
```

### SDS-Framework: ARM-software/SDS-Framework

| Item | Summary |
|---|---|
| B7 | `ARM::SDS@3.1.0-dev` was only on `main` with no tag; the USB SDSIO server raised `FileNotFoundError` when its glob missed. v3.1.0 now exists and the script is `utilities/sdsio-server.py`: re-check, and keep only the "print the searched paths and the resolved pack version" part if it still applies |
| D1 | The fixed 3 s SDSIO startup handshake expires when the host server is not running yet or macOS USB configuration is still in progress |
| D2 | The E8 board layer selects the high-speed USB controller while the generated SDS configuration forces full-speed (owner to confirm whether the layer is SDS's or the example's) |
| D3 | DWC3 endpoint armed but DMA never consumes the OUT TRB; SDS bulk buffer vs the protected DTCM USB region; missing 76.8 MHz I²S clock (partly Alif's DFP/driver) |

```markdown
Title: SDSIO over USB on Alif E8: fixed 3 s handshake, HS/FS mismatch, DWC3 OUT transfers never complete

SDS <version after re-check>, Alif AppKit-E8, macOS host.
- The SDSIO startup handshake has a fixed 3 s timeout; it expires when the host server starts later or while macOS is
  still configuring the USB device. A configurable timeout or a retry would help.
- The board layer selects the high-speed controller; the generated SDS configuration overrides it to full-speed.
- The DWC3 OUT endpoint is armed but DMA never consumes the TRB; the SDS bulk buffer may sit in the DTCM region the
  USB DMA cannot reach. A 76.8 MHz I2S clock was also missing (possibly Alif DFP).
- (If still present in v3.1.0) the SDSIO server should print the searched paths and resolved pack version when it
  cannot find its input, instead of a bare FileNotFoundError.
```

### CMSIS-Toolbox: Open-CMSIS-Pack/cmsis-toolbox

| Item | Summary |
|---|---|
| B5 | With only the E8 packs selected, the solution's MLOps simulator metadata still referenced the SSE-320 board; an explicit solution dependency was needed to resolve both contexts |

```markdown
Title: MLOps metadata references a board whose packs are not selected

csolution with two target-types (Alif E8, Corstone-320 SSE-320 FVP) and an mlops: node. With only the E8 packs
selected, the generated MLOps simulator metadata still referenced the SSE-320 board, and the solution did not
resolve until an explicit solution-level dependency was added. Expected: metadata only for the selected
target-type, or a clear message naming the missing pack. Reproduction: <link to CDA-Testdrive commit>.
```

### Example project: the maintainer's repositories

| Item | Repository | Fix |
|---|---|---|
| B4 | cmsis-executorch-simple (inherited by CDA-Testdrive) | `scripts/run_export.cmake` fails early with "run *Setup Python virtual environment* first" when `.venv` is missing, instead of B2's ninja failure; README says the venv is needed for the FVP target too |
| B9 | cmsis-executorch-simple | Pin torch / ExecuTorch in `requirements-executorch.txt` and silence known deprecation warnings in the export step |
| D4 | CDA-Testdrive (`board/Alif-E8`) | README note: switch `SW4` must be in position `U4` for the PRG USB VCOM to reach UART4 |

### Not actionable

C5 (target parked in `osRtxIdleThread`: the firmware never reached the breakpoints, and the recovery section said so) and E2 (diff volume without checkpoints is the agent harness's UX) are closed with #21, with no forward.

Draft closing comment on #21:

```markdown
Forwarded:
- CMSIS Solution: <link issue 1> (B1, B2/B8, B6, C6), <link issue 2> (build output and recent-problems commands; #15, #48)
- CMSIS Debugger: <link> (C1, C2)
- rtos-views: <link> (C4)
- SDS-Framework: <link> (D1-D3; B7 re-checked on v3.1.0: <dropped | included>)
- CMSIS-Toolbox: <link> (B5)
- Example: fixed in MatthiasHertelArm/cmsis-executorch-simple@<sha> (B4, B9) and MatthiasHertel80/CDA-Testdrive@<sha> (D4)
Not actionable: C5, E2. Our own halves: #15 and #48 (2.3.12), #13 (2.3.11). Closing.
```

## What changes for the agent and the user

```text
before  findings live only in #21; sibling owners do not know about them; #21 stays open on the board
after   one issue per owner (two for CMSIS Solution), the example fixed in place, #21 closed with the links;
        our #15/#48 work can later switch from the diagnostic re-run to the CMSIS Solution commands if they are adopted
```

## Decisions for you

- [ ] **One issue or two for CMSIS Solution?** **Recommended:** two, a bug (B1, B2/B8, B6, C6) and a feature request (#15 and #48 commands). Different templates and probably different reviewers; the feature request is what our 2.3.12 interim waits for. Alternative: one combined issue, which is fewer links but mixes bug triage with an API discussion.
- [ ] **Include the #48 command ask for the CMSIS Debugger?** **Recommended:** yes, as an optional line. #48 phase 3 names both extensions, and asking once now is cheaper than a second round. Alternative: only CMSIS Solution now (the plan's WP-Q list), CMSIS Debugger later with #48 phase 3.
- [ ] **Who files?** **Recommended:** the maintainer files from their own account after the re-check, because the owners know the maintainer and the studio-test context. Alternative: a colleague who ran the studio test files the SDS and example items.

## Tests and acceptance

- Each forwarded item is re-checked on the version named in its issue (CMSIS Solution 1.70.1, CMSIS Debugger 1.8.0, SDS v3.1.0) or dropped.
- Every issue link is posted on #21; #21 is closed; the board item gets no version (plan: "none, do now").
- The example commits reference #21 in their messages.

## Out of scope and follow-ups

- Our halves stay here: #15 and #48 (2.3.12, WP-H), #13 (2.3.11, WP-C).
- When CMSIS Solution adopts a build-output or recent-problems command, WP-H's interim "diagnostic re-run of cbuild" is replaced (tracked in #15).
- A shared record format for sibling problem feeds (#48's open question on who owns the `code` vocabulary) is a follow-up with #41.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
