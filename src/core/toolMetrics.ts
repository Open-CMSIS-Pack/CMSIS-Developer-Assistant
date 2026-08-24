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
 * Per-tool call statistics for one MCP server.
 *
 * Pure: no vscode, no I/O. The server records one sample per tool call at the
 * MCP boundary — what the agent actually sent and received, after redaction —
 * so that "the agent looped on X" and "that response was huge" become numbers
 * instead of anecdotes. Samples are kept in a bounded ring; totals are
 * aggregated as samples arrive so reading them costs nothing.
 */

export type ToolOutcome = 'ok' | 'timeout' | 'error';

export interface ToolSample {
    tool: string;
    /** Serialized argument bytes; 0 for tools without input. */
    argBytes: number;
    /** Serialized result bytes as handed to the transport. */
    resultBytes: number;
    /** Wall time of the call as the client experiences it. */
    ms: number;
    outcome: ToolOutcome;
    /** Epoch milliseconds when the call finished. */
    at: number;
    sessionId?: string;
}

export interface PerToolTotals {
    calls: number;
    ms: number;
    bytesOut: number;
    timeouts: number;
    errors: number;
}

export interface ToolTotals {
    calls: number;
    timeouts: number;
    errors: number;
    bytesIn: number;
    bytesOut: number;
    ms: number;
    perTool: Record<string, PerToolTotals>;
}

/**
 * Handlers fence their work and return the timeout as *text* rather than
 * throwing (see withHandlerTimeout and the motion tools' "did not complete"
 * trailer), so a timeout has to be recognised from the result.
 */
const TIMEOUT_MARKERS: readonly RegExp[] = [
    /did not complete within/i,
    /\bHardwareTimeoutError\b/,
    /timed out after/i,
];

/** withHandlerTimeout converts a thrown error into this prefix. */
const ERROR_MARKERS: readonly RegExp[] = [/^Error in '/m];

export function classifyOutcome(text: string, isError = false): ToolOutcome {
    if (isError) { return 'error'; }
    if (TIMEOUT_MARKERS.some((re) => re.test(text))) { return 'timeout'; }
    if (ERROR_MARKERS.some((re) => re.test(text))) { return 'error'; }
    return 'ok';
}

export function formatBytes(n: number): string {
    if (n < 1024) { return `${n} B`; }
    if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} kB`; }
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function emptyTotals(): ToolTotals {
    return { calls: 0, timeouts: 0, errors: 0, bytesIn: 0, bytesOut: 0, ms: 0, perTool: {} };
}

export class ToolMetrics {
    private readonly ring: ToolSample[] = [];
    private readonly running: ToolTotals = emptyTotals();

    /**
     * @param ringSize how many recent samples to keep; totals count every call regardless.
     * @param onSample invoked after each sample is recorded (aggregation, logging, sinks).
     */
    constructor(
        private readonly ringSize: number = 200,
        private readonly onSample?: (sample: ToolSample) => void,
    ) {}

    public record(sample: ToolSample): void {
        this.ring.push(sample);
        if (this.ring.length > this.ringSize) {
            this.ring.splice(0, this.ring.length - this.ringSize);
        }

        const t = this.running;
        t.calls += 1;
        t.bytesIn += sample.argBytes;
        t.bytesOut += sample.resultBytes;
        t.ms += sample.ms;
        if (sample.outcome === 'timeout') { t.timeouts += 1; }
        if (sample.outcome === 'error') { t.errors += 1; }

        const per = t.perTool[sample.tool] ?? (t.perTool[sample.tool] = { calls: 0, ms: 0, bytesOut: 0, timeouts: 0, errors: 0 });
        per.calls += 1;
        per.ms += sample.ms;
        per.bytesOut += sample.resultBytes;
        if (sample.outcome === 'timeout') { per.timeouts += 1; }
        if (sample.outcome === 'error') { per.errors += 1; }

        this.onSample?.(sample);
    }

    /** The most recent samples, oldest first. */
    public samples(): ToolSample[] {
        return this.ring.slice();
    }

    /** A snapshot; safe to serialize or mutate. */
    public totals(): ToolTotals {
        const perTool: Record<string, PerToolTotals> = {};
        for (const [tool, per] of Object.entries(this.running.perTool)) {
            perTool[tool] = { ...per };
        }
        return { ...this.running, perTool };
    }

    /**
     * Two lines for a human or an agent: the session's totals and the tools
     * that returned the most bytes. Appended to get_session_status.
     */
    public formatTotals(label = 'this session'): string {
        const t = this.running;
        if (t.calls === 0) {
            return `Tool stats (${label}): no tool calls recorded yet.`;
        }
        const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const head = `Tool stats (${label}): ${plural(t.calls, 'call')} · ${formatBytes(t.bytesOut)} returned · ` +
            `${(t.ms / 1000).toFixed(1)} s in tools · ${plural(t.timeouts, 'timeout')} · ${plural(t.errors, 'error')}`;
        const largest = Object.entries(t.perTool)
            .sort((a, b) => b[1].bytesOut - a[1].bytesOut)
            .slice(0, 3)
            .map(([tool, per]) => `${tool} ${formatBytes(per.bytesOut)} over ${plural(per.calls, 'call')}`)
            .join(' · ');
        return `${head}\n  largest: ${largest}`;
    }
}
