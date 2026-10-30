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

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CatalogQuery, PackInstalled, queryCatalog, WebOrigins } from '../core/catalogQuery';
import { packInstalledIn } from '../core/packInstall';
import {
    acquireSolutionApi,
    ApiBoard,
    ApiBoardFilter,
    ApiBoardId,
    ApiCreateOptions,
    ApiDevice,
    ApiDeviceId,
    ApiDraft,
    ApiPackId,
    catalogErrorsOf,
    Clock,
    matcherOf,
    SolutionApiV2,
    SolutionExtensionHandle,
} from '../core/solutionApi';
import { ErrorCode, JsonObject, ToolError, ToolReply, ToolText, errorDetail, isToolReply } from '../core/toolResult';
import { CatalogBoardId, packOfOriginUrl, WEB_CATALOG_URL, webExampleOrigins } from '../core/webCatalog';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import { DebuggingHandler } from '../debuggingHandler';
import { createSolution, CreateRequest, SolutionActivator } from '../handler/createSolution';
import { HandlerHost, VSCODE_HOST } from '../handler/host';
import type { IDebugConfigurationManager } from '../utils/debugConfigurationManager';
import { ManualClock } from './cmsisTaskFixtures';

/**
 * `cmsis_query` and `cmsis_action create_solution` against a stub of CMSIS
 * Solution's API version 2, shaped as the 1.72.0 bundle answers: boards and
 * devices whose devices, packs and cores are promises, drafts that say
 * whether they come from the web or an installed pack, a data manager that
 * keeps the failures of its last request, and a createNewSolution that
 * refuses a draft it does not list.
 */

const CLOCK: Clock = {
    now: () => Date.now(),
    startTimer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
    },
};
const soon = (ms = 5_000): number => Date.now() + ms;
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function pack(vendor: string, name: string, version?: string): ApiPackId {
    return { key: `${vendor.toLowerCase()}::${name.toLowerCase()}${version ? `@${version}` : ''}`, vendor, name, version };
}

function deviceId(key: string): ApiDeviceId {
    const [vendor, name] = key.split('::');
    return { key, vendor, name };
}

function board(vendor: string, name: string, devices: string[], bsp?: ApiPackId, packAnswer?: PromiseLike<ApiPackId | undefined>): ApiBoard {
    const id: ApiBoardId = { key: `${vendor}::${name}`, vendor, name };
    return { id, vendor, name, devices: Promise.resolve(devices.map(deviceId)), pack: packAnswer ?? Promise.resolve(bsp) };
}

function device(key: string, family: string, cores: Array<[string, string]>, dfp?: ApiPackId, subfamily?: string): ApiDevice {
    const id = deviceId(key);
    return {
        id, vendor: id.vendor, name: id.name, family, subfamily,
        pack: Promise.resolve(dfp),
        processors: Promise.resolve(cores.map(([name, core]) => ({ name, core }))),
    };
}

function draft(key: string, name: string, draftType: string, draftSource: string, from?: ApiPackId, format = 'Csolution', description = ''): ApiDraft {
    return { id: { key, name }, name, description, format, draftType, draftSource, pack: from };
}

const BSP = pack('Keil', 'STM32H735G-DK_BSP', '1.1.0');
const H735 = board('STMicroelectronics', 'STM32H735G-DK', ['STMicroelectronics::STM32H735IGKx', 'STMicroelectronics::STM32H735IGTx'], BSP);
const NUCLEO = board('STMicroelectronics', 'NUCLEO-H753ZI', ['STMicroelectronics::STM32H753ZITx']);
const DISCO = board('STMicroelectronics', 'STM32H747I-DISCO', ['STMicroelectronics::STM32H747XIHx']);
const FRDM = board('NXP', 'FRDM-MCXN947', ['NXP::MCXN947VDF']);
/** The BBC micro:bit V2 as its pack names it, and as a vendor might name a board by its display name. */
const MICROBIT = board('MicroBit', 'microbit-v2', ['NordicSemiconductor::nRF52833_xxAA'], pack('MicroBit', 'MicroBit_V2_BSP', '0.1.1'));
const MICROBIT_DISPLAY = board('BBC', 'BBC micro:bit V2', ['NordicSemiconductor::nRF52833_xxAA']);
const WEB_BLINKY = draft('blinky-stm32h735g-dk', 'Blinky', 'Example', 'Web', undefined, 'Csolution', 'Blinks the LEDs of the board');
const CUBEMX = draft('keil::stm32h735g-dk_bsp@1.1.0:cubemx', 'CubeMX', 'Template', 'Local', BSP);
const UV_BLINKY = draft('keil::stm32h735g-dk_bsp@1.1.0:blinky', 'Blinky', 'Example', 'Local', BSP, 'uVision');

/** CMSIS Solution's API version 2, scripted. */
class StubApi implements SolutionApiV2 {
    /** As CsolutionApiV2Impl has it: the data manager, whose `errors` are those of its last request. */
    dataManager: { errors: string[] } | undefined = { errors: [] };
    readonly filters: Array<ApiBoardFilter | undefined> = [];
    readonly created: ApiCreateOptions[] = [];
    readonly drafts = new Map<string, ApiDraft[]>();
    boardsAnswer: (() => Promise<ApiBoard[]>) | undefined;
    createAnswer: (() => Promise<void>) | undefined;

    constructor(readonly boards: ApiBoard[] = [], readonly devices: ApiDevice[] = []) {}

    static draftKey(board?: ApiBoardId, device?: ApiDeviceId): string {
        return `${board?.key ?? ''}|${device?.key ?? ''}`;
    }

    async getBoards(filter?: ApiBoardFilter): Promise<ApiBoard[]> {
        this.filters.push(filter);
        if (this.boardsAnswer) {
            return this.boardsAnswer();
        }
        if (!filter?.mountedDevice) {
            return [...this.boards];
        }
        // As the API does: a mountedDevice filter drops the boards without a device.
        const withDevices = await Promise.all(this.boards.map(async (entry) => (await entry.devices).length > 0));
        return this.boards.filter((_, index) => withDevices[index]);
    }

    async getDevices(): Promise<ApiDevice[]> {
        return [...this.devices];
    }

    async getDraftProjects(board?: ApiBoardId, device?: ApiDeviceId): Promise<ApiDraft[]> {
        return [...(this.drafts.get(StubApi.draftKey(board, device)) ?? [])];
    }

    async createNewSolution(options: ApiCreateOptions): Promise<void> {
        if (this.createAnswer) {
            return this.createAnswer();
        }
        const listed = this.drafts.get(StubApi.draftKey(options.board?.id, options.device?.id)) ?? [];
        if (!listed.some((entry) => entry.id.key === options.draft.id.key)) {
            throw new Error(`Draft project not found: ${options.draft.id.key}`);
        }
        this.created.push(options);
        fs.mkdirSync(options.folder, { recursive: true });
        fs.writeFileSync(path.join(options.folder, `${options.draft.name}.csolution.yml`), 'solution:\n');
    }
}

/** The extension as `getExtension` describes it, active, with `getApi(2)` answering `api`. */
function installed(api: unknown, options: { active?: boolean; getApi?: (version: number) => unknown } = {}): SolutionExtensionHandle & { activations: number; asked: number } {
    const handle = {
        isActive: options.active ?? true,
        activations: 0,
        asked: 0,
        version: '1.72.0',
        exports: {
            getApi: (version: number): unknown => {
                handle.asked++;
                if (options.getApi) {
                    return options.getApi(version);
                }
                if (version !== 2) {
                    throw new Error(`No API version ${version} found`);
                }
                return api;
            },
        },
        activate: async (): Promise<unknown> => {
            handle.activations++;
            handle.isActive = true;
            return handle.exports;
        },
    };
    return handle;
}

async function query(api: SolutionApiV2, args: CatalogQuery, deadline = soon(), web?: WebOrigins, installed?: PackInstalled): Promise<ToolReply> {
    return queryCatalog(api, args, CLOCK, deadline, web, installed);
}

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

function catalogApi(): StubApi {
    const api = new StubApi([H735, NUCLEO, DISCO, FRDM], [
        device('NXP::MCXN947VDF', 'MCX', [['cm33_core0', 'Cortex-M33'], ['cm33_core1', 'Cortex-M33']], pack('NXP', 'MCXN947_DFP', '19.0.0'), 'MCX N94x'),
        device('STMicroelectronics::STM32H735IGKx', 'STM32H7', [['', 'Cortex-M7']], pack('Keil', 'STM32H7xx_DFP', '4.1.1')),
    ]);
    api.drafts.set(StubApi.draftKey(H735.id), [WEB_BLINKY, CUBEMX, UV_BLINKY]);
    return api;
}

suite('CMSIS Solution catalog: cmsis_query and create_solution', () => {

    suite('cmsis_query', () => {

        test('boards: case-insensitive filters, sorted by id, capped with the rest counted, each with its device and pack', async () => {
            const api = catalogApi();
            const reply = await query(api, { what: 'boards', vendor: 'stmicro', name: 'h7', limit: 2 });
            assert.strictEqual(reply.text, [
                'Boards matching vendor \'stmicro\', name \'h7\': 3, the first 2 listed.',
                '- STMicroelectronics::NUCLEO-H753ZI — device STMicroelectronics::STM32H753ZITx',
                '- STMicroelectronics::STM32H735G-DK — device STMicroelectronics::STM32H735IGKx (+1 more), pack Keil::STM32H735G-DK_BSP@1.1.0',
                '1 more not listed: narrow the filters, or raise limit (at most 100).',
                'Next: cmsis_query {what:\'examples\', board:\'<id>\'} lists the examples and templates of a board.',
            ].join('\n'));
            assert.strictEqual(reply.status, 'ok');
            const data = reply.data as JsonObject;
            assert.deepStrictEqual([data.what, data.total, data.listed, data.omitted], ['boards', 3, 2, 1]);
            assert.deepStrictEqual((data.entries as JsonObject[])[1], {
                id: 'STMicroelectronics::STM32H735G-DK', vendor: 'STMicroelectronics', name: 'STM32H735G-DK',
                devices: ['STMicroelectronics::STM32H735IGKx', 'STMicroelectronics::STM32H735IGTx'], pack: 'Keil::STM32H735G-DK_BSP@1.1.0',
            });
            assert.deepStrictEqual(api.filters, [undefined], 'the filters are applied here, not by the API');
        });

        test('boards by a device on them: the API fetches the boards with their devices; the match ignores case and the vendor', async () => {
            const api = catalogApi();
            const reply = await query(api, { what: 'boards', device: '^stm32h735igk' });
            assert.deepStrictEqual(api.filters, [{ mountedDevice: {} }]);
            assert.deepStrictEqual(((reply.data as JsonObject).entries as JsonObject[]).map((entry) => entry.id), ['STMicroelectronics::STM32H735G-DK']);
            assert.ok(reply.text.startsWith('Boards matching device \'^stm32h735igk\': 1.\n'), reply.text);
        });

        test('a name as the user spells it finds the board: against the name and the id, separators ignored', async () => {
            const api = new StubApi([MICROBIT, MICROBIT_DISPLAY, FRDM]);
            const idsFor = async (name: string): Promise<string[]> =>
                (((await query(api, { what: 'boards', name })).data as JsonObject).entries as JsonObject[]).map((entry) => entry.id as string);
            for (const spelling of ['micro:bit', 'microbit', 'Micro Bit', 'MICRO-BIT', 'micro:bit v2']) {
                assert.deepStrictEqual(await idsFor(spelling), ['BBC::BBC micro:bit V2', 'MicroBit::microbit-v2'], spelling);
            }
            // The id matches too, and a regex keeps its meaning: anchored, it is the id prefix; as text, `MicroBit::`
            // is the word microbit, which both boards carry.
            assert.deepStrictEqual(await idsFor('^MicroBit::'), ['MicroBit::microbit-v2']);
            assert.deepStrictEqual(await idsFor('MicroBit::'), ['BBC::BBC micro:bit V2', 'MicroBit::microbit-v2']);
            assert.deepStrictEqual(await idsFor('^BBC'), ['BBC::BBC micro:bit V2']);
            assert.deepStrictEqual(await idsFor('frdm'), ['NXP::FRDM-MCXN947']);
            assert.deepStrictEqual(await idsFor('nucleo'), []);
            const reply = await query(api, { what: 'boards', name: 'micro:bit' });
            assert.ok(reply.text.startsWith("Boards matching name 'micro:bit': 2.\n"), reply.text);
        });

        test('a pattern that is no regular expression is taken as text', () => {
            const brackets = matcherOf('H7[35');
            assert.ok(brackets !== undefined && brackets('stm32h7[35x') && !brackets('STM32H735'));
            assert.strictEqual(matcherOf('  '), undefined);
            const colon = matcherOf('micro:bit');
            assert.ok(colon !== undefined && colon('microbit-v2') && colon('BBC micro:bit V2') && !colon('microbot'));
        });

        test('devices: family, the cores with their processor names when there are several, and the pack', async () => {
            const reply = await query(catalogApi(), { what: 'devices', name: 'MCXN|h735' });
            assert.strictEqual(reply.text, [
                'Devices matching name \'MCXN|h735\': 2.',
                '- NXP::MCXN947VDF — family MCX / MCX N94x, Cortex-M33 (cm33_core0), Cortex-M33 (cm33_core1), pack NXP::MCXN947_DFP@19.0.0',
                '- STMicroelectronics::STM32H735IGKx — family STM32H7, Cortex-M7, pack Keil::STM32H7xx_DFP@4.1.1',
                'Next: cmsis_query {what:\'boards\', device:\'<name>\'} finds the boards that carry a device; '
                    + '{what:\'examples\', device:\'<id>\'} lists the templates of its installed packs.',
            ].join('\n'));
        });

        test('devices by device and boards by board: the argument the other kinds take is a name pattern here, never ignored', async () => {
            // A tester's call: {what:'devices', device:'XMC4700'} listed all 13 605 devices of the catalog.
            const devices = await query(catalogApi(), { what: 'devices', device: 'h735' });
            assert.deepStrictEqual(((devices.data as JsonObject).entries as JsonObject[]).map((entry) => entry.id), ['STMicroelectronics::STM32H735IGKx']);
            assert.ok(devices.text.startsWith('Devices matching device \'h735\': 1.\n'), devices.text);
            // With name as well, both must match.
            const both = await query(catalogApi(), { what: 'devices', name: 'MCXN|h735', device: '^NXP::' });
            assert.deepStrictEqual(((both.data as JsonObject).entries as JsonObject[]).map((entry) => entry.id), ['NXP::MCXN947VDF']);
            assert.ok(both.text.startsWith('Devices matching name \'MCXN|h735\', device \'^NXP::\': 1.\n'), both.text);
            assert.strictEqual((await query(catalogApi(), { what: 'devices', device: 'XMC4700' })).text, 'Devices matching device \'XMC4700\': none.');

            const api = catalogApi();
            const boards = await query(api, { what: 'boards', board: 'nucleo' });
            assert.deepStrictEqual(((boards.data as JsonObject).entries as JsonObject[]).map((entry) => entry.id), ['STMicroelectronics::NUCLEO-H753ZI']);
            assert.ok(boards.text.startsWith('Boards matching board \'nucleo\': 1.\n'), boards.text);
            assert.deepStrictEqual(api.filters, [undefined], 'a board pattern needs no devices from the API');
        });

        test('the examples of a board: each says where it comes from, in the API\'s order, with the call that creates one', async () => {
            const reply = await query(catalogApi(), { what: 'examples', board: 'stmicroelectronics::stm32h735g-dk' });
            assert.strictEqual(reply.text, [
                'Examples and templates for board \'STMicroelectronics::STM32H735G-DK\': 3.',
                '- blinky-stm32h735g-dk — Blinky, Example, web: Blinks the LEDs of the board',
                '- keil::stm32h735g-dk_bsp@1.1.0:cubemx — CubeMX, Template, installed Keil::STM32H735G-DK_BSP@1.1.0',
                '- keil::stm32h735g-dk_bsp@1.1.0:blinky — Blinky, Example, installed Keil::STM32H735G-DK_BSP@1.1.0, µVision project, converted on creation',
                'Create a project from one: cmsis_action {action:\'create_solution\', board:\'STMicroelectronics::STM32H735G-DK\', draft:\'<id>\', '
                    + 'path:\'<new project folder>\'}.',
            ].join('\n'));
            const data = reply.data as JsonObject;
            assert.strictEqual(data.board, 'STMicroelectronics::STM32H735G-DK');
            assert.deepStrictEqual((data.entries as JsonObject[]).map((entry) => [entry.id, entry.type, entry.source]), [
                ['blinky-stm32h735g-dk', 'Example', 'web'],
                ['keil::stm32h735g-dk_bsp@1.1.0:cubemx', 'Template', 'installed'],
                ['keil::stm32h735g-dk_bsp@1.1.0:blinky', 'Example', 'installed'],
            ]);
        });

        test('a board whose pack is not installed says so, with the call that installs it; installed or unknown, nothing is said', async () => {
            const api = catalogApi();
            api.drafts.set(StubApi.draftKey(H735.id), [WEB_BLINKY]);
            const asked: ApiPackId[] = [];
            const notInstalled: PackInstalled = (wanted) => {
                asked.push(wanted);
                return false;
            };
            const missing = await query(api, { what: 'examples', board: 'STMicroelectronics::STM32H735G-DK' }, soon(), undefined, notInstalled);
            assert.ok(missing.text.endsWith('\nThe board\'s pack Keil::STM32H735G-DK_BSP@1.1.0 is not installed; its own examples appear after '
                + 'cmsis_action {action:\'install_pack\', pack:\'Keil::STM32H735G-DK_BSP@1.1.0\'}.\n'
                + 'Create a project from one: cmsis_action {action:\'create_solution\', board:\'STMicroelectronics::STM32H735G-DK\', draft:\'<id>\', '
                + 'path:\'<new project folder>\'}.'), missing.text);
            assert.strictEqual((missing.data as JsonObject).boardPackNotInstalled, 'Keil::STM32H735G-DK_BSP@1.1.0');
            assert.deepStrictEqual(asked, [BSP]);

            for (const answer of [true, undefined]) {
                const quiet = await query(api, { what: 'examples', board: 'STMicroelectronics::STM32H735G-DK' }, soon(), undefined, () => answer);
                assert.ok(!quiet.text.includes('is not installed'), quiet.text);
                assert.strictEqual((quiet.data as JsonObject).boardPackNotInstalled, undefined);
            }
            const failing = await query(api, { what: 'examples', board: 'STMicroelectronics::STM32H735G-DK' }, soon(), undefined, () => Promise.reject(new Error('no root')));
            assert.ok(!failing.text.includes('is not installed'), failing.text);

            // An example from an installed copy of the pack, of any version, shows that it is installed: nothing is asked.
            api.drafts.set(StubApi.draftKey(H735.id), [WEB_BLINKY, draft('keil::stm32h735g-dk_bsp@1.0.0:cubemx', 'CubeMX', 'Template', 'Local',
                pack('Keil', 'STM32H735G-DK_BSP', '1.0.0'))]);
            asked.length = 0;
            const listed = await query(api, { what: 'examples', board: 'STMicroelectronics::STM32H735G-DK' }, soon(), undefined, notInstalled);
            assert.ok(!listed.text.includes('is not installed'), listed.text);
            assert.deepStrictEqual(asked, []);

            // A board without a pack, and a device without a board, are not asked about.
            api.drafts.set(StubApi.draftKey(NUCLEO.id), []);
            const packless = await query(api, { what: 'examples', board: 'STMicroelectronics::NUCLEO-H753ZI' }, soon(), undefined, notInstalled);
            assert.ok(!packless.text.includes('is not installed'), packless.text);
            const mcxn = api.devices[0];
            api.drafts.set(StubApi.draftKey(undefined, mcxn.id), []);
            const byDevice = await query(api, { what: 'examples', device: 'MCXN947VDF' }, soon(), undefined, notInstalled);
            assert.ok(!byDevice.text.includes('is not installed'), byDevice.text);
            assert.deepStrictEqual(asked, []);
        });

        test('a pack counts as installed when a version folder under the pack root holds its PDSC', () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-packroot-'));
            try {
                assert.strictEqual(packInstalledIn(root, 'Infineon', 'XMC4000_DFP'), false);
                fs.mkdirSync(path.join(root, 'Infineon', 'XMC4000_DFP', '2.14.0'), { recursive: true });
                assert.strictEqual(packInstalledIn(root, 'Infineon', 'XMC4000_DFP'), false, 'an empty version folder is a failed install');
                fs.writeFileSync(path.join(root, 'Infineon', 'XMC4000_DFP', '2.14.0', 'Infineon.XMC4000_DFP.pdsc'), '<package/>');
                assert.strictEqual(packInstalledIn(root, 'Infineon', 'XMC4000_DFP'), true);
                assert.strictEqual(packInstalledIn(path.join(root, 'missing'), 'Infineon', 'XMC4000_DFP'), undefined, 'no pack root, no answer');
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        test('web examples alike are told apart by the pack each comes from, which only Arm\'s web catalog knows', async () => {
            // The tester's XMC4700 Relax Kit: each demo twice, one per Oryx-Embedded Middleware release, same name and description.
            const relax: ApiBoard = { ...board('Infineon', 'XMC4700 Relax Kit', ['Infineon::XMC4700-F144x2048']), revision: 'V1' };
            const demo = (id: string, name: string, what: string): ApiDraft => draft(id, name, 'Example', 'Web', undefined, 'uVision', `${what} demo (CycloneTCP and CMSIS-RTOS)`);
            const api = new StubApi([relax]);
            api.drafts.set(StubApi.draftKey(relax.id), [
                demo('1f407c32', 'mqtt_client_demo', 'MQTT Client'), demo('a30928ba', 'mqtt_client_demo', 'MQTT Client'),
                demo('815ef6e6', 'snmp_agent_demo', 'SNMP Agent'), demo('5780de87', 'snmp_agent_demo', 'SNMP Agent'),
                demo('83d5f7cd', 'RTX_Blinky', 'RTX Blinky'),
            ]);
            const asked: Array<[CatalogBoardId, number]> = [];
            const origins = new Map([['1f407c32', 'Oryx-Embedded::Middleware@2.6.6'], ['a30928ba', 'Oryx-Embedded::Middleware@2.4.4'],
                ['815ef6e6', 'Oryx-Embedded::Middleware@2.6.6'], ['5780de87', 'Oryx-Embedded::Middleware@2.4.4'], ['83d5f7cd', 'Infineon::XMC4000_DFP@2.14.0']]);
            const web: WebOrigins = async (target, ms) => {
                asked.push([target, ms]);
                return origins;
            };
            const reply = await query(api, { what: 'examples', board: 'Infineon::XMC4700 Relax Kit' }, soon(), web);
            assert.strictEqual(reply.text, [
                'Examples and templates for board \'Infineon::XMC4700 Relax Kit\': 5.',
                '- 1f407c32 — mqtt_client_demo, Example, web from Oryx-Embedded::Middleware@2.6.6, µVision project, converted on creation: MQTT Client demo (CycloneTCP and CMSIS-RTOS)',
                '- a30928ba — mqtt_client_demo, Example, web from Oryx-Embedded::Middleware@2.4.4, µVision project, converted on creation: MQTT Client demo (CycloneTCP and CMSIS-RTOS)',
                '- 815ef6e6 — snmp_agent_demo, Example, web from Oryx-Embedded::Middleware@2.6.6, µVision project, converted on creation: SNMP Agent demo (CycloneTCP and CMSIS-RTOS)',
                '- 5780de87 — snmp_agent_demo, Example, web from Oryx-Embedded::Middleware@2.4.4, µVision project, converted on creation: SNMP Agent demo (CycloneTCP and CMSIS-RTOS)',
                '- 83d5f7cd — RTX_Blinky, Example, web, µVision project, converted on creation: RTX Blinky demo (CycloneTCP and CMSIS-RTOS)',
                'Create a project from one: cmsis_action {action:\'create_solution\', board:\'Infineon::XMC4700 Relax Kit\', draft:\'<id>\', '
                    + 'path:\'<new project folder>\'}.',
            ].join('\n'));
            assert.deepStrictEqual(asked.map(([target]) => target), [{ vendor: 'Infineon', name: 'XMC4700 Relax Kit', revision: 'V1' }]);
            assert.ok(asked[0][1] > 0 && asked[0][1] <= 5_000, `at most 5 s, within the call: ${asked[0][1]}`);
            assert.deepStrictEqual(((reply.data as JsonObject).entries as JsonObject[]).map((entry) => entry.pack),
                ['Oryx-Embedded::Middleware@2.6.6', 'Oryx-Embedded::Middleware@2.4.4', 'Oryx-Embedded::Middleware@2.6.6', 'Oryx-Embedded::Middleware@2.4.4', undefined]);

            // Without twins nothing is asked; a catalog that does not answer leaves a note on the twins it could not tell apart.
            asked.length = 0;
            await query(api, { what: 'examples', board: 'Infineon::XMC4700 Relax Kit', name: 'snmp|Blinky', limit: 2 }, soon(), web);
            await query(api, { what: 'examples', board: 'Infineon::XMC4700 Relax Kit', name: 'Blinky' }, soon(), web);
            assert.strictEqual(asked.length, 1, 'only the listing with the two snmp_agent_demo asks');
            const silent = await query(api, { what: 'examples', board: 'Infineon::XMC4700 Relax Kit', name: 'snmp' }, soon(), async () => undefined);
            assert.match(silent.text, /\n- 815ef6e6 — snmp_agent_demo, Example, web, µVision project/);
            assert.match(silent.text, /\nsnmp_agent_demo: listed more than once by Arm's web catalog, one per pack release that ships the example; CMSIS Solution does not say which is which, and the web catalog did not tell within \d+(\.\d)? s\.\n/);
        });

        test('the web catalog lookup: the board by its CMSIS id, then the origin of its projects; any failure is nothing', async () => {
            assert.strictEqual(packOfOriginUrl('https://pack-content.cmsis.io/packs/Oryx-Embedded.Middleware.2.6.6.pack'), 'Oryx-Embedded::Middleware@2.6.6');
            assert.strictEqual(packOfOriginUrl('https://pack-content.cmsis.io/packs/Infineon.XMC4000_DFP.2.14.0-dev3.pack'), 'Infineon::XMC4000_DFP@2.14.0-dev3');
            assert.strictEqual(packOfOriginUrl('https://github.com/acme/examples'), undefined);
            assert.strictEqual(packOfOriginUrl(undefined), undefined);

            const sent: Array<{ url: string; variables: Record<string, unknown> }> = [];
            const answers: unknown[] = [
                { data: { search_boards: { results: [{ id: 'infineon-xmc4700-relax-kit-v1-14afca4', example_projects_count: 3 }] } } },
                { data: { search_projects: { results: [
                    { id: '815ef6e6', origin: { type: 'cmsis_pack', url: 'https://pack-content.cmsis.io/packs/Oryx-Embedded.Middleware.2.6.6.pack' } },
                    { id: '5780de87', origin: { type: 'cmsis_pack', url: 'https://pack-content.cmsis.io/packs/Oryx-Embedded.Middleware.2.4.4.pack' } },
                    { id: 'elsewhere', origin: { type: 'github', url: 'https://github.com/acme/examples' } },
                ] } } },
            ];
            const scripted = async (url: string, init: RequestInit): Promise<Response> => {
                sent.push({ url, variables: (JSON.parse(String(init.body)) as { variables: Record<string, unknown> }).variables });
                return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
            };
            const found = await webExampleOrigins(scripted, { vendor: 'Infineon', name: 'XMC4700 Relax Kit', revision: 'V1' }, 2_000, CLOCK);
            assert.deepStrictEqual(found, new Map([['815ef6e6', 'Oryx-Embedded::Middleware@2.6.6'], ['5780de87', 'Oryx-Embedded::Middleware@2.4.4']]));
            assert.deepStrictEqual(sent, [
                { url: WEB_CATALOG_URL, variables: { name: 'XMC4700 Relax Kit', vendor: 'Infineon', revision: 'V1' } },
                { url: WEB_CATALOG_URL, variables: { boardId: 'infineon-xmc4700-relax-kit-v1-14afca4', offset: 0, limit: 1000 } },
            ]);

            const failing = async (): Promise<Response> => new Response('busy', { status: 503 });
            assert.strictEqual(await webExampleOrigins(failing, { vendor: 'Infineon', name: 'XMC4700 Relax Kit' }, 2_000, CLOCK), undefined);
            const unreachable = async (): Promise<Response> => {
                throw new TypeError('fetch failed');
            };
            assert.strictEqual(await webExampleOrigins(unreachable, { vendor: 'Infineon', name: 'XMC4700 Relax Kit' }, 2_000, CLOCK), undefined);
            let signal: AbortSignal | undefined;
            const hanging = async (_url: string, init: RequestInit): Promise<Response> => {
                signal = init.signal ?? undefined;
                return never<Response>();
            };
            assert.strictEqual(await webExampleOrigins(hanging, { vendor: 'Infineon', name: 'XMC4700 Relax Kit' }, 30, CLOCK), undefined);
            assert.strictEqual(signal?.aborted, true, 'the request still open at the deadline is aborted');
        });

        test('Arm\'s web catalog unreachable is said so, in the text and in the data', async () => {
            const api = catalogApi();
            api.drafts.set(StubApi.draftKey(H735.id), [CUBEMX]);
            api.dataManager = { errors: ['Web service could not be reached'] };
            const reply = await query(api, { what: 'examples', board: 'STM32H735G-DK' });
            assert.match(reply.text, /\nArm's web catalog could not be reached \("Web service could not be reached"\): only the installed packs answered\.\n/);
            assert.doesNotMatch(reply.text, /None came from/);
            assert.strictEqual((reply.data as JsonObject).webUnreachable, true);
            assert.deepStrictEqual((reply.data as JsonObject).errors, ['Web service could not be reached']);

            api.dataManager = { errors: ['Web service could not be reached', 'csolution rpc exited with code 1'] };
            const boards = await query(api, { what: 'boards', name: 'h735' });
            assert.match(boards.text, /\nArm's web catalog could not be reached .*\nCMSIS Solution also reported: csolution rpc exited with code 1\n/);
        });

        test('without a word from CMSIS Solution, examples that came from no web source are said to be unexplained', async () => {
            const api = catalogApi();
            api.drafts.set(StubApi.draftKey(H735.id), [CUBEMX]);
            api.dataManager = undefined;
            assert.strictEqual(catalogErrorsOf(api), undefined);
            const unknown = await query(api, { what: 'examples', board: 'STMicroelectronics::STM32H735G-DK' });
            assert.match(unknown.text, /\nNone came from Arm's web catalog: the board has no examples there, the catalog is switched off \(setting cmsis-csolution\.useWebServices\), or it could not be reached; CMSIS Solution does not say which\.\n/);
            assert.strictEqual((unknown.data as JsonObject).webUnreachable, undefined);

            api.dataManager = { errors: [] };
            const quiet = await query(api, { what: 'examples', board: 'STMicroelectronics::STM32H735G-DK' });
            assert.match(quiet.text, /\nNone came from Arm's web catalog: the board has no examples there, or the catalog is switched off/);
        });

        test('examples of a device alone come from the installed packs, and that is said', async () => {
            const api = catalogApi();
            const mcxn = api.devices[0];
            api.drafts.set(StubApi.draftKey(undefined, mcxn.id), [draft('nxp::mcxn947_dfp@19.0.0:blank', 'Blank', 'Template', 'Local', pack('NXP', 'MCXN947_DFP', '19.0.0'))]);
            const reply = await query(api, { what: 'examples', device: 'MCXN947VDF' });
            assert.match(reply.text, /^Examples and templates for device 'NXP::MCXN947VDF': 1\.\n/);
            assert.match(reply.text, /\nWithout a board only the installed packs answer: Arm's web catalog lists examples per board\.\n/);
            assert.match(reply.text, /create_solution', device:'NXP::MCXN947VDF', draft:'<id>'/);
        });

        test('examples need a board or a device; a board that is not there is refused with ids that come close', async () => {
            const api = catalogApi();
            await refusalOf(query(api, { what: 'examples' }), 'INVALID_ARGUMENT');
            const missing = await refusalOf(query(api, { what: 'examples', board: 'STM32H735' }), 'INVALID_ARGUMENT');
            assert.strictEqual(errorDetail(missing), 'cmsis_query {what:\'examples\'} not attempted: no board \'STM32H735\' among the 4 CMSIS Solution knows. '
                + 'Ids that contain \'STM32H735\': STMicroelectronics::STM32H735G-DK.\n'
                + 'cmsis_query {what:\'boards\', name} lists boards with their ids.');
        });

        test('a list that fails is TASK_FAILED; one that does not answer in time is running, the catalog still loading', async () => {
            const api = catalogApi();
            api.boardsAnswer = () => Promise.reject(new Error('csolution rpc is not running'));
            const failed = await refusalOf(query(api, { what: 'boards' }), 'TASK_FAILED');
            assert.strictEqual(failed.message, 'cmsis_query: CMSIS Solution could not list the boards: csolution rpc is not running');
            api.boardsAnswer = () => never();
            const late = await query(api, { what: 'boards' }, soon(50));
            assert.strictEqual(late.status, 'running');
            assert.strictEqual(late.text, 'cmsis_query {what:\'boards\'}: the CMSIS Solution catalog is still loading (first request fetches Arm\'s web catalog); '
                + 'repeat the same cmsis_query call.');
            assert.deepStrictEqual(late.data, { what: 'boards', loading: true });
            // examples: the boards it needs first are as late.
            const examples = await query(api, { what: 'examples', board: 'STM32H735G-DK' }, soon(50));
            assert.deepStrictEqual([examples.status, examples.data], ['running', { what: 'examples', loading: true }]);
        });

        test('a pack that does not arrive in time is left out, and the entries without it are counted', async () => {
            const slow = board('Arm', 'V2M-MPS3-SSE-300-FVP', ['ARM::SSE-300-MPS3'], undefined, never());
            const reply = await query(new StubApi([slow]), { what: 'boards' }, soon(300));
            assert.match(reply.text, /^Boards: 1\.\n- Arm::V2M-MPS3-SSE-300-FVP — device ARM::SSE-300-MPS3\nThe device or pack of 1 entry did not arrive within 0\.\d s and is left out\.\n/);
        });

        test('no match is an answer, not a failure', async () => {
            const reply = await query(catalogApi(), { what: 'boards', vendor: 'Nordic' });
            assert.strictEqual(reply.text, 'Boards matching vendor \'Nordic\': none.');
            assert.deepStrictEqual(reply.data, { what: 'boards', total: 0, listed: 0, omitted: 0, entries: [] });
        });
    });

    suite('the API seam', () => {
        const WHAT = 'cmsis_query {what:\'boards\'}';

        test('the extension not installed is CMSIS_NO_SOLUTION, with the Keil Studio Pack to install', async () => {
            const refused = await refusalOf(acquireSolutionApi(undefined, WHAT, CLOCK), 'CMSIS_NO_SOLUTION');
            assert.strictEqual(refused.message, `${WHAT} not attempted: the CMSIS Solution extension (Arm.cmsis-csolution) is not installed in this VS Code, `
                + 'so there is no active solution.');
            assert.ok(refused.hint?.startsWith('Ask the user to install the Keil Studio Pack (Arm.keil-studio-pack)'), refused.hint);
        });

        test('an inactive extension is activated once, and getApi is asked once per extension', async () => {
            const api = catalogApi();
            const handle = installed(api, { active: false });
            assert.strictEqual(await acquireSolutionApi(handle, WHAT, CLOCK), api);
            assert.strictEqual(await acquireSolutionApi(handle, WHAT, CLOCK), api);
            assert.deepStrictEqual([handle.activations, handle.asked], [1, 1]);
        });

        test('an activation that fails is TASK_FAILED, one that does not end TIMEOUT', async () => {
            const failing = { ...installed(catalogApi(), { active: false }), activate: () => Promise.reject(new Error('cmsis-toolbox missing')) };
            const failed = await refusalOf(acquireSolutionApi(failing, WHAT, CLOCK), 'TASK_FAILED');
            assert.strictEqual(failed.message, `${WHAT} not attempted: the CMSIS Solution extension 1.72.0 failed to activate (cmsis-toolbox missing).`);
            const stuck = { ...installed(catalogApi(), { active: false }), activate: () => never<unknown>() };
            const late = await refusalOf(acquireSolutionApi(stuck, WHAT, CLOCK, 50), 'TIMEOUT');
            assert.match(late.message, /did not finish activating within 0\.\d s\.$/);
        });

        test('getApi missing, getApi throwing, and an API without a method are TOOL_DISABLED', async () => {
            const bare: SolutionExtensionHandle = { isActive: true, exports: {}, version: '1.40.0', activate: async () => ({}) };
            assert.strictEqual((await refusalOf(acquireSolutionApi(bare, WHAT, CLOCK), 'TOOL_DISABLED')).message,
                `${WHAT} not attempted: the CMSIS Solution extension 1.40.0 offers no public API (no getApi).`);
            const throwing = installed(undefined, { getApi: () => { throw new Error('No API version 2 found'); } });
            const refused = await refusalOf(acquireSolutionApi(throwing, WHAT, CLOCK), 'TOOL_DISABLED');
            assert.strictEqual(errorDetail(refused), `${WHAT} not attempted: the CMSIS Solution extension 1.72.0 offers no API version 2 (No API version 2 found).\n`
                + 'Ask the user to update the CMSIS Solution extension: its API version 2 came with release 1.46.0.');
            const partial = installed({ getBoards: () => Promise.resolve([]), getDevices: () => Promise.resolve([]), getDraftProjects: () => Promise.resolve([]) });
            assert.match((await refusalOf(acquireSolutionApi(partial, WHAT, CLOCK), 'TOOL_DISABLED')).message, /lacks createNewSolution\.$/);
        });
    });

    suite('create_solution', () => {
        let scratch: string;
        setup(() => {
            scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-create-')));
        });
        teardown(() => {
            fs.rmSync(scratch, { recursive: true, force: true });
        });

        const asFolder = (fsPath: string): vscode.WorkspaceFolder => ({ uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 });
        /** The real host with the window's folders and the extension replaced. */
        const hostWith = (folders: string[], handle: SolutionExtensionHandle | undefined): HandlerHost => ({
            ...VSCODE_HOST,
            workspaceFolders: () => folders.map(asFolder),
            solutionExtension: () => handle,
        });
        /** An activator that records its calls and answers as `open_solution` does for a solution the extension took. */
        const activator = (answer?: (file: string) => Promise<ToolText>): SolutionActivator & { calls: Array<[string, number]> } => {
            const calls: Array<[string, number]> = [];
            const activate = async (file: string, deadline: number): Promise<ToolText> => {
                calls.push([file, deadline]);
                return answer ? answer(file) : { text: 'ok', status: 'ok', data: { opened: path.dirname(file), newWindow: false, solution: file } };
            };
            return Object.assign(activate, { calls });
        };
        const create = (host: HandlerHost, request: CreateRequest, deadline = soon(), activate: SolutionActivator = activator()): Promise<ToolText> =>
            createSolution(host, request, deadline, activate);

        test('in the window that has the folder open: the board and draft are looked up by id, git stays off, the new csolution is activated', async () => {
            const api = catalogApi();
            const folder = path.join(scratch, 'h735-app');
            fs.mkdirSync(folder);
            const file = path.join(folder, 'CubeMX.csolution.yml');
            // The extension reports the path as it lists it (`Uri.fsPath`: on Windows the drive letter in lower case).
            const reported = vscode.Uri.file(file).fsPath;
            const deadline = soon();
            const activate = activator(async () => ({ text: 'ok', status: 'ok', data: { opened: folder, newWindow: false, solution: reported } }));
            const reply = await create(hostWith([folder], installed(api)),
                { path: folder, board: 'STMicroelectronics::STM32H735G-DK', draft: 'keil::stm32h735g-dk_bsp@1.1.0:cubemx', client: 'copilot' }, deadline, activate);
            assert.ok(isToolReply(reply) && reply.status === 'ok');
            assert.deepStrictEqual(activate.calls, [[file, deadline]], 'activated with the created csolution, within the call\'s deadline');
            assert.strictEqual(api.created.length, 1);
            const options = api.created[0];
            assert.strictEqual(options.board, H735, 'the API gets the board object it listed');
            assert.strictEqual(options.draft, CUBEMX);
            assert.strictEqual(options.device, undefined, 'the board\'s own device is CMSIS Solution\'s default');
            assert.deepStrictEqual([options.folder, options.git], [folder, false]);
            assert.strictEqual(reply.text, [
                `Created a solution in ${folder} from the template 'CubeMX' from the installed pack Keil::STM32H735G-DK_BSP@1.1.0 `
                    + 'for board STMicroelectronics::STM32H735G-DK. Solution: CubeMX.csolution.yml.',
                'CMSIS Solution set the board and device in the csolution\'s target type and added their packs.',
                'CMSIS Solution goes on by itself: it writes .vscode/cmsis.json and, when the project brings no vcpkg-configuration.json, '
                    + 'adds one through the Arm Tools Environment Manager (CMSIS-Toolbox, CMake, Ninja, Arm Compiler 6).',
                'Then it opens the folder in this window, which has it open already, so the window stays.',
                `Active solution: ${reported}. Next: cmsis_action build, which fetches the packs.`,
            ].join('\n'));
            assert.deepStrictEqual(reply.data, {
                created: folder, draft: 'keil::stm32h735g-dk_bsp@1.1.0:cubemx', reloads: false,
                board: 'STMicroelectronics::STM32H735G-DK', solution: file, activation: 'active', active: reported,
            });
        });

        test('an activation that fails keeps the folder a success and adds the failure with its hint; one that is pending says so', async () => {
            const api = catalogApi();
            const folder = path.join(scratch, 'h735-app');
            fs.mkdirSync(folder);
            const file = path.join(folder, 'CubeMX.csolution.yml');
            const request: CreateRequest = { path: folder, board: 'STMicroelectronics::STM32H735G-DK', draft: 'keil::stm32h735g-dk_bsp@1.1.0:cubemx' };
            const picker = 'If VS Code shows the CMSIS Solution extension\'s "Select a solution" picker, ask the user to pick the solution there.';
            const failing = activator(async () => {
                throw new ToolError('TASK_FAILED', `CMSIS 'open_solution' failed: the CMSIS Solution extension did not activate ${file} within 10 s.`, picker);
            });
            const failed = await create(hostWith([folder], installed(api)), request, soon(), failing);
            assert.ok(isToolReply(failed) && failed.status === 'ok', JSON.stringify(failed));
            assert.strictEqual(failing.calls.length, 1);
            assert.strictEqual(failed.text.split('\n').at(-1),
                `Activating ${file} failed: CMSIS 'open_solution' failed: the CMSIS Solution extension did not activate ${file} within 10 s. ${picker} `
                    + 'Next: once it is active, cmsis_action build, which fetches the packs.');
            assert.deepStrictEqual([failed.data?.activation, failed.data?.active, failed.data?.solution], ['failed', undefined, file]);

            fs.rmSync(folder, { recursive: true, force: true });
            fs.mkdirSync(folder);
            const pending = activator(async () => ({ text: 'asked', status: 'running', data: { opened: folder, newWindow: false, solution: file } }));
            const later = await create(hostWith([folder], installed(api)), request, soon(), pending);
            assert.ok(isToolReply(later) && later.status === 'ok');
            assert.strictEqual(later.text.split('\n').at(-1),
                `CMSIS Solution was asked to activate ${file} but does not report it as active yet. `
                    + `Next: get_session_status until it is active (if it stays inactive, cmsis_action {action:'open_solution', path:'${file}'} activates it), `
                    + 'then cmsis_action build, which fetches the packs.');
            assert.strictEqual(later.data?.activation, 'pending');

            fs.rmSync(folder, { recursive: true, force: true });
            fs.mkdirSync(folder);
            const unasked = activator();
            const late = await create(hostWith([folder], installed(api)), request, soon(1_000), unasked);
            assert.ok(isToolReply(late) && late.status === 'ok');
            assert.strictEqual(unasked.calls.length, 0, 'with less than 3 s left the activation is not started');
            assert.strictEqual(late.text.split('\n').at(-1),
                `Not activated: the call has no time left to activate it. Next: cmsis_action {action:'open_solution', path:'${file}'} activates it, `
                    + 'then cmsis_action build, which fetches the packs.');
            assert.strictEqual(late.data?.activation, 'skipped');
        });

        test('an unknown draft id is refused with the ids there are, and nothing is created', async () => {
            const api = catalogApi();
            const folder = path.join(scratch, 'app');
            const refused = await refusalOf(create(hostWith([folder], installed(api)),
                { path: folder, board: 'STMicroelectronics::STM32H735G-DK', draft: 'hello-world' }), 'INVALID_ARGUMENT');
            assert.strictEqual(errorDetail(refused), 'CMSIS \'create_solution\' not attempted: \'hello-world\' is none of the 3 examples and templates '
                + 'for board STMicroelectronics::STM32H735G-DK: blinky-stm32h735g-dk, keil::stm32h735g-dk_bsp@1.1.0:cubemx, keil::stm32h735g-dk_bsp@1.1.0:blinky.\n'
                + 'cmsis_query {what:\'examples\', board:\'STMicroelectronics::STM32H735G-DK\'} lists them with their ids.');
            assert.strictEqual(api.created.length, 0);
            assert.strictEqual(fs.existsSync(folder), false);

            const twice = await refusalOf(create(hostWith([folder], installed(api)),
                { path: folder, board: 'STMicroelectronics::STM32H735G-DK', draft: 'blinky' }), 'INVALID_ARGUMENT');
            assert.match(twice.message, /'blinky' names 2 examples and templates for board STMicroelectronics::STM32H735G-DK: blinky-stm32h735g-dk, keil::/);
        });

        test('a window with another folder open is refused before CMSIS Solution is asked, since the folder would close', async () => {
            const handle = installed(catalogApi(), { active: false });
            const other = path.join(scratch, 'other');
            // The window's folder as VS Code reports it: on Windows with a lower-case drive letter.
            const shown = vscode.Uri.file(other).fsPath;
            const folder = path.join(scratch, 'app');
            const refused = await refusalOf(create(hostWith([other], handle),
                { path: folder, board: 'STM32H735G-DK', draft: 'blinky-stm32h735g-dk', client: 'claude-code' }), 'INVALID_ARGUMENT');
            assert.strictEqual(errorDetail(refused), `CMSIS 'create_solution' not attempted: CMSIS Solution opens the new project in the window that creates it, `
                + `and this window has ${shown} open, which it would close.\n`
                + `Give the project a window of its own first: create the folder, open it with cmsis_action {action:'open_solution', path:'${folder}'} `
                + '(a new window, which this session follows), then repeat this call: it runs in that window.');
            assert.strictEqual(handle.activations, 0);

            const nested = path.join(other, 'app');
            const inside = await refusalOf(create(hostWith([other], handle), { path: nested, board: 'STM32H735G-DK', draft: 'x' }), 'INVALID_ARGUMENT');
            assert.match(inside.hint ?? '', new RegExp(`It lies inside ${shown.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}, so open_solution would use this window`));
        });

        test('a window without a folder: refused for a chat inside the window, created for a client that survives the reload', async () => {
            const api = catalogApi();
            const folder = path.join(scratch, 'app');
            const request: CreateRequest = { path: folder, board: 'STMicroelectronics::STM32H735G-DK', draft: 'blinky-stm32h735g-dk', git: true };
            const chat = await refusalOf(create(hostWith([], installed(api)), { ...request, client: 'GitHub Copilot Chat' }), 'NO_WORKSPACE');
            assert.match(chat.message, /this window, which has no folder, that is a reload, which ends a chat that runs inside it\.$/);
            assert.strictEqual(api.created.length, 0);

            const activate = activator();
            const reply = await create(hostWith([], installed(api)), { ...request, client: 'claude-code' }, soon(), activate);
            assert.ok(isToolReply(reply));
            assert.strictEqual(api.created[0].git, true);
            assert.strictEqual(reply.data?.reloads, true);
            assert.deepStrictEqual([activate.calls.length, reply.data?.activation], [0, undefined], 'the window reloads: nothing to activate here');
            assert.match(reply.text, /^Created a solution in .* from the example 'Blinky' from Arm's web catalog for board STMicroelectronics::STM32H735G-DK\. /);
            assert.match(reply.text, /\nCMSIS Solution goes on by itself: it runs git init, writes \.vscode\/cmsis\.json/);
            assert.match(reply.text, /\nThen it opens the folder in this window without asking: VS Code reloads the window, and the MCP server with it when it runs here\. /);
            assert.match(reply.text, new RegExp(`\\nNext: when no window has the folder open by then, cmsis_action \\{action:'open_solution', path:'${folder.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}'\\} opens it`));
        });

        test('the path is checked first: missing, relative, a file, or a folder that has a csolution already', async () => {
            const host = hostWith([], installed(catalogApi()));
            const base = { board: 'STM32H735G-DK', draft: 'blinky-stm32h735g-dk', client: 'claude-code' };
            assert.match((await refusalOf(create(host, base), 'INVALID_ARGUMENT')).message, /not attempted: no path given\.$/);
            assert.match((await refusalOf(create(host, { ...base, path: 'app' }), 'INVALID_ARGUMENT')).message, /'app' is not an absolute path\.$/);
            const file = path.join(scratch, 'notes.txt');
            fs.writeFileSync(file, '');
            assert.match((await refusalOf(create(host, { ...base, path: file }), 'INVALID_ARGUMENT')).message, /is a file, not a folder\.$/);
            fs.writeFileSync(path.join(scratch, 'Old.csolution.yml'), '');
            const taken = await refusalOf(create(host, { ...base, path: scratch }), 'INVALID_ARGUMENT');
            assert.strictEqual(errorDetail(taken), `CMSIS 'create_solution' not attempted: ${scratch} already holds Old.csolution.yml.\n`
                + `Open it instead: cmsis_action {action:'open_solution', path:'${path.join(scratch, 'Old.csolution.yml')}'}; or pass an empty or new folder.`);
            assert.match((await refusalOf(create(host, { path: path.join(scratch, 'new'), draft: 'x' }), 'INVALID_ARGUMENT')).message, /no board or device given\.$/);
        });

        test('a creation that outlasts the wait is running; one that CMSIS Solution refuses is TASK_FAILED with its message', async () => {
            const api = catalogApi();
            const folder = path.join(scratch, 'app');
            const host = hostWith([folder], installed(api));
            const request: CreateRequest = { path: folder, board: 'STMicroelectronics::STM32H735G-DK', draft: 'blinky-stm32h735g-dk' };
            api.createAnswer = () => never();
            const slow = await create(host, request, soon(100));
            assert.ok(isToolReply(slow) && slow.status === 'running', JSON.stringify(slow));
            assert.match(slow.text, /^CMSIS Solution is still creating the solution in .* \(a web example downloads first\)\. /);

            api.createAnswer = () => Promise.reject(new Error('Selected solution directory  already contains Blinky.csolution.yml'));
            const failed = await refusalOf(create(host, request), 'TASK_FAILED');
            assert.strictEqual(errorDetail(failed), `CMSIS 'create_solution' failed: CMSIS Solution did not create the solution in ${folder}: `
                + 'Selected solution directory  already contains Blinky.csolution.yml\n'
                + 'The folder holds a csolution now: open it with cmsis_action {action:\'open_solution\', path}.');
        });
    });

    suite('through the debugging handler', () => {
        /** The handler with its host's CMSIS Solution extension and folders replaced; no executor is reached. */
        class CatalogHandler extends DebuggingHandler {
            constructor(private readonly replaced: Partial<HandlerHost>) {
                super({} as IDebuggingExecutor, {} as IDebugConfigurationManager, 5);
            }

            protected host(): HandlerHost {
                return { ...super.host(), ...this.replaced };
            }
        }

        test('cmsis_query answers a reply with data; without the extension (as in the test VS Code) it is refused', async () => {
            const answered = await new CatalogHandler({ solutionExtension: () => installed(catalogApi()) }).handleCmsisQuery({ what: 'boards', name: 'frdm' });
            assert.ok(isToolReply(answered) && answered.status === 'ok');
            assert.strictEqual(answered.text.split('\n')[1], '- NXP::FRDM-MCXN947 — device NXP::MCXN947VDF');
            const refused = await refusalOf(new CatalogHandler({}).handleCmsisQuery({ what: 'devices' }), 'CMSIS_NO_SOLUTION');
            assert.match(refused.message, /^cmsis_query \{what:'devices'\} not attempted: the CMSIS Solution extension \(Arm\.cmsis-csolution\) is not installed/);
        });

        /** Lets the body of a fenced call run up to its next timer: microtasks first, then one macrotask. */
        const settle = (): Promise<void> => new Promise<void>((wake) => setImmediate(wake));

        test('cmsis_query whose first list request outlasts its deadline answers running; the next call lists, on the same API object', async () => {
            const clock = new ManualClock(1_000_000);
            const api = catalogApi();
            let arrive: ((boards: ApiBoard[]) => void) | undefined;
            api.boardsAnswer = () => new Promise<ApiBoard[]>((resolve) => { arrive = resolve; });
            const handle = installed(api);
            const handler = new CatalogHandler({
                solutionExtension: () => handle, now: () => clock.now(), startTimer: (ms, fire) => clock.startTimer(ms, fire),
            });
            const first = handler.handleCmsisQuery({ what: 'boards' });
            await settle();
            clock.advance(clock.now() + 57_000);
            const reply = await first;
            assert.ok(isToolReply(reply), JSON.stringify(reply));
            assert.strictEqual(reply.status, 'running');
            assert.strictEqual(reply.text, 'cmsis_query {what:\'boards\'}: the CMSIS Solution catalog is still loading (first request fetches Arm\'s web catalog); '
                + 'repeat the same cmsis_query call.');
            assert.deepStrictEqual(reply.data, { what: 'boards', loading: true });
            assert.strictEqual(clock.pendingTimers(), 0, 'the fence is disarmed');

            // The catalog arrives; the repeat lists it without a new API object or activation.
            assert.ok(arrive !== undefined);
            arrive(api.boards);
            api.boardsAnswer = undefined;
            const second = await handler.handleCmsisQuery({ what: 'boards', name: 'frdm' });
            assert.ok(isToolReply(second) && second.status === 'ok', JSON.stringify(second));
            assert.strictEqual(second.text.split('\n')[1], '- NXP::FRDM-MCXN947 — device NXP::MCXN947VDF');
            assert.deepStrictEqual([handle.asked, handle.activations], [1, 0]);
        });

        test('the fence of cmsis_query, when it wins, answers running too, with the catalog as the cause', async () => {
            const clock = new ManualClock(1_000_000);
            const api = catalogApi();
            api.boardsAnswer = () => never();
            const handler = new CatalogHandler({
                solutionExtension: () => installed(api), now: () => clock.now(), startTimer: (ms, fire) => clock.startTimer(ms, fire),
            });
            const pending = handler.handleCmsisQuery({ what: 'boards' });
            await settle();
            // Both timers are due: the fence, armed first and settled synchronously, wins the race.
            clock.advance(clock.now() + 60_000);
            const reply = await pending;
            assert.ok(isToolReply(reply), JSON.stringify(reply));
            assert.strictEqual(reply.status, 'running');
            assert.strictEqual(reply.text, '\'cmsis_query\' did not complete within 60000 ms (handler-level cap). '
                + 'The CMSIS Solution catalog is still loading (first request fetches Arm\'s web catalog); repeat the same cmsis_query call.');
        });

        test('cmsis_action create_solution needs no active solution, passes its arguments through, and activates with open_solution\'s code', async () => {
            const api = catalogApi();
            const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-create-')));
            try {
                const handler = new CatalogHandler({ solutionExtension: () => installed(api), workspaceFolders: () => [asFolderOf(folder)] });
                const reply = await handler.handleCmsisCommand({
                    action: 'create_solution', path: folder, board: 'STMicroelectronics::STM32H735G-DK', draft: 'blinky-stm32h735g-dk', git: true,
                });
                assert.ok(isToolReply(reply) && reply.status === 'ok', JSON.stringify(reply));
                assert.deepStrictEqual([api.created.length, api.created[0].git, api.created[0].folder], [1, true, folder]);
                // The activation is open_solution's: in the test VS Code, without the CMSIS Solution extension, it refuses, and the reply says so.
                assert.strictEqual(reply.data?.activation, 'failed');
                assert.match(reply.text, /\nActivating .*Blinky\.csolution\.yml failed: CMSIS 'open_solution' not attempted: the CMSIS Solution extension \(Arm\.cmsis-csolution\) is not installed/);
            } finally {
                fs.rmSync(folder, { recursive: true, force: true });
            }
        });

        function asFolderOf(fsPath: string): vscode.WorkspaceFolder {
            return { uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 };
        }
    });
});
