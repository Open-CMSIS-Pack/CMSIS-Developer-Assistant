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
 * Memory helpers of the executor: how addresses are spelled, where the bytes
 * of a DAP `readMemory` reply lie, how one 32-bit word is read through GDB
 * when the adapter's `readMemory` request fails, and what a failed read
 * means (#3).
 *
 * The word read tries evaluate requests in turn and keeps the first answer it
 * can parse: a watch expression that dereferences the address, then raw GDB
 * commands in the dialect of the session's adapter (src/core/gdbDialect.ts).
 * On the CMSIS Debugger that is the MI command `-data-read-memory-bytes`,
 * whose result comes back in the evaluate reply (a CLI command's text would
 * only reach the Debug Console); elsewhere `x/1xw` and `print/x` through
 * `-exec`, whose text is the reply. A timeout ends the read at once.
 *
 * A read that fails keeps why each strategy failed (`MemoryReadFailure`).
 * On the CMSIS Debugger, `explainReadFailure` then reads DHCSR once
 * (`probeDebugPort`) and turns the failure into `PROBE_WEDGED` or
 * `INVALID_ARGUMENT` (src/core/probeWedge.ts); elsewhere the failure keeps
 * its causes and nothing more is read. Every DHCSR read of a CMSIS Debugger
 * session leaves its verdict with the session tracker.
 *
 * `readWord` in src/core/peripheralReader.ts is a similar ladder with its own
 * behaviour (no third form, `readMemory` first); the two stay separate.
 */

import * as vscode from 'vscode';
import { bytesFromMiMemoryReply, CMSIS_DEBUGGER_TYPE, miReadMemoryCommand } from '../core/gdbDialect';
import { attemptsText, CANARY_MS, classifyReadFailure, coreVerdict, DebugPortProbe, DHCSR_ADDRESS, ReadAttempt } from '../core/probeWedge';
import { noteCoreVerdict } from '../utils/sessionStateTracker';
import { customRequestWithTimeout, HardwareTimeoutError } from '../utils/timeout';
import { EvaluateBody, FrameArg, messageOf, ReadMemoryBody } from './common';
import type { MemoryRead } from './contract';

/** An address written without `0x` gets it; anything else is used verbatim (no case change, no padding). */
export function withHexPrefix(address: string): string {
    return /^0x/i.test(address) ? address : `0x${address}`;
}

/** The address of a DAP `readMemory` reply: hex after `0x`, decimal otherwise. */
const REPLY_ADDRESS = /^(?:0x[0-9a-f]+|[0-9]+)$/i;

/**
 * The part of a DAP `readMemory` reply that lies in the `count` bytes from
 * `first`, and how far after `first` it begins. The reply's `address` is
 * that of its first byte (DAP). cdt-gdb-adapter sets it to where GDB's first
 * readable block begins, which is later than asked when the start of the
 * range cannot be read. A reply without an address begins at `first`;
 * `unreadableBytes` counts bytes after the data and moves nothing. A string
 * says why the reply holds no byte of the range.
 */
export function bytesInRange(reply: ReadMemoryBody | undefined, first: bigint, count: number): MemoryRead | string {
    const data = reply?.data ? Buffer.from(reply.data, 'base64') : undefined;
    if (!data || data.length === 0) {
        return 'no data in the reply';
    }
    const spelled = String(reply?.address ?? '').trim();
    if (spelled !== '' && !REPLY_ADDRESS.test(spelled)) {
        return `the reply's address '${spelled}' is not a number`;
    }
    const begin = spelled === '' ? first : BigInt(spelled);
    const end = first + BigInt(count);
    const from = begin > first ? begin : first;
    const to = begin + BigInt(data.length) < end ? begin + BigInt(data.length) : end;
    if (to <= from) {
        return `the reply's ${data.length} bytes at 0x${begin.toString(16)} lie outside the range`;
    }
    return { bytes: data.subarray(Number(from - begin), Number(to - begin)), offset: Number(from - first) };
}

/**
 * The address `index` words after `start`: lower-case, unpadded, and computed
 * with BigInt, so it is never wrapped at 4 GiB (KB15). A `start` BigInt cannot
 * parse throws its SyntaxError.
 */
export function nthWordAddress(start: string, index: number): string {
    return `0x${(BigInt(start) + BigInt(index) * 4n).toString(16)}`;
}

/** One way of asking GDB for the word, and how its answer is read. */
interface WordQuery {
    /** How the failure names this strategy. */
    strategy: string;
    context: 'watch' | 'repl';
    expressionFor(address: string): string;
    /** The word in the adapter's `result` text for `address`, or undefined when there is none. */
    parse(result: string, address: string): number | undefined;
}

const WATCH_QUERY: WordQuery = {
    strategy: 'watch expression', context: 'watch', expressionFor: (address) => `*(unsigned int*)${address}`, parse: leadingInteger,
};

/** The ladder per adapter: the CMSIS Debugger answers MI commands in the reply, MIEngine answers `-exec` commands there. */
const CDT_QUERIES: readonly WordQuery[] = [
    WATCH_QUERY,
    { strategy: 'MI read', context: 'repl', expressionFor: (address) => `>${miReadMemoryCommand(address, 4)}`, parse: wordFromMiReply },
];
const MI_ENGINE_QUERIES: readonly WordQuery[] = [
    WATCH_QUERY,
    { strategy: 'x/1xw', context: 'repl', expressionFor: (address) => `-exec x/1xw ${address}`, parse: hexAfterColon },
    { strategy: 'print/x', context: 'repl', expressionFor: (address) => `-exec print/x *(unsigned int*)${address}`, parse: firstHexLiteral },
];

/** A read that failed in every way it was tried: the address, and why each strategy gave no value. */
export class MemoryReadFailure extends Error {
    constructor(readonly address: string, readonly attempts: readonly ReadAttempt[]) {
        super(`Failed to read memory at ${address}: ${attemptsText(attempts)}`);
        this.name = 'MemoryReadFailure';
    }
}

/** `caught` with `earlier` attempts in front when it is a `MemoryReadFailure`; anything else as it is. */
export function withEarlierAttempts(caught: unknown, earlier: readonly ReadAttempt[]): unknown {
    return caught instanceof MemoryReadFailure && earlier.length > 0
        ? new MemoryReadFailure(caught.address, [...earlier, ...caught.attempts])
        : caught;
}

/** Why a query's reply held no word: its text, or that there was none. */
function unreadableReply(answer: unknown): string {
    if (typeof answer !== 'string') {
        return 'no result in the reply';
    }
    const text = answer.trim();
    return text.length > 0 ? `no value in '${text}'` : 'empty result';
}

/**
 * The word at `address`, asked in the frame `frame` names (or in none). A
 * rejected request, an empty or unreadable answer moves on to the next query;
 * a `HardwareTimeoutError` is rethrown without trying the rest. When every
 * query failed, the `MemoryReadFailure` names each one's cause.
 */
export async function readWordThroughGdb(
    session: vscode.DebugSession,
    address: string,
    frame: FrameArg,
    budgetMs: number,
): Promise<number> {
    const queries = session.type === CMSIS_DEBUGGER_TYPE ? CDT_QUERIES : MI_ENGINE_QUERIES;
    const attempts: ReadAttempt[] = [];
    for (const query of queries) {
        let word: number | undefined;
        try {
            const reply = await customRequestWithTimeout<EvaluateBody | undefined>(session, 'evaluate',
                { expression: query.expressionFor(address), context: query.context, ...frame }, budgetMs);
            const answer = reply?.result;
            word = typeof answer === 'string' ? query.parse(answer, address) : undefined;
            if (word === undefined) {
                attempts.push({ strategy: query.strategy, cause: unreadableReply(answer) });
            }
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                throw err;
            }
            attempts.push({ strategy: query.strategy, cause: messageOf(err) });
        }
        if (word !== undefined) {
            return word;
        }
    }
    throw new MemoryReadFailure(address, attempts);
}

/**
 * Read DHCSR once, 4 bytes through DAP `readMemory` within at most 1 s: does
 * the debug port answer? On the CMSIS Debugger the session tracker keeps the
 * verdict for `get_session_status` (`noteCoreVerdict`). Never rejects.
 */
export async function probeDebugPort(session: vscode.DebugSession, budgetMs: number): Promise<DebugPortProbe> {
    const probe = await readDhcsr(session, budgetMs);
    if (session.type === CMSIS_DEBUGGER_TYPE) {
        noteCoreVerdict(session, coreVerdict(probe));
    }
    return probe;
}

/** `probeDebugPort` without the verdict kept. */
async function readDhcsr(session: vscode.DebugSession, budgetMs: number): Promise<DebugPortProbe> {
    try {
        const reply = await customRequestWithTimeout<ReadMemoryBody | undefined>(session, 'readMemory',
            { memoryReference: DHCSR_ADDRESS, count: 4 }, Math.min(budgetMs, CANARY_MS));
        const bytes = reply?.data ? Buffer.from(reply.data, 'base64') : undefined;
        if (bytes && bytes.length >= 4) {
            return { readable: true, dhcsr: bytes.readUInt32LE(0) };
        }
        return { readable: false, timedOut: false, cause: bytes ? `short reply (${bytes.length} of 4 bytes)` : 'no data in the reply' };
    } catch (err) {
        return { readable: false, timedOut: err instanceof HardwareTimeoutError, cause: messageOf(err) };
    }
}

/**
 * What a failed read of `address` is to be thrown as. On the CMSIS Debugger a
 * `MemoryReadFailure` or a `HardwareTimeoutError` is followed by one DHCSR
 * read and becomes `PROBE_WEDGED` or `INVALID_ARGUMENT` — a timeout on a port
 * that answers stays the timeout. Other errors, and every error on other
 * adapters, are returned as they are.
 */
export async function explainReadFailure(session: vscode.DebugSession, address: string, caught: unknown, budgetMs: number): Promise<unknown> {
    const timedOut = caught instanceof HardwareTimeoutError;
    if (session.type !== CMSIS_DEBUGGER_TYPE || (!timedOut && !(caught instanceof MemoryReadFailure))) {
        return caught;
    }
    const attempts = caught instanceof MemoryReadFailure
        ? caught.attempts
        : [{ strategy: (caught as HardwareTimeoutError).operation, cause: `timed out after ${(caught as HardwareTimeoutError).timeoutMs} ms` }];
    const failedAt = caught instanceof MemoryReadFailure ? caught.address : address;
    const probe = await probeDebugPort(session, budgetMs);
    const request = typeof session.configuration?.request === 'string' ? session.configuration.request : undefined;
    return classifyReadFailure({ address: failedAt, attempts, timedOut, probe, request }) ?? caught;
}

/**
 * A GDB number with anything after it: hex when it starts with `0x`/`0X`,
 * decimal otherwise, and neither masked nor sign-checked (KB15).
 */
function leadingInteger(result: string): number | undefined {
    const text = result.trim();
    const value = /^0x/i.test(text) ? parseInt(text, 16) : parseInt(text, 10);
    return Number.isNaN(value) ? undefined : value;
}

/** `x/1xw` answers `0x20000000:\t0x12345678`: the word is the hex literal right after a colon. */
function hexAfterColon(result: string): number | undefined {
    const hit = /:\s*(0x[0-9a-fA-F]+)/.exec(result);
    return hit ? parseInt(hit[1], 16) : undefined;
}

/** `print/x` answers `$1 = 0x12345678`: the word is the first hex literal. */
function firstHexLiteral(result: string): number | undefined {
    const hit = /0x[0-9a-fA-F]+/.exec(result);
    return hit ? parseInt(hit[0], 16) : undefined;
}

/** `-data-read-memory-bytes` answers the bytes as hex text: the word is the first four, little-endian. */
function wordFromMiReply(result: string, address: string): number | undefined {
    const bytes = bytesFromMiMemoryReply(result, address);
    return bytes && bytes.length >= 4 ? bytes.readUInt32LE(0) : undefined;
}
