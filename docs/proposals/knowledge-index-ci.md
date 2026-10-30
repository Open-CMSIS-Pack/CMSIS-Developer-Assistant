# Build the core knowledge index in CI instead of by hand

> **Historical proposal; 2.7.0 outcome (2026-10-29).** Phases 1–3 shipped: `resources/knowledge/core.lock.json` pins the core index by version and sha256, `npm run knowledge:fetch` downloads and checks it, CI fetches it before the tests and packaging, packaging refuses a VSIX without it, and the knowledge-base repository builds and releases the index in its own CI. Phase 4 in part: the store refuses an index of another major `schema_version`; replies do not name the index version yet. Phase 5 is open. The text below is the proposal of 19 October.

| | |
|---|---|
| Issue | none yet |
| Area · priority · source | Packaging, knowledge · High · the v2.7.0 fork release, 2026-10-18 |
| Original release plan | phase 1 with the next release (2.7.1); phases 2–3 when the knowledge-base repository is on GitHub; phase 4 later |
| Size | phase 1 S, phase 2 S, phase 3 M, phase 4 XS, phase 5 S |
| Depends on | phases 2–3: the knowledge-base repository on GitHub (Decision 1) |
| Related | [knowledge-base.md](knowledge-base.md) (phase 0 "index contract", phase 3 "delivery"), the `skills/cmsis-skills.lock.json` pin |
| Original status | Proposed, awaiting review (2026-10-19) |

## Problem

The core index `resources/knowledge/core.db` reaches a VSIX only when someone copies it in by hand. The
v2.7.0 pre-release on the fork showed what that costs: CI packaged all five platforms without the index
(3.27 MB each instead of 16.25 MB), nothing failed, and every `knowledge_search`, `knowledge_get` and
`knowledge_expand` call of those builds was refused with "The knowledge index … does not exist". The
release assets had to be replaced by VSIX files built on one Mac.

Three things make it fragile beyond the missing copy step:

- **Nobody else can build the index.** It comes from the knowledge-base repository, which has no Git remote,
  uncommitted changes in `tools/build_index.py`, `tools/kb_lib.py`, `tools/skill2ku.py` and
  `scripts/rebuild.sh`, and its split build script (`scripts/build_split.sh`) is not committed at all.
  The maintainers who publish to the Marketplace have no way to produce the file.
- **Nothing says which index a VSIX carries.** `build_index.py` writes the `info` table only when it builds
  vectors (line 229), so the shipped index has no version, build date or source revision.
- **Nothing checks what goes in.** The `units/` folder also holds copyrighted book units ("not for
  distribution") and CC BY-SA documentation. Today the right selection depends on running the right script
  on the right machine.

## Current state

### This extension

- `.gitignore:44` ignores `resources/knowledge/*.db`. `docs/architecture/knowledge.md:12` says the file is
  "copied in from the knowledge-base repository".
- The `package` job of `.github/workflows/ci.yml` runs `npm ci` and `npm run package -- --target <t>` on
  ubuntu for each of the five targets. No step provides the index, and `scripts/package.ts` packages
  whatever `resources/` holds, so a missing index is silent.

### The index 2.7.0 ships

`cmsis-knowledge-base/build/knowledge.core.db` of 16 October 13:05, 65 MB, sha256
`a54734078376e95f22926b4862abfa80dba5f376d012d11bbd96dc954253e3e9`, 7 064 units:

| Licence (unit frontmatter) | Units |
|---|---|
| Apache-2.0 | 4 796 |
| MIT | 1 022 |
| BSD-3-Clause | 493 |
| "own summary of a GitHub issue" (issue digests) | 526 |
| none given (procedures, rules and routes converted from cmsis-skills and this extension, Apache-2.0 sources) | 227 |

No CC BY-SA unit and no book unit is in it. Its content is the default set of `scripts/rebuild.sh`
without `CCBYSA`: skills, canonical, extracted, troubleshooting, cda-skills, cda-routes, the documentation
(`units/docs`) and the issue digests. That is not what `build_split.sh` calls "core": that one leaves the
documentation out (`knowledge.core-nodocs.db`, 28 MB).

### What building it takes

- **Building the index** is cheap and deterministic: `tools/build_index.py --no-vec` over committed Markdown
  units (9 322 tracked files, 74 MB) and committed entities (`build/entities/*.jsonl`). It needs Python 3,
  PyYAML and SQLite with FTS5 (in the standard library; checked with SQLite 3.50.4). No network, no model.
- **Making the units** is not: fetching the pack index and PDSC files, cloning the documentation sources,
  the stage 2 results, the issue digests and the error catalog involve the network, review and in places a
  language model. Their results are committed units. This stays a maintainer step, and CI builds only from
  what is committed.
- **There is a cycle.** The knowledge base converts this extension's own skills (`CDA=<checkout>` →
  `units/cda-skills`, `units/cda-routes`), and this extension ships the knowledge base's index.

## Proposed fix

### Phase 1: pin the index and fail without it (S, this repository, now)

This phase fixes the CI gap without waiting for anything else.

1. **Publish the 2.7.0 index once as a release asset**, as `knowledge-core-2026.10.16.db` with its
   `.sha256` (where: Decision 1). It is the first pinned version and keeps 2.7.0 reproducible.
2. **`resources/knowledge/core.lock.json`**, committed, the same idea as `skills/cmsis-skills.lock.json`:

   ```json
   { "version": "2026.10.16", "url": "https://…/knowledge-core-2026.10.16.db",
     "sha256": "a547…e3e9", "size": 65413120, "units": 7064 }
   ```

3. **`scripts/knowledge-index.ts`** with two npm scripts:
   - `npm run knowledge:fetch` downloads the file when `resources/knowledge/core.db` is missing or its
     sha256 differs from the lock, checks the hash, and writes the file;
   - `npm run knowledge:update -- <version>` rewrites the lock from a release's metadata file.
4. **Packaging refuses a VSIX without the pinned index.** `scripts/package.ts` checks that the file is
   there and matches the lock before it calls `vsce`. The CI `package` job runs `npm run knowledge:fetch`
   first and caches the file by its sha256. An unpinned local index (a developer's rebuilt one) needs an
   explicit `--index-unpinned` flag, so it cannot slip into a release.

### Phase 2: the knowledge-base repository builds reproducibly (S, knowledge-base repository)

1. Commit the open changes and the untracked build scripts. Leave out what must stay local: the book tooling
   and `units/books*` stay git-ignored.
2. **`scripts/build_core.sh`**: the one recipe for the shipped index, the unit folders above, `--no-vec`.
3. **`requirements-build.txt`** with exact versions (PyYAML only). `requirements.txt` has lower bounds only.
4. **`build_index.py` always writes `info`**, also without vectors:
   - `schema_version` (1);
   - `built_at`, taken from the commit time so that two builds of one commit are identical;
   - `kb_commit`;
   - the revisions of cmsis-skills, devtools and this extension that the units were converted from;
   - the unit count per licence.
5. **A licence gate, `tools/check_licences.py`.** Every unit in the recipe needs a `license` field: the 227
   units without one get the licence of their source. The gate fails on anything outside the allow-list
   (Apache-2.0, MIT, BSD-3-Clause, the issue-digest marker), on CC BY-SA and on `mode: P`.

### Phase 3: the knowledge-base repository releases the index (M, knowledge-base repository)

A workflow `index.yml`:

- **On every push and pull request:**
  - set up Python, install `requirements-build.txt`, then run `build_core.sh`, the licence gate,
    `tests/test_kb.py` and `build_index.py --strict` (stale `applies_to` targets);
  - build a second time and compare the sha256, so the build is known to be deterministic;
  - run the golden-set retrieval check (`tests/eval_search.py`) and report Recall@5 (Decision 5);
  - upload the index as an artifact.
- **On a tag `core-YYYY.MM.DD`:** a release with `knowledge-core-<version>.db`, its `.sha256`, and
  `knowledge-core-<version>.json` (the `info` table and the licence counts). `knowledge:update` reads that
  JSON.

### Phase 4: the extension checks the index it opens (XS, this repository)

- The knowledge store reads `info.schema_version` and refuses another major version with a typed error.
  This is phase 0, item 2 of [knowledge-base.md](knowledge-base.md).
- `knowledge_search` names the index version in its "Indexes:" line, and `get_session_status` names it too.

### Phase 5: keep the two repositories in step (S, both, later)

- A knowledge-base release sends a `repository_dispatch` to the fork, whose workflow opens a pull request
  that runs `knowledge:update`.
- Against the cycle: the index records the extension commit its `cda-skills` were converted from
  (`info.cda_commit`). This repository's CI warns when `skills/` changed since that commit, which means the
  knowledge base should convert the extension's skills again.

## What changes

```text
2.7.0   CI: npm ci → npm run package          → VSIX 3.27 MB, no index, nothing fails
        release: VSIX rebuilt by hand on one Mac and uploaded over the CI ones

new     CI: npm ci → knowledge:fetch (lock, sha256 checked, cached) → npm run package
        → VSIX 16.25 MB with the pinned index; packaging fails if it is missing
        knowledge_search: "Indexes: base core-2026.10.16 (7 064 units), …"
```

## Decisions for you

- [ ] **1. Where the knowledge-base repository and its releases live.** **Recommended:** a public GitHub
  repository (the legal review is done). The fork's CI, the upstream CI and the Marketplace maintainers then
  fetch the index without a secret.
  - Alternative a: a private repository. The fork's CI needs a token; the upstream repository cannot fetch it
    without one, so upstream releases would depend on the fork.
  - Alternative b: no repository for now; the index files are release assets on the fork (a tag such as
    `knowledge-core-2026.10.16`). This is enough for phase 1 and can move later; only the `url` in the lock
    changes.
- [ ] **2. Who builds.** **Recommended:** the knowledge-base CI builds and releases, and this repository
  pins a version.
  - Alternative: this repository's CI checks out the knowledge base at a pinned commit and builds the index
    itself. No release step, but this CI then depends on the knowledge base's tooling and on access to it,
    and every package job builds the index again.
- [ ] **3. What the shipped index contains.** **Recommended:** as in 2.7.0, everything in one file including
  the documentation (65 MB, 16 MB in the VSIX).
  - Alternative: the core without the documentation in the VSIX (28 MB), and the documentation as a pack
    index (`Local::CMSIS_Knowledge`) installed separately. A smaller VSIX, but one more thing to install.
- [ ] **4. Versions and cadence.** **Recommended:** date tags (`core-2026.10.16`); an extension release pins
  one, and a bump is an ordinary pull request (phase 5 automates it).
- [ ] **5. The golden-set check.** **Recommended:** report only at first, then fail when Recall@5 drops by
  more than an agreed margin against the last release.

## Tests and acceptance

- **Phase 1:**
  - A CI run on the fork produces five VSIX files of about 16 MB, each containing
    `extension/resources/knowledge/core.db` with the lock's sha256.
  - Removing the lock entry or corrupting the file makes `npm run package` fail with a message that names
    `knowledge:fetch`.
  - Unit tests: parsing the lock, the hash check, and that the cache hit skips the download.
- **Phase 2:** a build from a clean clone gives 7 064 units with the licence counts above, or explains every
  difference against the 2.7.0 index. The licence gate fails on a planted CC BY-SA unit and on a unit
  without a licence.
- **Phase 3:** two builds of one commit give the same sha256. A tag produces the three release files.
- **Phase 4:** an index with `schema_version` 2 is refused with the typed error, and the version shows in
  `knowledge_search`.

## Out of scope

- Vectors and embeddings (the extension searches BM25 only).
- The CC BY-SA tier and the book units: they stay out of every published index.
- Pack indexes: `Local::CMSIS_Knowledge`, and packs such as the micro:bit BSP, which already build their
  `.knowledge/knowledge.db` in their own CI with `cmsis-knowledge`.
- Making the units themselves in CI (fetching sources, stage 2, issue digests).

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
