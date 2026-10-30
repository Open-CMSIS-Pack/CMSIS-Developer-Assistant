# esbuild bundling and VSIX packaging

The extension builds two bundles: `dist/extension.js` and the PDF extraction
worker `dist/pdfWorker.js`. `esbuild.js` bundles their JavaScript dependencies
except `vscode`, provided by the editor, and `serialport`, which needs its
native package layout.

The VSIX also carries the `serialport` dependency subtree, pdf.js's
`legacy/build/pdf.worker.min.mjs`, runtime agent documentation, the
`cmsis-help` skill and catalog, core SVDs, and the pinned knowledge index with
its attribution. `.vscodeignore` controls that payload and excludes source,
tests, design notes and local build state.

## Why `serialport` stays external

`serialport` loads a native `.node` binary through `node-gyp-build`, which
resolves the prebuild directory **relative to `__dirname` at runtime**.
Bundling that code moves `__dirname` to `dist/`, so the native lookup fails.

`esbuild.js` therefore marks it external, and `.vscodeignore` includes its
transitive dependency subtree. Check that list after a `serialport` upgrade:

```sh
node -e "const s=new Set();(function w(p){if(s.has(p))return;s.add(p);
  let j;try{j=require('./node_modules/'+p+'/package.json')}catch(e){return}
  for(const d of Object.keys(j.dependencies||{}))w(d)})('serialport');
  console.log([...s].sort().join('\n'))"
```

A missing dependency can be hidden by the development checkout's complete
`node_modules` tree. Verify the packaged extension after changing this list.

## Building the package

From a clean checkout:

```sh
npm ci
npm run knowledge:fetch
npm run package
```

`npm run package` type-checks, builds both production bundles and runs
`scripts/package.ts`. The wrapper selects the current platform by default;
choose another supported target explicitly when needed:

```sh
npm run package -- --target linux-x64
```

Before invoking the installed `vsce`, the wrapper verifies
`resources/knowledge/core.db` and `SOURCES.md` against
`resources/knowledge/core.lock.json`. The index is git-ignored, so fetch it
after checkout and whenever the lock changes. `npm run knowledge:check`
verifies the local files without downloading them. A missing index prevents
packaging; `--index-unpinned` permits a present rebuilt index for development
and is not for a release.

The wrapper also generates `out/readme.vsix.md`: repository images become
data URIs and relative links become repository URLs. It passes that file to
`vsce`; the repository's `README.md` is excluded to avoid a case-insensitive
filename collision. Use this wrapper for packaging so the index checks and
README generation run together.

## Verifying the result

Pass the generated VSIX, whose name includes the target and version, to the
package harness:

```sh
node test/transport/packaged-vsix.js <built.vsix>
```

The harness unpacks the artifact and checks it as an installed extension:
the main entry exists and loads, compiled tests are absent, `serialport`
resolves from the packaged tree and its native binding enumerates ports.
It also checks the external serial import, core SVDs, installed help skill
and catalog, knowledge index and attribution, and both PDF worker files.
The packaged PDF worker must successfully extract a test PDF. Run the harness
against the package built for the machine performing the check, so its
native serial binding can load.
