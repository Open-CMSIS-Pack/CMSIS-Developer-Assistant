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
 * A small, non-backtracking matcher for an index's symptom patterns. The
 * supported grammar covers message catalogues: character atoms, anchors,
 * alternation, unquantified groups and quantifiers on individual atoms.
 * Anything else is refused, never handed to the native regexp matcher.
 * Every automaton state is visited at most once per input position.
 */

import { ToolError } from '../toolResult';

/** A catalogue pattern is one line, not a program of arbitrary size. */
const PATTERN_MAX = 500;
/** Fixed bounds apply before parsing, expanding repetitions or matching. */
const GROUP_DEPTH_MAX = 32;
const REPEAT_MAX = 100;
const STATES_MAX = 1_024;
const LINE_MAX = 2_000;
/** Shared across every pattern, input line and member of one search. */
const MATCH_STEPS_MAX = 8_000_000;
/** Shared across the open index set, including malformed patterns attempted. */
const INDEX_PATTERNS_MAX = 4_096;
const INDEX_STATES_MAX = 250_000;

type Assertion = 'start' | 'end' | 'word' | 'notWord';
type Expression = { kind: 'atom'; pattern: RegExp }
    | { kind: 'assert'; assertion: Assertion }
    | { kind: 'sequence' | 'choice'; parts: Expression[] }
    | { kind: 'repeat'; atom: RegExp; min: number; max: number };
type State = { kind: 'atom'; pattern: RegExp; next: number }
    | { kind: 'assert'; assertion: Assertion; next: number }
    | { kind: 'split'; left: number; right: number }
    | { kind: 'match' };

/** A compiled, case-insensitive pattern with bounded, non-backtracking execution. */
export interface SymptomPattern {
    readonly stateCount: number;
    test(line: string, budget?: SymptomMatchBudget): boolean;
}

/**
 * Deterministic aggregate work cap: a large index or many query lines must
 * not defeat the per-pattern bound. Exhaustion is an explicit incomplete
 * search, never a false negative or a partial answer presented as complete.
 */
export class SymptomMatchBudget {
    constructor(private remaining: number = MATCH_STEPS_MAX) { }

    consume(): void {
        if (--this.remaining < 0) {
            throw new ToolError('TIMEOUT', 'Knowledge symptom matching reached its safety work limit; the search is incomplete.',
                'Search for a shorter error message or reduce broad symptom patterns in the workspace and pack indexes. No complete search result was returned.');
        }
    }
}

/** Bound compilation and retained automaton memory across all members of an open index set. */
export class SymptomCompilationBudget {
    private remainingPatterns = INDEX_PATTERNS_MAX;
    private remainingStates = INDEX_STATES_MAX;

    compile(source: string): SymptomPattern | undefined {
        if (--this.remainingPatterns < 0) {
            throw this.exhausted('pattern count');
        }
        const pattern = compileSymptomPattern(source);
        this.remainingStates -= pattern?.stateCount ?? 0;
        if (this.remainingStates < 0) {
            throw this.exhausted('compiled state count');
        }
        return pattern;
    }

    private exhausted(reason: string): ToolError {
        return new ToolError('INVALID_ARGUMENT', `The knowledge indexes exceed the symptom ${reason} safety limit; the index set was not opened.`,
            'Reduce symptom patterns in the workspace or pack indexes, then repeat the search. No patterns were silently omitted.');
    }
}

/** A parser for the supported grammar, not a heuristic over arbitrary regexps. */
class PatternParser {
    private at = 0;

    constructor(private readonly source: string) { }

    parse(): Expression {
        const result = this.choice(0);
        if (this.at !== this.source.length) {
            throw new Error('Unmatched group');
        }
        return result;
    }

    private choice(depth: number): Expression {
        const parts = [this.sequence(depth)];
        while (this.source[this.at] === '|') {
            this.at++;
            parts.push(this.sequence(depth));
        }
        return parts.length === 1 ? parts[0] : { kind: 'choice', parts };
    }

    private sequence(depth: number): Expression {
        const parts: Expression[] = [];
        while (this.at < this.source.length && this.source[this.at] !== ')' && this.source[this.at] !== '|') {
            const group = this.source[this.at] === '(';
            const atom = this.atom(depth);
            const repeat = this.quantifier();
            if (repeat === undefined) {
                parts.push(atom);
            } else {
                // Refuse all quantified groups, not just the nested cases a
                // heuristic happens to spot. The catalogue needs none of them.
                if (group || atom.kind !== 'atom') {
                    throw new Error('Only character atoms may be quantified');
                }
                parts.push({ kind: 'repeat', atom: atom.pattern, ...repeat });
            }
        }
        return { kind: 'sequence', parts };
    }

    private atom(depth: number): Expression {
        const start = this.at;
        const c = this.source[this.at++];
        if (c === '(') {
            if (depth >= GROUP_DEPTH_MAX) {
                throw new Error('Too many nested groups');
            }
            if (this.source[this.at] === '?') {
                if (this.source[this.at + 1] !== ':') {
                    throw new Error('Unsupported group');
                }
                this.at += 2;
            }
            const nested = this.choice(depth + 1);
            if (this.source[this.at++] !== ')') {
                throw new Error('Unclosed group');
            }
            return nested;
        }
        if (c === '^' || c === '$') {
            return { kind: 'assert', assertion: c === '^' ? 'start' : 'end' };
        }
        if (c === '\\') {
            const escape = this.source[this.at];
            if (escape === 'b' || escape === 'B') {
                this.at++;
                return { kind: 'assert', assertion: escape === 'b' ? 'word' : 'notWord' };
            }
            this.escape(false);
        } else if (c === '[') {
            let closed = false;
            while (this.at < this.source.length) {
                const part = this.source[this.at++];
                if (part === ']') {
                    closed = true;
                    break;
                }
                if (part === '\\') {
                    this.escape(true);
                }
            }
            if (!closed) {
                throw new Error('Unclosed character class');
            }
        } else if ('*+?{}]'.includes(c)) {
            throw new Error('Unexpected metacharacter');
        }
        // Only one verified character atom reaches RegExp. It cannot branch,
        // repeat, look around or refer back; native matching sees one code unit.
        return { kind: 'atom', pattern: new RegExp(`^(?:${this.source.slice(start, this.at)})$`, 'i') };
    }

    /** Consume an escape after its backslash, rejecting references and unknown letter escapes. */
    private escape(inClass: boolean): void {
        const c = this.source[this.at++];
        if (c === undefined) {
            throw new Error('Incomplete escape');
        }
        if (c === 'x' || c === 'u') {
            const length = c === 'x' ? 2 : 4;
            const digits = this.source.slice(this.at, this.at + length);
            if (digits.length !== length || !/^[0-9a-f]+$/i.test(digits)) {
                throw new Error('Invalid character escape');
            }
            this.at += length;
        } else if (c === '0') {
            if (/\d/.test(this.source[this.at] ?? '')) {
                throw new Error('Octal escapes are not supported');
            }
        } else if (/[a-z0-9]/i.test(c) && !'dDsSwWnrtfv'.includes(c) && !(inClass && c === 'b')) {
            throw new Error('Unsupported escape');
        }
    }

    private quantifier(): { min: number; max: number } | undefined {
        const c = this.source[this.at];
        let min: number;
        let max: number;
        if (c === '*' || c === '+' || c === '?') {
            this.at++;
            min = c === '+' ? 1 : 0;
            max = c === '?' ? 1 : Infinity;
        } else if (c === '{') {
            const match = /^\{(\d+)(?:,(\d*))?\}/.exec(this.source.slice(this.at));
            if (match === null) {
                throw new Error('Invalid repetition');
            }
            min = Number(match[1]);
            max = match[2] === undefined ? min : match[2] === '' ? Infinity : Number(match[2]);
            if (min > REPEAT_MAX || (max !== Infinity && max > REPEAT_MAX) || min > max) {
                throw new Error('Repetition exceeds the limit');
            }
            this.at += match[0].length;
        } else {
            return undefined;
        }
        // Greediness affects which substring is selected, not whether it matches.
        if (this.source[this.at] === '?') {
            this.at++;
        }
        return { min, max };
    }
}

/** Turn the supported expression into an epsilon-NFA, bounded before allocating states. */
function automaton(expression: Expression): { states: State[]; start: number } {
    const states: State[] = [];
    const add = (state: State): number => {
        if (states.length >= STATES_MAX) {
            throw new Error('Pattern exceeds the state limit');
        }
        states.push(state);
        return states.length - 1;
    };
    const build = (part: Expression, next: number): number => {
        switch (part.kind) {
            case 'atom':
                return add({ kind: 'atom', pattern: part.pattern, next });
            case 'assert':
                return add({ kind: 'assert', assertion: part.assertion, next });
            case 'sequence': {
                let first = next;
                for (let i = part.parts.length - 1; i >= 0; i--) {
                    first = build(part.parts[i], first);
                }
                return first;
            }
            case 'choice': {
                let first = build(part.parts[0], next);
                for (let i = 1; i < part.parts.length; i++) {
                    first = add({ kind: 'split', left: first, right: build(part.parts[i], next) });
                }
                return first;
            }
            case 'repeat': {
                let first = next;
                if (part.max === Infinity) {
                    const split = { kind: 'split' as const, left: -1, right: next };
                    first = add(split);
                    split.left = add({ kind: 'atom', pattern: part.atom, next: first });
                } else {
                    for (let i = part.min; i < part.max; i++) {
                        first = add({ kind: 'split', left: add({ kind: 'atom', pattern: part.atom, next: first }), right: first });
                    }
                }
                for (let i = 0; i < part.min; i++) {
                    first = add({ kind: 'atom', pattern: part.atom, next: first });
                }
                return first;
            }
        }
    };
    return { states, start: build(expression, add({ kind: 'match' })) };
}

function assertionMatches(assertion: Assertion, line: string, at: number): boolean {
    switch (assertion) {
        case 'start':
            return at === 0;
        case 'end':
            return at === line.length;
        case 'word':
        case 'notWord': {
            const boundary = /\w/.test(line[at - 1] ?? '') !== /\w/.test(line[at] ?? '');
            return assertion === 'word' ? boundary : !boundary;
        }
    }
}

/**
 * Compile only the supported grammar. Native RegExp never receives the
 * whole pattern; unsupported or oversized expressions are unusable.
 */
export function compileSymptomPattern(source: string): SymptomPattern | undefined {
    if (source.length > PATTERN_MAX) {
        return undefined;
    }
    try {
        const { states, start } = automaton(new PatternParser(source).parse());
        return {
            stateCount: states.length,
            test(candidate: string, budget: SymptomMatchBudget = new SymptomMatchBudget()): boolean {
                budget.consume();
                const line = candidate.slice(0, LINE_MAX);
                const seen = new Uint16Array(states.length);
                let pending: number[] = [];
                for (let at = 0; at <= line.length; at++) {
                    const generation = at + 1;
                    const next: number[] = [];
                    pending.push(start); // Search from every position in the same pass, never restart a backtracking match.
                    while (pending.length > 0) {
                        budget.consume();
                        const id = pending.pop()!;
                        if (seen[id] === generation) {
                            continue;
                        }
                        seen[id] = generation;
                        const state = states[id];
                        if (state.kind === 'match') {
                            return true;
                        }
                        if (state.kind === 'split') {
                            pending.push(state.left, state.right);
                        } else if (state.kind === 'assert') {
                            if (assertionMatches(state.assertion, line, at)) {
                                pending.push(state.next);
                            }
                        } else if (at < line.length && state.pattern.test(line[at])) {
                            next.push(state.next);
                        }
                    }
                    pending = next;
                }
                return false;
            },
        };
    } catch {
        return undefined;
    }
}
