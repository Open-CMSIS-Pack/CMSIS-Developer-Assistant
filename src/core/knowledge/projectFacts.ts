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
 * What a knowledge search knows about the project without being told: the
 * device, board and packs of the active `*.cbuild-run.yml`, the cores from
 * the device pack's PDSC on disk (in the folder the CMSIS Solution extension
 * names for it when there is one, else under the pack root), the compiler, the components and the
 * other packs from the cbuild files. The documentation and build-artefact cores already resolve
 * all of it; this module only puts their answers together.
 *
 * It never throws: a workspace without a build has no facts, and the search
 * runs without a filter. No `vscode` import.
 */

import * as fs from 'fs';
import { resolveBuildContext } from '../buildInfo/artifacts';
import type { BuildInfoHost } from '../buildInfo/host';
import { formatPackId } from '../packDocs/cbuildRun';
import type { PackDocsHost } from '../packDocs/host';
import { collectProcessors, findPdscFile, loadPdsc } from '../packDocs/pdscBooks';
import { locatePack, resolveTarget } from '../packDocs/targetDocs';
import type { ProjectFacts } from './search';

/** The facts, or why there are none. */
export interface ProjectFactsResult {
    facts?: ProjectFacts;
    /** One line for the reply: why the search ran without a project, or what is missing. */
    note?: string;
}

/** `    - component: ARM::CMSIS:CORE@6.1.0` lines of a cbuild.yml. */
export function componentsOf(cbuildYml: string): string[] {
    const found: string[] = [];
    for (const line of cbuildYml.split(/\r?\n/)) {
        const match = line.match(/^\s+- component:\s*(.+?)\s*$/);
        if (match) {
            found.push(match[1].replace(/^["']|["']$/g, ''));
        }
    }
    return found;
}

/** `    - pack: ARM::CMSIS@6.1.0` lines of a cbuild.yml, as `ARM::CMSIS`. */
export function packsOf(cbuildYml: string): string[] {
    const found: string[] = [];
    for (const line of cbuildYml.split(/\r?\n/)) {
        const match = line.match(/^\s+- pack:\s*(.+?)\s*$/);
        if (match) {
            found.push(match[1].replace(/^["']|["']$/g, '').replace(/@.*$/, ''));
        }
    }
    return found;
}

function firstLine(value: string): string {
    return value.split('\n', 1)[0];
}

/** The facts of the window's active target. */
export async function projectFacts(docs: PackDocsHost, build: BuildInfoHost): Promise<ProjectFactsResult> {
    try {
        if (docs.workspaceFolders().length === 0) {
            return { note: 'no folder is open' };
        }
        const target = await resolveTarget(docs, {});
        if ('error' in target) {
            return { note: firstLine(target.error) };
        }
        const facts: ProjectFacts = {};
        if (target.device) {
            facts.device = target.device.name;
        }
        if (target.board) {
            facts.board = target.board.vendor ? `${target.board.vendor}::${target.board.name}` : target.board.name;
        }
        const packs = [target.devicePack, target.boardPack].filter((pack) => pack !== undefined);
        facts.packs = [...new Set(packs.map((pack) => formatPackId({ vendor: pack.vendor, name: pack.name })))];

        let note: string | undefined;
        if (target.devicePack) {
            const notes: string[] = [];
            const located = locatePack(target.packRoot, target.devicePack, notes, target.packDirs?.devicePack);
            const pdsc = located ? findPdscFile(located.dir, located.id) : undefined;
            if (located && pdsc) {
                facts.cores = [...new Set(collectProcessors(loadPdsc(pdsc, located.id, docs.log), target.device?.name).map((p) => p.core))];
            }
            if (!facts.cores?.length) {
                note = `the core of ${facts.device ?? 'the device'} is not known (${notes[0] ?? 'the device pack names none'})`;
            }
        }

        const context = await resolveBuildContext(build, {});
        if (!('error' in context)) {
            facts.compiler = context.compiler;
            const components = new Set<string>();
            const packs = new Set(facts.packs);
            for (const image of context.images) {
                if (image.cbuildYml && fs.existsSync(image.cbuildYml)) {
                    const yml = fs.readFileSync(image.cbuildYml, 'utf-8');
                    componentsOf(yml).forEach((c) => components.add(c));
                    packsOf(yml).forEach((pack) => packs.add(pack));
                }
                facts.compiler ??= image.compiler;
            }
            facts.components = [...components];
            facts.packs = [...packs];
        }
        return { facts, ...(note ? { note } : {}) };
    } catch (caught) {
        docs.log.debug(`knowledge: no project facts: ${caught instanceof Error ? caught.message : String(caught)}`);
        return { note: 'the project could not be read' };
    }
}

/** `STM32U585AIIx, Cortex-M33, GCC`: the facts as a reply names them. */
export function describeFacts(facts: ProjectFacts): string {
    const compiler = facts.compiler?.replace(/@.*$/, '');
    return [facts.device ?? facts.board, ...(facts.cores ?? []), compiler]
        .filter((part): part is string => typeof part === 'string' && part.length > 0).join(', ');
}
