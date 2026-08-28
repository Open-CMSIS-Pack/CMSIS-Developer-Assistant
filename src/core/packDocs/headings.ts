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
 * A section label per page, from the text alone: the first numbered heading
 * on the page (`6.3.10 RCC AHB1 peripheral clock enable register`), else the
 * running header (the first short line). A PDF outline, when an extractor
 * provides one, will replace this heuristic.
 */

const NUMBERED = /^\s{0,12}(\d{1,2}(?:\.\d{1,3}){0,4})\s+([A-Z][^\n]{2,90}?)\s*$/;
const MAX_LINES = 25;

export function detectHeading(pageText: string): string {
    const lines = pageText.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim().length > 0);
    for (const line of lines.slice(0, MAX_LINES)) {
        const m = line.match(NUMBERED);
        if (m && !/^\d+\s*$/.test(m[2]) && !/\.{3,}/.test(line)) {
            return `${m[1]} ${collapse(m[2])}`;
        }
    }
    const first = lines[0];
    if (first && first.trim().length <= 80) { return collapse(first); }
    return '';
}

function collapse(s: string): string {
    return s.replace(/\s{2,}/g, ' ').trim();
}
