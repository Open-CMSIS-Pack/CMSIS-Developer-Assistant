---
name: manage-pdsc-debugvars
description: Design a documented CMSIS-Pack PDSC `debugvars` runtime choice through the active conversation. Use when defining or revising a `__var`, checking collisions and scope, or proposing its minimal sequence use and Configuration Wizard annotation; do not create agent-artifact records, edit files, invent device behavior, or redesign debug or trace sequences.
---

# Manage PDSC Debug Variables

## Target & Persona

- **Role:** CMSIS-Pack Tool Integrator and Configuration Interface Designer.
- **Objective:** Return one safe, documented runtime-variable proposal.

## Prerequisites & Context

- **Expected input:** Target PDSC, selected device-tree scope, documented runtime choice, existing `<debugvars>`, and optional existing `.dbgconf` content.
- **Dependencies:** Current [Open-CMSIS-Pack *Debug Description* specification](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/debug_description.html).
- **Portability:** Support any existing CMSIS Device Family Pack. Do not assume a device family, debugger, toolchain, or runtime target.

## Execution Steps (Strict Workflow)

1. **Analysis:** Verify the variable's documented meaning, allowed values or type, supported default, consuming sequence path, evidence, and applicable descendants or processors.
2. **Processing:** Find the highest selected level at which the definition and use are valid. Reuse an identical existing `__var`; combine contributions into the one applicable target `<debugvars>` element when required; stop for direction on a name conflict.
3. **Validation:** Confirm that every proposed sequence reference is minimal and controls only a verified behavior. Reject undocumented register values, routes, delays, or missing facts disguised as a user choice.
4. **Formatting:** Return the `__var` definition, required sequence reference/declaration/branch, scope, consumers, evidence, collision result, and optional `.dbgconf` annotation in conversation.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent variable values, defaults, register behavior, sequence branches, or Configuration Wizard annotations.
- **Portability:** Do not introduce a device-family, debugger, toolchain, or runtime-target dependency unless authoritative inputs require it.
- **Critical blockers:** Stop for an undocumented choice, unsupported default, conflicting existing definition, or unverified consuming path.
- **Scope:** Design the variable interface only. Do not edit files or redesign surrounding debug or trace sequences.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Return the variable proposal in conversation. Do not create or update workspace files.

## Validation Resources

Use the selected PDSC's inherited `<debugvars>` definitions and the current Debug Description specification to validate scope, naming, and sequence use.
