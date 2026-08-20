// Copyright (c) Microsoft Corporation.
// Copyright 2026 Arm Limited and contributors

/**
 * Selection and rendering of DAP variables.
 *
 * Pure — no vscode import — so the matching and formatting rules are
 * unit-testable outside the extension host. The DAP shapes are modelled
 * loosely on purpose: adapters routinely add fields, and `gdbtarget` omits
 * ones the spec marks optional.
 */

import { REDACTION_NOTICE } from '../utils/secretRedaction';

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
    } = { header: 'Variables' },
): string {
    const emptyScopeText = options.emptyScopeText ?? '  No variables in this scope';
    let out = `${options.header}:\n==========\n\n`;
    let anyRedacted = false;

    for (const scope of scopes) {
        out += `${scope.name}:\n`;
        if (scope.error) {
            out += `  Error retrieving variables: ${scope.error}\n`;
        } else if (scope.variables && scope.variables.length > 0) {
            for (const variable of scope.variables) {
                let shown = variable.value;
                if (options.redact) {
                    const verdict = options.redact(variable.name, variable.value);
                    shown = verdict.value;
                    anyRedacted ||= verdict.redacted;
                }
                out += `  ${variable.name}: ${shown}`;
                if (variable.type) { out += ` (${variable.type})`; }
                out += '\n';
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
export function renderVariableNames(scopes: DapScope[]): string {
    let out = 'Variables in scope (names and types only — use get_variables_values to read values):\n\n';
    let total = 0;

    for (const scope of scopes) {
        out += `${scope.name}:\n`;
        if (scope.error) {
            out += `  Error retrieving variables: ${scope.error}\n`;
        } else if (scope.variables && scope.variables.length > 0) {
            for (const variable of scope.variables) {
                total++;
                out += `  ${variable.name}${variable.type ? `: ${variable.type}` : ''}\n`;
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
