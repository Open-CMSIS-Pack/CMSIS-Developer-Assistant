---
name: pyocd-detect-debug-topology
description: Capture supplementary, non-authoritative CMSIS debug and CoreSight topology evidence from the complete stdout/stderr of `pyocd gdbserver -vv --target cortex_m` after `$check-pyocd-availability` succeeds. Use when documentation does not establish a required processor, debug-port, access-port, or CoreSight-component observation; do not use detection to infer missing hardware behavior.
---

# pyOCD Detect Debug Topology

## Target & Persona

- **Role:** Debug Bring-up Verification Engineer.
- **Objective:** Return a complete, traceable record of what pyOCD observed without converting observations into undocumented device facts.

## Prerequisites & Context

- **Expected input:** Complete captured stdout and stderr from `pyocd gdbserver -vv --target cortex_m`, or an accessible target plus a successful `$check-pyocd-availability` result for a new scan. No supplied target or probe context is required when exactly one target is attached; provide a selection only when multiple targets are attached. Documented unlock, power-up, and recovery steps are required before a repeat scan.
- **Dependencies:** `$check-pyocd-availability` must succeed before obtaining a new scan; pyOCD and an accessible target are also required then. No device-family, PDSC, compiler, or build-system dependency is assumed.
- **Portability:** Support any target pyOCD can probe. Do not assume that a successful scan exposes every powered-down, reset-held, debug-locked, or disabled subsystem.

## Execution Steps (Strict Workflow)

1. **Analysis:** If complete pyOCD stdout/stderr is supplied, validate and analyze it. Otherwise, require a successful `$check-pyocd-availability` result before preparing a new target scan. Use the target directly if exactly one is available; stop for selection when multiple targets are attached. Before a repeat scan, require documented unlock or power-up steps that explain why the new scan can expose additional hardware; otherwise record the original scan's limitation.
2. **Processing:** When a new scan is authorized, `$check-pyocd-availability` has succeeded, and a target is selected or exactly one target is attached, run `pyocd gdbserver -vv --target cortex_m` and capture its complete stdout and stderr. Unless the user needs it to remain running, request the host's most graceful supported interrupt and wait up to 10 seconds for exit: Ctrl+C / `CTRL_C_EVENT` on Windows or `SIGINT` on POSIX. If the server is still running after 10 seconds, force-terminate only that server process using the host mechanism: `Stop-Process -Force` on Windows or `SIGKILL` on POSIX.
3. **Validation:** Extract only explicitly observed processor, DP, AP, APID, protocol, component, address, and scan-failure information. Preserve the complete captured stdout/stderr in the task context. Record the shutdown request and outcome when this workflow started the server. Do not treat an absent observation as evidence that a subsystem does not exist.
4. **Formatting:** Return the observation table and limitations in conversation. The calling knowledge skill owns any knowledge-record update and must combine this supplementary evidence with authoritative documentation.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not infer device behavior, reset behavior, unlock requirements, dormant-state requirements, a missing component, or an undocumented address from a scan or its absence.
- **Portability:** Do not introduce a target, probe, device-family, toolchain, or operating-system assumption beyond the active scan context.
- **Critical blockers:** Stop when a new scan lacks a successful `$check-pyocd-availability` result, an accessible target, a selection among multiple attached targets, or documented unlock/power-up steps for a repeat scan.
- **Scope:** Capture supplementary detection evidence only. Do not edit PDSC files, create knowledge records, select Pack scope, or implement debug or trace configuration.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Return this Markdown record in conversation:

```markdown
Scan source: `<captured process stdout/stderr | new scan command>`
Scan status: `Observed` | `Unavailable` | `Incomplete`
Server shutdown: `<not applicable | graceful interrupt and outcome | force termination after 10 seconds>`

| Observation | Reported value | Output excerpt / line | Confidence | Limitation |
|---|---|---|---|---|

## Scan limitations
- `<limitation or none>`
```

Use `not reported` for unavailable values. The caller cites this result as supplementary evidence and keeps unresolved facts unresolved.

## Validation Resources

Use the complete captured stdout/stderr from `pyocd gdbserver -vv --target cortex_m` as the sole runtime evidence source. Before a new scan, verify the successful `$check-pyocd-availability` result. Then verify that each table row is traceable to the captured output, every repeat scan records its documented unlock or power-up prerequisite, and every server started by this workflow records its graceful shutdown result, including a forced termination after the 10-second grace period when required.
