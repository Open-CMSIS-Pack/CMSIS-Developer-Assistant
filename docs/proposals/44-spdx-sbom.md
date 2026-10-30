# #44 Proposal: Can we make the assistant to generate SPDX formatted SBOM files?

> **2.7.0 status (2026-10-27).** The SBOM workflow remains a proposal. Its local skill-vendoring and picker steps are obsolete: procedure sources belong to the knowledge base, which also imports cmsis-skills directly. Remaining choices are listed for the [knowledge and documentation review](../reviews/2026-10-28-knowledge-and-docs.md). The original proposal below is historical.

| | |
|---|---|
| Issue | [#44](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues/44) |
| Area · priority · source | Build info · Medium (proposed) · External (KeilChris; comment by ReinhardKeil) |
| Original release plan | Future (WP-O) |
| Size | M overall; the part in this repo is XS |
| Depends on | none |
| Related | #51 (reads the same `*.cbuild.yml`, `processor:` block), #17 and #41 (toolchain facts from `.cmsis/tools-environment.yml`), #21 (asks owned by other teams) |
| Original status | Proposed, awaiting review (2026-09-23) |

## Problem

**What was asked.**

- KeilChris: the Cyber Resilience Act makes SBOMs mandatory; can the CMSIS Developer Assistant help generate SPDX SBOM files?
- ReinhardKeil: this should be a skill over the CMSIS-Toolbox build-information files, which already carry license information and the source file list; possibly extended to Zephyr.

Nothing in 2.3.10 touches SBOM, SPDX or licenses. The inputs exist, but they are build outputs: the generated CMSIS `.gitignore` excludes `*.cbuild.yml` and `*.cbuild-idx.yml`. An SBOM can only be made after `cbuild` or `cbuild setup` has converted the solution.

The inputs also have gaps that an SBOM cannot paper over:

- The packs in the test fixture declare no SPDX license: both entries read `license: <unknown>`. ARM::CMSIS@6.0.0 is Apache-2.0 and ships a LICENSE file, which cbuild.yml lists only as `license-agreement`.
- The C runtime library linked in is visible only as a linker flag (`misc: Link: --specs=nano.specs`).
- Files carry no hashes.
- CMSIS packs have no registered package-URL (purl) type.

## Current state (2.3.10)

- **No SBOM code.** There is no SBOM, SPDX or license code in `src/`. `parseCbuildYml` ([artifacts.ts:181-224](../../src/core/buildInfo/artifacts.ts#L181-L224)) reads only `compiler`, `context`, `device`, `processor.core`, `output-dirs`, `output` and `linker.script`.
- **Fixture** `Blinky.Debug+MPS3.cbuild.yml`, which a build of `test/eval/fixtures/corstone-blinky` writes to `build/MPS3/GCC/Debug/Blinky/outdir/`, has what an SBOM needs:
  - `board`, `board-pack`, `device`, `device-pack` (lines 7-14);
  - `processor` (27-31);
  - `packs` with `pack` and `path` (32-36);
  - `misc` (39-49);
  - `components` (85-243): id with version, `from-pack`, `selected-by`, and `files` with `category`, `attr` (`config`, `template`) and `version`;
  - `apis` (244-254);
  - `groups`, the user sources (258-274);
  - `constructed-files` (275-277);
  - `licenses` (278-298): `license`, `license-agreement`, `packs`, `components`.
- **Index file.** `Blinky.cbuild-idx.yml`, written by the same build next to the csolution, lists the contexts of the active target (`cbuilds[]`), `packs-unused` and csolution's messages. The format is documented in [YML-CBuild-Format](https://open-cmsis-pack.github.io/cmsis-toolbox/YML-CBuild-Format/), which says nothing about SBOM, hashes or runtime libraries.
- **Skills.**
  - The catalog category `devops` exists ([skillCatalog.ts:28-41](../../src/utils/skillCatalog.ts#L28-L41)); no vendored skill uses it at the pinned commit `d778b91`.
  - Upstream `Open-CMSIS-Pack/cmsis-skills` `main` has since added `devops/create-csolution-github-action` (commit `94ad394`) and a new category `ethos-u`.
  - `scripts/sync-skills.ts` rejects unknown categories ([sync-skills.ts:159-166](../../scripts/sync-skills.ts#L159-L166)), so `npm run skills:sync -- --update` fails today until `SkillCategory` learns `ethos-u`.
  - Bundled skills are always installed and cost every user context. Vendored skills are opt-in through `installedSkills`.
- **Tool-list budget.** Measured with `test/transport/session-lifecycle.js` on the f76aa8b build: single-window 28 799 of 30 000 B ([session-lifecycle.js:149](../../test/transport/session-lifecycle.js#L149)); all groups 40 527 of 42 000 B.
- **Zephyr** has native SBOM support: `west spdx` writes SPDX 2.x tag-value documents for the application, Zephyr and the build. It needs `west spdx --init` before the build configures. Verify the flags against the Zephyr version in use.

## Proposed fix

Where each part belongs:

| Part | Home | Why |
|---|---|---|
| The SBOM workflow: resolve the context, run the converter, validate, report gaps | a skill `devops/generate-sbom` in Open-CMSIS-Pack/cmsis-skills | ReinhardKeil's proposal; it sits next to `create-csolution-github-action`, which can then emit the SBOM in CI |
| The converter from cbuild YAML to SPDX 2.3 JSON | a script shipped in that skill (`scripts/`) | hashing hundreds of files and assembling JSON must be deterministic, not model-written |
| Native SBOM output (`cbuild … --sbom` or a csolution command) | CMSIS-Toolbox | the durable home, like `west spdx`; the skill then calls it |
| License metadata of packs | pack vendors (PDSC license information) | `<unknown>` in cbuild.yml comes from the packs |
| Vendoring, picker and cmsis-help entry | this repo | `npm run skills:sync`; no bundled skill, no new MCP tool |

**Format.** SPDX 2.3 JSON. The common validators (`pyspdxtools` from spdx-tools) and consumers read it today, and GitHub's SBOM export uses it. SPDX 3.0 (JSON-LD, profiles) can follow when tooling catches up. CRA guidance accepts SPDX, but the exact version and field set required should be confirmed with the proposers.

**Mapping** proposed to the skill owners; the relationship details are theirs to settle:

| cbuild input | SPDX 2.3 |
|---|---|
| document | `spdxVersion: SPDX-2.3`, `dataLicense: CC0-1.0`, `documentNamespace` with a UUID, `creators: Tool: generate-sbom <ver>` plus `Tool: csolution <generated-by>` |
| one `cbuilds[]` context from cbuild-idx (for example `Blinky.Debug+MPS3`) and its `output` ELF | root package (`primaryPackagePurpose: FIRMWARE`, `DESCRIBES`); the ELF as a File with SHA-256. Multi-core targets get one root per image |
| `packs[]` (`ARM::CMSIS@6.0.0`) | Package: name `ARM::CMSIS`, `versionInfo: 6.0.0`, `supplier: Organization: ARM`, `downloadLocation` from the PDSC `<url>` or `NOASSERTION`, `filesAnalyzed: false`, purl `pkg:generic/…` until a CMSIS purl type exists |
| `components[]` (`ARM::CMSIS:CORE@6.0.0`) | Package with `versionInfo`; pack `CONTAINS` component; root `CONTAINS` component |
| `components[].files[]` with category source, header, library, object or linker script | File with SHA-1 and SHA-256 after expanding `${CMSIS_PACK_ROOT}`. `attr: config` files are the project's RTE copies. Skip `doc`, directory-valued `include` entries and unselected templates |
| `groups[].files[]`, `constructed-files[]` | Files of the root package (user code, generated `RTE_Components.h`) |
| `licenses[]` | `licenseDeclared` on the listed packs and components: the SPDX ID when it is one; `<unknown>` becomes `NOASSERTION`; `<proprietary> …` becomes `LicenseRef-…` with the text from `license-agreement` in `hasExtractedLicensingInfos`; `licenseConcluded: NOASSERTION` |
| `compiler`, `misc.Link` (`--specs=nano.specs`), toolchain version from `.cmsis/tools-environment.yml` | the toolchain and its C library as packages with `BUILD_TOOL_OF` or `STATIC_LINK`, flagged as "declared from flags, not from the build information" |

**Phased path.**

1. **Phase 0, now (no code).** Answer the proposers (draft below), move #44 to Backlog with Version Future, and offer the corstone-blinky fixture and our review.
2. **Phase 1, in cmsis-skills (owner: the proposers).** The skill, the converter and a test that runs the converter on the corstone-blinky fixture and validates the output with `pyspdxtools`. The skill reports its gaps: unknown licenses, runtime libraries seen only as flags, files that could not be hashed. For Zephyr solutions it delegates to `west spdx`.
3. **Phase 2, in this repo (XS).**
   - Add `ethos-u` to `SkillCategory`, `SKILL_CATEGORY_ORDER` and the labels (needed for any upstream sync).
   - Run `npm run skills:sync -- --update`; this regenerates `catalog.json` and cmsis-help.
   - Mention the skill in the README skills table.
   - No bundled skill and no router: `devops` stays a picker group.
4. **Phase 3, in CMSIS-Toolbox.** Native SBOM output; the skill switches to it. It needs a PDSC license field that packs actually fill in.

**No MCP tool.** A `get_build_inventory` tool would cost about 450 to 600 B of `tools/list` for data the agent can read from the workspace YAML. It would also push hundreds of file entries through the model's context. The converter reads the files directly, which is cheaper and deterministic. An optional zero-byte hook is a one-line summary in `list_build_artifacts` ("packs 2 · components 10 · licenses: 2 unknown"). That needs `parseCbuildYml` to parse `packs`, `components` and `licenses`, which #51 also wants for `processor:`. Decide it with #51, not here.

Draft answer on #44:

```text
Thanks, agreed that this is a skill over the CMSIS-Toolbox build information. Proposal:
- Home: Open-CMSIS-Pack/cmsis-skills, devops/generate-sbom (next to create-csolution-github-action), with a
  deterministic converter script; output SPDX 2.3 JSON, validated with pyspdxtools. We vendor it into the
  CMSIS Developer Assistant's skill picker; no new MCP tool.
- Input: *.cbuild-idx.yml + *.cbuild.yml (packs, components/files, groups, licenses). Gaps to report, not hide:
  packs without license info come out as <unknown> (see the corstone-blinky example), the C runtime library is
  only visible as a linker flag, files need hashing.
- Zephyr: delegate to west spdx.
- Longer term a native cbuild/csolution SBOM output would be the durable home.
Would you own the skill (we review and provide the test fixture)? Which SPDX version and fields does your CRA
checklist require?
```

## What changes for the agent and the user

```text
Now:    "Generate an SBOM" → the agent improvises from the YAML or refuses.
After Phase 2 (skill installed from the picker, devops group):
        the agent runs the generate-sbom skill → out/sbom/Blinky.Debug+MPS3.spdx.json (validated)
        plus a gap report: "2 packs without license information (ARM::CMSIS@6.0.0, ARM::V2M_MPS3_SSE_300_BSP@1.5.0);
        C library from --specs=nano.specs declared from flags"
```

## Decisions for you

- [ ] **Home of the skill.** **Recommended:** Open-CMSIS-Pack/cmsis-skills, owned by the proposers and vendored here, because it is useful outside VS Code and CI can reuse it. Alternative: a bundled skill in this repo, which we control fully but which costs every user context and ties the skill to our release cycle.
- [ ] **SPDX version.** **Recommended:** 2.3 JSON, which today's validators and consumers read. Alternatives: 3.0 JSON-LD, which is current but thinly supported; or CycloneDX, which is not what was asked.
- [ ] **Helper MCP tool.** **Recommended:** none; the converter reads the YAML itself (0 B). Alternative: `get_build_inventory` (about 500 B of `tools/list`, near the budget) only if a client without file access needs it.
- [ ] **Fix the `ethos-u` sync blocker now.** **Recommended:** yes, as a small commit independent of #44, since any `skills:sync --update` fails until it is fixed. Alternative: wait for Phase 2.

## Tests and acceptance

- **In cmsis-skills (Phase 1).**
  - The converter on the corstone-blinky fixture produces a document that `pyspdxtools -i` validates, with 2 pack packages, 10 component packages and the group files.
  - `<unknown>` licenses come out as `NOASSERTION`, and the gap report lists them.
- **In this repo (Phase 2).**
  - `npm run skills:sync -- --update` succeeds with the new category.
  - `skillCatalog.test.ts` covers an `ethos-u` entry and a `devops` entry.
  - `skill.test.ts` stays green.
  - cmsis-help lists the new skill under DevOps.
  - `session-lifecycle.js` budgets unchanged.

## Out of scope and follow-ups

- **Pack metadata.** A purl type and a registry for CMSIS packs are Open-CMSIS-Pack spec work.
- **Vulnerability data.** VEX and CVE matching need CPEs that packs do not declare.
- **Signing.** Signing or attesting the SBOM is for the CI skill or the release pipeline.
- **Owner asks.** Native SBOM output in CMSIS-Toolbox and filled-in pack license fields go into the WP-Q (#21) forwarding list.

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
