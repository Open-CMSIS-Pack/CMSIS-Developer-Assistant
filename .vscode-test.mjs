// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/src/test/**/*.test.js',
	launchArgs: process.platform === 'darwin' ? ['--user-data-dir=/tmp/cmsis-vscode-test'] : [],
	// The end-to-end suites build a workspace with pack and build fixtures in
	// their suiteSetup; on the Windows runners that takes longer than mocha's
	// 2 s default.
	mocha: { timeout: 20_000 },
	coverage: {
		reporter: ['lcov', 'text'],
		output: './coverage',
	},
});
