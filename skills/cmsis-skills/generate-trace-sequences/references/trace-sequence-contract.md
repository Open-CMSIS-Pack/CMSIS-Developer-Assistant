# Trace assembly contract

## Shared integration ownership

Run `$prepare-pdsc-sequence-change` before domain assembly, `$manage-pdsc-debugvars` for a documented runtime choice, `$apply-confirmed-pdsc-proposal` after confirmation, and `$validate-pdsc-sequence-xml` for common XML/PDSC and `<block>` checks. This contract defines the trace-specific topology, asset, scaffold, routing, marker, and lifecycle requirements that extend those shared workflows.

Use the current [Open-CMSIS-Pack *Debug Description* specification](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/debug_description.html) as the grammar authority. Its `Sequence("name")` function calls another debug access sequence; predefined sequence implementations in a PDSC override the debugger-provided behavior. Use `.agent-artifacts/<pdsc-stem>.trace-knowledge.md` from `$trace-knowledge` as read-only input. Consult `.agent-artifacts/<pdsc-stem>.debug-access-knowledge.md` from `$debug-access-knowledge` only when trace implementation requires a processor, debug connection, DP/AP path, protocol, or dormant-state fact that the trace knowledge record does not provide.

## Contents

- [Required recognizable output](#required-recognizable-output)
- [Component selection and placement](#component-selection-and-placement)
- [Standard component-operation routing](#standard-component-operation-routing)
- [Component asset fidelity](#component-asset-fidelity)
- [Structural and formatting gates](#structural-and-formatting-gates)

## Required recognizable output

Maintain exactly one target `<debugvars>` element and one target `<sequences traceSetup="full">` element for each affected debug description. This skill always generates full trace setup: the PDSC sequences perform the trace sink and trace data-path setup rather than relying on debugger a-priori CoreSight configuration. Use the following marker comments verbatim:

Trace setup is device-level by default. Unless the user explicitly narrows scope, assemble it for all processors and all evidence-backed trace paths available in the selected device subtree; do not create separate default configurations merely because a device has multiple CPUs.

Configure every evidenced trace path in the selected scope by default. When a documented runtime choice belongs to the end user, generate or update it through `debugvars` with a supported default and propose matching Configuration Wizard annotations in `.dbgconf`; do not require the user to select which evidenced paths to generate.

```xml
<!-- CMSIS-PACK-TRACE: ADD-DEVICE-SPECIFIC-HERE BEGIN -->
<!-- CMSIS-PACK-TRACE: ADD-DEVICE-SPECIFIC-HERE END -->
<!-- CMSIS-PACK-TRACE: INSERT-CORESIGHT-SNIPPET-CALLS-HERE -->
```

The `ADD-DEVICE-SPECIFIC-HERE` pair delimits user-maintained device work and remains in generated PDSC XML. The single CoreSight insertion marker belongs in a mode-specific `DoTrace*` helper, whose name identifies the phase and trace mode; it is scaffold-only and must be removed after selected CoreSight calls replace it in generated PDSC XML. Do not add redundant CoreSight begin/end wrappers.

The markers define the required order:

```text
TraceStart:   ADD-DEVICE-SPECIFIC-HERE -> mode-specific CoreSight start helpers
TraceCapture: ADD-DEVICE-SPECIFIC-HERE -> mode-specific CoreSight capture helpers
TraceFlush:   mode-specific CoreSight flush/read helpers -> ADD-DEVICE-SPECIFIC-HERE
TraceStop:    mode-specific CoreSight stop helpers -> ADD-DEVICE-SPECIFIC-HERE
```

Enable trace clocks in `DebugDeviceUnlock` before auto-detection. Some devices cannot be automatically detected while their trace clocks are gated. This is the default requirement; omit or relocate it only when the user explicitly directs otherwise. Also configure trace clocks in `TraceStart`'s device-specific region, before the mode-specific CoreSight start helpers. Do not assume the `DebugDeviceUnlock` setting survives reset. This `TraceStart` setup is also required by default; omit or relocate it only when the user explicitly directs otherwise.

The debugger is expected to call `TraceFlush` before `TraceStop` so trace data is drained before stopping. `DoTraceFlush_<mode>` helpers are reusable from other verified sequences, but `TraceStop` and `DoTraceStop_<mode>` helpers must not call `DoTraceFlush` or any `DoTraceFlush_<mode>` helper again.

## Component selection and placement

Map the selected device subtree, its processors, and every evidence-backed trace path. Group descendants with an identical verified device-level configuration and place shared `debugvars`, component sequences, scaffold calls, and extension placeholders at their topmost selected common level. Put only proven deviations on outer leaf variants. Omit a processor or path only when the user narrows scope or evidence proves it unavailable.

Select one asset per required physical CoreSight instance. Omit unused assets, snippets, variables, and calls; merge every selected asset's `<debugvars>` contribution into the target's single `<debugvars>` element; deduplicate names and reject conflicting definitions. Whenever this adds a `<debugvars>` `__var`, suggest adding or updating the matching `.dbgconf` file with Configuration Wizard annotations. Include the variable name, default, and applicable scope; do not modify the `.dbgconf` file unless the user includes it in their confirmation.

Number non-predefined sequences by component type from `0` in ascending verified base-address order and preserve existing numbers: `CS_<COMPONENT>_0_*`, `CS_<COMPONENT>_1_*`, and so on. Name the operation as a separate segment and append any operation subvariant as another underscore-separated segment: `CS_<COMPONENT>_<instance>_<operation>[_<subvariant>]` (for example, `CS_ETF_0_Configure_HWFIFO`). Rename every copied sequence and every `Sequence("...")` call consistently.

## Standard component-operation routing

Call a component operation only from the helper for its active trace mode:

| Operation | Helper destination | Applies to |
|---|---|---|
| `Configure` | `DoTraceStart_<mode>` | Active path only |
| `Capture` | `DoTraceCapture_<mode>` | Active path only |
| `Flush` | `DoTraceFlush_<mode>` | Active path only; `TraceFlush` must never be called from a generated component or helper sequence |
| `ReadBuffer` | `DoTraceRead_Buffer` after `DoTraceFlush` | Trace-buffer path only |

For every applicable start or capture path, call operations in trace-route order: first funnels, then other glue logic such as an ETF in hardware-FIFO mode, then the trace sink or output component.

| Trace mode | Applicable component route |
|---|---|
| SWO | Funnels on the SWO route, then either a standalone SWO component or a Cortex-M TPIU used in SWO mode. |
| Sync | Funnels on the synchronous route, then applicable glue such as an ETF in hardware-FIFO mode, then the synchronous TPIU trace port. |
| Trace buffer | Funnels on the buffer route, then applicable glue, then the selected buffer sink: ETB, ETF in circular-buffer mode, ETR, or another verified buffer variant. |

Do not emit a component call merely because its snippet exists. The verified topology determines its trace mode and presence. For shutdown or other operations not listed above, use only the component-specific order supported by evidence.

`TraceFlush` is the debugger-facing top-level orchestration sequence and is never a callable component/helper dependency. A `DoTraceFlush_<mode>` helper may be called from another sequence, including a capture sequence, when the verified mode-specific operation requires it. The sole lifecycle exception is the stop path: do not call it from `TraceStop` or `DoTraceStop_<mode>` because the debugger has already invoked `TraceFlush`.

Every component snippet must use a numeric `instance_suffix`, an optional `<debugvars>` contribution, and one or more sequence bodies. Number instances of each component type from `0` in ascending verified base-address order: `CS_<COMPONENT>_0_*`, `CS_<COMPONENT>_1_*`, and so on. Preserve prior numbering when updating an existing PDSC. Rename its sequence names and `Sequence("...")` calls before integration using that suffix. Do not merge duplicate variables silently: same name requires identical documented meaning and value, otherwise stop for user direction.

When a verified device-specific trace design uses a CoreSight component in a non-standard role or order, its snippet sequences may be called from the applicable `ADD-DEVICE-SPECIFIC-HERE` region. Exclude those operations from the standard mode-specific CoreSight helper path so the component is not configured, captured, flushed, or stopped twice.

For a selected device subtree, place a configuration shared by all selected descendants on the topmost selected common level. Put only specializations/deviations on outer leaf variants. The same placement rule applies to `<debugvars>`, component sequence bodies, scaffold calls, and device-extension placeholders.

The XML assets use a wrapper element only to remain well-formed standalone files. Copy their child `debugvars`/`sequence` elements into the PDSC; do not copy the wrapper. They are skeletons, not validated device configurations. Resolve every device-specific placeholder—such as an instance suffix, component base address/AP, selected component calls, and trace-mode routing—only from the trace knowledge record and authoritative device/CoreSight documentation. The `ADD-DEVICE-SPECIFIC-HERE` markers are not placeholders: retain them as user-maintained extension regions.

## Component asset fidelity

A selected component asset is the source template for its operations, not an illustrative example. Copy its comments, `__var` declarations, checks, control blocks, waits, cleanup, and sequence bodies into the generated PDSC. Do not handwrite a replacement sequence when that selected asset provides the operation.

For every selected asset, add a line-level merge checklist to `.agent-artifacts/<pdsc-stem>.trace-sequences.md` that identifies every retained, changed, and omitted line or block. Every change or omission requires a documented device-specific evidence reason. Before completion, compare each generated fragment to the corresponding selected asset after normalizing approved instance suffixes and evidence-backed substituted values. Flag a missing comment, variable declaration, control block, wait, or cleanup as a validation failure unless the checklist records its evidence-backed omission. Never simplify for brevity, even when the XML is schema-valid.

## Structural and formatting gates

Before editing, use `assets/scaffolds/full-trace.xml` and confirm that every required top-level sequence and applicable `DoTrace*_<mode>` helper remains present, with its opening trace-mode variable block. When migrating legacy setup, also follow `references/legacy-to-full-migration.md`. Insert calls only through the defined helper and extension markers. Do not flatten or inline helpers to shorten the result. Be mindful of patch-size limits when updating PDSC files: split large edits into smaller, focused patches and validate the XML after each patch.

Put each high-level routing sequence's `__var` declarations in its opening `<block>`, before executable statements. These routing sequences are `TraceStart`, `TraceCapture`, `DoTraceFlush`, `TraceFlush`, `TraceStop`, and their `DoTrace*_<mode>` helpers; each begins with `swoTrace`, `syncTrace`, and `bufferTrace` definitions derived from `__traceout`. Component snippet sequences declare only the variables they use.

When a retained scaffolding sequence has no C-like content other than its standard trace-mode `__var` declarations, put `<!-- No trace operation is required for this mode. -->` after its opening `<block>`. A scaffold-only CoreSight insertion marker may follow it. Remove the comment and marker when a component call or device-specific operation is added.

Before completion, run `$validate-pdsc-sequence-xml`. Then run this trace-specific marker check:

```text
rg -n 'INSERT-CORESIGHT-SNIPPET-CALLS-HERE' <target.pdsc>
```

Inspect and resolve every match that is C-like sequence content. Also inspect every retained scaffolding sequence that contains only its standard trace-mode `__var` declarations and require the empty-operation comment. If context or time is tight, stop and continue later rather than producing compressed or partial sequences. Never trade required scaffold structure for schema validity or a shorter response.

Do not invent register addresses, values, funnel routes, timestamping, formatter settings, component order, or a dormant-state requirement. Honor the trace knowledge record's evidence-backed `debugconfig dormant` decision when present; otherwise obtain that decision from `$debug-access-knowledge` when the selected trace configuration requires it. Ask for documentation when a selected snippet needs information not supplied by the verified trace knowledge.

Write `.agent-artifacts/<pdsc-stem>.trace-sequences.md` at the project root. Record the selected device-tree scope, each PDSC placement and its applicable descendants, trace component instances, emitted sequence names, extension placeholders, sources, and validation result. Include a `Documents requiring user download` table with `title | URL | retrieval issue | requested workspace path` whenever an identified technical document cannot be downloaded. Ask the user to download and copy it into the target workspace, then inspect that local copy before relying on it.

`.agent-artifacts/` files are agent-owned and may be created or updated without user confirmation. Before changing an existing user-owned PDSC or another existing user file, present the proposed change and obtain user confirmation.

After the user confirms the proposed trace configuration, generate, apply, and validate the complete XML in the same turn. Do not stop after updating the assembly record unless missing evidence or a validation failure blocks completion.
