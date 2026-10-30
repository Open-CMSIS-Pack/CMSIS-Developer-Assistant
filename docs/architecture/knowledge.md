# Knowledge tools (`knowledge`, experimental)

Three tools over a knowledge index: how-to knowledge next to the *what* of
the documentation tools. Procedures, rules, concepts, and the causes and
fixes of csolution, packchk and svdconv messages are knowledge units in
Markdown; the knowledge-base tooling builds them into one SQLite file,
`knowledge.db`, with the entities they apply to and the relations between
them. [docs/proposals/knowledge-base.md](../proposals/knowledge-base.md) has
the reasons and the open decisions.

The knowledge index is mandatory. The extension ships the core index
(`resources/knowledge/core.db`) and the knowledge tools are always on.
`knowledge.indexPath` replaces the core index, for testing a rebuilt one.
The file is git-ignored and pinned instead: the knowledge-base repository,
which is private, builds it reproducibly from a commit (`scripts/build_core.sh`)
and publishes it as a GitHub release `core-<version>` with its sha256, a
metadata file and `SOURCES.md` in the public repository
[cmsis-knowledge-index](https://github.com/MatthiasHertelArm/cmsis-knowledge-index)
(`scripts/release_core.sh`); `resources/knowledge/core.lock.json` names the
version, the asset URL, the hash, the size, the unit count and the commit.
`npm run knowledge:fetch` downloads the pinned file when the local one is
missing or differs, hash and size checked before it takes the file's place;
`npm run knowledge:check` only verifies; `npm run knowledge:update -- <version>`
rewrites the lock from a release's metadata. Packaging refuses a VSIX whose
index is missing or not the pinned one (`--index-unpinned` lets a rebuilt
index through, loudly, never a missing one), and the CI package job fetches
the index, cached by the pinned hash, before it packages. The logic is
`src/core/knowledge/coreIndexLock.ts`, build tooling that nothing of the
extension imports; `scripts/knowledge-index.ts` is its command line.
The same release carries `SOURCES.md`, the attribution of the index's
content (every source with repository and licence, the copyright lines and
licence texts the MIT and BSD-3-Clause licences require, the NOTICE files of
the Apache-2.0 sources, the issue repositories), which the lock names too
(`sources`, `sourcesSha256`): the extension commits and ships the copy
`resources/knowledge/SOURCES.md`, `knowledge:fetch` refreshes it with the
index, `knowledge:check` and packaging hold it to the lock's hash, and
`npm run tpip:report` copies its table of sources into TPIP.md.
Packs and the workspace add their own indexes to it: every pack under the
pack root and in cpackget's local repository, and the DFP and BSP folders
the CMSIS Solution extension names for the active target, which reach a
pack a csolution names with `path:` outside the pack root
(`KnowledgeHost.packFolders`, filled by `namedPackFolders` in
`src/core/packDocs/targetDocs.ts`). A file found twice is opened once.

- **Knowledge first.** A skill is loaded because its description matches
  the task; a knowledge unit is not. So after the tool rules, the instructions
  open with one sentence that says it: before a CMSIS task, look the
  procedure up with `knowledge_search` and follow it (`KNOWLEDGE_FIRST`), and
  the first `get_session_status` repeats it in a line (`KNOWLEDGE_REMINDER`).
- **One installed skill.** `cmsis-help` is the only skill the extension
  installs. It is the health check and the router: the session state, the
  debug windows and the recent problems, then the debug topic or the knowledge
  procedure for the task. Every other procedure is a unit of the index. The
  CDA procedure sources, assets and routing definitions are authored in
  `cmsis-knowledge-base/sources/cda-procedures`. Its converter reads their
  source catalog, while this extension's catalog contains only `cmsis-help`.
  The knowledge base also fetches and converts upstream cmsis-skills, including
  the bring-up, pack, Ethos-U and stream procedures.
  The installer's sweep removes every other skill this extension installed.

- **A task name leads to its procedure.** BM25 over title, summary, body
  and triggers ranks a short reference unit that carries a word in its title
  above a procedure that names the word once in a long description, so
  `HardFault` did not reach `proc-cmsis-debug-live` and `create a new
  project` neither `route-project` nor `proc-cmsis-bootstrap`. A question
  of at most three content words is taken as a task name: the procedures and
  routing units whose title, summary or triggers name all of its words (all
  but one of three; two adjacent words also as one identifier, `hard fault`
  as `HardFault`) get a bonus above the spread of the rank scores
  (`HOW_TO_BONUS` in `search.ts`, `KnowledgeIndex.howToCoverage`). Longer
  questions carry specifics the reference text answers better and get none;
  the golden set of the knowledge base (`tests/eval_search.js`) is the
  measure for any change here.
- **An id leads to its unit.** BM25 splits `proc-cmsis-debug-live` into four
  words that dozens of units carry, so a search for an id an agent already
  has did not find that unit first (a tester's agent tried nine times
  before it found `knowledge_get`). A word of the query that is a unit's id
  now puts that unit first, above an exact symptom (`ID_BONUS`); a query of
  one word that is no id but starts the ids of at most ten units
  (`proc-cmsis-debug`) puts those first (`ID_PREFIX_BONUS`,
  `unitsNamed()` in `search.ts`, `unitIdsWithPrefix` of the reader). The
  filters still apply: `types`, `domain` and the project context can leave
  the named unit out, and `knowledge_get` reads it regardless.
- **Files of a unit.** A skill's templates and scripts are `asset` entities
  with the file as body, referenced by their procedure. `knowledge_get` on a
  procedure lists them by the path its text uses, and returns one by its id
  (`KnowledgeIndex.assetsOf`). They are not in the search index.
- **A pack's units stay with the pack.** A unit a pack ships is scoped to
  the pack by its `scoped_to` edge, and when its index was built without
  those edges, by the index it comes from: `packScopeOf` reads the pack from
  the index's info table (`pack`, written by `cmsis-knowledge`) or else from
  its label, so that no pack unit is ever universal (an index of a C++ book
  showed up in a Cortex-M55 search). Search runs over the view
  `forContext(context)` of the open set: the base, the workspace and the
  packs the project uses. A pack outside the project takes no candidate
  slot and its symptom patterns never run; `knowledge_get` and
  `knowledge_expand` still read it, and the `Indexes:` line of a search
  says that its pack is not in the project. Each index contributes up to
  `CANDIDATES` BM25 hits of its own (`MemberView.bm25`), so pack hits do
  not crowd the core's out before the filters run. The context itself is
  built on the whole set (`contextEntities`): a pack's board entity is what
  brings the pack into the context. A component of the cbuild file names
  its vendor (`Infineon::Device:Startup`), and only that vendor's entity
  joins the context, without bundle and variant; the lookup by the name
  alone, which would bring `Device:Startup` of some 40 vendors and so their
  units, is left to a component given without a vendor (`CMSIS:CORE`).
- **Symptom matching cannot backtrack.** Any index may supply a
  `symptom_regex`; heuristic checks on a native regexp miss ambiguous
  alternatives and adjacent repetitions. `symptomPattern.ts` instead
  compiles a restricted grammar into a bounded automaton. A state is visited
  at most once per input position, including when the match may start
  anywhere, so alternatives and repetitions never multiply the work
  exponentially. Native regexp matching sees only individual character
  atoms, never a complete index-supplied pattern. Character classes,
  anchors, alternation, unquantified groups and quantifiers on character
  atoms cover the core catalogue. Quantified groups, references,
  lookarounds and unsupported escapes are refused and counted as unusable,
  with malformed or oversized patterns. Source length, nesting, expanded
  state count and input length are bounded before work or allocation;
  matching still uses at most the first 2 000 characters of each line.
  An aggregate step budget is shared across patterns, lines, messages and
  active indexes: many individually bounded matches must not monopolise the
  extension host either. Exhaustion fails explicitly as an incomplete
  search, never a nonmatch or a partial list presented as complete. Index
  opening streams symptom rows and caps the aggregate number of attempted
  patterns and retained states across the open set; exceeding either cap
  closes the files and refuses the set instead of silently omitting units.
  The core catalogue remains compatible, checked against the pinned index.
- **The failed build's lookup follows the active target.** The
  `Known message:` lines of a failed build (`knownMessageLookup.ts`,
  `KnowledgeHandler.knownMessageLines`) read the facts of the window's
  active target at each build, not the context of the last search, so a
  build in another project names that project's pack units.
- **A summary line is no cause.** csolution follows the errors of a context
  with `processing context '…' failed`. A unit the index marks
  `role: summary` is named after the others and worded as a summary, and
  left out when a real unit was found for an earlier error line
  (`knownMessages()`), so a failed build does not send the agent to a unit
  that only says "fix the errors before this line".

## The knowledge browser

The command **Open Knowledge Browser** shows the index to the people who
write and review it: a list of all units with filters and the tools' search,
one node in full, its relations as a graph that can be walked, and the
figures of the index. It reads the same open index as the tools and changes
nothing. The browser and the tools both use the mandatory knowledge index.

- **Data and page are apart.** `core/knowledge/browse.ts` turns the index
  into plain data (`unitRows`, `overviewOf`, `detailOf`, `graphAround`) and
  is tested without an editor. `knowledgePanel.ts` passes messages;
  `knowledgePanelPage.ts` is the page's stylesheet and script.
- **Collections.** Filters by type, domain and collection: the source a
  unit came from (`zephyr`, `issues-pyocd`, …), so a reviewer can take one
  source at a time. Units the knowledge base builds without a collection
  are grouped by kind (`skills`, `error-catalog`, `routing`, `extracted`).
- **Text from anyone.** A unit's Markdown is rendered by `renderMarkdown`,
  which escapes the source and then adds its own tags, so the page never
  gets a tag or attribute of the source. The page's script runs under a
  nonce and builds everything else with `textContent`.
- **What the page may ask for.** Open an `http`/`https` link, open the
  Markdown file the index names for a unit, copy an id, open the knowledge
  settings. Each is checked in `knowledgePanel.ts`.
- **The graph is laid out in the page**: the node in the centre, its
  relations on a ring, theirs on a second one, at most 70 nodes.

## Where to look

| Path | What |
| ---- | ---- |
| `src/core/knowledge/store.ts` | `KnowledgeReader`, `KnowledgeIndex` (one file: the SQL over `nodes`, `edges`, `nodes_fts`), `KnowledgeSet` (several, merged) |
| `src/core/knowledge/symptomPattern.ts` | The restricted symptom grammar and bounded, non-backtracking matcher |
| `src/core/knowledge/packIndexes.ts` | Where pack and workspace indexes are found (`PACK_INDEX`, `WORKSPACE_INDEX`), the folders of the active target's packs included (`packFolderIndexes`) |
| `src/core/knowledge/search.ts` | `searchKnowledge`, `contextEntities`, `inScope`, `appliesIn`, `isIncomplete`, `knownMessages` |
| `src/core/knowledge/projectFacts.ts` | The facts of the active target |
| `src/knowledgeHandler.ts` | `handleKnowledgeSearch`, `handleKnowledgeGet`, `handleKnowledgeExpand`, the reply texts |
| `src/knowledgeTools.ts` | Tool names and schemas |
| `src/core/knowledge/browse.ts` | The browser's data: list, overview, one node, the neighbourhood, Markdown as HTML |
| `src/knowledgePanel.ts`, `src/knowledgePanelPage.ts` | The knowledge browser: messages and guards; the page's style and script |
| `src/packDocsHost.ts` | The settings read per call (`knowledge.indexPath`, `knowledge.includeIncomplete`) and the host |
| `src/test/knowledge.test.ts` | An index written in the test, the retrieval cases of the prototype, the handler and the dispatch; a pack built by `cmsis-knowledge` in `src/test/fixtures/knowledge/packs` |
