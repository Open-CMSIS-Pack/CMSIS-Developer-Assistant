/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// The integration-test run behind `npm test` (@vscode/test-cli finds this file
// by its name). The suites are the tsc output that `pretest` compiles; they
// run in the stable VS Code against the extension in this directory, whose
// entry point is the bundle in dist/. Everything not set here keeps the
// test-cli default (tdd interface, no workspace).

import { defineConfig } from '@vscode/test-cli';

/** Compiled suites: `src/test/*.test.ts` after `npm run compile`. */
const compiledSuites = 'out/src/test/**/*.test.js';

/**
 * macOS: a short, fixed profile directory; the default one under the
 * repository can make the IPC socket path too long.
 */
const profileArgs = [
    ...(process.platform === 'darwin' ? ['--user-data-dir=/tmp/cmsis-vscode-test'] : []),
    ...(process.platform === 'linux' ? ['--disable-gpu'] : []),
];

/** The end-to-end suites build pack and build fixtures in `suiteSetup`, beyond mocha's 2 s default on Windows runners. */
const perTestLimitMs = 20_000;

const testRun = {
    files: compiledSuites,
    launchArgs: profileArgs,
    mocha: { timeout: perTestLimitMs },
    coverage: { reporter: ['lcov', 'text'], output: './coverage' },
};

export default defineConfig(testRun);
