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
 * The few lines of a `*.cbuild-run.yml` that identify the target's packs:
 *
 *   cbuild-run:
 *     solution: TFLiteRT_HelloWorld.csolution.yml
 *     target-type: STM32F756ZGTx
 *     device: STMicroelectronics::STM32F756ZGTx
 *     device-pack: Keil::STM32F7xx_DFP@3.0.0
 *     board: STMicroelectronics::NUCLEO-F756ZG:Rev.B
 *     board-pack: Keil::NUCLEO-F756ZG_BSP@2.0.0
 *
 * Read with a line scanner like the CMSIS Developer Assistant's SVD lookup:
 * the file is generated, two-space indented, and the keys are top level.
 */

import * as os from 'os';
import * as path from 'path';

export interface PackId {
    vendor: string;
    name: string;
    version?: string;
}

export interface QualifiedName {
    vendor?: string;
    name: string;
    /** Board revision, e.g. `Rev.B`. */
    revision?: string;
}

export interface CbuildRunInfo {
    file: string;
    solution?: string;
    targetType?: string;
    device?: QualifiedName;
    devicePack?: PackId;
    board?: QualifiedName;
    boardPack?: PackId;
}

/** `Keil::STM32F7xx_DFP@3.0.0` → vendor, name, version. */
export function parsePackId(text: string | undefined): PackId | undefined {
    if (!text) { return undefined; }
    const m = text.trim().match(/^([^:@]+)::([^:@]+)(?:@(.+))?$/);
    if (!m) { return undefined; }
    return { vendor: m[1].trim(), name: m[2].trim(), version: m[3]?.trim() || undefined };
}

export function formatPackId(id: PackId): string {
    return `${id.vendor}::${id.name}${id.version ? `@${id.version}` : ''}`;
}

/** `STMicroelectronics::NUCLEO-F756ZG:Rev.B` → vendor, name, revision; `Alif Semiconductor::AE722F80F55D5LS` keeps the space. */
export function parseQualifiedName(text: string | undefined): QualifiedName | undefined {
    if (!text) { return undefined; }
    const t = text.trim();
    if (!t) { return undefined; }
    const sep = t.indexOf('::');
    const vendor = sep >= 0 ? t.slice(0, sep).trim() : undefined;
    const rest = sep >= 0 ? t.slice(sep + 2) : t;
    const rev = rest.indexOf(':');
    if (rev >= 0) {
        return { vendor, name: rest.slice(0, rev).trim(), revision: rest.slice(rev + 1).trim() || undefined };
    }
    return { vendor, name: rest.trim() };
}

function unquote(value: string): string {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}

export function parseCbuildRun(content: string, file: string): CbuildRunInfo {
    const info: CbuildRunInfo = { file };
    for (const raw of content.split('\n')) {
        // Only the two-space, top-level keys directly under `cbuild-run:`.
        const m = raw.match(/^ {2}([a-z-]+):\s*(.*?)\s*$/);
        if (!m) { continue; }
        const value = unquote(m[2]);
        switch (m[1]) {
            case 'solution': info.solution = value; break;
            case 'target-type': info.targetType = value; break;
            case 'device': info.device = parseQualifiedName(value); break;
            case 'device-pack': info.devicePack = parsePackId(value); break;
            case 'board': info.board = parseQualifiedName(value); break;
            case 'board-pack': info.boardPack = parsePackId(value); break;
            default: break;
        }
    }
    return info;
}

/** `$CMSIS_PACK_ROOT`, else `~/.cache/arm/packs` — the CMSIS-Toolbox default. */
export function defaultPackRoot(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
    const fromEnv = env.CMSIS_PACK_ROOT?.trim();
    return fromEnv ? fromEnv : path.join(home, '.cache', 'arm', 'packs');
}

export function expandPackRoot(filePath: string, packRoot: string): string {
    return filePath.replace(/\$\{CMSIS_PACK_ROOT\}/g, packRoot).replace(/\$CMSIS_PACK_ROOT\b/g, packRoot);
}

/** `<packRoot>/<Vendor>/<Name>/<version>` — the version is required. */
export function packDir(packRoot: string, id: PackId): string | undefined {
    if (!id.version) { return undefined; }
    return path.join(packRoot, id.vendor, id.name, id.version);
}
