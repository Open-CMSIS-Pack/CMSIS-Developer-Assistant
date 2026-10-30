# Pack Docs storage at a glance

A short map of where Pack Docs keeps documents and which functions act on
them. The detailed requirements, including the proposed boundary for an
external document manager, are in
[Pack Docs: external document-storage management](pack-docs-storage.md); the
tool group as a whole is described in [packDocs.md](../architecture/packDocs.md).

Pack Docs keeps two kinds of data: the **originals** (the PDFs) and the
**derived data** (extracted page text and a search index). Originals come
from four places; all derived data lives in one cache,
[`PageStore`](../../src/core/packDocs/pageStore.ts), under
`<globalStorageUri>/packdocs/`.

## Anatomy

```txt
ORIGINALS                                   CACHE  <globalStorageUri>/packdocs/   (PageStore)
---------                                   -------------------------------------------------
Pack PDFs (DFP/BSP, read-only)       --+    <vendor>/<pack>/<version>/<slug>.*
Workspace PDFs (docs/,               --+--> workspace/<dir hash>/<slug>.*
  .agent-artifacts/docs)               |    user/<dir hash>/<slug>.*
User library ~/.cmsis-pack-docs/user --+
  + docs.json (title, category, revision)

Arm catalogue / web (fetch_doc) ----------> arm/<id>/          doc.pdf + fetch.json + sidecars
                                            web/<host>/<hash>/ doc.pdf + fetch.json + sidecars
```

Each cached document has three sidecars:

- `.pages.jsonl`: one line per page, `{p, heading, text}`;
- `.idx.json`: the BM25 index;
- `.meta.json`: size, mtime, sha256, page count and extractor; the
  freshness check reads it.

Downloads are the one place where the cache also holds the original
(`doc.pdf`) and its provenance (`fetch.json`).

## Functions by job

1. **Find a target's documents.** `resolveTarget` determines device, board
   and packs; `collectTargetDocs` gathers pack/PDSC, Arm catalogue, user and
   workspace documents, and the handler adds the downloads from
   `PageStore.listFetched()`. Helpers: `collectUserDocs`,
   `collectWorkspaceDocs`, `readManifest`
   ([targetDocs.ts](../../src/core/packDocs/targetDocs.ts),
   [userDocs.ts](../../src/core/packDocs/userDocs.ts),
   [workspaceDocs.ts](../../src/core/packDocs/workspaceDocs.ts)).
2. **Bring an original in.** `importUserDoc` copies a file into the user
   library under a scope folder and merges its `docs.json` entry.
   `fetchDocument` ([webFetch.ts](../../src/core/packDocs/webFetch.ts))
   downloads into `arm/` or `web/` and writes `fetch.json`; it does not index.
3. **Extract and index.** `PageStore.ensure(doc, extractor)` loads the cache
   when `isCurrent` holds (size and mtime still match `.meta.json`);
   otherwise it extracts with pdf.js, builds the BM25 index and writes the
   three sidecars. Concurrent requests for one document share one
   extraction. The handler wraps this as `indexDocument` and `indexTarget`
   ([packDocsHandler.ts](../../src/packDocsHandler.ts)).
4. **Inspect.** `annotate` adds `cached`, `indexed` and `pages` to a
   `DocRef`; also `load`, `listCached`, `readCachedPages`, `readCachedIndex`
   and `readFetchRecord`.
5. **Clean up.** `storeUsage` previews; `clearExtracted` removes only the
   sidecars and keeps the PDFs; `clearDownloads` removes the `arm/` and
   `web/` trees. Neither touches pack, workspace or user originals.

## Three things to keep in mind

- **Attribution is the folder.** A user document's scope comes from its
  path (`<Vendor>/<Pack>`, `<Vendor>`, `devices/<pattern>`, `boards/…`,
  `cores/…`); `docs.json` holds only title, category and revision. IDs are
  derived from the path, so moving or renaming a file changes its ID.
- **Only the sidecars are rebuildable.** Downloads are originals that
  happen to live in the cache folder; clearing them loses the file.
- **One writer per document is assumed.** Freshness is size and mtime only
  (the sha256 is recorded, not compared), the sidecars and manifests are
  written directly rather than through
  [`atomicFile.ts`](../../src/utils/atomicFile.ts), and every window
  constructs its own `PageStore` over the same global folder.
