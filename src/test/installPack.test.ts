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

// `cmsis_action install_pack`: the pack id, the licence gate, the install through a stand-in host, the knowledge line, the failures.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DebuggingHandler } from '../debuggingHandler';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import { KnowledgeHandler } from '../knowledgeHandler';
import { SOLUTION_EXTENSION_ID } from '../core/bootstrapState';
import type { ProjectFactsResult } from '../core/knowledge/projectFacts';
import { silentLog } from '../core/packDocs/host';
import {
    checkLicence,
    INSTALL_PACK_COMMAND,
    knowledgeLine,
    licenceQuestion,
    parsePackRequest,
} from '../core/packInstall';
import type { ProblemInput } from '../core/problemJournal';
import { errorDetail, ErrorCode, JsonObject, textOf, ToolError, ToolText } from '../core/toolResult';
import { VSCODE_HOST, type HandlerHost } from '../handler/host';
import { PackInstallHost, runInstallPack } from '../handler/installPack';
import type { IDebugConfigurationManager } from '../utils/debugConfigurationManager';

/** The pack root of the knowledge fixtures: Acme::Mini_BSP 0.2.0 with a `.knowledge/` that cmsis-knowledge built. */
const BUILT_PACKS = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'knowledge', 'packs');
const MINI_FOLDER = path.join(BUILT_PACKS, 'Acme', 'Mini_BSP', '0.2.0');
const MINI_EXPAND = 'It ships 3 knowledge units: knowledge_expand {id: "pack:Acme::Mini_BSP", relation: "scoped_to"}';
const LOCKED = 'flash is locked (result code 0x42)';

const USAGE = 'Pass pack: \'Vendor::Name@version\' with the exact version identification verified, e.g. \'ARM::CMSIS@6.1.0\'.';
const OUTPUT_HINT = 'The "CMSIS Solution" output channel (View → Output) has cpackget\'s lines. '
    + 'The CMSIS Solution extension runs the cpackget on VS Code\'s PATH, not the copy it bundles for builds. '
    + 'Do not run cpackget yourself; tell the user what the channel says.';

function pdsc(vendor: string, name: string, licence?: string): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<package schemaVersion="1.7.36">\n'
        + `  <vendor>${vendor}</vendor>\n  <name>${name}</name>\n`
        + (licence !== undefined ? `  <license>${licence}</license>\n` : '')
        // A licence set names licences too; only the package's own <license> is what cpackget asks about.
        + '  <licenseSets>\n    <licenseSet id="all" default="true" gating="true">\n'
        + '      <license title="Apache-2.0 License" name="LICENSE" spdx="Apache-2.0"/>\n    </licenseSet>\n  </licenseSets>\n'
        + '  <releases><release version="1.0.0">First.</release></releases>\n</package>\n';
}

/** The `ToolError` a call rejects with, its code checked. */
async function refusalOf(pending: Promise<unknown>, code: ErrorCode): Promise<ToolError> {
    try {
        await pending;
    } catch (caught) {
        assert.ok(caught instanceof ToolError, `expected a ToolError, got ${String(caught)}`);
        assert.strictEqual(caught.code, code, errorDetail(caught));
        return caught;
    }
    assert.fail('expected the call to reject');
}

function replyOf(answer: ToolText): { text: string; status: string; data: JsonObject } {
    assert.ok(typeof answer === 'object', `expected a reply, got ${JSON.stringify(answer)}`);
    return { text: answer.text, status: answer.status, data: answer.data ?? {} };
}

/** The CMSIS Solution extension and VS Code as the install sees them, scripted. */
class StandInInstaller implements PackInstallHost {
    commands: string[] = [INSTALL_PACK_COMMAND];
    readonly asked: Array<{ message: string; detail: string }> = [];
    readonly installs: string[] = [];
    readonly problems: ProblemInput[] = [];
    /** The user's answer to the licence question. */
    answer: () => Thenable<boolean> = async () => true;
    /** What the command answers; by default it unpacks the pack as cpackget would and returns its folder. */
    result: (vendor: string, name: string, version: string) => Thenable<unknown> = async (vendor, name, version) => {
        const folder = path.join(this.root, vendor, name, version);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, `${vendor}.${name}.pdsc`), pdsc(vendor, name));
        return folder;
    };

    constructor(readonly root: string) { }

    async solutionCommands(): Promise<readonly string[]> {
        return this.commands;
    }

    installPack(vendor: string, name: string, version: string): Thenable<unknown> {
        this.installs.push(`${vendor}::${name}@${version}`);
        return this.result(vendor, name, version);
    }

    async packRoot(): Promise<string> {
        return this.root;
    }

    confirmLicence(message: string, detail: string): Thenable<boolean> {
        this.asked.push({ message, detail });
        return this.answer();
    }

    report(problem: ProblemInput): void {
        this.problems.push(problem);
    }
}

/** The host of the window: the CMSIS Solution extension installed, unless `solution` is false. */
function hostFor(installer: PackInstallHost, solution = true): HandlerHost {
    return {
        ...VSCODE_HOST,
        toolEnvironment: () => ({
            extension: (id) => (solution && id === SOLUTION_EXTENSION_ID ? { path: '/ext/csolution', version: '1.71.0' } : undefined),
            pathEnv: '',
            platform: process.platform,
        }),
        packInstall: () => installer,
    };
}

/** The debugging handler with its host replaced; install_pack needs nothing of the executor. */
class PackHandler extends DebuggingHandler {
    constructor(private readonly replaced: HandlerHost) {
        super({} as IDebuggingExecutor, {} as IDebugConfigurationManager, 5);
    }

    protected host(): HandlerHost {
        return this.replaced;
    }
}

suite('cmsis_action install_pack', () => {
    let root: string;
    setup(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-install-')));
        fs.mkdirSync(path.join(root, '.Web'));
        fs.writeFileSync(path.join(root, '.Web', 'Acme.Lic.pdsc'), pdsc('Acme', 'Lic', 'License/EULA.txt'));
        fs.writeFileSync(path.join(root, '.Web', 'Acme.Free.pdsc'), pdsc('Acme', 'Free'));
    });
    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const install = (installer: StandInInstaller, pack: unknown, waitMs = 5_000, host: HandlerHost = hostFor(installer)): Promise<ToolText> =>
        runInstallPack(host, pack, host.now() + waitMs);

    suite('the pack argument', () => {
        test('a missing, malformed or unversioned pack is refused with the reason, and nothing is installed', async () => {
            const refused = (given: unknown): string => {
                try {
                    parsePackRequest(given);
                } catch (caught) {
                    assert.ok(caught instanceof ToolError && caught.code === 'INVALID_ARGUMENT', String(caught));
                    assert.strictEqual(caught.hint, USAGE);
                    return caught.message;
                }
                assert.fail(`expected ${JSON.stringify(given)} to be refused`);
            };
            assert.strictEqual(refused(undefined), 'CMSIS \'install_pack\' not attempted: no pack given.');
            assert.strictEqual(refused('  '), 'CMSIS \'install_pack\' not attempted: no pack given.');
            assert.strictEqual(refused('CMSIS@6.1.0'),
                'CMSIS \'install_pack\' not attempted: \'CMSIS@6.1.0\' is not a pack id of the form Vendor::Name@version (letters, digits, - and _ in vendor and name).');
            assert.match(refused('ARM::../../x@1.0.0'), /is not a pack id/);
            assert.match(refused('Alif Semi::Ensemble@1.0.0'), /is not a pack id/);
            assert.strictEqual(refused('ARM::CMSIS'),
                'CMSIS \'install_pack\' not attempted: \'ARM::CMSIS\' names no version. install_pack installs one exact version, never the latest.');
            assert.match(refused('ARM::CMSIS@'), /names no version/);
            for (const version of ['latest', 'v6.1.0', '6.1', '06.1.0', '6.1.0.1']) {
                assert.strictEqual(refused(`ARM::CMSIS@${version}`),
                    `CMSIS 'install_pack' not attempted: '${version}' is not a version of the form major.minor.patch.`);
            }
            assert.deepStrictEqual(parsePackRequest(' ARM::CMSIS@6.1.0 '), { vendor: 'ARM', name: 'CMSIS', version: '6.1.0' });
            assert.deepStrictEqual(parsePackRequest('Keil::STM32F7xx_DFP@3.0.0-rc1+b.7'), { vendor: 'Keil', name: 'STM32F7xx_DFP', version: '3.0.0-rc1+b.7' });

            const installer = new StandInInstaller(root);
            const detail = errorDetail(await refusalOf(install(installer, 'ARM::CMSIS'), 'INVALID_ARGUMENT'));
            assert.ok(detail.endsWith(`\n${USAGE}`), detail);
            assert.deepStrictEqual([installer.asked, installer.installs, installer.problems], [[], [], []]);
        });

        test('without the CMSIS Solution extension, or with one that lacks the command, it is refused before anything is asked', async () => {
            const installer = new StandInInstaller(root);
            const missing = await refusalOf(install(installer, 'Acme::Lic@1.0.0', 5_000, hostFor(installer, false)), 'CMSIS_NO_SOLUTION');
            assert.strictEqual(missing.message, 'CMSIS \'install_pack\' not attempted: the CMSIS Solution extension (Arm.cmsis-csolution) '
                + 'is not installed in this VS Code, so there is no active solution.');
            assert.ok(missing.hint?.startsWith('Ask the user to install the Keil Studio Pack (Arm.keil-studio-pack)'), missing.hint);

            installer.commands = ['cmsis-csolution.build'];
            assert.strictEqual(errorDetail(await refusalOf(install(installer, 'Acme::Lic@1.0.0'), 'TOOL_DISABLED')),
                'CMSIS \'install_pack\' not attempted: the CMSIS Solution extension 1.71.0 has no command cmsis-csolution.installPack; '
                + 'CMSIS Solution 1.72.0 has it.\n'
                + 'Ask the user to update the CMSIS Solution extension (Arm.cmsis-csolution) and to reload the window. Do not run cpackget yourself.');

            installer.solutionCommands = () => Promise.reject(new Error('activation failed'));
            assert.strictEqual(errorDetail(await refusalOf(install(installer, 'Acme::Lic@1.0.0'), 'TASK_FAILED')),
                'CMSIS \'install_pack\' not attempted: the CMSIS Solution extension did not activate (activation failed).\n'
                + 'Ask the user to reload the VS Code window, then call install_pack again; get_recent_problems shows what the extension reported.');
            installer.solutionCommands = () => new Promise<readonly string[]>(() => undefined);
            assert.strictEqual((await refusalOf(install(installer, 'Acme::Lic@1.0.0', 1_700), 'TASK_FAILED')).message,
                'CMSIS \'install_pack\' not attempted: the CMSIS Solution extension did not activate (no answer within 0.2 s).');
            assert.deepStrictEqual([installer.asked, installer.installs], [[], []]);
        });
    });

    suite('the licence gate', () => {
        test('the PDSC in .Web/ says whether the pack declares a licence, matched without regard to case', () => {
            const lic = path.join(root, '.Web', 'Acme.Lic.pdsc');
            assert.deepStrictEqual(checkLicence(root, { vendor: 'Acme', name: 'Lic', version: '1.0.0' }), { kind: 'declared', file: 'License/EULA.txt', pdsc: lic });
            assert.deepStrictEqual(checkLicence(root, { vendor: 'acme', name: 'LIC', version: '1.0.0' }), { kind: 'declared', file: 'License/EULA.txt', pdsc: lic });
            assert.deepStrictEqual(checkLicence(root, { vendor: 'Acme', name: 'Free', version: '1.0.0' }),
                { kind: 'none', pdsc: path.join(root, '.Web', 'Acme.Free.pdsc') });
            fs.writeFileSync(path.join(root, '.Web', 'Acme.Empty.pdsc'), pdsc('Acme', 'Empty', ' '));
            assert.strictEqual(checkLicence(root, { vendor: 'Acme', name: 'Empty', version: '1.0.0' }).kind, 'none');
            assert.deepStrictEqual(checkLicence(root, { vendor: 'Acme', name: 'Ghost', version: '1.0.0' }),
                { kind: 'unchecked', reason: `${path.join(root, '.Web')} has no Acme.Ghost.pdsc` });
            assert.deepStrictEqual(checkLicence(path.join(root, 'nowhere'), { vendor: 'Acme', name: 'Lic', version: '1.0.0' }).kind, 'unchecked');
            fs.writeFileSync(path.join(root, '.Web', 'Acme.Broken.pdsc'), '<package><license>X</package>');
            const broken = checkLicence(root, { vendor: 'Acme', name: 'Broken', version: '1.0.0' });
            assert.ok(broken.kind === 'unchecked' && /Acme\.Broken\.pdsc could not be read \(closing <\/package> does not match <license>/.test(broken.reason),
                JSON.stringify(broken));
        });

        test('a declared licence is installed only after the user chose Install, and the question names the pack and the file', async () => {
            const installer = new StandInInstaller(root);
            const folder = path.join(root, 'Acme', 'Lic', '1.0.0');
            const result = replyOf(await install(installer, 'Acme::Lic@1.0.0'));
            assert.deepStrictEqual(installer.asked, [licenceQuestion({ vendor: 'Acme', name: 'Lic', version: '1.0.0' }, 'License/EULA.txt', folder)]);
            assert.strictEqual(installer.asked[0].message, 'Install the CMSIS pack Acme::Lic@1.0.0?');
            assert.strictEqual(installer.asked[0].detail, 'An agent asked to install Acme::Lic@1.0.0 through the CMSIS Developer Assistant. '
                + 'The pack declares a licence in its file \'License/EULA.txt\'. Install agrees to that licence for you, as cpackget '
                + `--agree-embedded-license does; the file is in ${folder} after the install.`);
            assert.deepStrictEqual(installer.installs, ['Acme::Lic@1.0.0']);
            assert.strictEqual(result.status, 'ok');
            assert.strictEqual(result.text, `Acme::Lic@1.0.0 installed in ${folder}.\nThe user accepted its licence (License/EULA.txt) in VS Code.`);
            assert.deepStrictEqual(result.data, { pack: 'Acme::Lic@1.0.0', folder, licence: 'accepted' });
        });

        test('Cancel is a refusal that says the user declined; nothing is installed and nothing journaled', async () => {
            const installer = new StandInInstaller(root);
            installer.answer = async () => false;
            assert.strictEqual(errorDetail(await refusalOf(install(installer, 'Acme::Lic@1.0.0'), 'TASK_FAILED')),
                'CMSIS \'install_pack\' not attempted: the user declined the licence of Acme::Lic@1.0.0 (License/EULA.txt) in the VS Code window.\n'
                + 'Do not install the pack another way. Ask the user whether to install it with that licence; if so, call install_pack again.');
            assert.deepStrictEqual([installer.installs, installer.problems], [[], []]);
            // Declined is not remembered: the next call asks again.
            installer.answer = async () => true;
            assert.strictEqual(replyOf(await install(installer, 'Acme::Lic@1.0.0')).status, 'ok');
            assert.strictEqual(installer.asked.length, 2);
        });

        test('no answer within the wait is a refusal; a repeated call waits for the same question, and a late Install installs once', async () => {
            const installer = new StandInInstaller(root);
            let choose: (install: boolean) => void = () => undefined;
            installer.answer = () => new Promise<boolean>((resolve) => {
                choose = resolve;
            });
            const unanswered = await refusalOf(install(installer, 'Acme::Lic@1.0.0', 1_700), 'TASK_FAILED');
            assert.match(unanswered.message,
                /^CMSIS 'install_pack' not attempted: nobody answered the licence question for Acme::Lic@1\.0\.0 in the VS Code window \(asked [\d.]+ s ago\)\.$/);
            assert.strictEqual(unanswered.hint, 'The dialog stays open. Ask the user to answer it, then call install_pack with the same pack again: '
                + 'it waits for that answer instead of asking twice, and timeoutMs (up to 600000) gives the user longer.');
            assert.deepStrictEqual(installer.installs, []);

            const again = install(installer, 'Acme::Lic@1.0.0');
            setTimeout(() => choose(true), 50);
            const result = replyOf(await again);
            assert.match(result.text, /^Attached to the install of Acme::Lic@1\.0\.0 started [\d.]+ s ago \(not started again\)\. Acme::Lic@1\.0\.0 installed in /);
            assert.strictEqual(installer.asked.length, 1);
            assert.deepStrictEqual(installer.installs, ['Acme::Lic@1.0.0']);
        });

        test('two calls for the same pack at once share one question and one install', async () => {
            const installer = new StandInInstaller(root);
            const [one, two] = await Promise.all([install(installer, 'Acme::Lic@1.0.0'), install(installer, 'acme::lic@1.0.0')]);
            assert.strictEqual(replyOf(one).status, 'ok');
            assert.match(replyOf(two).text, /^Attached to the install of Acme::Lic@1\.0\.0 started [\d.]+ s ago \(not started again\)\. Acme::Lic@1\.0\.0 installed in /);
            assert.deepStrictEqual([installer.asked.length, installer.installs], [1, ['Acme::Lic@1.0.0']]);
        });

        test('a pack without a licence is installed without a question, and one without a PDSC says that its licence was not checked', async () => {
            const installer = new StandInInstaller(root);
            const free = replyOf(await install(installer, 'Acme::Free@2.1.0'));
            assert.strictEqual(free.text, `Acme::Free@2.1.0 installed in ${path.join(root, 'Acme', 'Free', '2.1.0')}.`);
            assert.strictEqual(free.data.licence, 'none');

            const ghost = replyOf(await install(installer, 'Acme::Ghost@0.3.0'));
            assert.strictEqual(ghost.text, `Acme::Ghost@0.3.0 installed in ${path.join(root, 'Acme', 'Ghost', '0.3.0')}.\n`
                + `Its licence was not checked before the install: ${path.join(root, '.Web')} has no Acme.Ghost.pdsc, `
                + 'and cpackget accepted any licence the pack embeds. Tell the user.');
            assert.strictEqual(ghost.data.licence, 'unchecked');
            assert.deepStrictEqual(installer.asked, []);
            assert.deepStrictEqual(installer.installs, ['Acme::Free@2.1.0', 'Acme::Ghost@0.3.0']);
        });
    });

    suite('after the command', () => {
        test('the result names the knowledge units the pack ships', async () => {
            assert.deepStrictEqual(knowledgeLine(MINI_FOLDER, { vendor: 'Acme', name: 'Mini_BSP', version: '0.2.0' }), { line: MINI_EXPAND, units: 3 });
            assert.strictEqual(knowledgeLine(root, { vendor: 'Acme', name: 'Mini_BSP', version: '0.2.0' }), undefined);
            const bad = path.join(root, 'bad');
            fs.mkdirSync(path.join(bad, '.knowledge'), { recursive: true });
            fs.writeFileSync(path.join(bad, '.knowledge', 'knowledge.db'), 'not a database');
            assert.match(knowledgeLine(bad, { vendor: 'V', name: 'P', version: '1.0.0' })?.line ?? '',
                /^It ships a knowledge index that could not be read \(.*is not a knowledge index/);

            const installer = new StandInInstaller(root);
            installer.result = async () => MINI_FOLDER;
            const result = replyOf(await install(installer, 'Acme::Mini_BSP@0.2.0'));
            assert.strictEqual(result.text, `Acme::Mini_BSP@0.2.0 installed in ${MINI_FOLDER}.\n`
                + `Its licence was not checked before the install: ${path.join(root, '.Web')} has no Acme.Mini_BSP.pdsc, `
                + `and cpackget accepted any licence the pack embeds. Tell the user.\n${MINI_EXPAND}`);
            assert.strictEqual(result.data.knowledgeUnits, 3);
        });

        test('knowledge_expand lists the units of a pack that knowledge_search hides outside a project using it', async () => {
            const base = path.join(root, 'base.db');
            const db = new DatabaseSync(base);
            db.exec(`
                BEGIN;
                CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT, type TEXT, domain TEXT, title TEXT, summary TEXT, body TEXT, meta JSON);
                CREATE TABLE edges(src TEXT, rel TEXT, dst TEXT, qual JSON, PRIMARY KEY(src, rel, dst));
                CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, title, summary, body, symptoms, triggers, tokenize='porter unicode61');
                CREATE TABLE info(key TEXT PRIMARY KEY, value TEXT);
                INSERT INTO nodes VALUES('fx-flash', 'knowledge', 'concept', NULL, 'Flash basics', 'How flash is locked', 'flash is locked', '{}');
                INSERT INTO nodes_fts VALUES('fx-flash', 'Flash basics', 'How flash is locked', 'flash is locked', '', '');
                COMMIT;
            `);
            db.close();
            const handlerWith = (facts: ProjectFactsResult): KnowledgeHandler => new KnowledgeHandler({
                indexPath: () => base, includeIncomplete: () => true, packRoot: async () => BUILT_PACKS, workspaceFolders: () => [],
                projectFacts: async () => facts, log: silentLog,
            }, { timeoutMs: 5_000 });
            const using = handlerWith({ facts: { packs: ['Acme::Mini_BSP'] } });
            const knowledge = handlerWith({ note: 'no active project' });
            try {
                assert.match(textOf(await using.handleKnowledgeSearch({ query: LOCKED })), /ts-mini-flash-locked/);
                assert.doesNotMatch(textOf(await knowledge.handleKnowledgeSearch({ query: LOCKED })), /mini/);
                const expanded = textOf(await knowledge.handleKnowledgeExpand({ id: 'pack:Acme::Mini_BSP', relation: 'scoped_to' }));
                assert.match(expanded, /^pack:Acme::Mini_BSP · pack · .*\n3 relations of kind scoped_to:\n/);
                for (const unit of ['concept-mini-board', 'proc-mini-bring-up', 'ts-mini-flash-locked']) {
                    assert.match(expanded, new RegExp(`← scoped_to ${unit} · `));
                }
            } finally {
                using.dispose();
                knowledge.dispose();
            }
        });

        test('no folder from the command is a failure with the pack id and the output channel, journaled', async () => {
            const installer = new StandInInstaller(root);
            installer.result = async () => undefined;
            const failed = await refusalOf(install(installer, 'Acme::Free@1.0.0'), 'TASK_FAILED');
            assert.strictEqual(errorDetail(failed), 'CMSIS \'install_pack\' failed: the CMSIS Solution extension did not install Acme::Free@1.0.0 '
                + `(cmsis-csolution.installPack returned no folder).\n${OUTPUT_HINT}`);
            assert.deepStrictEqual(installer.problems, [{ source: 'extension', origin: 'Arm.cmsis-csolution', severity: 'error', code: 'TASK_FAILED',
                message: failed.message, hint: OUTPUT_HINT }]);

            // A folder the expected place has anyway is named.
            fs.mkdirSync(path.join(root, 'Acme', 'Free', '1.0.0'), { recursive: true });
            installer.result = () => Promise.reject(new Error('cpackget not found'));
            assert.strictEqual((await refusalOf(install(installer, 'Acme::Free@1.0.0'), 'TASK_FAILED')).message,
                'CMSIS \'install_pack\' failed: the CMSIS Solution extension did not install Acme::Free@1.0.0 '
                + `(cmsis-csolution.installPack failed: cpackget not found). ${path.join(root, 'Acme', 'Free', '1.0.0')} exists, perhaps from an earlier install.`);
            assert.strictEqual(installer.problems.length, 2);
        });

        test('a folder the command names but that is missing is a failure, journaled', async () => {
            const installer = new StandInInstaller(root);
            const named = path.join(root, 'Acme', 'Free', '1.0.0');
            installer.result = async () => named;
            const failed = await refusalOf(install(installer, 'Acme::Free@1.0.0'), 'TASK_FAILED');
            assert.strictEqual(failed.message,
                `CMSIS 'install_pack' failed: cmsis-csolution.installPack reported ${named} for Acme::Free@1.0.0, but that folder does not exist.`);
            assert.ok(failed.hint?.startsWith('The CMSIS Solution extension answers so without running cpackget while the same install still waits '
                + 'in its queue: call install_pack again in a moment.'), failed.hint);
            assert.strictEqual(installer.problems[0]?.message, failed.message);
        });

        test('an installed pack is not installed again, and its knowledge is named', async () => {
            const installer = new StandInInstaller(BUILT_PACKS);
            const result = replyOf(await install(installer, 'Acme::Mini_BSP@0.2.0'));
            assert.strictEqual(result.text, `Acme::Mini_BSP@0.2.0 is already installed in ${MINI_FOLDER}; nothing was installed.\n${MINI_EXPAND}`);
            assert.deepStrictEqual([installer.asked, installer.installs], [[], []]);
        });

        test('an install that outlasts the wait is running; a repeated call waits for it and does not start a second one', async () => {
            const installer = new StandInInstaller(root);
            const unpack = installer.result;
            let finish: () => void = () => undefined;
            installer.result = (vendor, name, version) => new Promise<unknown>((resolve) => {
                finish = () => resolve(unpack(vendor, name, version));
            });
            const first = replyOf(await install(installer, 'Acme::Free@1.0.0', 1_700));
            assert.strictEqual(first.status, 'running');
            assert.match(first.text, /^Acme::Free@1\.0\.0 is still being installed by the CMSIS Solution extension \(cpackget add, [\d.]+ s so far\)\. /);
            assert.ok(first.text.endsWith('Call install_pack with the same pack again to wait for it; it is not started twice.'), first.text);
            assert.deepStrictEqual(first.data, { pack: 'Acme::Free@1.0.0', folder: path.join(root, 'Acme', 'Free', '1.0.0') });

            const second = install(installer, 'Acme::Free@1.0.0');
            setTimeout(() => finish(), 50);
            assert.match(replyOf(await second).text, /^Attached to the install of Acme::Free@1\.0\.0 started [\d.]+ s ago \(not started again\)\. Acme::Free@1\.0\.0 installed in /);
            assert.deepStrictEqual(installer.installs, ['Acme::Free@1.0.0']);
        });

        test('cmsis_action carries pack to the install and needs no solution', async () => {
            const installer = new StandInInstaller(root);
            const handler = new PackHandler({ ...hostFor(installer), workspaceFolders: () => [] });
            const result = replyOf(await handler.handleCmsisCommand({ action: 'install_pack', pack: 'Acme::Free@1.2.3' }));
            assert.strictEqual(result.text, `Acme::Free@1.2.3 installed in ${path.join(root, 'Acme', 'Free', '1.2.3')}.`);
            assert.strictEqual(errorDetail(await refusalOf(handler.handleCmsisCommand({ action: 'install_pack' }), 'INVALID_ARGUMENT')),
                `CMSIS 'install_pack' not attempted: no pack given.\n${USAGE}`);
            assert.deepStrictEqual(installer.installs, ['Acme::Free@1.2.3']);
        });
    });
});
