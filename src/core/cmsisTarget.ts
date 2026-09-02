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
 * Pure helpers behind the `target` input of `cmsis_action`: parsing a
 * `type` / `type@set` reference, matching it against what the CMSIS Solution
 * extension reports as active (`cmsis-csolution.getActiveTargetSet`, same
 * format), listing the target-types a csolution declares, and editing the
 * extension's `.vscode/cmsis.json` selection so a re-activated solution comes
 * up on the requested target.
 *
 * The cmsis.json layout mirrors what the CMSIS Solution extension (1.70)
 * writes itself:
 *
 *   { "targetSet": { "<solutionDisplayName>": {
 *         "activeTargetType": "<type>",
 *         "<type>": <index into that type's target-set list>   // optional
 *   } } }
 *
 * where `<solutionDisplayName>` is the csolution path relative to the
 * workspace folder with both extensions stripped, forward slashes.
 *
 * No `vscode` import here so the logic is unit-testable outside the host.
 */

import * as path from 'path';
import { applyEdits, modify } from 'jsonc-parser';

/** A target reference as the agent passes it: `MPS3` or `HP@debug`. */
export interface TargetRef {
    type: string;
    /** Named target-set; undefined = any set of the type, '' = the unnamed set. */
    set?: string;
}

/** One `target-types:` entry of a csolution and the names of its target-sets ('' = unnamed). */
export interface TargetTypeInfo {
    name: string;
    sets: string[];
}

/** Parse `type` or `type@set`; undefined for an empty/invalid reference. */
export function parseTargetRef(text: string | undefined): TargetRef | undefined {
    const trimmed = (text ?? '').trim();
    if (!trimmed) { return undefined; }
    const at = trimmed.indexOf('@');
    if (at < 0) { return { type: trimmed }; }
    const type = trimmed.slice(0, at).trim();
    if (!type) { return undefined; }
    return { type, set: trimmed.slice(at + 1).trim() };
}

/** Split an active-target name (`type` or `type@set`) into its parts. */
export function splitActiveTarget(active: string | undefined): TargetRef | undefined {
    const parsed = parseTargetRef(active);
    if (!parsed) { return undefined; }
    return { type: parsed.type, set: parsed.set ?? '' };
}

/** Render a reference the way the extension names it: `type` for the unnamed set, else `type@set`. */
export function formatTargetName(type: string, set: string | undefined): string {
    return set ? `${type}@${set}` : type;
}

/**
 * Does the active target satisfy the request? A type-only request accepts
 * any set of that type; `type@set` must match exactly (`type@` = unnamed).
 */
export function targetMatches(active: string | undefined, wanted: TargetRef): boolean {
    const current = splitActiveTarget(active);
    if (!current) { return false; }
    if (current.type !== wanted.type) { return false; }
    return wanted.set === undefined || wanted.set === current.set;
}

/**
 * The target-types a csolution declares, with their target-set names, from a
 * line scan of the YAML (the repo carries no YAML parser; the csolution
 * schema keeps `target-types:` a flat list so a scan is enough).
 */
export function listTargetTypes(csolutionText: string): TargetTypeInfo[] {
    const types: TargetTypeInfo[] = [];
    const lines = csolutionText.split(/\r?\n/);
    let blockIndent = -1;
    let inSets = false;

    for (const raw of lines) {
        const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
        if (!line.trim()) { continue; }
        const indent = line.length - line.trimStart().length;

        if (blockIndent < 0) {
            if (/^\s*target-types:\s*$/.test(line)) { blockIndent = indent; }
            continue;
        }
        if (indent <= blockIndent) { break; } // left the target-types block

        const typeMatch = /^\s*-\s*type:\s*(.+?)\s*$/.exec(line);
        if (typeMatch) {
            types.push({ name: unquote(typeMatch[1]), sets: [] });
            inSets = false;
            continue;
        }
        const current = types[types.length - 1];
        if (!current) { continue; }
        if (/^\s*target-set:\s*$/.test(line)) { inSets = true; continue; }
        // `- set:` list items only occur under target-set:; a set's own keys
        // (debugger:, images:) and the type's other keys are skipped.
        const setMatch = /^\s*-\s*set:\s*(.*?)\s*$/.exec(line);
        if (inSets && setMatch) {
            current.sets.push(unquote(setMatch[1]));
        }
    }
    return types;
}

/** The choices to offer when a request does not resolve: `MPS3, HE@debug, HE@release`. */
export function formatTargetChoices(types: TargetTypeInfo[]): string {
    const names: string[] = [];
    for (const t of types) {
        if (t.sets.length === 0) { names.push(t.name); continue; }
        for (const s of t.sets) { names.push(formatTargetName(t.name, s)); }
    }
    return names.join(', ');
}

export type TargetResolution =
    | { ok: true; type: string; set: string | undefined; setIndex: number | undefined; name: string }
    | { ok: false; reason: string };

/**
 * Resolve a request against the declared target-types. A type-only request
 * leaves the set selection alone (the extension keeps its last choice); a
 * named set becomes the index the extension stores.
 */
export function resolveTargetSelection(types: TargetTypeInfo[], wanted: TargetRef): TargetResolution {
    const type = types.find((t) => t.name === wanted.type);
    if (!type) {
        return { ok: false, reason: `target-type '${wanted.type}' is not declared in the csolution` };
    }
    if (wanted.set === undefined) {
        return { ok: true, type: type.name, set: undefined, setIndex: undefined, name: type.name };
    }
    const index = type.sets.indexOf(wanted.set);
    if (index < 0) {
        const sets = type.sets.map((s) => s || '(unnamed)').join(', ') || '(none)';
        return { ok: false, reason: `target-type '${type.name}' has no target-set '${wanted.set || '(unnamed)'}' — its sets: ${sets}` };
    }
    return { ok: true, type: type.name, set: wanted.set, setIndex: index, name: formatTargetName(type.name, wanted.set) };
}

/** The key the extension files a solution under in cmsis.json. */
export function solutionDisplayName(workspaceFolder: string, solutionPath: string): string {
    const relative = path.relative(workspaceFolder, solutionPath);
    const stripped = relative.replace(/\.[^./\\]+$/, '').replace(/\.[^./\\]+$/, '');
    return stripped.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * Return cmsis.json text with the solution's active target-type set (and the
 * set index when one was named). Existing content — other solutions, other
 * keys, comments — is preserved; formatting follows the extension (4 spaces).
 */
export function applyTargetSelection(
    cmsisJsonText: string,
    displayName: string,
    type: string,
    setIndex: number | undefined,
): string {
    const formattingOptions = { insertSpaces: true, tabSize: 4, eol: '\n' };
    let text = cmsisJsonText.trim() ? cmsisJsonText : '{}';
    text = applyEdits(text, modify(text, ['targetSet', displayName, 'activeTargetType'], type, { formattingOptions }));
    if (setIndex !== undefined) {
        text = applyEdits(text, modify(text, ['targetSet', displayName, type], setIndex, { formattingOptions }));
    }
    return text.endsWith('\n') ? text : `${text}\n`;
}

function unquote(value: string): string {
    const v = value.trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        return v.slice(1, -1);
    }
    return v;
}
