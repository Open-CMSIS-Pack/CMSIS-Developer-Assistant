---
name: board-debug-knowledge
description: Document a named board's supported debug and trace connector, jumper, pin-routing, and configuration choices without narrowing device-level Pack support. Use only for an explicitly requested board-specific debug or trace configuration before a knowledge workflow records optional board alternatives or a Pack workflow designs a runtime variable.
---

# Board Debug Knowledge

## Target & Persona

- **Role:** Board Bring-up Verification Engineer.
- **Objective:** Establish an evidenced, reusable knowledge inventory of one board's optional debug and trace configurations.

## Prerequisites & Context

- **Expected input:** A named board, its fitted device when known, board manual/design guide/schematics or equivalent authoritative documentation, and the requested debug or trace purpose.
- **Dependencies:** `$resolve-official-device-documentation` when a cited board document is unavailable.
- **Portability:** Support any board and MCU family. Do not assume a board connector, probe, trace transport, voltage level, or jumper convention.

## Execution Steps (Strict Workflow)

1. **Analysis:** Identify the board revision and the documents that establish its debug connector, trace connector, relevant jumpers, routing switches, fitted-device constraints, and pin map. Stop if the board identity or requested purpose is ambiguous.
2. **Processing:** Record every documented selectable configuration that affects the requested debug or trace use. When a cited board source is unavailable, run `$resolve-official-device-documentation`. Distinguish a board-only routing choice from a device capability, and retain connector, jumper, switch, pin, and electrical notes only when documented.
3. **Validation:** Confirm each option against the board documentation and preserve all device-level Pack options. Derive a candidate runtime choice only when its values and supported default are documented; do not infer an unsupported choice.
4. **Formatting:** Return the option inventory and candidate runtime choices in conversation. The calling knowledge skill owns any project artifact update.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent connector pins, jumper positions, routes, voltages, electrical settings, board revisions, variable values, or defaults.
- **Portability:** Do not generalize a board wiring choice to another board or remove device-level Pack support because one board lacks a route.
- **Critical blockers:** Stop when an option lacks authoritative board evidence, its board revision is incompatible with the request, or a proposed default is undocumented.
- **Scope:** Establish board alternatives only. Do not establish SoC debug access, CoreSight topology, or implement a configuration choice.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Return these tables in conversation:

```markdown
| Board / revision | Connector / pins | Jumper / switch / route | Debug or trace purpose | Electrical notes | Evidence | Status |
|---|---|---|---|---|---|---|

| Board choice | Candidate runtime choice | Documented values and default | Evidence | Status |
|---|---|---|---|---|
```

Mark a missing field `not reported`; do not infer it. The caller may copy an evidenced candidate into its own record.

## Validation Resources

Use the board's manual, design guide, connector map, schematic, or vendor-provided revision notes. Recheck that every reported option remains board-specific and that the result does not omit a documented device-level option.
