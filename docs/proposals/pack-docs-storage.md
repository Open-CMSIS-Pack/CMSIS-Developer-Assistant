# Pack Docs: external document-storage management

Internal integration requirements, checked against the 2.7.0 source. This
document describes existing functions and a proposed boundary; it does not
introduce an extension API. For the current calls into other extensions,
see [Cross-extension calls](extension-calls.md); for a one-page map of the
storage, see [Pack Docs storage at a glance](pack-docs-storage-overview.md).

## The boundary today

Pack Docs has no external storage-provider API. Its
[`PackDocsHost`](../../src/core/packDocs/host.ts) supplies directories,
settings and target context, not document-storage operations.
[`PackDocsHandler`](../../src/packDocsHandler.ts) constructs
`new PageStore(host.storageDir, host.log)` itself, and the core modules use
Node's filesystem directly. `activate()` in
[`extension.ts`](../../src/extension.ts) returns `Promise<void>`, not an API
object another extension can acquire.

An external manager can already maintain PDFs and `docs.json` under
`cmsis-developer-assistant.packDocs.userDocsDir`, or put PDFs into configured
workspace document folders. The next target collection discovers them.
That is a folder convention, **not** a live synchronization or transactional
management API. In particular, editing the page-store sidecars externally
is not a supported integration.

The proposed split is: the manager owns source files, metadata, attribution
and their lifecycle; Pack Docs retains target resolution, PDF extraction,
page numbering, BM25 indexes, chapter detection, SVD enrichment and search.
Moving the derived cache as well requires the larger interface described
below.

## Keep the storage classes separate

| Data | Current owner and location | What a manager must preserve |
| --- | --- | --- |
| Pack PDFs and PDSCs | Installed or explicitly located DFP/BSP; resolved pack folders can be outside the pack root | Read-only references. Do not move or delete pack contents as a document-cache operation. |
| Workspace PDFs | Each workspace's `packDocs.workspaceDocDirs`; default `.agent-artifacts/docs` and `docs` | User/project-owned originals. Removing a library reference is not permission to delete the file. |
| Imported user PDFs and `docs.json` | `packDocs.userDocsDir`; default `~/.cmsis-pack-docs/user` | Durable originals, title/category/revision and target attribution. Keep confidential manuals local unless separately authorized. |
| Downloaded PDFs and `fetch.json` | `<globalStorageUri>/packdocs/arm/` and `web/` | Source identity and provenance, even when extraction fails. These are distinct from imported originals. |
| Extracted pages, metadata and indexes | `<globalStorageUri>/packdocs/`; `.pages.jsonl`, `.meta.json`, `.idx.json` | Rebuildable derived data, not the source library. |
| Bundled core SVDs and knowledge indexes | Extension assets, installed packs and knowledge-specific locations | Outside this document-storage contract; not PDF-cache contents. |

The physical cache layout remains an implementation detail of
[`PageStore`](../../src/core/packDocs/pageStore.ts). Supplying a different
`storageDir` relocates that layout; it does not replace its filesystem
implementation or move imported originals.

## Existing functions an integration can wrap

These are TypeScript-internal functions, not exported VS Code commands or
an installed package's supported public API. Links identify the defining
module; parameter and result type names are the current source types.

### Context, discovery and attribution

| Function | Result and responsibility |
| --- | --- |
| `resolveTarget(host: PackDocsHost, args: TargetArgs): Promise<TargetResult>` | Resolve the device, board, packs and cbuild-run context; keep this policy in Pack Docs. Defined in [targetDocs.ts](../../src/core/packDocs/targetDocs.ts). |
| `collectTargetDocs(host: PackDocsHost, res: TargetResolution): TargetDocs` | Collect pack/PDSC, Arm catalogue, user and workspace documents. The handler separately merges `PageStore.listFetched()` and annotates cache state. |
| `resolveUserDocsDir(setting: string \| undefined, home?: string): string` | Expand the configured user root and its default. Defined in [userDocs.ts](../../src/core/packDocs/userDocs.ts), with the next four functions. |
| `collectUserDocs(root: string, target: UserTarget, log?: PackDocsLog): UserDocs` | Apply folder-based attribution; return matching documents, folders and notes. |
| `userScopeDir(root: string, scope: UserScope): string` | Map an attribution to its user-library folder. |
| `userDocId(root: string, file: string): string` | Derive the current scope-relative user document ID. |
| `readManifest(dir: string): UserDocsManifest` | Read the filename-keyed `docs.json`; missing or unreadable manifests yield `{}`. |
| `collectWorkspaceDocs(host: PackDocsHost): WorkspaceDocs` | Scan configured folders in every workspace. Defined in [workspaceDocs.ts](../../src/core/packDocs/workspaceDocs.ts). |
| `PackDocsHandler.inspectTarget(args: TargetArgs): Promise<TargetInspection>` | Structured target/document/cache inspection used by the panel, without extraction. |

The required host inputs are `packRoot`, `storageDir`, `settings()`,
`findCbuildRunFiles()`, `workspaceFolders()`, `userAgent` and `log`.
`assetsDir`, `activeContext()`, `packRootFromToolchain()`,
`activeCbuildRunFile()` and `activePackFolders()` are optional context hooks;
`fetchFn` and `allowPrivateHosts` support tests. None is a document-provider
registration hook. The existing host signatures remain in
[`host.ts`](../../src/core/packDocs/host.ts).

### Import, fetch and index

| Function | Required semantics to retain |
| --- | --- |
| `importUserDoc(root: string, scope: UserScope, file: string, meta?: UserDocMeta): ImportResult` | Copy to the scope folder, merge nonblank metadata, return `{ dest, dir, id, replaced }`. Currently overwrites a same-named destination without a dedicated replacement confirmation. Blank metadata does not clear old fields. |
| `fetchDocument(doc: DocRef, store: PageStore, ctx: ResolveContext): Promise<FetchOutcome>` | Resolve a URL, download and persist provenance, or record an unsupported HTML result. Defined in [webFetch.ts](../../src/core/packDocs/webFetch.ts). It does not index. |
| `PackDocsHandler.indexDocument(doc: DocRef): Promise<LoadedDoc>` | Extract/index one local document after an import, subject to `maxPdfMb`. This is ensure-current, not force-reindex. |
| `PackDocsHandler.indexTarget(args: TargetArgs, progress?: (message: string) => void): Promise<string>` | Index readable documents of a target; progress is textual and the result is a summary. |
| `PageStore.ensure(doc: DocRef, extractor: PdfExtractor, opts?): Promise<LoadedDoc>` | Load a current extraction or produce one. `opts` contains optional `timeoutMs` and `log`. |
| `PageStore.ensureFromPages(doc: DocRef, pages: PageRecord[], info: PagesInfo, log?: PackDocsLog): LoadedDoc` | Build the index and persist pages plus metadata. Still requires a local `doc.path` for source identity/freshness. |

Source storage and indexing are separate success states: an import or
download can succeed while extraction fails. A management API must return
both states without treating the source as lost or automatically importing
it again. The five MCP tools (`list_target_docs`, `search_target_docs`,
`read_doc_pages`, `fetch_doc`, `get_peripheral_docs`) are agent operations,
not a complete library-management interface. Import/index palette commands
and private panel messages are not suitable unattended RPC contracts.

### Cache inspection and clearing

All functions in this table belong to `PageStore`.

| Functions | Purpose |
| --- | --- |
| `paths(doc): Paths`, `readMeta(doc): StoreMeta \| undefined`, `isCurrent(doc, meta?): boolean` | Locate sidecars and check source size/mtime against cached metadata. |
| `annotate(doc: DocRef): DocRef`, `load(doc: DocRef): LoadedDoc \| undefined` | Add availability/index information or load an existing current extraction. `annotate` mutates the descriptor. |
| `readFetchRecord(doc): FetchRecord \| undefined`, `listFetched(): DocRef[]` | Recover downloaded/HTML document identities across sessions, including records without an extraction. |
| `listCached(): CachedDoc[]` | Enumerate extracted documents; this is **not** the complete source library. |
| `readCachedPages(entry: CachedDoc): PageRecord[]`, `readCachedIndex(entry: CachedDoc): DocIndex` | Panel inspection of persisted derived data. |
| `storeUsage(): StoreUsage` | Preview document/file/byte counts for the two clear operations. |
| `clearExtracted(): ClearResult` | Remove all page/index/meta sidecars; keep PDFs and fetch records. |
| `clearDownloads(): ClearResult` | Remove the `arm/` and `web/` trees, including their downloaded PDFs, provenance and sidecars. Leave pack/workspace/user originals alone. |

`StoreUsage.extracted` and `.downloads` overlap for downloaded documents'
sidecars; they must not be summed as disjoint totals. The panel previews
usage, confirms the operation, clears, and calls `PackDocsHandler.dropCaches()`.
That last method clears only its chapter cache, not every cache in every
window.

## Functions required at an external boundary

The following names are a **proposed contract, not implemented methods**.
An extension facade should be typed and versioned; a separate local service
would need equivalent serializable requests. Do not expose arbitrary paths
to delete, the private panel protocol, or internal window-routing endpoints.

### Read side: Pack Docs calls the source manager

| Proposed operation | Inputs and result | Why Pack Docs needs it |
| --- | --- | --- |
| `listDocuments(query)` | Resolved target facts and workspace identity, or an explicit all-library query; returns source descriptors and a catalogue generation | Discover applicable documents without using the derived cache as a catalogue. Preserve target-scoped and all-library views as distinct operations. |
| `getDocument(id)` | Exact stable source ID; returns the current descriptor or a typed not-found result | Resolve a read/fetch independently of whichever target was listed last. |
| `acquireLocalFile(id, expectedContentVersion)` | Returns a lease containing an absolute readable PDF path, content version, size and `release()` | The current `PdfExtractor.extract(file, opts)` accepts a local filename, not an arbitrary URI or stream. Hold the snapshot unchanged until extraction and cache publication finish. |
| `onDidChangeDocuments(listener)` | Subscribe to added/updated/removed IDs, content/metadata versions and catalogue generation; returns a disposable subscription | Reconcile descriptors and derived caches in every consuming window, including changes made by another process. |

Source descriptors need identity, title, category, revision, attribution,
format, ownership/capabilities, source URL or local reference, and a content
version separate from the human edition. Pack Docs computes `cached`,
`indexed` and `pages`; these are not authoritative source-manager fields.
Map the descriptors to the existing
[`DocRef`](../../src/core/packDocs/pdscBooks.ts) inside an adapter rather than
making clients construct cache paths.

Acquiring a local file must not silently turn a list/search into a web
download. If the source is not local, return a needs-fetch result; fetching
remains an explicit operation. A remote provider must materialize a local
snapshot or the extractor/storage consumers must be redesigned.

### Write side: the management UI and explicit document actions call the owner

| Proposed operation | Required behavior |
| --- | --- |
| `importDocument(file, scope, metadata, replacementPolicy)` | Validate the input and copy into owned storage; make reject/replace explicit; return the new descriptor and whether existing content changed. |
| `fetchDocument(idOrUrl, options)` | Explicit download/refresh with a deadline and size limit; return persisted source/provenance state separately from indexing state. An adapter can retain the existing resolvers. |
| `updateMetadata(id, patch, expectedVersion)` | Update title/category/revision; define how a field is cleared; reject conflicting writes. Metadata changes need descriptor refresh, not necessarily PDF re-extraction. |
| `setAttribution(id, scopes, expectedVersion)` | Assign pack/vendor/device/board/core/all-target scope without losing document identity, or return an explicit old-to-new ID mapping. |
| `removeDocument(id, mode, expectedVersion)` | Distinguish unregistering a reference from deleting a manager-owned original. Reject deletion of pack or workspace originals through cache management. |
| `getStorageUsage(selection)` and `clearDownloads(selection, expectedGeneration)` | Preview an exact deletion scope and then remove only approved managed downloads. Retain the current distinction from clearing extracted text. |

These are required for a full management UI, not for a read-only provider.
Unsupported writes should be advertised as capabilities, not guessed from
an extension's presence. Mutations must publish changes to all readers and
define conflict, missing-document, unsupported-format, access-denied and
timeout outcomes. A timeout must say whether work is still running; it is
not proof that no write occurred.

### Pack Docs retains the derived-data operations

Expose a structured facade for `indexDocument(id, options)`,
`getIndexState(id)`, `invalidateDocuments(ids)` and
`clearExtracted(selection, expectedGeneration)` if the external UI is to
control indexing. These are proposed wrappers/extensions of the existing
handler and `PageStore` functions, **not** methods available today.

In particular, per-document invalidation, a force-reindex option, complete
descriptor/page/index/chapter invalidation, and cross-window change
notification still need implementation. Importing the current class or
calling `dropCaches()` alone does not supply them.

If the manager also owns the derived cache, add an injected cache interface
for coherent reads/commits of `{ meta, pages, index }`, version negotiation,
enumeration, usage and scoped deletion. The current `PageStore.paths()` and
the downloader's direct file writes must then be removed from the public
boundary. A database-backed or remote implementation is not a drop-in
replacement for the present synchronous, path-based methods.

## Identity and attribution rules

- `docs.json` is `Record<filename, UserDocMeta>`; metadata is only `title`,
  `category` and `revision`. Categories are `overview`, `manual`,
  `schematic`, `setup`, `other`. Attribution is in the folder, not the JSON.
- `UserScope` maps all-target documents to the root, pack documents to
  `<Vendor>/<Pack>`, vendor documents to `<Vendor>`, and other scopes to
  `devices/<pattern>`, `boards/<pattern>` or `cores/<core>`. Pack scope is
  not version-specific. Matching accepts case-insensitive `*`/`?` globs.
- User IDs include the slugged scope-relative folder and filename, for
  example `user/keil/stm32u5xx-dfp/rm0456`. Moving or renaming can change
  that ID; slug collisions are still possible. Workspace IDs begin as
  `workspace/<file-slug>` and collisions are suffixed within the collected
  set. Neither scheme is an immutable global library key.
- User/workspace cache locations hash the absolute parent directory;
  moving a library root changes cache locations even if a user ID survives.
- Arm IDs keep the requested version (`arm/ddi0553-latest`) separate from
  the resolved version and citation edition. Generic web IDs contain a
  host slug and URL hash. Preserve the declared source URL separately from
  a transient download URL.
- The current handler merges **all** `listFetched()` records into every
  resolved target. Target-binding these downloads would be a deliberate
  behavior change, not a storage-only refactor.
- The existing scanners limit traversal depth to three, user PDFs to 200
  and workspace PDFs to 100. A manager's full-library inventory must not
  silently inherit a target listing's truncation.

Preserve existing tool IDs where possible; expose aliases or an explicit
migration when changing the identity scheme. A title is never a safe key.
Keep source facts, citation edition and content version separate.

## Publication, invalidation and `atomicFile.ts`

The existing implementation is not a concurrent external-writer contract:

- `PageStore.isCurrent()` checks size, floored millisecond mtime and the
  presence of pages/index files. It records SHA-256 but does not compare it
  for freshness. Same-size/same-mtime replacement can look unchanged.
- Page/index memory caches use `doc.id`; chapters use ID plus source hash;
  the handler remembers descriptors in `knownDocs`. There is no unified
  invalidation notification when another window changes the storage.
- `PageStore.ensure()` coalesces work only within that instance. Windows
  construct separate instances against shared global storage.
- Pages, indexes, metadata, `docs.json` and `fetch.json` use direct writes.
  Downloads stage through a shared `<destination>.part` then rename. A
  clear operation does not cancel an extraction that can recreate files.
- A tool's timeout reply can precede background completion. A lease must
  cover the actual work, not merely the lifetime of its caller's wait.

[`atomicFile.ts`](../../src/utils/atomicFile.ts) provides
`writeFileAtomicSync(filePath, content, options?)`, its asynchronous
`writeFileAtomic` counterpart, `tempPathFor(filePath)` and `isTempPath(name)`.
The writers publish one UTF-8 file by exclusively creating a unique sibling
temporary file and renaming it. They write through symbolic links and
preserve existing permission bits by default, subject to the process
umask; callers may specify a mode. The referenced review candidate matches
this workspace's implementation.

Pack Docs does **not** currently use these helpers for the writes listed
above. They are useful building blocks for JSON publication, not a binary
PDF storage API, transaction system or cross-process lock. They provide no
`fsync` durability guarantee. Atomic replacement of one file does not stop
lost read/modify/write updates to a manifest or publish pages/index/meta as
one consistent generation.

An external manager therefore needs one writer or cross-process
serialization/version checks; unique staging for downloads; coherent
publication of complete document/cache generations; notifications after
commit; and a delete/clear policy that coordinates active readers and
writers. Validate ownership and root containment before deletion, preserve
the previous usable revision on failure, and clean only the operation's
own staging files.

## Acceptance checks before exposing an API

1. List imports that have never been indexed and downloads whose indexing
   failed; do not substitute `listCached()` for the library.
2. Update only metadata, then replace bytes with the same size and mtime;
   neither case may serve stale descriptors or text.
3. Move/re-scope a document or change the user root with a documented ID
   migration and no accidental deletion of originals.
4. Import/fetch/index from two windows; observe one coherent revision and
   no manifest lost update or shared staging-file collision.
5. Delete or clear during extraction, including after a timeout; work must
   not silently resurrect a deleted revision.
6. Fail between source, provenance and index publication; report which
   part succeeded and retain the previous usable revision.
7. Clear extracted data without deleting any originals; clear downloads
   without touching pack/workspace/user documents. Reject stale previews.
8. Keep unsupported HTML outcomes, URL/redirect guards, size limits and
   deadlines; no implicit network fetch during list/search.

Relevant regression suites are
[`userDocs.test.ts`](../../src/test/userDocs.test.ts),
[`workspaceDocs.test.ts`](../../src/test/workspaceDocs.test.ts),
[`pageStore.test.ts`](../../src/test/pageStore.test.ts),
[`webFetch.test.ts`](../../src/test/webFetch.test.ts),
[`packDocsHandler.test.ts`](../../src/test/packDocsHandler.test.ts) and
[`packDocsPanel.test.ts`](../../src/test/packDocsPanel.test.ts). New tests are
needed for the proposed provider and multi-window consistency guarantees.
