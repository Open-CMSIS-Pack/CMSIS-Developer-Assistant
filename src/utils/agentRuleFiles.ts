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
 * Writing the tool rules into agents' rule files, taking them out again, and
 * keeping them current (#50 part 2, #45). The steps are the same whoever
 * drives them: the setup step in agentConfigurationManager.ts with VS Code's
 * picker and diff editor, the unit tests with an in-memory file system and
 * scripted answers.
 *
 * - `runRuleStep()`: offer the files, then apply what was checked or
 *   unchecked, one previewed and confirmed change at a time. A change the
 *   user does not confirm writes nothing.
 * - `refreshRecordedRules()`: at activation, offer to update every recorded
 *   block whose text is not the current contract's, and update in place the
 *   ones the user confirms after the preview. It never creates a block or a
 *   file.
 *
 * The files the rules went into are recorded (`RuleRecordStore`, globalState
 * in the extension): a removal needs to know whether the file and its
 * directories were made for the rules, and activation needs to know which
 * blocks to keep current. The rules text and the file map come from
 * src/core/agentRules.ts. No vscode import.
 */

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomicFile';
import {
    RuleFileProbe,
    RuleFileRecord,
    RuleFileTarget,
    RulesState,
    rulesState,
    withRules,
    withoutRules,
} from '../core/agentRules';

/** The file operations the rule files need. */
export interface RuleFileSystem {
    /** The file's text; undefined when nothing is there (the directory may be missing too). */
    read(file: string): Promise<string | undefined>;
    /** Replace the file's text in one step, creating the file when it is missing; its directory exists. */
    write(file: string, text: string): Promise<void>;
    /** Create the directories missing above `file`; returns them, outermost first. */
    makeParentDirs(file: string): Promise<string[]>;
    remove(file: string): Promise<void>;
    /** Remove `dir` if it is empty; false when it is not, or is gone. */
    removeDirIfEmpty(dir: string): Promise<boolean>;
}

/** Where the records of written files live. */
export interface RuleRecordStore {
    read(): RuleFileRecord[];
    write(records: RuleFileRecord[]): Promise<void>;
}

export interface RuleLog {
    info(message: string): void;
    warn(message: string, detail?: unknown): void;
}

/** One file as the picker offers it. */
export interface RuleChoice {
    target: RuleFileTarget;
    /** The file's text; undefined when there is no file. */
    text: string | undefined;
    state: RulesState;
    /** Checked when the picker opens: preselected, or the rules are in it already. */
    checked: boolean;
}

export type RuleChangeKind = 'create' | 'add' | 'update' | 'remove';

/** What accepting the picker means for one file. */
export interface RuleChange {
    target: RuleFileTarget;
    kind: RuleChangeKind;
    before: string | undefined;
    /** The text afterwards; undefined when the file is deleted. */
    after: string | undefined;
}

/** The two questions the step asks. */
export interface RuleStepUi {
    /** The files that are to carry the rules; undefined when the user backed out. */
    choose(choices: readonly RuleChoice[]): Promise<ReadonlySet<string> | undefined>;
    /** Show the change and ask for it; true only when the user confirmed. */
    confirm(change: RuleChange): Promise<boolean>;
}

export interface RuleStepDeps {
    fs: RuleFileSystem;
    store: RuleRecordStore;
    log: RuleLog;
}

export interface RuleStepReport {
    /** The picker was closed without an answer: nothing changed. */
    dismissed: boolean;
    applied: Array<{ file: string; kind: RuleChangeKind }>;
    declined: string[];
    failed: Array<{ file: string; error: string }>;
}

/**
 * The picker's choices: each target with its text and state. A file that
 * cannot be read, or whose markers are broken, is left out and logged —
 * the rules are never written around a block the extension cannot find.
 */
export async function ruleChoices(targets: readonly RuleFileTarget[], rules: string, deps: Pick<RuleStepDeps, 'fs' | 'log'>): Promise<RuleChoice[]> {
    const choices: RuleChoice[] = [];
    for (const target of targets) {
        let text: string | undefined;
        let state: RulesState;
        try {
            text = await deps.fs.read(target.file);
            state = rulesState(text, rules);
        } catch (failure) {
            deps.log.warn(`Tool rules: ${target.file} is not offered, it cannot be read or its rule markers are broken`, failure);
            continue;
        }
        choices.push({ target, text, state, checked: target.preselect || state !== 'absent' });
    }
    return choices;
}

/**
 * The changes that accepting the picker with `checked` means: a checked file
 * gets the current rules unless it has them; an unchecked file that has
 * rules loses them, and is deleted when nothing else is left and the file
 * is the extension's own or was made for the rules.
 */
export function planRuleChanges(
    choices: readonly RuleChoice[],
    checked: ReadonlySet<string>,
    rules: string,
    records: readonly RuleFileRecord[],
): RuleChange[] {
    const changes: RuleChange[] = [];
    for (const { target, text, state } of choices) {
        if (checked.has(target.file)) {
            if (state === 'current') {
                continue;
            }
            const kind: RuleChangeKind = text === undefined ? 'create' : state === 'absent' ? 'add' : 'update';
            changes.push({ target, kind, before: text, after: withRules(text, target.file, rules) });
        } else if (state !== 'absent' && text !== undefined) {
            const rest = withoutRules(text, target.form);
            const deletes = rest.empty && (target.form === 'own' || recordOf(records, target.file)?.created === true);
            changes.push({ target, kind: 'remove', before: text, after: deletes ? undefined : rest.text });
        }
    }
    return changes;
}

function recordOf(records: readonly RuleFileRecord[], file: string): RuleFileRecord | undefined {
    return records.find((record) => record.file === file);
}

/**
 * Carry out one confirmed change. The file is read again first and the
 * change made on what is there now, so an edit the user saved while the
 * preview was open is kept. The record follows the file.
 */
export async function applyRuleChange(change: RuleChange, rules: string, deps: RuleStepDeps): Promise<void> {
    const { target } = change;
    const records = deps.store.read();
    const known = recordOf(records, target.file);
    const others = records.filter((record) => record.file !== target.file);
    const now = await deps.fs.read(target.file);

    if (change.kind !== 'remove') {
        const next = withRules(now, target.file, rules);
        const createdDirs = now === undefined ? await deps.fs.makeParentDirs(target.file) : [];
        if (next !== now) {
            await deps.fs.write(target.file, next);
        }
        const created = now === undefined || known?.created === true;
        const record: RuleFileRecord = {
            file: target.file,
            scope: target.scope,
            form: target.form,
            agents: [...target.agents],
            created,
            createdDirs: now === undefined ? createdDirs : known?.createdDirs ?? [],
        };
        await deps.store.write([...others, record]);
        deps.log.info(`Tool rules ${change.kind === 'update' ? 'updated' : 'written'} in ${target.file} (read by ${target.agents.join(', ')})`);
        return;
    }

    if (now !== undefined) {
        const rest = withoutRules(now, target.form);
        const deletes = rest.empty && (target.form === 'own' || known?.created === true);
        if (deletes) {
            await deps.fs.remove(target.file);
            // Innermost first; a directory someone put anything else into stays.
            for (const dir of [...(known?.createdDirs ?? [])].reverse()) {
                if (!(await deps.fs.removeDirIfEmpty(dir))) {
                    break;
                }
            }
        } else if (rest.text !== now) {
            await deps.fs.write(target.file, rest.text);
        }
        deps.log.info(`Tool rules removed from ${target.file}${deletes ? ', and the file deleted' : ''}`);
    }
    if (known) {
        await deps.store.write(others);
    }
}

/**
 * The setup step: offer the targets, then apply each change the user
 * confirms after its preview. A file that fails is reported and does not
 * stop the others.
 */
export async function runRuleStep(targets: readonly RuleFileTarget[], rules: string, ui: RuleStepUi, deps: RuleStepDeps): Promise<RuleStepReport> {
    const report: RuleStepReport = { dismissed: false, applied: [], declined: [], failed: [] };
    const choices = await ruleChoices(targets, rules, deps);
    if (choices.length === 0) {
        deps.log.info('Tool rules: no rule file to offer');
        return report;
    }
    const checked = await ui.choose(choices);
    if (checked === undefined) {
        report.dismissed = true;
        deps.log.info('Tool rules: the picker was closed; no rule file changed');
        return report;
    }
    for (const change of planRuleChanges(choices, checked, rules, deps.store.read())) {
        if (!(await ui.confirm(change))) {
            report.declined.push(change.target.file);
            deps.log.info(`Tool rules: ${change.kind} of ${change.target.file} declined; the file is unchanged`);
            continue;
        }
        try {
            await applyRuleChange(change, rules, deps);
            report.applied.push({ file: change.target.file, kind: change.kind });
        } catch (failure) {
            deps.log.warn(`Tool rules: could not change ${change.target.file}`, failure);
            report.failed.push({ file: change.target.file, error: failure instanceof Error ? failure.message : String(failure) });
        }
    }
    return report;
}

/** The two questions the refresh asks. */
export interface RuleRefreshUi {
    /** Offer to review the updates of outdated blocks; true when the user wants to see them. */
    offer(changes: readonly RuleChange[]): Promise<boolean>;
    /** Show one update and ask for it; true only when the user confirmed. */
    confirm(change: RuleChange): Promise<boolean>;
}

export interface RuleRefreshReport {
    updated: string[];
    /** Outdated blocks left as they are: the offer was not taken up, or the update was declined. */
    postponed: string[];
    /** Records dropped: the file or its block is gone, and neither is brought back. */
    forgotten: string[];
    failed: string[];
}

/**
 * At activation: offer to bring every recorded block whose text differs
 * from the current rules up to date, then update in place each one the user
 * confirms after its preview. The user may own the file, keep it in version
 * control or link it from elsewhere, so a new release never rewrites it
 * unasked; a block left outdated is offered again by the setup step. A
 * recorded file that is gone, or whose block the user deleted, is forgotten
 * — never recreated. A file that cannot be read or written keeps its record
 * for the next time.
 */
export async function refreshRecordedRules(rules: string, ui: RuleRefreshUi, deps: RuleStepDeps): Promise<RuleRefreshReport> {
    const report: RuleRefreshReport = { updated: [], postponed: [], forgotten: [], failed: [] };
    const records = deps.store.read();
    const kept: RuleFileRecord[] = [];
    const changes: RuleChange[] = [];
    for (const record of records) {
        let text: string | undefined;
        let state: RulesState;
        try {
            text = await deps.fs.read(record.file);
            state = rulesState(text, rules);
        } catch (failure) {
            deps.log.warn(`Tool rules: ${record.file} could not be checked`, failure);
            report.failed.push(record.file);
            kept.push(record);
            continue;
        }
        if (text === undefined || state === 'absent') {
            deps.log.info(`Tool rules: ${record.file} ${text === undefined ? 'is gone' : 'no longer has the rules block'}; `
                + 'it is not written again');
            report.forgotten.push(record.file);
            continue;
        }
        kept.push(record);
        if (state === 'current') {
            continue;
        }
        const target: RuleFileTarget = {
            file: record.file,
            scope: record.scope,
            form: record.form,
            agents: [...record.agents],
            preselect: false,
        };
        changes.push({ target, kind: 'update', before: text, after: withRules(text, record.file, rules) });
    }
    if (kept.length !== records.length) {
        await deps.store.write(kept);
    }
    if (changes.length === 0) {
        return report;
    }
    if (!(await ui.offer(changes))) {
        report.postponed.push(...changes.map((change) => change.target.file));
        deps.log.info(`Tool rules: ${changes.length} rule file(s) have an older version of the rules and are left as they are; `
            + 'Configure Agent offers the update');
        return report;
    }
    for (const change of changes) {
        if (!(await ui.confirm(change))) {
            report.postponed.push(change.target.file);
            deps.log.info(`Tool rules: update of ${change.target.file} declined; the file is unchanged`);
            continue;
        }
        try {
            // The offer may have waited a long time: a file deleted or emptied of its block meanwhile is not written back.
            const now = await deps.fs.read(change.target.file);
            if (now === undefined || rulesState(now, rules) === 'absent') {
                report.postponed.push(change.target.file);
                deps.log.info(`Tool rules: ${change.target.file} lost its rules block while the update was offered; it is not written`);
                continue;
            }
            await applyRuleChange(change, rules, deps);
            report.updated.push(change.target.file);
        } catch (failure) {
            deps.log.warn(`Tool rules: could not update ${change.target.file}`, failure);
            report.failed.push(change.target.file);
        }
    }
    return report;
}

// ---------------------------------------------------------------------------
// The real file system
// ---------------------------------------------------------------------------

function errorCode(failure: unknown): string | undefined {
    return (failure as NodeJS.ErrnoException | undefined)?.code;
}

/** The files on disk; every write is atomic and keeps a replaced file's permission bits (atomicFile.ts). */
export const NODE_RULE_FILES: RuleFileSystem = {
    async read(file) {
        try {
            return await fs.promises.readFile(file, 'utf8');
        } catch (failure) {
            // Nothing there, or a file where a directory of the path should be.
            if (errorCode(failure) === 'ENOENT' || errorCode(failure) === 'ENOTDIR') {
                return undefined;
            }
            throw failure;
        }
    },
    write: (file, text) => writeFileAtomic(file, text),
    async makeParentDirs(file) {
        const missing: string[] = [];
        for (let dir = path.dirname(file); !fs.existsSync(dir); dir = path.dirname(dir)) {
            missing.unshift(dir);
            if (path.dirname(dir) === dir) {
                break;
            }
        }
        if (missing.length > 0) {
            await fs.promises.mkdir(missing[missing.length - 1], { recursive: true });
        }
        return missing;
    },
    remove: (file) => fs.promises.unlink(file),
    async removeDirIfEmpty(dir) {
        try {
            await fs.promises.rmdir(dir);
            return true;
        } catch {
            return false;
        }
    },
};

/** The disk as `ruleFileTargets` asks about it. */
export const NODE_RULE_PROBE: RuleFileProbe = {
    kind(target) {
        try {
            const stats = fs.statSync(target);
            return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : undefined;
        } catch {
            return undefined;
        }
    },
    hasText(file) {
        try {
            return fs.readFileSync(file, 'utf8').trim().length > 0;
        } catch {
            return false;
        }
    },
    hasEntries(dir) {
        try {
            return fs.readdirSync(dir).length > 0;
        } catch {
            return false;
        }
    },
};
