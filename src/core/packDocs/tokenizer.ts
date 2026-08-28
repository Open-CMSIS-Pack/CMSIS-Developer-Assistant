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
 * Identifier-aware tokens for reference manuals.
 *
 *   RCC_AHB2ENR1  → rcc_ahb2enr1, rcc, ahb2enr1
 *   0x4002_3800   → 0x4002_3800, 0x40023800, 40023800
 *   GPIOAEN       → gpioaen
 *
 * so that a query for either the full register name or one of its parts
 * lands on the same page, and addresses match however they are spelled.
 */

export const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'by', 'with', 'as', 'at', 'it',
    'this', 'that', 'these', 'those', 'from', 'when', 'if', 'then', 'than', 'can', 'not', 'no', 'set', 'bit', 'bits',
    'value', 'reset', 'reserved', 'must', 'kept', 'read', 'write', 'rw', 'r', 'w', 'note', 'see', 'section',
]);

const TOKEN_RE = /[a-z0-9_]+/g;

function expand(token: string, out: string[]): void {
    out.push(token);
    if (/^0x[0-9a-f_]+$/.test(token)) {
        const noUnderscore = token.replace(/_/g, '');
        if (noUnderscore !== token) { out.push(noUnderscore); }
        out.push(noUnderscore.slice(2));
        return;
    }
    if (token.includes('_')) {
        for (const part of token.split('_')) {
            if (part.length >= 2 && !STOP_WORDS.has(part)) { out.push(part); }
        }
    }
}

/** Tokens for indexing a page, expansions included, stop words removed. */
export function tokenize(text: string): string[] {
    const out: string[] = [];
    const lower = text.toLowerCase();
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(lower)) !== null) {
        const t = m[0].replace(/^_+|_+$/g, '');
        if (t.length < 2 || STOP_WORDS.has(t)) { continue; }
        expand(t, out);
    }
    return out;
}

export interface ParsedQuery {
    /** Distinct index terms (expanded like page text). */
    terms: string[];
    /** The raw words as typed, for snippet marking. */
    words: string[];
    /** Quoted phrases, lower-cased. */
    phrases: string[];
}

export function parseQuery(query: string): ParsedQuery {
    const phrases: string[] = [];
    const rest = query.replace(/"([^"]+)"/g, (_, p: string) => { phrases.push(p.trim().toLowerCase()); return ' '; });
    const words = (rest + ' ' + phrases.join(' ')).split(/\s+/).map(w => w.trim()).filter(w => w.length >= 2);
    const terms = [...new Set(tokenize(rest + ' ' + phrases.join(' ')))];
    return { terms, words: [...new Set(words)], phrases };
}
