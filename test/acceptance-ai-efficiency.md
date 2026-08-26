# Acceptance test — AI-efficiency work (2.3.5 → WP7)

Exercises what `npm test` cannot: the new tools against a live target, what an agent sees,
and the evaluation runner. One pass takes ~45 min on an FVP, less on a board. Record the
numbers you get in the *Result* column of §6 — they are the before/after for #18 and #23.

**Needs:** the branch built and installed (`npm run package` → install the VSIX, reload the
window); a csolution open in VS Code — the FVP fixture `test/eval/fixtures/corstone-blinky`
(see `test/eval/README.md`, apply the two launch.json fixes) or any board project; an MCP
client (Copilot Chat, Claude Code, Codex) registered against `http://localhost:3001/mcp`.

## 0. Automated gate (5 min)

```bash
nvm use 22
npm run compile && npm run lint && npm test && npm run test:transport
node test/transport/packaged-vsix.js cmsis-developer-assistant-darwin-arm64-<version>.vsix
```

Expect: 284 passing; transport prints `tools/list stays under the 30000 byte budget — ~29.4 kB`,
`serialEnabled:false leaves the serial tools out — 35 tools`, `lookup_peripheral without an SVD
explains what it tried`, `get_debug_instructions serves the breakpoints topic`; both harnesses
`ALL CHECKS PASSED`.

## 1. Headless, no target (5 min) — from any MCP client, no session running

| # | Do | Expect |
|---|----|--------|
| 1.1 | List tools | 45 tools (35 with `cmsis-developer-assistant.serial.enabled: false` + reload); no description longer than ~4 lines |
| 1.2 | `get_debug_instructions` (no args) | ~3 KB: the numbered steps, `## 🐞 DEBUGGER FIRST`, then `## Topics` with six entries |
| 1.3 | `get_debug_instructions { topic: "faults" }` | The fault section only (EXC_RETURN, the flag table); footer names the other topics |
| 1.4 | `get_debug_instructions { topic: "nonsense" }` | `Unknown topic 'nonsense'. Showing the overview.` — no error |
| 1.5 | `lookup_peripheral {}` | Peripheral list of the project's SVD (from `out/**/*.cbuild-run.yml`), or `No SVD file found for a lookup. Tried: …` naming each location |
| 1.6 | `lookup_peripheral { name: "gpio" }` | `… is not in the SVD … Did you mean: GPIO0, GPIO1 …` — suggestions, never a silent pick |
| 1.7 | `lookup_register { peripheral: "<one from 1.5>", register: "<one>" }` | Address, access, reset value, bit fields `[hi:lo]`, enumerated values inline, `Next: read_peripheral_register …` |
| 1.8 | `lookup_peripheral { address: "<a register address from 1.7>" }` | `0x… = PERIPH.REG — offset … in PERIPH @ …` |
| 1.9 | `lookup_peripheral { address: "0x20000000" }` | `… not inside any peripheral … that is the SRAM region (0x20000000–0x3fffffff)` |
| 1.10 | `get_session_status` | `State: no-session` … and a trailing `Tool stats (this session): N calls · … returned · …` counting 1.2–1.9 |
| 1.11 | Read resource `cmsis-developer-assistant://stats` | JSON with `session.perTool` naming the tools above with `bytesOut` |
| 1.12 | Set `cmsis-developer-assistant.telemetry.jsonlPath` to `.vscode/tool-telemetry.jsonl`, reload, repeat 1.2 | One JSON line per call in the file — `tool`, `argBytes`, `resultBytes`, `ms`, `outcome` — and nothing else (no arguments, no results) |

## 2. Bring-up and motion (10 min) — CMSIS project

| # | Do | Expect |
|---|----|--------|
| 2.1 | `cmsis_action { action: "build" }` | Ends with `✅` or `❌` and the exit code. On a first build that exceeds 60 s: the fence text, and a second `build` returns the real result |
| 2.1a | On a solution with two target-types (e.g. HE/HP), panel on the first: `cmsis_action { action: "build", target: "<second type>" }`, then again with the same `target`, then `target: "Nope"` | First call: status bar flips to the second type, cbuild runs that context, result ends `… on <second type>, switched from <first> (task … exited 0)`, `.vscode/cmsis.json` has `activeTargetType` = second type. Second call: `… on <second type>` with no switch. Third: `not attempted … 'Nope' is not declared … Declared targets: …` |
| 2.2 | `add_breakpoint` on a line in `main`, then `cmsis_action { action: "load_and_debug" }` | Full state JSON once: `configurationName`, `stackTrace`, `breakpoints`, `fileName` all present; `get_device_info` afterwards ends with `CMSIS target: <type@set>` |
| 2.3 | `step_over` ×3 | Each reply is the **compact** state: no `configurationName`/`fileName`, `stackTrace` ≤ 5 entries (`… N more — get_call_stack` when deeper), `breakpointsUnchanged: 1` — not the list |
| 2.4 | `add_breakpoint` on another line, then `step_over` | This reply carries `breakpoints: [...]` (the list changed); the next `step_over` is back to `breakpointsUnchanged: 2` |
| 2.5 | `read_memory { address: "<SP from read_core_registers>", length: 64 }` | Hex only; `format: "both"` adds the ASCII block |
| 2.6 | `get_call_stack` | Paths relative to the workspace (`Blinky/Blinky.c:42`), not absolute |
| 2.7 | `get_variables_values` (no names) at a frame with >40 locals if you have one, else skip | `… N more, truncated — narrow with variableNames`; with `variableNames` the same variables come uncapped |
| 2.8 | `continue_execution` into a free-running loop with no breakpoint | Times out with `⚠️ '…' did not complete …` and a `🩹 Recovery` section showing `PC = … LR = …` — two registers, not 23 |
| 2.9 | `get_session_status` | `stopped`, and the trailer's `largest:` names the tools that returned the most bytes |

## 3. Faults (15 min) — FVP fixture overlays, or a planted fault on your board

Run once per overlay: `npm run eval:scenario -- <id> --keep --no-mcp-config` materialises
`test/eval/.work/<id>/` (it stops at "no window has it open" — that is fine, the work dir is
what you want); open it in the window, build, `load_and_debug`, `continue_execution`,
`wait_for_stop`.

| overlay | `diagnose_fault` must say | also check |
|---------|---------------------------|------------|
| `divide-by-zero` | `Class: UsageFault — DIVBYZERO`, `Exception frame: MSP @ …`, `PC=… ← faulting instruction`, hypothesis 1 `[high] Integer division by zero…`, `Next: get_frame_variables …` | `get_fault_info` still prints the classic `=== Cortex-M Fault Analysis ===` block, now with `UFSR  = 0x0200 / DIVBYZERO` |
| `undefined-instruction` | `UNDEFINSTR`, `PC is in SRAM — not code`, hypotheses: `Execution left the code region` **and** `Undefined instruction at 0x2…` | stacked `LR=` is the caller in `Blinky` |
| `stack-overflow` | `Class: UsageFault — STKOF`, hypothesis `[high] Stack overflow … (MSP 0x… is below its limit 0x…)`, `Registers now: … MSPLIM=…` | `get_call_stack` shows `pattern_value` repeated |
| `unaligned-access` | `UNALIGNED`, hypothesis `Unaligned access with UNALIGN_TRP set…`, `Next: get_frame_variables …` | stacked `R0`–`R3` show `buf + 1` odd address |
| on a board: an unclocked peripheral write | `Fault address (BFAR): 0x4000… = I2C1.CR1 (Peripheral)`, hypothesis `[high] Precise access to I2C1.CR1: the peripheral's clock is gated…`, `Next: read_peripheral_register on the clock-enable register` | `lookup_peripheral { address }` gives the same resolution without a session |
| `led-off-by-one` (no fault) | `=== No fault flags set ===`, `Stop: breakpoint, thread mode, PC …`, ≤ 10 lines | — |

Every `diagnose_fault` reply ≤ 40 lines. Pull the probe (board) mid-run and call it again:
the reply names `Skipped (timeout or read failure): …` rather than failing.

## 4. Agent behaviour (5 min) — prompts to an agent with the skill installed

| Prompt | Expect from the transcript |
|--------|----------------------------|
| "The firmware faults right after boot. Find out why." | First tool: the `cmsis-debug-live` skill; then `get_session_status`; on `stopped` it calls **`diagnose_fault`** (not six separate calls); no `add_logpoint`/printf edits |
| "Which bit in RCC enables I2C1?" (no session) | `lookup_register` / `lookup_peripheral`, no attempt to start a session |
| "What is at 0x40005400?" | `lookup_peripheral { address }` |
| "Explain how to bring up the target" (Copilot Chat, no skills) | `get_debug_instructions { topic: "build" }` — not the whole guide |

## 5. Evaluation runner (10 min) — machine with Copilot CLI + FVP/board

```bash
npm run eval:scenario -- --list
npm run eval:scenario -- divide-by-zero --wait-for-window 120 --runs 2
```

Expect: `# run 1/2: PASS — N tool calls, M turns, S s, B bytes from the server`, a report in
`test/eval/reports/`, `unknownEventTypes` listed (send them back so the aggregator can be
refined), and `$COPILOT_HOME/mcp-config.json` unchanged afterwards. Stop the FVP mid-run:
the report says `infra_error`, not a failed agent.

## 6. Numbers to record

| Metric | Where | Result |
|--------|-------|--------|
| `tools/list` bytes (44/45 tools) | §0 transport output | |
| `get_debug_instructions` default bytes | §1.2 (`resultBytes` in stats) | |
| `step_over` reply bytes, compact | §2.3 stats `perTool.step_over.bytesOut / calls` | |
| HardFault triage: calls to root cause | §3, count tool calls until the answer | |
| Eval scenario: calls / turns / bytes / pass | §5 report | |

## Pre-existing, not in scope

README line 25 double blank (markdownlint), `cmsis-help/SKILL.md` underscore emphasis
(generator footer), `docs/architecture` fence language — all predate this branch.
