# #52 Proposal: statistical PC-based profiler and agent-driven hotspot identification

> **2.7.0 status (2026-10-27).** Sampling and dump_memory tools remain proposed. Workflow content now belongs in knowledge procedures; preserve the original capture/validation questions when deciding the remaining hardware and file-export hooks. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#52](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/52) |
| Area · priority · source | Skills & agent rules (proposed, as #51) · Low (proposed) · External (FabKlein) |
| Original release plan | Future (WP-P) |
| Size | XXL overall; this repo's part M (S without the PC-sampling op) |
| Depends on | none; a PC-sampling op depends on a spike and on WP-G budget |
| Related | #51 (same proposer, shared hooks), #50, #41, #17 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

FabKlein proposes a statistical profiler that finds where a whole Cortex-M application spends its time. A periodic interrupt samples the interrupted PC (plus LR, xPSR, EXC_RETURN and optional PMU counters) into a RAM buffer. The debugger dumps the buffer, and a host script symbolises it against the exact ELF into ranked functions. An agent skill would integrate the layer, run the capture and report the hotspots with their statistical limits, then hand the top hotspot to the #51 optimisation flow. The prototype exists ([FabKlein/cmsis_statistical_profiler](https://github.com/FabKlein/cmsis_statistical_profiler), Apache-2.0, marked "initial prototype"). Verified against 2.3.10: nothing here samples the PC or reads the PMU, but almost every step of the proposed workflow maps onto existing tools. The one real gap is getting a 64 KiB buffer out without pushing it through the agent's context.

## Current state (2.3.10)

- **The prototype** (read 2026-09-23):
  - A common layer `cmsis_statistical_profiler.clayer.yml`, board adapters (Corstone-300 timer0, STM32N6 TIM2, Alif E8 UTIMER, a template) and a SysTick integration.
  - Capture format v1 (`FORMAT.md`): magic `SCPF`, 164-byte header with `complete`/`active` flags, then records of 24 + 4 × PMU-count bytes. A 64 KiB buffer holds 2 723 samples without PMU. There is no firmware identity field.
  - `tools/export_profiler_buffer.gdb` checks `complete == 1 && active == 0`, then runs `dump binary memory` over the whole `statistical_samples` object.
  - `host/analyze_profiler_buffer.py` writes `functions.csv`, `samples.csv` and `summary.json`.
  - PMU: 0-4 events on Armv8.1-M.
  - TODO: circular buffer, repeated capture/export/resume.
- **No sampling code here**: [dwt.ts:22-38](../../src/core/dwt.ts#L22-L38) knows DEMCR, DWT_CTRL and DWT_CYCCNT only.
- **The shipped core SVDs already describe the hooks**:
  - DWT `PCSR` at offset 0x01C, "read repeatedly by a debugger for non-intrusive statistical profiling. 0xFFFFFFFF when halted" ([Cortex_M55.svd:722-724](../../assets/svd/core/Cortex_M55.svd#L722-L724)); present in the M0, M0+, M3, M4, M33 and M55 SVDs checked.
  - A `PMU` peripheral in Cortex_M52/M55/M85/Star_MC3.svd. It is reachable only through `get_peripheral_docs` (documentation tools, off by default: [coreSvd.ts:88-100](../../src/core/packDocs/coreSvd.ts#L88-L100), [packDocsHandler.ts:373-378](../../src/packDocsHandler.ts#L373-L378)); `lookup_register` / `lookup_peripheral` use the device SVD only.
- **Reads are refused while the target runs** (`ensureStoppedSession`, [debuggingHandler.ts:370-397](../../src/debuggingHandler.ts#L370-L397)). A debugger-side PC sampler needs a non-halting read path. The CMSIS Debugger 1.8.0 reads while running only for `gdbtarget` sessions with `auxiliaryGdb: true` (`canAccessWhileRunning` in its `dist/main.js`, used by Live Watch and CPU States). The CMSIS Solution-generated `launch.json` in CDA-Testdrive sets it for the J-Link and pyOCD configurations and not for the FVP one. Whether our DAP requests are served while running is unknown.
- **Buffer retrieval today**:
  - `read_memory` returns at most 4 096 bytes per call as hex text into the context ([debugMCPServer.ts:599-613](../../src/debugMCPServer.ts#L599-L613)): 16 calls and about 250 kB of text (62 characters per 16-byte line, [debuggingHandler.ts:1305-1310](../../src/debuggingHandler.ts#L1305-L1310)) for the prototype's 64 KiB buffer.
  - `evaluate_expression` passes `-exec …` straight to the session's GDB ([debuggingHandler.ts:1056-1058](../../src/debuggingHandler.ts#L1056-L1058)), and our guidance already uses it (`-exec info breakpoints`). The prototype's own `dump binary memory` can therefore run inside the session's GDB with no new code; the file-landing behaviour is still to be verified.
- **Symbolisation and identity**: `symbolAt` ([elf.ts:407](../../src/core/buildInfo/elf.ts#L407)) backs `lookup_symbol` (build-artefact tools, opt-in). `readElf` records the `.note*` section names ([elf.ts:343](../../src/core/buildInfo/elf.ts#L343)) but not the GNU build-id value.
- **Waiting for a long capture**: `continue_execution` / `wait_for_stop` accept `timeoutMs` up to 60 s per call, so the agent loops; WP-B raises caps only for `cmsis_action` and `flash`.
- **Tool contract (#50)**: running the host decoder (`python3 host/analyze_profiler_buffer.py …`) is host-side file analysis and stays allowed. A separate `arm-none-eabi-gdb -x export_profiler_buffer.gdb` would not be; the same script through `evaluate_expression("-exec …")` is.

## Proposed fix

How the proposed workflow maps onto today's tools:

| Proposal step | Tool path |
|---|---|
| 1-3 add the layer, reserve RAM, loop the workload | the skill edits the csolution; `get_memory_usage`, `get_section_layout` check the region (build-artefact tools) |
| 5 build, keep the exact ELF | `cmsis_action build`; `list_build_artifacts` names the ELF |
| 6 load, run to the capture-complete breakpoint | `cmsis_action load_and_debug`, `add_breakpoint` after `sampling_profiler_stop()`, `continue_execution`, `wait_for_stop` in a loop |
| 7 check the header, dump the buffer | `evaluate_expression("statistical_samples.header")`, then `evaluate_expression("-exec source <repo>/tools/export_profiler_buffer.gdb")` and `evaluate_expression("-exec export_profiler_buffer <absolute path>/samples.bin")` |
| 8 decode | shell: `python3 host/analyze_profiler_buffer.py --samples … --elf …` |

Split by owner:

| Part | Owner | Home |
|---|---|---|
| Target component, adapters, capture format, host decoder | FabKlein | their repository now; later a CMSIS pack or layer (publisher to agree) |
| Profiling skill (integrate, capture, decode, report with limits, hand-off to #51) | FabKlein | Open-CMSIS-Pack/cmsis-skills, the same `optimize` category as #51 |
| PMU event selection by capability | FabKlein (layer and skill) | uses H3 and the #51 processor features |
| Hooks below | this repo | WP-P |

Hooks in this repo:

- **H1, dump path (XS first, S if a tool is needed).**
  - Phase 1 is zero code: document the `-exec` route above in `cmsis-debug-live` ("large buffers: GDB `dump binary memory` through `evaluate_expression`, absolute path") and verify it on the Corstone-300 FVP and on a J-Link board. Verification items: cdt-gdb-adapter accepts `dump` and `source` through DAP evaluate; the file lands at the absolute path on the host that runs GDB; the reply is empty on success.
  - Only if that fails, or for non-GDB adapters: a `dump_memory {address, length?, file}` tool. It reads in 4 KiB chunks with DAP `readMemory` (the executor's [readMemory, debuggingExecutor.ts:961](../../src/debuggingExecutor.ts#L961)) and accepts a symbol for `address`, with `sizeof` as the default length. It is limited to 16 MiB, refuses paths outside the workspace, writes with `writeFileAtomic` and returns the path, bytes, sha256 and rate. It gets `readOnlyHint: false`: it writes a host file, so it must not inherit `read_memory`'s auto-approval. That costs about 350 B in `tools/list` and needs WP-G budget.
- **H2, spike: debugger-side PC sampling (½-1 day, live).**
  - Q1: with `auxiliaryGdb: true`, does a DAP `readMemory` from this extension succeed while the target runs? If only the CMSIS Debugger's internal path can do it, ask for a command (see #41).
  - Q2: the achievable sampling rate over GDB/pyOCD and J-Link, in samples per second.
  - Q3: PCSR presence and semantics per architecture (optional on Armv6-M). Look them up in the Armv7-M and Armv8-M reference manuals through `search_target_docs`, not the web.
  - If Q1 and Q2 pass: a `sample_pc {durationMs, file?}` op. It polls DWT_PCSR, drops `0xFFFFFFFF`, symbolises with `symbolAt` over the current ELF, and returns the top N functions plus the sample count, rate and invalid count; raw samples go to `file`. That gives a first profile with no firmware change, before the layer is integrated. About 400 B in `tools/list`.
  - If not: the spike report says so, and the target-side sampler stays the only path.
- **H3, core-SVD fallback for `lookup_register` / `lookup_peripheral` (S).** When the device SVD lacks DWT or PMU, answer from the shipped core SVD that the documentation tools already load. PMU event programming and PCSR then become discoverable without `packDocs.enabled`. 0 B in `tools/list`.
- **H4, firmware identity (XS).** `list_build_artifacts` reports the `.note.gnu.build-id` value when present. On our side this answers the proposer's open question on rejecting a mismatched image; the capture header needs a matching field (format v2, proposer).
- **Shared with #51:** processor features in `get_device_info` (#51 H1). The skill enables PMU events only on cores that have a PMU.

Phased path:

1. **Now:** answer on #52; H1 phase 1 (document and verify the `-exec` dump).
2. **Proposer, phases 1-2:** generalise the layer; write the skill against the tool path in the first table.
3. **Here, WP-P:** H3 and H4; the H2 spike.
4. **Proposer, phases 3-5:** automated collection in the skill, PMU capability tables, jitter, RTOS/TrustZone support; circular or repeated capture uses the same dump path per round.
5. **Optional:** `sample_pc` (after the spike and WP-G) and `dump_memory` (only if H1 phase 1 fails).

Draft answer on #52:

```markdown
Thanks — the prototype maps well onto what the MCP tools already do. Proposal:
- Component, adapters, format and host decoder stay in your repository (later a pack/layer); the profiling skill goes
  into Open-CMSIS-Pack/cmsis-skills next to the #51 skill.
- Collection works today without new tools: cmsis_action build / load_and_debug, add_breakpoint after
  sampling_profiler_stop(), continue_execution + wait_for_stop, evaluate_expression("statistical_samples.header"),
  and your export_profiler_buffer.gdb through evaluate_expression("-exec source …") / ("-exec export_profiler_buffer
  <abs path>") inside the session's GDB — no second GDB on the probe. We will verify that path on FVP and J-Link.
- From our side: core-SVD fallback so lookup_register describes DWT/PMU without the documentation setting, the ELF
  build-id in list_build_artifacts (a build-id field in your header would let the host reject a mismatched image),
  and a spike on debugger-side PC sampling via DWT_PCSR while running, as a zero-instrumentation first look.
```

## What changes for the agent and the user

```text
before  agent: 16 x read_memory { length: 4096 } -> ~250 kB of hex in context, or runs arm-none-eabi-gdb in a shell
after   agent: evaluate_expression("-exec export_profiler_buffer /…/samples.bin") -> file on disk, empty reply
        python3 host/analyze_profiler_buffer.py … -> functions.csv; the skill reports the ranked hotspots and limits
        lookup_register { peripheral: "PMU", register: "PMU_TYPER" } answers from the core SVD (H3)
spike   sample_pc { durationMs: 5000 } -> "1 842 samples @ 368/s; 41 % arm_fir_f32, 17 % memcpy, …" (only if Q1/Q2 pass)
```

## Decisions for you

- [ ] **Dump path: GDB passthrough or a new tool?** **Recommended:** `-exec dump binary memory` through `evaluate_expression` first. It needs no code and no `tools/list` bytes, and it is the prototype's own script. Build `dump_memory` only if the verification fails or a non-GDB adapter needs it. Alternative (the plan): build the file-dump tool now; it has a cleaner contract (workspace paths, sha256) but costs about 350 B and a release slot.
- [ ] **Spike debugger-side PC sampling?** **Recommended:** yes, half a day to a day. A profile with no firmware change is the best first step for an agent, and it complements the target sampler (which has higher rates, LR, PMU and no probe dependency). Alternative: leave PC sampling entirely to the target-side component.
- [ ] **One skill category for #51 and #52?** **Recommended:** yes, `optimize` in cmsis-skills with two skills (profile, then optimise), since they form one workflow. Alternative: a separate `profile` category, a second router and more vendoring config.
- [ ] **Core-SVD fallback in `lookup_register` (H3): Future WP-P or earlier?** **Recommended:** WP-P (Future); it has no user demand beyond this proposal yet. Alternative: 2.3.12, since it is small and also helps fault triage (SCB, DWT) on devices whose SVD omits core peripherals.

## Tests and acceptance

- H1 phase 1: a documented, verified run on the Corstone-300 FVP (the eval fixture is SSE-300) with the prototype's `examples/corstone300`: the dump file equals the object size and the decoder accepts it. The same run on a J-Link board.
- H2: a spike report with Q1-Q3 answered, rate numbers per probe, and a go/no-go for `sample_pc`.
- H3: `lookup_register` on a device whose SVD lacks `PMU` answers from `Cortex_M55.svd`, with the source named; unit test with a fixture device SVD.
- H4: `buildInfoElf.test.ts` reads the build-id from a fixture linked with `--build-id` (a new fixture, or the existing `blink-gcc.elf` if it carries one).
- End to end (proposer's skill): "Profile this application and show me its main hotspots" on the FVP fixture, with no shell GDB or pyOCD in the transcript (the #50 eval deny list).

## Out of scope and follow-ups

- The capture format, the adapters, PMU capability tables and RTOS/TrustZone attribution belong to the proposer.
- ETM/ITM trace-based profiling (richer, probe-dependent) stays a separate topic; the `trace-knowledge` skills describe trace paths.
- Zephyr targets: the proposer points to Zephyr's native perf tool; no hook needed.
- Board hygiene: move #52 from Triage to Backlog, set the area, post the answer above.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
