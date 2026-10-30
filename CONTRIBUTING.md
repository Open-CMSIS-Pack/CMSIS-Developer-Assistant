# Contributing

Contributions and suggestions are welcome.

- Open an issue to discuss a bug or feature before large changes.
- Submit changes as a pull request against `main`; keep PRs focused and include
  a clear description of what changed and why.
- Make sure the build and tests pass locally (`npm run compile`, `npm run lint`,
  and the test suites) before requesting review.
- Newly contributed files are expected to be licensed under **Apache-2.0** and
  include the appropriate SPDX license identifier; see [LICENSE](LICENSE) and
  [NOTICE](NOTICE) for the project's licensing and provenance requirements.

This project is part of [Open-CMSIS-Pack](https://github.com/Open-CMSIS-Pack);
please follow the org's contribution and sign-off requirements where they apply.
All participation is subject to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

```sh
npm ci
npm run knowledge:fetch # fetch the pinned core index and its attribution

npm run compile        # tsc → out/src  (what the tests run against)
npm run check-types    # type-check only
npm run build          # check-types + production esbuild bundle → dist/
npm run package        # build + create a platform-targeted VSIX
npm run lint           # lint src/
npm run lint:md        # lint Markdown files
npm run skills:sync    # regenerate skills/catalog.json and the tool-contract blocks (see skills/README.md)
```

The core knowledge index is git-ignored. Fetch it after installing dependencies
and whenever its lock changes: packaging and `skills:sync` require it, and the
documentation-consistency tests need it to run. `npm run knowledge:check` verifies
that the index and `resources/knowledge/SOURCES.md` match the committed lock.

The extension and its PDF worker ship as bundles in `dist/`; `out/` exists for
the tests. See [docs/packaging-esbuild.md](docs/packaging-esbuild.md) for the
runtime payload, the external `serialport` dependency and package verification.

To install a locally built VSIX:

```sh
code --install-extension cmsis-developer-assistant-<platform>-<version>.vsix --force
```

### Tests

Build the extension first: the VS Code test host loads `dist/extension.js`.
`npm test` compiles the test sources and runs the source linter before the tests.

```sh
npm run build
npm test                                              # VS Code integration tests
npm run test:transport                                # session lifecycle + two-window routing, over real sockets
node test/transport/packaged-vsix.js <built.vsix>        # verify a packaged VSIX
```

For changes to tool replies, configuration or DAP behavior, run the relevant
behavior oracle after compiling:

```sh
node test/transport/dap-scenarios.js
node test/transport/config-scenarios.js
node test/transport/executor-cases.js
npm run test:surface
```

The DAP and configuration oracles accept `--update` for intended snapshot
changes. The surface snapshot depends on the host and is a local check; update
it with `npm run test:surface -- --update` only for an intended change.

The unit tests can also be run headlessly against `out/`, which is useful where
the Electron harness will not start:

```sh
./node_modules/.bin/mocha --ui tdd \
  --require test/transport/vscode-stub.js out/src/test/*.test.js
```

`test/transport/packaged-vsix.js` is the one that catches packaging mistakes:
a missing entry in the `.vscodeignore` serialport allow-list fails **only** in
the built extension, never in the workspace, so it unpacks the VSIX and proves
the native serial binding really enumerates ports.
