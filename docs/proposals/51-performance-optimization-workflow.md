# #51 Proposal: target-aware Cortex-M performance optimization workflow (llvm-mca, SWOGs, learning-path, ACLE intrinsics)

> **2.7.0 status (2026-10-27).** The performance workflow remains proposed; the read_cycle_counter annotation fix (H5) has shipped. Local category/vendoring work (H3) is obsolete after the knowledge-source move; remaining workflow ownership and hardware hooks need review. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#51](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/51) |
| Area · priority · source | Skills & agent rules · Low (proposed) · External (FabKlein) |
| Original release plan | Future (WP-P); a small enabling fix can go into any release |
| Size | XXL overall; this repo's part M |
| Depends on | none; #17 helps locate the toolchain |
| Related | #52 (same proposer, shares hooks), #17, #50, #44 |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

FabKlein proposes a processor-aware optimisation workflow for Cortex-M. An agent resolves the target's core, FPU, DSP and MVE features, isolates a hot loop, runs `llvm-mca`, consults the core's Software Optimization Guide (SWOG) and intrinsic references, rewrites the loop, and then measures baseline and candidate on hardware with the DWT cycle counter. A pointer-chasing memory-latency sweep and curated Learning Paths come on top. The proposal asks for a lightweight delivery: one selectable skill, the existing document index, local `llvm-mca` discovery, and perhaps a thin read-only MCP tool later. Verified against 2.3.10: the measuring end exists (`read_cycle_counter`), the knowledge end does not. There is no SWOG in the Arm document catalogue, processor features are resolved nowhere, and ATfE ships no `llvm-mca`. Most of the proposal is skill content that belongs to its author; this repo should supply the hooks.

## Current state (2.3.10)

- **Cycle measurement**: `read_cycle_counter` ([debugMCPServer.ts:627-636](../../src/debugMCPServer.ts#L627-L636)), handler gated on a halted target ([debuggingHandler.ts:1389-1412](../../src/debuggingHandler.ts#L1389-L1412)), executor [debuggingExecutor.ts:1349-1373](../../src/debuggingExecutor.ts#L1349-L1373), register map [dwt.ts:22-38](../../src/core/dwt.ts#L22-L38) (DEMCR, DWT_CTRL, DWT_CYCCNT only). **Small bug:** it is annotated `readOnlyHint: true` ([:631](../../src/debugMCPServer.ts#L631)) although it writes DEMCR.TRCENA and DWT_CTRL.CYCCNTENA on first use.
- **Arm documents**: [ARM_DOCS (armDocs.ts:124-163)](../../src/core/packDocs/armDocs.ts#L124-L163) with kinds `arch | adi | coresight | etm | trm | npu | gug` ([:89](../../src/core/packDocs/armDocs.ts#L89), order at [:165](../../src/core/packDocs/armDocs.ts#L165)). [armDocsFor (:219-230)](../../src/core/packDocs/armDocs.ts#L219-L230) excludes `gug` and is called from [targetDocs.ts:293](../../src/core/packDocs/targetDocs.ts#L293). [packDocsHandler.ts:371](../../src/packDocsHandler.ts#L371) and [:378](../../src/packDocsHandler.ts#L378) hard-code `['arch', 'gug', 'trm']` for core peripherals. [armDocs.test.ts:53-82](../../src/test/armDocs.test.ts#L53-L82) pins the Cortex-M33 list exactly. No SWOG entry.
- **Processor features**:
  - [parseCbuildYml (artifacts.ts:181-224)](../../src/core/buildInfo/artifacts.ts#L181-L224) reads only `processor.core` ([:200-203](../../src/core/buildInfo/artifacts.ts#L200-L203)), and nothing consumes it. The corstone-blinky fixture's `cbuild.yml` carries `dsp: on`, `fpu: dp`, `mve: fp`, `core: Cortex-M55` (lines 27-31 of `build/MPS3/GCC/Debug/Blinky/outdir/Blinky.Debug+MPS3.cbuild.yml`, which a build of the fixture writes).
  - The pdsc path returns only `Dcore` and `DcoreVersion` ([ProcessorInfo, pdscBooks.ts:98-106](../../src/core/packDocs/pdscBooks.ts#L98-L106)), although [collectProcessors (:226-244)](../../src/core/packDocs/pdscBooks.ts#L226-L244) already merges all `<processor>` attributes (`Dfpu`, `Ddsp`, `Dmve`, `Dtz`).
  - The ELF attribute reader returns only `Tag_CPU_name` ([parseCpuName, elf.ts:184-232](../../src/core/buildInfo/elf.ts#L184-L232)).
- **Skills**: Open-CMSIS-Pack/cmsis-skills has the categories `bring-up`, `debug`, `devops`, `ethos-u`, `pack` and `project`, with no optimisation or profiling skill. Our vendoring **fails** on a category it does not know ([sync-skills.ts:163-166](../../scripts/sync-skills.ts#L163-L166), union at [skillCatalog.ts:28](../../src/utils/skillCatalog.ts#L28)). Upstream `main` added `ethos-u` on 2026-08-26, after our pin `d778b91`, so `npm run skills:sync -- --update` already fails today. Upstream skill names may not collide with router names ([sync-skills.ts:295-307](../../scripts/sync-skills.ts#L295-L307)). Bundled skills are always installed and cost every user context; vendored ones are opt-in through `installedSkills`.
- **Toolchain**: the ATfE installs on the maintainer's Mac (17.0.1, 20.1.0, 22.1.0 under `~/.vcpkg/artifacts`) ship `llvm-objdump` but no `llvm-mca`, which confirms the proposer's finding.
- **Tool contract (#50)**: running `llvm-mca` or `llvm-objdump -d` in a shell stays allowed. The contract bans probe tools and shell symbol/size lookups, and was worded to leave disassembly open for this flow. Build, flash and measure go through `cmsis_action`, `flash` and `read_cycle_counter`; `lookup_symbol` gives a function's address and size for `llvm-objdump --start-address/--stop-address`.
- **Budget**: `tools/list` is 28 799 of 30 000 B single-window (measured on 2.3.10), so an `analyze_assembly` tool needs budget from WP-G.

## Proposed fix

Split by owner:

| Part of the proposal | Owner | Home | Hook from this repo |
|---|---|---|---|
| 1. Optimisation skill | FabKlein | Open-CMSIS-Pack/cmsis-skills, new category `optimize` | H1 features, H3 category support |
| 2. `llvm-mca` discoverable | ATfE team | [arm/arm-toolchain](https://github.com/arm/arm-toolchain) (issue by the proposer) | locate the toolchain via #17 (`.cmsis/tools-environment.yml`) |
| 3. SWOG knowledge | this repo (catalogue); the skill (use) | `ARM_DOCS` | H2 `swog` kind |
| 4. Intrinsics and porting | FabKlein | skill references (ACLE, Arm Intrinsics Database, CMSIS-DSP/NN) | none; public PDFs such as *Coding for Helium* can be indexed with `fetch_doc` |
| 5. Learning Paths | FabKlein | skill references, on demand | none |
| 6. Memory-latency sweep | FabKlein | firmware example or layer in their repo, plus the skill | H4 dump to file (defined in [#52](52-statistical-profiler.md)); `read_cycle_counter` |
| Optional `analyze_assembly` tool | later | this repo or a separate server | only after WP-G, and only if shell-less clients need it |

Hooks in this repo (WP-P, M in total):

- **H1, processor features (S).**
  - `parseCbuildYml` reads the whole `processor:` block into `processorFeatures {core, fpu?, dsp?, mve?, trustzone?, endian?, branchProtection?}`, spelled as cbuild writes them.
  - The ELF attribute pass also collects `Tag_CPU_arch`, `Tag_CPU_arch_profile`, `Tag_FP_arch`, `Tag_DSP_extension` and `Tag_MVE_arch`. Verify the tag numbers in the Arm ELF ABI addenda, imported with `fetch_doc`.
  - `ProcessorInfo` gains `fpu`, `dsp`, `mve` and `trustzone` from the pdsc attributes.
  - `get_device_info` adds one line, e.g. `Processor: Cortex-M55, fpu dp, dsp on, mve fp (cbuild.yml; ELF agrees)`, and flags a mismatch between the build intent and the binary. `list_build_artifacts` shows the ELF attributes per image.
  - No new tool and no `tools/list` bytes; results grow by about 80 B.
- **H2, `swog` document kind (S).**
  - `ArmDocKind` gains `swog`, ordered after `trm`.
  - Entries only for cores with a public guide: Cortex-M55 = 102692 (from the issue); M85, M52, M7 and others only after their IDs and existence are verified by importing them with `fetch_doc`.
  - Also consider the *Armv8.1-M Performance Monitoring User Guide* that the #52 prototype links (ID to verify the same way).
  - `armDocsFor` includes them automatically, `list_target_docs` lists them, and `search_target_docs` answers with page citations.
  - Re-verification before a release: [armDocs.ts:117-123](../../src/core/packDocs/armDocs.ts#L117-L123) names `test/transport/arm-catalogue-check.js` for this, but that script is not in the repository. Add it (it fetches every entry's resolver URL) or fix the comment.
- **H3, skill category support (XS, can go into any release).**
  - Add `optimize` and `ethos-u` to `SkillCategory`, the order and the labels.
  - Change the unknown-category `fail` into a warning that skips the category, so a new upstream category never blocks a pin move again.
  - A `cmsis-optimize` router is optional. If it is added, the upstream skill must not be named `cmsis-optimize` (name collision rule): suggest `optimize-cortex-m-kernel`.
- **H4, dump to file** from #52 (H1 there): GDB `dump binary memory` through `evaluate_expression("-exec …")` first, a `dump_memory` tool only if that fails. Used for sweep results and other large buffers.
- **H5, bug fix (XS, 2.3.11 WP-A):** `read_cycle_counter` gets `readOnlyHint: false`, since it writes two debug registers on first use (+1 B).

Phased path:

1. **Now:** answer on #51; H3; agree the category and skill names with the cmsis-skills maintainers.
2. **Proposer, phase 1:** the skill in cmsis-skills, with `llvm-mca` from the shell. It uses `cmsis_action build`, `lookup_symbol` and `read_cycle_counter`. Here: H1.
3. **Phase 2:** H2 here; the skill reads the SWOG through `search_target_docs` / `read_doc_pages` with citations.
4. **Phase 3:** the baseline/candidate measurement loop and report in the skill, on existing tools.
5. **Phase 4:** the pointer-chasing firmware in the proposer's repo; results come back through H4.
6. **Phase 5, optional:** an `analyze_assembly` tool, after WP-G.

Draft answer on #51:

```markdown
Thanks — we would like this to exist and propose this split:
- The workflow as a skill in Open-CMSIS-Pack/cmsis-skills (new `optimize` category), opt-in through the AI Skills
  Pack like the other pack skills; skill-driven llvm-mca first, as you suggest.
- llvm-mca in ATfE: please open that request on arm/arm-toolchain; we will not bundle or download it.
- From our side: (1) the processor features (core, FPU, DSP, MVE, TrustZone) from cbuild.yml and the ELF attributes in
  get_device_info; (2) SWOGs as a `swog` kind in the Arm document catalogue, so list_target_docs/search_target_docs
  cite them (M55 first, other cores once verified); (3) a documented dump-to-file path for large result buffers (with #52);
  (4) vendoring support for the new category.
- Build, flash and measure should go through cmsis_action and read_cycle_counter rather than a shell (tool contract,
  #50); llvm-mca and llvm-objdump in the shell are fine.
- An analyze_assembly MCP tool can follow once the tool-list budget allows it.
```

## What changes for the agent and the user

```text
before  get_device_info: "... CMSIS target: MPS3@debug"           (no FPU/DSP/MVE; agent guesses -mcpu flags)
        list_target_docs (M55): architecture, ADI, CoreSight, ETM, TRM   (no optimisation guide)
after   get_device_info: "... Processor: Cortex-M55, fpu dp, dsp on, mve fp (cbuild.yml; ELF agrees)"
        list_target_docs (M55): ... TRM, "Cortex-M55 Software Optimization Guide (102692)"
        /cmsis-optimize (installed from the AI Skills Pack) drives build -> llvm-mca -> SWOG -> rewrite -> DWT measure
```

## Decisions for you

- [ ] **Where does the optimisation skill live?** **Recommended:** Open-CMSIS-Pack/cmsis-skills, a new `optimize` category, opt-in; it has its own owner and a narrow audience. Alternative: bundle it here, which puts it in front of every user at a context cost on every session.
- [ ] **SWOGs: catalogue kind or synthetic target documents?** **Recommended:** a `swog` kind in `ARM_DOCS`; it reuses verification dates, the `fetch_doc` resolver and page citations. Alternative: synthetic per-processor documents built at resolve time; more flexible, but a second mechanism.
- [ ] **Who maps features to `llvm-mca` flags (`-mtriple`, `-mcpu`, `-mattr`)?** **Recommended:** the skill; we expose raw features only and stay out of LLVM version churn. Alternative: a `llvmTarget` line from us, computed and unit-tested once, but tied to LLVM releases.
- [ ] **An unknown upstream skill category: fail or skip?** **Recommended:** warn and skip, plus add `ethos-u` and `optimize` now; `skills:sync -- --update` is broken by `ethos-u` today. Alternative: keep failing and extend the union for each new category, which forces a code change before every pin move.

## Tests and acceptance

- H1: `parseCbuildYml` on the corstone-blinky `cbuild.yml` gives `{core: 'Cortex-M55', fpu: 'dp', dsp: 'on', mve: 'fp'}`; the ELF attributes on `src/test/fixtures/buildinfo/blink-gcc.elf` and `blink-ac6.axf` (in `buildInfoElf.test.ts`); a mismatch line when they disagree.
- H2: `armDocsFor(['Cortex-M55'])` includes the SWOG after the TRM; the M33 pin is unchanged unless an M33 guide is added; the catalogue check (once it exists) fetches every `swog` entry.
- H3: `skillCatalog.test.ts` with a fake upstream tree that contains an unknown category, which is skipped with a warning; a real `npm run skills:sync -- --update` succeeds against upstream `main`.
- H5: `session-lifecycle.js` asserts `readOnlyHint: false` for `read_cycle_counter` (no test checks annotations today).
- Acceptance: the proposer's skill, installed from the pack, runs the M55 FIR example end to end on the Corstone-300 FVP fixture, using only MCP tools plus `llvm-mca` and `llvm-objdump` in the shell.

## Out of scope and follow-ups

- Bundling or downloading `llvm-mca`, an intrinsics database and Learning Path content: owned by ATfE and the skill.
- A cycle-accurate model (FVP cycle counts are not hardware cycles); the skill must say so, as the proposal already does for MCA.
- #17 (toolchain information from `.cmsis/tools-environment.yml`) is the natural way for the skill to find the ATfE `bin` directory; it is scheduled with WP-M (Future).
- Board hygiene: move #51 from Triage to Backlog and post the answer above.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
