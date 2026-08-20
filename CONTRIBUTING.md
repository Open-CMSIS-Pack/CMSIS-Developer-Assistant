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
npm install

npm run compile        # tsc → out/src  (what the tests run against)
npm run check-types    # type-check only
npm run build          # check-types + production esbuild bundle → dist/
npm run package        # build + create a platform-targeted VSIX
npm run lint           # lint src/
npm run lint:md        # lint Markdown files
npm run skills:sync    # re-vendor the cmsis-agent skills + regenerate skills/catalog.json (see skills/README.md)
```

The extension ships as the esbuild bundle in `dist/`; `out/` exists for the
tests. See [docs/packaging-esbuild.md](docs/packaging-esbuild.md) for why
`serialport` is deliberately left unbundled.

To install a locally built VSIX:

```sh
code --install-extension cmsis-developer-assistant-<platform>-<version>.vsix --force
```

### Tests

```sh
npm test                                              # VS Code integration tests
npm run test:transport                                # session lifecycle + two-window routing, over real sockets
node test/transport/packaged-vsix.js <built.vsix>     # verify a packaged VSIX
```

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
