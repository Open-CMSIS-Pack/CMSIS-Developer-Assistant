# Agent skills shipped with the extension

Everything in this directory ships in the VSIX. On activation the extension
copies the skills the user selected (setting
`cmsis-developer-assistant.installedSkills`, command **Select Agent Skills**)
into their personal skills directories — see the *Agent Skills* section of
the top-level README.

| Path | What | Maintained how |
|------|------|----------------|
| `cmsis-debug-live/` | The extension's own live Cortex-M debugging workflow. Always installed. | Authored here. |
| `cmsis-help/` | The extension's own "what can I ask for?" skill: slash commands, member skills per category, VS Code commands, MCP tool groups, settings. Always installed. | **Generated** from `catalog.json`, `package.json` and the `help` block of `scripts/skills.config.json` (`src/utils/skillHelp.ts`); the test re-renders it. |
| `cmsis-skills/<name>/` | The [Open-CMSIS-Pack/cmsis-skills](https://github.com/Open-CMSIS-Pack/cmsis-skills) skills, verbatim, flattened by name. `LICENSE` is upstream's Apache-2.0. | **Generated** — never edit; re-sync. |
| `cmsis-project/`, `cmsis-bring-up/`, `cmsis-pack/` | One router skill per upstream category: a dispatch table to the member skills plus a typical workflow. Gives agents one slash command per category. | **Generated** from `scripts/skills.config.json`. |
| `catalog.json` | Name, description, category, kind, source, path and `dependsOn` of every skill. The runtime and the tests read only this. | **Generated.** |
| `cmsis-skills.lock.json` | Upstream repository, the pinned commit SHA, and a content hash of `cmsis-skills/`. | **Generated.** |

## Re-syncing upstream

```sh
npm run skills:sync              # re-vendor at the pinned SHA (after editing scripts/skills.config.json)
npm run skills:sync -- --update  # move the pin to the current upstream main, then re-vendor
```

The script does a shallow `git fetch` of the pinned commit, copies
`generic-mcu-skills/skills/<category>/<name>/` into `cmsis-skills/<name>/`,
reads each skill's frontmatter and `agents/openai.yaml`, records the `$name`
cross-references as dependencies, regenerates the routers, the catalog and
the `cmsis-help` skill, and rewrites the lock. It fails loudly on duplicate
names, a name that collides with a bundled or router skill, an unknown
category, a `$name` reference that no longer resolves, or a palette command
or listed setting without a one-liner in the `help` block.

`src/test/skillCatalog.test.ts` pins the catalog to the directories on disk
and the lock's content hash, so a hand edit under `cmsis-skills/` or a
forgotten re-sync fails `npm test`. Upstream has no tags or releases; the
commit SHA is the version.

Router descriptions are the text skills-aware harnesses use to decide when
to invoke the entry point. Keep them trigger-rich and under 1024 characters
(the Agent Skills limit — the test checks).

## Installed layout

Each installed directory additionally contains `.cmsis-developer-assistant.json`
(`name`, `source`, `sha`, `extensionVersion`, `installedAt`, `hidden`). Skills
installed only as dependencies of a pick get `user-invocable: false` added to
their frontmatter, which hides them from the `/` menu in harnesses that
honour the field while keeping them model-invocable.
