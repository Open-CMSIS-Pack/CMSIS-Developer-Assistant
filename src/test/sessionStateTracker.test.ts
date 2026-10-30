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
import { ProblemJournal, type ProblemRecord } from '../core/problemJournal';
import {
    adoptedBreakpointsOf,
    armFocusWatch,
    armStartFocusWatch,
    awaitBreakpointsApplied,
    captureOutput,
    coreSilentSince,
    createSessionTracker,
    endRequestOf,
    expectAgentStart,
    type FocusSource,
    forgetAdoptedBreakpoints,
    forgetAgentStarts,
    forgetGdbLogpoints,
    gdbLogpointsOf,
    getLiveSessionNames,
    isAgentStarted,
    noteCoreVerdict,
    noteOwnRequest,
    quietStartFailure,
    registrySession,
    rememberGdbLogpoint,
    waitForSessionEnd,
    waitForStopEvent,
} from '../utils/sessionStateTracker';

/** A session as the tracker sees it, with the tracker VS Code would give it. */
interface Tracked {
    session: vscode.DebugSession;
    tracker: vscode.DebugAdapterTracker;
    output(text: string, category?: string): void;
    event(event: string, body?: unknown): void;
}

let sessionCount = 0;
const open: Tracked[] = [];

function track(type = 'gdbtarget', journal?: ProblemJournal): Tracked {
    const session = { id: `tracker-test-${++sessionCount}`, name: `Tracker test ${sessionCount}`, type, configuration: {} } as unknown as vscode.DebugSession;
    const tracker = createSessionTracker(session, journal);
    const tracked: Tracked = {
        session,
        tracker,
        output: (text, category = 'stdout') => tracker.onDidSendMessage?.({ type: 'event', event: 'output', body: { category, output: text } }),
        event: (event, body = {}) => tracker.onDidSendMessage?.({ type: 'event', event, body }),
    };
    open.push(tracked);
    return tracked;
}

const delay = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

type StackItem = ReturnType<FocusSource['current']>;

/** VS Code's focused stack item as a test drives it: `select` fires the change event, `hold` does not. */
interface FakeFocus {
    source: FocusSource;
    select(item: StackItem): void;
    hold(item: StackItem): void;
    listeners(): number;
}

function fakeFocus(initial: StackItem = undefined): FakeFocus {
    let item = initial;
    const listeners = new Set<(next: StackItem) => void>();
    return {
        source: {
            current: () => item,
            onDidChange: (listener) => {
                listeners.add(listener);
                return { dispose: () => listeners.delete(listener) };
            },
        },
        select: (next) => {
            item = next;
            for (const listener of [...listeners]) {
                listener(next);
            }
        },
        hold: (next) => {
            item = next;
        },
        listeners: () => listeners.size,
    };
}

/** A stack frame of `session`, as VS Code makes a new one for every focus it reports. */
function frameOf(session: vscode.DebugSession, frameId = 1000): StackItem {
    return { session, threadId: 1, frameId } as unknown as vscode.DebugStackFrame;
}

/**
 * The session tracker's hooks for #13 and #56: the output a GDB command
 * prints, the adapter's answers to VS Code's `setBreakpoints`, the GDB
 * logpoints of a session, and the wait for a session's end.
 */
suite('Session state tracker', () => {
    teardown(() => {
        for (const tracked of open.splice(0)) {
            tracked.tracker.onWillStopSession?.();
        }
    });

    suite('output capture', () => {
        test('collects its session\'s stdout in order, and nothing after it stopped', () => {
            const a = track();
            const b = track();
            const capture = captureOutput(a.session);
            a.output('r0             0x2a                42\n');
            a.output('GDB banner\n', 'console');
            b.output('other session\n');
            a.output('r1             0x0                 0\n');
            assert.strictEqual(capture.stop(), 'r0             0x2a                42\nr1             0x0                 0\n');
            a.output('late\n');
            assert.strictEqual(capture.stop(), 'r0             0x2a                42\nr1             0x0                 0\n');
        });

        test('settle waits until the output has been quiet for the quiet period', async () => {
            const a = track();
            const capture = captureOutput(a.session);
            a.output('Resetting target with halt\n');
            const began = Date.now();
            const settled = capture.settle(60, 2000);
            await delay(30);
            a.output('Successfully halted device on reset\n');
            const text = await settled;
            const took = Date.now() - began;
            assert.strictEqual(text, 'Resetting target with halt\nSuccessfully halted device on reset\n');
            assert.ok(took >= 80 && took < 1000, `quiet period counted from the last output: ${took} ms`);
        });

        test('settle gives up at the cap while output keeps coming, and at once when the session ends', async () => {
            const a = track();
            const chatty = captureOutput(a.session);
            const timer = setInterval(() => a.output('.'), 10);
            const began = Date.now();
            try {
                const text = await chatty.settle(40, 150);
                const took = Date.now() - began;
                assert.ok(took >= 140 && took < 1000, `capped: ${took} ms`);
                assert.ok(text.length > 3, text);
            } finally {
                clearInterval(timer);
            }

            const b = track();
            const cut = captureOutput(b.session);
            b.output('half a line');
            const settled = cut.settle(5000, 10_000);
            const ended = Date.now();
            b.event('terminated');
            assert.strictEqual(await settled, 'half a line');
            assert.ok(Date.now() - ended < 1000);
        });

        test('a capture started before the request sees output that comes before the reply', async () => {
            const a = track();
            const capture = captureOutput(a.session);
            a.output('Dprintf 3 at 0x80002f4: file main.c, line 29.\n');
            assert.strictEqual(await capture.settle(0, 100), 'Dprintf 3 at 0x80002f4: file main.c, line 29.\n');
        });
    });

    suite('setBreakpoints answered by the adapter', () => {
        function request(t: Tracked, seq: number, sourcePath: string): void {
            t.tracker.onWillReceiveMessage?.({ type: 'request', seq, command: 'setBreakpoints', arguments: { source: { path: sourcePath }, breakpoints: [] } });
        }
        function respond(t: Tracked, requestSeq: number): void {
            t.tracker.onDidSendMessage?.({ type: 'response', request_seq: requestSeq, command: 'setBreakpoints', success: true, body: { breakpoints: [] } });
        }

        test('resolves once every file has been answered, not before', async () => {
            const a = track();
            let settled = false;
            const applied = awaitBreakpointsApplied(a.session, ['/w/main.c', '/w/led.c'], 2000).then((value) => {
                settled = true;
                return value;
            });
            request(a, 7, '/w/main.c');
            request(a, 8, '/w/led.c');
            respond(a, 7);
            await delay(10);
            assert.strictEqual(settled, false, 'led.c has not been answered');
            respond(a, 8);
            assert.strictEqual(await applied, true);
        });

        test('answers for other files and sessions do not count; the wait is bounded and ends with the session', async () => {
            const a = track();
            const b = track();
            const began = Date.now();
            const applied = awaitBreakpointsApplied(a.session, ['/w/main.c'], 120);
            request(b, 1, '/w/main.c');
            respond(b, 1);
            request(a, 2, '/w/other.c');
            respond(a, 2);
            assert.strictEqual(await applied, false);
            assert.ok(Date.now() - began >= 100);

            const ending = awaitBreakpointsApplied(a.session, ['/w/main.c'], 5000);
            a.event('terminated');
            assert.strictEqual(await ending, false);
            assert.strictEqual(await awaitBreakpointsApplied(b.session, [], 5000), true, 'nothing to wait for');
        });

        test('paths compare with forward slashes and a lower-case drive letter', async () => {
            const a = track();
            const applied = awaitBreakpointsApplied(a.session, ['C:\\w\\main.c'], 2000);
            request(a, 3, 'c:/w/main.c');
            respond(a, 3);
            assert.strictEqual(await applied, true);
        });
    });

    suite('GDB logpoints of a session', () => {
        test('remembered by number, listed in order, forgotten by number and on GDB\'s own delete', () => {
            const a = track();
            const b = track();
            rememberGdbLogpoint(a.session, { number: 5, file: '/w/main.c', line: 30, message: 'b' });
            rememberGdbLogpoint(a.session, { number: 3, file: '/w/main.c', line: 29, message: 'a', condition: 'n > 1' });
            rememberGdbLogpoint(b.session, { number: 3, file: '/w/led.c', line: 17, message: 'other' });
            assert.deepStrictEqual(gdbLogpointsOf(a.session).map((logpoint) => logpoint.number), [3, 5]);
            const copy = gdbLogpointsOf(a.session)[0];
            copy.line = 99;
            assert.strictEqual(gdbLogpointsOf(a.session)[0].line, 29, 'callers get copies');

            forgetGdbLogpoints(a.session, [5, 42]);
            assert.deepStrictEqual(gdbLogpointsOf(a.session).map((logpoint) => logpoint.number), [3]);
            a.event('breakpoint', { reason: 'changed', breakpoint: { id: 3, verified: true } });
            assert.strictEqual(gdbLogpointsOf(a.session).length, 1);
            a.event('breakpoint', { reason: 'removed', breakpoint: { id: 3, verified: false } });
            assert.deepStrictEqual(gdbLogpointsOf(a.session), []);
            assert.strictEqual(gdbLogpointsOf(b.session).length, 1, 'the other session keeps its own');
        });

        test('forgotten when the session ends, whichever way it ends', () => {
            for (const end of ['terminated', 'exited', 'stop']) {
                const a = track();
                rememberGdbLogpoint(a.session, { number: 3, file: '/w/main.c', line: 29, message: 'a' });
                if (end === 'stop') {
                    a.tracker.onWillStopSession?.();
                } else {
                    a.event(end);
                }
                assert.deepStrictEqual(gdbLogpointsOf(a.session), [], end);
            }
        });
    });

    suite('the last DHCSR read that got no answer (#3)', () => {
        test('kept with its time per session; a read that answers forgets it, one that tells nothing changes nothing', () => {
            const a = track();
            const b = track();
            assert.strictEqual(coreSilentSince(a.session), undefined);
            noteCoreVerdict(a.session, 'silent', 1_000);
            noteCoreVerdict(a.session, 'unknown', 2_000);
            assert.strictEqual(coreSilentSince(a.session), 1_000);
            assert.strictEqual(coreSilentSince(b.session), undefined, 'the other session has its own');
            noteCoreVerdict(a.session, 'silent', 3_000);
            assert.strictEqual(coreSilentSince(a.session), 3_000, 'the last read counts');
            noteCoreVerdict(a.session, 'answers', 4_000);
            assert.strictEqual(coreSilentSince(a.session), undefined);
        });

        test('a stop event forgets it, a continued event does not', () => {
            const a = track();
            noteCoreVerdict(a.session, 'silent', 1_000);
            a.event('continued', { threadId: 1 });
            assert.strictEqual(coreSilentSince(a.session), 1_000);
            a.event('stopped', { reason: 'step', threadId: 1 });
            assert.strictEqual(coreSilentSince(a.session), undefined);
        });

        test('forgotten when the session ends and when an adapter starts in it again', () => {
            for (const end of ['terminated', 'stop']) {
                const a = track();
                noteCoreVerdict(a.session, 'silent', 1_000);
                if (end === 'stop') {
                    a.tracker.onWillStopSession?.();
                } else {
                    a.event(end);
                }
                assert.strictEqual(coreSilentSince(a.session), undefined, end);
            }
            const b = track();
            noteCoreVerdict(b.session, 'silent', 1_000);
            const again = createSessionTracker(b.session);
            assert.strictEqual(coreSilentSince(b.session), undefined, 'a relaunch in the same session');
            again.onWillStopSession?.();
        });
    });

    suite('a session asked to end', () => {
        test('a disconnect or terminate request to the adapter is kept with its time; other requests are not', () => {
            const a = track();
            const b = track();
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 1, command: 'threads', arguments: {} });
            assert.strictEqual(endRequestOf(a.session), undefined);
            const before = Date.now();
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 2, command: 'terminate', arguments: {} });
            const ending = endRequestOf(a.session);
            assert.strictEqual(ending?.command, 'terminate');
            assert.ok(ending !== undefined && ending.at >= before && ending.at <= Date.now());
            assert.strictEqual(endRequestOf(b.session), undefined, 'the other session has its own');
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 3, command: 'disconnect', arguments: { restart: false } });
            assert.strictEqual(endRequestOf(a.session)?.command, 'disconnect', 'the last request counts');
        });

        test('forgotten when the adapter refuses it, when the session ends and when an adapter starts in it again', () => {
            const a = track();
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 1, command: 'terminate', arguments: {} });
            a.tracker.onDidSendMessage?.({ type: 'response', request_seq: 1, command: 'terminate', success: true });
            assert.strictEqual(endRequestOf(a.session)?.command, 'terminate', 'a terminate that succeeds still waits for the end');
            a.tracker.onDidSendMessage?.({ type: 'response', request_seq: 1, command: 'terminate', success: false, message: 'not now' });
            assert.strictEqual(endRequestOf(a.session), undefined);

            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 2, command: 'disconnect', arguments: {} });
            a.event('terminated');
            assert.strictEqual(endRequestOf(a.session), undefined);

            const b = track();
            b.tracker.onWillReceiveMessage?.({ type: 'request', seq: 1, command: 'disconnect', arguments: { restart: true } });
            const again = createSessionTracker(b.session);
            assert.strictEqual(endRequestOf(b.session), undefined, 'a relaunch in the same session');
            again.onWillStopSession?.();
        });
    });

    suite('session end', () => {
        test('the wait resolves when the session ends, false when it does not, true for a session that is gone', async () => {
            const a = track();
            assert.ok(getLiveSessionNames().includes(a.session.name));
            const ending = waitForSessionEnd(a.session, 5000);
            a.tracker.onWillStopSession?.();
            assert.strictEqual(await ending, true);
            assert.ok(!getLiveSessionNames().includes(a.session.name));
            assert.strictEqual(await waitForSessionEnd(a.session, 5000), true, 'already gone');

            const b = track();
            assert.strictEqual(await waitForSessionEnd(b.session, 50), false);
        });

        test('a stop wait on a session that has ended resolves at once, until an adapter starts in it again', async () => {
            const a = track();
            a.event('terminated');
            const began = Date.now();
            assert.deepStrictEqual(await waitForStopEvent(a.session, 5000), { kind: 'ended' });
            assert.ok(Date.now() - began < 1000);
            // VS Code's restart of an adapter without a restart request reuses the session.
            const again = createSessionTracker(a.session);
            const stop = waitForStopEvent(a.session, 5000);
            again.onDidSendMessage?.({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } });
            assert.deepStrictEqual(await stop, { kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            again.onWillStopSession?.();
        });
    });

    suite('the frame VS Code selects after a stop', () => {
        test('a frame object other than the one focused when the watch was armed counts at once; the stale one never does', async () => {
            const a = track();
            const before = frameOf(a.session);
            const focus = fakeFocus(before);
            const watch = armFocusWatch(a.session, focus.source);
            // VS Code has not yet heard the stop of a request sent as a custom request: it still holds the frame from before.
            const began = Date.now();
            assert.strictEqual(await watch.selected(80), false);
            assert.ok(Date.now() - began >= 70, 'the wait ran to its bound');
            assert.strictEqual(focus.listeners(), 0, 'the subscription went with the wait');

            focus.hold(frameOf(a.session));
            assert.strictEqual(await armFocusWatch(a.session, focus.source).selected(0), false, 'armed now, the new frame is the stale one');
            assert.strictEqual(await watch.selected(0), true, 'for the watch armed before, it is the stop\'s');
        });

        test('a frame of the session delivered by the change event ends the wait; threads and other sessions\' frames do not', async () => {
            const a = track();
            const b = track();
            const focus = fakeFocus();
            const pending = armFocusWatch(a.session, focus.source).selected(2_000);
            let settled: boolean | undefined;
            void pending.then((selected) => {
                settled = selected;
            });
            focus.select({ session: a.session, threadId: 1 } as unknown as vscode.DebugThread);
            focus.select(frameOf(b.session));
            await delay(20);
            assert.strictEqual(settled, undefined, 'a thread item and another session\'s frame leave it waiting');
            const began = Date.now();
            focus.select(frameOf(a.session));
            assert.strictEqual(await pending, true);
            assert.ok(Date.now() - began < 500, 'the event ends the wait, no poll');
            assert.strictEqual(focus.listeners(), 0);
        });

        test('the end of the session ends the wait; a session that has ended and a bound of 0 answer at once', async () => {
            const a = track();
            const focus = fakeFocus();
            const pending = armFocusWatch(a.session, focus.source).selected(5_000);
            const began = Date.now();
            a.tracker.onWillStopSession?.();
            assert.strictEqual(await pending, false);
            assert.ok(Date.now() - began < 500);
            assert.strictEqual(focus.listeners(), 0);
            assert.strictEqual(await armFocusWatch(a.session, focus.source).selected(5_000), false, 'ended before the wait');

            const b = track();
            assert.strictEqual(await armFocusWatch(b.session, focus.source).selected(0), false);
            assert.strictEqual(focus.listeners(), 0, 'nothing subscribed for a wait of 0');
        });
    });

    suite('the frame VS Code selects for a session that came up', () => {
        test('a stopped session waits for a frame of its own; a frame of an earlier session focused at arming does not count', async () => {
            const old = track();
            const a = track();
            const focus = fakeFocus(frameOf(old.session));
            const watch = armStartFocusWatch(focus.source, () => a.session, () => true);
            assert.strictEqual(await watch.settled(30), 'none', 'no frame of the new session yet');
            const pending = watch.settled(2_000);
            focus.select(frameOf(a.session));
            assert.strictEqual(await pending, 'selected');
            assert.strictEqual(focus.listeners(), 0);
            // Armed after VS Code focused it, that frame is the stale item: the watch is taken before the start.
            focus.hold(frameOf(a.session));
            assert.strictEqual(await armStartFocusWatch(focus.source, () => a.session, () => true).settled(0), 'none',
                'the item focused when armed is never the start\'s');
        });

        test('a target that runs needs no frame, and without a session there is none', async () => {
            const a = track();
            const focus = fakeFocus();
            assert.strictEqual(await armStartFocusWatch(focus.source, () => a.session, () => false).settled(5_000), 'running');
            assert.strictEqual(await armStartFocusWatch(focus.source, () => undefined, () => true).settled(5_000), 'none');
            assert.strictEqual(focus.listeners(), 0);
        });
    });

    suite('the breakpoints VS Code adopts from an adapter', () => {
        teardown(() => forgetAdoptedBreakpoints());

        test('a new breakpoint at a source line is adopted for the window, past the session\'s end; its removal by the same adapter forgets it', () => {
            forgetAdoptedBreakpoints();
            const a = track();
            const at = (id: number, line: number): unknown => ({ reason: 'new', breakpoint: { id, verified: true, source: { name: 'startup.c', path: '/w/startup.c' }, line } });
            a.event('breakpoint', at(1, 53));
            a.event('breakpoint', at(2, 54));
            a.event('breakpoint', { reason: 'new', breakpoint: { id: 3, verified: true, instructionReference: '0x10000100' } });
            a.event('breakpoint', { reason: 'changed', breakpoint: { id: 1, verified: true, source: { path: '/w/startup.c' }, line: 53 } });
            assert.deepStrictEqual(adoptedBreakpointsOf(), [
                { path: '/w/startup.c', line: 53, sessionName: a.session.name },
                { path: '/w/startup.c', line: 54, sessionName: a.session.name },
            ], 'no source line, nothing VS Code can adopt; a change adopts nothing');
            const b = track();
            b.event('breakpoint', { reason: 'removed', breakpoint: { id: 2, verified: false } });
            assert.strictEqual(adoptedBreakpointsOf().length, 2, 'another session\'s id 2 is another breakpoint');
            a.event('breakpoint', { reason: 'removed', breakpoint: { id: 2, verified: false } });
            assert.deepStrictEqual(adoptedBreakpointsOf().map((bp) => bp.line), [53]);
            a.tracker.onWillStopSession?.();
            assert.deepStrictEqual(adoptedBreakpointsOf().map((bp) => bp.line), [53], 'VS Code keeps it after the session');
            forgetAdoptedBreakpoints();
            assert.deepStrictEqual(adoptedBreakpointsOf(), []);
        });
    });

    suite('the session the window\'s registry entry names', () => {
        test('the focused session while it is live; not while its end is announced, nor once the tracker saw it end', () => {
            const a = track();
            assert.strictEqual(registrySession(a.session), a.session);
            assert.strictEqual(registrySession(a.session, a.session), undefined, 'VS Code still has it focused while onDidTerminateDebugSession runs');
            a.tracker.onWillStopSession?.();
            assert.strictEqual(registrySession(a.session), undefined, 'a focus VS Code has not moved yet');
            assert.strictEqual(registrySession(undefined), undefined);
        });

        test('of two sessions, the one that stays when the other ends, focused or not', () => {
            const first = track();
            const second = track();
            assert.strictEqual(registrySession(undefined), second.session, 'none focused: the most recent live session');
            assert.strictEqual(registrySession(first.session), first.session, 'the focused one, though older');
            assert.strictEqual(registrySession(second.session, second.session), first.session);
            second.event('terminated');
            assert.strictEqual(registrySession(second.session), first.session);
            assert.strictEqual(registrySession(undefined), first.session);
        });

        test('a focused session the tracker never saw counts as VS Code has it, until its end is announced', () => {
            const elsewhere = { id: 'other-host', name: 'Python', type: 'debugpy', configuration: { name: 'Python: Current File' } } as unknown as vscode.DebugSession;
            assert.strictEqual(registrySession(elsewhere), elsewhere);
            assert.strictEqual(registrySession(elsewhere, elsewhere), undefined);
        });
    });

    suite('a failed start an agent asked for opens no dialog', () => {
        teardown(() => forgetAgentStarts());

        /** A failed launch response as cdt-gdb-adapter sends it: the error marked for the user. */
        const failedLaunch = (command = 'launch'): { type: string; command: string; success: boolean; message: string; body: { error: { id: number; format: string; showUser?: boolean } } } => ({
            type: 'response', command, success: false, message: 'could not connect: Operation timed out.',
            body: { error: { id: 1, format: 'could not connect: Operation timed out.', showUser: true } },
        });

        test('a session started while an agent start is expected gets its failed launch or attach marked showUser false', () => {
            expectAgentStart(60_000);
            const agents = track();
            assert.ok(isAgentStarted(agents.session));
            const launch = failedLaunch();
            agents.tracker.onDidSendMessage?.(launch);
            assert.strictEqual(launch.body.error.showUser, false, 'VS Code shows no modal dialog for it');
            const attach = failedLaunch('attach');
            agents.tracker.onDidSendMessage?.(attach);
            assert.strictEqual(attach.body.error.showUser, false);
            // Other failed requests keep what the adapter said.
            const evaluate = { ...failedLaunch(), command: 'evaluate' };
            agents.tracker.onDidSendMessage?.(evaluate);
            assert.strictEqual(evaluate.body.error.showUser, true);
        });

        test('a session the user started keeps VS Code\'s dialog; a child session of an agent\'s start counts as the agent\'s', () => {
            const users = track();
            assert.ok(!isAgentStarted(users.session));
            const launch = failedLaunch();
            users.tracker.onDidSendMessage?.(launch);
            assert.strictEqual(launch.body.error.showUser, true);

            expectAgentStart(60_000);
            const root = track();
            forgetAgentStarts();
            const core = { id: 'core1', name: 'core 1', type: 'gdbtarget', configuration: {}, parentSession: root.session } as unknown as vscode.DebugSession;
            createSessionTracker(core);
            assert.ok(isAgentStarted(core));
        });

        test('an error response without an error object gets one that says showUser false', () => {
            const bare: { message: string; body?: { error?: unknown } } = { message: 'Unable to start debugging.' };
            assert.strictEqual(quietStartFailure(bare), 'Unable to start debugging.');
            assert.deepStrictEqual(bare.body, { error: { id: 0, format: 'Unable to start debugging.', showUser: false } });
        });
    });

    suite('problems on the adapter channel (#48)', () => {
        let journal: ProblemJournal;

        setup(() => {
            journal = new ProblemJournal();
        });

        /** A tracked session whose problems go to this suite's journal. */
        function journaled(): Tracked {
            return track('gdbtarget', journal);
        }

        const only = (): ProblemRecord => {
            const { records } = journal.query();
            assert.strictEqual(records.length, 1, JSON.stringify(records));
            return records[0];
        };

        test('a failed response to a request VS Code sent is an error, classified when the line is known', () => {
            const a = journaled();
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 5, command: 'setBreakpoints', arguments: { source: { path: '/w/main.c' } } });
            a.tracker.onDidSendMessage?.({
                type: 'response', request_seq: 5, command: 'setBreakpoints', success: false,
                message: 'Cannot execute this command while the target is running.',
            });
            const record = only();
            assert.deepStrictEqual(
                [record.source, record.severity, record.code, record.hint, record.origin, record.debugSessionId, record.message],
                ['dap', 'error', 'TARGET_RUNNING', 'Call pause_execution first.', a.session.name, a.session.id,
                    'error response to \'setBreakpoints\': Cannot execute this command while the target is running.']);
        });

        test('a failed response to a request a tool announced is a warning: the tool reports it', () => {
            const a = journaled();
            noteOwnRequest(a.session, 'readMemory');
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 9, command: 'readMemory', arguments: { memoryReference: '0x0', count: 4 } });
            a.tracker.onDidSendMessage?.({ type: 'response', request_seq: 9, command: 'readMemory', success: false, message: 'Unable to read memory.' });
            assert.deepStrictEqual([only().severity, only().message], ['warning', 'error response to \'readMemory\': Unable to read memory.']);
            // The announcement is used up: the next readMemory is VS Code's own.
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 10, command: 'readMemory' });
            a.tracker.onDidSendMessage?.({ type: 'response', request_seq: 10, command: 'readMemory', success: false, message: 'Unable to read memory at 0x4.' });
            assert.strictEqual(journal.query().records[1].severity, 'error');
        });

        test('a failed response whose request the tracker never saw is a warning while a tool call runs, else an error', () => {
            const a = journaled();
            const call = journal.beginCall('abcd1234-1');
            a.tracker.onDidSendMessage?.({ type: 'response', command: 'launch', success: false, message: 'Failed to launch the GDB server' });
            call.end();
            a.tracker.onDidSendMessage?.({ type: 'response', command: 'threads', success: false, body: { error: { id: 1, format: 'No threads' } } });
            assert.deepStrictEqual(journal.query().records.map((record) => [record.severity, record.message, record.toolCallId]), [
                ['warning', 'error response to \'launch\': Failed to launch the GDB server', 'abcd1234-1'],
                ['error', 'error response to \'threads\': No threads', undefined],
            ]);
        });

        test('an evaluate the views sent on their own (Watch, hover, Live Watch) that fails is info; a tool\'s stays a warning', () => {
            const a = journaled();
            // A tester's Watch expressions while the target ran, and Live Watch without a frame.
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 21, command: 'evaluate', arguments: { expression: 'huart2', context: 'watch' } });
            a.tracker.onDidSendMessage?.({ type: 'response', request_seq: 21, command: 'evaluate', success: false });
            a.tracker.onDidSendMessage?.({ type: 'response', command: 'evaluate', success: false,
                message: 'Evaluation of expression without frameId is not supported.' });
            noteOwnRequest(a.session, 'evaluate');
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 22, command: 'evaluate', arguments: { expression: 'x' } });
            a.tracker.onDidSendMessage?.({ type: 'response', request_seq: 22, command: 'evaluate', success: false, message: 'No symbol "x" in current context.' });
            a.tracker.onWillReceiveMessage?.({ type: 'request', seq: 23, command: 'readMemory' });
            a.tracker.onDidSendMessage?.({ type: 'response', request_seq: 23, command: 'readMemory', success: false, message: 'Unable to read memory.' });
            assert.deepStrictEqual(journal.query().records.map((record) => [record.severity, record.message]), [
                ['info', 'error response to \'evaluate\': <no message>'],
                ['info', 'error response to \'evaluate\': Evaluation of expression without frameId is not supported.'],
                ['warning', 'error response to \'evaluate\': No symbol "x" in current context.'],
                ['error', 'error response to \'readMemory\': Unable to read memory.'],
            ]);
            assert.strictEqual(journal.counters().errors, 1, 'only the readMemory counts as an error');
        });

        test('a cancelled request and a successful response are no problem', () => {
            const a = journaled();
            a.tracker.onDidSendMessage?.({ type: 'response', command: 'stackTrace', success: false, message: 'cancelled' });
            a.tracker.onDidSendMessage?.({ type: 'response', command: 'threads', success: true, body: { threads: [] } });
            assert.strictEqual(journal.size, 0);
        });

        test('stderr is a warning, console and important are info, the target\'s stdout and GDB\'s log are left out; a known line takes its code, weight and source', () => {
            const a = journaled();
            a.output('hello from the target\n', 'stdout');
            a.output('&"set pagination off\\n"\n', 'log');
            a.output('   \n', 'stderr');
            a.output('warning: could not read symbols\n', 'stderr');
            a.output('Reading symbols from blinky.elf...\n', 'console');
            a.output('Program received signal SIGTRAP\n', 'important');
            a.output('Failed to power up DAP\n', 'stderr');
            a.output('Waiting for a debug probe matching unique ID \'cmsisdap:\' to be connected...\n', 'console');
            a.output('telemetry blob', 'telemetry');
            assert.deepStrictEqual(journal.query().records.map((record) => [record.severity, record.source, record.code ?? '-', record.message]), [
                ['warning', 'dap', '-', 'warning: could not read symbols'],
                ['info', 'dap', '-', 'Reading symbols from blinky.elf...'],
                ['info', 'dap', '-', 'Program received signal SIGTRAP'],
                ['error', 'gdb-server', 'DAP_POWER_UP_FAILED', 'Failed to power up DAP'],
                ['error', 'gdb-server', 'PROBE_BUSY', 'Waiting for a debug probe matching unique ID \'cmsisdap:\' to be connected...'],
            ]);
        });

        test('the GDB server\'s output (category server on cdt-gdb-adapter) is the gdb-server\'s, info unless the line is known, one record per line', () => {
            const a = journaled();
            a.output('Listening on port 3333\r\nFailed to power up DAP\n\n', 'server');
            a.output('gdbserver exited with code 1\n', 'server');
            assert.deepStrictEqual(journal.query().records.map((record) => [record.severity, record.source, record.code ?? '-', record.message]), [
                ['info', 'gdb-server', '-', 'Listening on port 3333'],
                ['error', 'gdb-server', 'DAP_POWER_UP_FAILED', 'Failed to power up DAP'],
                ['info', 'gdb-server', '-', 'gdbserver exited with code 1'],
            ]);
        });

        test('a GDB-server line keeps the level pyOCD gave it, without its colour codes', () => {
            // A tester's pyOCD on Windows (CMSIS Debugger 1.10.0), whose STDIO file folder did not exist.
            const a = journaled();
            a.output([
                '0000652 I Target device: STM32F746ZGTx [cbuild_run]',
                '0000992 E Unhandled exception in \'gdbserver\' subcommand [gdbserver_cmd]',
                '\x1b[2mTraceback (most recent call last):',
                'FileNotFoundError: Directory D:\\Test\\DUT\\out\\reports for STDIO file usart-validation.log does not exist\x1b[0m',
                '0001001 C Error: Directory D:\\Test\\DUT\\out\\reports for STDIO file usart-validation.log does not exist [__main__]',
                'gdbserver exited with code 1',
            ].join('\r\n') + '\r\n', 'server');
            // The same prefix outside the GDB server's category weighs nothing.
            a.output('0000992 E not the server\'s\n', 'console');
            assert.deepStrictEqual(journal.query().records.map((record) => [record.severity, record.source, record.message]), [
                ['info', 'gdb-server', '0000652 I Target device: STM32F746ZGTx [cbuild_run]'],
                ['error', 'gdb-server', '0000992 E Unhandled exception in \'gdbserver\' subcommand [gdbserver_cmd]'],
                ['info', 'gdb-server', 'Traceback (most recent call last):'],
                ['info', 'gdb-server', 'FileNotFoundError: Directory D:\\Test\\DUT\\out\\reports for STDIO file usart-validation.log does not exist'],
                ['error', 'gdb-server', '0001001 C Error: Directory D:\\Test\\DUT\\out\\reports for STDIO file usart-validation.log does not exist [__main__]'],
                ['info', 'gdb-server', 'gdbserver exited with code 1'],
                ['info', 'dap', '0000992 E not the server\'s'],
            ]);
        });

        test('a line the GDB server writes in pieces is one record once its newline comes; categories keep their own pieces', () => {
            // The Corstone FVP's output reached the journal as "Bl", "in", "ky i", ... one record each.
            const a = journaled();
            for (const piece of ['= Bl', 'in', 'ky i', 's running =', '\r', '\nFailed to po', 'wer up DAP\nListening']) {
                a.output(piece, 'server');
            }
            a.output('Reading sym', 'console');
            a.output('bols\n', 'console');
            assert.deepStrictEqual(journal.query().records.map((record) => [record.source, record.code ?? '-', record.message]), [
                ['gdb-server', '-', '= Blinky is running ='],
                ['gdb-server', 'DAP_POWER_UP_FAILED', 'Failed to power up DAP'],
                ['dap', '-', 'Reading symbols'],
            ]);
            a.output(' on port 3333\n', 'server');
            assert.strictEqual(journal.query().records.at(-1)?.message, 'Listening on port 3333');
            a.output('hello', 'stdout');
            a.output(' target\n', 'stdout');
            assert.strictEqual(journal.size, 4, 'the target\'s stdout is still left out');
        });

        test('the start of a line is journaled as it is after a short wait, at the session\'s end, or when it is very long', async () => {
            const a = journaled();
            a.output('gdbserver exited with code 1', 'server');
            assert.strictEqual(journal.size, 0, 'it waits for its end');
            await delay(700);
            assert.deepStrictEqual(journal.query().records.map((record) => record.message), ['gdbserver exited with code 1']);

            const b = journaled();
            b.output('Remote connection closed', 'console');
            b.event('terminated');
            assert.strictEqual(journal.query().records.at(-1)?.message, 'Remote connection closed', 'the session\'s end journals it at once');
            await delay(700);
            assert.strictEqual(journal.query().records.filter((record) => record.message === 'Remote connection closed').length, 1, 'and only once');

            const c = journaled();
            const before = journal.size;
            c.output('x'.repeat(5_000), 'server');
            assert.strictEqual(journal.size, before + 1, 'a very long piece is not held');
            assert.ok(journal.query().records.at(-1)?.message.startsWith('xxxx'));
        });

        test('an adapter error is an error', () => {
            const a = journaled();
            a.tracker.onError?.(new Error('pipe closed'));
            assert.deepStrictEqual([only().severity, only().message], ['error', 'adapter error: pipe closed']);
        });
    });
});
