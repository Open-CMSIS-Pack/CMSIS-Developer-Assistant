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
 * Selection and rendering of DAP variables.
 *
 * Pure — no vscode import — so the matching and formatting rules are
 * unit-testable outside the extension host. The DAP shapes are modelled
 * loosely on purpose: adapters routinely add fields, and `gdbtarget` omits
 * ones the spec marks optional.
 */

import { REDACTION_NOTICE } from '../utils/secretRedaction';
import { clipValue, truncateList } from './textBudget';

/** Caps on an un-narrowed listing; 0 disables a cap. */
export interface ListingLimits {
    maxVariables: number;
    maxValueChars: number;
}

/**
 * Applied by the handlers when the caller did not pass variableNames. Embedded
 * frames are small, so the caps rarely bite; when they do, the footer says how
 * to lift them.
 */
export const DEFAULT_LISTING_LIMITS: ListingLimits = { maxVariables: 40, maxValueChars: 200 };
export const DEFAULT_NAME_LISTING_LIMIT = 100;

export interface DapVariable {
    name: string;
    value: string;
    type?: string;
    /** The canonical evaluatable name. Absent on many gdbtarget responses. */
    evaluateName?: string;
    variablesReference?: number;
}

export interface DapScope {
    name: string;
    variables?: DapVariable[];
    error?: string;
}

/**
 * Strip an adapter's type decoration from a display name.
 *
 * Some adapters render the display name as `config [Dictionary]` while the
 * evaluatable name is plain `config`. Matching on the raw display name alone
 * therefore makes those variables unreachable by name.
 */
function undecorate(name: string): string {
    return name.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}

/** Every name a caller could reasonably use to refer to this variable. */
function aliasesOf(variable: DapVariable): string[] {
    const aliases = [variable.name, undecorate(variable.name)];
    if (variable.evaluateName) {
        aliases.push(variable.evaluateName, undecorate(variable.evaluateName));
    }
    return aliases;
}

/**
 * Keep only the variables the caller asked for.
 *
 * Returns the filtered scopes plus the requested names that matched nothing,
 * so the caller gets explicit feedback instead of a silently short list. Scopes
 * that end up empty are dropped, but scopes carrying an `error` are kept — a
 * failed scope read is information, not absence.
 */
export function selectVariables(
    scopes: DapScope[],
    requested: string[],
): { scopes: DapScope[]; missing: string[] } {
    const wanted = requested.map(n => n.trim()).filter(n => n.length > 0);
    if (wanted.length === 0) {
        return { scopes, missing: [] };
    }

    const found = new Set<string>();
    const filtered: DapScope[] = [];

    for (const scope of scopes) {
        const matches = (scope.variables ?? []).filter(variable => {
            const aliases = aliasesOf(variable);
            const hit = wanted.filter(name => aliases.includes(name));
            hit.forEach(name => found.add(name));
            return hit.length > 0;
        });

        if (matches.length > 0 || scope.error) {
            filtered.push({ ...scope, variables: matches });
        }
    }

    return { scopes: filtered, missing: wanted.filter(name => !found.has(name)) };
}

/**
 * Render scopes and their variables as the value listing an agent reads.
 *
 * `redact` is injected rather than imported so this module stays a pure
 * formatter and the redaction policy remains testable on its own.
 */
export function renderScopes(
    scopes: DapScope[],
    options: {
        header: string;
        emptyScopeText?: string;
        redact?: (name: string, value: string) => { value: string; redacted: boolean };
        /**
         * Caps applied when the caller did not narrow the request. A whole
         * scope on a big frame, or one 4 KB array rendered inline, is the
         * kind of result that forces a context compaction; the footer says
         * how to lift the cap.
         */
        limits?: ListingLimits;
    } = { header: 'Variables' },
): string {
    const emptyScopeText = options.emptyScopeText ?? '  No variables in this scope';
    let out = `${options.header}:\n==========\n\n`;
    let anyRedacted = false;
    const maxVariables = options.limits?.maxVariables ?? 0;
    const maxValueChars = options.limits?.maxValueChars ?? 0;

    for (const scope of scopes) {
        out += `${scope.name}:\n`;
        if (scope.error) {
            out += `  Error retrieving variables: ${scope.error}\n`;
        } else if (scope.variables && scope.variables.length > 0) {
            const { shown: variables, hidden } = truncateList(scope.variables, maxVariables);
            for (const variable of variables) {
                let shown = variable.value;
                let redacted = false;
                if (options.redact) {
                    const verdict = options.redact(variable.name, variable.value);
                    shown = verdict.value;
                    redacted = verdict.redacted;
                    anyRedacted ||= redacted;
                }
                // The placeholder is never clipped — a cut placeholder reads
                // like a partial value.
                out += `  ${variable.name}: ${redacted ? shown : clipValue(shown, maxValueChars)}`;
                if (variable.type) { out += ` (${variable.type})`; }
                out += '\n';
            }
            if (hidden > 0) {
                out += `  … ${hidden} more, truncated — narrow with variableNames\n`;
            }
        } else {
            out += `${emptyScopeText}\n`;
        }
        out += '\n';
    }

    return anyRedacted ? `${out}${REDACTION_NOTICE}\n` : out;
}

/**
 * Render names and types only — no values are read or shown. Lets an agent see
 * what exists before deciding what is worth pulling over the wire, which on a
 * slow probe is the difference between one round trip and thirty.
 */
export function renderVariableNames(scopes: DapScope[], limits?: Pick<ListingLimits, 'maxVariables'>): string {
    let out = 'Variables in scope (names and types only — use get_variables_values to read values):\n\n';
    let total = 0;
    const maxVariables = limits?.maxVariables ?? 0;

    for (const scope of scopes) {
        out += `${scope.name}:\n`;
        if (scope.error) {
            out += `  Error retrieving variables: ${scope.error}\n`;
        } else if (scope.variables && scope.variables.length > 0) {
            const { shown, hidden } = truncateList(scope.variables, maxVariables);
            for (const variable of shown) {
                total++;
                out += `  ${variable.name}${variable.type ? `: ${variable.type}` : ''}\n`;
            }
            if (hidden > 0) {
                total += hidden;
                out += `  … ${hidden} more — pass scope: 'local' or inspect one frame with get_frame_variables\n`;
            }
        } else {
            out += '  No variables in this scope\n';
        }
        out += '\n';
    }

    if (total === 0) {
        return 'No variables are visible at the current execution point.';
    }
    return out;
}

/** The trailing note naming the variables that matched nothing. */
export function formatMissingNames(missing: string[]): string {
    if (missing.length === 0) { return ''; }
    return `\n⚠️ Not found in the requested scope(s): ${missing.join(', ')}. ` +
        'Call list_variable_names to see what is actually in scope, or use evaluate_expression ' +
        'for globals and struct members that are not top-level locals.\n';
}
