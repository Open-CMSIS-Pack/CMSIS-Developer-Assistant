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

/**
 * The import order of AGENTS.md ("Writing code") over every TypeScript file
 * under src/: `vscode` first, then Node built-ins and packages, then this
 * repository's modules. Type-only imports keep the place of their module.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Files that still break the order and are reordered in a change of their
 * own. The list only shrinks: the change that reorders a file removes its
 * entry, and a test below fails until it does.
 */
const EXEMPT_FILES: string[] = [];

/** One import declaration: the module it names and the line it starts on. */
interface ImportLine {
    specifier: string;
    line: number;
}

/** The place of a module in the order: 0 `vscode`, 1 Node built-ins and packages, 2 this repository. */
function groupOf(specifier: string): number {
    if (specifier === 'vscode') {
        return 0;
    }
    return specifier.startsWith('.') ? 2 : 1;
}

/** The TypeScript files under `dir` of `root`, as paths with forward slashes. */
function sourceFiles(root: string, dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            out.push(...sourceFiles(root, rel));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            out.push(rel);
        }
    }
    return out;
}

/** The import declarations of a source text in order, `import x = require()` included. */
function importsOf(fileName: string, text: string): ImportLine[] {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022);
    const found: ImportLine[] = [];
    for (const statement of source.statements) {
        let specifier: ts.Expression | undefined;
        if (ts.isImportDeclaration(statement)) {
            specifier = statement.moduleSpecifier;
        } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
            specifier = statement.moduleReference.expression;
        }
        if (specifier !== undefined && ts.isStringLiteral(specifier)) {
            const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
            found.push({ specifier: specifier.text, line });
        }
    }
    return found;
}

/** Each import that follows one of a later group, as `file:line: 'module' after 'module'`. */
function orderBreaks(fileName: string, text: string): string[] {
    const imports = importsOf(fileName, text);
    const breaks: string[] = [];
    for (let i = 1; i < imports.length; i++) {
        if (groupOf(imports[i].specifier) < groupOf(imports[i - 1].specifier)) {
            breaks.push(`${fileName}:${imports[i].line}: '${imports[i].specifier}' after '${imports[i - 1].specifier}'`);
        }
    }
    return breaks;
}

suite('Import order (AGENTS.md, "Writing code")', () => {

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const files = sourceFiles(repoRoot, 'src').sort();
    const breaksOf = (rel: string): string[] => orderBreaks(rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8'));

    test('the check reads multi-line and type-only imports and names each break', () => {
        const text = [
            "import * as fs from 'fs';",
            "import type * as vscode from 'vscode';",
            'import {',
            '    helper,',
            "} from './helper';",
            "import { SerialPortMock } from 'serialport';",
        ].join('\n');
        assert.deepStrictEqual(orderBreaks('sample.ts', text), [
            "sample.ts:2: 'vscode' after 'fs'",
            "sample.ts:6: 'serialport' after './helper'",
        ]);
        assert.ok(files.includes('src/extension.ts'), `no src/ under ${repoRoot}`);
    });

    test('every file under src/ imports vscode first, then Node built-ins and packages, then the repository\'s modules', () => {
        const breaks = files.filter((rel) => !EXEMPT_FILES.includes(rel)).flatMap(breaksOf);
        assert.deepStrictEqual(breaks, [],
            'move the imports: vscode first, then Node built-ins and packages, then this repository\'s modules');
    });

    test('every exempt file still breaks it, so the list shrinks with each reorder', () => {
        const reordered = EXEMPT_FILES.filter((rel) => breaksOf(rel).length === 0);
        assert.deepStrictEqual(reordered, [], 'remove reordered files from EXEMPT_FILES in src/test/importOrder.test.ts');
    });
});
