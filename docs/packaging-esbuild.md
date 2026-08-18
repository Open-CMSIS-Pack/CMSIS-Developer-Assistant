# esbuild bundling

The extension is bundled into a single `dist/extension.js` with esbuild, and
the VSIX ships only that plus `serialport`'s subtree. Enabled in v2.0.1.

Effect on the package: **2271 files / 14.7 MB → 246 files / 12.4 MB.**

## Why `serialport` stays external

`serialport` loads a native `.node` binary through `node-gyp-build`, which
resolves the prebuild directory **relative to `__dirname` at runtime**. Bundling
that code moves `__dirname` to `dist/`, the lookup fails, and every serial tool
dies at its first call — with an error that reads like a missing driver rather
than a packaging mistake.

So `esbuild.js` marks it external, and `.vscodeignore` carries an allow-list of
its full transitive closure alongside `node_modules/**`. Regenerate that list
after a `serialport` upgrade:

```sh
node -e "const s=new Set();(function w(p){if(s.has(p))return;s.add(p);
  let j;try{j=require('./node_modules/'+p+'/package.json')}catch(e){return}
  for(const d of Object.keys(j.dependencies||{}))w(d)})('serialport');
  console.log([...s].sort().join('\n'))"
```

## Verifying a build

A missing allow-list entry fails **only in the packaged extension** — in
development the whole tree is present and everything looks fine. So check the
artifact, not the workspace:

```sh
npm run package                                   # check-types + esbuild
npx --yes @vscode/vsce package --allow-star-activation
node test/transport/packaged-vsix.js cmsis-debugmcp-<version>.vsix
```

That harness unpacks the VSIX and loads from it the way VS Code would: the
`main` entry exists, no compiled tests shipped, `serialport` resolves from the
packaged tree, **the native binding actually enumerates ports**, the bundle
still `require()`s serialport rather than inlining it, and the agent skill is
present.

If the binding fails and the closure cannot be pinned down quickly, revert
`main` to `./out/extension.js` and drop the `node_modules` exclusions — a
smaller VSIX is not worth a broken serial backend.

## Note on installing esbuild here

`npm install esbuild` took **35 minutes** on this machine and failed outright
several times with `ETIMEDOUT` fetching the tarball (a proxy/network issue, not
a repo one). One failed attempt left `node_modules/esbuild` as an *empty
directory* while reporting success, so if a build suddenly cannot find esbuild,
check that the package actually resolves:

```sh
node -e "console.log(require('esbuild').version)"
```

Upstream pins `^0.28.1`, which does not exist in the registry; `0.28.0` is the
newest published version.
