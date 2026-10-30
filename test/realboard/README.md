# Real-board test driver

A live-target smoke test for the debugger tools exposed by
`cmsis-developer-assistant` (e.g. on an Alif AppKit-E8). It covers session
startup, state, variables, memory, registers, faults, breakpoints, stepping
and the command that opens the Serial Monitor UI. It does not cover the
documentation, build-artefact or knowledge tools, or direct serial I/O.

Use a dedicated test workspace: the driver clears all breakpoints, restarts
the target and stops the session during its sequence.

## What it does

1. Connects to the running MCP server over Streamable HTTP.
2. Runs its selected checks in dependency order (no-session → start → inspect
   → step → Serial Monitor UI → teardown).
3. **Pre-flight estimate** — every test declares an `estimatedMs`; the
   harness derives a hard timeout `min(2·estimatedMs, 60 s)`. Any test whose
   estimate exceeds 60 s is skipped up front.
4. **Harness wait cap** — the driver waits at most 60 s for a tool call.
   This does not cancel work still running in the extension.
5. **Pause + diagnose on overshoot** — when a hard timeout fires, the driver
   pauses, calls `get_session_status`, `check_target_connection` and
   `get_fault_info`, prints the diagnostic, and either continues or aborts
   (configurable).

## Setup

```bash
cd CMSIS-Developer-Assistant
cp test/realboard/realboard.config.example.json test/realboard/realboard.config.json
# edit test/realboard/realboard.config.json — see fields below
```

Open the test workspace in VS Code with `cmsis-developer-assistant` active.
Use its configured MCP port (3001 by default) in `endpoint`, including the
`/mcp` path. The CDA status-bar item and output channel show the server state.

## Run

```bash
# Uses test/realboard/realboard.config.json by default.
npx tsx test/realboard/run.ts

# Or pass an explicit config path:
npx tsx test/realboard/run.ts ./my-other-board.json
```

Install the repository dependencies first; `tsx` is already a development dependency.

## Config fields

| Field                        | Purpose                                                              |
|------------------------------|----------------------------------------------------------------------|
| `endpoint`                   | MCP server URL, e.g. `http://localhost:3001/mcp`                     |
| `configurationName`          | launch.json config name (used when `preferCmsisLoadAndDebug=false`)  |
| `workingDirectory`           | Workspace folder containing the launch.json                          |
| `breakpoint.fileFullPath`    | Source file to set a test breakpoint in                              |
| `breakpoint.lineContent`     | Legacy substring locator used by this driver; the tool also supports the preferred numeric `line` |
| `memoryProbe`                | `{address, length}` in a known-readable region (e.g. SRAM)           |
| `peripheralProbe`            | `{peripheral, register?}` — peripheral name from the SVD             |
| `evaluateProbe.expression`   | Expression to test `evaluate_expression` (e.g. `$pc`)                |
| `preferCmsisLoadAndDebug`    | Use `cmsis_action load_and_debug` instead of `start_debugging`       |
| `globalCapMs`                | Hard cap per tool call (clamped to 60 000)                           |
| `abortOnFirstFailure`        | Stop on the first failure instead of continuing                      |

## Output

- Live PASS/FAIL/SKIP lines with durations.
- Inline diagnostic dump after every overshoot.
- JSON report dropped at `test/realboard/realboard.report.<timestamp>.json`.

Exit code is 0 on all-green, 1 if any test failed, 2 on driver crash.

## Why the 60 s cap exists

The following is this smoke-test driver's policy. The extension itself permits
longer waits for CMSIS actions, flash and documentation indexing; see the
[user guide](../../docs/user-guide.md).

  a) **Estimate first** — every tool call has a rough expected runtime.
  b) **If estimate > cap, refuse to start** — don't get stuck on a probe
     that was always going to take too long. Decompose the work or pick a
     different approach.
  c) **On overshoot, pause and check status** — never silently keep waiting.
     The probe might be wedged, the target might have hit a fault, or the
     session might have ended. Always run `get_session_status` /
     `check_target_connection` / `get_fault_info` before deciding what to
     do next.

A harness timeout is not proof that the target failed or the operation was
cancelled. Check the session and any CMSIS job result before retrying work.
