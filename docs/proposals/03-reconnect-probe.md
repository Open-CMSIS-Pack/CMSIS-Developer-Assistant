# #3 reconnect_probe / auto retry-with-reconnect after probe wedge

> **2.7.0 status (2026-10-27).** Phase 1 diagnosis is implemented in [probeWedge.ts](../../src/core/probeWedge.ts); automatic probe reconnect remains a separate proposal. Preserve the fault-state requirements when reviewing the remaining work. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#3](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/3) |
| Area · priority · source | Probe recovery and post-mortem · Low ("lower") · hardware-session field notes, item 9 (soumeh01) |
| Original release plan | Phase 1: 2.3.12 (with WP-H; the plan says Future). Phase 2: Future (WP-N) |
| Size | M (phase 1 S, phase 2 M) |
| Depends on | #11 (`ToolError`, `PROBE_WEDGED`); phase 2 after #14 and #48 |
| Related | #13 (the `-exec` prefix finding affects the read ladder), #20 (reset fallback text), #21 (request to the CMSIS Solution / Debugger owners), #50 (hint must not send the agent to the shell for long) |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

After a HardFault on a probe board, the fault-register and stacked-frame reads failed with "all GDB strategies exhausted" until someone restarted the GDB server by hand. The agent could not tell a wedged probe from a bad address, and no tool can restart the server without losing the fault state.

This is still true in 2.3.10: there is no reconnect logic anywhere.

The plan's recovery hint ("`cmsis_action detach`, then `attach`, keeps the fault state") does **not** work for the common case. After `load_and_debug`, `detach` ends the session, and the adapter kills the GDB server that session started. `attach` then finds no server, because CMSIS attach configurations start none. `restart_debugging` and `load_and_debug` re-flash and reset. So none of today's tools can restart the server without losing the fault state.

## Current state (2.3.10)

- **Where the message comes from.** "all GDB strategies exhausted" is thrown at [debuggingExecutor.ts:1104](../../src/debuggingExecutor.ts#L1104) in `evaluateMemoryWord` ([:1037-1105](../../src/debuggingExecutor.ts#L1037-L1105)). Each of its three strategies swallows its error. `readMemory` discards the DAP `readMemory` error before falling back ([:984-990](../../src/debuggingExecutor.ts#L984-L990)). So the message carries no cause at all.
- **Strategies 2 and 3 cannot produce a value on `gdbtarget`.** They are `-exec x/1xw` and `-exec print/x` ([:1067](../../src/debuggingExecutor.ts#L1067), [:1087](../../src/debuggingExecutor.ts#L1087)).
  - cdt-gdb-adapter 1.10.0 evaluates `-exec …` as a C expression (see #13).
  - With the adapter's `>` prefix the output goes to the Debug Console, and the evaluate body is `\r` or the MI result (`evaluateRequestGdbCommand`, `GDBDebugSessionBase.js:1884-1895`).
  - In practice the message means that DAP `readMemory` and the watch-context evaluate both failed.
- **Who reads through this path.**
  - `readFaultRegisters` ([:1411-1433](../../src/debuggingExecutor.ts#L1411-L1433)) and `readExceptionFrame` ([:1436-1439](../../src/debuggingExecutor.ts#L1436-L1439)).
  - The DWT reads ([:1356-1369](../../src/debuggingExecutor.ts#L1356-L1369)) and the reset verification ([:1258-1263](../../src/debuggingExecutor.ts#L1258-L1263)).
  - `get_fault_info` ([debuggingHandler.ts:1427-1432](../../src/debuggingHandler.ts#L1427-L1432)).
  - `diagnose_fault`, whose fault-register read ([:1452](../../src/debuggingHandler.ts#L1452)) is outside any `try`: a wedge fails the whole call, and only the stacked frame degrades to "skipped".
- **Server lifecycle (cdt-gdb-adapter 1.10.0).**
  - The adapter starts a GDB server only for `request: 'launch'` (`dist/desktop/GDBTargetDebugSession.js:200-209`).
  - It kills that server on disconnect unless `target.automaticallyKillServer` is `false` (`:242`, `:673`).
- **CMSIS Solution 1.70.1.**
  - `cmsisDetachDebugger` calls `vscode.debug.stopDebugging(activeDebugSession)` for its tracked session. `cmsisAttachDebugger` calls `startDebugging(folder, <active attach configuration>)`.
  - The attach templates (`templates/debug/JLink.adapter.json`, `CMSIS-DAP-pyOCD.adapter.json`) are `request: attach` with only `target.port`.
  - The launch templates run `preLaunchTask: "CMSIS Load"`, then `monitor reset …` and `tbreak main`. There is one exception: with the csolution `debugger: connect: attach` node, J-Link gets `-nohalt -noreset` and the reset lines are skipped.
  - Our own `cmsis_action` already warns that `attach` needs a listening server ([debuggingHandler.ts:2159-2164](../../src/debuggingHandler.ts#L2159-L2164)).
- **No reconnect logic.** Nothing in `src/` restarts a server, and no session or probe code watches for a wedge. Background: [improvement-notes.md](../improvement-notes.md), field note 9 (line 109) and "Top remaining" item 4 (line 32).

## Proposed fix

**Phase 1: name the wedge and the way out (S, recommended for 2.3.12).**

1. **Keep the evidence.**
   - Move the read ladder into `src/core/gdbMemory.ts`, as codebase review item "GDB word-read ladder" already proposes.
   - Keep the DAP `readMemory` error and the watch-evaluate error, and put both (≤200 chars each) into the thrown message.
   - Drop strategies 2 and 3 for `gdbtarget` if #13's spike confirms they cannot return a value.
2. **Tell a wedge from a bad address.**
   - After a failure that is not a timeout, read DHCSR (`0xE000EDF0`, 4 bytes, DAP `readMemory`, ≤1 s) once. A debugger can read DHCSR on every Cortex-M whenever the debug port works.
   - If the canary also fails or times out: `ToolError('PROBE_WEDGED', 'Memory reads fail and the debug port does not answer (DHCSR unreadable): …', hint)`.
   - If the canary reads: `ToolError('INVALID_ARGUMENT', 'Cannot read 0x… — the debug port answers, the address is not readable in this state: <DAP error>')`.
   - A `HardwareTimeoutError` on a read followed by a timed-out canary also becomes `PROBE_WEDGED`. So does the `unresponsive` state in `ensureStoppedSession` (the DAP `threads` probe timed out). This refines #11, which maps that state to `TIMEOUT`.
   - A readable DHCSR with `S_LOCKUP` (bit 19) adds "core is in lockup" to `get_fault_info` / `diagnose_fault`. This is a free diagnostic.
3. **A hint that matches the session.** The hint depends on `session.configuration.request`:
   - **`attach`:** "`cmsis_action detach`, then `cmsis_action attach`: reconnects GDB to the running server without a reset. Then `get_fault_info`."
   - **`launch`** (a `load_and_debug` session): "This session owns the GDB server; detaching stops it, and `restart_debugging` / `load_and_debug` re-flash and reset. To keep the fault state: `stop_debugging`, start the server without reset (J-Link `-nohalt -noreset`, pyOCD `-O connect_mode=attach`), then `cmsis_action attach`. If the fault state does not matter: `load_and_debug`."

   Once phase 2 lands, the launch hint becomes a single `cmsis_action reconnect`, so no shell step remains (#50).
4. **`diagnose_fault` and `get_fault_info`** return the `PROBE_WEDGED` error itself, not a partial diagnosis built on unread registers.

**Phase 2: one-call reconnect (M, Future, WP-N).**

1. **`cmsis_action {action: 'reconnect'}`.** One more enum value on the existing tool, about 90 B in `tools/list`. The handler:
   - Requires a `gdbtarget` session started from a CMSIS launch configuration with `target.server` set.
   - Builds a derived configuration from the session's resolved `configuration` with a new pure `deriveReconnectConfig(config)` in `src/core/reconnect.ts`:
     - same `type`, `request: 'launch'`, `target.server` and `target.port`;
     - `serverParameters` with the halt and reset options swapped for the no-reset connect ones (J-Link: drop `-halt`, add `-nohalt -noreset`; pyOCD: add `-O connect_mode=attach`);
     - no `preLaunchTask`;
     - `initCommands` reduced to the `add-symbol-file` lines;
     - the name `<name> (reconnect)`.
   - Stops the wedged session, which kills its server. Waits (≤5 s) until the session has ended and the port is free. Then calls `startDebugging(folder, derived)`, runs `confirmSessionSurvives`, and reads DHCSR and the fault registers.
   - Answers "Reconnected without reset — core halted in HardFault_Handler, CFSR=0x00008200, BFAR=0x40001000", or a `ToolError`.
   - An unknown server type, or `Arm-FVP`, gives `ToolError('INVALID_ARGUMENT')` with "reconnect supports J-Link and pyOCD launch sessions".
2. **In parallel, ask the owners** (via #21) for an official "attach with server start, no reset" configuration or command in CMSIS Solution / CMSIS Debugger. When it exists, `reconnect` calls it instead of deriving a configuration.
3. **No automatic retry inside `read_memory`** (Decision 4). A reconnect replaces the debug session: new session, breakpoints sent again, and the core may run between detach and re-attach. That must never happen as a side effect of a read.
4. **Docs.** The `faults` and `troubleshooting` topics, `skills/cmsis-debug-live/SKILL.md` (post-mortem recovery), `docs/improvement-notes.md` item 9 moved to "Closed", and the CHANGELOG. The `tools/list` cost is ≈90 B in phase 2 and 0 B in phase 1.

## What changes for the agent and the user

```text
get_fault_info after the probe wedged (load_and_debug session, J-Link)

2.3.10   "Error in 'get_fault_info': Failed to read memory at 0xe000ed28 — all GDB strategies exhausted"
         (plain ok result; no cause, no way out)

phase 1  isError: "[PROBE_WEDGED] Memory reads fail and the debug port does not answer (DHCSR unreadable):
          readMemory: Remote communication error …; evaluate: …
          This session owns the GDB server; detaching stops it … start the server without reset
          (J-Link -nohalt -noreset …), then cmsis_action attach."

phase 2  cmsis_action {action: "reconnect"} →
         "Reconnected without reset (JLinkGDBServerCL -nohalt -noreset, port 50000). Core halted in
          HardFault_Handler; CFSR=0x00008200 (PRECISERR), BFAR=0x40001000. Breakpoints were sent again."
```

The user no longer has to restart the GDB server from a terminal, and the fault state they wanted to inspect survives.

## Decisions for you

- [ ] **1. When phase 1 ships.** **Recommended:** 2.3.12 with WP-H's code mapping. It is small (classification, canary and hint), it makes the wedge visible, and it does not depend on the reconnect design.
  - Alternative: the plan's Future, together with phase 2. One design pass, but the misleading message stays two releases longer.
- [ ] **2. How reconnect gets a server without reset.** **Recommended:** derive the configuration ourselves (`deriveReconnectConfig`, J-Link and pyOCD only), and also ask the owners for an official one (phase 2, step 2).
  - Alternative A: wait for the owners. Cleaner and nothing fragile, but no date, and the manual hint stays.
  - Alternative B: phase 1 only. Nothing fragile, but the agent keeps being sent to the shell (#50).
  - The derived configuration depends on the templates' `serverParameters` conventions, so the unit fixtures must pin them.
- [ ] **3. Tool surface for phase 2.** **Recommended:** `cmsis_action {action: 'reconnect'}` (≈90 B). It sits next to `attach` / `detach` and is CMSIS-specific. This deviates from the plan.
  - Alternative: the plan's `restart_debugging {reconnect: true}` (≈130 B). It suggests that every debug type can reconnect, and it contradicts "restart from the beginning".
- [ ] **4. Automatic retry inside reads.** **Recommended:** off.
  - Alternative: an opt-in setting `probe.autoReconnect`. It saves a call, but a read silently replaces the session.

## Tests and acceptance

- **Unit, new `src/test/gdbMemory.test.ts`** (codebase review 4.3 plus these cases):
  - DAP read and evaluate fail and the DHCSR canary fails → `PROBE_WEDGED`, with both causes in the message.
  - Canary succeeds → `INVALID_ARGUMENT` naming the address.
  - A timeout plus a timed-out canary → `PROBE_WEDGED`.
  - `S_LOCKUP` set → lockup note.
- **Unit, new `src/test/reconnect.test.ts`.** `deriveReconnectConfig` against resolved J-Link and pyOCD launch configurations captured from real sessions (fixtures under `src/test/fixtures/`): `-halt` removed, `-nohalt -noreset` added, `connect_mode=attach` added, `preLaunchTask` gone, `initCommands` stripped, unknown server rejected.
- **Unit, `src/test/debuggingHandler.test.ts`.**
  - `diagnose_fault` with a wedged fake executor rejects with `PROBE_WEDGED`.
  - The launch vs. attach hint wording.
  - Reconnect orchestration order: stop, wait for end, start, survive.
- **Live, probe board** (Alif E8 with J-Link, or a CMSIS-DAP board with pyOCD):
  - Provoke a HardFault (store to an unmapped address), and note CFSR/BFAR with `get_fault_info`.
  - Closest to the field failure (the server is alive, the probe is not): switch the probe's USB port off and on with the board-power-cycle skill (uhubctl), on a board that is not powered from the probe. Expect `PROBE_WEDGED` with the launch hint.
  - Then `cmsis_action reconnect`. CFSR/BFAR must be identical before and after, and the core halted in the handler.
  - Secondary check: `kill -STOP <server pid>` makes the DAP probe time out. Expect `PROBE_WEDGED` from the `unresponsive` state. Then `kill -CONT`.

## Out of scope and follow-ups

- `start_gdb_server` / `stop_gdb_server` tools (improvement notes item 2).
- Reconnect for multi-core sessions: the other cores' child sessions are not rebuilt in v1.
- Reconnect for FVP and for non-CMSIS debug types.
- Wedge detection outside memory reads, for example in `step_over`. #14 covers a wedged window; the #48 journal records `PROBE_WEDGED` with its source.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
