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
 * The dispatch seam for the documentation and build-artefact tools — the
 * pack-docs counterpart of `SerialDispatch`.
 *
 * Single window: `localPackDocsDispatch` calls the two handlers directly.
 * Multi-window: the router forwards the op name over the control server and
 * the worker's `ControlServer` picks the handler by the same op table, so a
 * documentation lookup runs in the window that owns the workspace (its
 * cbuild-run files, its `docs/` folder) exactly like a debug or serial op.
 */

import { PackDocsOpName, isKnowledgeOp, isPackDocsDocOp } from './core/opTable';
import { ToolError, ToolText } from './core/toolResult';
import type { PackDocsHandler } from './packDocsHandler';
import type { BuildInfoHandler } from './buildInfoHandler';
import type { KnowledgeHandler } from './knowledgeHandler';

/** The two handlers one window owns; built by the extension, lazy until called. */
export interface PackDocsHandlers {
    docs: PackDocsHandler;
    build: BuildInfoHandler;
    /** The experimental knowledge tools; absent where a window is built without them (tests). */
    knowledge?: KnowledgeHandler;
}

/** Runs one documentation or build-artefact op: a text, or a reply with a status; a failure rejects. */
export type PackDocsDispatch = (op: PackDocsOpName, args?: unknown) => Promise<ToolText>;

/** Single-window dispatch: straight to this window's handlers. */
export function localPackDocsDispatch(handlers: PackDocsHandlers): PackDocsDispatch {
    return (op, args) => {
        const owner = isKnowledgeOp(op) ? handlers.knowledge : isPackDocsDocOp(op) ? handlers.docs : handlers.build;
        if (owner === undefined) {
            return Promise.reject(new ToolError('TOOL_DISABLED', `Pack docs op ${op}: the knowledge handler is not available in this window`));
        }
        const target = owner as unknown as Record<string, unknown>;
        const method = target[op];
        if (typeof method !== 'function') {
            return Promise.reject(new Error(`Pack docs op ${op} is not implemented`));
        }
        return Promise.resolve((method as (a?: unknown) => Promise<ToolText>).call(owner, args));
    };
}
