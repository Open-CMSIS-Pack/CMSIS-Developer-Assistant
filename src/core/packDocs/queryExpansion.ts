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
 * Query expansion from the SVD for `search_target_docs`.
 *
 * An agent asks for `USART1` or `RCC_APB2ENR`; the manual's page says
 * "universal synchronous asynchronous receiver transmitter" or "APB2
 * peripheral clock enable register". The SVD knows both spellings, so an
 * identifier in the query is expanded with the words of its SVD description
 * (peripheral, register or field) and the type synonyms `peripheralAliases`
 * knows, at a lower weight than the words the user typed. Quoted queries
 * are never expanded — the user asked for that phrase.
 */

import { acronymsFor, phrasesFor } from './peripheralAliases';
import { SvdSummary, findPeripheral, registersOf } from './svdLite';
import { STOP_WORDS, parseQuery, tokenize } from './tokenizer';

/** Words that look like a peripheral, register or field identifier rather than prose. */
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$|^[A-Z]{2,}[A-Z0-9]*$/;

/** Weight of an expansion term relative to a typed one. */
export const EXPANSION_WEIGHT = 0.5;

export interface QueryExpansion {
    /** Extra index terms and their weights. */
    expansions: Record<string, number>;
    /** One line per expanded identifier, for the result text. */
    notes: string[];
}

function words(text: string | undefined): string[] {
    return text ? tokenize(text).filter(t => t.length >= 3 && !STOP_WORDS.has(t)) : [];
}

export function expandQuery(query: string, svd: SvdSummary | undefined): QueryExpansion {
    const none: QueryExpansion = { expansions: {}, notes: [] };
    if (!svd) { return none; }
    const parsed = parseQuery(query);
    if (parsed.phrases.length) { return none; }
    // Only identifier-only queries (`USART1`, `RCC_APB2ENR GPIOAEN`) are
    // expanded. Prose already carries the description words, and expanding
    // the acronyms inside it (RCC, DMA, APB2) only dilutes the ranking —
    // measured on RM0455: description queries lost 2 points with it.
    if (!parsed.words.length || !parsed.words.every(w => IDENTIFIER_RE.test(w))) { return none; }
    const own = new Set(parsed.terms);
    const expansions: Record<string, number> = {};
    const notes: string[] = [];
    const add = (terms: string[], label: string) => {
        const added = [...new Set(terms)].filter(t => !own.has(t) && !(t in expansions));
        for (const t of added) { expansions[t] = EXPANSION_WEIGHT; }
        if (added.length) { notes.push(`${label}: ${added.join(' ')}`); }
    };

    for (const word of parsed.words) {
        if (!IDENTIFIER_RE.test(word)) { continue; }
        const upper = word.toUpperCase();

        const peripheral = findPeripheral(svd, upper);
        if (peripheral) {
            add([
                ...acronymsFor(upper).map(a => a.toLowerCase()),
                ...phrasesFor(upper).flatMap(p => words(p)),
                ...words(peripheral.description),
            ], `${word} (peripheral)`);
            continue;
        }

        // Register names (RCC_APB2ENR) are deliberately not expanded: the
        // manual's heading carries them and the heading field finds them
        // (R@1 98 % on RM0455); adding the description words only diluted it.

        // A bare field name (GPIOAEN) never appears in a heading — add the
        // register it lives in and the field's description.
        let found = false;
        for (const p of svd.peripherals) {
            for (const r of registersOf(svd, p)) {
                const field = r.fields.find(f => f.name.toUpperCase() === upper);
                if (field) {
                    add([...words(field.description), `${p.name}_${r.name}`.toLowerCase(), ...tokenize(`${p.name}_${r.name}`)],
                        `${word} (field of ${p.name}_${r.name})`);
                    found = true;
                    break;
                }
            }
            if (found) { break; }
        }
    }
    return { expansions, notes };
}
