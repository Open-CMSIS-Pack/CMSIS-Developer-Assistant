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
 * The handler-level fence around the inspection and CMSIS tools. A call that
 * fails is answered with its `ToolError` (a plain error gets a classified
 * code), and a call that outlives its limit is answered by the cap: a
 * `timeout` reply for the tools that wait for something, a `TIMEOUT` error
 * for the reads, which have no result to show (#11).
 *
 * The limit is capped at 60 s, except for `cmsis_action` and `flash`, whose
 * waits may run to 600 s (#12). Those two answer before their fence, which
 * stays as a backstop with advice of their own.
 */

import { ToolError, ToolText, toToolError } from '../core/toolResult';
import type { HandlerHost } from './host';

/** The limit when the caller passes no positive `timeoutMs`. */
const UNSPECIFIED_LIMIT_MS = 30_000;
/** The most any single call may ask for. */
const LIMIT_CAP_MS = 60_000;
/** The most `cmsis_action` and `flash` may ask for (#12). */
export const LONG_LIMIT_CAP_MS = 600_000;

/**
 * What the cap answers: `reply` for tools that wait (the wait ran out, which
 * is not a failure), `error` for reads (no data came back).
 */
export type CapOutcome = 'reply' | 'error';

/** What a caught value says: an Error's message, anything else as a string. */
export function failureText(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/** The limit for a tool call's `timeoutMs`: clamped to `capMs` when positive, else the 30 s default. */
export function fenceLimitMs(timeoutMs: number | undefined, capMs: number = LIMIT_CAP_MS): number {
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        return Math.min(timeoutMs, capMs);
    }
    return UNSPECIFIED_LIMIT_MS;
}

function overrunStatement(label: string, limitMs: number): string {
    return `'${label}' did not complete within ${limitMs} ms (handler-level cap).`;
}

const OVERRUN_ADVICE = 'The DAP probe or target may be unresponsive — call get_session_status / check_target_connection to confirm. '
    + 'Note: the underlying request may still be running on the server; consider restart_debugging if subsequent calls also stall.';

/**
 * A cap other than 60 s, what the cap's answer advises instead of the DAP
 * text, and the status of a `reply` cap: `timeout` (the wait ran out), or
 * `running` for a call whose work goes on and is answered by a repeat of the
 * same call, as `cmsis_query` while the catalog loads.
 */
export interface FenceOptions {
    capMs?: number;
    advice?: string;
    capStatus?: 'timeout' | 'running';
}

/**
 * Race `body` against the limit for `timeoutMs`. A failing body rejects with
 * its `ToolError`; the cap resolves with a `timeout` reply (or a `running`
 * one, `options.capStatus`) or rejects with a `TIMEOUT` error, as `onCap`
 * says.
 *
 * The timer is armed before the body starts, so a body whose own wait is as
 * long as the fence loses the tie. A body that loses keeps running — a DAP
 * request cannot be withdrawn — and whatever it produces later, a rejection
 * included, is dropped.
 */
export async function fenced(
    label: string,
    timeoutMs: number | undefined,
    timers: Pick<HandlerHost, 'startTimer'>,
    body: () => Promise<ToolText>,
    onCap: CapOutcome,
    options: FenceOptions = {},
): Promise<ToolText> {
    const limitMs = fenceLimitMs(timeoutMs, options.capMs);
    const advice = options.advice ?? OVERRUN_ADVICE;
    let disarm: () => void = () => undefined;
    const expiry = new Promise<ToolText>((settle, fail) => {
        disarm = timers.startTimer(limitMs, () => {
            if (onCap === 'reply') {
                settle({ text: `${overrunStatement(label, limitMs)} ${advice}`, status: options.capStatus ?? 'timeout' });
            } else {
                fail(new ToolError('TIMEOUT', overrunStatement(label, limitMs), advice));
            }
        });
    });
    const answer = body().then((text) => text, (caught: unknown) => {
        throw toToolError(caught);
    });
    // A second observer: once the cap has won, the race no longer waits for the body.
    answer.catch(() => undefined);
    try {
        return await Promise.race([answer, expiry]);
    } finally {
        disarm();
    }
}
