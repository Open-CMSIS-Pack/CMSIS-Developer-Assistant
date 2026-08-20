// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * `serialport` must not be bundled.
 *
 * It loads a native `.node` binary through `node-gyp-build`, which resolves the
 * prebuild directory relative to `__dirname` at runtime. Inlining that code
 * moves `__dirname` to `dist/`, the lookup fails, and every serial tool dies at
 * the first call — with an error that reads like a missing driver rather than a
 * packaging mistake. Keeping it external means its tree ships from
 * node_modules; `.vscodeignore` carries the matching allow-list.
 *
 * `vscode` is external because the host provides it.
 */
const external = ['vscode', 'serialport'];

/**
 * `jsonc-parser`'s default entry is a UMD bundle that hands `require` to its
 * factory as a *parameter*:
 *
 *     (function (factory) { ... factory(require, exports) ... })
 *     (function (require, exports) { ... require("./impl/format") ... })
 *
 * esbuild cannot trace a `require` it does not own, so it leaves that call in
 * place. At runtime it then resolves relative to `dist/`, where `impl/` does
 * not exist, and activation dies with "Cannot find module './impl/format'".
 *
 * The package also ships an ESM build using ordinary static imports, which
 * bundles correctly. Alias to it rather than marking the package external —
 * jsonc-parser has no dependencies of its own, so this costs nothing and keeps
 * the bundle self-contained.
 */
const alias = { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' };

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',
    setup(build) {
        build.onStart(() => {
            console.log('[esbuild] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location) {
                    console.error(`    ${location.file}:${location.line}:${location.column}`);
                }
            });
            console.log('[esbuild] build finished');
        });
    },
};

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/extension.js',
        external,
        alias,
        logLevel: 'silent',
        plugins: [esbuildProblemMatcherPlugin],
    });
    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
