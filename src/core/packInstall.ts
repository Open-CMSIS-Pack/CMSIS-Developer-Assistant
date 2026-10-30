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
 * What `cmsis_action install_pack` decides without VS Code: the pack the
 * agent names, the licence the pack declares, the knowledge it ships, and
 * the texts of its results.
 *
 * - The pack is `Vendor::Name@version`, the version required: the agent
 *   installs the version identification verified, never `latest`. The
 *   CMSIS Solution extension checks the same (a valid semver) but answers a
 *   bad id with nothing; here it is refused with the reason.
 * - The licence comes from the PDSC cpackget keeps in the pack root's
 *   `.Web/` (`<Vendor>.<Name>.pdsc`, the PDSC of the newest release): its
 *   `<license>` names the file cpackget would ask about, which
 *   `cpackget add -a` accepts without asking.
 * - The knowledge is the pack's `.knowledge/knowledge.db`; the count comes
 *   from its `info` table (`units`), else from the units themselves.
 *
 * File access, no `vscode` import.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PACK_INDEX } from './knowledge/packIndexes';
import { KnowledgeIndex } from './knowledge/store';
import { firstChild, parseXml } from './packDocs/xmlLite';
import { ToolError } from './toolResult';

/** The command of the CMSIS Solution extension that installs a pack (hidden from the palette). */
export const INSTALL_PACK_COMMAND = 'cmsis-csolution.installPack';
/** The first CMSIS Solution release known to have that command. */
export const INSTALL_PACK_SINCE = '1.72.0';
/** Where the CMSIS Solution extension writes cpackget's output. */
export const SOLUTION_OUTPUT_CHANNEL = 'CMSIS Solution';

/** A pack the agent asked for: all three parts present. */
export interface PackRequest {
    vendor: string;
    name: string;
    version: string;
}

/** Vendor and name as the pack index spells them. */
const PACK_NAME_PART = /^[A-Za-z0-9_-]+$/;
/** A semantic version without a leading `v`: what the CMSIS Solution extension accepts and cpackget installs. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const USAGE = 'Pass pack: \'Vendor::Name@version\' with the exact version identification verified, e.g. \'ARM::CMSIS@6.1.0\'.';

/** `Vendor::Name@version`. */
export function formatPackRequest(pack: PackRequest): string {
    return `${pack.vendor}::${pack.name}@${pack.version}`;
}

/** The knowledge entity of a pack, the one its units are scoped to. */
export function packEntityId(pack: PackRequest): string {
    return `pack:${pack.vendor}::${pack.name}`;
}

/** The pack `given` names; a missing, malformed or unversioned id is `INVALID_ARGUMENT`. */
export function parsePackRequest(given: unknown): PackRequest {
    const refuse = (why: string): ToolError => new ToolError('INVALID_ARGUMENT', `CMSIS 'install_pack' not attempted: ${why}`, USAGE);
    if (typeof given !== 'string' || given.trim().length === 0) {
        throw refuse('no pack given.');
    }
    const wanted = given.trim();
    const parts = /^([^:@]*)::([^:@]*)(?:@(.*))?$/.exec(wanted);
    if (!parts || !PACK_NAME_PART.test(parts[1]) || !PACK_NAME_PART.test(parts[2])) {
        throw refuse(`'${wanted}' is not a pack id of the form Vendor::Name@version (letters, digits, - and _ in vendor and name).`);
    }
    const [, vendor, name, version] = parts;
    if (version === undefined || version.length === 0) {
        throw refuse(`'${wanted}' names no version. install_pack installs one exact version, never the latest.`);
    }
    if (!SEMVER.test(version)) {
        throw refuse(`'${version}' is not a version of the form major.minor.patch.`);
    }
    return { vendor, name, version };
}

/** `<packRoot>/<Vendor>/<Name>/<version>`, where cpackget installs the pack. */
export function packFolder(packRoot: string, pack: PackRequest): string {
    return path.join(packRoot, pack.vendor, pack.name, pack.version);
}

/**
 * Whether any version of the pack `vendor::name` is installed under
 * `packRoot`: a version folder that holds its `<Vendor>.<Name>.pdsc`.
 * Undefined when the pack root itself is not a folder that can be read.
 */
export function packInstalledIn(packRoot: string, vendor: string, name: string): boolean | undefined {
    try {
        if (!fs.statSync(packRoot).isDirectory()) {
            return undefined;
        }
    } catch {
        return undefined;
    }
    const folder = path.join(packRoot, vendor, name);
    let versions: string[];
    try {
        versions = fs.readdirSync(folder);
    } catch {
        return false;
    }
    return versions.some((version) => fs.existsSync(path.join(folder, version, `${vendor}.${name}.pdsc`)));
}

/** What the pack's PDSC in `.Web/` says about a licence. */
export type LicenceCheck =
    /** The PDSC names a licence file: the user is asked. */
    | { kind: 'declared'; file: string; pdsc: string }
    /** The PDSC names none. */
    | { kind: 'none'; pdsc: string }
    /** No PDSC to read, or one that could not be read: installed without asking, and the result says so. */
    | { kind: 'unchecked'; reason: string };

/** The PDSC of the pack in `<packRoot>/.Web/`: `Vendor.Name.pdsc` as it is spelled there, matched without regard to case when the exact name is missing. */
function webPdscOf(packRoot: string, pack: PackRequest): string | undefined {
    const web = path.join(packRoot, '.Web');
    let entries: string[];
    try {
        entries = fs.readdirSync(web);
    } catch {
        return undefined; // no .Web folder
    }
    const wanted = `${pack.vendor}.${pack.name}.pdsc`;
    const found = entries.find((entry) => entry === wanted) ?? entries.find((entry) => entry.toLowerCase() === wanted.toLowerCase());
    return found === undefined ? undefined : path.join(web, found);
}

/**
 * The licence the pack declares, from its PDSC in the pack root's `.Web/`:
 * the text of the `<license>` element of `<package>`, which cpackget asks
 * about. The `<license>` entries of `<licenseSets>` are not that element.
 */
export function checkLicence(packRoot: string, pack: PackRequest): LicenceCheck {
    const pdsc = webPdscOf(packRoot, pack);
    if (pdsc === undefined) {
        return { kind: 'unchecked', reason: `${path.join(packRoot, '.Web')} has no ${pack.vendor}.${pack.name}.pdsc` };
    }
    try {
        const file = firstChild(parseXml(fs.readFileSync(pdsc, 'utf8')), 'license')?.text.trim() ?? '';
        return file.length > 0 ? { kind: 'declared', file, pdsc } : { kind: 'none', pdsc };
    } catch (caught) {
        return { kind: 'unchecked', reason: `${pdsc} could not be read (${caught instanceof Error ? caught.message : String(caught)})` };
    }
}

/** The modal that asks the user before a pack with a licence is installed. */
export function licenceQuestion(pack: PackRequest, licenceFile: string, folder: string): { message: string; detail: string } {
    const id = formatPackRequest(pack);
    return {
        message: `Install the CMSIS pack ${id}?`,
        detail: `An agent asked to install ${id} through the CMSIS Developer Assistant. The pack declares a licence in its file `
            + `'${licenceFile}'. Install agrees to that licence for you, as cpackget --agree-embedded-license does; the file is in `
            + `${folder} after the install.`,
    };
}

/** The line of the result that names the pack's knowledge, or undefined when it ships none. */
export function knowledgeLine(folder: string, pack: PackRequest): { line: string; units?: number } | undefined {
    const file = path.join(folder, PACK_INDEX);
    if (!fs.existsSync(file)) {
        return undefined;
    }
    const expand = `knowledge_expand {id: "${packEntityId(pack)}", relation: "scoped_to"}`;
    let index: KnowledgeIndex | undefined;
    try {
        index = new KnowledgeIndex(file);
        const recorded = Number.parseInt(index.info.units ?? '', 10);
        const units = Number.isFinite(recorded) && recorded >= 0 ? recorded : index.unitCount();
        if (units === 0) {
            return { line: `Its knowledge index ${file} holds no units.`, units };
        }
        return { line: `It ships ${units} knowledge unit${units === 1 ? '' : 's'}: ${expand}`, units };
    } catch (caught) {
        const reason = caught instanceof Error ? caught.message : String(caught);
        return { line: `It ships a knowledge index that could not be read (${reason}).` };
    } finally {
        index?.close();
    }
}

/** The result line about the licence: what the user accepted, or that it was not checked. */
export function licenceLine(check: LicenceCheck): string | undefined {
    if (check.kind === 'declared') {
        return `The user accepted its licence (${check.file}) in VS Code.`;
    }
    if (check.kind === 'unchecked') {
        return `Its licence was not checked before the install: ${check.reason}, and cpackget accepted any licence the pack embeds. `
            + 'Tell the user.';
    }
    return undefined;
}

/** Where cpackget's own lines are, and what the extension runs. */
export const INSTALL_FAILURE_HINT = `The "${SOLUTION_OUTPUT_CHANNEL}" output channel (View → Output) has cpackget's lines. `
    + 'The CMSIS Solution extension runs the cpackget on VS Code\'s PATH, not the copy it bundles for builds. '
    + 'Do not run cpackget yourself; tell the user what the channel says.';

/** The failure of an install the command answered without a folder, or rejected. */
export function installFailure(pack: PackRequest, cause: string, leftover: string | undefined): ToolError {
    const there = leftover !== undefined ? ` ${leftover} exists, perhaps from an earlier install.` : '';
    return new ToolError('TASK_FAILED',
        `CMSIS 'install_pack' failed: the CMSIS Solution extension did not install ${formatPackRequest(pack)} (${cause}).${there}`,
        INSTALL_FAILURE_HINT);
}

/** The failure of an install the command reported done, while its folder is missing. */
export function missingFolderFailure(pack: PackRequest, folder: string): ToolError {
    return new ToolError('TASK_FAILED',
        `CMSIS 'install_pack' failed: ${INSTALL_PACK_COMMAND} reported ${folder} for ${formatPackRequest(pack)}, but that folder does not exist.`,
        'The CMSIS Solution extension answers so without running cpackget while the same install still waits in its queue: '
            + `call install_pack again in a moment. ${INSTALL_FAILURE_HINT}`);
}
