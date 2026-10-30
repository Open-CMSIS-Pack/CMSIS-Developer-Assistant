/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * What is known of an MCP client from the name it sent with `initialize`:
 * where it lives, and how it shows a tool result to the model.
 *
 * `open_solution` from a window without a folder may open the folder in that
 * window, which VS Code reloads: a client that runs outside the window (a CLI
 * in a terminal) loses its MCP session for a few seconds and connects again,
 * but a chat that lives inside the window — Copilot Chat, Cline, Roo Code,
 * any editor that hosts the extension — is ended by the reload, mid-turn.
 * So the reload is only for clients known to survive it; everyone else gets
 * a new window, which always works.
 *
 * Some clients hand the model a result's `structuredContent` instead of its
 * text, so every `structuredContent` repeats the text as `message`. A client
 * that shows both then reads every result with data twice; its sessions get
 * the text alone (`TEXT_ONLY_CLIENTS`).
 *
 * Some clients never pass the server's `instructions` to the model, so the
 * tool rules at their top do not arrive (`NO_INSTRUCTIONS_CLIENTS`).
 *
 * Some clients take the loss of the GET stream as the end of the server, so
 * their sessions are offered none (`NO_GET_STREAM_CLIENTS`).
 *
 * Pure: no vscode.
 */

/**
 * Name prefixes of the clients that run outside the VS Code window: the CLIs.
 * Not `kimi-code`: the Kimi Code CLI and its VS Code extension, which lives in
 * the window, share the SDK that sends the name.
 */
const OUTSIDE_THE_WINDOW: readonly string[] = ['claude-code', 'codex', 'gemini'];

/**
 * Names of the clients whose sessions get tool results without
 * `structuredContent`, because they show the model the text and the object
 * serialized after it. The text says everything without the object
 * (`linesMissingFromStructured`), and a failure keeps `isError` and its
 * `[CODE]`. A name matches exactly, in the case the client sends it.
 *
 * - `kimi-code`: Kimi Code, the CLI and the VS Code extension, appends
 *   `structuredContent` to the text as `<mcp-result-extras>` JSON; releases
 *   before 2.0 dropped it (MoonshotAI/kimi-code `agent/mcp/output.ts` at
 *   743f140; 17 KB of 95 KB in a session of September 2026).
 *
 * The GitHub Copilot SDK agent shows both too (a tester's log of
 * 2.7.0-preview3: 635 KB of `structuredContent` on top of 764 KB of text);
 * its exact client name goes here once it is known.
 */
export const TEXT_ONLY_CLIENTS: readonly string[] = ['kimi-code'];

/**
 * Names of the clients that do not hand the server's `instructions` to the
 * model, matched exactly: the first `get_session_status` of their sessions
 * carries the tool rules themselves instead of a line that points at the
 * instructions.
 *
 * - `kimi-code`: Kimi Code's MCP client lists and calls tools and nothing
 *   else (MoonshotAI/kimi-code `mcpCore/types.ts` at 743f140, issue 4142);
 *   the system prompt of a Kimi Code 2.3.2 session holds no line of ours.
 */
export const NO_INSTRUCTIONS_CLIENTS: readonly string[] = ['kimi-code'];

/** Whether a client of this name is one whose model never sees the server instructions. An absent name never is. */
export function dropsInstructions(clientName: string | undefined): boolean {
    return clientName !== undefined && NO_INSTRUCTIONS_CLIENTS.includes(clientName);
}

/**
 * Names of the clients whose sessions are offered no GET stream, matched
 * exactly: their GET gets 405, which the MCP specification provides for a
 * server that offers no stream at the endpoint, and the SDK client then opens
 * none and reports nothing.
 *
 * - `kimi-code`: the stream drops whenever the server restarts (the router
 *   window reloads or closes, another window takes over); the SDK client
 *   retries it twice within about 2.5 s, then reports "Maximum reconnection
 *   attempts (2) exceeded", which Kimi Code takes as final
 *   (`isTerminalTransportError`, MoonshotAI/kimi-code at 743f140). It marks
 *   the server failed, and a session opened or resumed afterwards gets none
 *   of its tools until the window reloads. Without the stream nothing fails:
 *   the first call after a restart gets 404, and Kimi reconnects and retries
 *   it. Kimi ignores what a server sends outside a request (tools/list_changed).
 */
export const NO_GET_STREAM_CLIENTS: readonly string[] = ['kimi-code'];

/** Whether a client of this name gets 405 for a GET stream. An absent name never does. */
export function offersNoGetStream(clientName: string | undefined): boolean {
    return clientName !== undefined && NO_GET_STREAM_CLIENTS.includes(clientName);
}

/**
 * Where a client sets how long it waits for one tool call, by client name,
 * matched exactly: the sentence a cut wait's note adds. Kimi Code ends a call
 * after 60 s unless its server entry has `toolTimeoutMs`, which Configure
 * Agent writes; a hand-written entry often lacks it.
 */
const WAIT_SETTINGS: Readonly<Record<string, string>> = {
    'kimi-code': 'To wait longer, give this server\'s entry in Kimi Code\'s mcp.json a toolTimeoutMs, as Configure Agent writes it: '
        + 'run CMSIS Developer Assistant: Configure Agent, then start a new Kimi session.',
};

/** The sentence that names a client's own wait setting; undefined for a client without one on record. */
export function waitSettingOf(clientName: string | undefined): string | undefined {
    return clientName === undefined ? undefined : WAIT_SETTINGS[clientName];
}

/**
 * Whether a client of this name keeps working while the VS Code window it
 * talks to reloads. Unknown and absent names count as inside the window.
 */
export function survivesWindowReload(clientName: string | undefined): boolean {
    if (!clientName) {
        return false;
    }
    const name = clientName.trim().toLowerCase();
    return OUTSIDE_THE_WINDOW.some((prefix) => name.startsWith(prefix));
}

/**
 * Whether a client of this name gets tool results as text alone: its name is
 * in `textOnly` (`TEXT_ONLY_CLIENTS` unless a test passes another list),
 * exactly. An absent name never is.
 */
export function wantsTextOnly(clientName: string | undefined, textOnly: readonly string[] = TEXT_ONLY_CLIENTS): boolean {
    return clientName !== undefined && textOnly.includes(clientName);
}
