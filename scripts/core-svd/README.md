# Cortex-M core peripheral SVDs

`assets/svd/core/` ships one CMSIS-SVD file per Cortex-M core describing the
*core* peripherals a device SVD usually leaves out: the System Control Space
(SCB, SysTick, NVIC, MPU, SAU, FPU, DCB, DIB, ICB/SCnSCB) and the CoreSight
components inside the core (ITM, DWT, FPB/BPU, TPIU, CTI, PMU), plus the
implementation-specific blocks of Cortex-M7 / M55 / M85 / M52 / STAR (TCM and
cache control, ERRBNK, MEMSYSCTL, PWRMODCTL, EWIC, STL, …) and the Non-secure
aliases at `0xE002xxxx` on ARMv8-M. Every register and field carries a
description condensed from the Arm Architecture Reference Manuals and the
core TRMs — which is what `coreHeader.ts` (parsing `core_cm*.h` at runtime)
cannot provide. `coreSvd.ts` loads them; the header parser remains the
fallback for a core without a shipped file.

`index.json` maps the csolution / cbuild-run `core:` name (`Cortex-M33`,
`Cortex-M0+`, …) to the file, its architecture and the peripherals it holds.

| Core | File | Peripherals |
| ---- | ---- | ----------- |
| Cortex-M0, M0+, M1, SC000 | `Cortex_M0.svd` … | SCB, SysTick, NVIC, (MPU), DCB, DWT, BPU |
| Cortex-M3, M4, M7, SC300 | `Cortex_M3.svd` … | + SCnSCB, ITM, TPIU, FPB, (FPU), Cortex-M7: cache/TCM regs, ERRBNK |
| Cortex-M23 | `Cortex_M23.svd` | SCB, SysTick, NVIC, MPU, SAU, DCB, DIB, DWT, TPIU, FPB, CTI, `*_NS` aliases |
| Cortex-M33, M35P, STAR-MC1 | `Cortex_M33.svd` … | + ITM, FPU, SCnSCB |
| Cortex-M55, M85, M52, STAR-MC3 | `Cortex_M55.svd` … | + ICB, PMU, MEMSYSCTL, PWRMODCTL, EWIC, EWIC_ISA, ERRBNK, PRCCFGINF, STL, (DCAR) |

Optional components are described whether or not a particular device has
them; the ID/TYPE registers (or the DFP) say what is really present.

## Sources

1. **CMSIS-Core headers** (`core_cm*.h`, `core_sc*.h`, `core_starmc*.h` of the
   newest `ARM.CMSIS` pack in `$CMSIS_PACK_ROOT`): register names, offsets and
   access from the `Offset: 0x… (R/W) …` comments of the `*_Type` structs,
   bit fields from the `*_Pos`/`*_Msk` macros, base addresses from the
   `*_BASE` macros. Nothing the header states is typed in by hand.
2. **`core_svd_supplement.py`**: what CMSIS-Core does not model — the FPB /
   BPU, the ARMv6-M DCB and DWT, the CTI, the CoreSight PIDR/CIDR block, and
   the architectural 32-bit layout of `SHPR1-3` and `NVIC_IPRn` — from the
   ARMv6-M / v7-M / v8-M Architecture Reference Manuals and the core TRMs.
3. **`desc_*.py`**: register and field descriptions condensed from the same
   manuals, enumerated values, reset values, and the header fields to drop
   (byte-wide aliases such as `CFSR.MEMFAULTSR`, write-key aliases such as
   `DHCSR.DBGKEY` that overlap the status bits).

Known header quirks the generator corrects (each logged as a warning):
`MPU_RBAR_XN_Msk (01UL)`, `ERRBNK_*_VALID_Msk (1UL << )`, masks that disagree
with their `_Pos` (`TPIU_DEVTYPE_SubType`, `PMU_TYPE_TRACE_ON_OV_SUPPORT`,
`TPIU_ITFTTD*_data2`), a 5-bit `DIB_DDEVARCH_PRESENT`, registers listed under
two structs (`STIR`, `SFSR/SFAR`, `MVFR0-2`), and STAR-MC1 keeping the
`SCB_ITCMCR_*` bits in `EMSS_Type`.

Not covered: the ETM (its register set is per-ETM-version and vendor
configured), the MTB (device-specific base address), and the Ethos-U NPU
(`npuHeader.ts` handles that one from the driver pack).

## Regenerating

```sh
python3 scripts/core-svd/gen_core_svd.py            # newest ARM.CMSIS pack → assets/svd/core
python3 scripts/core-svd/gen_core_svd.py --cmsis ~/.cache/arm/packs/ARM/CMSIS/6.3.0 --verbose
svdconv assets/svd/core/Cortex_M33.svd --strict     # CMSIS-Toolbox validator
npm run test:unit                                   # src/test/coreSvd.test.ts loads every shipped file
```

`npm run svd:core` runs the generator. All files pass `svdconv --strict`
with no errors; the only warning (M332, "peripheral has only one register")
is for `SCnSCB` on Cortex-M1 and SC000, whose CMSIS header defines just
`ACTLR` there — pass `-x M332` to silence it. Device names are C identifiers
(`Cortex_M0plus`) because strict mode rejects `-` and `+`; `index.json`
carries the real core names.

`--inventory file.json` writes every register/field with the cores it appears
on and the keys still lacking a curated description — the authoring aid for
`desc_*.py`. Fields without curated text fall back to a pointer at the
architecture manual so nothing ships silently undocumented.

The `scripts/` directory is excluded from the VSIX; only `assets/svd/core`
ships.
