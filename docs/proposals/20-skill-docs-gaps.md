# #20 Skill/docs gaps: long builds, J-Link/Alif reset fallback, check the build result line, window tools

> **Historical proposal; outcome checked against 2.7.0 (2026-10-27).** The guidance fixes shipped. Current guidance is the [agent guide](../agent-resources/debug_instructions.md), cmsis-help and the pinned knowledge procedures. The original analysis and decisions below are retained as evidence, not current implementation instructions.

| | |
|---|---|
| Issue | [#20](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/20) |
| Area · priority · source | Skills & agent rules · Low · Studio test |
| Original release plan | 2.3.11 (WP-D) |
| Size | XS |
| Depends on | none (the running-target rule rides on the #50 contract, same WP) |
| Related | #50, #13, #11 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

The issue listed five guidance gaps. Four are closed since 2.3.6, as the 2026-08-31 comment says, and 2.3.10 confirms it. `cmsis-debug-live` covers long builds, the ✅/❌ result line and `timeoutMs` ([SKILL.md:106-111](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/SKILL.md#L106-L111)) and the window tools ([:268-277](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/SKILL.md#L268-L277)), and so does the `build` topic of `get_debug_instructions`. Still open: the fallback the agent had to invent when `reset` reports that a J-Link / Alif E8 target did not reset (stop the session, `cmsis_action load_and_debug` again), with the note that on secure-boot parts nSRST alone does not re-vector the core. It is missing from the skill, from `embedded.md` and from the `reset` failure text. Also open: "running → `pause_execution` first" as a rule, and the list of tools that are rejected while the target runs.

## Current state (2.3.10)

- The fallback exists in exactly one place: the `inspection` topic of the guide ([debug_instructions.md:180](../../docs/agent-resources/debug_instructions.md#L180), last sentence: "When `reset` reports no reset on a J-Link / secure-boot part, the fallback is `stop_debugging` and `cmsis_action load_and_debug` again.").
- Missing from:
  - [skills/cmsis-debug-live/SKILL.md](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/SKILL.md): no mention of `reset` failing.
  - Both copies of `troubleshooting/embedded.md` ([skill](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/references/troubleshooting/embedded.md), [MCP resource](../../docs/agent-resources/troubleshooting/embedded.md), byte-identical today).
  - The `reset` tool description ([debugMCPServer.ts:474-477](../../src/debugMCPServer.ts#L474-L477)).
  - The failure text, [resetAssist.ts:108-113](../../src/core/resetAssist.ts#L108-L113):

    ```text
    ⚠️ Reset was issued but the target does NOT appear to have reset. <detail>. Method(s) tried: <…>.<commands>
    The target is halted<before><notApplied> — use continue_execution to run. 'hardware' requires nSRST wired
    from probe to target — if it is not connected, no software reset can recover this; power-cycle the board or
    reconnect the probe. Adapter replies: <…>
    ```

- Pinned by [resetAssist.test.ts:72-80](../../src/test/resetAssist.test.ts#L72-L80) (partial-regex matches on "does NOT appear to have reset", the halted sentence and the commands line; the nSRST sentence is not pinned).
- Running target: the skill has it as a table row only ([SKILL.md:132](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/SKILL.md#L132), "Reads will be rejected. `pause_execution`, or …"). The gate's own error does not name `pause_execution`: [debuggingHandler.ts:384](../../src/debuggingHandler.ts#L384) says "Add a breakpoint or wait for the previous continue/step to stop …". Its `no-session` hint ([:378](../../src/debuggingHandler.ts#L378)) says "Call start_debugging first", which contradicts the skill's "`cmsis_action load_and_debug` for CMSIS projects".
- Tools gated by `ensureStoppedSession` ([debuggingHandler.ts:370-397](../../src/debuggingHandler.ts#L370-L397)): `step_over`, `step_into`, `step_out`, `continue_execution`, `read_memory`, `read_core_registers`, `read_peripheral_register`, `read_cycle_counter`, `get_fault_info`, `diagnose_fault`, `evaluate_expression`, `get_call_stack`, `get_frame_variables`, `get_threads`, `list_variable_names`, `get_variables_values`. Breakpoint tools are not gated (that is #13); `reset` halts a running target itself.

## Proposed fix

1. **Failure text** in `renderResetOutcome` ([resetAssist.ts:108-113](../../src/core/resetAssist.ts#L108-L113)). Replace the nSRST sentence with a next step that needs no human first:

   ```text
   … The target is halted<before><notApplied> — use continue_execution to run. Next: stop_debugging, then
   cmsis_action load_and_debug (a fresh connect and reset). That is the working fallback on J-Link and on
   secure-boot parts such as Alif Ensemble, where nSRST alone does not re-vector the core. If that fails too,
   power-cycle the board or reconnect the probe. Adapter replies: <…>
   ```

   The text is the same for every GDB server kind. The halted sentence stays byte-identical, so the existing pins hold. The failure text grows by 120 B (163 → 283 B for the replaced sentence); `tools/list` does not change. The "'hardware' requires nSRST wired" explanation stays in the `method` parameter description.
2. **Skill**: in [SKILL.md](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/b37a5263b8cfd59b2a43e1d4131e68ae67e0b4c2/skills/cmsis-debug-live/SKILL.md), directly after the session-state table (after line 136), add:

   ```markdown
   `running` rejects `step_*`, `continue_execution`, `read_memory`, `read_core_registers`,
   `read_peripheral_register`, `read_cycle_counter`, `get_fault_info`, `diagnose_fault`,
   `evaluate_expression`, `get_call_stack`, `get_frame_variables`, `get_threads`,
   `list_variable_names` and `get_variables_values`: call `pause_execution` first.

   `reset` verifies the PC against the reset vector. When it says the target did NOT
   reset (common with J-Link and on secure-boot parts such as Alif Ensemble, where
   nSRST alone does not re-vector the core), `stop_debugging`, then
   `cmsis_action load_and_debug`. Power-cycle only if that fails too.
   ```

3. **`embedded.md`, both copies**: a new section after "Tool Call Hangs or Times Out":

   ```markdown
   ### `reset` Says the Target Did NOT Reset

   - Trust the verification, not the command echo: the PC is not at the reset vector.
   - `stop_debugging`, then `cmsis_action load_and_debug` — a fresh connect and reset. This is the fallback on J-Link and on secure-boot parts (Alif Ensemble), where nSRST alone does not re-vector the core.
   - Only if that fails: power-cycle the board or reconnect the probe.
   ```

4. **Guide**: [debug_instructions.md:180](../../docs/agent-resources/debug_instructions.md#L180) gains "power-cycle only if that fails too" after its existing fallback sentence.
5. **Gate hints** in `ensureStoppedSession`. WP-A turns this error into `ToolError(NO_SESSION | TARGET_RUNNING)`; its `hint` carries the new text, written once:
   - `running` ([:384](../../src/debuggingHandler.ts#L384)): "The target is running: call pause_execution first, or set a breakpoint and wait_for_stop."
   - `no-session` ([:378](../../src/debuggingHandler.ts#L378)): "No active debug session: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise."
6. **Rule**: "A running target rejects reads and steps: call pause_execution first." is one of the #50 contract lines, so it reaches `instructions`, the skill and `cmsis-help` through the same generator.
7. **`reset` description unchanged** (0 B in `tools/list`); the fallback arrives in the result at the moment it is needed.

## What changes for the agent and the user

```text
before  reset -> "⚠️ ... does NOT appear to have reset ... 'hardware' requires nSRST wired ... power-cycle the board
        or reconnect the probe."            -> agent stops, or asks the user to power-cycle
after   reset -> "⚠️ ... does NOT appear to have reset ... Next: stop_debugging, then cmsis_action load_and_debug
        (a fresh connect and reset) ... If that fails too, power-cycle the board or reconnect the probe."
        read_memory while running -> hint "The target is running: call pause_execution first, ..."
```

## Decisions for you

- [ ] **Fallback text for every GDB server or only for J-Link?** **Recommended:** every server. `detectGdbServerKind` returns `unknown` for many configurations, and a fresh `load_and_debug` is safe wherever an unverified reset leaves the target halted anyway. Alternative: J-Link only (`serverKind === 'jlink'`), which is shorter for pyOCD users but misses unknown servers.
- [ ] **Order: load_and_debug before power-cycle?** **Recommended:** yes. It needs no human and fixes the Alif E8 case seen in the studio test. Alternative: keep power-cycle first, which is the more conservative wording when flashing again is undesirable (for example on a board whose flash must not be rewritten).
- [ ] **Where the gate hints change.** **Recommended:** in WP-A, as the `hint` of the new `ToolError`. WP-A lands before WP-D in 2.3.11 and rewrites these lines anyway. Alternative: change the strings in WP-D; this is the same text, but it risks a merge conflict with WP-A.

## Tests and acceptance

- `resetAssist.test.ts`: the unverified outcome matches `/Next: stop_debugging, then cmsis_action load_and_debug/`, `/nSRST alone does not re-vector the core/` and `/If that fails too, power-cycle/`; the existing pins stay green; a verified reset does not contain "load_and_debug".
- `debugSkillGuidance.test.ts`: the skill mentions `pause_execution first` and the `load_and_debug` reset fallback.
- New test in `skill.test.ts`: the two `troubleshooting/embedded.md` copies are byte-identical, since today nothing keeps them in sync.
- Live (plan, 2.3.11 list, Alif E8 with J-Link): `reset` on the E8 reports the new text, and the agent follows it without inventing a step.
- Close #20 with the 2.3.11 release.

## Out of scope and follow-ups

- Automating the fallback (`reset { method: 'reconnect' }` or `restart_debugging { reconnect: true }`) belongs to #3 (WP-N, Future).
- Pause-apply-resume for breakpoint tools while running is #13 (WP-C).
- Whether nSRST re-vectors a given secure-boot part is device knowledge; the `cmsis-bring-up` / `debug-knowledge` records are the place to document it per device.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
