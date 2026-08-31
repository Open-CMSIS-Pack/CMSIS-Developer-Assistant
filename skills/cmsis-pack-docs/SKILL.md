---
name: cmsis-pack-docs
description: Look things up in the documentation of the current CMSIS csolution target through the CMSIS Developer Assistant documentation tools (list_target_docs, search_target_docs, read_doc_pages, fetch_doc, get_peripheral_docs) — the reference manual, datasheet, errata and board manual the packs ship or link, the Arm documents for the device's core (architecture reference manual, ADIv5/ADIv6, CoreSight and ETM specifications, core TRM), and PDFs the user dropped into the workspace docs folders. Use before assuming what a peripheral register or bit does, when the SVD gives a bit position but not its meaning, when a peripheral does not behave as expected (check the errata), when a debug/trace bring-up skill needs a vendor or Arm document, or when the user asks where something is documented. Cites document id, edition and page. The tools are off by default: the setting `cmsis-developer-assistant.packDocs.enabled` turns them on (window reload).
---

# CMSIS Pack Docs

The device family pack (DFP) and board pack (BSP) of a csolution target
ship or link the vendor documentation; the device's core determines which
Arm documents apply. These tools make all of it searchable page by page,
and fetch what is only linked.

## Workflow

1. `list_target_docs` once per session. It resolves the target (or takes
   `pack` + `device`), prints the core (`Core: Cortex-M33 r0p0 (Armv8-M)`)
   and lists four groups with an id and a state per row:
   - pack documents — `indexed, N p` or `not indexed yet` (searchable);
   - web-linked vendor documents — `web — not fetched (fetch_doc { doc })`;
   - **Arm documents for the core** — architecture reference manual, ADIv5
     and ADIv6, CoreSight architecture and SoC/components TRMs, ETM, core
     TRM — as `arm/<id>-<version>` rows, also `not fetched` until asked;
   - user documents — `user/<name>`: manuals the user supplied outside the
     packs (NDA documents, portal downloads) from the user documents folder,
     attributed to this pack/device/board/core; searchable like pack docs;
   - workspace documents — PDFs in `.agent-artifacts/docs` or `docs`
     (setting `cmsis-developer-assistant.packDocs.workspaceDocDirs`), searchable.
   When a pack ships no manual and a document is needed, tell the user
   about *CMSIS Developer Assistant: Import Document for Current Target* — a PDF they
   have becomes searchable in one step.
2. `search_target_docs { query }` with the identifiers the manual uses:
   register names (`RCC_AHB1ENR`), bit names (`GPIOAEN`), addresses
   (`0x40023800`), or a `"quoted phrase"`. Narrow with `doc` when the target
   has several manuals. The first call on a document extracts and indexes
   it; expect a few seconds for a 3 000-page manual. Pack, fetched and
   workspace documents are searched by default; unlisted pack PDFs only
   with `includeUnlisted: true` or a `doc` filter.
3. `fetch_doc { doc }` for a `not fetched` row — a vendor book by its id, an
   Arm document by its row id or bare document number (`ihi0031`,
   `ddi0553`, `100230`), or `{ url }` for a direct PDF link. Only this call
   downloads anything; the copy lives in the extension's cache, not in the
   workspace, and is listed with every target from then on. The result
   names the edition the service resolved (`version bz (B.z)`); an errata
   edition lists the other editions.
4. `read_doc_pages { doc, pages }` for the full page(s) around the best hit
   before answering — snippets are 400 characters.
5. `get_peripheral_docs { peripheral }` when the question is about one
   peripheral instance (`USART1`, `TIM2`, `GPIOA`): one call returns the
   chapters that cover it with page ranges, the page of every register, the
   RCC clock-enable/reset bits (from the SVD) with their page, the vector
   numbers and errata mentions — then `read_doc_pages` the page you need.
   Narrow with `aspects` (`chapters`, `registers`, `clock`, `irq`, `errata`)
   to keep the output short. A type name (`UART`) lists the instances.
   Arm core peripherals (`SCB`, `NVIC`, `SysTick`, `DWT`, `ITM`, `TPIU`,
   `DCB`, `MPU`, `SAU`) work too — they come from the CMSIS-Core header,
   and their chapters from the fetched Arm documents (architecture manual,
   core TRM, GUG).

## Citing

Cite `<doc id> <edition> p.<n>` with the section from the hit, for example
`stm32u5xx-dfp/rm0456 p.519 §11.8.29 RCC_AHB2ENR1` or
`arm/ihi0031-latest h p.108 §B4.3 Dormant state`. The edition is printed in
brackets in every hit and page header (`arm/ddi0553-latest [B.z] p.1207`);
never omit it for a fetched document — the bring-up knowledge contracts
require "document edition/revision and section/page". For a pack PDF with
no edition in the output, name the pack version instead
(`Keil::STM32U5xx_DFP@2.1.0`). Never cite a snippet alone; read the page.

## For the bring-up skills (debug-access-knowledge, debug-knowledge, trace-knowledge, board-debug-knowledge)

Before writing a row into a record's *Documents requiring user download*
table:

1. `list_target_docs` — the document is often already there.
2. Vendor documents first: the reference manual (debug support, RCC, DBGMCU,
   GPIO alternate functions, boot, option bytes), datasheet (pin tables),
   errata and board manual come from the packs; a web-linked one is one
   `fetch_doc { doc }` away.
3. Arm documents only for the facts that are Arm's to define — DP/AP
   behaviour, dormant state and `TARGETSEL` (`ihi0031`), APv2 addressing
   and ROM tables (`ihi0074`), DHCSR/DEMCR/AIRCR reset and halt semantics
   and debug authentication (`ddi0419`/`ddi0403`/`ddi0553`), fixed PPB
   addresses, TPIU port sizes and SWO modes (core TRM), identifying a
   scanned CoreSight component by its part number (CoreSight TRMs). Do
   **not** fetch CoreSight TRMs to program funnels, replicators, ETF/ETB/
   ETR, TPIU or SWO: the trace generator templates own that.
4. If `fetch_doc` reports a dead or unknown URL, run
   `$resolve-official-device-documentation`, then
   `fetch_doc { url: <Replacement official URL> }`.
5. Only then add the *Documents requiring user download* row, with
   **Requested workspace path** `.agent-artifacts/docs/<file>.pdf` — a copy
   placed there is listed and searched automatically.

When a document came through these tools, put its id in the record's
*Requested workspace path* / source column (`arm/ihi0031-latest h`) and copy
the resolved `version` and `versionLabel` from the `fetch_doc` output into
the Evidence table, so a later change of `latest` is detectable.

## Rules of thumb

- The SVD is authoritative for bit positions and reset values
  (`lookup_register`); the manual is where
  the semantics, sequences and constraints live. Use both.
- Errata sheets are documents too — search them when hardware behaves
  differently from the manual.
- Prefer one search with the exact identifier over several vague ones.
- If `list_target_docs` cannot resolve the target, build the solution first
  (so `*.cbuild-run.yml` exists) or pass `pack` and `device`.
- Never ask the user for a datasheet or manual before `list_target_docs` and
  `fetch_doc` have been tried, and never read a PDF into your context — it
  costs hundreds of thousands of tokens and yields no page cites. A document
  the user hands you goes into the workspace `docs/` folder (or the *CMSIS
  Developer Assistant: Import Document for Current Target* command for
  documents that should be attributed to a pack, device or board and kept
  outside the repository); then it is indexed and searched like the rest.
- If the tools are missing from your tool list they are switched off: point
  the user at `cmsis-developer-assistant.packDocs.enabled` (window reload)
  instead of asking for documents.
