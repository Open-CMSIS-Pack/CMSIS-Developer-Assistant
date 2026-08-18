// SPDX-License-Identifier: Apache-2.0 OR MIT
// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/src/test/**/*.test.js',
	coverage: {
		reporter: ['lcov', 'text'],
		output: './coverage',
	},
});
