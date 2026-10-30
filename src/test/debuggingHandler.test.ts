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
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { SerialPortMock } from 'serialport';
import { DebugState, formatBreakpointModifiers, StackFrame } from '../debugState';
import type { AdoptedBreakpoint, BreakpointBinding, DebugPortProbe, GdbLogpoint, GdbReply, IDebuggingExecutor, StartFocus } from '../debuggingExecutor';
import { DebuggingHandler, probeSchedule } from '../debuggingHandler';
import { PickerCancelled, type IDebugConfigurationManager } from '../utils/debugConfigurationManager';
import { REDACTION_NOTICE } from '../utils/secretRedaction';
import { FRAME_FOCUS_WAIT_MS, type StopWaitResult } from '../utils/sessionStateTracker';
import { HardwareTimeoutError } from '../utils/timeout';
import { activeCbuildRunFile, GET_CBUILD_RUN_FILE, type SolutionCommands } from '../utils/solutionQueries';
import { LOCKUP_NOTE, wedgeHint } from '../core/probeWedge';
import { renderResetOutcome, ResetOutcomeView } from '../core/resetAssist';
import { ErrorCode, ToolError, ToolText, errorDetail, isToolReply, textOf } from '../core/toolResult';
import { ProblemInput, ProblemJournal, problemJournal, problemJson } from '../core/problemJournal';
import { renderProblemsBlock, runJournaled } from '../core/problemFeed';
import type { HandlerHost, ToolEnvironment } from '../handler/host';
import { isAddressLiteral, sideEffectOf } from '../handler/targetText';
import type { GdbPortHolder } from '../core/gdbPortGuard';
import { GdbPortReservations } from '../core/gdbPortReservations';
import { CmsisJobTracker } from '../cmsisJobTracker';
import type { JobDiagnosis } from '../core/cmsisTasks';
import { runInCallContext } from '../core/callContext';
import { FakeExecution, FakeTasks, FixtureTask, ManualClock, workspaceTasks } from './cmsisTaskFixtures';
import { MockSerial, mockSerial } from './serialFixtures';

/**
 * The debugging handler against a scripted executor. The handler's host is
 * replaced where a case needs the focused frame, task events, workspace
 * folders or a faster clock; CMSIS Solution commands are registered as
 * stand-ins (the test host has no CMSIS Solution extension).
 */

type StatusShape = Awaited<ReturnType<IDebuggingExecutor['getSessionStatus']>>;
type ThreadShape = Awaited<ReturnType<IDebuggingExecutor['getThreads']>>[number];

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_SVD = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'test-device.svd');

const delay = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

function sampleState(): DebugState {
    const state = new DebugState();
    state.sessionActive = true;
    state.fileName = 'main.c';
    state.fileFullPath = '/w/main.c';
    state.currentLine = 42;
    state.frameName = 'main';
    return state;
}

function status(state: StatusShape['state'], extra: Partial<StatusShape> = {}): StatusShape {
    return {
        state, sessionName: 'Fake session', sessionType: 'gdbtarget', configurationName: 'Fake config',
        dapResponsive: state !== 'no-session', dapProbeMs: null, ...extra,
    };
}

/**
 * Records what the handler asks for and answers from its fields; a case
 * replaces any method it needs to behave differently.
 */
class ScriptedExecutor {
    /** Execution requests and waiter arming, in order. */
    readonly moves: string[] = [];
    /** Every call with its arguments. */
    readonly calls: unknown[][] = [];
    /** Answers for successive `armStopWaiter` calls. */
    readonly waiters: Array<StopWaitResult | Promise<StopWaitResult>> = [];
    /** Methods that throw instead of answering. */
    readonly failures: Record<string, Error> = {};
    session = true;
    stopped = true;
    sessionStatus: StatusShape = status('running');
    state: DebugState = sampleState();
    registers: Record<string, string> = { pc: '0x08000100', lr: '0x08000200' };
    breakpoints: vscode.Breakpoint[] = [];
    /** What the adapter reports for a breakpoint; by default verified where it was set. */
    binding: (bp: vscode.Breakpoint) => BreakpointBinding | undefined = (bp) => ({
        reported: true, verified: true, line: bp instanceof vscode.SourceBreakpoint ? bp.location.range.start.line + 1 : undefined, id: 7,
    });
    /** Whether the adapter answers `setBreakpoints` in time after a removal. */
    removalApplied: boolean | undefined = true;
    /** GDB's answers, by the first word of the command. */
    gdbReplies: Record<string, GdbReply> = {
        dprintf: { text: JSON.stringify({ bkpt: { number: '3', type: 'dprintf', addr: '0x080002f4', file: 'main.c', line: '12' } }), errored: false },
        condition: { text: '', errored: false },
        delete: { text: '', errored: false },
        list: { text: JSON.stringify({ BreakpointTable: { body: [{ number: '3', type: 'dprintf', times: '4' }] } }), errored: false },
    };
    logpoints: GdbLogpoint[] = [];
    restartOutcome: Awaited<ReturnType<IDebuggingExecutor['restart']>> = { via: 'workbench' };
    /** What the DHCSR read finds (#3): a halted core, not locked up. */
    debugPort: DebugPortProbe = { readable: true, dhcsr: 0x00030003 };
    /** The session `getActiveSession` returns; its `configuration.request` picks the reconnect hint, its `svdFile` the SVD. */
    activeSession: { name?: string; configuration: { request: string; svdFile?: string } } | undefined = { configuration: { request: 'launch' } };

    note(name: string, ...args: unknown[]): void {
        this.calls.push([name, ...args]);
    }

    argsOf(name: string): unknown[][] {
        return this.calls.filter((call) => call[0] === name).map((call) => call.slice(1));
    }

    private failIfScripted(name: string): void {
        const failure = this.failures[name];
        if (failure) {
            throw failure;
        }
    }

    private async execute(name: string, timeoutMs?: number): Promise<void> {
        this.moves.push(name);
        this.note(name, timeoutMs);
        this.failIfScripted(name);
    }

    hasDebugSession: IDebuggingExecutor['hasDebugSession'] = () => this.session;
    getActiveSession: IDebuggingExecutor['getActiveSession'] = () => this.activeSession as unknown as vscode.DebugSession | undefined;
    probeDebugPort: IDebuggingExecutor['probeDebugPort'] = async (ms) => {
        this.note('probeDebugPort', ms);
        return this.debugPort;
    };
    hasActiveSession: IDebuggingExecutor['hasActiveSession'] = async () => {
        this.note('hasActiveSession');
        return this.stopped;
    };
    getSessionStatus: IDebuggingExecutor['getSessionStatus'] = async () => {
        this.note('getSessionStatus');
        return this.sessionStatus;
    };
    getDiagnostics: IDebuggingExecutor['getDiagnostics'] = () =>
        ({ serverVersion: '9.8.7', liveSessionCount: 0, liveSessionNames: [], hasVscodeActiveSession: false });
    armStopWaiter: IDebuggingExecutor['armStopWaiter'] = (limitMs) => {
        this.moves.push('arm');
        this.note('armStopWaiter', limitMs);
        const next = this.waiters.shift();
        if (next === undefined) {
            throw new Error('no stop waiter scripted');
        }
        return Promise.resolve(next);
    };
    continue: IDebuggingExecutor['continue'] = (ms) => this.execute('continue', ms);
    stepOver: IDebuggingExecutor['stepOver'] = (ms) => this.execute('stepOver', ms);
    stepInto: IDebuggingExecutor['stepInto'] = (ms) => this.execute('stepInto', ms);
    stepOut: IDebuggingExecutor['stepOut'] = (ms) => this.execute('stepOut', ms);
    pause: IDebuggingExecutor['pause'] = (ms) => this.execute('pause', ms);
    getCurrentDebugState: IDebuggingExecutor['getCurrentDebugState'] = async (lines) => {
        this.note('getCurrentDebugState', lines);
        return this.state;
    };
    readCoreRegisters: IDebuggingExecutor['readCoreRegisters'] = async (ms, names) => {
        this.note('readCoreRegisters', ms, names);
        this.failIfScripted('readCoreRegisters');
        return this.registers;
    };
    startDebugging: IDebuggingExecutor['startDebugging'] = async (folder, config) => {
        this.note('startDebugging', folder, config);
        return true;
    };
    startDebuggingByName: IDebuggingExecutor['startDebuggingByName'] = async (folder, name) => {
        this.note('startDebuggingByName', folder, name);
        return true;
    };
    stopDebugging: IDebuggingExecutor['stopDebugging'] = async (...args) => {
        this.note('stopDebugging', ...args);
    };
    restart: IDebuggingExecutor['restart'] = async () => {
        this.moves.push('restart');
        this.note('restart');
        this.failIfScripted('restart');
        return this.restartOutcome;
    };
    waitForStop: IDebuggingExecutor['waitForStop'] = async (ms) => {
        this.note('waitForStop', ms);
        return { kind: 'timeout' };
    };
    /** What the focus wait after a stop answers, given its bound: by default VS Code has selected a frame. */
    frameSelected: (limitMs: number) => boolean | Promise<boolean> = () => true;
    watchFrameFocus: IDebuggingExecutor['watchFrameFocus'] = () => {
        this.note('watchFrameFocus');
        return {
            selected: async (limitMs) => {
                this.note('frameSelected', limitMs);
                return this.frameSelected(limitMs);
            },
        };
    };
    /** What the focus wait after a session came up answers, given its bound: by default VS Code has selected a frame. */
    startFocus: (limitMs: number) => StartFocus | Promise<StartFocus> = () => 'selected';
    watchStartFocus: IDebuggingExecutor['watchStartFocus'] = () => {
        this.note('watchStartFocus');
        return {
            settled: async (limitMs) => {
                this.note('startFocusSettled', limitMs);
                return this.startFocus(limitMs);
            },
        };
    };
    addBreakpoint: IDebuggingExecutor['addBreakpoint'] = async (uri, line, options) => {
        this.moves.push('addBreakpoint');
        // uri.path, not fsPath: forward slashes on every OS, so the expectations hold on Windows too.
        this.note('addBreakpoint', uri.path, line, options);
        this.failIfScripted('addBreakpoint');
        const added = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)), true,
            options?.condition, undefined, options?.logMessage);
        this.breakpoints = [...this.breakpoints, added];
        return added;
    };
    removeBreakpoint: IDebuggingExecutor['removeBreakpoint'] = async (uri, line, options) => {
        this.moves.push('removeBreakpoint');
        this.note('removeBreakpoint', uri.path, line, options);
        const matching = this.breakpoints.filter((bp) => bp instanceof vscode.SourceBreakpoint
            && bp.location.uri.toString() === uri.toString() && bp.location.range.start.line === line - 1
            && (!options?.logpointsOnly || Boolean(bp.logMessage)));
        this.breakpoints = this.breakpoints.filter((bp) => !matching.includes(bp));
        return matching.length > 0 ? { removed: matching.length, applied: this.session ? this.removalApplied : undefined } : { removed: 0 };
    };
    getBreakpoints: IDebuggingExecutor['getBreakpoints'] = () => this.breakpoints;
    /** The breakpoints VS Code adopted from the adapter: none by default. */
    adopted: AdoptedBreakpoint[] = [];
    adoptedBreakpoints: IDebuggingExecutor['adoptedBreakpoints'] = () => this.adopted.map((bp) => ({ ...bp }));
    clearAllBreakpoints: IDebuggingExecutor['clearAllBreakpoints'] = async () => {
        this.moves.push('clearAllBreakpoints');
        this.note('clearAllBreakpoints');
        const removed = this.breakpoints.length;
        this.breakpoints = [];
        return removed > 0 ? { removed, applied: this.session ? this.removalApplied : undefined } : { removed: 0 };
    };
    breakpointBinding: IDebuggingExecutor['breakpointBinding'] = async (bp, waitMs) => {
        this.note('breakpointBinding', waitMs);
        return this.session ? this.binding(bp) : undefined;
    };
    private gdb(name: string, key: string, ...args: unknown[]): GdbReply {
        this.moves.push(name);
        this.note(name, ...args);
        return this.gdbReplies[key];
    }
    insertDprintfViaGdb: IDebuggingExecutor['insertDprintfViaGdb'] = async (location, format, values) =>
        this.gdb('insertDprintfViaGdb', 'dprintf', location, format, values);
    setBreakpointConditionViaGdb: IDebuggingExecutor['setBreakpointConditionViaGdb'] = async (num, condition) =>
        this.gdb('setBreakpointConditionViaGdb', 'condition', num, condition);
    deleteBreakpointsViaGdb: IDebuggingExecutor['deleteBreakpointsViaGdb'] = async (numbers) =>
        this.gdb('deleteBreakpointsViaGdb', 'delete', numbers);
    listBreakpointsViaGdb: IDebuggingExecutor['listBreakpointsViaGdb'] = async () => this.gdb('listBreakpointsViaGdb', 'list');
    gdbLogpoints: IDebuggingExecutor['gdbLogpoints'] = () => this.logpoints.map((logpoint) => ({ ...logpoint }));
    rememberGdbLogpoint: IDebuggingExecutor['rememberGdbLogpoint'] = (logpoint) => {
        this.note('rememberGdbLogpoint', logpoint);
        this.logpoints = [...this.logpoints, logpoint];
    };
    forgetGdbLogpoints: IDebuggingExecutor['forgetGdbLogpoints'] = (numbers) => {
        this.note('forgetGdbLogpoints', numbers);
        this.logpoints = this.logpoints.filter((logpoint) => !numbers.includes(logpoint.number));
    };
    getVariables: IDebuggingExecutor['getVariables'] = async (frameId, scope, ms) => {
        this.note('getVariables', frameId, scope, ms);
        return { scopes: [] };
    };
    getVariablesForFrame: IDebuggingExecutor['getVariablesForFrame'] = async (frameId, scope, ms) => {
        this.note('getVariablesForFrame', frameId, scope, ms);
        return { scopes: [] };
    };
    evaluateExpression: IDebuggingExecutor['evaluateExpression'] = async (expression, frameId, ms) => {
        this.note('evaluateExpression', expression, frameId, ms);
        return { result: '1' };
    };
    /** The children behind each variablesReference. */
    childrenOf: Record<number, Awaited<ReturnType<IDebuggingExecutor['getVariableChildren']>>> = {};
    getVariableChildren: IDebuggingExecutor['getVariableChildren'] = async (reference, ms) => {
        this.note('getVariableChildren', reference, ms);
        return this.childrenOf[reference] ?? [];
    };
    readMemory: IDebuggingExecutor['readMemory'] = async (address, length, ms) => {
        this.note('readMemory', address, length, ms);
        return { bytes: Buffer.alloc(length), offset: 0 };
    };
    readCycleCounter: IDebuggingExecutor['readCycleCounter'] = async () => ({ cycles: 0, enabledNow: false, present: true });
    readPeripheralRegister: IDebuggingExecutor['readPeripheralRegister'] = async () => 'peripheral text';
    getFaultInfo: IDebuggingExecutor['getFaultInfo'] = async () => 'fault text';
    readFaultRegisters: IDebuggingExecutor['readFaultRegisters'] = async () =>
        ({ CFSR: 0x00008200, HFSR: 0x40000000, DFSR: 0, MMFAR: 0, BFAR: 0x60000000, AFSR: 0 });
    readExceptionFrame: IDebuggingExecutor['readExceptionFrame'] = async (sp, ms) => {
        this.note('readExceptionFrame', sp, ms);
        return Buffer.alloc(32);
    };
    resetTarget: IDebuggingExecutor['resetTarget'] = async (options) => {
        this.note('resetTarget', options);
        return {
            serverKind: 'pyocd', methodsTried: ['system'], commandsIssued: ['monitor reset halt system'], replies: ['ok'],
            verified: true, verificationDetail: 'PC matches', haltedByUs: false, resumed: false,
        };
    };
    getDeviceInfo: IDebuggingExecutor['getDeviceInfo'] = async () => '=== Debug Session Info ===\n  Session name: S\n';
    checkTargetConnection: IDebuggingExecutor['checkTargetConnection'] = async () => 'connection text';
    getThreads: IDebuggingExecutor['getThreads'] = async (ms) => {
        this.note('getThreads', ms);
        return [{ id: 1, name: 'main' }];
    };
    getCallStack: IDebuggingExecutor['getCallStack'] = async (threadId, levels, ms) => {
        this.note('getCallStack', threadId, levels, ms);
        return [{ name: 'main', source: '/w/main.c', line: 42, frameId: 1000 }];
    };
}

/** A clock `speedup` times faster than real time; it records the timers it is asked for. */
function fastClock(speedup: number, timers: number[] = []): Pick<HandlerHost, 'now' | 'sleep' | 'startTimer'> {
    const origin = Date.now();
    return {
        now: () => origin + (Date.now() - origin) * speedup,
        sleep: (ms) => new Promise<void>((wake) => {
            setTimeout(wake, ms / speedup);
        }),
        startTimer: (ms, fire) => {
            timers.push(ms);
            const handle = setTimeout(fire, ms / speedup);
            return () => clearTimeout(handle);
        },
    };
}

/** The handler with parts of its host replaced. */
class HostedHandler extends DebuggingHandler {
    constructor(
        executor: ScriptedExecutor,
        private readonly replaced: Partial<HandlerHost>,
        timeoutSeconds: number,
        configurations: Partial<IDebugConfigurationManager>,
    ) {
        super(executor as unknown as IDebuggingExecutor, configurations as IDebugConfigurationManager, timeoutSeconds);
    }

    protected host(): HandlerHost {
        // No GDB port is taken unless a test says so: the bind test would see whatever listens on this machine.
        return { ...super.host(), gdbPortHolder: async () => undefined, reserveGdbPort: () => ({ adopt: () => undefined, release: () => undefined }), ...this.replaced };
    }
}

/** A job tracker whose tasks.json has the CMSIS tasks of a pyOCD adapter, which CMSIS Solution writes with its launch configurations. */
function cmsisTasksTracker(clock: Pick<HandlerHost, 'now' | 'sleep' | 'startTimer'>): CmsisJobTracker {
    const tasks = new FakeTasks();
    tasks.fetched = workspaceTasks('/w', ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase']);
    return new CmsisJobTracker(tasks, clock);
}

function handlerFor(
    executor: ScriptedExecutor,
    replaced: Partial<HandlerHost> = {},
    timeoutSeconds = 5,
    configurations: Partial<IDebugConfigurationManager> = {},
): HostedHandler {
    return new HostedHandler(executor, replaced, timeoutSeconds, configurations);
}

async function rejectionOf(pending: Promise<unknown>): Promise<string> {
    try {
        await pending;
    } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
    }
    assert.fail('expected the call to reject');
}

/** The `ToolError` a call rejects with; `code` is checked when given. */
async function refusalOf(pending: Promise<unknown>, code?: ErrorCode): Promise<ToolError> {
    try {
        await pending;
    } catch (caught) {
        assert.ok(caught instanceof ToolError, `expected a ToolError, got ${String(caught)}`);
        if (code !== undefined) {
            assert.strictEqual(caught.code, code, errorDetail(caught));
        }
        return caught;
    }
    assert.fail('expected the call to reject');
}

/** The answer of a call that ends with a plain text: a success. */
async function textAnswer(pending: Promise<ToolText>): Promise<string> {
    const answered = await pending;
    assert.strictEqual(typeof answered, 'string', `expected a plain text, got ${JSON.stringify(answered)}`);
    return answered as string;
}

/**
 * A call run the way the control server runs it (`runJournaled`), in the
 * call context `callId`: a failure rejects with the records it produced in
 * `data.problems`.
 */
async function journaled(callId: string, run: () => Promise<ToolText>): Promise<ToolText> {
    const { outcome } = await runJournaled(problemJournal(), { callId }, run);
    if (outcome instanceof ToolError) {
        throw outcome;
    }
    return outcome;
}

/** The text of a call that ends with a reply of the given status. */
async function replyAnswer(pending: Promise<ToolText>, status: 'running' | 'timeout'): Promise<string> {
    const answered = await pending;
    assert.ok(typeof answered === 'object' && answered.status === status, `expected status ${status}, got ${JSON.stringify(answered)}`);
    return answered.text;
}

function sourceBreakpoint(file: string, zeroBasedLine: number, condition?: string): vscode.SourceBreakpoint {
    return new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(zeroBasedLine, 0)), true, condition);
}

function frames(count: number): StackFrame[] {
    return Array.from({ length: count }, (_, level) => ({ name: `fn${level}`, source: `/w/f${level}.c`, line: level + 1, frameId: 1000 + level }));
}

/** Register stand-ins for CMSIS Solution commands; dispose the result afterwards. */
function standIns(handlers: Record<string, (...args: unknown[]) => unknown>): vscode.Disposable {
    return vscode.Disposable.from(...Object.entries(handlers).map(([id, run]) => vscode.commands.registerCommand(id, run)));
}

suite('DebuggingHandler', () => {

    suite('logpoint messages become GDB dprintf calls', () => {
        const translate = (message: string) => DebuggingHandler.translateLogMessage(message);

        test('plain text ends with a newline escape and takes no arguments', () => {
            assert.deepStrictEqual(translate('reached init'), { format: 'reached init\\n', args: [] });
        });

        test('an interpolation prints with %d', () => {
            assert.deepStrictEqual(translate('count={count}'), { format: 'count=%d\\n', args: ['count'] });
        });

        test('a conversion after the colon replaces %d', () => {
            assert.deepStrictEqual(translate('name={name:%s} duty={duty:%f}'), { format: 'name=%s duty=%f\\n', args: ['name', 'duty'] });
            assert.deepStrictEqual(translate('t={ticks:%08lx}'), { format: 't=%08lx\\n', args: ['ticks'] });
        });

        test('a scope operator is not a conversion', () => {
            assert.deepStrictEqual(translate('v={ns::value}'), { format: 'v=%d\\n', args: ['ns::value'] });
        });

        test('doubled braces are literal braces', () => {
            assert.deepStrictEqual(translate('{{literal}} x={x}'), { format: '{literal} x=%d\\n', args: ['x'] });
        });

        test('a percent sign in the text is doubled', () => {
            assert.deepStrictEqual(translate('duty 50% at {t}'), { format: 'duty 50%% at %d\\n', args: ['t'] });
        });

        test('quotes and backslashes are escaped for the GDB command string', () => {
            assert.strictEqual(translate('path "C:\\dev"').format, 'path \\"C:\\\\dev\\"\\n');
        });

        test('expressions are passed on as written', () => {
            assert.deepStrictEqual(translate('{buf[i]} {p->field} {a + b}').args, ['buf[i]', 'p->field', 'a + b']);
        });

        test('unbalanced and empty braces are refused with their position', () => {
            assert.throws(() => translate('x={unclosed'), /Unbalanced '\{' in logMessage at position 2/);
            assert.throws(() => translate('x=}'), /Unbalanced '\}' in logMessage at position 2/);
            assert.throws(() => translate('x={}'), /Empty interpolation '\{\}' in logMessage at position 2/);
        });
    });

    suite('breakpoint modifier suffix used by list_breakpoints', () => {
        test('a plain enabled breakpoint has none', () => {
            assert.strictEqual(formatBreakpointModifiers({ enabled: true }), '');
            assert.strictEqual(formatBreakpointModifiers({}), '', 'an absent enabled flag is not "disabled"');
        });

        test('each modifier is listed in order', () => {
            assert.strictEqual(formatBreakpointModifiers({ condition: 'i == 100' }), ' [when: i == 100]');
            assert.strictEqual(formatBreakpointModifiers({ logMessage: 'x={x}' }), ' [log: x={x}]');
            assert.strictEqual(
                formatBreakpointModifiers({ enabled: false, condition: 'n > 0', logMessage: 'n={n}', hitCondition: '>5' }),
                ' [when: n > 0, log: n={n}, hits: >5, disabled]');
        });
    });

    suite('execution waits for the armed DAP stopped event', () => {
        test('continue arms the waiter before the request and reports the stop', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            const reply = await textAnswer(handlerFor(x).handleContinue());
            assert.deepStrictEqual(x.moves, ['arm', 'continue']);
            assert.ok(reply.startsWith('Target stopped (reason: breakpoint).\n\n{'), reply);
            assert.ok(reply.includes('main.c') && reply.includes('42'), reply);
        });

        for (const [method, request] of [['handleStepOver', 'stepOver'], ['handleStepInto', 'stepInto'], ['handleStepOut', 'stepOut']] as const) {
            test(`${method} sends ${request} after arming`, async () => {
                const x = new ScriptedExecutor();
                x.waiters.push({ kind: 'stopped', reason: 'step', threadId: 1 });
                const reply = await textAnswer(handlerFor(x)[method]());
                assert.deepStrictEqual(x.moves, ['arm', request]);
                assert.ok(reply.includes('reason: step'), reply);
            });
        }

        test('only the stop event ends the wait', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push(new Promise<StopWaitResult>(() => undefined));
            const first = await Promise.race([
                handlerFor(x).handleContinue().then(() => 'settled'),
                delay(100).then(() => 'still waiting'),
            ]);
            assert.strictEqual(first, 'still waiting');
        });

        test('a continue whose wait runs out leaves the target running: status running, no pause, the real wait', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'timeout' });
            const reply = await replyAnswer(handlerFor(x, {}, 180).handleContinue({ timeoutMs: 500 }), 'running');
            assert.deepStrictEqual(x.moves, ['arm', 'continue'], 'nothing is paused');
            assert.deepStrictEqual(x.argsOf('pause'), []);
            assert.deepStrictEqual(x.argsOf('getCurrentDebugState'), [], 'a running target is not asked for its state');
            assert.strictEqual(reply, 'Target is running: no stop within 500 ms of \'continue_execution\', and it keeps running; '
                + 'nothing was paused. Call wait_for_stop to wait for the next stop (a breakpoint, a fault), '
                + 'or pause_execution to halt it and see where it is.');

            const capped = new ScriptedExecutor();
            capped.waiters.push({ kind: 'timeout' });
            assert.ok((await replyAnswer(handlerFor(capped, {}, 180).handleContinue(), 'running')).includes('no stop within 60 s'),
                'without timeoutMs the wait is the setting under the 60 s cap');
        });

        test('a continue whose wait runs out answers at once: no state read that would wait out the adapter\'s deadline', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'timeout' });
            // A stackTrace to a running target can hang until its 10 s deadline; here it never answers.
            x.getCurrentDebugState = () => new Promise<DebugState>(() => undefined);
            const first = await Promise.race([
                replyAnswer(handlerFor(x).handleContinue({ timeoutMs: 100 }), 'running').then((text) => text),
                delay(1_000).then(() => 'still waiting'),
            ]);
            assert.ok(first.startsWith('Target is running: no stop within 100 ms of \'continue_execution\''), first);
        });

        test('a step that does not stop pauses the target and says where it is, with status timeout', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            const reply = await replyAnswer(handlerFor(x).handleStepOver(), 'timeout');
            assert.deepStrictEqual(x.moves, ['arm', 'stepOver', 'arm', 'pause']);
            // The reply leads with the overrun and the recovery; the state is read once, after the recovery pause stopped the target.
            assert.ok(reply.startsWith('⚠️ \'step_over\' did not complete within 5 s. The target is still running or the probe is unresponsive. '), reply);
            assert.ok(reply.includes('check_target_connection.\n🩹 Recovery attempt: target did not stop on its own'), reply);
            assert.ok(reply.includes('Paused successfully. PC = 0x08000100, LR = 0x08000200 in main at main.c:42.'), reply);
            assert.ok(reply.endsWith('or step from here with step_over / continue_execution.\n\n'
                + x.state.toCompactString({ includeBreakpoints: true })), reply);
            assert.deepStrictEqual(x.argsOf('getCurrentDebugState'), [[3]]);
            assert.deepStrictEqual(x.argsOf('readCoreRegisters'), [[5000, ['pc', 'lr']]]);
            assert.deepStrictEqual(x.argsOf('pause'), [[5000]]);

            // A frame was selected, but the stack read after it came back empty: no empty state block.
            const unfocused = new ScriptedExecutor();
            unfocused.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: null });
            unfocused.getCurrentDebugState = async () => new DebugState();
            const bare = await replyAnswer(handlerFor(unfocused).handleStepOver(), 'timeout');
            assert.ok(bare.endsWith('or step from here with step_over / continue_execution.'), bare);
        });

        test('the end of the session during a continue rejects with NO_SESSION, unwrapped, like pause and wait_for_stop', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'ended' });
            const failure = await refusalOf(handlerFor(x).handleContinue(), 'NO_SESSION');
            assert.strictEqual(failure.message, 'Debug session ended during \'continue_execution\' — '
                + 'the target may have run to completion, crashed, or lost its connection.');
            assert.strictEqual(failure.hint, 'Call get_session_status to confirm; to debug again, start a session with '
                + 'cmsis_action load_and_debug (CMSIS projects) or start_debugging.');
        });

        test('pause on a running target waits for the stop', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            const reply = await textAnswer(handlerFor(x).handlePause());
            assert.deepStrictEqual(x.moves, ['arm', 'pause']);
            assert.ok(reply.startsWith('Target paused. {'), reply);
        });

        test('recovery variants: register read failure, no stop, session end, pause failure, current line', async () => {
            const noRegisters = new ScriptedExecutor();
            noRegisters.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            noRegisters.failures.readCoreRegisters = new Error('boom');
            const failedRead = await replyAnswer(handlerFor(noRegisters).handleStepOver(), 'timeout');
            assert.ok(failedRead.includes('Paused successfully. PC = <read failed: boom> in main at main.c:42.'), failedRead);
            assert.ok(!failedRead.includes('LR ='), failedRead);

            const silent = new ScriptedExecutor();
            silent.waiters.push({ kind: 'timeout' }, { kind: 'timeout' });
            assert.ok((await replyAnswer(handlerFor(silent).handleStepOver(), 'timeout')).endsWith(
                'Pause did not produce a stop event within 5s — probe/GDB server may be unresponsive. '
                + 'Call check_target_connection, then restart_debugging if needed.'));
            assert.deepStrictEqual(silent.argsOf('getCurrentDebugState'), [], 'the target never stopped, so no state is read');

            const gone = new ScriptedExecutor();
            gone.waiters.push({ kind: 'timeout' }, { kind: 'ended' });
            assert.ok((await replyAnswer(handlerFor(gone).handleStepOver(), 'timeout')).includes(
                'Pause issued but the debug session ended. The target may have crashed during \'step_over\'.'));

            const wedged = new ScriptedExecutor();
            wedged.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'x', threadId: 1 });
            wedged.pause = async () => {
                throw new Error('probe wedged');
            };
            assert.ok((await replyAnswer(handlerFor(wedged).handleStepInto(), 'timeout')).endsWith(
                'Pause failed: probe wedged. Probe / GDB server may be wedged — call check_target_connection.'));

            const withLine = new ScriptedExecutor();
            withLine.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            withLine.state.currentLineContent = 'while (1) {';
            const located = await replyAnswer(handlerFor(withLine).handleStepOut(), 'timeout');
            assert.ok(located.includes('.\n  Current line: while (1) {\nThe breakpoint you expected was not hit'), located);
        });

        test('the timeout text names the real wait, not the setting', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            const reply = await replyAnswer(handlerFor(x, {}, 180).handleStepOver({ timeoutMs: 5000 }), 'timeout');
            assert.deepStrictEqual(x.argsOf('armStopWaiter')[0], [5000]);
            assert.deepStrictEqual(x.argsOf('stepOver'), [[5000]]);
            assert.ok(reply.includes('within 5 s.'), reply);
            assert.ok(!reply.includes('180'), reply);

            const plain = new ScriptedExecutor();
            plain.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            await handlerFor(plain, {}, 180).handleContinue();
            assert.deepStrictEqual(plain.argsOf('armStopWaiter'), [[60000]]);
        });

        test('a request that fails after arming is wrapped', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push(new Promise<StopWaitResult>(() => undefined));
            x.failures.stepOver = new Error('adapter gone');
            const failure = await refusalOf(handlerFor(x).handleStepOver(), 'INTERNAL');
            assert.strictEqual(failure.message, 'Step over failed: adapter gone', 'a plain Error reads without "Error: "');
            x.waiters.push(new Promise<StopWaitResult>(() => undefined));
            x.failures.stepOver = new HardwareTimeoutError('DAP next', 50);
            assert.match((await refusalOf(handlerFor(x).handleStepOver(), 'TIMEOUT')).message, /^Step over failed: HardwareTimeoutError: /);
        });

        test('a step while the target runs rejects with the gate\'s TARGET_RUNNING refusal, not wrapped again', async () => {
            const x = new ScriptedExecutor();
            x.stopped = false;
            x.sessionStatus = status('running');
            const failure = await refusalOf(handlerFor(x).handleStepOver(), 'TARGET_RUNNING');
            assert.strictEqual(failure.message, 'Cannot step over: session state is \'running\'.');
            assert.match(failure.hint ?? '', /^The target is running: call pause_execution first, or set a breakpoint and wait_for_stop\./);
            assert.deepStrictEqual(x.moves, [], 'nothing was sent');
        });
    });

    suite('after a stop the state waits for the frame VS Code selects', () => {
        const NOT_SELECTED = 'VS Code has not selected a frame yet, so the state is not shown: get_call_stack shows where.';
        /** The position of a call's first record in the executor's log. */
        const positionOf = (x: ScriptedExecutor, name: string): number => x.calls.findIndex((call) => call[0] === name);

        test('the focus watch is taken before the request; once a frame is selected the state is read and shown', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            const reply = await textAnswer(handlerFor(x, {}, 180).handleContinue());
            assert.ok(positionOf(x, 'armStopWaiter') < positionOf(x, 'watchFrameFocus'), 'the stop waiter first, as before');
            assert.ok(positionOf(x, 'watchFrameFocus') < positionOf(x, 'continue'), 'a frame VS Code holds before the request is not the stop\'s');
            assert.ok(positionOf(x, 'frameSelected') < positionOf(x, 'getCurrentDebugState'), 'the state is read after the frame is selected');
            assert.deepStrictEqual(x.argsOf('frameSelected'), [[2000]], 'the wait is bounded at 2 s');
            assert.ok(reply.startsWith('Target stopped (reason: breakpoint).\n\n{'), reply);
        });

        test('no frame within the bound: one line instead of the state, for continue, steps and pause; nothing is read', async () => {
            const stopped = new ScriptedExecutor();
            stopped.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            stopped.frameSelected = () => false;
            assert.strictEqual(await textAnswer(handlerFor(stopped).handleContinue()), `Target stopped (reason: breakpoint). ${NOT_SELECTED}`);
            assert.deepStrictEqual(stopped.argsOf('getCurrentDebugState'), []);

            const stepped = new ScriptedExecutor();
            stepped.waiters.push({ kind: 'stopped', reason: null, threadId: 1 });
            stepped.frameSelected = () => false;
            assert.strictEqual(await textAnswer(handlerFor(stepped).handleStepOver()), `Target stopped. ${NOT_SELECTED}`);

            const paused = new ScriptedExecutor();
            paused.waiters.push({ kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            paused.frameSelected = () => false;
            assert.strictEqual(await textAnswer(handlerFor(paused).handlePause()), `Target paused. ${NOT_SELECTED}`);
            assert.deepStrictEqual(paused.argsOf('getCurrentDebugState'), []);
        });

        test('the call returns within the bound when no frame comes, and the bound shrinks to what is left of the call\'s timeout', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            // As the tracker does: no frame, so the wait runs out at its bound.
            x.frameSelected = (limitMs) => delay(limitMs).then(() => false);
            const began = Date.now();
            const reply = await textAnswer(handlerFor(x).handleContinue({ timeoutMs: 300 }));
            const tookMs = Date.now() - began;
            assert.strictEqual(reply, `Target stopped (reason: breakpoint). ${NOT_SELECTED}`);
            const [[boundMs]] = x.argsOf('frameSelected') as number[][];
            assert.ok(boundMs > 0 && boundMs <= 300, `a 300 ms call waits at most 300 ms, not 2 s: ${boundMs}`);
            assert.ok(tookMs < 1_000, `answered after ${tookMs} ms`);

            // The request took 4.6 s of a 5 s call: 400 ms are left for VS Code.
            let clock = 1_000_000;
            const late = new ScriptedExecutor();
            late.waiters.push({ kind: 'stopped', reason: 'step', threadId: 1 });
            late.stepOver = async () => {
                clock += 4_600;
            };
            await textAnswer(handlerFor(late, { now: () => clock }).handleStepOver({ timeoutMs: 5000 }));
            assert.deepStrictEqual(late.argsOf('frameSelected'), [[400]]);

            // Nothing left: the focus is looked at once, without waiting.
            const spent = new ScriptedExecutor();
            spent.waiters.push({ kind: 'stopped', reason: 'step', threadId: 1 });
            spent.stepInto = async () => {
                clock += 9_000;
            };
            await textAnswer(handlerFor(spent, { now: () => clock }).handleStepInto({ timeoutMs: 5000 }));
            assert.deepStrictEqual(spent.argsOf('frameSelected'), [[0]]);
        });

        test('a reply without the state leaves the breakpoint bookkeeping alone', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x);
            x.state.breakpoints = ['main.c:10'];
            x.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            assert.ok((await textAnswer(h.handleContinue())).includes('"breakpoints": [\n    "main.c:10"\n  ]'));

            x.state.breakpoints = ['main.c:10', 'main.c:20'];
            x.frameSelected = () => false;
            x.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            await textAnswer(h.handleContinue());

            // The list changed since the agent last saw one, so the next state shows it.
            x.frameSelected = () => true;
            x.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            const next = await textAnswer(h.handleContinue());
            assert.ok(next.endsWith(x.state.toCompactString({ includeBreakpoints: true })), next);
        });

        test('the recovery pause keeps the PC/LR line only with values when no frame was selected, and shows no state', async () => {
            const read = new ScriptedExecutor();
            read.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            read.frameSelected = () => false;
            const located = await replyAnswer(handlerFor(read).handleStepOver(), 'timeout');
            assert.ok(located.includes('\nPaused successfully. PC = 0x08000100, LR = 0x08000200.\nThe breakpoint you expected was not hit'), located);
            assert.ok(located.endsWith('or step from here with step_over / continue_execution.'), located);
            assert.deepStrictEqual(read.argsOf('getCurrentDebugState'), []);
            assert.deepStrictEqual(read.argsOf('frameSelected'), [[2000]], 'the recovery pause waits for the frame too');

            const unread = new ScriptedExecutor();
            unread.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            unread.frameSelected = () => false;
            unread.registers = { pc: '<unavailable>', lr: '<unavailable>' };
            const pointer = await replyAnswer(handlerFor(unread).handleStepOver(), 'timeout');
            assert.ok(pointer.includes(`\nPaused successfully. ${NOT_SELECTED}\nThe breakpoint you expected was not hit`), pointer);
            assert.ok(!pointer.includes('<unavailable>'), pointer);
        });

        test('wait_for_stop waits for the frame after a stop event, not when the target was already stopped', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x, { now: () => 0 });
            x.waitForStop = async () => ({ kind: 'stopped', reason: 'breakpoint', threadId: 2 });
            assert.ok((await textAnswer(h.handleWaitForStop({ timeoutMs: 2500 }))).startsWith('Target stopped (reason: breakpoint, threadId=2).\n\n{'));
            assert.ok(positionOf(x, 'watchFrameFocus') < positionOf(x, 'frameSelected'));
            assert.deepStrictEqual(x.argsOf('frameSelected'), [[1000]], 'never past the wait\'s own budget (2500 ms less the 1500 ms margin)');

            x.frameSelected = () => false;
            assert.strictEqual(await textAnswer(h.handleWaitForStop()), `Target stopped (reason: breakpoint, threadId=2). ${NOT_SELECTED}`);
            assert.deepStrictEqual(x.argsOf('frameSelected')[1], [2000]);
            assert.strictEqual(x.argsOf('getCurrentDebugState').length, 1, 'no state is read without a frame');

            const already = new ScriptedExecutor();
            already.waitForStop = async () => ({ kind: 'already-stopped', reason: 'breakpoint' });
            assert.ok((await textAnswer(handlerFor(already).handleWaitForStop())).startsWith('Target was already stopped (reason: breakpoint).\n\n{'));
            assert.deepStrictEqual(already.argsOf('frameSelected'), [], 'the stop came before the call: no wait');
            assert.deepStrictEqual(already.argsOf('getCurrentDebugState'), [[3]]);
        });
    });

    suite('survival probe schedule', () => {
        test('both probes fit into the budget', () => {
            for (const budget of [1000, 4000, 8000, 16000, 60000]) {
                const plan = probeSchedule(budget);
                assert.ok(plan.firstDelayMs + plan.probeMs + plan.secondDelayMs + plan.probeMs <= budget, `budget ${budget}`);
                assert.ok(plan.probeMs >= 250 && plan.probeMs <= 5000, `probe ${plan.probeMs}`);
                assert.ok(plan.firstDelayMs > 0 && plan.secondDelayMs >= 0);
            }
            assert.deepStrictEqual(probeSchedule(8000), { firstDelayMs: 2800, secondDelayMs: 1200, probeMs: 2000 });
            assert.deepStrictEqual(probeSchedule(0), probeSchedule(1000));
        });
    });

    suite('fence and state gate', () => {
        test('a failing body rejects with a ToolError, its code classified, without the tool label', async () => {
            const x = new ScriptedExecutor();
            x.readMemory = async () => {
                throw new Error('x');
            };
            assert.strictEqual((await refusalOf(handlerFor(x).handleReadMemory({ address: '0x0', length: 4 }), 'INTERNAL')).message, 'x');
            x.readMemory = async () => {
                throw new HardwareTimeoutError('DAP readMemory', 10);
            };
            await refusalOf(handlerFor(x).handleReadMemory({ address: '0x0', length: 4 }), 'TIMEOUT');
        });

        test('read_memory without a session rejects with NO_SESSION', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.stopped = false;
            x.sessionStatus = status('no-session');
            const failure = await refusalOf(handlerFor(x).handleReadMemory({ address: '0x20000000', length: 4 }), 'NO_SESSION');
            assert.strictEqual(failure.message, 'Cannot read memory: session state is \'no-session\'.');
            assert.strictEqual(failure.hint, 'No active debug session: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise. '
                + 'Use get_session_status for a definitive, never-failing classification.');
        });

        test('the cap of a read rejects with TIMEOUT and drops the late result', async () => {
            const x = new ScriptedExecutor();
            x.readMemory = () => new Promise((_, fail) => setTimeout(() => fail(new Error('late')), 150));
            let unhandled = 0;
            const count = (): void => {
                unhandled++;
            };
            process.on('unhandledRejection', count);
            try {
                const failure = await refusalOf(handlerFor(x).handleReadMemory({ address: '0x0', length: 4, timeoutMs: 100 }), 'TIMEOUT');
                assert.strictEqual(failure.message, '\'read_memory\' did not complete within 100 ms (handler-level cap).');
                assert.match(failure.hint ?? '', /^The DAP probe or target may be unresponsive/);
                await delay(300);
                assert.strictEqual(unhandled, 0);
            } finally {
                process.removeListener('unhandledRejection', count);
            }
        });

        test('the cap of a tool that waits answers with status timeout', async () => {
            const x = new ScriptedExecutor();
            x.resetTarget = () => new Promise((_, fail) => setTimeout(() => fail(new Error('late')), 150));
            const text = await replyAnswer(handlerFor(x).handleReset({ timeoutMs: 100 }), 'timeout');
            assert.ok(text.startsWith('\'reset\' did not complete within 100 ms (handler-level cap). The DAP probe or target may be unresponsive'), text);
            await delay(300);
        });

        test('the fence limit defaults to 30 s and is capped at 60 s', async () => {
            const timers: number[] = [];
            const h = handlerFor(new ScriptedExecutor(), fastClock(1000, timers));
            await h.handleReadCoreRegisters();
            await h.handleReadCoreRegisters({ timeoutMs: 0 });
            await h.handleReadCoreRegisters({ timeoutMs: -1 });
            await h.handleReadCoreRegisters({ timeoutMs: 120_000 });
            await h.handleReadCoreRegisters({ timeoutMs: 2500 });
            assert.deepStrictEqual(timers, [30000, 30000, 30000, 60000, 2500]);
        });

        test('each session state has its own refusal code and hint', async () => {
            const hints: Record<StatusShape['state'], string> = {
                'no-session': 'No active debug session: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise.',
                initializing: 'The debug adapter is still starting, or the session is shutting down, and takes no requests. Wait briefly and retry.',
                running: 'The target is running: call pause_execution first, or set a breakpoint and wait_for_stop.',
                unresponsive: 'The probe/GDB server is unresponsive. Call check_target_connection to confirm.',
                stopped: 'Session reports stopped — please retry the operation.',
            };
            const codes: Record<StatusShape['state'], ErrorCode> = {
                'no-session': 'NO_SESSION', initializing: 'NO_SESSION', running: 'TARGET_RUNNING', unresponsive: 'PROBE_WEDGED', stopped: 'INTERNAL',
            };
            for (const [state, hint] of Object.entries(hints) as Array<[StatusShape['state'], string]>) {
                const x = new ScriptedExecutor();
                x.stopped = false;
                x.sessionStatus = status(state);
                const reconnect = state === 'unresponsive' ? ` ${wedgeHint('launch')}` : '';
                const fullHint = `${hint}${reconnect} Use get_session_status for a definitive, never-failing classification.`;
                const read = await refusalOf(handlerFor(x).handleReadMemory({ address: 'zz', length: 4 }), codes[state]);
                assert.strictEqual(read.message, `Cannot read memory: session state is '${state}'.`);
                assert.strictEqual(read.hint, fullHint);
                assert.deepStrictEqual(x.argsOf('readMemory'), [], 'the gate runs before anything else');
                const step = await refusalOf(handlerFor(x).handleStepInto(), codes[state]);
                assert.strictEqual(step.message, `Cannot step into: session state is '${state}'.`, 'the gate refusal is not wrapped');
                assert.strictEqual(step.hint, fullHint);
            }
        });

        test('an unresponsive probe is PROBE_WEDGED, and the hint reconnects the way the session allows (#3)', async () => {
            const x = new ScriptedExecutor();
            x.stopped = false;
            x.sessionStatus = status('unresponsive');
            x.activeSession = { configuration: { request: 'attach' } };
            const attached = await refusalOf(handlerFor(x).handleGetFaultInfo(), 'PROBE_WEDGED');
            assert.ok(attached.hint?.includes('cmsis_action detach, then cmsis_action attach reconnects without a reset (pyOCD lets the target run while detached and halts it on attach); then get_fault_info.'),
                attached.hint);
            x.activeSession = { configuration: { request: 'launch' } };
            const launched = await refusalOf(handlerFor(x).handleDiagnoseFault(), 'PROBE_WEDGED');
            assert.ok(launched.hint?.includes('ask the user to restart the GDB server without a reset (J-Link -nohalt -noreset, '
                + 'pyOCD -O connect_mode=attach) — do not start one yourself — then cmsis_action attach and get_fault_info.'), launched.hint);
            assert.ok(!launched.hint?.includes('cmsis_action detach, then'), launched.hint);
        });
    });

    suite('session start, stop, restart and reset', () => {
        test('a second start is refused without touching the configuration manager', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('stopped', { sessionName: null });
            let asked = false;
            const refused = await refusalOf(handlerFor(x, {}, 5, {
                promptForConfiguration: async () => {
                    asked = true;
                    return 'x';
                },
            }).handleStartDebugging({ workingDirectory: '/w', configurationName: 'C' }), 'PROBE_BUSY');
            assert.strictEqual(refused.message, 'A debug session is already active (name=\'?\', state=stopped). Refusing to start a second session.');
            assert.strictEqual(refused.hint, 'Use stop_debugging first, or call restart_debugging to reuse the current session, '
                + 'or proceed directly with inspection tools (get_variables_values, read_memory, …).');
            assert.strictEqual(asked, false);
            assert.deepStrictEqual(x.argsOf('startDebuggingByName'), []);
        });

        test('without a configuration name the picker is asked first, and its failure is wrapped', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const asked: string[] = [];
            const message = await rejectionOf(handlerFor(x, {}, 5, {
                promptForConfiguration: async (folder: string) => {
                    asked.push(folder);
                    throw new Error('picker dismissed');
                },
            }).handleStartDebugging({ workingDirectory: '/w', fileFullPath: '/w/main.c' }));
            assert.deepStrictEqual(asked, ['/w']);
            assert.ok(message.startsWith('Error starting debug session: picker dismissed'), message);
            assert.deepStrictEqual(x.argsOf('startDebugging'), []);
        });

        /** A picker nobody answers: it rejects as the real one does once its token fires. */
        const unanswered = (offered: string[], seen: Array<vscode.CancellationToken | undefined> = []): Partial<IDebugConfigurationManager> => ({
            promptForConfiguration: (_folder: string, cancel?: vscode.CancellationToken) => new Promise<string | undefined>((_chosen, closed) => {
                seen.push(cancel);
                cancel?.onCancellationRequested(() => closed(new PickerCancelled(offered)));
            }),
        });

        test('a picker nobody answers is closed after 30 s: INVALID_ARGUMENT naming the configurations to pass (#14)', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const timers: number[] = [];
            const seen: Array<vscode.CancellationToken | undefined> = [];
            const refused = await refusalOf(handlerFor(x, fastClock(1000, timers), 5, unanswered(['CMSIS Debugger: pyOCD', 'Attach'], seen))
                .handleStartDebugging({ workingDirectory: '/w', fileFullPath: '/w/main.c' }), 'INVALID_ARGUMENT');
            assert.deepStrictEqual(timers, [30_000]);
            assert.strictEqual(seen[0]?.isCancellationRequested, true, 'the picker got the token, and it fired');
            assert.strictEqual(refused.message, 'Error starting debug session: No debug configuration was chosen within 30 s: '
                + 'without configurationName, start_debugging asks the user in a picker in that VS Code window, and nobody chose.');
            assert.strictEqual(refused.hint, 'Pass configurationName: one of \'CMSIS Debugger: pyOCD\', \'Attach\' (from .vscode/launch.json), '
                + 'or \'Default Configuration\' with fileFullPath to derive one from the file type. '
                + 'For a CMSIS solution, cmsis_action load_and_debug starts the session instead.');
            assert.deepStrictEqual(x.argsOf('startDebugging'), []);
            assert.deepStrictEqual(x.argsOf('startDebuggingByName'), []);
        });

        test('the picker waits for timeoutMs, at most 60 s; without launch.json entries the hint names the derived configuration (#14)', async () => {
            const waits: number[][] = [];
            for (const timeoutMs of [5_000, 600_000]) {
                const x = new ScriptedExecutor();
                x.session = false;
                const timers: number[] = [];
                const refused = await refusalOf(handlerFor(x, fastClock(1000, timers), 5, unanswered([]))
                    .handleStartDebugging({ workingDirectory: '/w', fileFullPath: '/w/main.c', timeoutMs }), 'INVALID_ARGUMENT');
                waits.push(timers);
                assert.strictEqual(refused.hint, '.vscode/launch.json lists no configuration: pass configurationName \'Default Configuration\' '
                    + 'with fileFullPath to derive one from the file type. For a CMSIS solution, cmsis_action load_and_debug starts the session instead.');
            }
            assert.deepStrictEqual(waits, [[5_000], [60_000]]);
        });

        test('a choice made in time starts that configuration, and the picker\'s timer is disarmed', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.sessionStatus = status('stopped');
            let disarmed = 0;
            const clock = fastClock(1000);
            const reply = await textAnswer(handlerFor(x, {
                ...clock,
                startTimer: (ms, fire) => {
                    const cancel = clock.startTimer(ms, fire);
                    return () => { disarmed++; cancel(); };
                },
            }, 5, { promptForConfiguration: async () => 'CMSIS Debugger: pyOCD' })
                .handleStartDebugging({ workingDirectory: '/w' }));
            assert.ok(reply.startsWith('Debug session started successfully for: CMSIS Debugger: pyOCD'), reply);
            assert.ok(disarmed >= 1, 'the picker\'s deadline is cleared once it answered');
        });

        test('a named configuration starts by name and shows the full state; motion then diffs the breakpoints', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.sessionStatus = status('stopped');
            const h = handlerFor(x);
            const reply = await textAnswer(h.handleStartDebugging({ workingDirectory: '/w', configurationName: 'CMSIS Debugger: pyOCD' }));
            assert.deepStrictEqual(x.argsOf('startDebuggingByName'), [['/w', 'CMSIS Debugger: pyOCD']]);
            assert.ok(reply.startsWith('Debug session started successfully for: CMSIS Debugger: pyOCD '
                + 'using configuration \'CMSIS Debugger: pyOCD\'. Current state: {\n  "sessionActive": true,\n  "configurationName"'), reply);

            x.session = true;
            x.waiters.push({ kind: 'stopped', reason: 'step', threadId: 1 }, { kind: 'stopped', reason: 'step', threadId: 1 });
            assert.ok((await textAnswer(h.handleStepOver())).includes('"breakpointsUnchanged": 0'));
            x.state.breakpoints = ['main.c:7'];
            assert.ok((await textAnswer(h.handleStepOver())).includes('"breakpoints": [\n    "main.c:7"\n  ]'));
        });

        test('a start that comes up halted waits for VS Code\'s frame, bounded, and says so in one line when none comes', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.sessionStatus = status('stopped');
            x.startFocus = () => 'none';
            const reply = await textAnswer(handlerFor(x).handleStartDebugging({ workingDirectory: '/w', configurationName: 'CMSIS Debugger: pyOCD' }));
            assert.strictEqual(reply, 'Debug session started successfully for: CMSIS Debugger: pyOCD using configuration \'CMSIS Debugger: pyOCD\'. '
                + 'VS Code has not selected a frame yet, so the state is not shown: get_call_stack shows where.');
            const order = x.calls.map((call) => call[0]);
            assert.ok(order.indexOf('watchStartFocus') < order.indexOf('startDebuggingByName'), 'armed before the start');
            const [[bound]] = x.argsOf('startFocusSettled') as number[][];
            assert.ok(bound > 0 && bound <= FRAME_FOCUS_WAIT_MS, `bound ${bound}`);
            assert.deepStrictEqual(x.argsOf('getCurrentDebugState'), [], 'no state read without the frame');

            x.session = false;
            x.startFocus = () => 'running';
            const running = await textAnswer(handlerFor(x).handleStartDebugging({ workingDirectory: '/w', configurationName: 'CMSIS Debugger: pyOCD' }));
            assert.ok(running.includes('. Current state: {'), running);
        });

        test('Default Configuration without a file is refused', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const refused = await refusalOf(handlerFor(x).handleStartDebugging({ workingDirectory: '/w', configurationName: 'Default Configuration' }),
                'INVALID_ARGUMENT');
            assert.ok(refused.message.startsWith('Error starting debug session: fileFullPath is required when no named configuration is provided.'),
                refused.message);
        });

        test('a file start builds the configuration and names the test', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.sessionStatus = status('running');
            const built: unknown[][] = [];
            const config = { type: 'python', name: 'n', request: 'launch' };
            const reply = await textAnswer(handlerFor(x, {}, 5, {
                promptForConfiguration: async () => undefined,
                getDebugConfig: async (...args: unknown[]) => {
                    built.push(args);
                    return config;
                },
            }).handleStartDebugging({ workingDirectory: '/w', fileFullPath: '/w/test_x.py', testName: 't1' }));
            assert.deepStrictEqual(built, [['/w', '/w/test_x.py', undefined, 't1']]);
            assert.deepStrictEqual(x.argsOf('startDebugging'), [['/w', config]]);
            assert.ok(reply.startsWith('Debug session started successfully for: /w/test_x.py with default configuration for test \'t1\'. Current state: {'), reply);
        });

        test('a session that never comes up fails the start', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.sessionStatus = status('initializing');
            const message = await rejectionOf(handlerFor(x, fastClock(200), 5)
                .handleStartDebugging({ workingDirectory: '/w', configurationName: 'CMSIS Debugger: pyOCD' }));
            assert.ok(message.startsWith('Error starting debug session: Debug session started but failed to become active within timeout period'), message);
        });

        test('stop without a session, and with one', async () => {
            const idle = new ScriptedExecutor();
            idle.session = false;
            assert.strictEqual(await textAnswer(handlerFor(idle).handleStopDebugging()), 'Nothing to stop — no debug session is active.');

            const x = new ScriptedExecutor();
            const reply = await textAnswer(handlerFor(x).handleStopDebugging());
            assert.deepStrictEqual(x.argsOf('stopDebugging'), [[]]);
            assert.ok(reply.startsWith('The debug session has been stopped.\n\n⚠️ **Root-cause check before you stop**'), reply);
            assert.ok(reply.includes('1. Set breakpoints at the places worth investigating with `add_breakpoint`.'), reply);
            assert.ok(reply.includes('2. Trace the run from its beginning with `start_debugging`.'), reply);
        });

        test('the root-cause check comes once per MCP session, and names cmsis_action load_and_debug on a CMSIS Debugger session', async () => {
            const x = new ScriptedExecutor();
            x.activeSession = { configuration: { request: 'launch' }, type: 'gdbtarget' } as typeof x.activeSession;
            const handler = handlerFor(x);
            const stop = (sessionId: string): Promise<string> =>
                textAnswer(runInCallContext({ callId: `${sessionId}-1`, sessionId }, () => handler.handleStopDebugging()));
            const first = await stop('mcp-a');
            assert.ok(first.includes('2. Trace the run from its beginning with `cmsis_action load_and_debug`.'), first);
            assert.ok(!first.includes('start_debugging'), first);
            assert.strictEqual(await stop('mcp-a'), 'The debug session has been stopped.');
            assert.ok((await stop('mcp-b')).includes('Root-cause check'), 'another MCP session gets it once too');
            assert.strictEqual(await stop('mcp-b'), 'The debug session has been stopped.');
        });

        test('a stop that never settles answers status timeout after 10 s while the session is still listed (#14)', async () => {
            const stuck = new ScriptedExecutor();
            stuck.stopDebugging = () => new Promise<void>(() => { /* VS Code never confirms */ });
            const timers: number[] = [];
            const text = await replyAnswer(handlerFor(stuck, fastClock(1000, timers)).handleStopDebugging(), 'timeout');
            assert.deepStrictEqual(timers, [10_000]);
            assert.strictEqual(text, 'Stop requested, but the debug session did not end within 10 s and is still listed. '
                + 'Call get_session_status to see whether it ends; stop_debugging may be called again.');

            // Gone by the time the fence fires: the stop took, although VS Code never said so.
            const quiet = new ScriptedExecutor();
            quiet.stopDebugging = () => {
                quiet.session = false;
                return new Promise<void>(() => { /* never confirms */ });
            };
            const stopped = await textAnswer(handlerFor(quiet, fastClock(1000)).handleStopDebugging());
            assert.ok(stopped.startsWith('The debug session has been stopped.'), stopped);

            // A stop that fails in time is still wrapped with its cause.
            const refused = new ScriptedExecutor();
            refused.stopDebugging = () => Promise.reject(new Error('adapter gone'));
            assert.strictEqual(await rejectionOf(handlerFor(refused, fastClock(1000)).handleStopDebugging()),
                'Could not stop the debug session: adapter gone');
        });

        test('restart needs a session and waits for it to come back', async () => {
            const idle = new ScriptedExecutor();
            idle.session = false;
            assert.strictEqual((await refusalOf(handlerFor(idle).handleRestart(), 'NO_SESSION')).message,
                'Nothing to restart — no debug session is active', 'a refusal, not wrapped');

            const x = new ScriptedExecutor();
            x.sessionStatus = status('stopped');
            assert.strictEqual(await textAnswer(handlerFor(x).handleRestart({ timeoutMs: 1 })), 'The debug session has been restarted.');
            assert.deepStrictEqual(x.argsOf('restart'), [[]]);
            assert.deepStrictEqual(x.moves, ['restart'], 'a stopped target is not paused');

            const stuck = new ScriptedExecutor();
            stuck.sessionStatus = status('initializing');
            assert.strictEqual(await rejectionOf(handlerFor(stuck, fastClock(200), 7).handleRestart()),
                'Could not restart the debug session: Debug session restart issued but target did not become ready '
                + 'within 7 s. The probe or target may be unresponsive.');
        });

        test('restart waits on through a moment without a session', async () => {
            const x = new ScriptedExecutor();
            // The status before the restart, then what the wait finds.
            const states: Array<StatusShape['state']> = ['stopped', 'initializing', 'no-session', 'stopped'];
            x.getSessionStatus = async () => {
                x.note('getSessionStatus');
                return status(states.length > 1 ? states.shift() as StatusShape['state'] : states[0]);
            };
            assert.strictEqual(await textAnswer(handlerFor(x, fastClock(50)).handleRestart()), 'The debug session has been restarted.');
            assert.strictEqual(x.argsOf('getSessionStatus').length, 4, 'the status before the restart, then three polls');
        });

        test('restart pauses a running CMSIS Debugger target first and says how it restarted', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('running');
            x.waiters.push({ kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            x.restartOutcome = { via: 'relaunched', configurationName: 'CMSIS Debugger: pyOCD', preLaunchTask: 'CMSIS Load' };
            x.logpoints = [{ number: 3, file: '/w/main.c', line: 12, message: 'tick' }];
            const reply = await textAnswer(handlerFor(x).handleRestart());
            assert.deepStrictEqual(x.moves, ['arm', 'pause', 'restart'], 'the pause is armed and sent before the restart');
            assert.deepStrictEqual(x.argsOf('pause'), [[5000]]);
            assert.strictEqual(reply, 'The debug session has been restarted. '
                + 'It was stopped and its launch configuration \'CMSIS Debugger: pyOCD\' started again. '
                + 'The target was paused first. '
                + 'Its preLaunchTask "CMSIS Load" ran first; a CMSIS launch configuration flashes the image there and resets the target in its initCommands. '
                + 'The 1 GDB dprintf logpoint(s) ended with the old session; add them again with add_logpoint.');
        });

        test('restart goes ahead when the pause before it does not stop the target or fails', async () => {
            const silent = new ScriptedExecutor();
            silent.sessionStatus = status('running');
            silent.waiters.push({ kind: 'timeout' });
            const late = await textAnswer(handlerFor(silent).handleRestart());
            assert.deepStrictEqual(silent.moves, ['arm', 'pause', 'restart']);
            assert.strictEqual(late, 'The debug session has been restarted. '
                + '⚠️ The target did not stop within 5 s of the pause request; the session was restarted anyway.');

            const refused = new ScriptedExecutor();
            refused.sessionStatus = status('running');
            refused.waiters.push(new Promise<StopWaitResult>(() => undefined));
            refused.failures.pause = new ToolError('INTERNAL', 'GDB rejected \'pause\': no thread');
            const failed = await textAnswer(handlerFor(refused).handleRestart());
            assert.ok(failed.endsWith('⚠️ Pausing the target first failed (GDB rejected \'pause\': no thread); the session was restarted anyway.'), failed);
            assert.deepStrictEqual(refused.argsOf('restart'), [[]]);
        });

        test('restart does not pause other adapters, and a failed restart is wrapped with its code', async () => {
            const python = new ScriptedExecutor();
            python.sessionStatus = status('running', { sessionType: 'python' });
            assert.strictEqual(await textAnswer(handlerFor(python).handleRestart()), 'The debug session has been restarted.');
            assert.deepStrictEqual(python.moves, ['restart']);

            const broken = new ScriptedExecutor();
            broken.sessionStatus = status('stopped');
            broken.failures.restart = new Error('Restarting the debug session failed: VS Code did not start the launch configuration \'X\' again.');
            const failure = await refusalOf(handlerFor(broken).handleRestart(), 'INTERNAL');
            assert.strictEqual(failure.message,
                'Could not restart the debug session: Restarting the debug session failed: VS Code did not start the launch configuration \'X\' again.');
        });

        test('reset passes the method default and renders the outcome', async () => {
            const x = new ScriptedExecutor();
            const reply = await textAnswer(handlerFor(x).handleReset({}));
            assert.deepStrictEqual(x.argsOf('resetTarget'), [[{ method: 'auto', halt: undefined, timeoutMs: undefined }]]);
            const outcome = await new ScriptedExecutor().resetTarget({});
            assert.strictEqual(reply, renderResetOutcome(outcome as ResetOutcomeView, undefined));

            const idle = new ScriptedExecutor();
            idle.session = false;
            const refused = await refusalOf(handlerFor(idle).handleReset({ halt: false }), 'NO_SESSION');
            assert.strictEqual(errorDetail(refused), 'No active debug session.\nreset drives the target through the live probe. Start a session first: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise.');
        });
    });

    suite('wait_for_stop and pause', () => {
        test('wait budgets leave room for the fence', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x, fastClock(100));
            await h.handleWaitForStop({ timeoutMs: 5000 });
            await h.handleWaitForStop({ timeoutMs: 1000 });
            await h.handleWaitForStop();
            assert.deepStrictEqual(x.argsOf('waitForStop'), [[3500], [100], [28500]]);
        });

        test('each wait outcome has its text', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x, fastClock(100));
            const answer = (outcome: Awaited<ReturnType<IDebuggingExecutor['waitForStop']>>): Promise<ToolText> => {
                x.waitForStop = async () => outcome;
                return h.handleWaitForStop();
            };
            assert.ok((await replyAnswer(answer({ kind: 'timeout' }), 'timeout')).startsWith('Target did not stop within the timeout — it is still running'));
            const ended = await refusalOf(answer({ kind: 'ended' }), 'NO_SESSION');
            assert.ok(ended.message.startsWith('The debug session ended while waiting for a stop'), ended.message);
            assert.strictEqual(ended.hint, 'Call get_session_status to confirm.');
            assert.ok((await textAnswer(answer({ kind: 'already-stopped', reason: null }))).startsWith('Target was already stopped (reason: unknown).\n\n{'));
            assert.ok((await textAnswer(answer({ kind: 'stopped', reason: 'breakpoint', threadId: 3 }))).startsWith('Target stopped (reason: breakpoint, threadId=3).\n\n{'));
            assert.ok((await textAnswer(answer({ kind: 'stopped', reason: 'step', threadId: null }))).startsWith('Target stopped (reason: step).'));

            const idle = new ScriptedExecutor();
            idle.session = false;
            const refused = await refusalOf(handlerFor(idle).handleWaitForStop(), 'NO_SESSION');
            assert.strictEqual(errorDetail(refused), 'No active debug session.\nwait_for_stop waits on a live session. Start a session first: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise.');
        });

        test('pause answers by session state', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x);
            x.sessionStatus = status('stopped', { detail: 'breakpoint' });
            assert.strictEqual(await textAnswer(h.handlePause()), 'Target is already stopped (reason: breakpoint). No pause needed — proceed with inspection tools.');
            x.sessionStatus = status('stopped');
            assert.ok((await textAnswer(h.handlePause())).startsWith('Target is already stopped (reason: n/a).'));
            // Unresponsive: one pause with a 5 s deadline; when it does not stop the target, PROBE_WEDGED as at every gate,
            // with the way to reconnect instead of a re-flash (#3).
            x.sessionStatus = status('unresponsive');
            x.waiters.push({ kind: 'timeout' });
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause({ timeoutMs: 30_000 }), 'PROBE_WEDGED')),
                'Cannot pause: session state is \'unresponsive\'.\nThe probe/GDB server is unresponsive. Call check_target_connection to confirm. '
                + `${wedgeHint('launch')} Use get_session_status for a definitive, never-failing classification.`);
            assert.deepStrictEqual(x.argsOf('pause'), [[5_000]], 'one pause, with the short deadline whatever timeoutMs says');
            assert.deepStrictEqual(x.argsOf('armStopWaiter'), [[5_000]]);
            x.failures.pause = new Error('Remote communication error.');
            x.waiters.push({ kind: 'timeout' });
            assert.strictEqual((await refusalOf(h.handlePause(), 'PROBE_WEDGED')).message, 'Cannot pause: session state is \'unresponsive\'.',
                'a pause that fails is the same refusal');
            delete x.failures.pause;
            x.waiters.push({ kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            const recovered = await textAnswer(h.handlePause());
            assert.ok(recovered.startsWith('Target paused. '), recovered);
            x.waiters.push({ kind: 'ended' });
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')),
                'Pause requested but the debug session ended. The target may have crashed.');
            x.calls.length = 0;
            x.sessionStatus = status('initializing');
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')),
                'Cannot pause yet: session is still initializing.\nWait briefly and retry.');
            x.sessionStatus = status('no-session');
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')), 'No active debug session.');
            x.sessionStatus = status('running');
            x.waiters.push({ kind: 'timeout' });
            assert.ok((await replyAnswer(h.handlePause({ timeoutMs: 700 }), 'timeout')).startsWith('Pause requested but target did not stop within the timeout.'));
            assert.deepStrictEqual(x.argsOf('pause'), [[700]]);
            assert.deepStrictEqual(x.argsOf('getCurrentDebugState'), [], 'a pause that did not stop the target reads no state');
            x.waiters.push({ kind: 'ended' });
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')),
                'Pause requested but the debug session ended. The target may have crashed.');
            x.session = false;
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')), 'No active debug session.\nStart a session first: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise.');
        });

        test('on an Arm FVP, whose GDB server ignores the interrupt, the replies that would advise a pause say that only a breakpoint stops it', async () => {
            const fvp = (): ScriptedExecutor => {
                const x = new ScriptedExecutor();
                x.activeSession = {
                    name: 'Arm-FVP@GDB (launch)',
                    configuration: {
                        type: 'gdbtarget', name: 'Arm-FVP@GDB (launch)', request: 'launch',
                        target: { server: '/w/.vscode/fvp.sh', serverParameters: ['--plugin', '/opt/fvp/plugins/GDBServer.so', '-C', 'GDBServer.port=3333'] },
                    },
                } as unknown as ScriptedExecutor['activeSession'];
                x.sessionStatus = status('running');
                return x;
            };

            const paused = fvp();
            paused.waiters.push({ kind: 'timeout' });
            assert.strictEqual(await replyAnswer(handlerFor(paused).handlePause({ timeoutMs: 700 }), 'timeout'),
                'Pause requested, but the Arm FVP did not stop: its GDB server ignores GDB\'s interrupt while the model runs, so only a breakpoint stops it. '
                + 'To see where it runs: stop_debugging, cmsis_action load_and_debug, add_breakpoint where it should stop (for a fault, HardFault_Handler), '
                + 'then continue_execution.');

            const continued = fvp();
            continued.sessionStatus = status('stopped');
            continued.waiters.push({ kind: 'timeout' });
            assert.strictEqual(await replyAnswer(handlerFor(continued, {}, 180).handleContinue({ timeoutMs: 500 }), 'running'),
                'Target is running: no stop within 500 ms of \'continue_execution\', and it keeps running; nothing was paused. '
                + 'Call wait_for_stop to wait for a breakpoint. On the Arm FVP pause_execution will not stop it, nor will a fault: '
                + 'to set a breakpoint, stop_debugging and cmsis_action load_and_debug first.');

            const breakpoint = fvp();
            breakpoint.waiters.push({ kind: 'timeout' });
            const refused = await refusalOf(handlerFor(breakpoint).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), 'TARGET_RUNNING');
            assert.strictEqual(errorDetail(refused), 'Cannot add a breakpoint while the Arm FVP runs: the change needs a halted target, '
                + 'and its GDB server ignores the pause request.\nstop_debugging, cmsis_action load_and_debug (it stops at main), make the change, '
                + 'then continue_execution.');
            assert.ok(!breakpoint.moves.includes('addBreakpoint') && !breakpoint.moves.includes('continue'), breakpoint.moves.join(', '));

            const stuck = fvp();
            stuck.stopDebugging = () => new Promise<void>(() => { /* the adapter waits for a halt the model never reports */ });
            assert.strictEqual(await replyAnswer(handlerFor(stuck, fastClock(1000)).handleStopDebugging(), 'timeout'),
                'Stop requested, but the session is still listed: the debug adapter halts the target before it disconnects, '
                + 'and the Arm FVP ignores that interrupt. Call stop_debugging once more: VS Code then ends the adapter.');

            const running = 'On the Arm FVP pause_execution will not stop it, only a breakpoint does: wait_for_stop for one that is set, '
                + 'or stop_debugging, cmsis_action load_and_debug and add_breakpoint before continue_execution.';
            const read = fvp();
            read.stopped = false;
            assert.strictEqual(errorDetail(await refusalOf(handlerFor(read).handleReadMemory({ address: '0x20000000', length: 4 }), 'TARGET_RUNNING')),
                `Cannot read memory: session state is 'running'.\n${running} Use get_session_status for a definitive, never-failing classification.`);
            assert.ok((await textAnswer(handlerFor(fvp()).handleGetSessionStatus())).endsWith(`\nHint: target is running. ${running}`));

            const waited = fvp();
            waited.waitForStop = async () => ({ kind: 'timeout' });
            assert.strictEqual(await replyAnswer(handlerFor(waited).handleWaitForStop({ timeoutMs: 2_000 }), 'timeout'),
                'Target did not stop within the timeout — it is still running. On the Arm FVP pause_execution will not stop it, only a breakpoint does: '
                + 'call wait_for_stop again with a larger timeoutMs, or stop_debugging and cmsis_action load_and_debug to set one.');

            const stepped = fvp();
            stepped.sessionStatus = status('stopped');
            stepped.waiters.push({ kind: 'timeout' });
            const runaway = await replyAnswer(handlerFor(stepped).handleStepOver({ timeoutMs: 500 }), 'timeout');
            assert.ok(runaway.endsWith('\n🩹 No recovery pause: the Arm FVP ignores it while the model runs, so only a breakpoint stops it — '
                + 'stop_debugging, cmsis_action load_and_debug, add_breakpoint where it should stop, then continue_execution.'), runaway);
            assert.deepStrictEqual(stepped.moves, ['arm', 'stepOver'], 'no pause sent');

            // Other sessions keep their texts.
            const board = new ScriptedExecutor();
            board.sessionStatus = status('running');
            board.waiters.push({ kind: 'timeout' });
            assert.ok((await replyAnswer(handlerFor(board).handlePause(), 'timeout')).startsWith('Pause requested but target did not stop within the timeout.'));
            board.stopped = false;
            assert.ok(errorDetail(await refusalOf(handlerFor(board).handleReadMemory({ address: '0x20000000', length: 4 }), 'TARGET_RUNNING'))
                .includes('call pause_execution first'));
            const boardWait = new ScriptedExecutor();
            boardWait.waitForStop = async () => ({ kind: 'timeout' });
            assert.ok((await replyAnswer(handlerFor(boardWait).handleWaitForStop({ timeoutMs: 2_000 }), 'timeout')).includes('pause_execution to see where it is'));
        });
    });

    suite('breakpoints and logpoints', () => {
        let scratch: string | undefined;
        teardown(() => {
            if (scratch) {
                fs.rmSync(scratch, { recursive: true, force: true });
                scratch = undefined;
            }
        });

        /** A scripted CMSIS Debugger session whose target is halted. */
        function halted(): ScriptedExecutor {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('stopped');
            return x;
        }

        test('line numbers are checked and a location is required', async () => {
            const x = halted();
            assert.strictEqual((await refusalOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 0 }), 'INVALID_ARGUMENT')).message,
                'Error adding breakpoint: Invalid line number 0: must be a 1-based integer.');
            assert.strictEqual(await rejectionOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c' })),
                'Error adding breakpoint: No location given: pass `line` (1-based line number). '
                + 'The legacy `lineContent` form is still accepted but deprecated.');
            assert.deepStrictEqual(x.argsOf('addBreakpoint'), []);
            assert.deepStrictEqual(x.moves, [], 'a refused request pauses nothing');
        });

        test('without a session the breakpoint only goes to the model', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const reply = await textAnswer(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10, condition: 'i > 3' }));
            assert.deepStrictEqual(x.argsOf('addBreakpoint'), [['/w/main.c', 10, { condition: 'i > 3' }]]);
            assert.deepStrictEqual(x.argsOf('breakpointBinding'), []);
            assert.deepStrictEqual(x.moves, ['addBreakpoint']);
            assert.strictEqual(reply, 'Breakpoint added at /w/main.c:10 [when: i > 3]\n'
                + '(No debug session yet — added to VS Code\'s breakpoint list; the debugger binds it when a session starts.)');
        });

        test('the adapter\'s own report says how the breakpoint bound', async () => {
            const x = halted();
            const h = handlerFor(x);
            assert.strictEqual(await textAnswer(h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 })),
                'Breakpoint added at /w/main.c:10\nAdapter: verified as GDB breakpoint 7.');
            assert.deepStrictEqual(x.argsOf('breakpointBinding'), [[2000]], 'the wait for the adapter is bounded to 2 s');

            x.binding = () => ({ reported: true, verified: true, line: 12, id: 8 });
            assert.strictEqual(await textAnswer(h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 11 })),
                'Breakpoint added at /w/main.c:11\nAdapter: verified as GDB breakpoint 8 at line 12.');

            x.binding = () => ({ reported: true, verified: false, message: 'No line 99 in file "main.c".' });
            const unbound = await textAnswer(h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 99 }));
            assert.strictEqual(unbound, 'Breakpoint added at /w/main.c:99\nAdapter: NOT verified — No line 99 in file "main.c".\n'
                + 'An unverified breakpoint never stops the target: the line may have no code (a declaration, a comment, code the '
                + 'optimiser removed), the path may not match the ELF\'s compiled paths, or the FPB comparators may be used up.');

            x.binding = () => ({ reported: false, verified: false });
            assert.strictEqual(await textAnswer(h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 13 })),
                'Breakpoint added at /w/main.c:13\nAdapter: not reported by the adapter yet.\n'
                + 'Call list_breakpoints later to see whether the adapter bound it.');
            assert.deepStrictEqual(x.argsOf('insertDprintfViaGdb'), [], 'no parallel GDB breakpoint');
        });

        test('other adapters: no GDB numbers, and a running target is not paused', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('running', { sessionType: 'cppdbg' });
            const reply = await textAnswer(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }));
            assert.strictEqual(reply, 'Breakpoint added at /w/main.c:10\nAdapter: verified.');
            assert.deepStrictEqual(x.moves, ['addBreakpoint']);
        });

        test('the deprecated lineContent form sets every matching line and reports each', async () => {
            scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-handler-'));
            const file = path.join(scratch, 'loop.c');
            fs.writeFileSync(file, ['a', 'b', '  return;', 'c', 'd', 'e', 'return;', 'f', 'x = 1; return;', 'g'].join('\r\n'));
            const x = halted();
            x.binding = (bp) => {
                const line = (bp as vscode.SourceBreakpoint).location.range.start.line + 1;
                return line === 7 ? { reported: true, verified: false, message: 'no code' } : { reported: true, verified: true, line };
            };
            const reply = await textAnswer(handlerFor(x).handleAddBreakpoint({ fileFullPath: file, lineContent: 'return;' }));
            assert.deepStrictEqual(x.argsOf('addBreakpoint').map((call) => call[1]), [3, 7, 9]);
            assert.ok(reply.startsWith(`Breakpoints added at 3 locations in ${file}: lines 3, 7, 9\n`
                + '⚠️ Located via the deprecated `lineContent` match (3 line(s) matched). '
                + 'Pass `line` instead — content matching hits every line containing the text.\n'
                + 'Adapter:\n  line 3: verified\n  line 7: NOT verified — no code\n  line 9: verified\nAn unverified breakpoint'), reply);
            assert.strictEqual(await rejectionOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: file, lineContent: 'nowhere' })),
                'Error adding breakpoint: Could not find any lines containing: nowhere');
        });

        suite('a change on a running CMSIS Debugger target pauses, applies and resumes', () => {
            /** A running target whose pause stops it. */
            function running(): ScriptedExecutor {
                const x = new ScriptedExecutor();
                x.sessionStatus = status('running');
                x.waiters.push({ kind: 'stopped', reason: 'SIGINT', threadId: 1 });
                x.breakpoints = [sourceBreakpoint('/w/main.c', 4)];
                x.logpoints = [{ number: 3, file: '/w/main.c', line: 5, message: 'tick' }];
                return x;
            }

            const tools: Array<[string, (h: DebuggingHandler) => Promise<ToolText>, string[]]> = [
                ['add_breakpoint', (h) => h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), ['addBreakpoint']],
                ['add_logpoint', (h) => h.handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'n={n}' }),
                    ['removeBreakpoint', 'insertDprintfViaGdb']],
                ['remove_breakpoint', (h) => h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 5 }),
                    ['deleteBreakpointsViaGdb', 'removeBreakpoint']],
                ['clear_all_breakpoints', (h) => h.handleClearAllBreakpoints(), ['deleteBreakpointsViaGdb', 'clearAllBreakpoints']],
            ];

            for (const [tool, call, mutation] of tools) {
                test(`${tool}: arm, pause, change, continue — and the answer says so`, async () => {
                    const x = running();
                    const reply = await textAnswer(call(handlerFor(x)));
                    assert.deepStrictEqual(x.moves, ['arm', 'pause', ...mutation, 'continue']);
                    assert.deepStrictEqual(x.argsOf('pause'), [[5000]]);
                    assert.match(reply, /\nTarget paused \d+\.\d s to apply this, then resumed\.(\n|$)/);
                });
            }

            test('a stopped target is not paused, and without a session nothing is', async () => {
                for (const [tool, call] of tools) {
                    const x = running();
                    x.sessionStatus = status('stopped');
                    const reply = await textAnswer(call(handlerFor(x)));
                    assert.ok(!x.moves.includes('pause') && !x.moves.includes('continue'), `${tool}: ${x.moves.join(', ')}`);
                    assert.ok(!reply.includes('Target paused'), `${tool}: ${reply}`);
                }
                const idle = new ScriptedExecutor();
                idle.session = false;
                await handlerFor(idle).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 });
                assert.deepStrictEqual(idle.moves, ['addBreakpoint']);
                assert.deepStrictEqual(idle.argsOf('getSessionStatus'), []);
            });

            test('a change that fails still resumes the target, and the failure keeps its code', async () => {
                const x = running();
                x.failures.addBreakpoint = new Error('model refused');
                const failure = await refusalOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), 'INTERNAL');
                assert.deepStrictEqual(x.moves, ['arm', 'pause', 'addBreakpoint', 'continue']);
                assert.strictEqual(failure.message, 'Error adding breakpoint: model refused');

                const refused = running();
                refused.gdbReplies.dprintf = { text: 'No source file named nowhere.c.', errored: true };
                const rejected = await refusalOf(handlerFor(refused).handleAddLogpoint({ fileFullPath: '/w/nowhere.c', line: 3, logMessage: 'x' }),
                    'INVALID_ARGUMENT');
                assert.deepStrictEqual(refused.moves, ['arm', 'pause', 'removeBreakpoint', 'insertDprintfViaGdb', 'continue']);
                assert.strictEqual(rejected.message, 'Could not add the logpoint: GDB rejected the logpoint: No source file named nowhere.c.');
            });

            test('a target that cannot be resumed is reported, with or without a failing change', async () => {
                const x = running();
                x.failures.continue = new Error('probe gone');
                const reply = await textAnswer(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }));
                assert.ok(reply.endsWith('\n⚠️ The target was paused for this and could not be resumed: probe gone. It is halted — call continue_execution.'),
                    reply);

                const both = running();
                both.failures.continue = new Error('probe gone');
                both.failures.addBreakpoint = new Error('model refused');
                const failure = await refusalOf(handlerFor(both).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), 'INTERNAL');
                assert.ok(failure.message.endsWith('model refused The target was paused for this and could not be resumed: probe gone.'), failure.message);
                assert.strictEqual(failure.hint, 'The target is halted: call continue_execution when ready.');
            });

            test('initializing, unresponsive, a pause that does not stop and a session that ends are refused before any change, unwrapped', async () => {
                const cases: Array<[StatusShape['state'], StopWaitResult | undefined, ErrorCode, string]> = [
                    ['initializing', undefined, 'NO_SESSION', 'Cannot add a breakpoint yet: the session is still initializing.'],
                    ['unresponsive', undefined, 'PROBE_WEDGED', 'Cannot add a breakpoint: session state is \'unresponsive\'.'],
                    ['running', { kind: 'timeout' }, 'TIMEOUT',
                        'Cannot add a breakpoint: the target did not stop within 5 s of the pause request.'],
                    ['running', { kind: 'ended' }, 'NO_SESSION',
                        'Cannot add a breakpoint: the debug session ended while the target was being paused for it.'],
                ];
                for (const [state, waiter, code, message] of cases) {
                    const x = new ScriptedExecutor();
                    x.sessionStatus = status(state);
                    if (waiter) {
                        x.waiters.push(waiter);
                    }
                    const failure = await refusalOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), code);
                    assert.strictEqual(failure.message, message);
                    assert.ok(!x.moves.includes('addBreakpoint') && !x.moves.includes('continue'), x.moves.join(', '));
                }
            });
        });

        suite('logpoints', () => {
            test('without a session a logpoint only goes to the model', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const reply = await textAnswer(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'n={n}', condition: 'n > 1' }));
                assert.deepStrictEqual(x.argsOf('addBreakpoint'), [['/w/main.c', 12, { condition: 'n > 1', logMessage: 'n={n}' }]]);
                assert.strictEqual(reply, 'Logpoint added at /w/main.c:12\n(No debug session yet — added to VS Code\'s breakpoint list. '
                    + 'The CMSIS Debugger prints such a logpoint\'s text without the {expr} values: '
                    + 'call add_logpoint again once the session is up to set it as a GDB dprintf.)');
            });

            test('on the CMSIS Debugger a logpoint is a GDB dprintf at a workspace-relative location, remembered by number', async () => {
                const x = halted();
                const h = handlerFor(x, { workspaceFolders: () => [{ uri: vscode.Uri.file('/w'), name: 'w', index: 0 }] });
                const reply = await textAnswer(h.handleAddLogpoint({ fileFullPath: '/w/src/main.c', line: 12, logMessage: 'n={n:%u} at {p->x}', condition: ' n > 5 ' }));
                assert.deepStrictEqual(x.argsOf('insertDprintfViaGdb'), [['src/main.c:12', 'n=%u at %d\\n', ['n', 'p->x']]]);
                assert.deepStrictEqual(x.argsOf('setBreakpointConditionViaGdb'), [[3, 'n > 5']]);
                assert.deepStrictEqual(x.argsOf('rememberGdbLogpoint'),
                    [[{ number: 3, file: '/w/src/main.c', line: 12, message: 'n={n:%u} at {p->x}', condition: 'n > 5' }]]);
                assert.deepStrictEqual(x.argsOf('addBreakpoint'), [], 'no VS Code logpoint besides the dprintf');
                assert.deepStrictEqual(x.argsOf('removeBreakpoint'), [['/w/src/main.c', 12, { logpointsOnly: true }]]);
                const lines = reply.split('\n');
                assert.deepStrictEqual(lines.slice(0, 5), [
                    'Logpoint added at /w/src/main.c:12',
                    '  GDB dprintf 3 (main.c:12, 0x080002f4): dprintf src/main.c:12,"n=%u at %d\\n",n,p->x',
                    '  Condition: n > 5',
                    'It prints to VS Code\'s Debug Console; list_breakpoints shows how often it fired. remove_breakpoint on /w/src/main.c:12 deletes it.',
                    '',
                ]);
                assert.ok(lines[5].startsWith('ℹ️ On Cortex-M a logpoint is not free:'), lines[5]);
            });

            test('a VS Code logpoint set there before the session is replaced; several locations are flagged', async () => {
                const x = halted();
                x.breakpoints = [new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file('/w/main.c'), new vscode.Position(11, 0)),
                    true, undefined, undefined, 'n={n}')];
                x.gdbReplies.dprintf = {
                    text: JSON.stringify({ bkpt: [{ number: '4', addr: '<MULTIPLE>' }, { number: '4.1', file: 'main.c', line: '12' }, { number: '4.2' }] }),
                    errored: false,
                };
                const reply = await textAnswer(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'n={n}' }));
                assert.deepStrictEqual(x.breakpoints, []);
                assert.ok(reply.includes('\n  GDB dprintf 4 (main.c:12): dprintf main.c:12,"n=%d\\n",n\n'
                    + '⚠️ GDB set it at 2 locations: the location matched more than one place.\n'
                    + 'Replaced the VS Code logpoint set at this line before the session, which printed its text without the values.\n'), reply);
            });

            test('GDB\'s refusals: location, condition (taken back out), running target, and a reply that names no breakpoint', async () => {
                const x = halted();
                x.gdbReplies.dprintf = { text: 'No line 99 in file "main.c".', errored: true };
                const rejected = await refusalOf(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 99, logMessage: '{q}' }), 'INVALID_ARGUMENT');
                assert.strictEqual(errorDetail(rejected), 'Could not add the logpoint: GDB rejected the logpoint: No line 99 in file "main.c".\n'
                    + 'Check that the line has code and the path matches the ELF\'s compiled paths, and that every expression is in scope at that line.');
                assert.deepStrictEqual(x.argsOf('rememberGdbLogpoint'), []);

                const badCondition = halted();
                badCondition.gdbReplies.condition = { text: 'No symbol "q" in current context.', errored: true };
                await refusalOf(handlerFor(badCondition).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'x', condition: 'q' }),
                    'INVALID_ARGUMENT');
                assert.deepStrictEqual(badCondition.argsOf('deleteBreakpointsViaGdb'), [[[3]]], 'the dprintf is taken back out');
                assert.deepStrictEqual(badCondition.argsOf('rememberGdbLogpoint'), []);

                const racing = halted();
                racing.gdbReplies.dprintf = { text: 'Cannot execute this command while the target is running.', errored: true };
                const raced = await refusalOf(handlerFor(racing).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'x' }), 'TARGET_RUNNING');
                assert.strictEqual(raced.hint, 'pause_execution first, or wait_for_stop if a stop is expected.');

                const garbled = halted();
                garbled.gdbReplies.dprintf = { text: '', errored: false };
                assert.match((await refusalOf(handlerFor(garbled).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'x' }), 'INTERNAL'))
                    .message, /GDB did not report the new dprintf: <empty reply>$/);

                assert.strictEqual(await rejectionOf(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 3, logMessage: 'x={' })),
                    'Could not add the logpoint: Unbalanced \'{\' in logMessage at position 2. Use {{ for a literal brace.');
            });

            test('other adapters keep a VS Code logpoint, which they fill in themselves', async () => {
                const x = new ScriptedExecutor();
                x.sessionStatus = status('stopped', { sessionType: 'cppdbg' });
                const reply = await textAnswer(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'n={n}' }));
                assert.deepStrictEqual(x.argsOf('addBreakpoint'), [['/w/main.c', 12, { condition: undefined, logMessage: 'n={n}' }]]);
                assert.deepStrictEqual(x.argsOf('insertDprintfViaGdb'), []);
                assert.ok(reply.startsWith('Logpoint added at /w/main.c:12\nAdapter: verified.\n\nℹ️'), reply);
            });
        });

        test('remove: the model breakpoint and the logpoint at that line, and nothing when there is none', async () => {
            const x = halted();
            const h = handlerFor(x);
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 5 })),
                'Nothing to remove — no breakpoint is set at /w/main.c:5.');
            assert.deepStrictEqual(x.moves, []);

            x.breakpoints = [sourceBreakpoint('/w/main.c', 4)];
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 5 })), 'Breakpoint removed from /w/main.c:5');
            assert.deepStrictEqual(x.argsOf('removeBreakpoint'), [['/w/main.c', 5, undefined]]);
            assert.deepStrictEqual(x.argsOf('deleteBreakpointsViaGdb'), [], 'no GDB `clear`');

            x.breakpoints = [sourceBreakpoint('/w/main.c', 4)];
            x.removalApplied = false;
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 5 })),
                'Breakpoint removed from /w/main.c:5\n⚠️ The debug adapter did not confirm the change within 2 s; list_breakpoints shows what it reports.');

            x.logpoints = [{ number: 3, file: '/w/main.c', line: 7, message: 'tick' }, { number: 5, file: '/w/led.c', line: 7, message: 'tock' }];
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 7 })),
                'Logpoint removed from /w/main.c:7\nDeleted GDB dprintf 3.');
            assert.deepStrictEqual(x.argsOf('deleteBreakpointsViaGdb'), [[[3]]]);
            assert.deepStrictEqual(x.logpoints.map((logpoint) => logpoint.number), [5]);

            x.gdbReplies.delete = { text: 'No breakpoint number 5.', errored: false };
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/led.c', line: 7 })),
                'Logpoint removed from /w/led.c:7\nGDB no longer had dprintf 5 (deleted outside these tools).');
            assert.deepStrictEqual(x.logpoints, []);
        });

        test('clear all: the model and the logpoints by number — never a bare delete', async () => {
            const idle = new ScriptedExecutor();
            idle.session = false;
            assert.strictEqual(await textAnswer(handlerFor(idle).handleClearAllBreakpoints()), 'Nothing to clear — no breakpoints are set.');
            idle.breakpoints = [sourceBreakpoint('/w/a.c', 1), sourceBreakpoint('/w/b.c', 2)];
            assert.strictEqual(await textAnswer(handlerFor(idle).handleClearAllBreakpoints()), 'Cleared 2 breakpoint(s) from the model.');

            const live = halted();
            assert.strictEqual(await textAnswer(handlerFor(live).handleClearAllBreakpoints()), 'Nothing to clear — no breakpoints are set.');
            assert.deepStrictEqual(live.moves, [], 'nothing is sent to GDB when nothing is set');

            live.breakpoints = [sourceBreakpoint('/w/a.c', 1)];
            live.logpoints = [{ number: 3, file: '/w/main.c', line: 7, message: 'tick' }, { number: 4, file: '/w/main.c', line: 9, message: 'tock' }];
            assert.strictEqual(await textAnswer(handlerFor(live).handleClearAllBreakpoints()),
                'Cleared 1 breakpoint(s) from the model.\nDeleted GDB dprintf 3, 4.');
            assert.deepStrictEqual(live.moves, ['deleteBreakpointsViaGdb', 'clearAllBreakpoints'], 'the logpoints go first');
            assert.deepStrictEqual(live.argsOf('deleteBreakpointsViaGdb'), [[[3, 4]]]);
            assert.deepStrictEqual(live.logpoints, []);
        });

        test('the list numbers every breakpoint and shows the binding and the logpoints with their hits', async () => {
            const x = halted();
            assert.strictEqual(await textAnswer(handlerFor(x).handleListBreakpoints()), 'The breakpoint list is empty.');
            x.breakpoints = [
                sourceBreakpoint('/w/src/main.c', 41, 'x'),
                new vscode.FunctionBreakpoint('HardFault_Handler'),
                { enabled: true } as unknown as vscode.Breakpoint,
                sourceBreakpoint('/w/src/led.c', 0),
            ];
            x.binding = (bp) => bp instanceof vscode.FunctionBreakpoint
                ? { reported: true, verified: false, message: 'Function "HardFault_Handler" not defined.' }
                : bp instanceof vscode.SourceBreakpoint && bp.location.range.start.line === 0
                    ? { reported: false, verified: false }
                    : { reported: true, verified: true, line: 42 };
            x.logpoints = [
                { number: 3, file: '/w/src/main.c', line: 50, message: 'n={n}', condition: 'n > 2' },
                { number: 9, file: '/w/src/main.c', line: 60, message: 'gone' },
            ];
            assert.strictEqual(await textAnswer(handlerFor(x).handleListBreakpoints()),
                'Breakpoints that are set:\n'
                + '1. main.c:42 [when: x] — verified\n'
                + '2. Function: HardFault_Handler — NOT verified — Function "HardFault_Handler" not defined.\n'
                + '4. led.c:1 — not reported by the adapter yet\n'
                + 'GDB dprintf logpoints (they print to the Debug Console):\n'
                + '5. main.c:50 [when: n > 2, log: n={n}] — GDB dprintf 3, 4 hits\n'
                + '6. main.c:60 [log: gone] — dprintf 9 is gone from GDB (deleted outside these tools)\n');
            assert.deepStrictEqual(x.argsOf('breakpointBinding'), [[0], [0], [0]], 'the list does not wait for the adapter');
            assert.deepStrictEqual(x.logpoints.map((logpoint) => logpoint.number), [3], 'a logpoint GDB no longer has is forgotten');

            x.gdbReplies.list = { text: 'Cannot access memory', errored: true };
            assert.ok((await textAnswer(handlerFor(x).handleListBreakpoints())).endsWith('5. main.c:50 [when: n > 2, log: n={n}] — GDB dprintf 3\n'));

            const idle = new ScriptedExecutor();
            idle.session = false;
            idle.breakpoints = [sourceBreakpoint('/w/src/main.c', 41)];
            assert.strictEqual(await textAnswer(handlerFor(idle).handleListBreakpoints()), 'Breakpoints that are set:\n1. main.c:42\n');
        });

        test('the breakpoints VS Code adopted from the adapter, which extensions do not see, are listed apart, and clear_all says they stay', async () => {
            const head = 'VS Code also holds these, adopted from the debug adapter (GDB break commands, such as those in the launch configuration\'s '
                + 'initCommands): it sends them to the next session and saves them with the workspace, but shows them to extensions only after a window '
                + 'reload, so remove_breakpoint and clear_all_breakpoints cannot reach them; VS Code\'s Breakpoints view can.';
            const x = new ScriptedExecutor();
            x.session = false;
            x.adopted = [
                { path: '/w/RTE/startup_SSE300MPS3.c', line: 53, sessionName: 'Arm-FVP@GDB (launch)' },
                { path: '/w/RTE/startup_SSE300MPS3.c', line: 54, sessionName: 'Arm-FVP@GDB (launch)' },
            ];
            assert.strictEqual(await textAnswer(handlerFor(x).handleListBreakpoints()),
                `${head}\n  startup_SSE300MPS3.c:53 (announced by 'Arm-FVP@GDB (launch)')\n  startup_SSE300MPS3.c:54 (announced by 'Arm-FVP@GDB (launch)')\n`);
            assert.strictEqual(await textAnswer(handlerFor(x).handleClearAllBreakpoints()),
                'Nothing this tool can clear. 2 breakpoint(s) VS Code adopted from the debug adapter stay: only its Breakpoints view removes them '
                + 'before a window reload (list_breakpoints names them).');

            // One that extensions see already (after a reload, or a duplicate of one set through the API) is listed once, in its place.
            x.breakpoints = [sourceBreakpoint('/w/RTE/startup_SSE300MPS3.c', 52), sourceBreakpoint('/w/main.c', 9)];
            assert.strictEqual(await textAnswer(handlerFor(x).handleListBreakpoints()),
                `Breakpoints that are set:\n1. startup_SSE300MPS3.c:53\n2. main.c:10\n${head}\n  startup_SSE300MPS3.c:54 (announced by 'Arm-FVP@GDB (launch)')\n`);
            assert.strictEqual(await textAnswer(handlerFor(x).handleClearAllBreakpoints()),
                'Cleared 2 breakpoint(s) from the model.\n1 breakpoint(s) VS Code adopted from the debug adapter stay: only its Breakpoints view '
                + 'removes them before a window reload (list_breakpoints names them).');
        });
    });

    suite('variables and expressions', () => {
        const focusedOn = (frameId: number | undefined): Partial<HandlerHost> => ({ focusedFrameId: () => frameId });
        const localScope = [{ name: 'Local', variables: [{ name: 'count', value: '3', type: 'int' }] }];

        test('a missing global scope widens to all', async () => {
            const x = new ScriptedExecutor();
            x.getVariables = async (frameId, scope, ms) => {
                x.note('getVariables', frameId, scope, ms);
                return scope === 'global' ? { scopes: [] } : { scopes: localScope };
            };
            const reply = await textAnswer(handlerFor(x, focusedOn(7)).handleGetVariables({ scope: 'global', timeoutMs: 900 }));
            assert.deepStrictEqual(x.argsOf('getVariables'), [[7, 'global', 900], [7, 'all', 900]]);
            assert.ok(reply.startsWith('Note: No dedicated "Global" scope is available from this debug adapter. '
                + 'Showing all available scopes instead. Use evaluate_expression to inspect specific global variables by name.\n\n'
                + 'Variables:\n==========\n\nLocal:\n  count: 3 (int)\n'), reply);

            const none = await textAnswer(handlerFor(x, focusedOn(7)).handleGetVariables({ variableNames: ['nope', 'other'] }));
            assert.strictEqual(none, 'None of the requested variables are in scope: nope, other.\nCall list_variable_names to see what is available here.');
        });

        test('a listing names the scopes left unread; a read by name only when a name was not found', async () => {
            const unread = 'Registers: not read here (expensive over the probe) — read_core_registers reads the core registers.';
            const x = new ScriptedExecutor();
            x.getVariables = async (frameId, scope, ms) => {
                x.note('getVariables', frameId, scope, ms);
                return scope === 'global' ? { scopes: [] } : { scopes: localScope, skipped: ['Registers'] };
            };
            const h = handlerFor(x, focusedOn(7));
            assert.strictEqual(await textAnswer(h.handleListVariableNames({})),
                `Variables in scope (names and types only — use get_variables_values to read values):\n\nLocal:\n  count: int\n\n${unread}\n`);
            assert.strictEqual(await textAnswer(h.handleGetVariables({})), `Variables:\n==========\n\nLocal:\n  count: 3 (int)\n\n${unread}\n`);
            const widened = await textAnswer(h.handleGetVariables({ scope: 'global' }));
            assert.ok(widened.startsWith('Note: No dedicated "Global" scope') && widened.endsWith(`  count: 3 (int)\n\n${unread}\n`), widened);
            assert.strictEqual(await textAnswer(h.handleGetVariables({ variableNames: ['count'] })), 'Variables:\n==========\n\nLocal:\n  count: 3 (int)\n\n',
                'every name found: no line');
            assert.strictEqual(await textAnswer(h.handleGetVariables({ variableNames: ['pc'] })),
                `None of the requested variables are in scope: pc.\nCall list_variable_names to see what is available here.\n${unread}`);
            const some = await textAnswer(h.handleGetVariables({ variableNames: ['count', 'pc'] }));
            assert.ok(some.includes('  count: 3 (int)\n') && some.endsWith(`struct members that are not top-level locals.\n${unread}\n`), some);

            x.getVariablesForFrame = async () => ({ scopes: localScope, skipped: ['Registers'] });
            assert.strictEqual(await textAnswer(h.handleGetFrameVariables({ frameId: 12 })),
                `Variables for frameId=12:\n==========\n\nLocal:\n  count: 3 (int)\n\n${unread}\n`);
            assert.strictEqual(await textAnswer(h.handleGetFrameVariables({ frameId: 12, variableNames: ['xpsr'] })),
                `None of the requested variables are in scope at frameId=12: xpsr.\n${unread}`);
            assert.ok(!(await textAnswer(h.handleGetFrameVariables({ frameId: 12, variableNames: ['count'] }))).includes('not read here'));
        });

        test('the variable tools need a focused frame and scopes', async () => {
            const x = new ScriptedExecutor();
            const unfocused = await refusalOf(handlerFor(x, focusedOn(undefined)).handleListVariableNames({}), 'TARGET_RUNNING');
            assert.strictEqual(errorDetail(unfocused), 'There is no active stack frame.\n'
                + 'Call wait_for_stop, which returns once the target is stopped at a frame, or pause_execution if it is running; then retry.');
            await refusalOf(handlerFor(x, focusedOn(undefined)).handleEvaluateExpression({ expression: 'x' }), 'TARGET_RUNNING');
            assert.strictEqual(await textAnswer(handlerFor(x, focusedOn(0)).handleGetVariables({})),
                'The debug adapter reports no variable scopes at the current execution point.');
            assert.deepStrictEqual(x.argsOf('getVariables'), [[0, 'all', undefined]]);
            x.getVariables = async () => ({ scopes: localScope });
            assert.ok((await textAnswer(handlerFor(x, focusedOn(3)).handleListVariableNames({ scope: 'local' }))).includes('  count: int\n'));
        });

        test('register-only scope replies still explain what was not read', async () => {
            const x = new ScriptedExecutor();
            x.getVariables = async () => ({ scopes: [], skipped: ['Registers'] });
            x.getVariablesForFrame = x.getVariables;
            const h = handlerFor(x, focusedOn(7));
            for (const reply of [await textAnswer(h.handleListVariableNames({})), await textAnswer(h.handleGetVariables({})),
                await textAnswer(h.handleGetFrameVariables({ frameId: 12 }))]) {
                assert.ok(reply.includes('Registers: not read here'), reply);
                assert.ok(reply.includes('read_core_registers'), reply);
            }
        });

        test('evaluate redacts by name, leaves -exec alone and shows the type', async () => {
            const x = new ScriptedExecutor();
            x.evaluateExpression = async (expression) => expression === 'apiKey'
                ? { result: '"k3y-value-123"', type: 'char *' }
                : { result: 'ghp_abcdefghijklmnopqrstuv0123' };
            const h = handlerFor(x, focusedOn(4));
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: 'apiKey' })),
                `Evaluated: apiKey\nResult: <redacted: possible secret>\nType: char *\n\n${REDACTION_NOTICE}`);
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: '  -exec info registers' })),
                'Evaluated:   -exec info registers\nResult: ghp_abcdefghijklmnopqrstuv0123');
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: '>info registers' })),
                'Evaluated: >info registers\nResult: ghp_abcdefghijklmnopqrstuv0123', 'the > spelling is a GDB command too');
            x.evaluateExpression = async () => ({ result: '' });
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: '-exec set var x = 1' })),
                'Evaluated: -exec set var x = 1\nResult: (GDB printed nothing)');
            x.evaluateExpression = async () => ({ result: undefined });
            assert.strictEqual((await refusalOf(h.handleEvaluateExpression({ expression: 'x' }), 'INTERNAL')).message,
                'The debug adapter returned no result for this expression.');
            x.evaluateExpression = async () => ({ result: 42, type: 'int' });
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: 'x' })), 'Evaluated: x\nResult: 42\nType: int');
        });

        test('evaluate shows the fields of a struct under the result, one level unless depth says more, redacted like variables', async () => {
            const x = new ScriptedExecutor();
            x.evaluateExpression = async (expression) => ({ result: '{...}', type: 'led_config_t', variablesReference: expression === 'password' ? 9 : 7 });
            x.childrenOf = {
                7: [
                    { name: 'period_ms', value: '500', type: 'uint32_t' },
                    { name: 'timing', value: '{...}', type: 'timing_t', variablesReference: 8 },
                    { name: 'secret', value: '"s3cr3t-value"', type: 'char [13]', variablesReference: 9 },
                ],
                8: [{ name: 'on_ms', value: '20', type: 'uint16_t' }],
                9: [{ name: '[0]', value: "115 's'", type: 'char' }],
            };
            const h = handlerFor(x, focusedOn(4));
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: 'config', timeoutMs: 800 })),
                'Evaluated: config\nResult: {...}\nType: led_config_t\nFields:\n  period_ms: 500 (uint32_t)\n  timing: {...} (timing_t)\n'
                + `  secret: <redacted: possible secret> (char [13])\n\n${REDACTION_NOTICE}`);
            assert.deepStrictEqual(x.argsOf('getVariableChildren'), [[7, 800]], 'one level, under the call\'s timeout');
            const deeper = await textAnswer(h.handleEvaluateExpression({ expression: 'config', depth: 2 }));
            assert.ok(deeper.includes('  timing: {...} (timing_t)\n    on_ms: 20 (uint16_t)\n  secret:'), deeper);
            assert.deepStrictEqual(x.argsOf('getVariableChildren').slice(1).map((call) => call[0]), [7, 8], 'the withheld field stays closed');
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: 'config', depth: 0 })),
                'Evaluated: config\nResult: {...}\nType: led_config_t', 'depth 0: the value only');
            assert.strictEqual(x.argsOf('getVariableChildren').length, 3, 'depth 0 opens nothing');

            await textAnswer(h.handleEvaluateExpression({ expression: 'password' }));
            assert.deepStrictEqual(x.argsOf('getVariableChildren').length, 3, 'a credential-named expression is not opened');
            x.evaluateExpression = async () => ({ result: 'text', variablesReference: 7 });
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: '-exec print config' })),
                'Evaluated: -exec print config\nResult: text', 'a GDB command has no fields');
        });

        test('frame variables use the given frame', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x, focusedOn(undefined));
            assert.strictEqual(await textAnswer(h.handleGetFrameVariables({ frameId: 12 })), 'No variable scopes available for frameId=12.');
            x.getVariablesForFrame = async () => ({ scopes: localScope });
            assert.strictEqual(await textAnswer(h.handleGetFrameVariables({ frameId: 12, variableNames: ['zz'] })),
                'None of the requested variables are in scope at frameId=12: zz.');
            assert.ok((await textAnswer(h.handleGetFrameVariables({ frameId: 12 }))).startsWith('Variables for frameId=12:\n==========\n\nLocal:\n  count: 3 (int)'));
        });
    });

    suite('raw target reads', () => {
        test('memory dump: header, hex rows and ASCII block', async () => {
            const x = new ScriptedExecutor();
            const bytes = Buffer.from('Hello, Cortex-M!\x00\x01ab', 'latin1');
            x.readMemory = async () => ({ bytes, offset: 0 });
            const reply = await textAnswer(handlerFor(x).handleReadMemory({ address: '0x20000000', length: 20, format: 'both' }));
            assert.strictEqual(reply, 'Memory at 0x20000000 (20 bytes):\n'
                + '\nHex:\n  0x20000000: 48 65 6c 6c 6f 2c 20 43 6f 72 74 65 78 2d 4d 21\n  0x20000010: 00 01 61 62\n'
                + '\nASCII:\n  Hello, Cortex-M!..ab\n');
        });

        test('an address expression is read where GDB says it points; one GDB cannot place is refused with the way to pass one', async () => {
            const x = new ScriptedExecutor();
            const readAt: string[] = [];
            x.readMemory = async (address) => {
                readAt.push(address);
                return { bytes: Buffer.from([1, 2, 3, 4]), offset: 0 };
            };
            x.evaluateExpression = async (expression, frameId) => {
                x.calls.push(['evaluateExpression', expression, frameId]);
                if (expression === '(unsigned long)(&bulkOutBuffer)') {
                    return { result: '536871168' };
                }
                if (expression === '(unsigned long)(usbState)') {
                    return { result: '{state = 2, address = 5}' };
                }
                throw new Error('No symbol "zz" in current context.');
            };
            const atFrame = { focusedFrameId: () => 1 };
            // Kimi Code's call: read_memory {address: "&bulkOutBuffer"} failed with "Cannot convert 0x&bulkOutBuffer to a BigInt".
            assert.strictEqual(await textAnswer(handlerFor(x, atFrame).handleReadMemory({ address: '&bulkOutBuffer', length: 4, format: 'hex' })),
                'Memory at 0x20000100 = &bulkOutBuffer (4 bytes):\n\nHex:\n  0x20000100: 01 02 03 04\n');
            assert.deepStrictEqual(readAt, ['0x20000100']);
            assert.deepStrictEqual(x.calls.find((call) => call[0] === 'evaluateExpression'), ['evaluateExpression', '(unsigned long)(&bulkOutBuffer)', 1],
                'in the focused frame');
            const unknown = await refusalOf(handlerFor(x, atFrame).handleReadMemory({ address: 'zz', length: 4 }), 'INVALID_ARGUMENT');
            assert.strictEqual(unknown.message, 'Cannot read memory at "zz": it is no hex address, and GDB found no address for it. GDB: No symbol "zz" in current context.');
            assert.ok(unknown.hint?.startsWith('Pass a hex address such as 0x20000000, or an expression for one such as &buffer'), unknown.hint);
            const struct = await refusalOf(handlerFor(x, atFrame).handleReadMemory({ address: 'usbState', length: 4 }), 'INVALID_ARGUMENT');
            assert.ok(struct.message.endsWith('GDB gave "{state = 2, address = 5}".'), struct.message);
            assert.deepStrictEqual(readAt, ['0x20000100'], 'no read without an address');
            // Without a focused frame the expression cannot be placed: the same refusal as evaluate_expression's.
            await refusalOf(handlerFor(x, { focusedFrameId: () => undefined }).handleReadMemory({ address: '&bulkOutBuffer', length: 4 }), 'TARGET_RUNNING');
        });

        test('sideEffectOf finds what writes and lets reads, casts and comparisons through', () => {
            for (const read of ['&buffer', 'buffer', '&s.field', '&s->rx[3]', 'ptr->data', '*pp', '(uint8_t *)ptr + 4',
                '(uint8_t *)(base + 4)', '(unsigned long)(&buf)', '*(uint32_t *)0xE000ED28', '&table[sizeof(int)]',
                'p != 0 ? p : q', 'a <= b', 'a == b', 'buf - -1', '{int} 0x20000000', '$sp', "'a'"]) {
                assert.strictEqual(sideEffectOf(read), undefined, read);
            }
            for (const [write, effect] of [
                ['x = 1', 'an assignment (=)'], ['x<<=1', 'an assignment (<<=)'], ['x |= 1', 'an assignment (|=)'],
                ['*p++', 'an increment or decrement'], ['--n', 'an increment or decrement'],
                ['f(1)', 'a call of f()'], ['s->cb ()', 'a call of cb()'], ['$_strlen(name)', 'a call of $_strlen()'],
                ['fns[1](2)', 'a function call'], ['(*fp)()', 'a function call'], ['(s.cb)(1)', 'a function call'],
                ['(&buf, x = 2)', 'an assignment (=)'], ['"abc"', 'a string literal'],
            ]) {
                assert.strictEqual(sideEffectOf(write), effect, write);
            }
            assert.ok(isAddressLiteral('0xface') && isAddressLiteral('20000000') && isAddressLiteral('2000BEEF'));
            assert.ok(!isAddressLiteral('face') && !isAddressLiteral('&buf') && !isAddressLiteral('0x'));
        });

        test('an address expression that would write is refused before GDB sees it; a word of hex letters is a name (K05)', async () => {
            const x = new ScriptedExecutor();
            const readAt: string[] = [];
            x.readMemory = async (address) => {
                readAt.push(address);
                return { bytes: Buffer.from([1, 2, 3, 4]), offset: 0 };
            };
            x.evaluateExpression = async (expression, frameId) => {
                x.calls.push(['evaluateExpression', expression, frameId]);
                if (expression === '(unsigned long)(face)') {
                    return { result: '536871168' };
                }
                throw new Error('No symbol "dead" in current context.');
            };
            const atFrame = { focusedFrameId: () => 1 };
            for (const [address, effect] of [
                ['ptr = 0', 'an assignment (=)'],
                ['mutate()', 'a call of mutate()'],
                ['buf[i++]', 'an increment or decrement'],
                ['count += 4', 'an assignment (+=)'],
                ['(*handler)()', 'a function call'],
                ['(char *)"text"', 'a string literal'],
            ]) {
                const refusal = await refusalOf(handlerFor(x, atFrame).handleReadMemory({ address, length: 4 }), 'INVALID_ARGUMENT');
                assert.strictEqual(refusal.message, `Cannot read memory at "${address}": it has ${effect}, and evaluating it would change the target.`);
            }
            assert.deepStrictEqual(x.calls.filter((call) => call[0] === 'evaluateExpression'), [], 'nothing reached GDB');
            assert.deepStrictEqual(readAt, []);
            // `face` is the pointer of that name, not the address 0xface.
            assert.strictEqual(await textAnswer(handlerFor(x, atFrame).handleReadMemory({ address: 'face', length: 4, format: 'hex' })),
                'Memory at 0x20000100 = face (4 bytes):\n\nHex:\n  0x20000100: 01 02 03 04\n');
            const unknown = await refusalOf(handlerFor(x, atFrame).handleReadMemory({ address: 'dead', length: 4 }), 'INVALID_ARGUMENT');
            assert.ok(unknown.hint?.startsWith('For the address 0xdead, write the 0x. Pass a hex address'), unknown.hint);
            // Hex digits that start with a decimal digit stay an address, as before.
            await textAnswer(handlerFor(x, atFrame).handleReadMemory({ address: '2000beef', length: 4 }));
            assert.deepStrictEqual(readAt, ['0x20000100', '2000beef']);
        });

        test('a partial read labels its rows from the first byte read and names the part that could not be read', async () => {
            const x = new ScriptedExecutor();
            const bytes = Buffer.from('Hello, Cortex-M!\x00\x01ab', 'latin1');
            x.readMemory = async () => ({ bytes: bytes.subarray(0, 4), offset: 0 });
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadMemory({ address: '0x20000000', length: 20, format: 'hex' })),
                'Memory at 0x20000000 (20 bytes):\nRead 4 of 20 bytes: 0x20000004–0x20000013 could not be read.\n'
                + '\nHex:\n  0x20000000: 48 65 6c 6c\n', 'the end of the range');
            // cdt-gdb-adapter's reply when the range starts in a hole: GDB's first readable block, 16 bytes in.
            x.readMemory = async () => ({ bytes, offset: 16 });
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadMemory({ address: '0x1FFFFFF0', length: 36, format: 'both' })),
                'Memory at 0x1FFFFFF0 (36 bytes):\nRead 20 of 36 bytes: 0x1ffffff0–0x1fffffff could not be read.\n'
                + '\nHex:\n  0x20000000: 48 65 6c 6c 6f 2c 20 43 6f 72 74 65 78 2d 4d 21\n  0x20000010: 00 01 61 62\n'
                + '\nASCII:\n  Hello, Cortex-M!..ab\n', 'the start of the range');
            x.readMemory = async () => ({ bytes: bytes.subarray(0, 16), offset: 16 });
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadMemory({ address: '0x1ffffff0', length: 64, format: 'ascii' })),
                'Memory at 0x1ffffff0 (64 bytes):\nRead 16 of 64 bytes: 0x1ffffff0–0x1fffffff and 0x20000010–0x2000002f could not be read.\n'
                + '\nASCII:\n  Hello, Cortex-M!\n', 'both ends');
        });

        test('a long ASCII block breaks after every 64 characters', async () => {
            const x = new ScriptedExecutor();
            x.readMemory = async () => ({ bytes: Buffer.alloc(70, 0x41), offset: 0 });
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadMemory({ address: '0x0', length: 70, format: 'ascii' })),
                `Memory at 0x0 (70 bytes):\n\nASCII:\n  ${'A'.repeat(64)}\n  AAAAAA\n`);
        });

        test('core registers are normalised and laid out in fixed cells', async () => {
            const x = new ScriptedExecutor();
            x.registers = {
                r0: '536870912', r1: '0x8000123 <main+4>', r2: '0X1F <x>', r3: '-7', r4: '', r6: '0', r7: '1', r8: '2', r9: '3',
                r10: '4', r11: '5', r12: '6', sp: '0x20017fd0', lr: '134218161', pc: '0x80002fe <main+22>',
                xpsr: '[ Z C ]', msp: '0x20017fd0', psp: '0x0', control: '0', faultmask: '0', basepri: '0', primask: '1',
            };
            const reply = await textAnswer(handlerFor(x).handleReadCoreRegisters());
            const cell = (name: string, value: string): string => `${name.padEnd(4)}= ${value.padEnd(14)}`;
            assert.strictEqual(reply, 'Core Registers:\n'
                + `  ${cell('r0', '0x20000000')}${cell('r1', '0x8000123')}${cell('r2', '0x1F')}${cell('r3', '0xfffffff9')}\n`
                + `  ${cell('r4', '<?>')}${cell('r5', '<?>')}${cell('r6', '0x00000000')}${cell('r7', '0x00000001')}\n`
                + `  ${cell('r8', '0x00000002')}${cell('r9', '0x00000003')}${cell('r10', '0x00000004')}${cell('r11', '0x00000005')}\n`
                + `  ${cell('r12', '0x00000006')}${cell('sp', '0x20017fd0')}${cell('lr', '0x080001b1')}${cell('pc', '0x80002fe')}\n`
                + '  xpsr = [ Z C ]\n  msp  = 0x20017fd0\n  psp  = 0x0\n  control   = 0\n'
                + '  faultmask = 0x00000000\n  basepri   = 0x00000000\n  primask   = 0x00000001\n');
            assert.deepStrictEqual(x.argsOf('readCoreRegisters'), [[undefined, undefined]]);
        });

        test('registers the GDB server does not report (the Arm FVP: GDB says void) read as such; in Handler mode MSP is the SP', async () => {
            const x = new ScriptedExecutor();
            const fvp = (xpsr: string): Record<string, string> => ({
                r0: '0', r1: '0', r2: '0', r3: '0', r4: '0', r5: '0', r6: '0', r7: '0', r8: '0', r9: '0', r10: '0', r11: '0', r12: '0',
                sp: '0x2005ffb0', lr: '-7', pc: '0x1000219e <HardFault_Handler+2>', xpsr,
                msp: 'void', psp: 'void', control: 'void', faultmask: 'void', basepri: 'void', primask: 'void',
            });
            x.registers = fvp('1627389955');
            const handler = await textAnswer(handlerFor(x).handleReadCoreRegisters());
            assert.ok(handler.endsWith('  xpsr = 1627389955\n'
                + '  msp  = 0x2005ffb0 (the SP: Handler mode runs on the MSP; the GDB server does not report msp)\n'
                + '  psp  = <not reported by the GDB server>\n  control   = <not reported by the GDB server>\n'
                + '  faultmask = <not reported by the GDB server>\n  basepri   = <not reported by the GDB server>\n'
                + '  primask   = <not reported by the GDB server>\n'), handler);
            assert.ok(!handler.includes('void'), handler);

            x.registers = fvp('16777216');
            const thread = await textAnswer(handlerFor(x).handleReadCoreRegisters());
            assert.ok(thread.includes('\n  msp  = <not reported by the GDB server>\n'), 'in Thread mode the SP may be the PSP');
        });

        test('diagnose_fault reads the frame at the SP in Handler mode when the GDB server does not report msp', async () => {
            const x = new ScriptedExecutor();
            x.registers = { sp: '0x20017fa8', lr: '-7', pc: '0x080001a4 <HardFault_Handler>', xpsr: '1627389955',
                msp: 'void', psp: 'void', control: 'void', msplim: 'void', psplim: 'void' };
            const reply = await textAnswer(handlerFor(x).handleDiagnoseFault());
            assert.match(reply, /\nException frame: MSP @ 0x20017fa8 /);
            assert.deepStrictEqual(x.argsOf('readExceptionFrame')[0]?.[0], 0x20017fa8);
        });

        test('a register unavailable on the CMSIS Debugger: one DHCSR read, and when the core does not answer, why and how to reconnect (#3)', async () => {
            const names = ['r0', 'sp', 'lr', 'pc'];
            const unavailable = Object.fromEntries(names.map((name) => [name, '<unavailable>']));
            const x = new ScriptedExecutor();
            x.registers = unavailable;
            x.activeSession = { configuration: { request: 'launch' } };
            (x.activeSession as { type?: string }).type = 'gdbtarget';
            const table = await textAnswer(handlerFor(x).handleReadCoreRegisters({ timeoutMs: 4000 }));
            assert.ok(table.startsWith('Core Registers:\n') && !table.includes('DHCSR'), 'a core that answers leaves the table as it is');

            x.debugPort = { readable: false, timedOut: false, cause: 'Unable to read memory. (@ 0xe000edf0)' };
            const reply = await textAnswer(handlerFor(x).handleReadCoreRegisters({ timeoutMs: 4000 }));
            assert.strictEqual(reply, `${table}Every register is unavailable: the core does not answer (DHCSR at 0xE000EDF0 unreadable: `
                + `Unable to read memory. (@ 0xe000edf0)): memory and register reads will fail with PROBE_WEDGED.\n${wedgeHint('launch')}\n`);
            assert.deepStrictEqual(x.argsOf('probeDebugPort'), [[4000], [4000]], 'one DHCSR read per call');

            x.debugPort = { readable: false, timedOut: true, cause: 'timed out' };
            assert.ok((await textAnswer(handlerFor(x).handleReadCoreRegisters())).includes('(DHCSR at 0xE000EDF0 timed out)'));
            x.debugPort = { readable: false, timedOut: false, cause: 'unrecognized request' };
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadCoreRegisters({ timeoutMs: 4000 })), table,
                'an adapter that cannot read DHCSR adds nothing');

            // A board that lost power (B-L475E-IOT01A, pyOCD): GDB still has the registers it read at the last stop, the rest come back
            // `<unavailable>` or without text.
            x.debugPort = { readable: false, timedOut: false, cause: 'Unable to read memory. (@ 0xe000edf0)' };
            x.registers = { r0: '<unavailable>', sp: '0x200098c8', lr: '134218335', pc: '' };
            const partial = await textAnswer(handlerFor(x).handleReadCoreRegisters());
            assert.ok(partial.includes('2 of 4 registers are unavailable: the core does not answer (DHCSR at 0xE000EDF0 unreadable: '
                + 'Unable to read memory. (@ 0xe000edf0)): memory and register reads will fail with PROBE_WEDGED. '
                + 'The values shown may be GDB\'s copies from before it lost the target.\n'), partial);

            const calls = x.argsOf('probeDebugPort').length;
            x.registers = { r0: '0x0', sp: '0x200098c8', lr: '134218335', pc: '0x080002fe <main+22>' };
            await textAnswer(handlerFor(x).handleReadCoreRegisters());
            x.registers = Object.fromEntries(names.map((name) => [name, '<timeout>']));
            await textAnswer(handlerFor(x).handleReadCoreRegisters());
            x.registers = unavailable;
            x.activeSession = { configuration: { request: 'launch' } };
            await textAnswer(handlerFor(x).handleReadCoreRegisters());
            assert.strictEqual(x.argsOf('probeDebugPort').length, calls,
                'not read when every register answered or timed out, or on other debug types');
        });

        test('cycle counter, present or not', async () => {
            const x = new ScriptedExecutor();
            x.readCycleCounter = async () => ({ cycles: 0, enabledNow: false, present: false });
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadCycleCounter()),
                'This core has no DWT cycle counter (none on Armv6-M and Armv8-M Baseline cores such as Cortex-M0, M0+ and M23; '
                + 'elsewhere DWT_CTRL.NOCYCCNT=1) — read_cycle_counter is unavailable. '
                + 'Use an RTOS tick or a timer peripheral for timing instead.');
            x.readCycleCounter = async () => ({ cycles: 255, enabledNow: true, present: true });
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadCycleCounter()), 'DWT cycle counter: 255 (0x000000ff)\n'
                + 'DWT was enabled during this call — deltas are valid from now.\n'
                + 'Wrap: 32-bit, wraps every 2^32 cycles (~10.7 s @ 400 MHz) — for longer spans, sample repeatedly and accumulate.\n'
                + 'Note: CYCCNT stops while the core is halted and during WFE sleep — it counts ACTIVE cycles only.\n'
                + 'To time a region: read here, continue_execution / wait_for_stop to the end point, read again, subtract (mod 2^32).');
        });

        test('peripheral registers and fault info pass the executor text through', async () => {
            const x = new ScriptedExecutor();
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadPeripheralRegister({ peripheral: 'RCC' })), 'peripheral text');
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetFaultInfo()), 'fault text');
        });
    });

    suite('fault diagnosis and SVD lookups', () => {
        test('diagnose_fault degrades section by section', async () => {
            const x = new ScriptedExecutor();
            x.failures.readCoreRegisters = new Error('registers timed out');
            const reply = await textAnswer(handlerFor(x).handleDiagnoseFault());
            assert.ok(reply.startsWith('=== Fault diagnosis ==='), reply);
            assert.ok(reply.includes('Exception frame: LR unavailable — read_core_registers, then read_memory at PSP/MSP'), reply);
            assert.ok(reply.includes('Skipped (timeout or read failure): core registers —'), reply);
            assert.ok(reply.includes('Note: no SVD found — addresses are classified by the Cortex-M system map only; '
                + 'pass svdFile to lookup_peripheral to resolve them'), reply);
            assert.deepStrictEqual(x.argsOf('readExceptionFrame'), []);
            assert.deepStrictEqual(x.argsOf('getCallStack'), [[undefined, 3, undefined]]);
            assert.deepStrictEqual(x.argsOf('readCoreRegisters'),
                [[undefined, ['sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'msplim', 'psplim']]]);

            const y = new ScriptedExecutor();
            y.registers = { sp: '0x20001000', lr: '-7', pc: '0x08000100', msp: '0x20001000', psp: '0x0' };
            y.getCallStack = async (threadId, levels, ms) => {
                y.note('getCallStack', threadId, levels, ms);
                throw new Error('no stack');
            };
            const noStack = await textAnswer(handlerFor(y).handleDiagnoseFault({ levels: 5, timeoutMs: 4000 }));
            assert.ok(noStack.includes('Skipped (timeout or read failure): call stack —'), noStack);
            assert.deepStrictEqual(y.argsOf('getCallStack'), [[undefined, 5, 4000]]);
        });

        test('a wedged probe is the answer of get_fault_info and diagnose_fault, not a partial diagnosis (#3)', async () => {
            const wedged = new ToolError('PROBE_WEDGED', 'Memory reads fail and the debug port does not answer (DHCSR at 0xE000EDF0 unreadable: E01).',
                wedgeHint('launch'));
            const x = new ScriptedExecutor();
            x.getFaultInfo = async () => {
                throw wedged;
            };
            x.readFaultRegisters = async () => {
                throw wedged;
            };
            assert.strictEqual((await refusalOf(handlerFor(x).handleGetFaultInfo(), 'PROBE_WEDGED')).message, wedged.message);
            const diagnosed = await refusalOf(handlerFor(x).handleDiagnoseFault(), 'PROBE_WEDGED');
            assert.strictEqual(diagnosed.hint, wedgeHint('launch'));
            assert.deepStrictEqual(x.argsOf('readCoreRegisters'), [], 'nothing is read after the wedge');

            const y = new ScriptedExecutor();
            y.registers = { sp: '0x20001000', lr: '0xfffffff9', pc: '0x080001a4', msp: '0x20001000', psp: '0x0' };
            y.readExceptionFrame = async () => {
                throw wedged;
            };
            assert.strictEqual((await refusalOf(handlerFor(y).handleDiagnoseFault(), 'PROBE_WEDGED')).message, wedged.message,
                'a wedge in the frame read ends the call as well');
            y.readExceptionFrame = async () => {
                throw new ToolError('INVALID_ARGUMENT', 'Cannot read 0x20001000 — the debug port answers, the address is not readable in this state: x');
            };
            assert.ok((await textAnswer(handlerFor(y).handleDiagnoseFault())).includes('Skipped (timeout or read failure): exception frame'),
                'an unreadable frame still degrades to a note');
        });

        test('a core in lockup says so in get_fault_info and diagnose_fault (#3)', async () => {
            const x = new ScriptedExecutor();
            x.debugPort = { readable: true, dhcsr: 0x000b0003 };
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetFaultInfo()), `fault text\n${LOCKUP_NOTE}\n`);
            const diagnosis = await textAnswer(handlerFor(x).handleDiagnoseFault());
            assert.ok(diagnosis.includes(`\nLockup: ${LOCKUP_NOTE}\n`), diagnosis);
            x.debugPort = { readable: false, timedOut: true, cause: 'timed out' };
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetFaultInfo()), 'fault text', 'an unreadable DHCSR adds nothing');
            assert.strictEqual(x.argsOf('probeDebugPort').length, 3);
        });

        test('an EXC_RETURN in LR reads the stacked frame', async () => {
            const x = new ScriptedExecutor();
            x.registers = { sp: '0x20001000', lr: '0xfffffff9', pc: '0x080001a4', xpsr: '1627389955', msp: '0x20001000', psp: '0x0' };
            const frame = Buffer.alloc(32);
            frame.writeUInt32LE(0x0800027a, 24);
            x.readExceptionFrame = async (sp, ms) => {
                x.note('readExceptionFrame', sp, ms);
                return frame;
            };
            x.getCallStack = async () => [{ name: 'HardFault_Handler' }, { name: 'led_toggle', source: '/w/led.c', line: 18, frameId: 1002 }];
            const reply = await textAnswer(handlerFor(x).handleDiagnoseFault());
            assert.deepStrictEqual(x.argsOf('readExceptionFrame'), [[0x20001000, undefined]]);
            assert.ok(reply.includes('Exception frame: MSP @ 0x20001000 (EXC_RETURN 0xfffffff9)'), reply);
            assert.ok(reply.includes('  #1 led_toggle @ /w/led.c:18 [frameId=1002]'), reply);

            x.readExceptionFrame = async () => Buffer.alloc(16);
            assert.ok((await textAnswer(handlerFor(x).handleDiagnoseFault())).includes('Exception frame: short read at MSP'));
            x.registers = { lr: '0xfffffffd', msp: '0x20001000' };
            assert.ok((await textAnswer(handlerFor(x).handleDiagnoseFault())).includes('Exception frame: PSP unavailable — read_core_registers'));
            assert.deepStrictEqual(x.argsOf('readCoreRegisters').map(([, names]) => (names as string[])[0]), ['sp', 'sp', 'sp'],
                'a frame on the current state\'s stack reads no banked register');
        });

        test('an LR and xPSR that GDB prints as signed decimals (int registers) decode like hex', async () => {
            // J-Link and pyOCD type lr and xpsr as int: EXC_RETURN 0xfffffff9 arrives as "-7", 0xfffffffd as "-3" (a tester's XMC4700 run).
            const x = new ScriptedExecutor();
            x.registers = { sp: '0x200299b8', lr: '-3', pc: '0x8000460', xpsr: '1090519046', msp: '0x200299b8', psp: '0x20007db0' };
            const frame = Buffer.alloc(32);
            frame.writeUInt32LE(0x08007169, 20);
            frame.writeUInt32LE(0x00000000, 24);
            x.readExceptionFrame = async (sp, ms) => {
                x.note('readExceptionFrame', sp, ms);
                return frame;
            };
            const reply = await textAnswer(handlerFor(x).handleDiagnoseFault());
            assert.deepStrictEqual(x.argsOf('readExceptionFrame'), [[0x20007db0, undefined]], 'EXC_RETURN 0xfffffffd selects PSP');
            assert.ok(reply.includes('Exception frame: PSP @ 0x20007db0 (EXC_RETURN 0xfffffffd)'), reply);
            assert.ok(reply.includes('PC=0x00000000'), reply);
            assert.ok(!reply.includes('LR unavailable'), reply);

            const y = new ScriptedExecutor();
            y.registers = { sp: '0x20029a28', lr: '-7', pc: '0x8000480', xpsr: '-1593835515', msp: '0x20029a28', psp: '0x0' };
            const stacked = await textAnswer(handlerFor(y).handleDiagnoseFault());
            assert.deepStrictEqual(y.argsOf('readExceptionFrame'), [[0x20029a28, undefined]], 'EXC_RETURN 0xfffffff9 selects MSP');
            assert.ok(stacked.includes('Exception frame: MSP @ 0x20029a28 (EXC_RETURN 0xfffffff9)'), stacked);
        });

        test('a frame on the other Security state\'s stack is read through that state\'s banked stack pointer', async () => {
            const x = new ScriptedExecutor();
            // A Non-secure handler whose frame Secure thread code pushed on PSP_S; MSP and PSP are the Non-secure ones.
            x.registers = {
                sp: '0x20001000', lr: '0xfffffff8', pc: '0x080001a4', msp: '0x20001000', psp: '0x0',
                msp_s: '0x30000f00', psp_s: '0x3000ff00', control_s: '2',
            };
            const stacked = Buffer.alloc(0x48);
            stacked.writeUInt32LE(0xFEFA125B, 0);
            stacked.writeUInt32LE(0x10000a3c, 0x28 + 24);
            x.readExceptionFrame = async (sp, ms, stateOffset) => {
                x.note('readExceptionFrame', sp, ms, stateOffset);
                return stacked;
            };
            const reply = await textAnswer(handlerFor(x).handleDiagnoseFault());
            assert.deepStrictEqual(x.argsOf('readCoreRegisters'), [
                [undefined, ['sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'msplim', 'psplim']],
                [undefined, ['msp_s', 'psp_s', 'control_s']],
            ]);
            assert.deepStrictEqual(x.argsOf('readExceptionFrame'), [[0x3000ff00, undefined, 0x28]]);
            assert.ok(reply.includes('Exception frame: PSP_S @ 0x3000ff00, R0 at +0x28 after the integrity signature and R4–R11 (EXC_RETURN 0xfffffff8)'), reply);
            assert.ok(reply.includes('  PC=0x10000a3c ← faulting instruction'), reply);
            assert.ok(!reply.includes('Integrity signature'), reply);

            // A GDB server without the banked registers: the frame is not read from the wrong state's MSP or PSP.
            const y = new ScriptedExecutor();
            y.registers = { sp: '0x20001000', lr: '0xfffffff8', pc: '0x080001a4', msp: '0x20001000', psp: '0x0', msp_s: 'void', psp_s: 'void', control_s: 'void' };
            const unreported = await textAnswer(handlerFor(y).handleDiagnoseFault());
            assert.deepStrictEqual(y.argsOf('readExceptionFrame'), []);
            assert.ok(unreported.includes('Exception frame: on MSP_S or PSP_S, as CONTROL_S selects, which the GDB server did not report — '
                + 'MSP and PSP are the Non-secure state\'s (EXC_RETURN 0xfffffff8)'), unreported);
        });

        test('lookup_peripheral: address first, then name, then the list', async () => {
            const h = handlerFor(new ScriptedExecutor());
            const byAddress = await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD, address: '0x40023800', name: 'GPIOA' }));
            assert.ok(byAddress.startsWith('0x40023800 = RCC.CR'), byAddress);
            assert.strictEqual(await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD, address: 'zz' })),
                '\'zz\' is not an address — pass hex like 0x40005400 or a decimal number.');
            assert.strictEqual(await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD, name: 'RCX' })),
                'Peripheral \'RCX\' is not in the SVD of TESTDEVICE. Did you mean: RCC?\nCall lookup_peripheral without name for the full list.');
            assert.ok((await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD, name: 'gpioa' }))).startsWith('=== GPIOA @ 0x40020000 ==='));
            assert.ok((await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD }))).startsWith('TESTDEVICE: 5 peripherals'));
        });

        test('lookup_register names what is missing', async () => {
            const h = handlerFor(new ScriptedExecutor());
            assert.strictEqual(await textAnswer(h.handleLookupRegister({ svdFile: FIXTURE_SVD, peripheral: 'RCC', register: 'CRX' })),
                'Register \'CRX\' is not in RCC. Did you mean: CR?\nCall lookup_peripheral { name: \'RCC\' } for its register map.');
            assert.ok((await textAnswer(h.handleLookupRegister({ svdFile: FIXTURE_SVD, peripheral: 'rcc', register: 'cr' }))).startsWith('=== RCC.CR @ 0x40023800'));
            const missing = await textAnswer(h.handleLookupRegister({ svdFile: '/nonexistent/device.svd', peripheral: 'RCC', register: 'CR' }));
            // The lookup normalises the path, so Windows reports it with backslashes.
            assert.ok(missing.startsWith(`No SVD file found for a lookup.\nTried:\n  - svdFile ${path.normalize('/nonexistent/device.svd')} (not found)`), missing);
            assert.ok(missing.endsWith('Pass svdFile (the device .svd from the DFP; ${CMSIS_PACK_ROOT} is expanded), '
                + 'or build the solution so out/<context>.cbuild-run.yml names it, or add "svdFile" to the launch configuration. '
                + 'For a multi-core device pass pname to pick the core.'), missing);
        });

        test('the lookups and diagnose_fault take the SVD of the executor\'s session, focused or not', async () => {
            // The test host focuses no session; the executor acts on the tracked one, whose launch configuration names the SVD.
            const x = new ScriptedExecutor();
            x.activeSession = { name: 'CMSIS Debugger: pyOCD', configuration: { request: 'launch', svdFile: FIXTURE_SVD } };
            x.readFaultRegisters = async () => ({ CFSR: 0x00008200, HFSR: 0x40000000, DFSR: 0, MMFAR: 0, BFAR: 0x40023800, AFSR: 0 });
            const h = handlerFor(x);
            assert.ok((await textAnswer(h.handleLookupPeripheral())).startsWith('TESTDEVICE: 5 peripherals'));
            assert.ok((await textAnswer(h.handleLookupRegister({ peripheral: 'RCC', register: 'CR' }))).startsWith('=== RCC.CR @ 0x40023800'));
            const diagnosis = await textAnswer(h.handleDiagnoseFault());
            assert.ok(diagnosis.includes('\nFault address (BFAR): 0x40023800 = RCC.CR ('), diagnosis);
            assert.ok(!diagnosis.includes('no SVD found'), diagnosis);
        });
    });

    suite('stack, threads, status, device and connection', () => {
        test('call stack: default cut, explicit depth, and frame details', async () => {
            const x = new ScriptedExecutor();
            x.getCallStack = async (threadId, levels, ms) => {
                x.note('getCallStack', threadId, levels, ms);
                return frames(25);
            };
            const cut = (await textAnswer(handlerFor(x).handleGetCallStack({ threadId: 2 }))).split('\n');
            assert.strictEqual(cut[0], 'Call stack (25 frames):');
            assert.strictEqual(cut[1], '  # 0  fn0  @ /w/f0.c:1 [frameId=1000]');
            assert.strictEqual(cut[20], '  #19  fn19  @ /w/f19.c:20 [frameId=1019]');
            assert.deepStrictEqual(cut.slice(21), ['  … 5 more frames — pass levels to see all', '',
                'Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.']);
            assert.deepStrictEqual(x.argsOf('getCallStack'), [[2, 50, undefined]]);
            const all = (await textAnswer(handlerFor(x).handleGetCallStack({ levels: 30 }))).split('\n');
            assert.strictEqual(all.length, 1 + 25 + 2);

            x.getCallStack = async () => [{ name: 'Reset_Handler' }];
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetCallStack({})),
                'Call stack (1 frame):\n  # 0  Reset_Handler  @ <no source>:?\n\n'
                + 'Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.');
            x.getCallStack = async () => [];
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetCallStack({})), 'No stack frames available.');
        });

        test('threads: top frames and the cut at 32', async () => {
            const x = new ScriptedExecutor();
            x.getThreads = async () => Array.from({ length: 40 }, (_, i): ThreadShape => (i === 0
                ? { id: 1, name: 'app_main', topFrame: { name: 'main', source: '/w/main.c', line: 42 } }
                : { id: i + 1, name: `task${i + 1}` }));
            const lines = (await textAnswer(handlerFor(x).handleGetThreads())).split('\n');
            assert.strictEqual(lines[0], 'Threads / RTOS tasks (40):');
            assert.strictEqual(lines[1], '  [1] app_main  → main @ /w/main.c:42');
            assert.strictEqual(lines[2], '  [2] task2');
            assert.deepStrictEqual(lines.slice(33), ['  … 8 more threads', '', 'Tip: pass a threadId to get_call_stack to inspect a specific task.']);
            x.getThreads = async () => [];
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetThreads()), 'No threads reported by the debug adapter.');
        });

        test('check_target_connection turns a hardware timeout into text', async () => {
            const x = new ScriptedExecutor();
            const timeout = new HardwareTimeoutError('DAP threads', 3000);
            x.checkTargetConnection = async () => {
                throw timeout;
            };
            assert.strictEqual(await textAnswer(handlerFor(x).handleCheckTargetConnection()), `check_target_connection: ${timeout.message}`);
            x.checkTargetConnection = async () => {
                throw new Error('boom');
            };
            assert.strictEqual(await rejectionOf(handlerFor(x).handleCheckTargetConnection()), 'Error checking target connection: boom');
            x.checkTargetConnection = async () => 'No active debug session.';
            assert.strictEqual(await textAnswer(handlerFor(x).handleCheckTargetConnection()), 'No active debug session.');
        });

        test('session status lists what is known and ends with a hint for the state', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = { state: 'stopped', sessionName: 'S', sessionType: 'gdbtarget', configurationName: 'C',
                dapResponsive: true, dapProbeMs: 12, detail: 'Stopped reason: step' };
            x.getDiagnostics = () => ({ serverVersion: '1.2.3', liveSessionCount: 2, liveSessionNames: ['S', 'T'], hasVscodeActiveSession: true });
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetSessionStatus()), 'State: stopped\nSession: S\nType: gdbtarget\nConfiguration: C\n'
                + 'DAP responsive: true (probe 12ms)\nDetail: Stopped reason: step\n'
                + 'Diagnostics: serverVersion=1.2.3, liveSessionsInThisWindow=2 [S, T], vscodeActiveDebugSession=set\n'
                + 'Hint: full inspection (variables, memory, registers) is available.');

            const hints: Array<[StatusShape['state'], string]> = [
                ['no-session', 'Hint: call start_debugging or cmsis_action load_and_debug to attach.'],
                ['initializing', 'Hint: the adapter is still starting or shutting down — wait a moment and retry.'],
                ['running', 'Hint: target is running. Add a breakpoint then continue_execution, or call pause_execution to inspect now.'],
                ['unresponsive', `Hint: probe/GDB server is hung. ${wedgeHint('launch')}`],
            ];
            const withFolder = { workspaceFolders: () => [{ uri: vscode.Uri.file('/w'), name: 'w', index: 0 }] };
            for (const [state, hint] of hints) {
                x.sessionStatus = { state, sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null };
                const text = await textAnswer(handlerFor(x, withFolder).handleGetSessionStatus());
                assert.strictEqual(text, `State: ${state}\nDAP responsive: false\n`
                    + 'Diagnostics: serverVersion=1.2.3, liveSessionsInThisWindow=2 [S, T], vscodeActiveDebugSession=set\n' + hint);
            }
            x.getDiagnostics = () => ({ serverVersion: '1.2.3', liveSessionCount: 0, liveSessionNames: [], hasVscodeActiveSession: false });
            x.sessionStatus = { state: 'no-session', sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null };
            const empty = await textAnswer(handlerFor(x, withFolder).handleGetSessionStatus());
            assert.ok(empty.includes('liveSessionsInThisWindow=0, vscodeActiveDebugSession=undefined\n'
                + 'Hint: no debug session is running in the VS Code window this call was routed to.'), empty);
        });

        test('an initializing session that was asked to end is shutting down, not starting: its hint says what ends it', async () => {
            const x = new ScriptedExecutor();
            const detail = 'The session was asked to end (terminate sent 12 s ago); its adapter takes no requests while it shuts down.';
            x.sessionStatus = { state: 'initializing', sessionName: 'Arm-FVP@GDB (launch)', sessionType: 'gdbtarget', configurationName: null,
                dapResponsive: true, dapProbeMs: 3, detail, endRequestedForMs: 12_000 };
            const text = await textAnswer(handlerFor(x).handleGetSessionStatus());
            assert.ok(text.startsWith('State: initializing\n'), text);
            assert.ok(text.includes(`\nDetail: ${detail}\n`), text);
            assert.ok(text.endsWith('\nHint: the session is shutting down — call get_session_status again in a moment; if it is still listed, '
                + 'stop_debugging once more makes VS Code end the adapter.'), text);
            assert.ok(!text.includes('still starting'), text);
        });

        test('a stopped session whose last DHCSR read got no answer says so instead of "full inspection", still stopped (#3)', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = { state: 'stopped', sessionName: 'S', sessionType: 'gdbtarget', configurationName: 'C',
                dapResponsive: true, dapProbeMs: 12, detail: 'Stopped reason: breakpoint', coreSilentForMs: 12_400 };
            const text = await textAnswer(handlerFor(x).handleGetSessionStatus());
            assert.ok(text.startsWith('State: stopped\n'), text);
            assert.ok(text.endsWith('\nHint: the session is stopped, but the last read of the core\'s debug status (DHCSR, 12 s ago) got no answer: '
                + `memory and register reads fail with PROBE_WEDGED. check_target_connection reads it again. ${wedgeHint('launch')}`), text);
            assert.deepStrictEqual(x.argsOf('probeDebugPort'), [], 'the status reads nothing');

            x.sessionStatus = { ...x.sessionStatus, coreSilentForMs: 2_400_000 };
            x.activeSession = { configuration: { request: 'attach' } };
            const later = await textAnswer(handlerFor(x).handleGetSessionStatus());
            assert.ok(later.includes('(DHCSR, 40 min ago)') && later.endsWith(wedgeHint('attach')), later);

            x.sessionStatus = { ...x.sessionStatus, coreSilentForMs: undefined };
            assert.ok((await textAnswer(handlerFor(x).handleGetSessionStatus())).endsWith('\nHint: full inspection (variables, memory, registers) is available.'));
        });

        test('session status without a session says what an empty window lacks: a folder, the CMSIS extensions', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = { state: 'no-session', sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null };
            const environment = (installed: string[]): Partial<HandlerHost> => ({
                toolEnvironment: () => ({
                    extension: (id) => (installed.includes(id) ? { path: `/ext/${id}`, version: '1.0.0' } : undefined),
                    pathEnv: '',
                    platform: process.platform,
                }),
            });
            const gaps = async (host: Partial<HandlerHost>): Promise<string[]> =>
                (await textAnswer(handlerFor(x, host).handleGetSessionStatus())).split('\n')
                    .filter((line) => line.startsWith('Workspace: ') || line.startsWith('Extensions: '));

            assert.deepStrictEqual(await gaps({ workspaceFolders: () => [], ...environment([]) }), [
                'Workspace: no folder is open in this VS Code window. '
                + 'Open the project with cmsis_action {action:\'open_solution\', path:\'<folder or *.csolution.yml>\'}. '
                + 'get_debug_instructions {topic:\'bootstrap\'} has the steps from an empty window to a debugged board.',
                'Extensions: CMSIS Solution (Arm.cmsis-csolution) and CMSIS Debugger (Arm.vscode-cmsis-debugger) not installed, '
                + 'so cmsis_action and gdbtarget sessions cannot work here. '
                + 'Ask the user to install the Keil Studio Pack (Arm.keil-studio-pack) in VS Code and to reload the window.',
            ]);
            const both = environment(['Arm.cmsis-csolution', 'Arm.vscode-cmsis-debugger']);
            assert.strictEqual((await gaps({ workspaceFolders: () => [], ...both })).length, 1, 'only the folder is missing');
            assert.deepStrictEqual(await gaps({ workspaceFolders: () => [{ uri: vscode.Uri.file('/w'), name: 'w', index: 0 }], ...environment([]) }), [],
                'a window with a folder is not told about CMSIS extensions');

            x.sessionStatus = { state: 'stopped', sessionName: 'S', sessionType: 'python', configurationName: null, dapResponsive: true, dapProbeMs: 3 };
            assert.deepStrictEqual(await gaps({ workspaceFolders: () => [], ...environment([]) }), [], 'a session of any kind needs no folder');
        });

        test('session status names the serial port this window holds, for the asking session, and why it was released (#49)', async () => {
            SerialPortMock.binding.reset();
            SerialPortMock.binding.createPort('COM7');
            const serial = mockSerial();
            const x = new ScriptedExecutor();
            x.sessionStatus = { state: 'no-session', sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null };
            const handler = handlerFor(x, { ownedSerial: () => serial.controller });
            const serialLine = async (sessionId?: string): Promise<string | undefined> => {
                const text = await textAnswer(sessionId === undefined ? handler.handleGetSessionStatus()
                    : runInCallContext({ callId: 'x-1', sessionId }, () => handler.handleGetSessionStatus()));
                return text.split('\n').find((line) => line.startsWith('Serial: '));
            };
            assert.strictEqual(await serialLine(), undefined, 'no port, no line');
            await serial.controller.open({ path: 'COM7' }, { owner: 'aaaaaaaa-1111', rule: 'idle', idleSeconds: 300 });
            serial.time.advanceSeconds(42);
            assert.strictEqual(await serialLine('aaaaaaaa-1111'), 'Serial: COM7 open (this session, idle 42 s of 300 s)');
            assert.strictEqual(await serialLine('bbbbbbbb-2222'), 'Serial: COM7 open (another MCP session (aaaaaaaa), idle 42 s of 300 s)');
            serial.time.advanceSeconds(258);
            assert.strictEqual(await serialLine('aaaaaaaa-1111'), 'Serial: COM7 released at 10:47:07 after 300 s without a serial call');
            SerialPortMock.binding.reset();
        });

        test('device info adds the active CMSIS target', async () => {
            const x = new ScriptedExecutor();
            let answer: () => unknown = () => 'HP@debug';
            const registration = vscode.commands.registerCommand('cmsis-csolution.getActiveTargetSet', () => answer());
            try {
                assert.strictEqual(await textAnswer(handlerFor(x).handleGetDeviceInfo()),
                    '=== Debug Session Info ===\n  Session name: S\n  CMSIS target: HP@debug');
                answer = () => {
                    throw new Error('not ready');
                };
                assert.strictEqual(await textAnswer(handlerFor(x).handleGetDeviceInfo()), '=== Debug Session Info ===\n  Session name: S\n');
            } finally {
                registration.dispose();
            }
            x.session = false;
            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x).handleGetDeviceInfo(), 'NO_SESSION')),
                'No active debug session.\nStart a session first: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise.', 'a refusal, not wrapped');
        });
    });

    suite('get_recent_problems (#48)', () => {
        function journalWith(...records: ProblemInput[]): ProblemJournal {
            const journal = new ProblemJournal();
            records.forEach((record) => journal.append(record));
            return journal;
        }
        const handlerOn = (journal: ProblemJournal): DebuggingHandler =>
            new DebuggingHandler(new ScriptedExecutor() as unknown as IDebuggingExecutor, {} as IDebugConfigurationManager, 5, journal);

        test('warnings and errors of the handler\'s journal from sinceSeq on, the newest 20, with the cursor and the records in data', async () => {
            const journal = journalWith(
                { source: 'dap', origin: 'S', severity: 'info', message: 'banner' },
                { source: 'gdb-server', origin: 'S', severity: 'error', code: 'DAP_POWER_UP_FAILED', message: 'Failed to power up DAP', hint: 'Check the power.' },
                { source: 'serial', origin: 'COM7', severity: 'warning', message: 'COM7 disconnected at 10:42:07' },
            );
            const reply = await handlerOn(journal).handleGetRecentProblems({ sources: ['gdb-server', 'serial', 'dap'] });
            assert.deepStrictEqual(reply, {
                text: '#2 error gdb-server [DAP_POWER_UP_FAILED] Failed to power up DAP → Check the power.\n#3 warning serial COM7 disconnected at 10:42:07\nnextSeq=4',
                status: 'ok',
                data: { nextSeq: 4, returned: 2, omitted: 0, records: journal.query({ minSeverity: 'warning' }).records.map(problemJson) },
            });
            const since = await handlerOn(journal).handleGetRecentProblems({ sinceSeq: 3, minSeverity: 'info', sources: ['serial'] });
            assert.strictEqual(textOf(since), '#3 warning serial COM7 disconnected at 10:42:07\nnextSeq=4');
            const empty = await handlerOn(journal).handleGetRecentProblems({ sinceSeq: 4, sources: ['dap'] });
            assert.strictEqual(textOf(empty), 'No warnings or errors from dap since #4 (nextSeq=4).');
        });

        test('arguments a router did not check are made safe: unknown sources and severities are ignored, limit is 1 to 50', async () => {
            const journal = journalWith(...Array.from({ length: 60 }, (_, index): ProblemInput =>
                ({ source: 'build', origin: 'cbuild', severity: 'error', message: `error ${index}` })));
            // A known source is left in, so the Problems panel of the test instance is not read.
            const loose = { sources: ['nonsense', 'build'], minSeverity: 'fatal', limit: 500, sinceSeq: -3 } as unknown as Parameters<DebuggingHandler['handleGetRecentProblems']>[0];
            const reply = await handlerOn(journal).handleGetRecentProblems(loose);
            const counts = (answer: ToolText): unknown => {
                const data = isToolReply(answer) ? answer.data : undefined;
                return data && { nextSeq: data.nextSeq, returned: data.returned, omitted: data.omitted, records: (data.records as unknown[]).length };
            };
            assert.deepStrictEqual(counts(reply), { nextSeq: 61, returned: 50, omitted: 10, records: 50 });
            const one = await handlerOn(journal).handleGetRecentProblems({ limit: 0, sources: ['build'] });
            assert.deepStrictEqual(counts(one), { nextSeq: 61, returned: 1, omitted: 59, records: 1 });
            const standard = await handlerOn(journal).handleGetRecentProblems({ sources: ['build'] });
            assert.deepStrictEqual(counts(standard), { nextSeq: 61, returned: 20, omitted: 40, records: 20 });
        });
    });

    suite('cmsis_action', () => {
        let registrations: vscode.Disposable | undefined;
        teardown(() => {
            registrations?.dispose();
            registrations = undefined;
        });

        const solutionOn = (target: string, more: Record<string, (...args: unknown[]) => unknown> = {}): void => {
            registrations = standIns({
                'cmsis-csolution.getSolutionFile': () => '/w/demo.csolution.yml',
                'cmsis-csolution.getActiveTargetSet': () => target,
                ...more,
            });
        };

        test('refusals come before any CMSIS command', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('running', { sessionName: 'CMSIS Debugger' });
            const executed: string[] = [];
            registrations = standIns({
                'cmsis-csolution.getSolutionFile': () => {
                    executed.push('getSolutionFile');
                    return '/w/demo.csolution.yml';
                },
                'cmsis-csolution.getActiveTargetSet': () => 'HE',
                'cmsis-csolution.cmsisLoadAndDebug': () => {
                    executed.push('cmsisLoadAndDebug');
                },
            });
            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'load_and_debug' }), 'PROBE_BUSY')),
                'A debug session is already active (name=\'CMSIS Debugger\', state=running). Refusing to load_and_debug.\n'
                + 'Use stop_debugging or restart_debugging first, or proceed with inspection.');
            assert.deepStrictEqual(executed, []);

            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'detach', target: '@x' }), 'INVALID_ARGUMENT')),
                'CMSIS \'detach\' not attempted: target \'@x\' is not a valid reference — '
                + 'pass a target-type name or type@set as declared in the csolution, e.g. \'MPS3\' or \'HP@debug\'.');
            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'detach', target: 'HP' }), 'PROBE_BUSY')),
                'CMSIS \'detach\' not attempted: the active target is \'HE\' and switching to \'HP\' re-activates the solution, '
                + 'which is not done under a live debug session.\nCall stop_debugging first, then repeat this call.');
        });

        test('an unknown action is noticed only after the solution checks (KB17)', async () => {
            const x = new ScriptedExecutor();
            const asked: string[] = [];
            registrations = standIns({
                'cmsis-csolution.getSolutionFile': () => {
                    asked.push('solution');
                    return '/w/demo.csolution.yml';
                },
                'cmsis-csolution.getActiveTargetSet': () => {
                    asked.push('target');
                    return 'HE';
                },
            });
            const action = 'reboot' as Parameters<DebuggingHandler['handleCmsisCommand']>[0]['action'];
            assert.strictEqual((await refusalOf(handlerFor(x).handleCmsisCommand({ action }), 'INVALID_ARGUMENT')).message, 'Unknown CMSIS action: reboot');
            assert.deepStrictEqual(asked, ['solution', 'target']);
        });

        test('no active solution is answered before anything runs, and says which part is missing', async () => {
            const x = new ScriptedExecutor();
            const opened = { workspaceFolders: () => [{ uri: vscode.Uri.file('/w'), name: 'w', index: 0 }] };
            const installed: Partial<HandlerHost> = {
                toolEnvironment: () => ({ extension: () => ({ path: '/ext/csolution', version: '1.72.0' }), pathEnv: '', platform: process.platform }),
            };
            const refusedBy = (host: Partial<HandlerHost>, code: ErrorCode): Promise<ToolError> =>
                refusalOf(handlerFor(x, host).handleCmsisCommand({ action: 'stop_run' }), code);

            // No folder open: NO_WORKSPACE, whatever else is missing.
            assert.strictEqual(errorDetail(await refusedBy({ workspaceFolders: () => [] }, 'NO_WORKSPACE')),
                'CMSIS \'stop_run\' not attempted: no folder is open in this VS Code window, so there is no CMSIS solution to act on.\n'
                + 'Open the project with cmsis_action {action:\'open_solution\', path:\'<folder or *.csolution.yml>\'}. '
                + 'No project yet? get_debug_instructions {topic:\'bootstrap\'} has the steps from an empty window to a debugged board.');

            // A folder, but no CMSIS Solution extension.
            const noExtension = await refusedBy({
                ...opened,
                toolEnvironment: () => ({ extension: () => undefined, pathEnv: '', platform: process.platform }),
            }, 'CMSIS_NO_SOLUTION');
            assert.strictEqual(noExtension.message, 'CMSIS \'stop_run\' not attempted: the CMSIS Solution extension (Arm.cmsis-csolution) '
                + 'is not installed in this VS Code, so there is no active solution.');
            assert.ok(noExtension.hint?.startsWith('Ask the user to install the Keil Studio Pack (Arm.keil-studio-pack)'), noExtension.hint);

            // The extension, a folder, and no csolution file in it.
            const noFile = await refusedBy({ ...opened, ...installed, findFiles: async () => [] }, 'CMSIS_NO_SOLUTION');
            assert.ok(noFile.message.startsWith('CMSIS \'stop_run\' not attempted: the CMSIS Solution extension reports no active solution '
                + 'in this VS Code window (cmsis-csolution.getSolutionFile → query failed: '), noFile.message);
            assert.ok(noFile.hint?.startsWith('The open folder (w) contains no *.csolution.yml. Create the solution first'), noFile.hint);

            // A csolution file that the extension has not loaded.
            const file = path.join(path.sep, 'w', 'demo.csolution.yml');
            const notLoaded = await refusedBy({ ...opened, ...installed, findFiles: async () => [vscode.Uri.file(file)] }, 'CMSIS_NO_SOLUTION');
            assert.strictEqual(notLoaded.hint, `A solution file exists: ${vscode.Uri.file(file).fsPath}. The extension may still be loading it, or failed to load it. `
                + `cmsis_action {action:'open_solution', path:'${vscode.Uri.file(file).fsPath}'} activates it; get_recent_problems shows what the extension reported.`);

            // The search failed: the general fixes, with the server version.
            const unknown = await refusedBy({ ...opened, ...installed, findFiles: () => Promise.reject(new Error('no search')) }, 'CMSIS_NO_SOLUTION');
            assert.ok(unknown.hint?.includes('(serverVersion=9.8.7)'), unknown.hint);
        });

        suite('open_solution', () => {
            let scratch: string;
            setup(() => {
                scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-open-')));
            });
            teardown(() => {
                fs.rmSync(scratch, { recursive: true, force: true });
            });
            const installed: Partial<HandlerHost> = {
                toolEnvironment: () => ({ extension: () => ({ path: '/ext/csolution', version: '1.72.0' }), pathEnv: '', platform: process.platform }),
            };
            const asFolder = (fsPath: string): vscode.WorkspaceFolder => ({ uri: vscode.Uri.file(fsPath), name: path.basename(fsPath), index: 0 });
            const open = (handler: DebuggingHandler, given?: string): Promise<ToolText> =>
                handler.handleCmsisCommand({ action: 'open_solution', path: given, client: 'claude-code' });

            /**
             * vscode.workspace.findFiles over the workspace folder `root` as VS Code answers the csolution searches made here:
             * the files below it whose names end in .csolution.yml or .csolution.yaml (in lower case), `root` as spelled
             * with the names below it as on disk; without the folders the exclude leaves out (the names of a brace list,
             * or every hidden folder for the hidden-folder glob); links followed unless `followLinks` is false; at most
             * `maxResults`, in the order of the walk. `calls` records the arguments.
             */
            const searchLike = (root: string, options: { followLinks?: boolean; calls?: unknown[][] } = {}): HandlerHost['findFiles'] =>
                async (include, exclude, maxResults) => {
                    options.calls?.push([include, exclude, maxResults]);
                    const named = /^\*\*\/\{([^}]*)\}\/\*\*$/.exec(exclude)?.[1].split(',') ?? [];
                    const leftOut = (name: string): boolean => (exclude === '**/.*/**' ? name.startsWith('.') : named.includes(name));
                    const found: vscode.Uri[] = [];
                    const walk = (folder: string): void => {
                        const dirents = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
                        for (const dirent of dirents) {
                            const full = path.join(folder, dirent.name);
                            if (dirent.isSymbolicLink() && options.followLinks === false) {
                                continue;
                            }
                            if (fs.statSync(full).isDirectory()) {
                                if (!leftOut(dirent.name)) {
                                    walk(full);
                                }
                            } else if (/\.csolution\.(yaml|yml)$/.test(dirent.name)) {
                                found.push(vscode.Uri.file(full));
                            }
                        }
                    };
                    walk(root);
                    return found.slice(0, maxResults ?? found.length);
                };
            /** The csolution files the CMSIS Solution extension lists for the workspace folder `root`, as it spells them. */
            const extensionList = async (root: string, followLinks?: boolean): Promise<string[]> =>
                (await searchLike(root, { followLinks })('**/*.csolution.{yaml,yml}', '**/.*/**')).map((uri) => uri.fsPath);

            test('a missing, relative, absent or foreign path is INVALID_ARGUMENT, and nothing is opened', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const openedFolders: string[] = [];
                const handler = handlerFor(x, { workspaceFolders: () => [], openFolder: async (folder) => void openedFolders.push(folder) });
                const usage = '\nPass path: the absolute path of a *.csolution.yml, or of the folder that holds the project.';
                assert.strictEqual(errorDetail(await refusalOf(open(handler), 'INVALID_ARGUMENT')), `CMSIS 'open_solution' not attempted: no path given.${usage}`);
                assert.strictEqual(errorDetail(await refusalOf(open(handler, 'demo'), 'INVALID_ARGUMENT')),
                    `CMSIS 'open_solution' not attempted: 'demo' is not an absolute path.${usage}`);
                const absent = path.join(scratch, 'nowhere');
                assert.strictEqual(errorDetail(await refusalOf(open(handler, absent), 'INVALID_ARGUMENT')),
                    `CMSIS 'open_solution' not attempted: ${absent} does not exist.${usage}`);
                const other = path.join(scratch, 'notes.txt');
                fs.writeFileSync(other, '');
                assert.strictEqual(errorDetail(await refusalOf(open(handler, other), 'INVALID_ARGUMENT')),
                    `CMSIS 'open_solution' not attempted: ${other} is neither a folder nor a *.csolution.yml.${usage}`);
                assert.deepStrictEqual(openedFolders, []);
            });

            test('a folder that is not open here is opened in a new window, with the csolution it holds in the data', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const project = path.join(scratch, 'Blinky');
                fs.mkdirSync(path.join(project, 'app'), { recursive: true });
                const solution = path.join(project, 'Blinky.csolution.yml');
                fs.writeFileSync(solution, 'solution:\n');
                const calls: Array<[string, boolean]> = [];
                // A window with another folder open: any other folder goes to a new window.
                const elsewhere = path.join(scratch, 'Elsewhere');
                fs.mkdirSync(elsewhere);
                const handler = handlerFor(x, { workspaceFolders: () => [asFolder(elsewhere)], openFolder: async (folder, fresh) => void calls.push([folder, fresh]) });

                const byFolder = await open(handler, project);
                assert.deepStrictEqual(calls, [[project, true]]);
                assert.deepStrictEqual(byFolder, {
                    text: `Opening ${project} in a new VS Code window. Solution: Blinky.csolution.yml. `
                        + 'The window joins the CMSIS Developer Assistant once its extensions have started, and the CMSIS Solution extension '
                        + `then loads the solution. Reach it with window: '${project}' on cmsis_action, or select_debug_window.`,
                    status: 'ok',
                    data: { opened: project, newWindow: true, solution },
                });

                // By file: its folder is opened. An empty folder opens too, and says that the solution is still to come.
                assert.deepStrictEqual((await open(handler, solution) as { data: unknown }).data, { opened: project, newWindow: true, solution });
                const empty = path.join(scratch, 'Empty');
                fs.mkdirSync(empty);
                const bare = await open(handler, empty);
                assert.match(textOf(bare), /It has no \*\.csolution\.yml yet: create the solution there before cmsis_action build\./);
                assert.deepStrictEqual((bare as { data: unknown }).data, { opened: empty, newWindow: true });
            });

            test('VS Code failing to open the folder is TASK_FAILED with the way to do it by hand', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const elsewhere = path.join(scratch, 'Elsewhere');
                fs.mkdirSync(elsewhere);
                const handler = handlerFor(x, { workspaceFolders: () => [asFolder(elsewhere)], openFolder: () => Promise.reject(new Error('no window')) });
                const refused = await refusalOf(open(handler, scratch), 'TASK_FAILED');
                assert.strictEqual(refused.message, `CMSIS 'open_solution' failed: VS Code did not open ${scratch} (no window).`);
            });

            test('a window without a folder opens the folder in itself, after the reply: the text says the window reloads and how to come back', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const project = path.join(scratch, 'Blinky');
                fs.mkdirSync(project);
                const solution = path.join(project, 'Blinky.csolution.yml');
                fs.writeFileSync(solution, 'solution:\n');
                const calls: Array<[string, boolean]> = [];
                let slept = 0;
                let release: () => void = () => undefined;
                const gate = new Promise<void>((done) => {
                    release = done;
                });
                const handler = handlerFor(x, {
                    workspaceFolders: () => [],
                    sleep: async (ms) => {
                        slept = ms;
                        await gate;
                    },
                    openFolder: async (folder, fresh) => void calls.push([folder, fresh]),
                });
                const reply = await open(handler, project);
                assert.deepStrictEqual(calls, [], 'the folder is not opened before the reply left');
                assert.strictEqual(slept, 1_000);
                assert.deepStrictEqual(reply, {
                    text: `Opening ${project} in this window, which has no folder: VS Code reloads it in a second, and the MCP server with it. `
                        + 'Solution: Blinky.csolution.yml. Wait about 10 s, then call get_session_status; if the connection is refused or the session is unknown, '
                        + 'connect again — the server listens on the same port. The CMSIS Solution extension loads the solution once the window is back.',
                    status: 'ok',
                    data: { opened: project, newWindow: false, reloads: true, solution },
                });
                release();
                await new Promise<void>((tick) => setImmediate(tick));
                assert.deepStrictEqual(calls, [[project, false]], 'opened in this window once the delay passed');
            });

            test('a window without a folder opens a new window for a client that lives inside it (Copilot Chat, unknown), and says why', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const project = path.join(scratch, 'Blinky');
                fs.mkdirSync(project);
                fs.writeFileSync(path.join(project, 'Blinky.csolution.yml'), 'solution:\n');
                for (const client of ['Visual Studio Code', undefined]) {
                    const calls: Array<[string, boolean]> = [];
                    const handler = handlerFor(x, { workspaceFolders: () => [], openFolder: async (folder, fresh) => void calls.push([folder, fresh]) });
                    const reply = await handler.handleCmsisCommand({ action: 'open_solution', path: project, client });
                    assert.deepStrictEqual(calls, [[project, true]], String(client));
                    assert.ok(textOf(reply).endsWith(' This window stays without a folder: your client runs inside it, and opening the folder here would reload the window and end your session.'), textOf(reply));
                    assert.deepStrictEqual((reply as { data: unknown }).data, { opened: project, newWindow: true, solution: path.join(project, 'Blinky.csolution.yml') });
                }
            });

            test('a folder this window has open is activated here: asked once, verified, and not under a debug session', async () => {
                const solution = path.join(scratch, 'demo.csolution.yml');
                fs.writeFileSync(solution, 'solution:\n');
                let active = '';
                const activated: unknown[] = [];
                registrations = standIns({
                    'cmsis-csolution.getSolutionFile': () => active,
                    'cmsis-csolution.getActiveTargetSet': () => (active ? 'MPS3@debug' : ''),
                    'cmsis-csolution.activateSolution': (file) => {
                        activated.push(file);
                        active = String(file);
                    },
                });
                const x = new ScriptedExecutor();
                x.session = false;
                const opened: string[] = [];
                const host: Partial<HandlerHost> = {
                    ...installed, workspaceFolders: () => [asFolder(scratch)], openFolder: async (folder) => void opened.push(folder), findFiles: searchLike(scratch),
                };
                // The extension is given, and the reply names, the path as VS Code writes it (on Windows: c:\, not C:\).
                const listed = vscode.Uri.file(solution).fsPath;
                const expected = {
                    text: `${scratch} is open in this VS Code window. Active solution: ${listed}, target MPS3@debug. `
                        + 'Next: cmsis_action build, then load_and_debug.',
                    status: 'ok',
                    data: { opened: scratch, newWindow: false, solution: listed },
                };
                assert.deepStrictEqual(await open(handlerFor(x, host), scratch), expected);
                assert.deepStrictEqual(activated, [listed]);
                // Already active: nothing is asked again, by folder or by file.
                assert.deepStrictEqual(await open(handlerFor(x, host), solution), expected);
                assert.deepStrictEqual(activated, [listed]);
                assert.deepStrictEqual(opened, [], 'no window is opened for a folder that is open here');

                // Another solution under a live session is refused.
                const second = path.join(scratch, 'other.csolution.yml');
                fs.writeFileSync(second, 'solution:\n');
                const live = new ScriptedExecutor();
                const busy = await refusalOf(open(handlerFor(live, host), second), 'PROBE_BUSY');
                assert.strictEqual(busy.hint, 'Call stop_debugging first, then repeat this call.');
                // Two files and none named: the extension's choice stands, the files are listed.
                assert.strictEqual(textOf(await open(handlerFor(x, host), scratch)),
                    `${scratch} is open in this VS Code window. Solutions: demo.csolution.yml, other.csolution.yml. `
                    + `Active solution: ${listed}. Pass the path of one *.csolution.yml to activate it.`);
            });

            /**
             * A stand-in that takes a path the way CMSIS Solution 1.72.0 does: only an exact entry of its list,
             * the fsPaths of vscode.workspace.findFiles. Any other spelling leaves the active solution as it was,
             * as when the user escapes its "Select a solution" picker.
             */
            const strictSolution = (listedFiles: string[], initial: string) => {
                const state = { active: initial, activated: [] as unknown[], listed: listedFiles };
                registrations = standIns({
                    'cmsis-csolution.getSolutionFile': () => state.active,
                    'cmsis-csolution.getActiveTargetSet': () => (state.active ? 'HE' : ''),
                    'cmsis-csolution.activateSolution': (file) => {
                        state.activated.push(file);
                        if (typeof file === 'string' && state.listed.includes(file)) {
                            state.active = file;
                        }
                    },
                });
                return state;
            };

            test('the solution goes to the extension spelled as VS Code lists it, not as the caller wrote it (#84, #99)', async () => {
                fs.mkdirSync(path.join(scratch, 'app'));
                const first = path.join(scratch, 'first.csolution.yml');
                const second = path.join(scratch, 'second.csolution.yml');
                fs.writeFileSync(first, 'solution:\n');
                fs.writeFileSync(second, 'solution:\n');
                const listedFiles = [first, second].map((file) => vscode.Uri.file(file).fsPath);
                const state = strictSolution(listedFiles, listedFiles[0]);
                const x = new ScriptedExecutor();
                x.session = false;
                const host: Partial<HandlerHost> = {
                    ...installed, ...fastClock(1_000), workspaceFolders: () => [asFolder(scratch)],
                    findFiles: async () => listedFiles.map((file) => vscode.Uri.file(file)),
                };
                // Another spelling of the second file (path.join would fold the '..'): the extension would not know it.
                const typed = [scratch, 'app', '..', 'second.csolution.yml'].join(path.sep);
                const reply = await open(handlerFor(x, host), typed);
                assert.deepStrictEqual(state.activated, [listedFiles[1]]);
                assert.strictEqual(state.active, listedFiles[1]);
                assert.deepStrictEqual((reply as { status: string; data: unknown }).status, 'ok');
                assert.deepStrictEqual((reply as { data: unknown }).data, { opened: path.dirname(typed), newWindow: false, solution: listedFiles[1] });
            });

            test('a solution the extension does not take is TASK_FAILED when another stays active, never "build next" (#99)', async () => {
                const first = path.join(scratch, 'first.csolution.yml');
                const fresh = path.join(scratch, 'fresh.csolution.yml');
                fs.writeFileSync(first, 'solution:\n');
                fs.writeFileSync(fresh, 'solution:\n');
                const listedFirst = vscode.Uri.file(first).fsPath;
                // The search finds both, the extension's list still has only the first one, as for a file written a moment ago.
                const state = strictSolution([listedFirst], listedFirst);
                const x = new ScriptedExecutor();
                x.session = false;
                const host: Partial<HandlerHost> = {
                    ...installed, ...fastClock(1_000), workspaceFolders: () => [asFolder(scratch)], findFiles: searchLike(scratch),
                };
                const listedFresh = vscode.Uri.file(fresh).fsPath;
                const refused = await refusalOf(open(handlerFor(x, host), fresh), 'TASK_FAILED');
                assert.deepStrictEqual(state.activated, [listedFresh]);
                assert.strictEqual(refused.message, `CMSIS 'open_solution' failed: the CMSIS Solution extension was asked to activate ${listedFresh} `
                    + `but still reports ${listedFirst} as the active solution, so CMSIS actions would run on that one.`);
                assert.strictEqual(refused.hint, 'Ask the user to select it in the CMSIS view (Select as Active Solution), or to reload the window, '
                    + 'then repeat this call; get_recent_problems shows what the extension reported.');

                // None active yet: it may still be loading, so the call is running and says to repeat it before a build.
                state.active = '';
                const pending = await replyAnswer(open(handlerFor(x, host), fresh), 'running');
                assert.ok(pending.endsWith(`The CMSIS Solution extension was asked to activate ${listedFresh} but reports 'none' as the active solution so far. `
                    + 'It may still be loading: repeat this call until it names the active solution, then cmsis_action build; '
                    + 'get_recent_problems shows load errors.'), pending);

                // Without a search result the path goes in as Uri.file writes it.
                state.activated.length = 0;
                const unsearched = { ...host, findFiles: (): Promise<vscode.Uri[]> => Promise.reject(new Error('no search')) };
                await replyAnswer(open(handlerFor(x, unsearched), fresh), 'running');
                assert.deepStrictEqual(state.activated, [listedFresh]);
            });

            /** Write the csolution `file`, with its folders. */
            const writeSolution = (file: string): string => {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, 'solution:\n');
                return file;
            };

            test('another letter case, other separators, the folder\'s path: activated here, spelled as the extension lists it', async function () {
                // A file system that ignores letter case (APFS and NTFS by default); Linux keeps the spellings apart.
                if (!fs.existsSync(scratch.toUpperCase()) || !fs.existsSync(scratch.toLowerCase())) {
                    this.skip();
                }
                const root = path.join(scratch, 'Work');
                const solution = writeSolution(path.join(root, 'App', 'Blinky.csolution.yml'));
                const listed = vscode.Uri.file(solution).fsPath;
                const state = strictSolution(await extensionList(root), '');
                assert.deepStrictEqual(state.listed, [listed]);
                const x = new ScriptedExecutor();
                x.session = false;
                const opened: string[] = [];
                const host: Partial<HandlerHost> = {
                    ...installed, ...fastClock(1_000), workspaceFolders: () => [asFolder(root)], findFiles: searchLike(root),
                    openFolder: async (folder) => void opened.push(folder),
                };
                // As an agent may type it on Windows: forward slashes, the drive letter in upper case. Elsewhere it stays as it is.
                const typed = (file: string): string => (process.platform === 'win32'
                    ? file.replace(/\\/g, '/').replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : file);
                const spellings = [
                    path.join(root, 'APP', 'blinky.csolution.yml'),
                    path.join(scratch, 'WORK', 'app', 'BLINKY.csolution.yml'),
                    path.join(scratch, 'work', 'APP'),
                ].map(typed);
                for (const given of spellings) {
                    state.active = '';
                    state.activated.length = 0;
                    const reply = await open(handlerFor(x, host), given);
                    assert.deepStrictEqual(state.activated, [listed], given);
                    assert.strictEqual((reply as { status: string }).status, 'ok', given);
                    const opening = fs.statSync(given).isDirectory() ? given : path.dirname(given);
                    assert.deepStrictEqual((reply as { data: unknown }).data, { opened: opening, newWindow: false, solution: listed }, given);
                }
                assert.deepStrictEqual(opened, [], 'no window is opened for a folder that is open here');
            });

            test('the extension\'s own search decides: a csolution in build/ is found, one it does not list is refused before it is asked', async () => {
                const app = writeSolution(path.join(scratch, 'App.csolution.yml'));
                const generated = writeSolution(path.join(scratch, 'build', 'Gen.csolution.yml'));
                const hidden = writeSolution(path.join(scratch, '.cmsis', 'Hidden.csolution.yml'));
                const state = strictSolution(await extensionList(scratch), vscode.Uri.file(app).fsPath);
                assert.deepStrictEqual(state.listed, [app, generated].map((file) => vscode.Uri.file(file).fsPath));
                const x = new ScriptedExecutor();
                x.session = false;
                const calls: unknown[][] = [];
                const host: Partial<HandlerHost> = {
                    ...installed, ...fastClock(1_000), workspaceFolders: () => [asFolder(scratch)], findFiles: searchLike(scratch, { calls }),
                };

                // The one in build/, which the extension lists, under another spelling: activated as listed.
                const reply = await open(handlerFor(x, host), [scratch, 'build', '..', 'build', 'Gen.csolution.yml'].join(path.sep));
                assert.deepStrictEqual(state.activated, [state.listed[1]]);
                assert.strictEqual((reply as { status: string }).status, 'ok');
                assert.deepStrictEqual(calls, [['**/*.csolution.{yaml,yml}', '**/.*/**', undefined]]);

                // One in a hidden folder, or with a name the extension's search does not match: refused, the extension is not asked,
                // and that comes before the refusal under a live session, which stopping the session would not help.
                const upper = writeSolution(path.join(scratch, 'Upper.CSOLUTION.YML'));
                for (const [unlisted, executor] of [[hidden, x], [upper, x], [hidden, new ScriptedExecutor()]] as const) {
                    const refused = await refusalOf(open(handlerFor(executor, host), unlisted), 'INVALID_ARGUMENT');
                    assert.strictEqual(refused.message, `CMSIS 'open_solution' not attempted: the CMSIS Solution extension does not list ${unlisted} `
                        + 'as a solution of this window, so it would ask the user to pick another one instead.');
                    assert.strictEqual(refused.hint, 'It lists only files whose names end in .csolution.yml or .csolution.yaml, that ending in lower case, '
                        + 'outside hidden folders and outside what the settings cmsis-csolution.exclude and files.exclude exclude. '
                        + 'Ask the user to rename or move the file, or to change the setting, then repeat this call.');
                }
                assert.deepStrictEqual(state.activated, [state.listed[1]]);
            });

            test('a path through a link: the folder open through one, the solution named through one, or one the search does not follow', async function () {
                const real = path.join(scratch, 'real');
                const solution = writeSolution(path.join(real, 'Blinky.csolution.yml'));
                const link = path.join(scratch, 'link');
                try {
                    // A junction on Windows, which needs no privilege; elsewhere the type is ignored.
                    fs.symlinkSync(real, link, 'junction');
                } catch {
                    this.skip();
                }
                const viaLink = path.join(link, 'Blinky.csolution.yml');
                const state = strictSolution([], '');
                const x = new ScriptedExecutor();
                x.session = false;
                const opened: string[] = [];
                const cases: Array<{ folder: string; followLinks?: boolean; given: string; listed: string }> = [
                    { folder: link, given: solution, listed: vscode.Uri.file(viaLink).fsPath },
                    { folder: real, given: viaLink, listed: vscode.Uri.file(solution).fsPath },
                    { folder: scratch, followLinks: false, given: viaLink, listed: vscode.Uri.file(solution).fsPath },
                ];
                for (const { folder, followLinks, given, listed } of cases) {
                    state.listed = await extensionList(folder, followLinks);
                    assert.deepStrictEqual(state.listed, [listed], given);
                    state.active = '';
                    state.activated.length = 0;
                    const host: Partial<HandlerHost> = {
                        ...installed, ...fastClock(1_000), workspaceFolders: () => [asFolder(folder)], findFiles: searchLike(folder, { followLinks }),
                        openFolder: async (opening) => void opened.push(opening),
                    };
                    const reply = await open(handlerFor(x, host), given);
                    assert.deepStrictEqual(state.activated, [listed], given);
                    assert.strictEqual((reply as { status: string }).status, 'ok', given);
                }
                assert.deepStrictEqual(opened, [], 'no window is opened for a folder that is open here');

                // Active already, under the other spelling: the answer says so, with no refusal for the live session.
                state.active = vscode.Uri.file(solution).fsPath;
                const live = { ...installed, workspaceFolders: () => [asFolder(scratch)], findFiles: searchLike(scratch, { followLinks: false }) };
                assert.strictEqual(textOf(await open(handlerFor(new ScriptedExecutor(), live), viaLink)),
                    `${link} is open in this VS Code window. Active solution: ${state.active}, target HE. Next: cmsis_action build, then load_and_debug.`);
            });

            test('every csolution the extension lists counts, however many the workspace has', async () => {
                for (let index = 0; index < 250; index++) {
                    writeSolution(path.join(scratch, 'examples', `a${String(index).padStart(3, '0')}.csolution.yml`));
                }
                const last = writeSolution(path.join(scratch, 'examples', 'z.csolution.yml'));
                const state = strictSolution(await extensionList(scratch), '');
                assert.strictEqual(state.listed.length, 251);
                const x = new ScriptedExecutor();
                x.session = false;
                const host: Partial<HandlerHost> = {
                    ...installed, ...fastClock(1_000), workspaceFolders: () => [asFolder(scratch)], findFiles: searchLike(scratch),
                };
                await open(handlerFor(x, host), [scratch, 'examples', '..', 'examples', 'z.csolution.yml'].join(path.sep));
                assert.deepStrictEqual(state.activated, [vscode.Uri.file(last).fsPath]);
            });

            test('the path a new window or a reload hands over is activated there, spelled as the extension lists it', async () => {
                const solution = writeSolution(path.join(scratch, 'Blinky', 'Blinky.csolution.yml'));
                const elsewhere = path.join(scratch, 'Elsewhere');
                fs.mkdirSync(elsewhere);
                const typed = [scratch, 'Blinky', '..', 'Blinky', 'Blinky.csolution.yml'].join(path.sep);
                const state = strictSolution([], '');
                const x = new ScriptedExecutor();
                x.session = false;
                const branches: Array<Partial<HandlerHost>> = [
                    { workspaceFolders: () => [asFolder(elsewhere)], openFolder: async () => undefined },
                    { workspaceFolders: () => [], openFolder: async () => undefined, sleep: async () => undefined },
                ];
                for (const branch of branches) {
                    const handedOver = (await open(handlerFor(x, branch), typed) as { data: unknown }).data as { opened: string; solution: string };
                    assert.deepStrictEqual([handedOver.opened, handedOver.solution], [path.dirname(typed), typed]);
                    // The window that then has the folder open (VS Code opens it resolved) is given the path back.
                    const folder = path.resolve(handedOver.opened);
                    state.listed = await extensionList(folder);
                    state.active = '';
                    state.activated.length = 0;
                    const there: Partial<HandlerHost> = {
                        ...installed, ...fastClock(1_000), workspaceFolders: () => [asFolder(folder)], findFiles: searchLike(folder),
                    };
                    await open(handlerFor(x, there), handedOver.solution);
                    assert.deepStrictEqual(state.activated, [vscode.Uri.file(solution).fsPath]);
                }
            });

            test('an open folder without the CMSIS Solution extension, or without a csolution, is reported as it is', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const bare = handlerFor(x, { workspaceFolders: () => [asFolder(scratch)], ...installed });
                assert.strictEqual(textOf(await open(bare, scratch)),
                    `${scratch} is open in this VS Code window. It has no *.csolution.yml yet: create the solution there before cmsis_action build.`);
                fs.writeFileSync(path.join(scratch, 'demo.csolution.yml'), 'solution:\n');
                const noExtension = handlerFor(x, {
                    workspaceFolders: () => [asFolder(scratch)],
                    toolEnvironment: () => ({ extension: () => undefined, pathEnv: '', platform: process.platform }),
                });
                const refused = await refusalOf(open(noExtension, scratch), 'CMSIS_NO_SOLUTION');
                assert.ok(refused.message.includes('(Arm.cmsis-csolution) is not installed'), refused.message);
            });
        });

        test('a failing command within the kick-off is returned through the fence; a late one is dropped', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            solutionOn('HE', {
                'cmsis-csolution.cmsisDetachDebugger': () => {
                    throw new Error('no active solution');
                },
            });
            const noSolution = errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'detach' }), 'CMSIS_NO_SOLUTION'));
            assert.ok(noSolution.startsWith('CMSIS \'detach\' failed: no active CMSIS solution. '), noSolution);
            assert.ok(noSolution.includes('(serverVersion=9.8.7)'), noSolution);
            registrations?.dispose();

            solutionOn('HE', {
                'cmsis-csolution.cmsisDetachDebugger': () => {
                    throw new Error('boom');
                },
            });
            const other = errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'detach' }), 'TASK_FAILED'));
            assert.match(other, /^CMSIS command 'cmsis-csolution.cmsisDetachDebugger' failed: .*boom.*\.\nEnsure the CMSIS Solution extension is installed and a solution context is active\./s);
            registrations?.dispose();

            solutionOn('HE', {
                'cmsis-csolution.cmsisDetachDebugger': () => new Promise((_, fail) => setTimeout(() => fail(new Error('late')), 300)),
            });
            assert.strictEqual(await textAnswer(handlerFor(x, fastClock(100)).handleCmsisCommand({ action: 'detach' })),
                'CMSIS \'detach\' on HE issued via \'cmsis-csolution.cmsisDetachDebugger\'. '
                + 'It runs in the CMSIS extension — check the CMSIS output channel if you need to confirm.');
            await delay(400);
        });

        suite('jobs: completion, deadline, attach and status (#47, #12)', () => {
            const BUILD_TASK: FixtureTask = {
                name: 'cbuild demo.csolution.yml --active HE', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' },
            };
            const shellTask = (name: string): FixtureTask => ({ name, source: 'Workspace', definition: { type: 'shell' } });

            /** A handler on a clock `speedup` times real time, with a tracker over fake task events on the same clock. */
            const jobWorld = (speedup = 20, more: Partial<HandlerHost> = {}) => {
                const clock = fastClock(speedup);
                const tasks = new FakeTasks();
                tasks.fetched = workspaceTasks('/w', ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase']);
                const tracker = new CmsisJobTracker(tasks, clock);
                const x = new ScriptedExecutor();
                x.session = false;
                return { clock, tasks, tracker, x, handler: handlerFor(x, { ...clock, cmsisJobs: () => tracker, ...more }) };
            };
            /** A stand-in command whose task starts a few ms later and ends with `exitCode` unless that is 'never'. */
            const runs = (tasks: FakeTasks, task: FixtureTask, exitCode: number | undefined | 'never', returned = false) => (): unknown => {
                const execution = tasks.execution(task);
                setTimeout(() => {
                    tasks.start(execution);
                    if (exitCode !== 'never') {
                        setTimeout(() => tasks.finish(execution, exitCode), 5);
                    }
                }, 5);
                return returned ? execution : undefined;
            };
            const again = (): void => {
                registrations?.dispose();
                registrations = undefined;
            };

            test('build ends with the task, its exit code, how long it ran and the job id: 0, 2, none', async () => {
                const w = jobWorld();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 0, true) });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'build' })),
                    /^✅ CMSIS 'build' succeeded on HE \(task 'cbuild demo\.csolution\.yml --active HE' exited 0 after [\d.]+ s, job b-1\)\. The firmware is built — use cmsis_action load or load_and_debug to flash it\.$/);
                again();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 2, true) });
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'build' FAILED on HE — task 'cbuild demo\.csolution\.yml --active HE' exited with code 2 after [\d.]+ s \(job b-2\)\.$/);
                assert.strictEqual(failed.hint, 'get_recent_problems lists what the Problems panel shows; otherwise ask the user for the errors in the cbuild terminal '
                    + '— do not run cbuild yourself. Fix them, then cmsis_action build again. This is a terminal result — do not wait for an output file.');
                again();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, undefined, true) });
                const cancelled = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.match(cancelled.message, /^CMSIS 'build' on HE — task '.*' ended without an exit code after [\d.]+ s \(it may have been cancelled; job b-3\)\.$/);
                assert.strictEqual(cancelled.hint, 'Re-run cmsis_action build to get a definite result.');
            });

            test('a failed build shows its error lines when they arrive within the deadline; after it, status shows them (#15)', async () => {
                const w = jobWorld();
                const diagnosis: JobDiagnosis = {
                    state: 'done', source: 'rerun', errorCount: 1, warningCount: 0, logFile: '/w/out/cmsis-developer-assistant/build-diagnostic.log',
                    errors: [{ severity: 'error', file: '/w/main.c', line: 42, column: 5, message: '\'ledx\' undeclared' }], warnings: [],
                    text: '1 error (from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 0):\n'
                        + '  main.c:42:5 error: \'ledx\' undeclared',
                };
                let deliver: () => void = () => undefined;
                w.tracker.onDidFinishJob((job) => {
                    if (job.state === 'failed') {
                        w.tracker.completeWith(job.id, new Promise<JobDiagnosis>((resolve) => {
                            deliver = () => resolve(diagnosis);
                        }));
                    }
                });
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 2, true) });
                setTimeout(() => deliver(), 100);
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'build' FAILED on HE — task '.*' exited with code 2 after [\d.]+ s \(job b-1\)\.\n1 error \(from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 0\):\n {2}main\.c:42:5 error: 'ledx' undeclared$/);
                assert.strictEqual(failed.hint, 'Fix the first error, then cmsis_action build again. This is a terminal result — do not wait for an output file.');
                assert.strictEqual((failed.data?.diagnosis as Record<string, unknown>).errorCount, 1);
                assert.strictEqual((failed.data?.job as Record<string, unknown>).id, 'b-1');

                again();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 2, true) });
                const early = await refusalOf(w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 4_000 }), 'TASK_FAILED');
                assert.ok(early.message.endsWith('(job b-2).\nError lines: still being collected (a diagnostic re-run of cbuild with --log, at most 120 s).'), early.message);
                assert.strictEqual(early.hint, 'Call cmsis_action {action:\'status\'} for the error lines — do not start another build to see them. '
                    + 'This is a terminal result — do not wait for an output file.');
                setTimeout(() => deliver(), 50);
                const idle = await textAnswer(w.handler.handleCmsisCommand({ action: 'status' }));
                assert.match(idle, /^No CMSIS job in flight in this window\. Last results: build on HE ❌ exit 2 [\d.]+ s ago \(job b-2, '.*'\)\.\nBuild job b-2 failed: 1 error \(from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 0\):\n {2}main\.c:42:5 error: 'ledx' undeclared\nNo CMSIS task is running in this window\.$/);
            });

            test('a build that exited 0 is answered after its check: failed with the lines, or not confirmed (CMSIS Solution reports 0 for failed builds)', async () => {
                const w = jobWorld();
                const checks: JobDiagnosis[] = [
                    {
                        state: 'done', check: 'failed', source: 'rerun', errorCount: 1, warningCount: 0, errors: [{ severity: 'error', file: '/w/main.c', line: 3, message: 'boom' }],
                        warnings: [], text: '1 error (from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 0):\n  main.c:3 error: boom',
                    },
                    {
                        state: 'done', check: 'unverified', source: 'none', errorCount: 0, warningCount: 0, errors: [], warnings: [],
                        text: 'The image out/demo.axf is missing, and CMSIS Solution reports exit 0 for a failed build too, so this build may have failed. It could not be checked: why.',
                    },
                ];
                w.tracker.onDidFinishJob((job) => {
                    const next = checks.shift();
                    if (job.state === 'ok' && next) {
                        w.tracker.completeWith(job.id, new Promise<JobDiagnosis>((resolve) => setTimeout(() => resolve(next), 20)));
                    }
                });
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 0, true) });
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'build' FAILED on HE — task 'cbuild demo\.csolution\.yml --active HE' exited 0 after [\d.]+ s, but the build failed \(CMSIS Solution reports exit 0 for a failed build too\) \(job b-1\)\.\n1 error /);
                assert.strictEqual(failed.hint, 'Fix the first error, then cmsis_action build again. This is a terminal result — do not wait for an output file.');

                again();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 0, true) });
                const unconfirmed = await w.handler.handleCmsisCommand({ action: 'build' });
                assert.ok(typeof unconfirmed === 'object' && unconfirmed.status === 'ok');
                assert.match(unconfirmed.text, /^⚠️ CMSIS 'build' on HE: task '.*' exited 0 after [\d.]+ s \(job b-2\), but that does not confirm the build\. The image out\/demo\.axf is missing, .* It could not be checked: why\. Before you load this image, ask the user whether the build in the cbuild terminal succeeded — do not run cbuild yourself\.$/);
            });

            test('the build the command returns is the result, not another build that started first', async () => {
                const w = jobWorld();
                const other: FixtureTask = { ...BUILD_TASK, name: 'cbuild other.csolution.yml' };
                solutionOn('HE', {
                    'cmsis-csolution.build': () => {
                        const theirs = w.tasks.start(w.tasks.execution(other));
                        const ours = w.tasks.execution(BUILD_TASK);
                        setTimeout(() => {
                            w.tasks.start(ours);
                            w.tasks.finish(theirs, 0);
                            setTimeout(() => w.tasks.finish(ours, 2), 5);
                        }, 5);
                        return ours;
                    },
                });
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'build' FAILED on HE — task 'cbuild demo\.csolution\.yml --active HE' exited with code 2 .* Note: also started meanwhile: 'cbuild other\.csolution\.yml' — not this call's result\.$/);
            });

            test('a CMSIS Load is never a build\'s result: nothing started within 10 s', async () => {
                const w = jobWorld();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, shellTask('CMSIS Load'), 0) });
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 20_000 }), 'TASK_FAILED');
                assert.strictEqual(errorDetail(refused), 'CMSIS \'build\' on HE: nothing started within 10 s of issuing \'cmsis-csolution.build\' (job b-1). '
                    + 'Note: also started meanwhile: \'CMSIS Load\' — not this call\'s result.\n'
                    + 'The CMSIS panel may be showing a picker or a save prompt: answer it in VS Code, then repeat the call. '
                    + 'This does not mean "already up to date" — cbuild runs even when nothing changed.');
                assert.strictEqual(w.tracker.last('load')?.origin, 'adopted', 'the Load became a job of its own');
            });

            test('still running at the deadline answers running with the job; a repeat attaches; status waits and reports', async () => {
                const w = jobWorld();
                let builds = 0;
                let execution: FakeExecution | undefined;
                solutionOn('HE', {
                    'cmsis-csolution.build': () => {
                        builds++;
                        execution = w.tasks.start(w.tasks.execution(BUILD_TASK));
                        return execution;
                    },
                });
                const first = await w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 8_000 });
                assert.ok(typeof first === 'object' && first.status === 'running', JSON.stringify(first));
                assert.match(first.text, /^CMSIS 'build' on HE is still running after [\d.]+ s \(task 'cbuild demo\.csolution\.yml --active HE', job b-1\)\. This is not a failure\. Call cmsis_action \{action:'status'\} to wait for the result — do not start another build\.$/);
                const job = first.data?.job as Record<string, unknown>;
                assert.deepStrictEqual([job.id, job.action, job.target, job.task, job.state, job.origin],
                    ['b-1', 'build', 'HE', BUILD_TASK.name, 'started', 'call']);
                assert.ok(typeof job.startedAt === 'string' && typeof job.elapsedMs === 'number', JSON.stringify(job));

                const busy = await w.handler.handleCmsisCommand({ action: 'status', timeoutMs: 4_000 });
                assert.ok(typeof busy === 'object' && busy.status === 'running' && busy.text.includes('job b-1'), JSON.stringify(busy));

                setTimeout(() => w.tasks.finish(execution as FakeExecution, 0), 30);
                const attached = await textAnswer(w.handler.handleCmsisCommand({ action: 'build' }));
                assert.match(attached, /^Attached to the build started [\d.]+ s ago \(job b-1, not started again\)\. ✅ CMSIS 'build' succeeded on HE \(task '.*' exited 0 after [\d.]+ s, job b-1\)\./);
                assert.strictEqual(builds, 1, 'the repeat did not issue a second build');

                const idle = await textAnswer(w.handler.handleCmsisCommand({ action: 'status' }));
                assert.match(idle, /^No CMSIS job in flight in this window\. Last results: build on HE ✅ [\d.]+ s ago \(job b-1, '.*'\)\.\nNo CMSIS task is running in this window\.$/);
            });

            test('a build of another target while one runs is refused; one from the panel is attached to', async () => {
                const w = jobWorld();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 'never', true) });
                await replyAnswer(w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 4_000 }), 'running');
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'build', target: 'HP' }), 'TASK_FAILED');
                assert.match(errorDetail(refused), /^CMSIS 'build' not started on 'HP': the build started [\d.]+ s ago on 'HE' is still running \(job b-1\)\.\nWait for it with cmsis_action \{action:'status'\}, then run build on the other target\.$/);

                const panel = jobWorld();
                const fromPanel = panel.tasks.start(panel.tasks.execution(BUILD_TASK));
                let issued = 0;
                again();
                solutionOn('HE', {
                    'cmsis-csolution.build': () => {
                        issued++;
                    },
                });
                setTimeout(() => panel.tasks.finish(fromPanel, 0), 20);
                assert.match(await textAnswer(panel.handler.handleCmsisCommand({ action: 'build' })),
                    /^Attached to the build started from the CMSIS panel [\d.]+ s ago \(job b-1, not started again\)\. ✅ CMSIS 'build' succeeded on HE \(task/);
                assert.strictEqual(issued, 0);
            });

            test('status needs no solution and launches nothing', async () => {
                const w = jobWorld();
                assert.strictEqual(await textAnswer(w.handler.handleCmsisCommand({ action: 'status' })),
                    'No CMSIS job in this window: nothing is in flight and none has finished since the window started.\n'
                    + 'No CMSIS task is running in this window.');
            });

            test('one deadline per call: a 20 s target switch still ends in the job\'s running reply, not the fence', async () => {
                const solutionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-switch-'));
                try {
                    const solution = path.join(solutionDir, 'demo.csolution.yml');
                    fs.writeFileSync(solution, ['solution:', '  target-types:', '    - type: HE', '    - type: HP', ''].join('\n'));
                    const w = jobWorld(20, { workspaceFolders: () => [{ uri: vscode.Uri.file(solutionDir), name: 'ws', index: 0 }] });
                    let active = 'HE';
                    registrations = standIns({
                        'cmsis-csolution.getSolutionFile': () => solution,
                        'cmsis-csolution.getActiveTargetSet': () => active,
                        'cmsis-csolution.deactivateSolution': () => undefined,
                        // 1 s of real time is 20 s on the handler's clock.
                        'cmsis-csolution.activateSolution': () => new Promise((done) => setTimeout(() => {
                            active = 'HP';
                            done(undefined);
                        }, 1_000)),
                        'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 'never', true),
                    });
                    const text = await replyAnswer(w.handler.handleCmsisCommand({ action: 'build', target: 'HP', timeoutMs: 30_000 }), 'running');
                    assert.match(text, /^CMSIS 'build' on HP, switched from HE is still running after \d+ s \(task '.*', job b-1\)\./);
                    assert.ok(!text.includes('did not complete within'), text);
                } finally {
                    fs.rmSync(solutionDir, { recursive: true, force: true });
                }
            });

            test('target switching accepts flow YAML and aliased target definitions and preserves target-set indexes', async () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-yaml-target-'));
                try {
                    const solution = path.join(dir, 'demo.csolution.yml');
                    const selectionFile = path.join(dir, '.vscode', 'cmsis.json');
                    fs.mkdirSync(path.dirname(selectionFile));
                    const variants = [
                        'solution: {target-types: [{type: HE}, {target-set: [{set: debug}, {set: release}], type: HP}]}\n',
                        'sets: &sets [{set: debug}, {set: release}]\ntarget: &hp {type: HP, target-set: *sets}\n'
                            + 'solution: {target-types: [{type: HE}, *hp]}\n',
                    ];
                    for (const yaml of variants) {
                        again();
                        fs.writeFileSync(solution, yaml);
                        fs.writeFileSync(selectionFile, '{"targetSet":{"demo":{"activeTargetType":"HE"}},"keep":42}\n');
                        const w = jobWorld(20, { workspaceFolders: () => [{ uri: vscode.Uri.file(dir), name: 'ws', index: 0 }] });
                        let active = 'HE';
                        const issued: string[] = [];
                        registrations = standIns({
                            'cmsis-csolution.getSolutionFile': () => solution,
                            'cmsis-csolution.getActiveTargetSet': () => active,
                            'cmsis-csolution.deactivateSolution': () => { issued.push('deactivate'); },
                            'cmsis-csolution.activateSolution': () => {
                                issued.push('activate');
                                const settings = JSON.parse(fs.readFileSync(selectionFile, 'utf8')) as {
                                    targetSet: { demo: { activeTargetType: string; HP: number } }; keep: number;
                                };
                                assert.deepStrictEqual(settings, { targetSet: { demo: { activeTargetType: 'HP', HP: 1 } }, keep: 42 });
                                active = 'HP@release';
                            },
                            'cmsis-csolution.cmsisDetachDebugger': () => { issued.push('detach'); },
                        });
                        const text = await textAnswer(w.handler.handleCmsisCommand({ action: 'detach', target: 'HP@release' }));
                        assert.match(text, /^CMSIS 'detach' on HP@release, switched from HE issued/);
                        assert.deepStrictEqual(issued, ['deactivate', 'activate', 'detach']);
                        w.tracker.dispose();
                    }
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            });

            test('target switching rejects malformed or unsupported YAML before settings or activation change', async () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-invalid-target-'));
                try {
                    const solution = path.join(dir, 'demo.csolution.yml');
                    const selectionFile = path.join(dir, '.vscode', 'cmsis.json');
                    const original = '{\n // retain this selection\n "targetSet":{"demo":{"activeTargetType":"HE"}},"keep":42\n}\n';
                    fs.mkdirSync(path.dirname(selectionFile));
                    fs.writeFileSync(selectionFile, original);
                    const modifiedAt = fs.statSync(selectionFile).mtimeMs;
                    const issued: string[] = [];
                    const w = jobWorld(20, { workspaceFolders: () => [{ uri: vscode.Uri.file(dir), name: 'ws', index: 0 }] });
                    registrations = standIns({
                        'cmsis-csolution.getSolutionFile': () => solution,
                        'cmsis-csolution.getActiveTargetSet': () => 'HE',
                        'cmsis-csolution.deactivateSolution': () => { issued.push('deactivate'); },
                        'cmsis-csolution.activateSolution': () => { issued.push('activate'); },
                        'cmsis-csolution.cmsisDetachDebugger': () => { issued.push('detach'); },
                    });
                    for (const yaml of [
                        'solution: {target-types: [',
                        'solution: {target-types: {type: HP}}',
                        'solution: {target-types: [{type: HP, target-set: invalid}]}',
                        'solution: {target-types: [*missing]}',
                        'solution: {? [target-types]: [{type: HP}]}',
                        'solution: {target-types: [{type: HP, target-set: [{? [set]: release}]}]}',
                        `#${'x'.repeat(1024 * 1024)}`,
                    ]) {
                        fs.writeFileSync(solution, yaml);
                        const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'detach', target: 'HP@release' }), 'INVALID_ARGUMENT');
                        assert.ok(refused.message.includes('cannot supply a valid target selection'), refused.message);
                        assert.ok(refused.message.includes('No selection was changed.'), refused.message);
                        assert.strictEqual(refused.hint, 'Correct the csolution YAML and its target-types, then repeat this call.');
                        assert.strictEqual(fs.readFileSync(selectionFile, 'utf8'), original, 'selection content unchanged');
                        assert.strictEqual(fs.statSync(selectionFile).mtimeMs, modifiedAt, 'selection was never rewritten');
                        assert.deepStrictEqual(issued, [], 'neither reactivation nor the requested action was issued');
                    }
                    w.tracker.dispose();
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            });

            test('a target switch of a solution in the second folder writes the first folder\'s cmsis.json, where CMSIS Solution reads it', async () => {
                const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-roots-'));
                try {
                    const first = path.join(root, 'app');
                    const second = path.join(root, 'fw');
                    fs.mkdirSync(first);
                    fs.mkdirSync(second);
                    const solution = path.join(second, 'demo.csolution.yml');
                    fs.writeFileSync(solution, ['solution:', '  target-types:', '    - type: HE', '    - type: HP', '      target-set:',
                        '        - set: debug', '        - set: release', ''].join('\n'));
                    const w = jobWorld(20, {
                        workspaceFolders: () => [
                            { uri: vscode.Uri.file(first), name: 'app', index: 0 },
                            { uri: vscode.Uri.file(second), name: 'fw', index: 1 },
                        ],
                    });
                    // CMSIS Solution 1.72.0 reads only <first folder>/.vscode/cmsis.json, files the solution there
                    // as '../fw/demo' and looks that key up split at every '.'.
                    const selection = (): Record<string, unknown> | undefined => {
                        let node: unknown;
                        try {
                            node = JSON.parse(fs.readFileSync(path.join(first, '.vscode', 'cmsis.json'), 'utf8'));
                        } catch {
                            return undefined;
                        }
                        for (const key of 'targetSet.../fw/demo'.split('.')) {
                            node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
                        }
                        return node !== null && typeof node === 'object' ? node as Record<string, unknown> : undefined;
                    };
                    let active = 'HE';
                    registrations = standIns({
                        'cmsis-csolution.getSolutionFile': () => solution,
                        'cmsis-csolution.getActiveTargetSet': () => active,
                        'cmsis-csolution.deactivateSolution': () => undefined,
                        'cmsis-csolution.activateSolution': () => {
                            const picked = selection();
                            active = picked?.activeTargetType === 'HP' ? `HP@${picked.HP === 1 ? 'release' : 'debug'}` : 'HE';
                        },
                        'cmsis-csolution.cmsisDetachDebugger': () => undefined,
                    });
                    const text = await textAnswer(w.handler.handleCmsisCommand({ action: 'detach', target: 'HP@release' }));
                    assert.match(text, /^CMSIS 'detach' on HP@release, switched from HE issued/);
                    assert.deepStrictEqual(selection(), { activeTargetType: 'HP', HP: 1 });
                    assert.ok(!fs.existsSync(path.join(second, '.vscode', 'cmsis.json')), 'CMSIS Solution reads no cmsis.json in the second folder');
                } finally {
                    fs.rmSync(root, { recursive: true, force: true });
                }
            });

            test('the label pre-check refuses a task the debugger adapter does not offer before anything runs', async () => {
                const w = jobWorld();
                w.tasks.fetched = workspaceTasks('/w', ['CMSIS Load+Run']);
                let loads = 0;
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoad': () => {
                        loads++;
                    },
                });
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'load' }), 'INVALID_ARGUMENT');
                assert.strictEqual(errorDetail(refused), 'CMSIS \'load\' on HE not started: this debugger adapter has no \'CMSIS Load\' task; '
                    + 'it offers load_and_run and load_and_debug.\n'
                    + 'Use one of those, or flash. (Arm Debugger adapters offer only load_and_run and load_and_debug.)');
                const cached = await refusalOf(w.handler.handleCmsisCommand({ action: 'erase' }), 'INVALID_ARGUMENT');
                assert.ok(cached.message.includes('no \'CMSIS Erase\' task'), 'the labels are cached until tasks.json changes');
                assert.strictEqual(w.tasks.fetchCount, 1);
                const bare = jobWorld();
                bare.tasks.fetched = [];
                const none = await refusalOf(bare.handler.handleCmsisCommand({ action: 'erase' }), 'INVALID_ARGUMENT');
                assert.ok(none.message.includes('the solution\'s .vscode/tasks.json has no CMSIS tasks'), none.message);
                assert.strictEqual(loads, 0);
            });

            test('rebuild and clean are jobs of their own over their commands; a repeat attaches, another build-type action is refused', async () => {
                const w = jobWorld();
                const rebuildTask: FixtureTask = {
                    name: 'cbuild demo.csolution.yml --target all --rebuild --active HE', source: 'cmsis-csolution.build',
                    definition: { type: 'cmsis-csolution.build', rebuild: true },
                };
                const cleanTask: FixtureTask = {
                    name: 'cbuild demo.csolution.yml --clean --target all', source: 'cmsis-csolution.build',
                    definition: { type: 'cmsis-csolution.build', clean: true },
                };
                solutionOn('HE', { 'cmsis-csolution.rebuild': runs(w.tasks, rebuildTask, 0, true) });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'rebuild' })),
                    /^✅ CMSIS 'rebuild' succeeded on HE \(task 'cbuild demo\.csolution\.yml --target all --rebuild --active HE' exited 0 after [\d.]+ s, job rb-1\)\. The firmware is rebuilt from scratch — use cmsis_action load or load_and_debug to flash it\.$/);
                again();
                solutionOn('HE', { 'cmsis-csolution.clean': runs(w.tasks, cleanTask, 0, true) });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'clean' })),
                    /^✅ CMSIS 'clean' succeeded on HE \(task 'cbuild demo\.csolution\.yml --clean --target all' exited 0 after [\d.]+ s, job c-2\)\. It covers the whole solution \(CMSIS Solution: "Clean All 'out' and 'tmp' Directories"\), not only this target: cmsis_action build before load or flash\.$/);

                again();
                let cleans = 0;
                solutionOn('HE', {
                    'cmsis-csolution.clean': () => {
                        cleans++;
                        return w.tasks.start(w.tasks.execution(cleanTask));
                    },
                    'cmsis-csolution.build': () => assert.fail('no build while the clean runs'),
                    'cmsis-csolution.rebuild': () => assert.fail('no rebuild while the clean runs'),
                });
                await replyAnswer(w.handler.handleCmsisCommand({ action: 'clean', timeoutMs: 4_000 }), 'running');
                const attached = await replyAnswer(w.handler.handleCmsisCommand({ action: 'clean', timeoutMs: 4_000 }), 'running');
                assert.match(attached, /^Attached to the clean started [\d.]+ s ago \(job c-3, not started again\)\. CMSIS 'clean' on HE is still running .* do not start another clean\.$/);
                assert.strictEqual(cleans, 1);
                for (const action of ['build', 'rebuild'] as const) {
                    const refused = await refusalOf(w.handler.handleCmsisCommand({ action }), 'TASK_FAILED');
                    assert.match(errorDetail(refused), new RegExp(`^CMSIS '${action}' on HE not started: the clean started [\\d.]+ s ago \\(job c-3\\) is still running, `
                        + `and CMSIS Solution would start the ${action} only after it\\.\\nWait for it with cmsis_action \\{action:'status'\\}, or end it with `
                        + 'cmsis_action \\{action:\'stop_build\'\\}; then repeat the call\\.$'));
                }
            });

            /** Stop deadlines with no wall-clock race: each end wait advances the tracker clock by exactly its budget. */
            const stopWorld = () => {
                const clock = new ManualClock(1_000);
                const tasks = new FakeTasks();
                const tracker = new CmsisJobTracker(tasks, clock);
                const waits: number[] = [];
                const waitForEnd = tracker.waitForEnd.bind(tracker);
                tracker.waitForEnd = async (executions, ms) => {
                    waits.push(ms);
                    clock.advance(clock.now() + ms);
                    return waitForEnd(executions, 0);
                };
                const x = new ScriptedExecutor();
                x.session = false;
                const handler = handlerFor(x, {
                    now: () => clock.now(),
                    startTimer: (ms, fire) => clock.startTimer(ms, fire),
                    sleep: (ms) => new Promise<void>((wake) => clock.startTimer(ms, wake)),
                    cmsisJobs: () => tracker,
                });
                return { clock, tasks, tracker, waits, handler };
            };

            for (const action of ['stop_build', 'stop_run'] as const) {
                const task = action === 'stop_build' ? BUILD_TASK : shellTask('CMSIS Run');
                const command = action === 'stop_build' ? 'cmsis-csolution.stopBuild' : 'cmsis-csolution.cmsisStopRun';

                test(`${action}: a short caller deadline leaves termination pending, without a premature second terminate`, async () => {
                    const w = stopWorld();
                    const execution = w.tasks.start(w.tasks.execution(task));
                    let failedJobs = 0;
                    w.tracker.onDidFinishJob((job) => {
                        if (job.state === 'failed') {
                            failedJobs++;
                        }
                    });
                    solutionOn('HE', { [command]: () => {
                        w.clock.startTimer(1_000, () => w.tasks.finish(execution, 130));
                    } });
                    const text = await replyAnswer(w.handler.handleCmsisCommand({ action, timeoutMs: 1_000 }), 'running');
                    assert.ok(text.includes('stop requested'), text);
                    assert.ok(text.includes('termination is pending'), text);
                    assert.ok(!text.includes('although terminated'), text);
                    assert.deepStrictEqual(w.waits, [750]);
                    assert.strictEqual(execution.terminateCalls, 0, 'the owner still has its three-second grace');
                    assert.strictEqual(w.clock.now(), 1_750, 'a short call still observes termination instead of a zero-second failure');
                    w.clock.advance(2_000);
                    const final = await textAnswer(w.handler.handleCmsisCommand({ action: 'status' }));
                    assert.ok(final.includes('No CMSIS task is running in this window.'), final);
                    if (action === 'stop_build') {
                        assert.strictEqual(w.tracker.last('build')?.state, 'cancelled');
                        assert.ok(final.includes('build stopped'), final);
                    }
                    assert.strictEqual(failedJobs, 0, 'a delayed requested stop must not trigger failed-build diagnostics');
                    assert.ok(!w.tracker.recent().some((job) => w.tracker.isCompleting(job.id)));
                    w.tracker.dispose();
                });

                test(`${action}: a truncated verification after the grace period remains pending, not a false failure`, async () => {
                    const w = stopWorld();
                    const execution = w.tasks.start(w.tasks.execution(task, true));
                    solutionOn('HE', { [command]: () => undefined });
                    await replyAnswer(w.handler.handleCmsisCommand({ action, timeoutMs: 6_000 }), 'running');
                    assert.deepStrictEqual(w.waits, [3_000, 1_500]);
                    assert.strictEqual(execution.terminateCalls, 1, 'the retry follows the full grace, not the short caller deadline');
                    w.tracker.dispose();
                });

                test(`${action}: ten full seconds of unsuccessful verification remains a genuine failure`, async () => {
                    const w = stopWorld();
                    const execution = w.tasks.start(w.tasks.execution(task, true));
                    solutionOn('HE', { [command]: () => undefined });
                    const refused = await refusalOf(w.handler.handleCmsisCommand({ action, timeoutMs: 15_000 }),
                        action === 'stop_build' ? 'TASK_FAILED' : 'PROBE_BUSY');
                    assert.ok(refused.message.includes('still running 10 s after the stop request'), refused.message);
                    assert.deepStrictEqual(w.waits, [3_000, 7_000]);
                    assert.strictEqual(execution.terminateCalls, 1);
                    w.tracker.dispose();
                });
            }

            test('stop_build: a failed stop command falls back directly even within a short caller deadline', async () => {
                const w = stopWorld();
                const execution = w.tasks.start(w.tasks.execution(BUILD_TASK, true));
                solutionOn('HE', { 'cmsis-csolution.stopBuild': () => { throw new Error('owner stop unavailable'); } });
                const text = await replyAnswer(w.handler.handleCmsisCommand({ action: 'stop_build', timeoutMs: 1_000 }), 'running');
                assert.strictEqual(execution.terminateCalls, 1, 'a failed command never gets a redundant grace period');
                assert.deepStrictEqual(w.waits, [0, 750]);
                assert.ok(text.includes('owner stop unavailable'), text);
                assert.ok(text.includes('terminated directly'), text);
                w.tracker.dispose();
            });

            test('stop_build ends a running build and says so; with none running it issues nothing and says that', async () => {
                const w = jobWorld();
                let stops = 0;
                solutionOn('HE', {
                    'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 'never', true),
                    // CMSIS Solution's stopBuildTask: the task runner's terminateProcess closes the task with 130.
                    'cmsis-csolution.stopBuild': () => {
                        stops++;
                        const running = w.tasks.taskExecutions()[0] as FakeExecution;
                        setTimeout(() => w.tasks.finish(running, 130), 5);
                    },
                });
                await replyAnswer(w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 4_000 }), 'running');
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'stop_build' })),
                    /^CMSIS 'stop_build' on HE: stopped 'cbuild demo\.csolution\.yml --active HE' \(ended [\d.]+ s after the stop request; job b-1\)\. Its outputs are incomplete: cmsis_action build before load or flash\.$/);
                assert.strictEqual(stops, 1);
                assert.strictEqual(w.tracker.last('build')?.state, 'cancelled');
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'status' })),
                    /^No CMSIS job in flight in this window\. Last results: build on HE stopped [\d.]+ s ago \(job b-1, 'cbuild demo\.csolution\.yml --active HE'\)\.\nNo CMSIS task is running in this window\.$/);

                assert.strictEqual(await textAnswer(w.handler.handleCmsisCommand({ action: 'stop_build' })),
                    'CMSIS \'stop_build\' on HE: nothing to stop — no build is running in this window.');
                assert.strictEqual(stops, 1, 'nothing was issued');
            });

            test('stop_build terminates what the command left, counts it as stopped whatever its exit code, and says when one survives', async () => {
                const w = jobWorld();
                let execution: FakeExecution | undefined;
                solutionOn('HE', {
                    'cmsis-csolution.build': () => {
                        execution = w.tasks.start(w.tasks.execution(BUILD_TASK));
                        return execution;
                    },
                    'cmsis-csolution.stopBuild': () => undefined,
                });
                await replyAnswer(w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 4_000 }), 'running');
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'stop_build' })),
                    /^CMSIS 'stop_build' on HE: stopped 'cbuild demo\.csolution\.yml --active HE' \(ended [\d.]+ s after the stop request; 'cbuild demo\.csolution\.yml --active HE' needed a second terminate; job b-1\)\./);
                assert.strictEqual(execution?.terminateCalls, 1);
                const stopped = w.tracker.last('build');
                assert.strictEqual(stopped?.state, 'cancelled', 'ended without an exit code after the stop request: stopped');
                assert.strictEqual(stopped?.executions[0].stopRequested, true);

                again();
                const s = jobWorld();
                const stubborn = s.tasks.start(s.tasks.execution(BUILD_TASK, true));
                solutionOn('HE', { 'cmsis-csolution.stopBuild': () => undefined });
                const refused = await refusalOf(s.handler.handleCmsisCommand({ action: 'stop_build' }), 'TASK_FAILED');
                assert.match(errorDetail(refused), /^CMSIS 'stop_build' on HE: 'cbuild demo\.csolution\.yml --active HE' is still running 1\d s after the stop request, although terminated twice\.\nStop it with the trash icon of its terminal in the Terminal panel/);
                assert.strictEqual(stubborn.terminateCalls, 1);
            });

            suite('a tasks.json without CMSIS tasks', () => {
                let dir: string;
                /** The active target's cbuild-run.yml as the host's lookup, the one flash takes, answers it. */
                let named: string | undefined;
                setup(() => {
                    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-tasks-'));
                    named = undefined;
                });
                teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

                /** A cbuild-run.yml for HE at `file`, with a debugger node when `debuggerName` is given. */
                const cbuildRun = (debuggerName?: string, file = path.join(dir, 'demo+HE.cbuild-run.yml')): string => {
                    fs.writeFileSync(file, ['cbuild-run:', '  target-type: HE', ...(debuggerName ? ['  debugger:', `    name: ${debuggerName}`, '    protocol: swd'] : []), ''].join('\n'));
                    return file;
                };
                /** A job world with no CMSIS task in tasks.json, whose host names `named` as the active cbuild-run.yml. */
                const tasksWorld = (more: Partial<HandlerHost> = {}): ReturnType<typeof jobWorld> => {
                    const w = jobWorld(20, { activeCbuildRunFile: async () => named, ...more });
                    w.tasks.fetched = [];
                    return w;
                };
                const LOAD_LABELS = ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase'];

                test('the debugger is named: Update Debug Tasks runs once, the labels are read again, and the action goes on', async () => {
                    const w = tasksWorld();
                    named = cbuildRun('CMSIS-DAP@pyOCD');
                    let updates = 0;
                    solutionOn('HE', {
                        'cmsis-csolution.updateDebugTasks': () => {
                            updates++;
                            setTimeout(() => {
                                w.tasks.fetched = workspaceTasks('/w', LOAD_LABELS);
                            }, 30);
                        },
                        'cmsis-csolution.cmsisLoad': runs(w.tasks, shellTask('CMSIS Load'), 0),
                    });
                    assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'load' })),
                        /^tasks\.json had no CMSIS tasks; Update Debug Tasks wrote them for the debugger 'CMSIS-DAP@pyOCD'\. ✅ CMSIS 'load' succeeded on HE \(task 'CMSIS Load' exited 0 after [\d.]+ s, job l-1\)\./);
                    assert.strictEqual(updates, 1);
                });

                test('Update Debug Tasks that writes none: run once, never again, and the refusal says so', async () => {
                    const w = tasksWorld();
                    named = cbuildRun('J-Link Server');
                    let updates = 0;
                    solutionOn('HE', {
                        'cmsis-csolution.updateDebugTasks': () => {
                            updates++;
                        },
                        'cmsis-csolution.cmsisErase': () => assert.fail('nothing runs without the task'),
                    });
                    const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'erase' }), 'INVALID_ARGUMENT');
                    assert.strictEqual(errorDetail(refused), 'CMSIS \'erase\' on HE not started: the solution\'s .vscode/tasks.json has no CMSIS tasks, '
                        + 'so there is no \'CMSIS Erase\' to run; Update Debug Tasks (cmsis-csolution.updateDebugTasks) ran for the debugger '
                        + '\'J-Link Server\' but wrote none.\n'
                        + 'Ask the user to open Manage Solution Settings (command cmsis-csolution.manageSolution) and choose a debugger on its '
                        + 'Debugger page; CMSIS Solution then writes the CMSIS tasks. Until then, flash programs the target.');
                    assert.strictEqual(updates, 1);
                    assert.ok(w.tasks.fetchCount >= 2, 'the labels were read again');
                });

                test('no debugger named, or no cbuild-run.yml yet: Update Debug Tasks is not run, and the refusal names the next step', async () => {
                    const w = tasksWorld();
                    named = cbuildRun();
                    let updates = 0;
                    const update = (): void => {
                        updates++;
                    };
                    solutionOn('HE', { 'cmsis-csolution.updateDebugTasks': update });
                    const unnamed = await refusalOf(w.handler.handleCmsisCommand({ action: 'run' }), 'INVALID_ARGUMENT');
                    assert.strictEqual(unnamed.message, 'CMSIS \'run\' on HE not started: the solution\'s .vscode/tasks.json has no CMSIS tasks, '
                        + 'so there is no \'CMSIS Run\' to run; demo+HE.cbuild-run.yml names no debugger.');
                    assert.ok(unnamed.hint?.startsWith('Ask the user to open Manage Solution Settings (command cmsis-csolution.manageSolution)'), unnamed.hint);

                    named = undefined;
                    const unbuilt = await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_run' }), 'INVALID_ARGUMENT');
                    assert.strictEqual(unbuilt.message, 'CMSIS \'load_and_run\' on HE not started: the solution\'s .vscode/tasks.json has no CMSIS tasks, '
                        + 'so there is no \'CMSIS Load+Run\' to run; the active target has no cbuild-run.yml yet.');
                    assert.ok(unbuilt.hint?.startsWith('cmsis_action build first: its convert writes the cbuild-run.yml'), unbuilt.hint);
                    assert.strictEqual(updates, 0);
                });

                test('load_and_debug and attach without CMSIS tasks: refused with the reason while the setting keeps CMSIS Solution from writing them', async () => {
                    const w = tasksWorld({ autoDebugLaunch: () => false });
                    named = cbuildRun('CMSIS-DAP@pyOCD');
                    let updates = 0;
                    solutionOn('HE', {
                        'cmsis-csolution.updateDebugTasks': () => {
                            updates++;
                        },
                        'cmsis-csolution.cmsisLoadAndDebug': () => assert.fail('nothing launches without a launch configuration'),
                        'cmsis-csolution.cmsisAttachDebugger': () => assert.fail('nothing attaches without a launch configuration'),
                    });
                    for (const action of ['load_and_debug', 'attach'] as const) {
                        const refused = await refusalOf(w.handler.handleCmsisCommand({ action }), 'INVALID_ARGUMENT');
                        assert.strictEqual(refused.message, `CMSIS '${action}' on HE not started: CMSIS Solution has no launch configuration to start `
                            + 'for this target; the setting cmsis-csolution.autoDebugLaunch is off, so CMSIS Solution writes no tasks.json.');
                        assert.ok(refused.hint?.startsWith('Ask the user to turn on cmsis-csolution.autoDebugLaunch'), refused.hint);
                    }
                    assert.strictEqual(updates, 0, 'with the setting off, Update Debug Tasks would write nothing');
                });

                test('load_and_debug without CMSIS tasks: Update Debug Tasks writes them, and the result says so first', async () => {
                    const w = tasksWorld();
                    named = cbuildRun('CMSIS-DAP@pyOCD');
                    w.x.sessionStatus = status('running');
                    w.x.getThreads = async () => [{ id: 1, name: 'main' }];
                    solutionOn('HE', {
                        'cmsis-csolution.updateDebugTasks': () => {
                            setTimeout(() => {
                                w.tasks.fetched = workspaceTasks('/w', LOAD_LABELS);
                            }, 30);
                        },
                        'cmsis-csolution.cmsisLoadAndDebug': () => {
                            const load = w.tasks.execution(shellTask('CMSIS Load'));
                            setTimeout(() => {
                                w.tasks.start(load);
                                w.tasks.finish(load, 0);
                                w.x.session = true;
                            }, 5);
                        },
                    });
                    assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'load_and_debug' })),
                        /^tasks\.json had no CMSIS tasks; Update Debug Tasks wrote them for the debugger 'CMSIS-DAP@pyOCD'\. CMSIS 'load_and_debug' completed on HE — 'CMSIS Load' exited 0 after [\d.]+ s \(job d-1\); debug session survived the connect/);
                });

                test('the launch configuration: none of CMSIS Solution\'s while the setting is off is refused; a Load that never starts is the answer and stays in status', async () => {
                    const w = tasksWorld({
                        autoDebugLaunch: () => false,
                        workspaceFolders: () => [{ uri: vscode.Uri.file(dir), name: 'demo', index: 0 }],
                    });
                    w.tasks.fetched = workspaceTasks(dir, LOAD_LABELS);
                    fs.mkdirSync(path.join(dir, '.vscode'));
                    const launchJson = (configurations: unknown[]): void => {
                        fs.writeFileSync(path.join(dir, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations }));
                    };
                    launchJson([
                        { name: 'CMSIS-DAP@pyOCD (attach)', type: 'gdbtarget', request: 'attach', cmsis: { cbuildRunFile: 'x' } },
                        { name: 'mine', type: 'gdbtarget', request: 'launch' },
                    ]);
                    solutionOn('HE', {
                        'cmsis-csolution.getSolutionFile': () => path.join(dir, 'demo.csolution.yml'),
                        'cmsis-csolution.cmsisLoadAndDebug': () => undefined,
                    });
                    const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_debug' }), 'INVALID_ARGUMENT');
                    assert.strictEqual(refused.message, 'CMSIS \'load_and_debug\' on HE not started: CMSIS Solution has no launch configuration to start '
                        + 'for this target; .vscode/launch.json has no launch configuration of CMSIS Solution, and the setting '
                        + 'cmsis-csolution.autoDebugLaunch is off, so CMSIS Solution writes none.');

                    launchJson([{ name: 'CMSIS-DAP@pyOCD (launch)', type: 'gdbtarget', request: 'launch', preLaunchTask: 'CMSIS Load', cmsis: { cbuildRunFile: 'x' } }]);
                    const silent = await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_debug' }), 'TASK_FAILED');
                    assert.strictEqual(errorDetail(silent), 'CMSIS \'load_and_debug\' on HE: nothing started within 10 s of issuing '
                        + '\'cmsis-csolution.cmsisLoadAndDebug\' (job d-1). Neither its pre-launch Load nor a session started.\n'
                        + 'CMSIS Solution may be showing a picker, or a message such as "Unable to start debugging" when it has no launch '
                        + 'configuration for the target: ask the user what VS Code shows, then repeat the call.');
                    assert.strictEqual(w.tracker.last('load_and_debug')?.state, 'not-started', 'cmsis_action status keeps the job');
                });

                test('one lookup with flash: a relative answer, a file that is gone and out/<solution>+<target> are no cbuild-run.yml', async () => {
                    // The extension answers through the host's lookup, as flash asks it, and its command answers the same.
                    // A relative answer resolved against the solution's folder, and the out/ convention, would both find a
                    // file that names a debugger: Update Debug Tasks reads neither of them.
                    const solution = path.join(dir, 'demo.csolution.yml');
                    const relative = 'demo+HE.cbuild-run.yml';
                    cbuildRun('CMSIS-DAP@pyOCD', path.join(dir, relative));
                    fs.mkdirSync(path.join(dir, 'out'));
                    cbuildRun('CMSIS-DAP@pyOCD', path.join(dir, 'out', relative));
                    let answer = relative;
                    const extension: SolutionCommands = {
                        extensionActive: () => true,
                        commands: async () => [GET_CBUILD_RUN_FILE],
                        execute: async () => answer,
                    };
                    const w = tasksWorld({
                        activeCbuildRunFile: () => activeCbuildRunFile(extension),
                        workspaceFolders: () => [{ uri: vscode.Uri.file(dir), name: 'demo', index: 0 }],
                        findFiles: async () => [],
                        // No pyOCD can be found: flash never programs anything here.
                        toolEnvironment: () => ({ extension: () => undefined, pathEnv: '', platform: process.platform }),
                    });
                    let asked = 0;
                    let updates = 0;
                    solutionOn('HE', {
                        'cmsis-csolution.getSolutionFile': () => solution,
                        [GET_CBUILD_RUN_FILE]: () => {
                            asked++;
                            return answer;
                        },
                        'cmsis-csolution.updateDebugTasks': () => {
                            updates++;
                        },
                    });
                    for (const said of [relative, '', path.join(dir, 'gone+HE.cbuild-run.yml')]) {
                        answer = said;
                        const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'load' }), 'INVALID_ARGUMENT');
                        assert.strictEqual(refused.message, 'CMSIS \'load\' on HE not started: the solution\'s .vscode/tasks.json has no CMSIS tasks, '
                            + 'so there is no \'CMSIS Load\' to run; the active target has no cbuild-run.yml yet.', `cmsis_action, answer ${JSON.stringify(said)}`);
                        const flashed = await refusalOf(w.handler.handleFlash({}), 'INVALID_ARGUMENT');
                        assert.match(errorDetail(flashed), /^No cbuild-run file found /, `flash, answer ${JSON.stringify(said)}`);
                    }
                    assert.strictEqual(updates, 0, 'Update Debug Tasks is not run for a file it would not read');
                    assert.strictEqual(asked, 0, 'cmsis_action asks through the host, not with a getCbuildRunFile of its own');
                });
            });

            test('load_and_run notes a serial port the window holds; build does not (#49)', async () => {
                SerialPortMock.binding.reset();
                SerialPortMock.binding.createPort('/dev/cu.usbmodem1102');
                const serial: MockSerial = mockSerial();
                await serial.controller.open({ path: '/dev/cu.usbmodem1102' }, { owner: 'aaaaaaaa-1111', rule: 'manual' });
                const w = jobWorld(20, { ownedSerial: () => serial.controller });
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoadAndRun': () => {
                        const load = w.tasks.execution(shellTask('CMSIS Load'));
                        setTimeout(() => {
                            w.tasks.start(w.tasks.execution(shellTask('CMSIS Load+Run')), false);
                            w.tasks.start(load);
                            w.tasks.finish(load, 0);
                            w.tasks.start(w.tasks.execution(shellTask('CMSIS Run')));
                        }, 5);
                    },
                    'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 0, true),
                });
                const loaded = await textAnswer(w.handler.handleCmsisCommand({ action: 'load_and_run' }));
                assert.ok(loaded.endsWith('\n/dev/cu.usbmodem1102 is open in this window; if the probe\'s VCP re-enumerates during programming, reopen it.'),
                    loaded);
                const built = await textAnswer(w.handler.handleCmsisCommand({ action: 'build' }));
                assert.ok(!built.includes('usbmodem'), built);
                await serial.controller.close();
                SerialPortMock.binding.reset();
            });

            test('load_and_run: flashed and CMSIS Run stays up; a failed Load answers with its code', async () => {
                const w = jobWorld();
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoadAndRun': () => {
                        const load = w.tasks.execution(shellTask('CMSIS Load'));
                        setTimeout(() => {
                            w.tasks.start(w.tasks.execution(shellTask('CMSIS Load+Run')), false);
                            w.tasks.start(load);
                            w.tasks.finish(load, 0);
                            w.tasks.start(w.tasks.execution(shellTask('CMSIS Run')));
                        }, 5);
                    },
                });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'load_and_run' })),
                    /^✅ CMSIS 'load_and_run' on HE: flashed \('CMSIS Load' exited 0 after [\d.]+ s\); 'CMSIS Run' started and stays active — with a probe adapter it hosts the GDB server \(job r-1\); an FVP runs the image without one\. cmsis_action attach to debug; cmsis_action stop_run frees the probe\.$/);

                const failing = jobWorld();
                again();
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoadAndRun': () => {
                        const load = failing.tasks.execution(shellTask('CMSIS Load'));
                        const parent = failing.tasks.execution(shellTask('CMSIS Load+Run'));
                        setTimeout(() => {
                            failing.tasks.start(parent, false);
                            failing.tasks.start(load);
                            failing.tasks.finish(load, 1);
                            failing.tasks.finish(parent, undefined, false);
                        }, 5);
                    },
                });
                const failed = await refusalOf(failing.handler.handleCmsisCommand({ action: 'load_and_run' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'load_and_run' FAILED on HE — 'CMSIS Load' exited with code 1 after [\d.]+ s, so 'CMSIS Run' was not started \(job r-1\)\.$/);
                assert.ok(failed.hint?.includes('call flash, which returns pyOCD\'s own error lines'), failed.hint);
            });

            test('run: CMSIS Run alone stays up and the result says nothing was programmed; a Run that ends fails with its code (#73)', async () => {
                const w = jobWorld();
                solutionOn('HE', {
                    'cmsis-csolution.cmsisRun': () => {
                        setTimeout(() => w.tasks.start(w.tasks.execution(shellTask('CMSIS Run'))), 5);
                    },
                });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'run' })),
                    /^✅ CMSIS 'run' on HE: 'CMSIS Run' started and stays active — with a probe adapter it hosts the GDB server \(job g-1\); nothing was built or programmed\. The flash is untouched; the pyOCD task resets the target and lets the firmware run \(--reset-run\), the J-Link task leaves it running as it was \(-nohalt\)\. The FVP task starts the model with the last-built image and hosts no GDB server: there, use load_and_debug for a session\. cmsis_action attach to debug; cmsis_action stop_run frees the probe\.$/);

                const failing = jobWorld();
                again();
                solutionOn('HE', {
                    'cmsis-csolution.cmsisRun': () => {
                        const run = failing.tasks.execution(shellTask('CMSIS Run'));
                        setTimeout(() => {
                            failing.tasks.start(run);
                            failing.tasks.finish(run, 1);
                        }, 5);
                    },
                });
                const failed = await refusalOf(failing.handler.handleCmsisCommand({ action: 'run' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'run' FAILED on HE — 'CMSIS Run' ended with code 1 after [\d.]+ s; it hosts the GDB server and must stay up \(job g-1\)\.$/);
                assert.ok(failed.hint?.startsWith('A GDB server that ends at once usually finds the probe or its port taken, or no probe at all.'), failed.hint);
                assert.ok(failed.hint?.includes('which no tool reads: ask the user for its last lines'), failed.hint);
            });

            test('load_and_debug: a failed pre-launch Load is the answer before any session probe; a good one leads the result', async () => {
                const w = jobWorld(50);
                solutionOn('HE', { 'cmsis-csolution.cmsisLoadAndDebug': runs(w.tasks, shellTask('CMSIS Load'), 1) });
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_debug' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'load_and_debug' FAILED on HE — its pre-launch task 'CMSIS Load' exited with code 1 after [\d.]+ s; no debug session was started \(job d-1\)\.$/);
                assert.deepStrictEqual(w.x.argsOf('getThreads'), [], 'no session probe');
                again();

                const good = jobWorld(50);
                good.x.sessionStatus = status('running');
                good.x.getThreads = async () => [{ id: 1, name: 'main' }];
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoadAndDebug': () => {
                        const load = good.tasks.execution(shellTask('CMSIS Load'));
                        setTimeout(() => {
                            good.tasks.start(load);
                            good.tasks.finish(load, 0);
                            good.x.session = true;
                        }, 5);
                    },
                });
                const text = await textAnswer(good.handler.handleCmsisCommand({ action: 'load_and_debug' }));
                assert.match(text, /^CMSIS 'load_and_debug' completed on HE — 'CMSIS Load' exited 0 after [\d.]+ s \(job d-1\); debug session survived the connect \(t\+3s: 1 thread\(s\), t\+6s: 1 thread\(s\) — target threads present\)\. State: \{/);
            });

            test('load_and_debug: a session lost while connecting points at the GDB server\'s lines, and a probe out of time is no verdict on the probe', async () => {
                const w = jobWorld(50);
                let probes = 0;
                w.x.getThreads = async () => {
                    probes++;
                    if (probes === 1) {
                        throw new HardwareTimeoutError('DAP threads', 2_000);
                    }
                    w.x.session = false;
                    throw new Error('session ended');
                };
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoadAndDebug': () => {
                        const load = w.tasks.execution(shellTask('CMSIS Load'));
                        setTimeout(() => {
                            w.tasks.start(load);
                            w.tasks.finish(load, 0);
                            w.x.session = true;
                        }, 5);
                    },
                });
                const lost = await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_debug' }), 'TASK_FAILED');
                assert.match(lost.message, /^CMSIS 'load_and_debug' on HE started a debug session but it did NOT survive the initial connect — 'CMSIS Load' exited 0 after [\d.]+ s \(job d-1\); t\+3s: thread probe failed — no answer within 2 s, then t\+6s: thread probe failed — session ended\.$/);
                assert.strictEqual(lost.hint, 'The GDB server or GDB ended while connecting: their error lines, listed below when there are any, say why '
                    + '(get_recent_problems {sources:[\'gdb-server\',\'dap\']} has the whole server log). Fix that, then cmsis_action load_and_debug again.');
            });

            test('load_and_debug whose session never showed: a launch the debug adapter refused during the call fails it, its records listed; without one it is running', async () => {
                const LOST_LAUNCH = 'The GDB server or GDB ended while connecting: their error lines, listed below when there are any, say why '
                    + '(get_recent_problems {sources:[\'gdb-server\',\'dap\']} has the whole server log). Fix that, then cmsis_action load_and_debug again.';
                /** One load_and_debug whose session is never seen: its command journals `records`, after a CMSIS Load that exits 0 when `load`. */
                const launch = (records: ProblemInput[], load = false): Promise<ToolText> => {
                    const w = jobWorld(50);
                    w.x.sessionStatus = status('no-session');
                    again();
                    solutionOn('HE', {
                        'cmsis-csolution.cmsisLoadAndDebug': () => {
                            const execution = load ? w.tasks.execution(shellTask('CMSIS Load')) : undefined;
                            setTimeout(() => {
                                if (execution) {
                                    w.tasks.start(execution);
                                    w.tasks.finish(execution, 0);
                                }
                                // What the session tracker journals from the adapter's failed response and the GDB server's output.
                                records.forEach((record) => problemJournal().append(record));
                            }, 5);
                        },
                    });
                    return journaled('launch01-1', () => w.handler.handleCmsisCommand({ action: 'load_and_debug' }));
                };

                // Corstone-300 FVP: GDB lost the model's GDB server during the launch, and the session ended between two polls.
                const reset = 'error response to \'launch\': Remote communication error.  Target disconnected: error while reading: Connection reset by peer.';
                const fvp = await refusalOf(launch([{ source: 'dap', origin: 'Arm-FVP (launch)', severity: 'error', message: reset, debugSessionId: 'fvp-1' }]),
                    'TASK_FAILED');
                assert.strictEqual(fvp.message, 'CMSIS \'load_and_debug\' on HE started no debug session — the debug adapter\'s launch failed.');
                assert.strictEqual(fvp.hint, LOST_LAUNCH);
                assert.match(renderProblemsBlock(fvp.data?.problems), new RegExp(`^\\nRecent problems:\\n  #\\d+ error dap ${reset.replace(/[.()]/g, '\\$&')}$`));

                // pyOCD after its Load, on a port another window's FVP held: the Load leads the message, the server's error line rides along.
                const unexpected = 'error response to \'launch\': Remote replied unexpectedly to \'vMustReplyEmpty\': timeout';
                const pyocd = await refusalOf(launch([
                    { source: 'gdb-server', origin: 'CMSIS_DAP@pyOCD (launch)', severity: 'error', message: '0001234 E Address already in use [gdbserver]' },
                    { source: 'dap', origin: 'CMSIS_DAP@pyOCD (launch)', severity: 'error', message: unexpected },
                ], true), 'TASK_FAILED');
                assert.match(pyocd.message, /^CMSIS 'load_and_debug' on HE started no debug session — 'CMSIS Load' exited 0 after [\d.]+ s \(job d-\d+\); the debug adapter's launch failed\.$/);
                assert.strictEqual(pyocd.hint, LOST_LAUNCH);
                const listed = renderProblemsBlock(pyocd.data?.problems).split('\n').slice(2);
                assert.deepStrictEqual(listed.map((line) => line.replace(/^  #\d+ /, '')),
                    ['error gdb-server 0001234 E Address already in use [gdbserver]', `error dap ${unexpected}`]);

                // Nothing journaled: a slow flash may still be on its way.
                const quiet = await replyAnswer(launch([]), 'running');
                assert.ok(quiet.startsWith('CMSIS \'load_and_debug\' on HE issued via \'cmsis-csolution.cmsisLoadAndDebug\'. '
                    + 'The flash/connect pipeline is running in the CMSIS extension'), quiet);
            });

            suite('the program of a failed Load or launch: J-Link and its PATH', () => {
                /** CMSIS Load as CMSIS Solution 1.72.0 writes it for the J-Link adapter: on Windows (a tester's XMC4700 project), and on macOS and Linux. */
                const JLINK_LOAD_WINDOWS = 'echo Connect > .cmd.jlink && echo LoadFile "out/snmp_agent_demo/snmp_agent_demo_flash/snmp_agent_demo.axf" '
                    + '>> .cmd.jlink && echo Exit >> .cmd.jlink && JLink.exe -device XMC4700-F144x2048 -if swd -speed 4000 -commandfile .cmd.jlink';
                const JLINK_LOAD_POSIX = 'echo Connect > .cmd.jlink && echo LoadFile "out/blinky/blinky.axf" >> .cmd.jlink && echo Exit >> .cmd.jlink && '
                    + 'JLinkExe -device XMC4700-F144x2048 -if swd -speed 4000 -commandfile .cmd.jlink';
                const SEGGER_JLINK = 'C:\\Program Files\\SEGGER\\JLink';
                const LABELS = ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase'];
                const loadTask = (commandLine: string): FixtureTask => ({ ...shellTask('CMSIS Load'), execution: { commandLine } });
                /** A Windows machine whose files are `files`, compared without regard to case; `terminalPath` is the PATH of terminal.integrated.env.windows. */
                const windowsTools = (files: readonly string[], terminalPath?: string): ToolEnvironment => ({
                    extension: () => undefined,
                    pathEnv: 'C:\\Windows\\system32;C:\\Windows',
                    platform: 'win32',
                    env: (name) => ({ PATHEXT: '.COM;.EXE;.BAT;.CMD', PROGRAMFILES: 'C:\\Program Files' } as Record<string, string>)[name.toUpperCase()],
                    terminalEnv: () => (terminalPath === undefined ? undefined : { PATH: terminalPath }),
                    isFile: (file) => files.some((known) => known.toLowerCase() === file.toLowerCase()),
                    listDir: () => [],
                });
                /** The fix and the pointer every hint about a missing program ends with; the procedure holds the steps. */
                const STEPS = 'then restart VS Code completely (all windows); knowledge_get { id: "proc-debugger-troubleshooting" } has the steps.';
                const NOT_FOUND_TAIL = `${STEPS} This is a terminal result — do not wait for an output file.`;
                const JLINK_MEANING = '"Cannot connect to J-Link" there means J-Link finds no free probe: another task or session holds it '
                    + '(cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks), or the probe is not connected or lacks its USB driver (ask the user); '
                    + '"Cannot connect to target" means the probe answers but the device does not: its power, the cable, or the device name the task passes. '
                    + 'This is a terminal result — do not wait for an output file.';
                let dir = '';
                setup(() => {
                    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-jlink-'));
                });
                teardown(() => {
                    fs.rmSync(dir, { recursive: true, force: true });
                });

                /** The hint of a load whose J-Link task fails with code 1 after `afterMs` of real time, on a clock 20 times as fast. */
                const failedLoadHint = async (tools: ToolEnvironment, commandLine: string, afterMs = 5): Promise<string | undefined> => {
                    const w = jobWorld(20, { toolEnvironment: () => tools });
                    w.tasks.fetched = workspaceTasks(dir, LABELS);
                    solutionOn('HE', {
                        'cmsis-csolution.getSolutionFile': () => path.join(dir, 'demo.csolution.yml'),
                        'cmsis-csolution.cmsisLoad': () => {
                            const load = w.tasks.execution(loadTask(commandLine));
                            setTimeout(() => {
                                w.tasks.start(load);
                                setTimeout(() => w.tasks.finish(load, 1), afterMs);
                            }, 5);
                        },
                    });
                    const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'load' }), 'TASK_FAILED');
                    assert.match(failed.message, /^❌ CMSIS 'load' FAILED on HE — task 'CMSIS Load' exited with code 1 after [\d.]+ s \(job l-1\)\.$/);
                    again();
                    return failed.hint;
                };

                test('Windows: a J-Link Load that fails at once names JLink.exe missing, or the SEGGER folder that holds it; found on the tasks\' PATH, J-Link\'s own lines', async () => {
                    assert.strictEqual(await failedLoadHint(windowsTools([]), JLINK_LOAD_WINDOWS),
                        'JLink.exe is not on the PATH of the CMSIS tasks (searched: VS Code\'s PATH), so \'CMSIS Load\' could not start it. Ask the user to install '
                            + `the SEGGER J-Link Software or add its folder to the system or user PATH, ${NOT_FOUND_TAIL}`);
                    assert.strictEqual(await failedLoadHint(windowsTools([`${SEGGER_JLINK}\\JLink.exe`]), JLINK_LOAD_WINDOWS),
                        'JLink.exe is not on the PATH of the CMSIS tasks (searched: VS Code\'s PATH), so \'CMSIS Load\' could not start it, but '
                            + `${SEGGER_JLINK} holds it. Ask the user to add that folder to the system or user PATH, ${NOT_FOUND_TAIL}`);
                    assert.strictEqual(await failedLoadHint(windowsTools([`${SEGGER_JLINK}\\JLink.exe`], `${SEGGER_JLINK};\${env:PATH}`), JLINK_LOAD_WINDOWS),
                        'Its output is in the \'CMSIS Load\' terminal, which no tool reads: ask the user for the terminal\'s last lines. JLink.exe is on the PATH '
                            + `of the CMSIS tasks (${SEGGER_JLINK}\\JLink.exe, from terminal.integrated.env.windows), so it ran and reported the failure there. `
                            + JLINK_MEANING);
                });

                test('macOS and Linux: JLinkExe missing from tools-environment.yml and VS Code\'s PATH; a J-Link Load that failed slowly asks for the terminal\'s lines', async () => {
                    fs.mkdirSync(path.join(dir, '.cmsis'));
                    fs.writeFileSync(path.join(dir, '.cmsis', 'tools-environment.yml'), ['cmsis-tools-environment:', '  version: 1.0.0', '  environment:',
                        '    path:', '      - /x/cmsis-toolbox/bin', '      - /x/gcc/bin', ''].join('\n'));
                    const looked: string[] = [];
                    const linux: ToolEnvironment = {
                        extension: () => undefined, pathEnv: '/usr/bin:/bin', platform: 'linux', listDir: () => [],
                        isFile: (file) => {
                            looked.push(file);
                            return false;
                        },
                    };
                    assert.strictEqual(await failedLoadHint(linux, JLINK_LOAD_POSIX),
                        'JLinkExe is not on the PATH of the CMSIS tasks (searched: .cmsis/tools-environment.yml, VS Code\'s PATH), so \'CMSIS Load\' could not '
                            + `start it. Ask the user to install the SEGGER J-Link Software or add its folder to the system or user PATH, ${NOT_FOUND_TAIL}`);
                    assert.deepStrictEqual(looked, ['/x/cmsis-toolbox/bin/JLinkExe', '/x/gcc/bin/JLinkExe', '/usr/bin/JLinkExe', '/bin/JLinkExe',
                        '/opt/SEGGER/JLink/JLinkExe']);
                    looked.length = 0;
                    // 150 ms of real time is 3 s on the handler's clock: J-Link ran, so its own lines are asked for and nothing is looked up.
                    assert.strictEqual(await failedLoadHint(linux, JLINK_LOAD_POSIX, 150),
                        `Its output is in the 'CMSIS Load' terminal, which no tool reads: ask the user for the terminal's last lines. ${JLINK_MEANING}`);
                    assert.deepStrictEqual(looked, []);
                });

                test('a pyOCD Load keeps the flash hint word for word, at once or not', async () => {
                    const w = jobWorld(20, { toolEnvironment: () => windowsTools([]) });
                    const pyocd: FixtureTask = {
                        ...shellTask('CMSIS Load'),
                        execution: { command: 'pyocd', args: ['load', '--probe', 'cmsisdap:', '--cbuild-run', '/w/out/demo+HE.cbuild-run.yml'] },
                    };
                    solutionOn('HE', { 'cmsis-csolution.cmsisLoad': runs(w.tasks, pyocd, 1) });
                    const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'load' }), 'TASK_FAILED');
                    assert.strictEqual(failed.hint, 'Its output is in the \'CMSIS Load\' terminal, which no tool reads: call flash, which returns pyOCD\'s own '
                        + 'error lines, or ask the user for the terminal\'s last lines. "Waiting for a debug probe" there means pyOCD sees no free probe: '
                        + 'another task or session holds it (cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks), or the probe is not connected '
                        + 'or lacks its USB driver (ask the user). This is a terminal result — do not wait for an output file.');
                });

                test('load_and_debug whose adapter cannot spawn JLinkGDBServerCL.exe: on the tasks\' PATH only, in the SEGGER folder only, nowhere, on VS Code\'s PATH', async () => {
                    fs.mkdirSync(path.join(dir, '.vscode'));
                    fs.writeFileSync(path.join(dir, '.vscode', 'launch.json'), JSON.stringify({
                        version: '0.2.0',
                        configurations: [{
                            name: 'JLink (launch)', type: 'gdbtarget', request: 'launch', preLaunchTask: 'CMSIS Load',
                            target: { server: 'JLinkGDBServerCL.exe', serverParameters: ['-device', 'XMC4700-F144x2048'], port: '3333' },
                            cmsis: { cbuildRunFile: '${command:cmsis-csolution.getCbuildRunFile}' },
                        }],
                    }));
                    const launchHint = async (tools: ToolEnvironment): Promise<string | undefined> => {
                        const w = jobWorld(50, { toolEnvironment: () => tools });
                        w.tasks.fetched = workspaceTasks(dir, LABELS);
                        w.x.getThreads = async () => {
                            w.x.session = false;
                            throw new Error('session ended');
                        };
                        solutionOn('HE', {
                            'cmsis-csolution.getSolutionFile': () => path.join(dir, 'demo.csolution.yml'),
                            'cmsis-csolution.cmsisLoadAndDebug': () => {
                                const load = w.tasks.execution(loadTask(JLINK_LOAD_WINDOWS));
                                setTimeout(() => {
                                    w.tasks.start(load);
                                    w.tasks.finish(load, 0);
                                    w.x.session = true;
                                    // What the session tracker journals from cdt-gdb-adapter's output (src/core/problemCodes.ts).
                                    problemJournal().append({
                                        source: 'dap', origin: 'JLink (launch)', severity: 'error', code: 'GDB_SERVER_NOT_FOUND',
                                        message: 'gdbserver has hit error Error: spawn JLinkGDBServerCL.exe ENOENT',
                                    });
                                }, 5);
                            },
                        });
                        const lost = await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_debug' }), 'TASK_FAILED');
                        assert.match(lost.message, /^CMSIS 'load_and_debug' on HE started a debug session but it did NOT survive the initial connect — 'CMSIS Load' exited 0/);
                        again();
                        return lost.hint;
                    };
                    const server = `${SEGGER_JLINK}\\JLinkGDBServerCL.exe`;
                    const onTasksOnly = await launchHint(windowsTools([server], `${SEGGER_JLINK};\${env:PATH}`));
                    assert.strictEqual(onTasksOnly,
                        'The debug adapter could not start the GDB server: JLinkGDBServerCL.exe is on the PATH of the CMSIS tasks '
                            + `(${SEGGER_JLINK}, from terminal.integrated.env.windows) but not on the PATH VS Code was started with, which the debug adapter `
                            + `uses. Ask the user to add ${SEGGER_JLINK} to the system or user PATH, ${STEPS}`);
                    const inSeggerOnly = await launchHint(windowsTools([server]));
                    assert.strictEqual(inSeggerOnly,
                        'The debug adapter could not start the GDB server: JLinkGDBServerCL.exe is on neither the PATH VS Code was started with nor the PATH '
                            + `of the CMSIS tasks (searched: VS Code's PATH), but ${SEGGER_JLINK} holds it. Ask the user to add that folder to the system or `
                            + `user PATH, ${STEPS}`);
                    assert.strictEqual(await launchHint(windowsTools([])),
                        'The debug adapter could not start the GDB server: JLinkGDBServerCL.exe is on neither the PATH VS Code was started with nor the PATH '
                            + 'of the CMSIS tasks (searched: VS Code\'s PATH). Ask the user to install the SEGGER J-Link Software or add its folder to the '
                            + `system or user PATH, ${STEPS}`);
                    for (const hint of [onTasksOnly, inSeggerOnly]) {
                        assert.ok(!/cmsis_action (?:run|attach)/.test(hint ?? ''), hint);
                    }
                    // On VS Code's PATH and still ENOENT: Node words a working directory that does not exist the same way.
                    assert.strictEqual(await launchHint({ ...windowsTools([server]), pathEnv: `C:\\Windows\\system32;${SEGGER_JLINK}` }),
                        `The debug adapter could not start the GDB server: JLinkGDBServerCL.exe is on the PATH VS Code was started with (${server}), so a `
                            + 'missing working directory is the likelier cause (Node reports it with the same ENOENT): check that the launch configuration\'s '
                            + 'cwd exists, then cmsis_action load_and_debug again.');
                });
            });

            test('refresh: the panel\'s Refresh, then csolution\'s messages from the rewritten index; an index that stays as it was answers running', async () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-refresh-'));
                try {
                    const index = path.join(dir, 'demo.cbuild-idx.yml');
                    const idx = (errors: string[], warnings: string[]): string => [
                        'build-idx:', '  csolution: demo.csolution.yml', '  messages:',
                        ...(errors.length > 0 ? ['    errors:', ...errors.map((message) => `      - "${message}"`)] : []),
                        ...(warnings.length > 0 ? ['    warnings:', ...warnings.map((message) => `      - "${message}"`)] : []),
                        '',
                    ].join('\n');
                    fs.writeFileSync(index, idx(['file \'RTE/CMSIS/RTX_Config.c\' not found; use --update-rte'], []));
                    let next = idx([], ['file \'RTE/CMSIS_Driver_Validation/DV_USART_Config.h.base\' not found; base version unknown']);
                    let refreshes = 0;
                    const rewrites = (): void => {
                        refreshes++;
                        setTimeout(() => fs.writeFileSync(index, next), 20);
                    };
                    solutionOn('HE', {
                        'cmsis-csolution.getSolutionFile': () => path.join(dir, 'demo.csolution.yml'),
                        'cmsis-csolution.refresh': rewrites,
                    });
                    const w = jobWorld(5);
                    assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'refresh' })),
                        /^✅ CMSIS 'refresh' on HE: the solution was converted with the RTE update after [\d.]+ s, and demo\.cbuild-idx\.yml records 0 error\(s\), 1 warning\(s\)\. csolution's warnings:\n  warning: file 'RTE\/CMSIS_Driver_Validation\/DV_USART_Config\.h\.base' not found; base version unknown\nNext: cmsis_action build\.$/);

                    next = idx(['component \'ARM::CMSIS:RTOS2:Keil RTX6\' not found'], []);
                    const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'refresh' }), 'TASK_FAILED');
                    assert.match(failed.message, /^❌ CMSIS 'refresh' on HE: the convert with the RTE update recorded 1 error\(s\), 0 warning\(s\) in demo\.cbuild-idx\.yml after [\d.]+ s:\n  error: component 'ARM::CMSIS:RTOS2:Keil RTX6' not found$/);
                    assert.ok(failed.hint?.startsWith('Fix the first error'), failed.hint);

                    again();
                    solutionOn('HE', {
                        'cmsis-csolution.getSolutionFile': () => path.join(dir, 'demo.csolution.yml'),
                        'cmsis-csolution.refresh': () => {
                            refreshes++;
                        },
                    });
                    assert.match(await replyAnswer(w.handler.handleCmsisCommand({ action: 'refresh', timeoutMs: 3_000 }), 'running'),
                        /^CMSIS 'refresh' on HE issued via 'cmsis-csolution\.refresh'; csolution has not rewritten demo\.cbuild-idx\.yml after [\d.]+ s\. /);
                    assert.strictEqual(refreshes, 3);
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            });

            test('a build whose csolution errors ask for --update-rte names refresh in its hint', async () => {
                const w = jobWorld();
                const diagnosis: JobDiagnosis = {
                    state: 'done', source: 'csolution', errorCount: 1, warningCount: 0, warnings: [],
                    errors: [{ severity: 'error', message: 'file \'/w/RTE/CMSIS/RTX_Config.c\' not found; use --update-rte' }],
                    text: '1 error from csolution:\n  error: file \'/w/RTE/CMSIS/RTX_Config.c\' not found; use --update-rte',
                };
                w.tracker.onDidFinishJob((job) => {
                    if (job.state === 'failed') {
                        w.tracker.completeWith(job.id, Promise.resolve(diagnosis));
                    }
                });
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 1, true) });
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.strictEqual(failed.hint, 'csolution misses files that a component brings ("use --update-rte"): cmsis_action refresh writes them — '
                    + 'the Refresh (Update RTE) of the CMSIS view — then cmsis_action build again.');
            });

            test('activate_environment: Reactivate Environment, then the tools of the rewritten record; no rewrite answers running; refusals', async () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-activate-'));
                try {
                    const solutionFile = path.join(dir, 'demo.csolution.yml');
                    const record = path.join(dir, '.cmsis', 'tools-environment.yml');
                    const environment = (cmake: string): string => [
                        'cmsis-tools-environment:', '  version: 1.0.0', '  environment:', '    path:', `      - /x/cmake/${cmake}/bin`,
                        '  tools:', '    - name: CMSIS-Toolbox', '      version: 2.15.1', `    - name: tools.kitware.cmake/${cmake}/bin`, '      origin: installed', '',
                    ].join('\n');
                    fs.mkdirSync(path.dirname(record));
                    fs.writeFileSync(record, environment('3.25.2'));
                    let activations = 0;
                    const handed: unknown[] = [];
                    const rewrites = (resource?: unknown): void => {
                        activations++;
                        handed.push(resource);
                        setTimeout(() => fs.writeFileSync(record, environment('3.31.5')), 20);
                    };
                    solutionOn('HE', { 'cmsis-csolution.getSolutionFile': () => solutionFile, 'environment-manager.reactivate': rewrites });
                    const w = jobWorld(5);
                    // No manifest: nothing to activate.
                    const noManifest = await refusalOf(w.handler.handleCmsisCommand({ action: 'activate_environment' }), 'INVALID_ARGUMENT');
                    assert.ok(noManifest.message.startsWith(`CMSIS 'activate_environment' on HE not attempted: no vcpkg-configuration.json from ${dir} up to the`), noManifest.message);
                    assert.strictEqual(activations, 0);

                    fs.writeFileSync(path.join(dir, 'vcpkg-configuration.json'), '{ "requires": { "arm:tools/kitware/cmake": "^3.31.5" } }\n');
                    assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'activate_environment' })),
                        /^✅ CMSIS 'activate_environment' on HE: vcpkg-configuration\.json was resolved and \.cmsis\/tools-environment\.yml rewritten after [\d.]+ s\. Tools of the CMSIS tasks now:\n  CMSIS-Toolbox 2\.15\.1\n  tools\.kitware\.cmake\/3\.31\.5\/bin\nNext: cmsis_action build\.$/);
                    assert.strictEqual(activations, 1);
                    // The command reads the manifest's Uri, as the Explorer's context menu hands it; without one it throws.
                    assert.strictEqual((handed[0] as vscode.Uri | undefined)?.fsPath, vscode.Uri.file(path.join(dir, 'vcpkg-configuration.json')).fsPath);

                    again();
                    solutionOn('HE', {
                        'cmsis-csolution.getSolutionFile': () => solutionFile,
                        'environment-manager.reactivate': () => {
                            activations++;
                        },
                    });
                    assert.match(await replyAnswer(w.handler.handleCmsisCommand({ action: 'activate_environment', timeoutMs: 3_000 }), 'running'),
                        /^CMSIS 'activate_environment' on HE issued via 'environment-manager\.reactivate'; CMSIS Solution has not rewritten \.cmsis\/tools-environment\.yml after [\d.]+ s\. /);
                    assert.strictEqual(activations, 2);

                    // Without the Environment Manager the command is not registered: refused before anything runs.
                    again();
                    solutionOn('HE', { 'cmsis-csolution.getSolutionFile': () => solutionFile });
                    const missing = await refusalOf(w.handler.handleCmsisCommand({ action: 'activate_environment' }), 'TASK_FAILED');
                    assert.ok(missing.message.includes('the Arm Tools Environment Manager extension (Arm.environment-manager) is not installed or not active'), missing.message);
                    assert.ok(missing.hint?.startsWith('Ask the user to install the Arm Tools Environment Manager'), missing.hint);
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            });

            test('a build whose vcpkg-configuration.json is newer than the tools record, or has none, says so before its result', async () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-stale-env-'));
                try {
                    const solutionFile = path.join(dir, 'demo.csolution.yml');
                    const manifest = path.join(dir, 'vcpkg-configuration.json');
                    const record = path.join(dir, '.cmsis', 'tools-environment.yml');
                    fs.writeFileSync(manifest, '{}\n');
                    const w = jobWorld();
                    solutionOn('HE', { 'cmsis-csolution.getSolutionFile': () => solutionFile, 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 0, true) });
                    assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'build' })),
                        /^Note: the tools environment of vcpkg-configuration\.json has not been activated in this window \(no \.cmsis\/tools-environment\.yml, the record of the tools the CMSIS tasks run with\): cmsis_action activate_environment does it\. ✅ CMSIS 'build' succeeded on HE/);

                    fs.mkdirSync(path.dirname(record));
                    fs.writeFileSync(record, 'cmsis-tools-environment:\n  tools: []\n');
                    const earlier = new Date(Date.now() - 60_000);
                    fs.utimesSync(record, earlier, earlier);
                    again();
                    solutionOn('HE', { 'cmsis-csolution.getSolutionFile': () => solutionFile, 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 0, true) });
                    assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'build' })),
                        /^Note: vcpkg-configuration\.json is newer than \.cmsis\/tools-environment\.yml \(the record of the tools the CMSIS tasks run with\), so the tasks still run with the tools of the earlier activation: cmsis_action activate_environment re-resolves it\. ✅ CMSIS 'build' succeeded on HE/);

                    const later = new Date(Date.now() + 60_000);
                    fs.utimesSync(record, later, later);
                    again();
                    solutionOn('HE', { 'cmsis-csolution.getSolutionFile': () => solutionFile, 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 0, true) });
                    assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'build' })), /^✅ CMSIS 'build' succeeded on HE/, 'a current record adds nothing');
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            });
        });

        suite('the probe guard (#46)', () => {
            const shellTask = (name: string): FixtureTask => ({ name, source: 'Workspace', definition: { type: 'shell' } });
            const again = (): void => {
                registrations?.dispose();
                registrations = undefined;
            };
            const guarded = (setupOwners: (tasks: FakeTasks, tracker: CmsisJobTracker) => void, session = false) => {
                const clock = fastClock(20);
                const tasks = new FakeTasks();
                tasks.fetched = workspaceTasks('/w', ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase']);
                const tracker = new CmsisJobTracker(tasks, clock);
                setupOwners(tasks, tracker);
                const x = new ScriptedExecutor();
                x.session = session;
                const issued: string[] = [];
                const record = (name: string) => () => {
                    issued.push(name);
                };
                solutionOn('HE', {
                    'cmsis-csolution.build': record('build'),
                    'cmsis-csolution.cmsisLoad': record('load'),
                    'cmsis-csolution.cmsisErase': record('erase'),
                    'cmsis-csolution.cmsisLoadAndRun': record('load_and_run'),
                    'cmsis-csolution.cmsisLoadAndDebug': record('load_and_debug'),
                    'cmsis-csolution.cmsisAttachDebugger': record('attach'),
                });
                return { handler: handlerFor(x, { ...clock, cmsisJobs: () => tracker }), issued, tasks, tracker, x };
            };

            test('a live CMSIS Run refuses load, erase, load_and_run, load_and_debug and flash, names itself, and lets attach and build through', async () => {
                const w = guarded((tasks) => {
                    tasks.start(tasks.execution(shellTask('CMSIS Load+Run')), false);
                    tasks.start(tasks.execution(shellTask('CMSIS Run')));
                });
                for (const action of ['load', 'erase', 'load_and_run', 'load_and_debug'] as const) {
                    const refused = await refusalOf(w.handler.handleCmsisCommand({ action, timeoutMs: 2_000 }), 'PROBE_BUSY');
                    assert.match(errorDetail(refused), new RegExp(`^CMSIS '${action}' on HE not started: the 'CMSIS Run' task \\(started [\\d.]+ s ago\\) holds the probe\\.\\n`
                        + 'cmsis_action \\{action:\'stop_run\'\\} first — or cmsis_action attach to debug the running firmware\\.$'));
                }
                const flash = await refusalOf(w.handler.handleFlash({}), 'PROBE_BUSY');
                assert.match(errorDetail(flash), /^Refusing to flash: the 'CMSIS Run' task \(started [\d.]+ s ago\) holds the probe\.\ncmsis_action \{action:'stop_run'\} first, then flash\.$/);
                assert.deepStrictEqual(w.issued, []);
                await w.handler.handleCmsisCommand({ action: 'attach', timeoutMs: 2_000 });
                await w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 2_000 });
                assert.deepStrictEqual(w.issued, ['attach', 'build']);
            });

            /**
             * A solution folder whose launch.json attach configuration points at a stand-in GDB server that
             * counts its clients: pyOCD halts the target for each one and, without --persist, shuts down when
             * it leaves, so the attach check must never be one of them. The stand-in attach command connects
             * nowhere; every connection the server sees comes from the check.
             */
            const attachWorld = async (attachName: string) => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-attach-'));
                let connections = 0;
                const server = net.createServer((socket) => {
                    connections++;
                    socket.destroy();
                });
                await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
                const port = (server.address() as net.AddressInfo).port;
                fs.mkdirSync(path.join(dir, '.vscode'));
                fs.writeFileSync(path.join(dir, '.vscode', 'launch.json'), JSON.stringify({
                    configurations: [{ name: attachName, type: 'gdbtarget', request: 'attach', target: { host: '127.0.0.1', port } }],
                }));
                const folders = () => [{ uri: vscode.Uri.file(dir), name: 'ws', index: 0 }];
                /** One call: `run` is the CMSIS Run task alive in the window, if any; `debuggerName` the cbuild-run.yml's debugger. */
                const attach = (run: FixtureTask | undefined, debuggerName?: string): { answer: Promise<ToolText>; issued: string[] } => {
                    again();
                    fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
                    const runFile = path.join(dir, 'out', 'demo+HE.cbuild-run.yml');
                    if (debuggerName) {
                        fs.mkdirSync(path.join(dir, 'out'));
                        fs.writeFileSync(runFile, `cbuild-run:\n  debugger:\n    name: ${debuggerName}\n`);
                    }
                    const clock = fastClock(20);
                    const tasks = new FakeTasks();
                    tasks.fetched = workspaceTasks(dir, ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase']);
                    const tracker = new CmsisJobTracker(tasks, clock);
                    if (run) {
                        tasks.start(tasks.execution(run));
                    }
                    const x = new ScriptedExecutor();
                    x.session = false;
                    x.sessionStatus = status('initializing');
                    const issued: string[] = [];
                    registrations = standIns({
                        'cmsis-csolution.getSolutionFile': () => path.join(dir, 'demo.csolution.yml'),
                        'cmsis-csolution.getActiveTargetSet': () => 'HE',
                        'cmsis-csolution.cmsisAttachDebugger': () => {
                            issued.push('attach');
                        },
                    });
                    const handler = handlerFor(x, {
                        ...clock, cmsisJobs: () => tracker, workspaceFolders: folders,
                        // The active target's cbuild-run.yml as CMSIS Solution names it, through the host's lookup.
                        activeCbuildRunFile: async () => (debuggerName ? runFile : undefined),
                    });
                    return { answer: handler.handleCmsisCommand({ action: 'attach' }), issued };
                };
                /** The clients the stand-in server saw, once a connection made by the call would have arrived. */
                const clients = async (): Promise<number> => {
                    await delay(50);
                    return connections;
                };
                const close = async (): Promise<void> => {
                    await new Promise<void>((done) => server.close(() => done()));
                    fs.rmSync(dir, { recursive: true, force: true });
                };
                return { attach, clients, close, port };
            };
            const runTask = (execution: unknown): FixtureTask => ({ ...shellTask('CMSIS Run'), execution });
            const PYOCD_RUN = { command: 'pyocd', args: ['gdbserver', '--probe', 'cmsisdap:', '--persist', '--reset-run', '--cbuild-run',
                '${command:cmsis-csolution.getCbuildRunFile}', '--quiet', '--log', '*.cbuild_run,*server=info'] };
            const FVP_RUN = { command: 'FVP_Corstone_SSE-300_Ethos-U55', args: ['-f', 'board/fvp_config.txt', '-a', 'out/Blinky/HE/Debug/Blinky.axf'] };

            test('attach never connects to the attach port first: a CMSIS Run of pyOCD, or none at all, and the attach goes ahead', async () => {
                const w = await attachWorld('CMSIS_DAP@pyOCD (attach)');
                try {
                    const withRun = w.attach(runTask(PYOCD_RUN));
                    const ran = await replyAnswer(withRun.answer, 'running');
                    assert.deepStrictEqual(withRun.issued, ['attach']);
                    assert.ok(!ran.includes('No CMSIS Run task is alive'), ran);
                    assert.strictEqual(await w.clients(), 0, 'the GDB server of the CMSIS Run saw a client before the attach');

                    // A GDB server the user started by hand, as the reconnect hints ask: no CMSIS Run task, no refusal.
                    const byHand = w.attach(undefined);
                    const text = await replyAnswer(byHand.answer, 'running');
                    assert.deepStrictEqual(byHand.issued, ['attach']);
                    assert.ok(text.startsWith('CMSIS \'attach\' on HE issued via \'cmsis-csolution.cmsisAttachDebugger\'.'), text);
                    assert.ok(text.endsWith(' No CMSIS Run task is alive in this window, so only a GDB server started outside it can serve '
                        + `127.0.0.1:${w.port} ('CMSIS_DAP@pyOCD (attach)'); without one the session ends at GDB's 15 s connect timeout. `
                        + 'With a probe adapter, cmsis_action run starts the server without programming; load_and_debug starts a session of its own.'), text);
                    assert.strictEqual(await w.clients(), 0, 'a server started without --persist would have shut down');
                } finally {
                    await w.close();
                }
            });

            test('attach while the CMSIS Run task is an FVP model without its plugin: refused without a connection', async () => {
                const w = await attachWorld('Arm-FVP@GDB (attach)');
                try {
                    const bare = w.attach(runTask(FVP_RUN));
                    const refused = await refusalOf(bare.answer, 'NO_SESSION');
                    assert.strictEqual(refused.message, 'CMSIS \'attach\' on HE not started: a CMSIS Run task is alive in this window, but it runs '
                        + `the FVP model without the GDB server plugin: nothing it started listens on 127.0.0.1:${w.port} ('Arm-FVP@GDB (attach)').`);
                    assert.ok(refused.hint?.startsWith('This adapter\'s CMSIS Run hosts no GDB server (an FVP runs the image without one;'), refused.hint);
                    assert.ok(refused.hint?.includes('Use load_and_debug'), refused.hint);
                    assert.deepStrictEqual(bare.issued, [], 'the attach command was not issued');

                    // A model shim (the fvp-debug-setup skill's fvp.sh) does not say what it runs: the target's Arm-FVP debugger does.
                    const shim = runTask({ command: '/w/.vscode/fvp.sh', args: ['-f', 'board/fvp_config.txt', '-a', 'x.axf'] });
                    const shimmed = w.attach(shim, 'Arm-FVP');
                    assert.match((await refusalOf(shimmed.answer, 'NO_SESSION')).message, /but it runs the FVP model without the GDB server plugin/);
                    assert.deepStrictEqual(shimmed.issued, []);
                    const otherDebugger = w.attach(shim, 'CMSIS-DAP@pyOCD');
                    await replyAnswer(otherDebugger.answer, 'running');
                    assert.deepStrictEqual(otherDebugger.issued, ['attach']);

                    // The model with its GDBServer plugin on the command line serves the attach.
                    const plugin = w.attach(runTask({ command: 'FVP_Corstone_SSE-320',
                        args: ['-D', '--plugin', '/opt/fvp/plugins/GDBServer.so', '-C', 'GDBServer.port=3333', '-a', 'x.axf'] }), 'Arm-FVP');
                    await replyAnswer(plugin.answer, 'running');
                    assert.deepStrictEqual(plugin.issued, ['attach']);
                    assert.strictEqual(await w.clients(), 0);
                } finally {
                    await w.close();
                }
            });

            test('a Load in flight: the same action attaches to it, another one waits', async () => {
                let load: FakeExecution | undefined;
                const w = guarded((tasks) => {
                    load = tasks.start(tasks.execution(shellTask('CMSIS Load')));
                });
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'erase' }), 'PROBE_BUSY');
                assert.match(errorDetail(refused), /^CMSIS 'erase' on HE not started: the 'CMSIS Load' task \(started [\d.]+ s ago\) is using the probe\.\ncmsis_action \{action:'status'\} waits for it\.$/);
                setTimeout(() => w.tasks.finish(load as FakeExecution, 0), 20);
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'load' })),
                    /^Attached to the load started from the CMSIS panel [\d.]+ s ago \(job l-1, not started again\)\. ✅ CMSIS 'load' succeeded on HE \(task 'CMSIS Load' exited 0/);
                assert.deepStrictEqual(w.issued, []);
            });

            test('a debug session now refuses load, erase and load_and_run too', async () => {
                const w = guarded(() => undefined, true);
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'load' }), 'PROBE_BUSY');
                assert.strictEqual(errorDetail(refused),
                    'CMSIS \'load\' on HE not started: a debug session is active (name=\'Fake session\', state=running) and holds the probe.\n'
                    + 'Call stop_debugging first.');
                assert.deepStrictEqual(w.issued, []);
            });

            test('stop_run waits until the CMSIS tasks ended, terminates leftovers itself, and says when one survives', async () => {
                const stopper = (tasks: FakeTasks) => () => {
                    for (const execution of tasks.taskExecutions()) {
                        if (execution.task.name.startsWith('CMSIS')) {
                            execution.terminate();
                        }
                    }
                };
                const w = guarded((tasks) => {
                    tasks.start(tasks.execution(shellTask('CMSIS Load+Run')), false);
                    tasks.start(tasks.execution(shellTask('CMSIS Run')));
                });
                again();
                solutionOn('HE', { 'cmsis-csolution.cmsisStopRun': stopper(w.tasks) });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'stop_run' })),
                    /^CMSIS 'stop_run' on HE: stopped 'CMSIS Load\+Run' and 'CMSIS Run' \(ended [\d.]+ s after the stop request\); the probe is free\.$/);
                assert.deepStrictEqual(w.tracker.probeOwners(), []);

                assert.strictEqual(await textAnswer(w.handler.handleCmsisCommand({ action: 'stop_run' })),
                    'CMSIS \'stop_run\' on HE: no CMSIS task of a run was running in this window. '
                    + '\'cmsis-csolution.cmsisStopRun\' was issued anyway; it also ends a debug session the CMSIS panel started.');

                // A build is stop_build's: stop_run names one it ended, and one that runs on.
                again();
                const b = guarded((tasks) => {
                    tasks.start(tasks.execution({ name: 'cbuild demo.csolution.yml --active HE', source: 'CMSIS Solution', definition: { type: 'cmsis-csolution.build' } }));
                });
                again();
                solutionOn('HE', { 'cmsis-csolution.cmsisStopRun': () => undefined });
                assert.strictEqual(await textAnswer(b.handler.handleCmsisCommand({ action: 'stop_run' })),
                    'CMSIS \'stop_run\' on HE: no CMSIS task of a run was running in this window. '
                    + '\'cmsis-csolution.cmsisStopRun\' was issued anyway; it also ends a debug session the CMSIS panel started. '
                    + '\'cbuild demo.csolution.yml --active HE\' still runs: stop_run leaves builds alone — cmsis_action stop_build ends them.');
                again();
                solutionOn('HE', {
                    'cmsis-csolution.cmsisStopRun': () => {
                        for (const execution of b.tasks.taskExecutions()) {
                            execution.terminate();
                        }
                    },
                });
                assert.strictEqual(await textAnswer(b.handler.handleCmsisCommand({ action: 'stop_run' })),
                    'CMSIS \'stop_run\' on HE: no CMSIS task of a run was running in this window. '
                    + '\'cmsis-csolution.cmsisStopRun\' was issued anyway; it also ends a debug session the CMSIS panel started. '
                    + '\'cbuild demo.csolution.yml --active HE\', a build, ended meanwhile: build again before load.');

                let stubborn: FakeExecution | undefined;
                again();
                const s = guarded((tasks) => {
                    stubborn = tasks.start(tasks.execution(shellTask('CMSIS Run'), true));
                });
                again();
                solutionOn('HE', { 'cmsis-csolution.cmsisStopRun': stopper(s.tasks) });
                const refused = await refusalOf(s.handler.handleCmsisCommand({ action: 'stop_run' }), 'PROBE_BUSY');
                assert.match(errorDetail(refused), /^CMSIS 'stop_run' on HE: 'CMSIS Run' is still running 1\d s after the stop request, although terminated twice\.\n/);
                assert.ok(refused.hint?.startsWith('Stop it with the trash icon in the Terminal panel'), refused.hint);
                assert.strictEqual(stubborn?.terminateCalls, 2);
            });

            test('get_session_status adds one line on the CMSIS tasks, before the hint', async () => {
                const w = guarded((tasks) => {
                    tasks.start(tasks.execution(shellTask('CMSIS Run')));
                });
                const text = await textAnswer(w.handler.handleGetSessionStatus());
                assert.match(text, /\nCMSIS tasks: 'CMSIS Run' alive [\d.]+ s \(holds the probe\)\nHint: /);
            });
        });

        test('attach waits for the session and probes it twice; no threads yet is not a failure, a vanished session is', async () => {
            const attach = async (threadCounts: Array<number | 'gone'> | undefined, fvp = false, focus: StartFocus = 'selected'): Promise<ToolText> => {
                const x = new ScriptedExecutor();
                x.startFocus = () => focus;
                if (fvp) {
                    x.activeSession = { configuration: { type: 'gdbtarget', name: 'Arm-FVP@GDB (attach)', request: 'attach' } } as unknown as ScriptedExecutor['activeSession'];
                }
                x.session = false;
                x.sessionStatus = status(threadCounts ? 'running' : 'initializing');
                x.getThreads = async () => {
                    const next = threadCounts?.shift() ?? 0;
                    if (next === 'gone') {
                        x.session = false;
                        throw new Error('session ended');
                    }
                    return Array.from({ length: next }, (_, i) => ({ id: i + 1, name: 't' }));
                };
                solutionOn('HE', {
                    'cmsis-csolution.cmsisAttachDebugger': () => {
                        x.session = true;
                    },
                });
                try {
                    const clock = fastClock(50);
                    const tracker = cmsisTasksTracker(clock);
                    return await handlerFor(x, { ...clock, cmsisJobs: () => tracker }).handleCmsisCommand({ action: 'attach' });
                } finally {
                    registrations?.dispose();
                    registrations = undefined;
                }
            };
            const survived = await textAnswer(attach([1, 1]));
            assert.ok(survived.startsWith('CMSIS \'attach\' completed on HE — debug session survived the connect '
                + '(t+3s: 1 thread(s), t+6s: 1 thread(s) — target threads present). State: {'), survived);
            assert.ok(!survived.includes('Arm FVP'), survived);
            assert.strictEqual(await textAnswer(attach([1, 1], false, 'none')), 'CMSIS \'attach\' completed on HE — debug session survived the connect '
                + '(t+3s: 1 thread(s), t+6s: 1 thread(s) — target threads present). '
                + 'VS Code has not selected a frame yet, so the state is not shown: get_call_stack shows where.');
            const onFvp = await textAnswer(attach([1, 1], true));
            assert.ok(onFvp.endsWith('\nOn the Arm FVP pause_execution will not stop the running model: set breakpoints '
                + '(for a fault, HardFault_Handler) before continue_execution.'), onFvp);
            assert.strictEqual(await replyAnswer(attach([1, 0]), 'running'),
                'CMSIS \'attach\' on HE: the debug session is up but the target is not reporting threads yet — '
                + 't+3s: 1 thread(s), then t+6s: session object present, 0 threads so far. '
                + 'This is not a failure: poll get_session_status until it reports \'running\' or \'stopped\'.');
            const lost = await refusalOf(attach([1, 'gone']), 'TASK_FAILED');
            assert.strictEqual(lost.message, 'CMSIS \'attach\' on HE started a debug session but it did NOT survive the initial connect — '
                + 't+3s: 1 thread(s), then t+6s: thread probe failed — session ended.');
            assert.ok(lost.hint?.startsWith('For \'attach\' this almost always means no GDB server is listening'), lost.hint);
            assert.ok(lost.hint?.includes('No CMSIS Run task is alive in this window — cmsis_action run starts the GDB server without programming '
                + '(the pyOCD task resets the target first); load_and_run programs first.'), lost.hint);
            const never = await replyAnswer(attach(undefined), 'running');
            assert.ok(never.startsWith('CMSIS \'attach\' on HE issued via \'cmsis-csolution.cmsisAttachDebugger\'. '
                + 'The flash/connect pipeline is running in the CMSIS extension'), never);
        });

        test('attach waits while the adapter takes no requests; a session that ends before it comes up fails the call at once', async () => {
            // The states the session probe reports one after the other, the last one repeated.
            const attach = async (states: Array<StatusShape['state']>): Promise<{ answer: ToolText | ToolError; x: ScriptedExecutor }> => {
                const x = new ScriptedExecutor();
                x.session = false;
                x.getSessionStatus = async () => {
                    x.note('getSessionStatus');
                    const state = states.length > 1 ? states.shift() as StatusShape['state'] : states[0];
                    x.session = state !== 'no-session';
                    return status(state);
                };
                x.getThreads = async () => {
                    x.note('getThreads');
                    return [{ id: 1, name: 't' }];
                };
                solutionOn('HE', {
                    'cmsis-csolution.cmsisAttachDebugger': () => {
                        x.session = true;
                    },
                });
                try {
                    const clock = fastClock(50);
                    const tracker = cmsisTasksTracker(clock);
                    return { answer: await handlerFor(x, { ...clock, cmsisJobs: () => tracker }).handleCmsisCommand({ action: 'attach' }), x };
                } catch (caught) {
                    assert.ok(caught instanceof ToolError, String(caught));
                    return { answer: caught, x };
                } finally {
                    registrations?.dispose();
                    registrations = undefined;
                }
            };

            const late = await attach(['initializing', 'initializing', 'running']);
            assert.ok(typeof late.answer === 'string' && late.answer.startsWith('CMSIS \'attach\' completed on HE — debug session survived the connect '
                + '(t+3s: 1 thread(s), t+6s: 1 thread(s) — target threads present).'), JSON.stringify(late.answer));
            assert.strictEqual(late.x.argsOf('getSessionStatus').length, 3, 'two polls found the adapter taking no requests');

            const lost = await attach(['initializing', 'no-session']);
            assert.ok(lost.answer instanceof ToolError && lost.answer.code === 'TASK_FAILED', JSON.stringify(lost.answer));
            assert.strictEqual(lost.answer.message, 'CMSIS \'attach\' on HE started a debug session but it did NOT survive the initial connect — '
                + 'it ended before it came up.');
            assert.ok(lost.answer.hint?.startsWith('For \'attach\' this almost always means no GDB server is listening'), lost.answer.hint);
            assert.deepStrictEqual(lost.x.argsOf('getThreads'), [], 'a session that is gone is not probed');
            assert.strictEqual(lost.x.argsOf('getSessionStatus').length, 2, 'the wait ends with the session');
        });

        test('attach whose session never showed: an attach the debug adapter refused fails it with the attach hint; a view\'s evaluate, a tool\'s warning, another call\'s error, or a server line while the session still connects do not', async () => {
            /** One attach whose command journals `records`; the session is never seen, or, with `connecting`, stays initializing. */
            const attach = async (records: ProblemInput[], connecting = false): Promise<ToolText> => {
                const x = new ScriptedExecutor();
                x.session = false;
                x.sessionStatus = status(connecting ? 'initializing' : 'no-session');
                solutionOn('HE', {
                    'cmsis-csolution.cmsisAttachDebugger': () => {
                        x.session = connecting;
                        setTimeout(() => records.forEach((record) => problemJournal().append(record)), 5);
                    },
                });
                try {
                    const clock = fastClock(50);
                    const tracker = cmsisTasksTracker(clock);
                    return await journaled('attach01-1', () => handlerFor(x, { ...clock, cmsisJobs: () => tracker }).handleCmsisCommand({ action: 'attach' }));
                } finally {
                    registrations?.dispose();
                    registrations = undefined;
                }
            };
            const origin = 'CMSIS_DAP@pyOCD (attach)';

            // No GDB server listening: GDB's connect timed out and the session ended between two polls.
            const timedOut = 'error response to \'attach\': could not connect: Operation timed out.';
            const refused = await refusalOf(attach([{ source: 'dap', origin, severity: 'error', message: timedOut, debugSessionId: 'a-1' }]), 'TASK_FAILED');
            assert.strictEqual(refused.message, 'CMSIS \'attach\' on HE started no debug session — the debug adapter\'s attach failed.');
            assert.strictEqual(refused.hint, 'For \'attach\' this almost always means no GDB server is listening on the configured port: '
                + 'start the GDB server first, or use \'load_and_debug\' (which launches one). No CMSIS Run task is alive in this window — '
                + 'cmsis_action run starts the GDB server without programming (the pyOCD task resets the target first); load_and_run programs first. '
                + 'Confirm with get_session_status / check_target_connection.');
            assert.match(renderProblemsBlock(refused.data?.problems), /^\nRecent problems:\n  #\d+ error dap error response to 'attach': could not connect: Operation timed out\.$/);

            // A Watch expression VS Code evaluated on its own (info), a tool's own failed request (warning), an error of another call: still running.
            const unrelated = await replyAnswer(attach([
                { source: 'dap', origin, severity: 'info', message: 'error response to \'evaluate\': <no message>' },
                { source: 'dap', origin, severity: 'warning', message: 'error response to \'threads\': Thread is running.' },
                { source: 'dap', origin, severity: 'error', message: timedOut, toolCallId: 'other001-9' },
            ]), 'running');
            assert.ok(unrelated.startsWith('CMSIS \'attach\' on HE issued via \'cmsis-csolution.cmsisAttachDebugger\'. '), unrelated);

            // A session still connecting: a server's error line is no verdict yet; the attach request itself refused is one.
            const serverLine = { source: 'gdb-server', origin, severity: 'error', message: '0000500 E Failed to get unique id for open [dap_access_cmsis_dap]' } as const;
            await replyAnswer(attach([serverLine], true), 'running');
            const refusedWhileThere = await refusalOf(attach([serverLine, { source: 'dap', origin, severity: 'error', message: timedOut }], true), 'TASK_FAILED');
            assert.strictEqual(refusedWhileThere.message, 'CMSIS \'attach\' on HE started no debug session — the debug adapter\'s attach failed.');
            assert.strictEqual(renderProblemsBlock(refusedWhileThere.data?.problems).split('\n').length, 4, 'both records listed');

            // Nothing journaled.
            await replyAnswer(attach([]), 'running');
        });

        test('the fence honours the long cap for cmsis_action and flash only', async () => {
            const timers: number[] = [];
            const x = new ScriptedExecutor();
            const tracker = new CmsisJobTracker(new FakeTasks(), fastClock(1));
            const handler = handlerFor(x, { ...fastClock(1, timers), cmsisJobs: () => tracker });
            await refusalOf(handler.handleFlash({ timeoutMs: 120_000 }), 'PROBE_BUSY');
            assert.strictEqual(timers[0], 120_000, 'flash');
            timers.length = 0;
            await textAnswer(handler.handleCmsisCommand({ action: 'status', timeoutMs: 600_000 }));
            assert.strictEqual(timers[0], 600_000, 'cmsis_action');
            timers.length = 0;
            await textAnswer(handler.handleCmsisCommand({ action: 'status', timeoutMs: 900_000 }));
            assert.strictEqual(timers[0], 600_000, 'cmsis_action beyond the cap');
            timers.length = 0;
            await textAnswer(handler.handleReadMemory({ address: '0x20000000', length: 4, timeoutMs: 120_000 }));
            assert.strictEqual(timers[0], 60_000, 'a read keeps the 60 s cap');
        });

        /**
         * Two windows on one GDB port (live test): an FVP launch in one window while pyOCD's CMSIS Run of
         * another listened on 127.0.0.1:3333 connected GDB to pyOCD and halted that board. A launch, a
         * CMSIS Run and start_debugging now ask who holds their GDB port before anything starts.
         */
        suite('two windows on one GDB port', () => {
            const FVP_LAUNCH = {
                name: 'Arm-FVP@GDB (launch)', type: 'gdbtarget', request: 'launch', cwd: '${workspaceFolder}/',
                target: {
                    server: '${workspaceFolder}/.vscode/fvp.sh',
                    serverParameters: ['-D', '--plugin', '${env:AVH_FVP_PLUGINS}/GDBServer.so', '-C', 'GDBServer.port=3333', '-f', 'fvp_config.txt'],
                    port: '', serverPortRegExp: 'GDBServer: Listening .*port=([0-9]+)',
                },
                cmsis: { cbuildRunFile: '${command:cmsis-csolution.getCbuildRunFile}', updateConfiguration: 'manual' },
            };
            const FVP_ATTACH = { name: 'Arm-FVP@GDB (attach)', type: 'gdbtarget', request: 'attach', target: { port: '3333' }, cmsis: {} };
            const PYOCD_LAUNCH = { name: 'STLink@pyOCD (launch)', type: 'gdbtarget', request: 'launch', target: { server: 'pyocd', port: '3333' }, cmsis: {} };
            const PYOCD_ATTACH = { name: 'STLink@pyOCD (attach)', type: 'gdbtarget', request: 'attach', target: { port: '3333' }, cmsis: {} };
            const PYOCD_RUN_TASK = { label: 'CMSIS Run', type: 'shell', command: 'pyocd',
                args: ['gdbserver', '--probe', 'stlink:', '--persist', '--reset-run', '--cbuild-run', '${command:cmsis-csolution.getCbuildRunFile}', '--quiet'] };
            const FVP_RUN_TASK = { label: 'CMSIS Run', type: 'shell', command: 'FVP_Corstone_SSE-300_Ethos-U55', args: ['-f', 'fvp_config.txt', '-a', 'Blinky.axf'] };
            const ITEM13_RUN: GdbPortHolder = { kind: 'window', pid: 70401, name: 'item13', claim: { port: 3333, source: 'cmsis-run', label: 'CMSIS Run', server: 'pyOCD' } };

            let dir: string;
            const managers: GdbPortReservations[] = [];
            const trackers: CmsisJobTracker[] = [];
            const otherStart = { what: 'launch' as const, subject: 'Other window not started', configuration: 'Other launch' };
            const reservationManager = (): GdbPortReservations => {
                const manager = new GdbPortReservations(path.join(dir, 'reservations'));
                managers.push(manager);
                return manager;
            };
            const assertReserved = (other: GdbPortReservations, port: number): void => {
                assert.throws(() => other.acquire(port, otherStart, 'other window').release(),
                    (caught: unknown) => caught instanceof ToolError && caught.code === 'PROBE_BUSY', `port ${port} must remain reserved`);
            };
            const assertAvailable = (other: GdbPortReservations, port: number): void => {
                other.acquire(port, otherStart, 'other window').release();
            };
            const writeVscode = (file: string, content: unknown): void => {
                fs.writeFileSync(path.join(dir, '.vscode', file), JSON.stringify(content));
            };
            setup(() => {
                dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-gdbport-'));
                fs.mkdirSync(path.join(dir, '.vscode'));
                writeVscode('launch.json', { version: '0.2.0', configurations: [FVP_LAUNCH, FVP_ATTACH] });
                writeVscode('tasks.json', { version: '2.0.0', tasks: [PYOCD_RUN_TASK] });
                // pyOCD's gdbserver --cbuild-run listens where the cbuild-run file says.
                fs.writeFileSync(path.join(dir, 'demo+HE.cbuild-run.yml'), 'cbuild-run:\n  debugger:\n    name: ST-Link@pyOCD\n    gdbserver:\n      - port: 3334\n');
            });
            teardown(() => {
                for (const tracker of trackers.splice(0)) {
                    tracker.dispose();
                }
                for (const manager of managers.splice(0)) {
                    manager.dispose();
                }
                fs.rmSync(dir, { recursive: true, force: true });
            });

            /** A window with that folder open; `holder` answers for each GDB port a call asks about, which `asked` records. */
            const portWorld = (
                holder: (port: number) => GdbPortHolder | undefined | Promise<GdbPortHolder | undefined>,
                reservations?: GdbPortReservations,
                command: (name: string) => unknown = () => undefined,
            ) => {
                const clock = fastClock(20);
                const tasks = new FakeTasks();
                tasks.fetched = workspaceTasks(dir, ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase']);
                const tracker = new CmsisJobTracker(tasks, clock);
                trackers.push(tracker);
                const x = new ScriptedExecutor();
                x.session = false;
                const asked: number[] = [];
                const issued: string[] = [];
                const record = (name: string) => () => {
                    issued.push(name);
                    return command(name);
                };
                registrations?.dispose();
                registrations = standIns({
                    'cmsis-csolution.getSolutionFile': () => path.join(dir, 'demo.csolution.yml'),
                    'cmsis-csolution.getActiveTargetSet': () => 'HE',
                    'cmsis-csolution.cmsisLoadAndDebug': record('load_and_debug'),
                    'cmsis-csolution.cmsisRun': record('run'),
                    'cmsis-csolution.cmsisLoadAndRun': record('load_and_run'),
                });
                const handler = handlerFor(x, {
                    ...clock,
                    cmsisJobs: () => tracker,
                    workspaceFolders: () => [{ uri: vscode.Uri.file(dir), name: 'ws', index: 0 }],
                    activeCbuildRunFile: async () => path.join(dir, 'demo+HE.cbuild-run.yml'),
                    gdbPortHolder: async (port) => {
                        asked.push(port);
                        return holder(port);
                    },
                    ...(reservations ? { reserveGdbPort: (port, start, group) => reservations.acquire(port, start, 'ws', group) } : {}),
                }, 5, {});
                return { handler, asked, issued, x, tasks, tracker };
            };

            test('each CMSIS launch or Run reserves before asynchronous preflight and before issuing its command', async () => {
                for (const action of ['load_and_debug', 'run', 'load_and_run'] as const) {
                    const owner = reservationManager();
                    const other = reservationManager();
                    const port = action === 'load_and_debug' ? 3333 : 3334;
                    const order: string[] = [];
                    const w = portWorld(async (asked) => {
                        assert.strictEqual(asked, port);
                        assertReserved(other, port);
                        order.push('preflight');
                        await Promise.resolve();
                        assertReserved(other, port);
                        return undefined;
                    }, owner, (issued) => {
                        assert.strictEqual(issued, action);
                        assertReserved(other, port);
                        order.push('command');
                        throw new Error('scripted command rejection');
                    });
                    const failed = await refusalOf(w.handler.handleCmsisCommand({ action }), 'TASK_FAILED');
                    assert.match(failed.message, /scripted command rejection/);
                    assert.deepStrictEqual(order, ['preflight', 'command']);
                    assertAvailable(other, port);
                }
            });

            test('start_debugging reserves before asynchronous preflight and rolls back a refused or rejected start', async () => {
                writeVscode('launch.json', { configurations: [PYOCD_LAUNCH] });
                for (const rejection of [false, true]) {
                    const owner = reservationManager();
                    const other = reservationManager();
                    const order: string[] = [];
                    const w = portWorld(async () => {
                        assertReserved(other, 3333);
                        order.push('preflight');
                        await Promise.resolve();
                        assertReserved(other, 3333);
                        return undefined;
                    }, owner);
                    w.x.startDebuggingByName = async () => {
                        assertReserved(other, 3333);
                        order.push('start');
                        if (rejection) {
                            throw new Error('scripted start rejection');
                        }
                        return false;
                    };
                    await refusalOf(w.handler.handleStartDebugging({ workingDirectory: dir, configurationName: PYOCD_LAUNCH.name }));
                    assert.deepStrictEqual(order, ['preflight', 'start']);
                    assertAvailable(other, 3333);
                }
            });

            test('a refused or failed asynchronous preflight releases the named launch reservation without starting it', async () => {
                writeVscode('launch.json', { configurations: [PYOCD_LAUNCH] });
                for (const rejected of [false, true]) {
                    const owner = reservationManager();
                    const other = reservationManager();
                    const w = portWorld(async () => {
                        assertReserved(other, 3333);
                        await Promise.resolve();
                        if (rejected) {
                            throw new Error('scripted preflight failure');
                        }
                        return { kind: 'listener' };
                    }, owner);
                    await refusalOf(w.handler.handleStartDebugging({ workingDirectory: dir, configurationName: PYOCD_LAUNCH.name }),
                        rejected ? undefined : 'PROBE_BUSY');
                    assert.deepStrictEqual(w.x.argsOf('startDebuggingByName'), []);
                    assertAvailable(other, 3333);
                }
            });

            test('load_and_debug rolls back an earlier reservation if a later candidate port is refused', async () => {
                // A multi-core J-Link target: one launch configuration and one GDB server per core.
                fs.writeFileSync(path.join(dir, 'demo+HE.cbuild-run.yml'),
                    'cbuild-run:\n  debugger:\n    name: J-Link Server\n    gdbserver:\n      - port: 3333\n      - port: 3334\n');
                const jlink = (name: string, port: string) => ({ name, type: 'gdbtarget', request: 'launch', target: { server: 'JLinkGDBServerCL', port }, cmsis: {} });
                writeVscode('launch.json', { configurations: [jlink('cm7 JLink (launch)', '3333'), jlink('cm4 JLink (launch)', '3334')] });
                const owner = reservationManager();
                const other = reservationManager();
                const w = portWorld(async (port) => {
                    assertReserved(other, 3333);
                    if (port === 3334) {
                        assertReserved(other, 3334);
                        await Promise.resolve();
                        return { kind: 'listener' };
                    }
                    return undefined;
                }, owner);
                await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_debug' }), 'PROBE_BUSY');
                assert.deepStrictEqual(w.asked, [3333, 3334]);
                assert.deepStrictEqual(w.issued, []);
                assertAvailable(other, 3333);
                assertAvailable(other, 3334);
            });

            /**
             * Tester feedback on preview 4, an STM32H7 with a custom debug setup: Load & Debug also reserved, and asked about, port
             * 3334 of an FVP configuration that launch.json kept beside the board's, and failed with PROBE_BUSY while an
             * FVP used it; CMSIS Solution starts only the board's. The setup's own adapter template runs pyOCD through
             * Python and a wrapper, with its port 45343 in quotes, and its CMSIS Run reads the port from the cbuild-run file.
             */
            suite('an STM32H7 with a custom debug setup beside an FVP configuration', () => {
                const PYTHON = '/usr/local/bin/python3.11';
                const WRAPPER = ['/Users/u/debug-setup/scripts/pyocd_wrapper.py', 'gdbserver', '--probe', 'cmsisdap:',
                    '--cbuild-run', '${command:cmsis-csolution.getCbuildRunFile}', '--quiet'];
                const CUSTOM_LAUNCH = { name: 'Custom@pyOCD (launch)', type: 'gdbtarget', request: 'launch', preLaunchTask: 'CMSIS Load',
                    target: { server: PYTHON, serverParameters: WRAPPER, port: '"45343"' }, cmsis: { updateConfiguration: 'auto' } };
                const FVP_BESIDE = { ...FVP_LAUNCH, target: { ...FVP_LAUNCH.target, serverParameters: ['-D', '--plugin', 'GDBServer.so', '-C', 'GDBServer.port=3334'] } };
                const FVP_WINDOW: GdbPortHolder = { kind: 'window', pid: 70402, name: 'fvp', claim: { port: 3334, source: 'session', label: 'Arm-FVP@GDB (launch)', server: 'Arm FVP' } };
                setup(() => {
                    writeVscode('launch.json', { configurations: [FVP_BESIDE, CUSTOM_LAUNCH] });
                    writeVscode('tasks.json', { version: '2.0.0', tasks: [{ label: 'CMSIS Run', type: 'process', command: PYTHON, args: [...WRAPPER.slice(0, 2), '--persist', ...WRAPPER.slice(2)] }] });
                    fs.writeFileSync(path.join(dir, 'demo+HE.cbuild-run.yml'), 'cbuild-run:\n  debugger:\n    name: Custom@pyOCD\n    gdbserver:\n      - port: 45343\n');
                });

                test('load_and_debug reserves and asks about the board\'s port only, not the FVP configuration\'s', async () => {
                    const owner = reservationManager();
                    const other = reservationManager();
                    const w = portWorld((port) => (port === 3334 ? FVP_WINDOW : undefined), owner);
                    await w.handler.handleCmsisCommand({ action: 'load_and_debug', timeoutMs: 2_000 }).catch(() => undefined);
                    assert.deepStrictEqual(w.asked, [45343]);
                    assert.deepStrictEqual(w.issued, ['load_and_debug']);
                    assertReserved(other, 45343);
                    assertAvailable(other, 3334);
                });

                test('the CMSIS Run behind Python reserves the port of the cbuild-run file, and a holder of it is named', async () => {
                    const owner = reservationManager();
                    const other = reservationManager();
                    const w = portWorld(() => undefined, owner);
                    await w.handler.handleCmsisCommand({ action: 'run', timeoutMs: 2_000 }).catch(() => undefined);
                    assert.deepStrictEqual(w.asked, [45343]);
                    assertReserved(other, 45343);

                    const held = portWorld(() => ({ kind: 'listener' }));
                    const refused = await refusalOf(held.handler.handleCmsisCommand({ action: 'run' }), 'PROBE_BUSY');
                    assert.match(refused.message, /its pyOCD GDB server \(CMSIS Run\) would use port 45343/);
                    assert.deepStrictEqual(held.issued, []);
                });
            });

            test('a pending CMSIS start keeps its reservation after the reply; a late rejection releases it only without a live owner', async () => {
                for (const live of ['none', 'task', 'session'] as const) {
                    const owner = reservationManager();
                    const other = reservationManager();
                    let rejectCommand: (error: Error) => void = () => assert.fail('command was not issued');
                    const command = new Promise<never>((_resolve, reject) => { rejectCommand = reject; });
                    const w = portWorld(() => undefined, owner, () => command);
                    await replyAnswer(w.handler.handleCmsisCommand({ action: 'run', timeoutMs: 4_000 }), 'running');
                    assert.deepStrictEqual(w.issued, ['run']);
                    owner.observe([]);
                    assertReserved(other, 3334);

                    let execution: FakeExecution | undefined;
                    if (live === 'task') {
                        execution = w.tasks.start(w.tasks.execution({ name: 'CMSIS Run', source: 'Workspace', definition: { type: 'shell' } }));
                    } else if (live === 'session') {
                        w.x.session = true;
                    }
                    if (live !== 'none') {
                        // The coordinator publishes and adopts the actual session/task's port.
                        owner.observe([{ port: 3334, source: live === 'task' ? 'cmsis-run' : 'session', label: 'Late startup' }]);
                    }
                    rejectCommand(new Error('late command rejection'));
                    await delay(0);
                    if (live !== 'none') {
                        assertReserved(other, 3334);
                        if (execution) {
                            w.tasks.finish(execution, 1);
                        }
                        w.x.session = false;
                        owner.observe([]);
                    }
                    assertAvailable(other, 3334);
                }
            });

            test('a pre-launch Load that fails after the running reply releases the reservation after its execution is removed', async () => {
                writeVscode('launch.json', { configurations: [{ ...PYOCD_LAUNCH, preLaunchTask: 'CMSIS Load' }] });
                const owner = reservationManager();
                const other = reservationManager();
                let execution: FakeExecution | undefined;
                const w = portWorld(() => undefined, owner, () => {
                    execution = w.tasks.start(w.tasks.execution({ name: 'CMSIS Load', source: 'Workspace', definition: { type: 'shell' } }));
                });
                await replyAnswer(w.handler.handleCmsisCommand({ action: 'load_and_debug', timeoutMs: 4_000 }), 'running');
                assert.ok(execution);
                assertReserved(other, 3333);
                w.tasks.finish(execution, 1);
                assertReserved(other, 3333);
                await delay(0);
                assert.deepStrictEqual(w.tracker.liveExecutions(), []);
                assertAvailable(other, 3333);
            });

            test('a completed single-task Load+Run releases its port, but successful pre-launch Load retains it for the pending session', async () => {
                writeVscode('launch.json', { configurations: [{ ...PYOCD_LAUNCH, preLaunchTask: 'CMSIS Load' }] });
                for (const action of ['load_and_run', 'load_and_debug'] as const) {
                    const owner = reservationManager();
                    const other = reservationManager();
                    const port = action === 'load_and_debug' ? 3333 : 3334;
                    let execution: FakeExecution | undefined;
                    const w = portWorld(() => undefined, owner, () => {
                        execution = w.tasks.start(w.tasks.execution({
                            name: action === 'load_and_debug' ? 'CMSIS Load' : 'CMSIS Load+Run',
                            source: 'Workspace', definition: { type: 'shell' },
                        }));
                    });
                    await replyAnswer(w.handler.handleCmsisCommand({ action, timeoutMs: 4_000 }), 'running');
                    assert.ok(execution);
                    assertReserved(other, port);
                    w.tasks.finish(execution, 0);
                    await delay(0);
                    assert.deepStrictEqual(w.tracker.liveExecutions(), []);
                    if (action === 'load_and_debug') {
                        owner.observe([]);
                        assertReserved(other, port);
                    } else {
                        assertAvailable(other, port);
                    }
                }
            });

            test('a confirmed running Run releases after it ends even when no positive port sample ever adopted it', async () => {
                for (const action of ['run', 'load_and_run'] as const) {
                    const owner = reservationManager();
                    const other = reservationManager();
                    let run: FakeExecution | undefined;
                    let compound: FakeExecution | undefined;
                    const w = portWorld(() => undefined, owner, () => {
                        if (action === 'load_and_run') {
                            compound = w.tasks.start(w.tasks.execution({
                                name: 'CMSIS Load+Run', source: 'Workspace', definition: { type: 'shell' },
                            }), false);
                            const load = w.tasks.start(w.tasks.execution({
                                name: 'CMSIS Load', source: 'Workspace', definition: { type: 'shell' },
                            }));
                            w.tasks.finish(load, 0);
                        }
                        run = w.tasks.start(w.tasks.execution({ name: 'CMSIS Run', source: 'Workspace', definition: { type: 'shell' } }));
                    });
                    const answer = await textAnswer(w.handler.handleCmsisCommand({ action, timeoutMs: 10_000 }));
                    assert.match(answer, /'CMSIS Run' started and stays active/);
                    assert.strictEqual(w.tracker.last(action)?.state, 'running-ok');
                    assert.ok(run);
                    assertReserved(other, 3334);

                    // The whole run can pass between coordinator observations; no positive sample is needed to release it.
                    w.tasks.finish(run, 0);
                    if (compound) {
                        w.tasks.finish(compound, undefined, false);
                    }
                    assert.deepStrictEqual(w.tracker.liveExecutions(), []);
                    assert.strictEqual(w.tracker.last(action)?.state, 'running-ok', 'settled jobs do not emit another completion at task end');
                    owner.observe([]);
                    assertAvailable(other, 3334);
                }
            });

            test('load_and_debug is refused before its command while another window\'s CMSIS Run uses the FVP\'s GDB port', async () => {
                const w = portWorld((port) => (port === 3333 ? ITEM13_RUN : undefined));
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_debug' }), 'PROBE_BUSY');
                assert.strictEqual(refused.message, 'CMSIS \'load_and_debug\' on HE not started: the Arm FVP GDB server of \'Arm-FVP@GDB (launch)\' would use '
                    + 'port 3333, which window \'item13\' (pid 70401) uses for its CMSIS Run task (pyOCD GDB server). GDB would connect to that server '
                    + 'instead of the new one, and debug — and halt — that target.');
                assert.strictEqual(refused.hint, 'Stop that task there once the user agrees (cmsis_action stop_run with window: \'70401\'), or give this project another port: '
                    + 'GDBServer.port in .vscode/launch.json.');
                assert.deepStrictEqual(w.asked, [3333], 'the launch configuration is asked about, the attach configuration is not');
                assert.deepStrictEqual(w.issued, []);
            });

            test('run and load_and_run are refused while another program listens where pyOCD\'s CMSIS Run would; its port comes from the cbuild-run file', async () => {
                const w = portWorld(() => ({ kind: 'listener' }));
                for (const action of ['run', 'load_and_run'] as const) {
                    const refused = await refusalOf(w.handler.handleCmsisCommand({ action }), 'PROBE_BUSY');
                    assert.strictEqual(refused.message, `CMSIS '${action}' on HE not started: its pyOCD GDB server (CMSIS Run) would use port 3334, and another `
                        + 'program already listens on that port of this computer — no window of the CMSIS Developer Assistant claims it: a GDB server started '
                        + 'elsewhere, or one an earlier session left running. Two GDB servers on one port: the new one fails to start, or a GDB meant for one '
                        + 'of them reaches the other.');
                    assert.strictEqual(refused.hint, 'Free the port (the user can end that program), or give this project\'s GDB server another port.');
                }
                assert.deepStrictEqual(w.asked, [3334, 3334]);
                assert.deepStrictEqual(w.issued, []);
            });

            test('a free port lets the launch and the CMSIS Run through; the FVP adapter\'s Run hosts no GDB server and asks nothing', async () => {
                const w = portWorld(() => undefined);
                await w.handler.handleCmsisCommand({ action: 'load_and_debug', timeoutMs: 2_000 }).catch(() => undefined);
                await w.handler.handleCmsisCommand({ action: 'run', timeoutMs: 2_000 }).catch(() => undefined);
                assert.deepStrictEqual(w.asked, [3333, 3334]);
                assert.deepStrictEqual(w.issued, ['load_and_debug', 'run']);

                writeVscode('tasks.json', { version: '2.0.0', tasks: [FVP_RUN_TASK] });
                const bare = portWorld(() => ({ kind: 'listener' }));
                await bare.handler.handleCmsisCommand({ action: 'run', timeoutMs: 2_000 }).catch(() => undefined);
                assert.deepStrictEqual(bare.asked, []);
                assert.deepStrictEqual(bare.issued, ['run']);
            });

            test('start_debugging of a launch configuration with a fixed port asks before the start; an attach configuration does not', async () => {
                writeVscode('launch.json', { version: '0.2.0', configurations: [PYOCD_LAUNCH, PYOCD_ATTACH] });
                const held = portWorld(() => ({ kind: 'listener' }));
                const refused = await refusalOf(held.handler.handleStartDebugging({ workingDirectory: dir, configurationName: 'STLink@pyOCD (launch)' }), 'PROBE_BUSY');
                assert.ok(refused.message.startsWith('Debug session not started: the pyOCD GDB server of \'STLink@pyOCD (launch)\' would use port 3333, '
                    + 'and another program already listens'), refused.message);
                assert.strictEqual(refused.hint, 'Free the port (the user can end that program), or give this project another port: '
                    + 'target.port of \'STLink@pyOCD (launch)\' in .vscode/launch.json.');
                assert.deepStrictEqual(held.x.argsOf('startDebuggingByName'), []);

                await held.handler.handleStartDebugging({ workingDirectory: dir, configurationName: 'STLink@pyOCD (attach)', timeoutMs: 1_000 }).catch(() => undefined);
                assert.deepStrictEqual(held.asked, [3333], 'the attach connects to a server that is meant to listen');
                assert.deepStrictEqual(held.x.argsOf('startDebuggingByName'), [[dir, 'STLink@pyOCD (attach)']]);
            });

            test('the window\'s handler reads the other windows\' GDB ports it was given, and names the session that holds one', async () => {
                writeVscode('launch.json', { version: '0.2.0', configurations: [PYOCD_LAUNCH] });
                const x = new ScriptedExecutor();
                x.session = false;
                const windows = [{ pid: 4047, name: 'eval1', claims: [{ port: 3333, source: 'session' as const, label: 'Arm-FVP@GDB (launch)', server: 'Arm FVP' as const }] }];
                // Its own reservations: the shared directory may hold a real window's start on 3333.
                const handler = new DebuggingHandler(x as unknown as IDebuggingExecutor, {} as IDebugConfigurationManager, 5, problemJournal(), () => windows,
                    reservationManager());
                const refused = await refusalOf(handler.handleStartDebugging({ workingDirectory: dir, configurationName: 'STLink@pyOCD (launch)' }), 'PROBE_BUSY');
                assert.strictEqual(refused.message, 'Debug session not started: the pyOCD GDB server of \'STLink@pyOCD (launch)\' would use port 3333, which '
                    + 'window \'eval1\' (pid 4047) uses for its debug session \'Arm-FVP@GDB (launch)\' (Arm FVP GDB server). GDB would connect to that server '
                    + 'instead of the new one, and debug — and halt — that target.');
                assert.strictEqual(refused.hint, 'Stop that session there once the user agrees (select_debug_window {pid: 4047}, then stop_debugging), or give this project another '
                    + 'port: target.port of \'STLink@pyOCD (launch)\' in .vscode/launch.json.');
                assert.deepStrictEqual(x.argsOf('startDebuggingByName'), []);
            });
        });
    });

    suite('flash', () => {
        const folder = (fsPath: string): vscode.WorkspaceFolder => ({ uri: vscode.Uri.file(fsPath), name: 'ws', index: 0 });

        test('refused under a live session', async () => {
            const refused = await refusalOf(handlerFor(new ScriptedExecutor()).handleFlash({}), 'PROBE_BUSY');
            assert.strictEqual(refused.message,
                'Refusing to flash while a debug session is active — programming under a live session wedges most probes.');
            assert.strictEqual(refused.hint, 'Call stop_debugging first, then flash, then cmsis_action attach or load_and_debug.');
        });

        test('the cbuild-run file is resolved or its absence explained', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const workspace = '/nonexistent-cda-ws';
            const withFolder = handlerFor(x, { workspaceFolders: () => [folder(workspace)] });
            const refused = async (pending: Promise<ToolText>): Promise<string> => errorDetail(await refusalOf(pending, 'INVALID_ARGUMENT'));
            assert.strictEqual(await refused(withFolder.handleFlash({ cbuildRunFile: 'out/x.cbuild-run.yml' })),
                `cbuild-run file not found: ${path.join(workspace, 'out/x.cbuild-run.yml')}.\n`
                + 'Pass an existing path, or omit cbuildRunFile to auto-resolve from launch.json / out/.');
            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x, { workspaceFolders: () => [] }).handleFlash({}), 'NO_WORKSPACE')),
                'flash not attempted: no folder is open in this VS Code window, so there is no CMSIS solution to act on.\n'
                + 'Open the project with cmsis_action {action:\'open_solution\', path:\'<folder or *.csolution.yml>\'}. '
                + 'No project yet? get_debug_instructions {topic:\'bootstrap\'} has the steps from an empty window to a debugged board.');

            const found = [vscode.Uri.file('/ws/out/a.cbuild-run.yml'), vscode.Uri.file('/ws/out/b.cbuild-run.yml')];
            const twoMatches = handlerFor(x, { workspaceFolders: () => [folder(workspace)], findFiles: async () => found });
            assert.strictEqual(await refused(twoMatches.handleFlash({})),
                `Found 2 cbuild-run files under out/ — pass cbuildRunFile explicitly:\n  ${found[0].fsPath}\n  ${found[1].fsPath}`);
            const noMatch = handlerFor(x, { workspaceFolders: () => [folder(workspace)], findFiles: async () => [] });
            assert.strictEqual(await refused(noMatch.handleFlash({})),
                'No cbuild-run file found (launch.json has no resolvable cmsis.cbuildRunFile and out/ has none).\n'
                + 'Build first (cmsis_action build), or pass cbuildRunFile explicitly.');
        });

        test('the cbuild-run file of the CMSIS Solution extension\'s active target comes before launch.json and out/', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-flash-active-')));
            try {
                const active = path.join(dir, 'demo+HE.cbuild-run.yml');
                fs.writeFileSync(active, 'cbuild-run:\n  generated-by: csolution\n  target-type: HE\n');
                const found = [vscode.Uri.file('/ws/out/a.cbuild-run.yml'), vscode.Uri.file('/ws/out/b.cbuild-run.yml')];
                const base: Partial<HandlerHost> = {
                    workspaceFolders: () => [folder(dir)],
                    findFiles: async () => found,
                    toolEnvironment: () => ({ extension: () => undefined, pathEnv: '', platform: process.platform }),
                };
                // Chosen without the out/ search: the call goes on to the pyOCD lookup, which finds none here.
                await refusalOf(handlerFor(x, { ...base, activeCbuildRunFile: async () => active }).handleFlash({}), 'TOOL_DISABLED');
                // No answer, or a file that is gone: launch.json and out/ decide, as before.
                for (const answer of [undefined, path.join(dir, 'gone+HE.cbuild-run.yml')]) {
                    const refused = await refusalOf(handlerFor(x, { ...base, activeCbuildRunFile: async () => answer }).handleFlash({}), 'INVALID_ARGUMENT');
                    assert.match(errorDetail(refused), /^Found 2 cbuild-run files under out\//);
                }
                // An explicit cbuildRunFile is never replaced by the answer.
                const named = await refusalOf(handlerFor(x, { ...base, activeCbuildRunFile: async () => active })
                    .handleFlash({ cbuildRunFile: 'missing.cbuild-run.yml' }), 'INVALID_ARGUMENT');
                assert.match(errorDetail(named), /^cbuild-run file not found: /);
            } finally {
                fs.rmSync(dir, { force: true, recursive: true });
            }
        });

        suite('pyOCD: the CMSIS Debugger\'s, never "pip install" (#46, #45)', () => {
            /** The fake pyOCD executables below are shell scripts. */
            const shellScriptsRun = process.platform !== 'win32';
            let dir: string;
            let cbuildRun: string;
            setup(() => {
                dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-flash-')));
                fs.mkdirSync(path.join(dir, 'out'));
                cbuildRun = path.join(dir, 'out', 'demo+HE.cbuild-run.yml');
                fs.writeFileSync(cbuildRun, 'cbuild-run:\n  generated-by: csolution\n  solution: ../demo.csolution.yml\n  target-type: HE\n');
            });
            teardown(() => fs.rmSync(dir, { force: true, recursive: true }));

            const flashHost = (extensionPath: string | undefined, probeId?: string): Partial<HandlerHost> => ({
                workspaceFolders: () => [folder(dir)],
                toolEnvironment: () => ({
                    extension: (id) => (id === 'Arm.vscode-cmsis-debugger' && extensionPath ? { path: extensionPath, version: '1.8.0' } : undefined),
                    pathEnv: '',
                    platform: process.platform,
                }),
                solutionProbeId: () => probeId,
            });

            /** The CMSIS Debugger's pyOCD as a script: `--version` says 0.45.1, `load` writes its arguments to argv.txt and runs `body`. */
            const fakePyocd = (body: string): { extensionPath: string; bin: string; argv: () => string } => {
                const extensionPath = path.join(dir, 'arm.vscode-cmsis-debugger-1.8.0-darwin-arm64');
                const bin = path.join(extensionPath, 'tools', 'pyocd', 'pyocd');
                const argvFile = path.join(dir, 'argv.txt');
                fs.mkdirSync(path.dirname(bin), { recursive: true });
                fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.45.1; exit 0; fi\necho "$*" > "${argvFile}"\n${body}`);
                fs.chmodSync(bin, 0o755);
                return { extensionPath, bin, argv: () => fs.readFileSync(argvFile, 'utf8').trim() };
            };
            /** The cbuild-run file with this `debugger:` node. */
            const withDebugger = (node: string): void => fs.writeFileSync(cbuildRun,
                `cbuild-run:\n  generated-by: csolution\n  solution: ../demo.csolution.yml\n  target-type: HE\n  debugger:\n${node}`);

            test('without any pyOCD the answer is TOOL_DISABLED and names the CMSIS Debugger, with no pip', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const refused = await refusalOf(handlerFor(x, flashHost(undefined)).handleFlash({ cbuildRunFile: cbuildRun }), 'TOOL_DISABLED');
                assert.strictEqual(errorDetail(refused),
                    'pyOCD not found: it ships with the CMSIS Debugger extension (Arm.vscode-cmsis-debugger), and neither the solution\'s '
                    + '.cmsis/tools-environment.yml nor PATH names another one.\n'
                    + 'Install or enable the CMSIS Debugger extension, or use cmsis_action load, which flashes through the CMSIS Solution '
                    + 'extension. Do not install pyOCD yourself.');
                assert.ok(!/pip/i.test(errorDetail(refused)));
            });

            test('the bundled pyOCD programs the target, and the result says which pyOCD it was', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const extensionPath = path.join(dir, 'arm.vscode-cmsis-debugger-1.8.0-darwin-arm64');
                const bin = path.join(extensionPath, 'tools', 'pyocd', 'pyocd');
                fs.mkdirSync(path.dirname(bin), { recursive: true });
                fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.45.1; exit 0; fi\n'
                    + 'echo "Erased 4096 bytes (1 sector), programmed 4096 bytes (16 pages), identical 0 bytes (0 pages) at 52.00 kB/s"\n');
                fs.chmodSync(bin, 0o755);
                const x = new ScriptedExecutor();
                x.session = false;
                assert.strictEqual(await textAnswer(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun })),
                    `✅ Flash succeeded — programmed 4096 bytes at 52 kB/s (pyOCD 0.45.1 from CMSIS Debugger 1.8.0: \`${bin} load --no-wait --cbuild-run ${cbuildRun}\`). `
                    + 'Use cmsis_action attach or load_and_debug to start a debug session.');
            });

            test('no free probe ends the flash at once, and the hint names a held probe, the cable and the driver, not a retry (#81)', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const extensionPath = path.join(dir, 'arm.vscode-cmsis-debugger-1.8.0-darwin-arm64');
                const bin = path.join(extensionPath, 'tools', 'pyocd', 'pyocd');
                fs.mkdirSync(path.dirname(bin), { recursive: true });
                fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.45.1; exit 0; fi\n'
                    + 'echo "No connected debug probes"\necho "0000412 E No target device available [load_cmd]" >&2\nexit 1\n');
                fs.chmodSync(bin, 0o755);
                const x = new ScriptedExecutor();
                x.session = false;
                const refused = await refusalOf(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }), 'TASK_FAILED');
                assert.ok(refused.message.startsWith(`❌ Flash FAILED (exit 1) — \`${bin} load --no-wait --cbuild-run ${cbuildRun}\`\nErrors:\n  No connected debug probes`),
                    refused.message);
                assert.strictEqual(refused.hint, 'pyOCD sees no free debug probe. Another task or session may hold it: cmsis_action {action:\'status\'} lists '
                    + 'this window\'s CMSIS tasks, stop_run or stop_debugging frees it. Otherwise the board is not connected or its probe lacks the USB '
                    + 'driver: ask the user to check the cable and the driver — a serial port in serial_list_ports does not prove that the probe is reachable. '
                    + 'Do not retry until one of these changed.');
            });

            test('a load that exits 0 succeeds although its log names a path with "Error" in it, and lists what pyOCD warned of', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                // pyOCD logs to stderr: each file at INFO (load_cmd.py:169), and session.py:285 warns with "Error".
                const { extensionPath, bin } = fakePyocd('echo "0000123 I Loading /proj/out/ErrorHandling/Debug/app.hex [load_cmd]" >&2\n'
                    + 'echo "0000150 W Error attempting to access config file \'/proj/pyocd.yaml\': [Errno 13] Permission denied [session]" >&2\n'
                    + 'echo "0002345 I Erased 4096 bytes (1 sector), programmed 4096 bytes (16 pages), identical 0 bytes (0 pages) at 52.00 kB/s [loader]" >&2\n');
                const x = new ScriptedExecutor();
                x.session = false;
                assert.strictEqual(await textAnswer(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun })),
                    `✅ Flash succeeded — programmed 4096 bytes at 52 kB/s (pyOCD 0.45.1 from CMSIS Debugger 1.8.0: \`${bin} load --no-wait --cbuild-run ${cbuildRun}\`).\n`
                    + 'pyOCD warned:\n'
                    + '  0000150 W Error attempting to access config file \'/proj/pyocd.yaml\': [Errno 13] Permission denied [session]\n'
                    + 'Use cmsis_action attach or load_and_debug to start a debug session.');
            });

            test('a data chunk pyOCD could not add: still no failure, but ⚠️ with the warning, and the target does not hold the image as built', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                // file_programmer.py:252-257 warns for an ELF segment loader.py:237 refuses, goes on, and load_cmd.py:205 returns 0.
                const { extensionPath, bin } = fakePyocd('echo "0000310 I Loading /w/out/app/Debug/app.elf [load_cmd]" >&2\n'
                    + 'echo "0000420 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]" >&2\n'
                    + 'echo "0002345 I Erased 65536 bytes (2 sectors), programmed 65536 bytes (256 pages), identical 0 bytes (0 pages) at 52.00 kB/s [loader]" >&2\n');
                const x = new ScriptedExecutor();
                x.session = false;
                assert.strictEqual(await textAnswer(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun })),
                    '⚠️ Flash exited 0, but pyOCD could not add a data chunk of the image — programmed 65536 bytes at 52 kB/s '
                    + `(pyOCD 0.45.1 from CMSIS Debugger 1.8.0: \`${bin} load --no-wait --cbuild-run ${cbuildRun}\`).\n`
                    + 'pyOCD warned:\n'
                    + '  0000420 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]\n'
                    + 'So the target does not hold the image as built. Check which sections load at the addresses pyOCD names, for example with '
                    + 'get_section_layout or lookup_symbol {address}, before you debug it. Use cmsis_action attach or load_and_debug to start a debug session.');
                // Two chunks and nothing else to program (loader.py:335-366), and an error pyOCD logged without failing
                // (session.py:228): the success lists the error first.
                const several = fakePyocd('echo "0000200 E Failed to initialize ctrace-run support: cannot access file: No such file or directory [session]" >&2\n'
                    + 'echo "0000301 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]" >&2\n'
                    + 'echo "0000302 W Failed to add data chunk: memory region at address 0x1fff7800 is not writable [file_programmer]" >&2\n'
                    + 'echo "0002345 I Erased 0 bytes (0 sectors), programmed 0 bytes (0 pages), identical 0 bytes (0 pages) at 0.00 kB/s [loader]" >&2\n');
                const text = await textAnswer(handlerFor(x, flashHost(several.extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }));
                assert.ok(text.startsWith('⚠️ Flash exited 0, but pyOCD could not add 2 data chunks of the image — programmed 0 bytes at 0 kB/s (pyOCD 0.45.1'), text);
                assert.ok(text.includes('pyOCD warned:\n'
                    + '  0000200 E Failed to initialize ctrace-run support: cannot access file: No such file or directory [session]\n'
                    + '  0000301 W Failed to add data chunk: no memory region defined for address 0x90000000 [file_programmer]\n'
                    + '  0000302 W Failed to add data chunk: memory region at address 0x1fff7800 is not writable [file_programmer]\n'
                    + 'So the target does not hold the image as built.'), text);
            });

            test('the probe is the one CMSIS Load selects: --probe by the debugger, --uid by the cbuild-run\'s probe-id, else by cmsis-csolution.probe-id', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const { extensionPath, bin, argv } = fakePyocd('echo "programmed 1024 bytes (4 pages) at 10.00 kB/s"\n');
                const x = new ScriptedExecutor();
                x.session = false;
                // ULINKplus@pyOCD has CMSIS-DAP-pyOCD.adapter.json: its CMSIS Load passes --probe cmsisdap: and the setting's probe ID.
                withDebugger('    name: ULINKplus@pyOCD\n    clock: 10000000\n');
                const text = await textAnswer(handlerFor(x, flashHost(extensionPath, 'DAP_T1n4che')).handleFlash({ cbuildRunFile: cbuildRun }));
                assert.ok(text.includes(`(pyOCD 0.45.1 from CMSIS Debugger 1.8.0: \`${bin} load --no-wait --probe cmsisdap: --uid DAP_T1n4che --cbuild-run ${cbuildRun}\`)`), text);
                assert.strictEqual(argv(), `load --no-wait --probe cmsisdap: --uid DAP_T1n4che --cbuild-run ${cbuildRun}`);
                // The cbuild-run file's probe-id comes before the setting, as in CMSIS Solution; ST-Link@pyOCD passes --probe stlink:.
                withDebugger('    name: ST-Link@pyOCD\n    probe-id: 066DFF555654725187084543\n');
                await textAnswer(handlerFor(x, flashHost(extensionPath, 'DAP_T1n4che')).handleFlash({ cbuildRunFile: cbuildRun }));
                assert.strictEqual(argv(), `load --no-wait --probe stlink: --uid 066DFF555654725187084543 --cbuild-run ${cbuildRun}`);
                // An adapter without a probe type and no probe ID: pyOCD looks at every probe, as before.
                withDebugger('    name: Arm-FVP\n');
                await textAnswer(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }));
                assert.strictEqual(argv(), `load --no-wait --cbuild-run ${cbuildRun}`);
            });

            test('several probes and none selected: TASK_FAILED names them and where the user picks one', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const hint = 'Ask the user which of them is connected to the board to program, and to set its unique ID in the setting cmsis-csolution.probe-id; '
                    + 'CMSIS Solution\'s Load, Run and Debug select the probe by it as well. Then call flash again; do not choose a probe yourself.';
                const x = new ScriptedExecutor();
                x.session = false;
                // With --probe cmsisdap: pyOCD lists the CMSIS-DAP probes and chooses none (helpers.py:164-173), then logs (load_cmd.py:107).
                const typed = fakePyocd('echo "More than one debug probe matches unique ID \'cmsisdap:\':"\n'
                    + 'echo "Arm DAPLink CMSIS-DAP | 9904360258994e45002e0012a6e1000038a1000097969900"\n'
                    + 'echo "NXP Semiconductors LPC-LINK2 CMSIS-DAP V5.460 | jsaqcqiq"\n'
                    + 'echo "0000412 E No target device available [load_cmd]" >&2\nexit 1\n');
                withDebugger('    name: CMSIS-DAP@pyOCD\n');
                const refused = await refusalOf(handlerFor(x, flashHost(typed.extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }), 'TASK_FAILED');
                assert.strictEqual(refused.message, `❌ Flash FAILED (exit 1) — \`${typed.bin} load --no-wait --probe cmsisdap: --cbuild-run ${cbuildRun}\`\n`
                    + 'pyOCD found 2 debug probes of the type cmsisdap and chose none:\n'
                    + '  9904360258994e45002e0012a6e1000038a1000097969900 (Arm DAPLink CMSIS-DAP)\n'
                    + '  jsaqcqiq (NXP Semiconductors LPC-LINK2 CMSIS-DAP V5.460)');
                assert.strictEqual(refused.hint, hint);
                // No probe type: pyOCD prints its table and asks (helpers.py:188-195); the closed stdin ends that (__main__.py:174-176).
                const untyped = fakePyocd('echo "  #   Probe/Board                               Unique ID                                          Target"\n'
                    + 'echo "---------------------------------------------------------------------------------------------------------------"\n'
                    + 'echo "  0   Arm DAPLink CMSIS-DAP                     9904360258994e45002e0012a6e1000038a1000097969900   n/a"\n'
                    + 'echo "  1   Segger J-Link OB-SAM3U128-V2-NordicSemi   000683000000                                       n/a"\n'
                    + 'printf "\\nEnter the number of the debug probe or \'q\' to quit> "\n'
                    + 'echo "0000921 C Error: EOF when reading a line [__main__]" >&2\nexit 1\n');
                fs.writeFileSync(cbuildRun, 'cbuild-run:\n  generated-by: csolution\n  solution: ../demo.csolution.yml\n  target-type: HE\n');
                const asked = await refusalOf(handlerFor(x, flashHost(untyped.extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }), 'TASK_FAILED');
                assert.strictEqual(asked.message, `❌ Flash FAILED (exit 1) — \`${untyped.bin} load --no-wait --cbuild-run ${cbuildRun}\`\n`
                    + 'pyOCD found 2 debug probes and chose none:\n'
                    + '  9904360258994e45002e0012a6e1000038a1000097969900 (Arm DAPLink CMSIS-DAP)\n'
                    + '  000683000000 (Segger J-Link OB-SAM3U128-V2-NordicSemi)');
                assert.strictEqual(asked.hint, hint);
            });

            test('a probe ID that no free probe matches: the hint names the ID and where it is set', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const { extensionPath, bin } = fakePyocd('echo "No connected debug probe matches unique ID \'DAP_T1n4che\'"\n'
                    + 'echo "0000412 E No target device available [load_cmd]" >&2\nexit 1\n');
                const x = new ScriptedExecutor();
                x.session = false;
                withDebugger('    name: CMSIS-DAP@pyOCD\n');
                const refused = await refusalOf(handlerFor(x, flashHost(extensionPath, 'DAP_T1n4che')).handleFlash({ cbuildRunFile: cbuildRun }), 'TASK_FAILED');
                assert.ok(refused.message.startsWith(`❌ Flash FAILED (exit 1) — \`${bin} load --no-wait --probe cmsisdap: --uid DAP_T1n4che --cbuild-run ${cbuildRun}\`\n`
                    + 'Errors:\n  No connected debug probe matches unique ID \'DAP_T1n4che\'\n  0000412 E No target device available [load_cmd]\n'), refused.message);
                assert.strictEqual(refused.hint, 'pyOCD sees no free debug probe whose unique ID contains \'DAP_T1n4che\' (the setting cmsis-csolution.probe-id). '
                    + 'Another task or session may hold it: cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks, stop_run or stop_debugging frees it. '
                    + 'Otherwise that probe is not connected or lacks its USB driver, or the ID names another one: ask the user to check the cable, the driver and '
                    + 'the setting cmsis-csolution.probe-id — a serial port in serial_list_ports does not prove that the probe is reachable. '
                    + 'Do not retry until one of these changed.');
            });

            test('flash notes a serial port the window holds, and one that went away while it programmed (#49)', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const extensionPath = path.join(dir, 'arm.vscode-cmsis-debugger-1.8.0-darwin-arm64');
                const bin = path.join(extensionPath, 'tools', 'pyocd', 'pyocd');
                fs.mkdirSync(path.dirname(bin), { recursive: true });
                fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.45.1; exit 0; fi\n'
                    + 'sleep 0.3\necho "programmed 4096 bytes (16 pages) at 52.00 kB/s"\n');
                fs.chmodSync(bin, 0o755);
                SerialPortMock.binding.reset();
                SerialPortMock.binding.createPort('COM7');
                const serial = mockSerial();
                const x = new ScriptedExecutor();
                x.session = false;
                const handler = handlerFor(x, { ...flashHost(extensionPath), ownedSerial: () => serial.controller });

                assert.ok(!(await textAnswer(handler.handleFlash({ cbuildRunFile: cbuildRun }))).includes('COM7'), 'no port, no note');
                await serial.controller.open({ path: 'COM7' }, { owner: 'aaaaaaaa-1111', rule: 'idle', idleSeconds: 300 });
                const held = await textAnswer(handler.handleFlash({ cbuildRunFile: cbuildRun }));
                assert.ok(held.endsWith('\nCOM7 is open in this window; if the probe\'s VCP re-enumerates during programming, reopen it.'), held);
                const programming = handler.handleFlash({ cbuildRunFile: cbuildRun });
                await delay(100);
                serial.controller.releaseForUser();
                const gone = await textAnswer(programming);
                assert.ok(gone.endsWith('\nCOM7 released at 10:42:07 by the user in VS Code, during programming. '
                    + 'Ask the user before you reopen it with serial_open.'), gone);
                SerialPortMock.binding.reset();
            });

            test('a bundled pyOCD that does not run is reported, and tools-environment.yml is the next place looked', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const extensionPath = path.join(dir, 'ext');
                const broken = path.join(extensionPath, 'tools', 'pyocd', 'pyocd');
                fs.mkdirSync(path.dirname(broken), { recursive: true });
                fs.writeFileSync(broken, 'not a program');
                fs.chmodSync(broken, 0o644);
                const x = new ScriptedExecutor();
                x.session = false;
                const refused = await refusalOf(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }), 'TOOL_DISABLED');
                assert.ok(refused.message.endsWith(`(found, but it did not run: ${broken}).`), refused.message);

                const listed = path.join(dir, 'listed');
                fs.mkdirSync(listed);
                fs.writeFileSync(path.join(listed, 'pyocd'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.44.0; exit 0; fi\n'
                    + 'echo "programmed 1024 bytes (4 pages) at 10.00 kB/s"\n');
                fs.chmodSync(path.join(listed, 'pyocd'), 0o755);
                fs.mkdirSync(path.join(dir, '.cmsis'));
                fs.writeFileSync(path.join(dir, '.cmsis', 'tools-environment.yml'),
                    `cmsis-tools-environment:\n  tools:\n    - name: pyOCD\n      version: 0.44.0\n      directory: ${listed}\n`);
                const text = await textAnswer(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }));
                assert.ok(text.includes('(pyOCD 0.44.0 from .cmsis/tools-environment.yml: '), text);
            });
        });
    });
});
