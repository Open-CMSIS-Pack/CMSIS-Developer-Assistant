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

/**
 * Error thrown when a hardware-facing operation exceeds its deadline.
 *
 * On embedded targets this typically means the probe/GDB server has stalled,
 * the target is running (DAP requests are only valid while stopped), or the
 * USB link has dropped. Callers should treat this as a recoverable but
 * user-visible condition — never as a silent success.
 */
export class HardwareTimeoutError extends Error {
    public readonly timeoutMs: number;
    public readonly operation: string;

    constructor(operation: string, timeoutMs: number, cause?: unknown) {
        const causeMsg = cause ? ` (cause: ${String(cause)})` : '';
        super(
            `Hardware operation '${operation}' timed out after ${timeoutMs}ms. ` +
            `The debug probe or target may be unresponsive — check the physical connection, ` +
            `reset the target, or restart the debug session.${causeMsg}`
        );
        this.name = 'HardwareTimeoutError';
        this.timeoutMs = timeoutMs;
        this.operation = operation;
    }
}

/**
 * Race a promise against a timeout. When the timeout expires the returned
 * promise rejects with {@link HardwareTimeoutError}. The underlying promise
 * is left to settle on its own (we cannot cancel a DAP request mid-flight),
 * but callers regain control and can report the failure.
 */
export async function withTimeout<T>(
    operation: string,
    timeoutMs: number,
    task: Promise<T> | (() => Promise<T>),
): Promise<T> {
    const promise = typeof task === 'function' ? task() : task;

    if (timeoutMs <= 0) {
        return promise;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new HardwareTimeoutError(operation, timeoutMs));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * Wrapper for `vscode.DebugSession.customRequest` that enforces a deadline.
 * All DAP traffic to an embedded target must go through this helper so that
 * a hung probe cannot block the MCP tool invocation indefinitely.
 */
export async function customRequestWithTimeout<T = unknown>(
    session: vscode.DebugSession,
    command: string,
    args: Record<string, unknown> | undefined,
    timeoutMs: number,
): Promise<T> {
    return withTimeout(
        `DAP ${command}`,
        timeoutMs,
        session.customRequest(command, args) as Promise<T>,
    );
}
