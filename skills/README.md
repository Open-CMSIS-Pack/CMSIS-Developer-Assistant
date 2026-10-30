# The installed help skill

This directory contains cmsis-help, the one Agent Skill the extension packages and installs, and its generated catalog.json. On activation and during Configure Agent, the installer copies the skill to the user's personal skills directories. Its marker-guarded sweep still removes skills installed by older releases.

The eight knowledge procedures formerly kept here are authored in the knowledge base's `sources/cda-procedures`, including their assets, references, metadata and routing definitions. They reach agents through the pinned knowledge index, not installed skill directories. The knowledge base also fetches Open-CMSIS-Pack/cmsis-skills directly.

## Updating the help skill

~~~sh
npm run skills:sync
~~~

This regenerates catalog.json from scripts/skills.config.json and the help frontmatter, and copies the tool-contract blocks into cmsis-help and the debugging guide. Run it after editing the help frontmatter, its agents/openai.yaml, the config or docs/agent-resources/tool-contract.md. The script requires the pinned core index so procedure hand-overs can be checked; run npm run knowledge:fetch when it is absent.

The config permits only cmsis-help. The installer retains the older catalog formats for migration, including the ability to remove obsolete managed skills without deleting personal content.

## Ownership and compatibility

The MCP tool rules and shell-to-tool table are authored in docs/agent-resources/tool-contract.md. Edit that source rather than its generated copies. Procedure sources contain no copies of those blocks; the server supplies the rules at runtime.

The extension tests the installed help skill, its declared tools, packaging and installer migration. The knowledge base tests the procedure sources, dependency links, assets and compatibility with the extension's debugger tool surface. Its compatibility snapshot is checked against a live extension checkout during rebuilds. Preserve procedure IDs when updating knowledge so the installed help and tool replies keep resolving through the pinned core index.
