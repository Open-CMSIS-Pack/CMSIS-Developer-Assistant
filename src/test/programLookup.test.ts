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

import * as assert from 'assert';
import { taskCommandWords } from '../core/gdbServerPorts';
import {
    findProgram,
    installedIn,
    LookupFacts,
    placesOf,
    processPathFolders,
    taskPathFolders,
    taskProgram,
} from '../core/programLookup';

/**
 * The CMSIS Load commands CMSIS Solution 1.72.0 writes from its adapter
 * templates (`templates/debug/JLink.adapter.json`, `CMSIS-DAP-pyOCD.adapter.json`);
 * the Windows one as a tester's Infineon XMC4700 project had it.
 */
const JLINK_LOAD_WINDOWS = 'echo Connect > .cmd.jlink && echo LoadFile "out/snmp_agent_demo/snmp_agent_demo_flash/snmp_agent_demo.axf" '
    + '>> .cmd.jlink && echo Exit >> .cmd.jlink && JLink.exe -device XMC4700-F144x2048 -if swd -speed 4000 -commandfile .cmd.jlink';
const JLINK_LOAD_POSIX = 'echo Connect > .cmd.jlink && echo LoadFile "out/blinky/blinky.axf" >> .cmd.jlink && echo Exit >> .cmd.jlink && '
    + 'JLinkExe -device XMC4700-F144x2048 -if swd -speed 4000 -commandfile .cmd.jlink';

/** Lookup facts of a Windows machine whose files are `files`, compared without regard to case. */
function windows(files: readonly string[], env: Record<string, string> = {}, dirs: Record<string, string[]> = {}): LookupFacts {
    const vars: Record<string, string> = { PATH: 'C:\\Windows\\system32;C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', PROGRAMFILES: 'C:\\Program Files', ...env };
    return {
        platform: 'win32',
        env: (name) => vars[name.toUpperCase()],
        isFile: (file) => files.some((known) => known.toLowerCase() === file.toLowerCase()),
        listDir: (folder) => dirs[folder] ?? [],
    };
}

suite('Program lookup', () => {
    test('the kind of a task\'s program: J-Link in a shell line, pyOCD, an FVP model, another command, none', () => {
        const shell = (commandLine: string): string[] | undefined => taskCommandWords({ execution: { commandLine } });
        assert.deepStrictEqual(taskProgram(shell(JLINK_LOAD_WINDOWS)), { kind: 'jlink', program: 'JLink.exe' });
        assert.deepStrictEqual(taskProgram(shell(JLINK_LOAD_POSIX)), { kind: 'jlink', program: 'JLinkExe' });
        // A whole shell line handed over as one command word.
        assert.deepStrictEqual(taskProgram([JLINK_LOAD_POSIX]), { kind: 'jlink', program: 'JLinkExe' });
        assert.deepStrictEqual(taskProgram(['JLinkGDBServerCLExe', '-device', 'X']), { kind: 'jlink', program: 'JLinkGDBServerCLExe' });
        assert.deepStrictEqual(taskProgram(['C:\\Program Files\\SEGGER\\JLink\\JLink.exe', '-device', 'X']),
            { kind: 'jlink', program: 'C:\\Program Files\\SEGGER\\JLink\\JLink.exe' });
        assert.deepStrictEqual(taskProgram(['pyocd', 'load', '--probe', 'cmsisdap:', '--cbuild-run', 'x.cbuild-run.yml']), { kind: 'pyocd' });
        assert.deepStrictEqual(taskProgram(['python3', 'scripts/pyocd_wrapper.py', 'load']), { kind: 'pyocd' });
        assert.deepStrictEqual(taskProgram(['FVP_Corstone_SSE-300', '-f', 'fvp.txt']), { kind: 'fvp' });
        assert.deepStrictEqual(taskProgram(['echo', 'CMSIS Load: images are loaded by the FVP model when CMSIS Run starts.']), { kind: 'other' });
        assert.deepStrictEqual(taskProgram(undefined), { kind: 'unknown' });
        assert.deepStrictEqual(taskProgram(['echo', '.cmd.jlink']), { kind: 'other' }, 'the command file is no J-Link program');
    });

    test('the PATH of the CMSIS tasks: tools-environment.yml first, then the terminal setting with ${env:PATH} as VS Code\'s PATH', () => {
        const facts = windows([], { TOOLS: 'D:\\tools' });
        const folders = taskPathFolders(['C:/Users/dev/.vcpkg/bin'], { Path: 'C:\\Program Files\\SEGGER\\JLink;${env:TOOLS};${env:PATH}' }, facts);
        assert.deepStrictEqual(folders, [
            { folder: 'C:\\Users\\dev\\.vcpkg\\bin', place: '.cmsis/tools-environment.yml' },
            { folder: 'C:\\Program Files\\SEGGER\\JLink', place: 'terminal.integrated.env.windows' },
            { folder: 'D:\\tools', place: 'terminal.integrated.env.windows' },
            { folder: 'C:\\Windows\\system32', place: 'VS Code\'s PATH' },
            { folder: 'C:\\Windows', place: 'VS Code\'s PATH' },
        ]);
        assert.deepStrictEqual(placesOf(folders), ['.cmsis/tools-environment.yml', 'terminal.integrated.env.windows', 'VS Code\'s PATH']);
        assert.deepStrictEqual(placesOf(taskPathFolders(undefined, { PATH: 'C:\\only' }, facts)), ['terminal.integrated.env.windows'],
            'a setting PATH without ${env:PATH} replaces VS Code\'s');
        assert.deepStrictEqual(taskPathFolders(undefined, { OTHER: 'x', PATH: null }, facts), processPathFolders(facts), 'no PATH set: VS Code\'s');
    });

    test('Windows: PATHEXT for a name without an extension, names without regard to case; elsewhere the name as it is', () => {
        const facts = windows(['C:\\Tools\\JLINK.EXE', 'C:\\Scripts\\server.cmd']);
        const folders = [{ folder: 'C:\\Scripts', place: 'a' }, { folder: 'c:\\tools', place: 'b' }];
        assert.strictEqual(findProgram('JLink.exe', folders, facts)?.place, 'b');
        assert.strictEqual(findProgram('JLink', folders, facts)?.file, 'c:\\tools\\JLink.exe');
        assert.strictEqual(findProgram('server', folders, facts)?.file, 'C:\\Scripts\\server.cmd');
        assert.strictEqual(findProgram('JLink.dll', folders, facts), undefined);
        assert.strictEqual(findProgram('C:\\Tools\\JLink.exe', folders, facts), undefined, 'a program with a folder is not looked up');
        const posix: LookupFacts = { platform: 'linux', env: () => '/usr/bin:/opt/SEGGER/JLink', isFile: (file) => file === '/opt/SEGGER/JLink/JLinkExe', listDir: () => [] };
        assert.strictEqual(findProgram('JLinkExe', processPathFolders(posix), posix)?.file, '/opt/SEGGER/JLink/JLinkExe');
        assert.strictEqual(findProgram('jlinkexe', processPathFolders(posix), posix), undefined);
    });

    test('a SEGGER folder holds the program although no PATH does: JLink, else the newest versioned folder; never a guess', () => {
        assert.strictEqual(installedIn('JLink.exe', windows(['C:\\Program Files\\SEGGER\\JLink\\JLink.exe'])), 'C:\\Program Files\\SEGGER\\JLink');
        const versioned = windows(['C:\\Program Files\\SEGGER\\JLink_V794\\JLink.exe', 'C:\\Program Files\\SEGGER\\JLink_V810\\JLink.exe'], {},
            { 'C:\\Program Files\\SEGGER': ['JLink_V794', 'JLink_V810', 'Ozone'] });
        assert.strictEqual(installedIn('JLink.exe', versioned), 'C:\\Program Files\\SEGGER\\JLink_V810');
        assert.strictEqual(installedIn('JLink.exe', windows([], {}, { 'C:\\Program Files\\SEGGER': ['JLink'] })), undefined,
            'a folder that does not hold the program is not named');
        const mac: LookupFacts = { platform: 'darwin', env: () => undefined, isFile: (file) => file === '/Applications/SEGGER/JLink/JLinkExe', listDir: () => [] };
        assert.strictEqual(installedIn('JLinkExe', mac), '/Applications/SEGGER/JLink');
    });
});
