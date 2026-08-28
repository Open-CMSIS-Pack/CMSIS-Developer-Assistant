---
name: add-board-layer
description: Add a board layer to an existing CMSIS csolution by interviewing the user for the few facts that cannot be read from the repo — board/device, layer strategy, debugger, STDIO transport, memory — then generating Board.clayer.yml and its startup / retarget-stdio / regions / device-header files (reusing the BSP layer when it fits, running the DFP's configuration generator when startup only comes from it, or a minimal bare-metal layer otherwise) and wiring the target-type into the solution. Use when the user wants to add or author a board layer and would rather be asked than hand over every parameter up front.
---

# Add a board layer by interviewing the user

Goal: produce a **working board layer** for a new target in an existing
csolution — `Board.clayer.yml` plus whatever startup / stdio / memory files it
needs — and wire it in as a target-type, ending on a green build. Real-hardware
bring-up (probe, serial marker, breakpoints) is the `$csolution-retarget` §6
flow; hand off to it once the layer builds.

The method is an **interview**: read everything the repo already answers, ask
the user only the handful of decisions it cannot, then generate. Never
interrogate the user for facts sitting in the pdsc, the SVD, the pack
documentation, or the csolution.

## Hardware facts: ask the documentation, not memory

When the **CMSIS Pack Docs MCP** (`cmsis-pack-docs`: `list_target_docs`,
`search_target_docs`, `read_doc_pages`) is available, every hardware question
in this skill goes through it — register offsets and bit meanings, the reset
clock tree, UART/VCP instance and pin muxing, memory map, boot pins, errata.
`list_target_docs` once, `search_target_docs` with the identifier the manual
uses (`RCC_AHB4ENR`, `USART1`, `0x58024400`), `read_doc_pages` around the best
hit, and **cite `<doc id> p.<n>`** in what you write. The SVD (via the
Developer Assistant's `lookup_register` / `lookup_peripheral`, or grep of the
DFP `.svd` when no MCP is available) is the cross-check for offsets, bit
positions and reset values; the manual is where semantics and sequences live.
Without either, say the value is unverified — do not fill the gap from a
vendor mega-header or from "same family, same map" memory.

## 0. Read before you ask

Gather these first — each one you find is a question you do NOT ask:

- The csolution: `compiler:`, existing `target-types`/`variables`
  (`Board-Layer`, `AI-Layer`, …), `target-set`/`debugger`, `packs`, and any
  solution-level node that cannot fork per target (`mlops:`, a generated layer,
  a single `.vscode`). An un-forkable node means **replace-on-a-branch**, not a
  new target-type (see `$csolution-retarget` §0).
- An existing board layer in the repo to mirror, and its file set — copy its
  shape rather than inventing one.
- If the user has already named the board, resolve its identity now (§2) so the
  interview can confirm specifics instead of asking blind.

## 1. The interview

Open in prose with the one open-ended question — **"Which board or device are
you adding, and is there an on-board debug probe / VCP?"** — then resolve §2.
Everything after that is a small set of decisions: ask them with
`AskUserQuestion`, **batched**, each with a recommended default derived from
what you read in §0/§2. Skip any question the repo already settles; state the
inference instead ("Solution compiler is AC6, so the layer targets AC6 — say if
you want otherwise") and move on.

The decisions worth asking (drop the ones already answered):

| Decision | Options to offer | Recommend from |
|---|---|---|
| **Scope** | New target-type · Replace on a branch | §0 — un-forkable solution node forces replace |
| **Layer strategy** | Reuse the BSP's `Board.clayer.yml` · Generator-based (run the DFP's configuration generator) · Minimal bare-metal layer | §2/§3 — whether the DFP ships `Device:Startup` and what the BSP layer needs |
| **Compiler** | AC6 · GCC · Clang | usually the solution's `compiler:` — infer, don't ask |
| **Debugger / probe** | `ST-Link@pyOCD` · `CMSIS-DAP@pyOCD` · `J-Link Server` · other | the probe the user named; `etc/debug-adapters.yml` for valid names |
| **STDIO transport** | UART VCP · Semihosting · ITM/none | UART when the board has a VCP; semihosting when it has none |
| **UART + pins** (if UART) | the board's debug VCP instance/pins | board manual via `cmsis-pack-docs` (search `VCP`, `ST-LINK UART`), else BSP `MX_Device.h`/`.ioc` |
| **Memory regions** | BSP `regions_*.h` · DFP `<memory>` · custom sizes | reuse the BSP's generated `regions_*.h` when present |

Only genuine forks belong in `AskUserQuestion`. Board name, register offsets,
and Dname suffixes are lookups (§2/§3), never multiple-choice questions.

## 2. Resolve the board and device identity — from the pdsc, never by guess

Pack root: `$CMSIS_PACK_ROOT` (default `~/.cache/arm/packs`). Install missing
packs with `cpackget add Vendor::Pack` or `cbuild --packs`.

- Device `Dname`: `grep -oE '<device Dname="[^"]*"' <DFP>.pdsc` — pick the exact
  suffix variant (`STM32H7B3LIHxQ`, not `…I6Q`).
- Board + mounted device: the BSP pdsc `<board vendor= name=>`. In the
  csolution: `board: <Vendor>::<BoardName>` (+ `device:` for clarity).
- While in the pdsc, note the default flash algorithm
  (`<algorithm … default="1">`), the SVD (`<debug svd=>`) and any debug
  sequences — that is what pyOCD consumes from `cbuild-run.yml`. A missing
  internal-flash FLM is a flashing blocker to raise **before** writing a line.
- **Does the DFP ship startup, or a generator?** Check both:
  `grep -c 'Cgroup="Startup"' <DFP>.pdsc` and `grep -o '<generator id="[^"]*"' <DFP>.pdsc`.
  A DFP with a `<generator>` (STM32CubeMX, MCUXpresso Config Tools, Infineon
  Device Configurator, Microchip MCC, …) may ship **no classic `Device:Startup`
  component at all** — startup, `SystemInit`, clock and pin configuration exist
  only as generator output (components carrying `generator="<id>"`). That
  decides §3.

If a name is fuzzy or several candidates remain, that is the moment for one
`AskUserQuestion` to disambiguate — with the resolved candidates as options.

## 3. Choose the layer strategy

Judge the DFP and the BSP's `<BSP>/Layers/*/Board.clayer.yml` on three axes —
compiler, generator, weight — and let that drive the "Layer strategy" answer:

- **Reuse** when the BSP layer matches the solution compiler and needs no
  generator (many NXP/Infineon DFPs ship proper `Device:Startup`). A thin layer
  over those is the least work.
- **Generator-based** when the DFP has no `Device:Startup` and its startup is
  generator output (§2). Do not hand-write what the generator owns; integrate
  it (§4a) and have the user run it. Check the BSP layer's compiler binding
  first: generated startup is often assembler plus a `for-compiler:` linker
  node for one compiler only — the ST case: Keil STM32 DFP 4.x + CubeMX ship
  MDK-ARM startup with `for-compiler: AC6`, which does not build in a GCC
  solution as shipped (confirmed to build in an AC6 solution for the
  STM32H7B3I-DK CubeMX layer). Regenerate for the solution's compiler, or fall
  back to minimal bare-metal.
- **Minimal bare-metal** when the vendor layer is bound to a compiler you are
  not using and regenerating is not wanted, or the user wants the smallest
  possible dependency set (§4b).

## 4a. Generator-based layer: integrate, then let the user run the generator

1. In `Board.clayer.yml` select the generator-bound components the DFP
   requires (e.g. `Device:CubeMX`, `Device:Config Tools`) plus `CMSIS:CORE`,
   `CMSIS-Compiler:*` and the Board files group; the DFP's own examples or
   the BSP layer show the exact component set.
2. Add the target-type (§5), then run one build pass:
   `cbuild <sol>.csolution.yml --active <target-type> --packs --update-rte`.
   It stops asking for the generator and writes the generator's input
   (`out/<…>/<generator>/*.cgen.yml` or the `.ioc`/config project under the
   layer's `RTE/`) — that is expected, not a failure.
3. **Tell the user to run the generator — you cannot do it for them.**
   Give the exact step: CMSIS Solution panel → **Run Configuration Generator**
   (command `cmsis-csolution.runGenerator`), or on the command line
   `csolution run -g <generator id> <sol>.csolution.yml -c <project>.<build>+<target>`.
   Say what to configure inside it (the debug UART/VCP and its pins from §1,
   the clock tree, and "generate code" for the solution's compiler) and that
   the output lands in the layer's generator directory (`<layer>/<generator>/`
   or `RTE/…`), which becomes part of the layer and is committed.
4. After they report back, build again (§6). `stdio_init` in
   `retarget_stdio.c` then calls the generated `MX_USARTx_UART_Init()`-style
   init instead of touching registers itself; keep the retarget file, drop the
   hand-written startup/system files.

## 4b. Minimal bare-metal recipe

Mirror an existing minimal layer in the repo. A complete layer is:

- **`Board.clayer.yml`** — `type: Board`, `for-board:`/`for-device:`,
  connections (`STDOUT`/`STDERR`/`STDIN`, `Heap:`), `packs` (CMSIS,
  CMSIS-Compiler, DFP, BSP), components `CMSIS:CORE` + `CMSIS-Compiler:CORE` +
  `CMSIS-Compiler:STDOUT:Custom` (+STDERR/STDIN), a Board files group, and
  `linker: - regions: ./regions_<board>.h`.
- **`main.c`** — `stdio_init()` then `app_main()`. Keep the app target-agnostic;
  target sizing goes through `#ifndef`-overridable `define:` in the csolution,
  never code edits.
- **CMSIS C startup (GCC)** — vector table in `.vectors`
  (`__VECTOR_TABLE_ATTRIBUTE`); `Reset_Handler` = `SystemInit()` +
  `__PROGRAM_START()`; a GNU range initializer `[16 ... N] = Interrupt_Handler`
  for unused IRQs. No MSPLIM/PSPLIM on ARMv7-M.
- **`SystemInit`** — FPU CP10/CP11 access, `SCB->VTOR`, caches. During bring-up
  enable **I-cache only**; a write-back D-cache makes halted-mode debugger reads
  stale and poisons the very validation you are about to do.
- **`retarget_stdio.c`** — CMSIS-Compiler Custom hooks `stdio_init`,
  `stdout_putchar`, `stderr_putchar`, `stdin_getchar`. Register-level UART is
  fine: enable the clock (read the enable register back once to let it settle),
  pin AF, BRR from the **reset** clock tree (staying on the reset oscillator
  avoids the PWR/PLL/flash-latency dance and is plenty for a validation port),
  CR enable. Take the reset clock frequency, the AF number and the register
  sequence from the reference manual via `cmsis-pack-docs`, with page cites.
- **`regions_<board>.h`** — copy the BSP's generated one
  (`Layers/*/RTE/Device/<dev>/regions_*.h`) or write from the DFP `<memory>`
  entries; add `__STACK_SIZE`/`__HEAP_SIZE`. The toolbox generates the linker
  script from it.
- **Device header** — if the DFP's is generator-bound or a multi-MB monster,
  write a minimal one: `IRQn_Type` (core exceptions + IRQ count),
  `__NVIC_PRIO_BITS`, `#include "core_cmX.h"`, and only the registers the layer
  touches.

**Register offsets come from the documentation, never from memory.** For each
register the layer touches: `search_target_docs` for its name, `read_doc_pages`
for the register description (offset, reset value, bit fields), cross-check
the offset and bit positions against the SVD (`lookup_register`), and note the
cite next to the define. Do not assume "same family, same map" — the
STM32H7A3/B3 keep the RCC clock-enable registers at 0x134…0x154 where the H743
differs. Verify the load-bearing ones on the target later (write via the
debugger, read back). Tells: reads-back-0 always → reserved/wrong address;
several registers of one peripheral reading the **same** value → the peripheral
is unclocked and the bus is echoing garbage. When the hardware disagrees with
the manual, search the errata document before changing code.

## 5. Wire into the csolution

```yaml
target-types:
  - type: <Board-Name>
    board: <Vendor>::<BoardName>
    device: <Dname>
    define:
      - APP_POOL_SIZE: 0x60000        # target sizing, #ifndef-overridable
    variables:
      - Board-Layer: $SolutionDir()$/board/<BoardName>/Board.clayer.yml
    target-set:
      - set:
        images:
          - project-context: <project>.Debug
        debugger:
          name: <chosen adapter>       # etc/debug-adapters.yml for valid names
```

Add the DFP + BSP to the solution `packs:`. Regenerate
`.vscode/launch.json`/`tasks.json` (Manage Solution → Debugger → Apply, or fill
the adapter template by hand) and repoint the clangd `--compile-commands-dir` at
the new `out/<name>/<target>/<build>`.

## 6. Build to green

Build with the toolbox the solution needs — bleeding-edge nodes (`mlops:`) may
exist only in the VS Code extension's bundled toolbox; check `csolution -V`.
`cbuild <sol>.csolution.yml --active <target-type> --packs --update-rte`. A
generated layer (AI/codegen keyed off the target, or a §4a generator) forces a
**two-pass** build — the first pass regenerates the component list or asks for
the generator and stops with "Re-run the build"; run the generator if it asked
for one, then cbuild again. RAM at "100%" in the summary is usually the stack
pinned at the region top by the template — read the map before panicking.

## 7. Confirm and hand off

Show the user the layer file set, the csolution diff, and the green build
summary. Then state the finish line honestly: a build is not a bring-up.
If a probe + VCP are attached, continue into `$csolution-retarget` §6
(serial_open → breakpoints → `cmsis_action load_and_debug` → success marker →
verify the config registers live). If no hardware is attached, say so — the
layer is validated to *compile and link*, not to run — and commit the layer
under `board/<BoardName>/` (generator output included), the csolution edit and
the regenerated `.vscode` files, noting the new target in the README.
