# Agent evaluation scenarios

`npm run eval:scenario -- <id>` runs a real agent (GitHub Copilot CLI, or Kimi Code with
`--agent kimi`) on a firmware bug planted in a small csolution, with the `cmsis-help` skill
and the CMSIS Developer Assistant MCP server, and reports what the investigation cost and whether the agent found
the root cause. It turns "this change made the HardFault case take 9 calls and 40 kB
instead of 15 and 120 kB" into a number you can quote in an issue.

```text
npm run eval:scenario -- --list
npm run eval:scenario -- divide-by-zero [--agent copilot|kimi] [--model ALIAS] [--target fvp|board]
                                        [--endpoint http://localhost:3001/mcp] [--runs 3] [--wait-for-window 120]
                                        [--rules] [--keep] [--no-mcp-config]
```

It is opt-in and never part of `npm test` or CI: it needs an authenticated agent CLI
(spends AI credits), a VS Code window with the extension active on the work directory,
and a Corstone-300 FVP (Docker on macOS) or a board. Failures of that infrastructure are
reported as `infra_error`, not as the agent's failure.

## What a run does

1. Materialises `fixtures/<fixture>/` plus `overlays/<scenario>/` into `.work/<id>/` and
   installs `skills/cmsis-help` under `.work/<id>/.agents/skills/`. The agent never
   sees the overlay mechanism, only a project with a bug in it. With `--rules` the tool rules
   go into `.work/<id>/AGENTS.md` between their marker comments, written by the same code as
   step 2 of *Configure Agent*.
2. Registers the MCP server in `$COPILOT_HOME/mcp-config.json` (restored afterwards; skip
   with `--no-mcp-config` when it is already registered).
3. Checks with `list_debug_windows` that a VS Code window has the work directory open —
   that window runs the debug session the agent drives. `--wait-for-window N` polls for N
   seconds instead of failing at once. Then activates the work copy's solution there with
   `cmsis_action open_solution`, retrying for up to a minute (or N seconds): step 1 has just
   replaced the folder that window has open, and until CMSIS Solution has seen the new files
   it lists no solution, so the agent would start in a window without one.
4. Snapshots `cmsis-developer-assistant://stats`, runs
   `copilot -p "<prompt>" --output-format json …`, keeps the raw event stream in
   `reports/events.<id>.<time>.<run>.jsonl`, snapshots again. The run passes
   `--no-custom-instructions` unless `--rules` is given; then Copilot CLI reads the work
   copy's `AGENTS.md`, and also your own user-level instructions
   (`$COPILOT_HOME/copilot-instructions.md`), so compare runs on a machine where that file
   does not differ between them.
5. Judges: the final answer must match `expectedRootCause`; tool calls, turns and wall time
   must stay within `budgets`; nothing in `forbidden` may appear (by default the agent must
   not reach for `add_logpoint` / `printf` — the point of the skill); no shell command may
   bypass the MCP tools (see below). The verdict and the numbers go to
   `reports/eval.<id>.<time>.json`; `--runs N` repeats and reports each run, because a
   model's path is not deterministic.

## Kimi Code

`--agent kimi` runs `kimi -p "<prompt>" --output-format stream-json --skills-dir
.work/<id>/.agents/skills` in the work copy (`$KIMI_BIN`, else `$KIMI_CODE_HOME/bin/kimi`,
else `kimi` on PATH; `--model` picks a model alias of Kimi's `config.toml`). Print mode
approves every tool call itself. What differs from a Copilot run:

- The server goes into the work copy's `.kimi-code/mcp.json`, with the entry *Configure
  Agent* writes (`url` and `toolTimeoutMs`); `KIMI_CODE_TRUST_WORKSPACE=1` lets the headless
  run read it, and it wins over an entry of the same name in `~/.kimi-code/mcp.json`. Your
  own files are not touched.
- The work copy becomes a git repository of its own, so that Kimi reads its `AGENTS.md`
  (with `--rules`) and none of this repository's. Kimi has no switch for the user-level
  `~/.kimi-code/AGENTS.md` and `~/.agents/AGENTS.md`; the runner names them when they
  exist, since rules in them make a run without `--rules` one with rules.
- Each stream line is a chat message: an assistant message per model step (a turn), with
  its tool calls, and a tool message per result (`aggregateKimiStream`). Token usage comes
  from the session's own log under `$KIMI_CODE_HOME/sessions/`, found by the session id
  the stream's resume hint names (`sumKimiUsage`). The shell tool is `Bash`.
- Kimi ends a tool call after 60 s unless the entry says otherwise, and does not reconnect
  to a server that was down when it started: the window must serve before the run.

## Shell bypasses

The tool rules (`docs/agent-resources/tool-contract.md`, #50) keep agents on the MCP tools
instead of `pyocd`, `gdb` or `cbuild` in a shell. Every scenario checks that:

- The commands of the shell tools — `bash` and `powershell` with their `command`, `write_bash`
  and `write_powershell` with their `input`, Kimi Code's `Bash` with its `command` — are matched against a default deny list:
  `pyocd`, `arm-none-eabi-gdb`, `gdb-multiarch`, `JLinkExe`, `JLinkGDBServer…`, `openocd`,
  `cbuild` (not `….cbuild-run.yml` and other file names), `cpackget`, `pip install` /
  `pip3 install`, `curl` against `localhost` or `127.0.0.1`, and the simulated board: an
  `FVP_…` model, the fixture's `fvp.sh`, and `docker run`/`rm`/`kill`/`stop`/`start`/`exec`
  (`DEFAULT_SHELL_DENY_LIST` in `src/core/evalScenario.ts`). The names of the shell tools
  follow Copilot CLI's hook documentation; check them against the first recorded stream.
- `forbidden.shell` adds a regex of the scenario's own; `"defaultShellDenyList": false`
  switches the default list off for a scenario that runs such a command on purpose.
- `forbidden.toolArgs` is matched against every other tool call only — MCP tools, skills,
  file edits — so an MCP `flash` call whose arguments name `app.cbuild-run.yml` is no bypass.
- Each run in the report lists its `bypasses` (tool, command, which rule caught it) and
  their count; the report gives the `bypassRate` of the scenario: the share of judged runs
  (infrastructure failures left out) with at least one bypass. Run a scenario with and
  without `--rules` to see what the rule file changes.

A compaction forced in the middle of a run is not part of it: Copilot CLI documents
`/compact` as an interactive command and nothing that triggers it in `-p` mode.

## Preparing the target

**FVP (reference).** The fixture is the BSP Blinky for the Corstone-300 FVP
(`FVP_Corstone_SSE-300_Ethos-U55`, Cortex-M55; MDK FVP models ≥ 11.32.23 ship the
GDBServer plugin the CMSIS Solution extension drives). Once per machine:

1. Open `.work/<id>/` (run once with `--keep`, or copy the fixture yourself) in VS Code
   with the CMSIS Solution and CMSIS Developer Assistant extensions. The fixture brings its
   `.vscode/launch.json` with the readiness fixes (`"port": ""`, `serverPortRegExp`,
   `portDetectionTimeout`, `"updateConfiguration": "manual"`), the model shim
   `.vscode/fvp.sh` and, for macOS, `.vscode/fvp.Dockerfile`.
2. On macOS `docker info` must work: `fvp.sh` builds the model image on first use
   (default release 11.32.23; `FVP_VERSION` overrides it) and mounts the Arm user-based
   licence in `~/.armlm`. On Linux and Windows, install the compatible MDK FVP separately
   and put `FVP_Corstone_SSE-300_Ethos-U55` on PATH, or set `FVP_MODEL` to its executable.
   The fixture's `vcpkg-configuration.json` does not install a model. Windows also needs
   a shell that can run the fixture's Bash shim.
3. Let the Arm Tools Environment Manager activate `vcpkg-configuration.json` in that window
   (CMSIS Solution then writes `.cmsis/tools-environment.yml`), and build once
   (`cmsis_action build`, or the CMSIS panel) so the cbuild-run file and the ELF exist. The
   fixture carries its RTE configuration files, so a clean copy builds without an RTE update.
4. Maintainers can verify the adapter's readiness handshake after that build. From
   `test/eval/.work/<id>/`, run `python3 ../../fixtures/verify-launch.py` with the CMSIS
   Debugger's `arm-none-eabi-gdb` on PATH and no session using the model. For a work copy
   elsewhere, use the helper's absolute repository path. It starts the model, drives GDB
   and tears the model down; it is a maintainer test utility, not an agent recovery
   bypass. Agents use the CMSIS MCP tools unless the user explicitly requests this test.

On the FVP a fault scenario reaches `diagnose_fault` only through a breakpoint on the fault
handler: the model's GDB server ignores GDB's interrupt, so `pause_execution` cannot stop a
model that spins in `HardFault_Handler`. The scenario's path is `load_and_debug`,
`add_breakpoint` on `HardFault_Handler` (in `startup_SSE300MPS3.c`), `continue_execution`,
then `diagnose_fault`; the `load_and_debug` reply on an FVP says to set breakpoints first.
`fvp.sh` refuses a GDB port that another folder's model or another program (a board's pyOCD
under CMSIS Run, for example) already listens on, and the extension refuses such a launch
before it starts. A launch or stop that hangs leaves the adapter's log in
`tmp/gdb-adapter.log` of the work folder.

**Board.** Point the same csolution at your hardware (a second target-type with its own
`target-set` debugger) and pass `--target board`; scenarios list which targets they suit.

## Scenarios

| id | planted bug | expects |
|----|-------------|---------|
| `divide-by-zero` | `delay_ms / blink_divider` with the divider 0 and `DIV_0_TRP` set | UsageFault `DIVBYZERO`, the variable named |
| `undefined-instruction` | a handler-table slot pointing into a RAM buffer of `0xDE` bytes | `UNDEFINSTR`, execution left the code region, the table named |
| `stack-overflow` | a recursive pattern parser that never advances, with `MSPLIM` set | `STKOF`, the function named |
| `unaligned-access` | a `uint32_t` read at `buf + 1` with `UNALIGN_TRP` set | `UNALIGNED`, the expression named |
| `led-off-by-one` | `1 << led_port_bit_length` — mask one bit too wide, `set_led_port` rejects it; **no fault** | the off-by-one, found by breakpoint and inspection |
| `flash-image-missing` | no bug: `flash-check/Blinky+MPS3.cbuild-run.yml` names an image no build produces, so `flash` fails (on the FVP pyOCD also finds no probe) | the agent stops and reports the failure, runs nothing from the deny list and does not claim success |

The five bug scenarios reproduce on the FVP; a peripheral clock-gating bug does not (the
model does not gate clocks) and would be a board-only scenario. `flash-image-missing` makes a
tool fail through the fixture alone, with no test hook in the extension, to check that an
agent follows the tool contract: after the same failure twice, consult
`get_session_status` and `get_recent_problems`, and report what no tool can resolve
instead of reaching for `pyocd` in a shell.

## Adding a scenario

Create `overlays/<id>/…` under the fixture with the files that replace the base (whole
files; keep the Arm header, no comments that give the bug away) and
`scenarios/<id>.json`:

```json
{
  "id": "…", "prompt": "…", "fixture": "corstone-blinky", "overlay": "overlays/…",
  "targets": ["fvp", "board"],
  "expectedRootCause": "regex the final answer must match",
  "expectedTools": ["diagnose_fault"],
  "forbidden": { "toolArgs": "add_logpoint|printf", "shell": "optional regex", "defaultShellDenyList": true },
  "budgets": { "maxToolCalls": 25, "maxTurns": 15, "maxWallMs": 900000 },
  "rootCause": "for the report reader only"
}
```

`src/test/evalScenario.test.ts` validates every scenario file and exercises the pure logic
(`src/core/evalScenario.ts`), with a synthetic Kimi stream in
`src/test/fixtures/kimi-stream.sample.jsonl` written from Kimi Code's source; the Copilot
event shapes it understands were written from
`tool.execution_start` plus defensive guesses — the report lists `unknownEventTypes` so the
aggregator can be refined from a recorded stream.
