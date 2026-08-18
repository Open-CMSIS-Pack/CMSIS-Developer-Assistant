# Real-board test driver

End-to-end test that exercises every MCP tool exposed by `cmsis-developer-assistant`
against a live target (e.g. Alif AppKit-E8).

## What it does

1. Connects to the running MCP server over Streamable HTTP.
2. Runs each tool in dependency order (no-session → start → inspect → step →
   serial → teardown).
3. **Pre-flight estimate** — every test declares an `estimatedMs`; the
   harness derives a hard timeout `min(2·estimatedMs, 60 s)`. Any test whose
   estimate exceeds 60 s is skipped up front.
4. **Hard cap** — no single tool call can run longer than 60 s. Period.
5. **Pause + diagnose on overshoot** — when a hard timeout fires, the driver
   pauses, calls `get_session_status`, `check_target_connection` and
   `get_fault_info`, prints the diagnostic, and either continues or aborts
   (configurable).

## Setup

```bash
cd DebugMCP
cp test/realboard/realboard.config.example.json test/realboard/realboard.config.json
# edit test/realboard/realboard.config.json — see fields below
```

Make sure the VS Code window with `cmsis-developer-assistant` installed is running and
note the port (the activation log prints `CMSIS Developer Assistant server running on
http://localhost:<port>`). Put that in `endpoint`.

## Run

```bash
# Uses test/realboard/realboard.config.json by default.
npx tsx test/realboard/run.ts

# Or pass an explicit config path:
npx tsx test/realboard/run.ts ./my-other-board.json
```

Add `tsx` as a dev dependency if not already installed:

```bash
npm install --save-dev tsx
```

## Config fields

| Field                        | Purpose                                                              |
|------------------------------|----------------------------------------------------------------------|
| `endpoint`                   | MCP server URL, e.g. `http://localhost:3001/mcp`                     |
| `configurationName`          | launch.json config name (used when `preferCmsisLoadAndDebug=false`)  |
| `workingDirectory`           | Workspace folder containing the launch.json                          |
| `breakpoint.fileFullPath`    | Source file to set a test breakpoint in                              |
| `breakpoint.lineContent`     | Line content (substring) to match for the breakpoint                 |
| `memoryProbe`                | `{address, length}` in a known-readable region (e.g. SRAM)           |
| `peripheralProbe`            | `{peripheral, register?}` — peripheral name from the SVD             |
| `evaluateProbe.expression`   | Expression to test `evaluate_expression` (e.g. `$pc`)                |
| `serial.path`                | Device path, e.g. `/dev/tty.usbmodemAlif` or `COM3`                  |
| `serial.baudRate`            | Optional baud rate (default 115200)                                  |
| `serial.skipIfMissing`       | If true, serial tests skip cleanly when the port doesn't exist       |
| `preferCmsisLoadAndDebug`    | Use `cmsis_action load_and_debug` instead of `start_debugging`       |
| `globalCapMs`                | Hard cap per tool call (clamped to 60 000)                           |
| `abortOnFirstFailure`        | Stop on the first failure instead of continuing                      |

## Output

- Live PASS/FAIL/SKIP lines with durations.
- Inline diagnostic dump after every overshoot.
- JSON report dropped at `test/realboard/realboard.report.<timestamp>.json`.

Exit code is 0 on all-green, 1 if any test failed, 2 on driver crash.

## Why the 60 s cap exists

These are the strategies for any agent driving the MCP:

  a) **Estimate first** — every tool call has a rough expected runtime.
  b) **If estimate > cap, refuse to start** — don't get stuck on a probe
     that was always going to take too long. Decompose the work or pick a
     different approach.
  c) **On overshoot, pause and check status** — never silently keep waiting.
     The probe might be wedged, the target might have hit a fault, or the
     session might have ended. Always run `get_session_status` /
     `check_target_connection` / `get_fault_info` before deciding what to
     do next.

Embedded targets fail in ways that look identical to "still running"; the
only safe behaviour is to bound every wait and check explicitly.
