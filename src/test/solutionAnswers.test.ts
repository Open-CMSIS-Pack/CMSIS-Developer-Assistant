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

// What the CMSIS Solution extension's getter answers mean, and when they are not asked:
// an inactive extension, a missing command, an empty answer, a timeout, "<not found>".

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import {
    activeTargetSetOf,
    cbuildRunFileOf,
    packFolderCandidates,
    packFolderOf,
    solutionAnswerOf,
    solutionFileOf,
    solutionNameOf,
    targetTypeOf,
} from '../core/solutionAnswers';
import {
    activeCbuildRunFile,
    activePackFolders,
    askSolution,
    GET_BSP_PATH,
    GET_CBUILD_RUN_FILE,
    GET_DFP_PATH,
    SolutionCommands,
} from '../utils/solutionQueries';

const RUN_FILE = path.resolve('/w/Blinky+HW.cbuild-run.yml');

/** A CMSIS Solution extension that answers from `answers`; `asked` records what ran. */
function stubCommands(answers: Record<string, () => unknown>, options: { active?: boolean; registered?: string[]; timeoutMs?: number } = {}): {
    source: SolutionCommands; asked: string[];
} {
    const asked: string[] = [];
    const source: SolutionCommands = {
        extensionActive: () => options.active ?? true,
        commands: async () => options.registered ?? Object.keys(answers),
        execute: async (command) => {
            asked.push(command);
            return answers[command]?.();
        },
        timeoutMs: options.timeoutMs,
    };
    return { source, asked };
}

suite('CMSIS Solution answers', () => {
    test('getSolutionFile: a path, an object that names one, or none', () => {
        assert.strictEqual(solutionFileOf('/w/Blinky.csolution.yml'), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf(' /w/Blinky.csolution.yml '), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf({ solutionFile: '/w/Blinky.csolution.yml' }), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf({ uri: { fsPath: '/w/Blinky.csolution.yml' } }), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf({ uri: { path: '/w/Blinky.csolution.yml' } }), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf(''), undefined, 'no solution loaded');
        assert.strictEqual(solutionFileOf({}), undefined);
        assert.strictEqual(solutionFileOf(null), undefined);
        assert.strictEqual(solutionFileOf(undefined), undefined);

        assert.deepStrictEqual(solutionAnswerOf('/w/Blinky.csolution.yml'), { active: true, file: '/w/Blinky.csolution.yml' });
        assert.deepStrictEqual(solutionAnswerOf({}), { active: true }, 'an object without a path: active, path unknown');
        assert.deepStrictEqual(solutionAnswerOf(42), { active: true });
        for (const none of ['', '  ', undefined, null, false, 0]) {
            assert.deepStrictEqual(solutionAnswerOf(none), { active: false }, JSON.stringify(none));
        }
        assert.strictEqual(solutionNameOf('/w/Blinky.csolution.yml'), 'Blinky');
        assert.strictEqual(solutionNameOf({ fsPath: '/w/Blinky.csolution.yaml' }), 'Blinky');
        assert.strictEqual(solutionNameOf(''), undefined);
    });

    test('getActiveTargetSet: the set, its target-type, or none', () => {
        assert.strictEqual(activeTargetSetOf(' HW@Debug '), 'HW@Debug');
        assert.strictEqual(activeTargetSetOf(''), undefined);
        assert.strictEqual(activeTargetSetOf({ set: 'HW' }), undefined);
        assert.strictEqual(targetTypeOf('HW@Debug'), 'HW');
        assert.strictEqual(targetTypeOf('HW'), 'HW');
        assert.strictEqual(targetTypeOf('@Debug'), undefined);
        assert.strictEqual(targetTypeOf(undefined), undefined);
    });

    test('getCbuildRunFile counts only as an absolute path; "" and a relative answer are none', () => {
        assert.strictEqual(cbuildRunFileOf(RUN_FILE), RUN_FILE);
        assert.strictEqual(cbuildRunFileOf(` ${RUN_FILE} `), RUN_FILE);
        assert.strictEqual(cbuildRunFileOf(''), undefined);
        assert.strictEqual(cbuildRunFileOf('out/Blinky+HW.cbuild-run.yml'), undefined);
        assert.strictEqual(cbuildRunFileOf(undefined), undefined);
        assert.strictEqual(cbuildRunFileOf({ fsPath: RUN_FILE }), undefined);
    });

    test('getDfpPath and getBspPath: "<not found>" and "" are none; a relative folder is resolved against each base', () => {
        assert.strictEqual(packFolderOf('<not found>'), undefined);
        assert.strictEqual(packFolderOf(' <not found> '), undefined);
        assert.strictEqual(packFolderOf(''), undefined);
        assert.strictEqual(packFolderOf(undefined), undefined);
        assert.strictEqual(packFolderOf('/packs/Keil/X/1.0.0'), '/packs/Keil/X/1.0.0');
        const absolute = path.resolve('/packs/Keil/X/1.0.0');
        assert.deepStrictEqual(packFolderCandidates(absolute, [path.resolve('/w')]), [absolute]);
        const bases = [path.resolve('/w/out/app/HW/Debug'), path.resolve('/w/out/lib/HW/Debug'), path.resolve('/w/out/app/HW/Debug')];
        assert.deepStrictEqual(packFolderCandidates('../../../../packs/X', bases), [path.resolve('/w/packs/X')],
            'the cbuild.yml files of one target lie at the same depth: one candidate');
        assert.deepStrictEqual(packFolderCandidates('../X', [path.resolve('/w/a'), path.resolve('/w/b/c')]), [path.resolve('/w/X'), path.resolve('/w/b/X')]);
        assert.deepStrictEqual(packFolderCandidates('../X', []), []);
    });

    test('the getters are asked while the extension is active and has the command', async () => {
        const { source, asked } = stubCommands({
            [GET_CBUILD_RUN_FILE]: () => RUN_FILE,
            [GET_DFP_PATH]: () => '/packs/Keil/STM32F7xx_DFP/3.0.0',
            [GET_BSP_PATH]: () => '../../../../bsp',
        });
        assert.strictEqual(await activeCbuildRunFile(source), RUN_FILE);
        assert.deepStrictEqual(await activePackFolders(source), { dfp: '/packs/Keil/STM32F7xx_DFP/3.0.0', bsp: '../../../../bsp' });
        assert.deepStrictEqual(asked.sort(), [GET_BSP_PATH, GET_CBUILD_RUN_FILE, GET_DFP_PATH]);
    });

    test('an inactive extension is not asked: running its command would activate it', async () => {
        const { source, asked } = stubCommands({ [GET_CBUILD_RUN_FILE]: () => RUN_FILE, [GET_DFP_PATH]: () => '/p' }, { active: false });
        assert.strictEqual(await activeCbuildRunFile(source), undefined);
        assert.deepStrictEqual(await activePackFolders(source), {});
        assert.deepStrictEqual(asked, []);
        const throwing: SolutionCommands = { ...source, extensionActive: () => { throw new Error('no extension API'); } };
        assert.strictEqual(await activeCbuildRunFile(throwing), undefined);
        assert.deepStrictEqual(await activePackFolders(throwing), {});
    });

    test('a CMSIS Solution version without the command is not asked', async () => {
        const { source, asked } = stubCommands({ [GET_CBUILD_RUN_FILE]: () => RUN_FILE }, { registered: ['cmsis-csolution.getSolutionFile'] });
        assert.strictEqual(await activeCbuildRunFile(source), undefined);
        assert.deepStrictEqual(await activePackFolders(source), {});
        assert.deepStrictEqual(asked, [], 'feature detection, not a rejected executeCommand');
    });

    test('"", "<not found>", a failing command and a timeout are no answer', async () => {
        const empty = stubCommands({ [GET_CBUILD_RUN_FILE]: () => '', [GET_DFP_PATH]: () => '<not found>', [GET_BSP_PATH]: () => '' });
        assert.strictEqual(await activeCbuildRunFile(empty.source), undefined);
        assert.deepStrictEqual(await activePackFolders(empty.source), {});

        const failing = stubCommands({ [GET_CBUILD_RUN_FILE]: () => { throw new Error('no solution'); } });
        assert.strictEqual(await activeCbuildRunFile(failing.source), undefined);

        const slow = stubCommands({
            [GET_CBUILD_RUN_FILE]: () => new Promise(() => { /* never answers */ }),
            [GET_DFP_PATH]: () => new Promise(() => { /* never answers */ }),
            [GET_BSP_PATH]: () => '/bsp',
        }, { timeoutMs: 50 });
        const started = Date.now();
        assert.strictEqual(await activeCbuildRunFile(slow.source), undefined);
        assert.deepStrictEqual(await activePackFolders(slow.source), { bsp: '/bsp' }, 'the answer that came is kept');
        assert.ok(Date.now() - started < 2_000, 'the fence, not the command, ends the wait');

        const slowList: SolutionCommands = { ...empty.source, commands: () => new Promise(() => { /* never answers */ }), timeoutMs: 50 };
        assert.strictEqual(await askSolution(GET_CBUILD_RUN_FILE, slowList), undefined, 'the command lookup is inside the fence');
    });

    test('in this VS Code, without the CMSIS Solution extension, a stand-in command is never run', async () => {
        let ran = 0;
        const stand = vscode.commands.registerCommand(GET_CBUILD_RUN_FILE, () => { ran++; return RUN_FILE; });
        try {
            assert.strictEqual(await activeCbuildRunFile(), undefined);
            assert.strictEqual(ran, 0);
        } finally {
            stand.dispose();
        }
    });
});
