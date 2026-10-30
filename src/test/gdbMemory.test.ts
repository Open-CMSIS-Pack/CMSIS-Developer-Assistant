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

import type * as vscode from 'vscode';
import * as assert from 'assert';
import { systemControlSpaceWords } from '../core/memoryMap';
import {
    ageText, attemptsText, CAUSE_MAX_CHARS, classifyReadFailure, coreVerdict, DebugPortProbe, DHCSR_ADDRESS, dhcsrSummary, isLockedUp, LOCKUP_NOTE,
    silentCoreText, wedgeHint,
} from '../core/probeWedge';
import { ToolError } from '../core/toolResult';
import { DebuggingExecutor } from '../debuggingExecutor';
import type { SessionStatus } from '../executor/contract';
import { explainReadFailure, MemoryReadFailure, probeDebugPort, readWordThroughGdb, withEarlierAttempts } from '../executor/gdbMemory';
import { connectionReport } from '../executor/sessionReports';
import { coreSilentSince, createSessionTracker } from '../utils/sessionStateTracker';
import { HardwareTimeoutError } from '../utils/timeout';

/**
 * The read ladder and the DHCSR read of #3 over scripted sessions: each
 * strategy's cause is kept, and a failure becomes PROBE_WEDGED when the
 * debug port does not answer either, INVALID_ARGUMENT when it does.
 */

type Answer = (command: string, args: Record<string, unknown>) => unknown;

interface Recorded {
    session: vscode.DebugSession;
    requests: Array<{ command: string; args: Record<string, unknown> }>;
}

/** A session whose adapter answers through `answer`: a value, a promise, or a throw. */
function scripted(answer: Answer, type = 'gdbtarget', request = 'launch'): Recorded {
    const requests: Recorded['requests'] = [];
    const session = {
        type, name: 'S', configuration: { type, name: 'S', request },
        customRequest: (command: string, args: Record<string, unknown>) => {
            requests.push({ command, args });
            try {
                return Promise.resolve(answer(command, args));
            } catch (caught) {
                return Promise.reject(caught);
            }
        },
    };
    return { session: session as unknown as vscode.DebugSession, requests };
}

const never = (): Promise<never> => new Promise<never>(() => undefined);
const bytes = (word: number): { data: string } => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(word >>> 0, 0);
    return { data: buffer.toString('base64') };
};

const BROKEN = 'Remote communication error.  Target disconnected.: Broken pipe.';

/** The ladder of 0xE000ED28 failing as a wedged probe fails it, with DAP readMemory's cause in front. */
async function wedgedRead(recorded: Recorded): Promise<unknown> {
    try {
        await readWordThroughGdb(recorded.session, '0xE000ED28', {}, 1_000);
    } catch (caught) {
        return withEarlierAttempts(caught, [{ strategy: 'DAP readMemory', cause: BROKEN }]);
    }
    assert.fail('the ladder should have failed');
}

async function explained(recorded: Recorded, caught: unknown, budgetMs = 1_000): Promise<unknown> {
    return explainReadFailure(recorded.session, '0xE000ED28', caught, budgetMs);
}

suite('memory reads and a wedged probe (#3)', () => {

    test('the ladder keeps why each strategy gave no value', async () => {
        const recorded = scripted((command, args) => {
            if (String(args.expression).startsWith('>')) {
                throw new Error('Unable to read memory.');
            }
            return { result: '' };
        });
        const failure = await wedgedRead(recorded);
        assert.ok(failure instanceof MemoryReadFailure);
        assert.deepStrictEqual(failure.attempts, [
            { strategy: 'DAP readMemory', cause: BROKEN },
            { strategy: 'watch expression', cause: 'empty result' },
            { strategy: 'MI read', cause: 'Unable to read memory.' },
        ]);
        assert.strictEqual(failure.message, `Failed to read memory at 0xE000ED28: DAP readMemory: ${BROKEN.replace(/\s+/g, ' ')}; `
            + 'watch expression: empty result; MI read: Unable to read memory.');
    });

    test('everything fails and DHCSR does not answer: PROBE_WEDGED with every cause, each at most 200 characters', async () => {
        const long = `GDB says: ${'x'.repeat(400)}`;
        const recorded = scripted((command) => {
            if (command === 'readMemory') {
                throw new Error(BROKEN);
            }
            throw new Error(long);
        });
        const error = await explained(recorded, await wedgedRead(recorded));
        assert.ok(error instanceof ToolError);
        assert.strictEqual(error.code, 'PROBE_WEDGED');
        assert.ok(error.message.startsWith(`Memory reads fail and the debug port does not answer (DHCSR at ${DHCSR_ADDRESS} unreadable: `
            + 'Remote communication error. Target disconnected.: Broken pipe.). Reading 0xE000ED28 — DAP readMemory: '), error.message);
        assert.ok(error.message.includes('watch expression: GDB says: x'), error.message);
        const clipped = /watch expression: (GDB says: x+…)/.exec(error.message)?.[1] ?? '';
        assert.strictEqual(clipped.length, CAUSE_MAX_CHARS);
        assert.strictEqual(error.hint, wedgeHint('launch'));
        const dhcsr = recorded.requests.filter((request) => request.args.memoryReference === DHCSR_ADDRESS);
        assert.deepStrictEqual(dhcsr.map((request) => [request.command, request.args.count]), [['readMemory', 4]], 'DHCSR is read once, 4 bytes');
    });

    test('DHCSR answers: the address is not readable in this state, INVALID_ARGUMENT naming it', async () => {
        const recorded = scripted((command, args) => {
            if (command === 'readMemory') {
                if (args.memoryReference === DHCSR_ADDRESS) {
                    return bytes(0x00030003);
                }
                throw new Error('Unable to read memory. (@ 0x60000000)');
            }
            return { result: 'Error: could not evaluate expression' };
        });
        const failure = new MemoryReadFailure('0x60000000', [{ strategy: 'DAP readMemory', cause: 'Unable to read memory. (@ 0x60000000)' }]);
        const error = await explainReadFailure(recorded.session, '0x60000000', failure, 1_000);
        assert.ok(error instanceof ToolError);
        assert.strictEqual(error.code, 'INVALID_ARGUMENT');
        assert.strictEqual(error.message, 'Cannot read 0x60000000 — the debug port answers, the address is not readable in this state: '
            + 'DAP readMemory: Unable to read memory. (@ 0x60000000)');
        assert.match(error.hint ?? '', /lookup_peripheral \{ address \}/);
    });

    test('a timeout, and DHCSR times out too: PROBE_WEDGED; a timeout on a port that answers stays the timeout', async () => {
        const hung = scripted(() => never());
        const timeout = new HardwareTimeoutError('DAP readMemory', 10_000);
        const wedged = await explained(hung, timeout, 50);
        assert.ok(wedged instanceof ToolError);
        assert.strictEqual(wedged.code, 'PROBE_WEDGED');
        assert.strictEqual(wedged.message, `Memory reads time out and the debug port does not answer (DHCSR at ${DHCSR_ADDRESS} timed out). `
            + 'Reading 0xE000ED28 — DAP readMemory: timed out after 10000 ms');

        const slow = scripted(() => bytes(0));
        assert.strictEqual(await explained(slow, timeout), timeout, 'the port answers: only the read was slow');
    });

    test('DHCSR is read within at most 1 s, whatever the budget', async () => {
        const hung = scripted(() => never());
        const began = Date.now();
        const probe = await probeDebugPort(hung.session, 60_000);
        const took = Date.now() - began;
        assert.deepStrictEqual(probe.readable ? undefined : [probe.timedOut], [true]);
        assert.ok(took >= 900 && took < 3_000, `${took} ms`);
    });

    test('S_LOCKUP in DHCSR is a core in lockup', async () => {
        const locked = await probeDebugPort(scripted(() => bytes(0x000b0003)).session, 1_000);
        assert.ok(locked.readable && isLockedUp(locked.dhcsr));
        const running = await probeDebugPort(scripted(() => bytes(0x01030003)).session, 1_000);
        assert.ok(running.readable && !isLockedUp(running.dhcsr));
        assert.match(LOCKUP_NOTE, /^The core is in lockup \(DHCSR\.S_LOCKUP=1\)/);
        const short = await probeDebugPort(scripted(() => ({ data: Buffer.from([1, 2]).toString('base64') })).session, 1_000);
        assert.deepStrictEqual(short, { readable: false, timedOut: false, cause: 'short reply (2 of 4 bytes)' });
    });

    test('other adapters read no DHCSR, and their failure keeps its causes', async () => {
        const recorded = scripted(() => {
            throw new Error('nope');
        }, 'cppdbg');
        const failure = await wedgedRead(recorded);
        assert.strictEqual(await explained(recorded, failure), failure);
        assert.ok(!recorded.requests.some((request) => request.args.memoryReference === DHCSR_ADDRESS));
        assert.ok(failure instanceof MemoryReadFailure);
        assert.deepStrictEqual(failure.attempts.map((attempt) => attempt.strategy), ['DAP readMemory', 'watch expression', 'x/1xw', 'print/x']);
    });

    test('a DHCSR read the adapter cannot do tells nothing; a running target is not a wedge; other errors pass', async () => {
        const failure = new MemoryReadFailure('0x20000000', [{ strategy: 'DAP readMemory', cause: 'unrecognized request' }]);
        const unsupported = scripted(() => {
            throw new Error('unrecognized request');
        });
        assert.strictEqual(await explained(unsupported, failure), failure);

        const running = scripted(() => {
            throw new Error('Cannot execute this command while the target is running.');
        });
        const refused = await explained(running, failure);
        assert.ok(refused instanceof ToolError);
        assert.strictEqual(refused.code, 'TARGET_RUNNING');

        const other = new SyntaxError('Cannot convert 0xZZ to a BigInt');
        assert.strictEqual(await explained(scripted(() => bytes(0)), other), other);
    });

    test('the way out depends on who owns the GDB server; the agent is never told to start one', () => {
        const attach = wedgeHint('attach');
        assert.strictEqual(attach, 'This session is attached to a GDB server that lives as long as its CMSIS Run task: cmsis_action detach, '
            + 'then cmsis_action attach reconnects without a reset (pyOCD lets the target run while detached and halts it on attach); '
            + 'then get_fault_info. If attach then fails with "could not connect", the server ended with its task (window closed or reloaded, '
            + 'stop_run): cmsis_action run in the window that owns the board starts it again, with a reset.');
        assert.ok(!/cmsis_action (load_and_debug|load_and_run)/.test(attach), 'an attach session is never told to re-flash');
        const launch = wedgeHint('launch');
        assert.ok(launch.startsWith('This session launched its own GDB server: detaching or stopping the session stops that server'), launch);
        assert.ok(launch.includes('ask the user to restart the GDB server without a reset (J-Link -nohalt -noreset, pyOCD -O connect_mode=attach)'));
        assert.ok(launch.includes('do not start one yourself'));
        assert.ok(launch.endsWith('If the fault state does not matter: cmsis_action load_and_debug.'));
        assert.strictEqual(wedgeHint(undefined), launch);
        const wedged = classifyReadFailure({
            address: '0x0', attempts: [], timedOut: false, probe: { readable: false, timedOut: true, cause: 'x' }, request: 'attach',
        });
        assert.strictEqual(wedged?.hint, attach);
    });

    test('repeated causes are named once', () => {
        assert.strictEqual(attemptsText([
            { strategy: 'MI read', cause: 'Unable to read memory.' },
            { strategy: 'MI read', cause: 'Unable to read memory.' },
            { strategy: 'block read', cause: 'boom\n  second line' },
        ]), 'MI read: Unable to read memory.; block read: boom second line');
    });
});

/**
 * Whether the core answers, beyond the adapter's `threads` reply (#3, tester
 * feedback on an XMC4700 with J-Link): `check_target_connection` reads DHCSR
 * on a stopped CMSIS Debugger session, and `get_session_status` reports the
 * last read that got no answer without reading.
 */
suite('the core\'s debug status in check_target_connection and get_session_status (#3)', () => {
    const UNREADABLE = 'Unable to read memory. (@ 0xe000edf0)';
    const unreadable: DebugPortProbe = { readable: false, timedOut: false, cause: UNREADABLE };
    const timedOut: DebugPortProbe = { readable: false, timedOut: true, cause: 'DAP readMemory timed out after 1000 ms' };
    const unsupported: DebugPortProbe = { readable: false, timedOut: false, cause: 'unrecognized request' };
    const refusedRunning: DebugPortProbe = { readable: false, timedOut: false, cause: 'Cannot execute this command while the target is running.' };
    const stopped: SessionStatus = {
        state: 'stopped', sessionName: 'S', sessionType: 'gdbtarget', configurationName: 'C', dapResponsive: true, dapProbeMs: 4,
    };
    const HEAD = 'Session: S (type=gdbtarget)\nConfiguration: C\nDAP probe: OK (4ms)\n';

    test('the verdict: DHCSR read answers, unreadable or timed out is silent, an adapter without readMemory or a running target tells nothing', () => {
        assert.strictEqual(coreVerdict({ readable: true, dhcsr: 0 }), 'answers');
        assert.strictEqual(coreVerdict(unreadable), 'silent');
        assert.strictEqual(coreVerdict(timedOut), 'silent');
        assert.strictEqual(coreVerdict({ readable: false, timedOut: false, cause: 'no data in the reply' }), 'silent');
        assert.strictEqual(coreVerdict(unsupported), 'unknown');
        assert.strictEqual(coreVerdict(refusedRunning), 'unknown');
        assert.strictEqual(coreVerdict({ readable: false, timedOut: true, cause: 'not supported' }), 'silent', 'a timeout is never "unsupported"');
    });

    test('a DHCSR value says halted or not, sleeping, and lockup with the tool that reads the fault', () => {
        assert.strictEqual(dhcsrSummary(0x00030003), 'DHCSR=0x00030003 (halted)');
        assert.strictEqual(dhcsrSummary(0x000b0003), 'DHCSR=0x000b0003 (halted, in lockup — get_fault_info)');
        assert.strictEqual(dhcsrSummary(0x01040001), 'DHCSR=0x01040001 (not halted, sleeping)');
        assert.strictEqual(dhcsrSummary(0xffffffff | 0), 'DHCSR=0xffffffff (halted, sleeping, in lockup — get_fault_info)');
        assert.strictEqual(ageText(12_400), '12 s');
        assert.strictEqual(ageText(119_000), '119 s');
        assert.strictEqual(ageText(2_400_000), '40 min');
        assert.strictEqual(ageText(-5), '0 s');
    });

    test('readable DHCSR: the report says the debug port answers, with the value, instead of "full inspection"', () => {
        assert.strictEqual(connectionReport(stopped, { readable: true, dhcsr: 0x00030003 }, 'launch'),
            `${HEAD}Target state: stopped — the debug port answers: DHCSR=0x00030003 (halted).`);
        assert.strictEqual(connectionReport(stopped, { readable: true, dhcsr: 0x000b0003 }, 'launch'),
            `${HEAD}Target state: stopped — the debug port answers: DHCSR=0x000b0003 (halted, in lockup — get_fault_info).`);
    });

    test('unreadable or timed-out DHCSR: the core does not answer, reads will fail with PROBE_WEDGED, and the way to reconnect', () => {
        assert.strictEqual(connectionReport(stopped, unreadable, 'launch'), `${HEAD}Target state: stopped, but the core does not answer `
            + `(DHCSR at 0xE000EDF0 unreadable: ${UNREADABLE}): memory and register reads will fail with PROBE_WEDGED.\n${wedgeHint('launch')}`);
        assert.strictEqual(connectionReport(stopped, timedOut, 'attach'), `${HEAD}Target state: stopped, but the core does not answer `
            + `(DHCSR at 0xE000EDF0 timed out): memory and register reads will fail with PROBE_WEDGED.\n${wedgeHint('attach')}`);
        const long = silentCoreText({ readable: false, timedOut: false, cause: 'x'.repeat(500) });
        assert.ok(long.includes(`unreadable: ${'x'.repeat(CAUSE_MAX_CHARS - 1)}…)`), 'the cause is clipped');
    });

    test('an adapter that cannot read memory, a refusal because the target runs, and no read keep today\'s line', () => {
        const today = `${HEAD}Target state: stopped — full inspection is available.`;
        assert.strictEqual(connectionReport(stopped, unsupported, 'launch'), today);
        assert.strictEqual(connectionReport(stopped, refusedRunning, 'launch'), today);
        assert.strictEqual(connectionReport(stopped), today);
        const running = connectionReport({ ...stopped, state: 'running' }, unreadable, 'launch');
        assert.ok(running.endsWith('Target state: running — DAP reads (memory/registers/variables) will be rejected until the target stops.'), running);
    });

    suite('through the executor, on a live session', () => {
        type Answer = (command: string, args: Record<string, unknown>) => unknown;
        interface Live {
            session: vscode.DebugSession;
            requests: Array<{ command: string; args: Record<string, unknown> }>;
            tracker: vscode.DebugAdapterTracker;
            event(event: string, body?: unknown): void;
        }
        const live: Live[] = [];
        let count = 0;

        /** A session the tracker sees as the most recent one, whose adapter answers `threads` with a thread list and DHCSR through `dhcsr`. */
        function liveSession(dhcsr: Answer, type = 'gdbtarget', request = 'launch'): Live {
            const requests: Live['requests'] = [];
            const session = {
                id: `core-status-${++count}`, name: 'S', type, configuration: { type, name: 'C', request },
                customRequest: (command: string, args: Record<string, unknown>) => {
                    requests.push({ command, args });
                    try {
                        return Promise.resolve(command === 'threads' ? { threads: [{ id: 1, name: 'main' }] } : dhcsr(command, args));
                    } catch (caught) {
                        return Promise.reject(caught);
                    }
                },
            } as unknown as vscode.DebugSession;
            const tracker = createSessionTracker(session);
            const made: Live = {
                session, requests, tracker,
                event: (event, body = {}) => tracker.onDidSendMessage?.({ type: 'event', event, body }),
            };
            live.push(made);
            return made;
        }
        const dhcsrReads = (made: Live): number => made.requests.filter((request) => request.command === 'readMemory'
            && request.args.memoryReference === DHCSR_ADDRESS && request.args.count === 4).length;
        const fails = (message: string): Answer => () => {
            throw new Error(message);
        };

        teardown(() => {
            for (const made of live.splice(0)) {
                made.tracker.onWillStopSession?.();
            }
        });

        test('a stopped CMSIS Debugger session: one DHCSR read; halted and lockup are reported', async () => {
            const halted = liveSession(() => bytes(0x00030003));
            halted.event('stopped', { reason: 'breakpoint', threadId: 1 });
            const text = await new DebuggingExecutor().checkTargetConnection();
            assert.match(text, /^Session: S \(type=gdbtarget\)\nConfiguration: C\nDAP probe: OK \(\d+ms\)\n/);
            assert.ok(text.endsWith('\nTarget state: stopped — the debug port answers: DHCSR=0x00030003 (halted).'), text);
            assert.strictEqual(dhcsrReads(halted), 1);
            halted.tracker.onWillStopSession?.();

            const locked = liveSession(() => bytes(0x000b0003));
            locked.event('stopped', { reason: 'signal', threadId: 1 });
            assert.ok((await new DebuggingExecutor().checkTargetConnection()).endsWith('(halted, in lockup — get_fault_info).'));
        });

        test('unreadable and timed-out DHCSR: the core does not answer, with the reconnect hint of the session\'s request', async () => {
            const wedged = liveSession(fails('Unable to read memory. (@ 0xe000edf0)'), 'gdbtarget', 'attach');
            wedged.event('stopped', { reason: 'breakpoint', threadId: 1 });
            const text = await new DebuggingExecutor().checkTargetConnection();
            assert.ok(text.endsWith('Target state: stopped, but the core does not answer (DHCSR at 0xE000EDF0 unreadable: Unable to read memory. '
                + `(@ 0xe000edf0)): memory and register reads will fail with PROBE_WEDGED.\n${wedgeHint('attach')}`), text);
            wedged.tracker.onWillStopSession?.();

            const hung = liveSession(() => never());
            hung.event('stopped', { reason: 'breakpoint', threadId: 1 });
            const began = Date.now();
            const slow = await new DebuggingExecutor({ dapRequestMs: 5_000 }).checkTargetConnection();
            assert.ok(Date.now() - began < 3_000, 'DHCSR gets at most 1 s');
            assert.ok(slow.endsWith(`(DHCSR at 0xE000EDF0 timed out): memory and register reads will fail with PROBE_WEDGED.\n${wedgeHint('launch')}`),
                slow);
        });

        test('an adapter without readMemory keeps today\'s line; a running target and other debug types are not read', async () => {
            const unsupportedAdapter = liveSession(fails('unrecognized request'));
            unsupportedAdapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
            assert.ok((await new DebuggingExecutor().checkTargetConnection()).endsWith('\nTarget state: stopped — full inspection is available.'));
            assert.strictEqual(dhcsrReads(unsupportedAdapter), 1);
            unsupportedAdapter.tracker.onWillStopSession?.();

            const running = liveSession(() => bytes(0x00030003));
            running.event('continued', {});
            assert.ok((await new DebuggingExecutor().checkTargetConnection()).endsWith('will be rejected until the target stops.'));
            assert.strictEqual(dhcsrReads(running), 0);
            running.tracker.onWillStopSession?.();

            const python = liveSession(() => bytes(0x00030003), 'debugpy');
            python.event('stopped', { reason: 'breakpoint', threadId: 1 });
            const unchanged = await new DebuggingExecutor().checkTargetConnection();
            assert.match(unchanged, /^Session: S \(type=debugpy\)\nConfiguration: C\nDAP probe: OK \(\d+ms\)\nTarget state: stopped — full inspection is available\.$/);
            assert.strictEqual(dhcsrReads(python), 0);
        });

        test('the status keeps a DHCSR read that got no answer, without reading; a stop or a DHCSR read that answers forgets it', async () => {
            let answer: Answer = fails('Unable to read memory. (@ 0xe000edf0)');
            const made = liveSession((command, args) => answer(command, args));
            made.event('stopped', { reason: 'breakpoint', threadId: 1 });
            const executor = new DebuggingExecutor();
            assert.strictEqual((await executor.getSessionStatus()).coreSilentForMs, undefined);
            await executor.checkTargetConnection();
            const status = await executor.getSessionStatus();
            assert.strictEqual(status.state, 'stopped', 'pause and stop stay possible');
            assert.ok(typeof status.coreSilentForMs === 'number' && status.coreSilentForMs >= 0 && status.coreSilentForMs < 5_000, String(status.coreSilentForMs));
            assert.strictEqual(dhcsrReads(made), 1, 'the status reads nothing');

            made.event('continued', {});
            assert.strictEqual((await executor.getSessionStatus()).coreSilentForMs, undefined, 'only a stopped status carries it');
            assert.notStrictEqual(coreSilentSince(made.session), undefined, 'a continue alone does not forget it');
            made.event('stopped', { reason: 'step', threadId: 1 });
            assert.strictEqual((await executor.getSessionStatus()).coreSilentForMs, undefined, 'the target ran and stopped again');

            await executor.probeDebugPort();
            assert.notStrictEqual((await executor.getSessionStatus()).coreSilentForMs, undefined, 'every DHCSR read counts, lockedUp\'s too');
            answer = () => bytes(0x00030003);
            await executor.probeDebugPort();
            assert.strictEqual((await executor.getSessionStatus()).coreSilentForMs, undefined, 'a DHCSR read that answers');
        });

        /** An adapter like the Corstone FVP's GDB server: a System Control Space read longer than one word comes back as zeros. */
        const fvpMemory = (words: Record<number, number>): Answer => (command, args) => {
            if (command !== 'readMemory') {
                throw new Error('unrecognized request');
            }
            const at = Number(args.memoryReference);
            const count = Number(args.count);
            const out = Buffer.alloc(count);
            if (!(at >= 0xE000E000 && at <= 0xE000EFFF && count > 4)) {
                for (let index = 0; index < count; index++) {
                    const address = at + index;
                    out[index] = ((words[address - (address & 3)] ?? 0) >>> ((address & 3) * 8)) & 0xff;
                }
            }
            return { data: out.toString('base64') };
        };
        const FAULTED = { 0xE000ED00: 0x411FD220, 0xE000ED04: 0x00000803, 0xE000ED28: 0x02000000, 0xE000ED2C: 0x40000000, 0xE000DFFC: 0xAABBCCDD, 0x20000000: 0x11223344 };
        const reads = (made: Live): string[] => made.requests.filter((request) => request.command === 'readMemory')
            .map((request) => `${String(request.args.memoryReference)}/${String(request.args.count)}`);

        test('the fault registers are read one word each, so a server that zeroes longer SCS reads still shows the fault', async () => {
            const made = liveSession(fvpMemory(FAULTED));
            made.event('stopped', { reason: 'breakpoint', threadId: 1 });
            const registers = await new DebuggingExecutor().readFaultRegisters();
            assert.deepStrictEqual(registers, { CFSR: 0x02000000, HFSR: 0x40000000, DFSR: 0, MMFAR: 0, BFAR: 0, AFSR: 0 });
            assert.deepStrictEqual(reads(made), ['0xE000ED28/4', '0xE000ED2C/4', '0xE000ED30/4', '0xE000ED34/4', '0xE000ED38/4', '0xE000ED3C/4']);
        });

        test('a memory read that touches the SCS goes word by word, aligned; other reads stay one block', async () => {
            const made = liveSession(fvpMemory(FAULTED));
            made.event('stopped', { reason: 'breakpoint', threadId: 1 });
            const executor = new DebuggingExecutor();
            const faultStatus = await executor.readMemory('0xE000ED28', 8);
            assert.deepStrictEqual([...faultStatus.bytes], [0, 0, 0, 2, 0, 0, 0, 0x40]);
            assert.strictEqual(faultStatus.offset, 0);
            assert.deepStrictEqual(reads(made), ['0xe000ed28/4', '0xe000ed2c/4']);

            made.requests.length = 0;
            const unaligned = await executor.readMemory('E000ED02', 5);
            assert.deepStrictEqual([...unaligned.bytes], [0x1F, 0x41, 0x03, 0x08, 0x00], 'CPUID\'s upper half, then ICSR\'s first three bytes');
            assert.deepStrictEqual(reads(made), ['0xe000ed00/4', '0xe000ed04/4']);

            made.requests.length = 0;
            const straddling = await executor.readMemory('0xE000DFFC', 8);
            assert.deepStrictEqual([...straddling.bytes], [0xDD, 0xCC, 0xBB, 0xAA, 0, 0, 0, 0]);
            assert.deepStrictEqual(reads(made), ['0xe000dffc/4', '0xe000e000/4']);

            made.requests.length = 0;
            const ram = await executor.readMemory('0x20000000', 16);
            assert.deepStrictEqual([...ram.bytes.subarray(0, 4)], [0x44, 0x33, 0x22, 0x11]);
            assert.deepStrictEqual(reads(made), ['0x20000000/16']);
        });

        test('the SCS and its Non-secure alias are read word by word; the rest of the PPB is not', () => {
            assert.deepStrictEqual(systemControlSpaceWords(0xE000ED28n, 24), { first: 0xE000ED28n, words: 6, skip: 0 });
            assert.deepStrictEqual(systemControlSpaceWords(0xE000EFFEn, 4), { first: 0xE000EFFCn, words: 2, skip: 2 });
            assert.deepStrictEqual(systemControlSpaceWords(0xE002ED28n, 4), { first: 0xE002ED28n, words: 1, skip: 0 });
            assert.strictEqual(systemControlSpaceWords(0xE0001000n, 16), undefined, 'the DWT');
            assert.strictEqual(systemControlSpaceWords(0xE000F000n, 16), undefined);
            assert.strictEqual(systemControlSpaceWords(0xE000DFF0n, 16), undefined, 'ends just below');
            assert.strictEqual(systemControlSpaceWords(0x20000000n, 4096), undefined);
        });

        test('a failed memory read\'s DHCSR read is kept too; other debug types keep nothing', async () => {
            const made = liveSession(fails('Unable to read memory.'));
            made.event('stopped', { reason: 'breakpoint', threadId: 1 });
            const failure = new MemoryReadFailure('0x20000000', [{ strategy: 'DAP readMemory', cause: 'Unable to read memory.' }]);
            const thrown = await explainReadFailure(made.session, '0x20000000', failure, 1_000);
            assert.ok(thrown instanceof ToolError && thrown.code === 'PROBE_WEDGED');
            assert.notStrictEqual(coreSilentSince(made.session), undefined);

            const other = scripted(fails('Unable to read memory.'), 'cppdbg');
            await probeDebugPort(other.session, 1_000);
            assert.strictEqual(coreSilentSince(other.session), undefined);
        });
    });
});
