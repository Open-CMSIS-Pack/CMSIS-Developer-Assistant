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
 * The seam between the pure build-info core and its host — this extension
 * today, the CMSIS Developer Assistant after the merge. Nothing under
 * `core/buildInfo/` imports `vscode`; file discovery, settings and the log
 * arrive through this interface. The log has the same four methods as the
 * pack-docs one so both subsystems share the output channel.
 */

import { PackDocsLog, prefixedLog, silentLog } from '../packDocs/host';
import { ActiveContextHint } from '../packDocs/cbuildRun';

export type BuildInfoLog = PackDocsLog;

export interface BuildInfoSettings {
    /** Symbols and objects listed by get_memory_usage / get_section_layout (`top` overrides per call). */
    maxSymbols: number;
    /** Workspace-relative globs searched for build logs, newest first. */
    logGlobs: string[];
}

export interface BuildInfoHost {
    /** Absolute paths of the open workspace folders (empty when none). */
    workspaceFolders(): string[];
    /**
     * Files matching a workspace-relative glob (`**\/*.cbuild-run.yml`), absolute
     * paths. The extension backs it with `vscode.workspace.findFiles`; tests and
     * the smoke client walk the directory (`walkGlob`).
     */
    findFiles(glob: string): Promise<string[]>;
    settings(): BuildInfoSettings;
    log: BuildInfoLog;
    /** The active csolution / target-type, when the host can ask — picks one of several cbuild-run contexts. */
    activeContext?(): Promise<ActiveContextHint | undefined>;
}

export const defaultBuildInfoSettings: BuildInfoSettings = {
    maxSymbols: 20,
    logGlobs: ['**/out/**/*.log', '**/build*.log'],
};

export { prefixedLog, silentLog };
