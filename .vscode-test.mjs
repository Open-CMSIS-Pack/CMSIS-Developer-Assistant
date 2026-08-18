// Copyright (c) Microsoft Corporation.

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/src/test/**/*.test.js',
	coverage: {
		reporter: ['lcov', 'text'],
		output: './coverage',
	},
});
