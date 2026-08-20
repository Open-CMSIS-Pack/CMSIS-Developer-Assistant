---
name: identify-cmsis-board-support
description: Resolve a supplied board or device to exactly one verified CMSIS identity, identify its BSP or DFP, and ask the user when multiple candidates remain. Use when a CMSIS solution needs verified board, device, and pack identifiers.
---

# Identify CMSIS Board Support

## Target & Persona

- **Role:** CMSIS Pack Integrator
- **Objective:** Resolve the requested hardware to exactly one verified board and fitted device, or exactly one device for device-only input, and identify its CMSIS support pack.

## Prerequisites & Context

- **Expected input:** A user-supplied board or device name, which may be fuzzy. Manufacturer, board revision, and fitted MCU or SoC evidence should be included when available.
- **Dependencies:** Access to the Keil Boards and Devices catalogs. An active CMSIS-Toolbox environment is optional for installed-pack cross-checks.
- **Portability:** Applies across MCU and SoC vendors when their board or device is represented in the referenced catalogs. It has no compiler, RTOS, debugger, or probe dependency.

Collect when available:

- physical board manufacturer, model, and revision;
- exact fitted MCU or SoC from authoritative board information.

An `identify-zephyr-board` result provides suitable input for a Zephyr-supported
board, but this skill does not depend on Zephyr.

## Execution Steps (Strict Workflow)

1. **Analysis:** Determine whether the input requests a physical board or a device, then collect every plausible exact identity from authoritative information.
2. **Processing:** Resolve each required board or device identity to exactly one choice before accepting its support pack. Search the board catalog first for board input, then the device catalog for the exact fitted device whether or not a BSP is established.
3. **Validation:** Confirm every accepted catalog result against the board, device, processor/core, family, and optional installed-pack query. Do not proceed while a required identity has zero or multiple choices.
4. **Formatting:** Return the defined `BSP`, `DFP`, `AMBIGUOUS`, or `NO MATCH` result with exact identifiers, candidates when applicable, and supporting URLs.

### Detailed procedure

1. Define the identities that must be unique:
   - for board input, one exact physical board model/revision and one exact fitted
     CMSIS device `Dname`;
   - for device-only input, one exact CMSIS device `Dname`.
2. For board input, search the complete [Keil Boards catalog](https://www.keil.arm.com/boards/)
   and authoritative manufacturer information using the supplied manufacturer,
   model, revision, and device terms. Keep all plausible board models or revisions;
   do not select the first, closest, or locally installed result.
3. Normalize and de-duplicate candidates by exact board identifier, including its
   revision. If more than one plausible board remains, return `AMBIGUOUS`, list
   the exact candidates and distinguishing details, and ask the user to choose.
   If the physical board cannot be established, return `NO MATCH`.
4. Accept a BSP match only when its detail page identifies the uniquely selected
   physical board and fitted device. Record the exact CMSIS board identifier,
   CMSIS device identifier, and BSP pack identifier. A uniquely identified board
   without a BSP may still continue to DFP lookup for its authoritative fitted device.
5. Search the complete [Keil Devices catalog](https://www.keil.arm.com/devices/)
   using the fitted device for board input or the supplied device terms for
   device-only input. Include this search when a matching BSP was found.
6. Normalize and de-duplicate device candidates by exact CMSIS `Dname`. Multiple
   processor `Pname` entries belonging to the same `Dname` are one device identity
   unless the requested target must select a processor. If more than one plausible
   `Dname` or required processor remains, return `AMBIGUOUS`, list the exact
   candidates and distinguishing details, and ask the user to choose. If no device
   can be established, return `NO MATCH`.
7. Accept a DFP match only when the vendor, device or supported device pattern,
   processor/core, and family are compatible. Record the exact CMSIS device
   identifier and DFP pack identifier.
8. When the CMSIS-Toolbox environment is active, cross-check installed packs
   with `csolution list boards --filter <terms>` or
   `csolution list devices --filter <terms>`. Installed-pack results are supporting
   evidence only: they may be a subset of the online catalog and therefore cannot
   establish uniqueness or eliminate other candidates. An empty local result does
   not prove that the online catalog lacks a BSP or DFP.

Return `BSP` or `DFP` only after every required identity resolves to exactly one
choice. Prefer the matching BSP over a DFP-only result. Never silently choose
among plausible candidates.

## Guardrails & Constraints (Strict Rules)

- **No fabrication:** Do not invent CMSIS board, device, BSP, or DFP identifiers, and do not infer support from a similar part name.
- **Portability:** Do not add vendor, toolchain, RTOS, debugger, or probe assumptions beyond the verified catalog result.
- **Exactly-one gate:** Do not return a usable support result unless every required board/device identity resolves to exactly one choice. For multiple choices, ask the user to select from the exact candidates before continuing.
- **Critical blockers:** Stop when a required identity has no authoritative match, neither catalog match is established, or the user has not resolved an `AMBIGUOUS` result.
- **Scope:** Identify CMSIS support only; do not install packs, create a project, or configure hardware.
- **Tone and style:** Respond factually and directly. Omit conversational filler.

## Expected Output

Report:

- status: `BSP`, `DFP`, `AMBIGUOUS`, or `NO MATCH`;
- physical board and fitted device used for the lookup;
- exact CMSIS board identifier when status is `BSP`;
- exact CMSIS device identifier;
- exact BSP pack identifier when status is `BSP`;
- exact DFP pack identifier for the fitted device; when status is `BSP`, report
  whether it is the same pack as the BSP or a separate pack;
- supporting catalog URLs;
- for `AMBIGUOUS`, the exact candidate board identifiers or device `Dname` values,
  their distinguishing manufacturer/revision/device details and supporting URLs,
  followed by one focused question asking the user to choose;
- the missing identity or mismatch when status is `NO MATCH`.

Do not invent CMSIS identifiers, infer support from similar part names, or treat an
empty installed-pack query as proof that no online pack exists.

## Validation Resources

- [Keil Boards catalog](https://www.keil.arm.com/boards/)
- [Keil Devices catalog](https://www.keil.arm.com/devices/)
- CMSIS-Toolbox `csolution list boards` and `csolution list devices` commands
