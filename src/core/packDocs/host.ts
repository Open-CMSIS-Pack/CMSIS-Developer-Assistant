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
 * The seam between the pure pack-docs core and whatever hosts it: this
 * extension today, the CMSIS Developer Assistant after the merge. Nothing
 * under `core/packDocs/` imports `vscode`; everything it needs from the
 * host arrives through this interface.
 */

import { ActiveContextHint } from './cbuildRun';

export interface PackDocsLog {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}

export interface PackDocsSettings {
    /** `auto` picks pdftotext when it is on PATH. */
    extractor: 'auto' | 'pdftotext';
    /** Executable name or absolute path. */
    pdftotextPath: string;
    /** PDFs above this size are listed but never extracted. */
    maxPdfMb: number;
    /** Also report PDFs inside the pack that no `<book>` references. */
    includeUnlisted: boolean;
    /**
     * Folders, relative to each workspace folder, whose PDFs are listed and
     * searched with the target's documents — where the bring-up skills ask
     * the user to drop documents they could not fetch.
     */
    workspaceDocDirs: string[];
    /**
     * The user documents folder — manuals obtained outside the packs (under
     * NDA, from a vendor portal), kept outside any workspace and attributed
     * to packs/devices/boards/cores by sub-folder. Empty: `~/.cmsis-pack-docs/user`.
     */
    userDocsDir: string;
}

export interface PackDocsHost {
    /** `$CMSIS_PACK_ROOT`, else `~/.cache/arm/packs`. */
    packRoot: string;
    /** Where page text, metadata and indexes are cached (globalStorage/packdocs). */
    storageDir: string;
    /** The extension's `assets` directory (shipped core-peripheral SVDs under `svd/core`); absent in some tests. */
    assetsDir?: string;
    /** Every `*.cbuild-run.yml` in the workspace (solution root or out/). */
    findCbuildRunFiles(): Promise<string[]>;
    /** Absolute paths of the open workspace folders (empty when none). */
    workspaceFolders(): string[];
    /** Sent with every request `fetch_doc` makes, e.g. `cmsis-pack-docs/0.3.0`. */
    userAgent: string;
    /** Injected by tests; defaults to the global `fetch`. */
    fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
    settings(): PackDocsSettings;
    log: PackDocsLog;
    /**
     * The csolution and target-type the CMSIS Solution panel has active, when
     * the host can ask (the VS Code extension does). Picks one cbuild-run
     * context when the workspace holds several solutions; absent or
     * undefined leaves the choice to `target` / the caller.
     */
    activeContext?(): Promise<ActiveContextHint | undefined>;
}

export const silentLog: PackDocsLog = {
    debug: () => { /* silent */ },
    info: () => { /* silent */ },
    warn: () => { /* silent */ },
    error: () => { /* silent */ },
};

export const defaultSettings: PackDocsSettings = {
    extractor: 'auto',
    pdftotextPath: 'pdftotext',
    maxPdfMb: 150,
    includeUnlisted: true,
    workspaceDocDirs: ['.agent-artifacts/docs', 'docs'],
    userDocsDir: '',
};

/** A log that prefixes every line, for the per-tool traces in the output channel. */
export function prefixedLog(log: PackDocsLog, prefix: string): PackDocsLog {
    return {
        debug: (m) => log.debug(`${prefix} ${m}`),
        info: (m) => log.info(`${prefix} ${m}`),
        warn: (m) => log.warn(`${prefix} ${m}`),
        error: (m, e) => log.error(`${prefix} ${m}`, e),
    };
}
