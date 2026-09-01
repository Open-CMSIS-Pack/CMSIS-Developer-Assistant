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
 * pdf.js text items → page text. Shared by the pdf.js worker thread
 * (`pdfWorker.ts`), which runs it, and the tests, which check it; it has
 * no other dependency so the worker bundle stays small.
 */

/** The subset of pdf.js's text item this extractor reads. */
export interface TextItemLike {
    str: string;
    transform?: number[];
    width?: number;
    height?: number;
    hasEOL?: boolean;
}

/**
 * Rebuild lines from pdf.js text items — the analogue of `pdftotext -layout`
 * for register tables: items on one baseline (y within `tolerance`) form a
 * line ordered by x, and a horizontal gap wider than ~1.5 em becomes two
 * spaces so table columns stay separable. Exported for the tests.
 */
export function itemsToPageText(items: TextItemLike[], tolerance = 2): string {
    type Placed = { x: number; y: number; w: number; h: number; str: string };
    const placed: Placed[] = [];
    for (const it of items) {
        if (!it.str || !it.transform) { continue; }
        placed.push({ x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: it.height ?? Math.abs(it.transform[3]) ?? 10, str: it.str });
    }
    if (!placed.length) { return ''; }
    // Top of the page first (PDF y grows upwards), then left to right.
    placed.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines: Placed[][] = [];
    for (const p of placed) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last[0].y - p.y) <= Math.max(tolerance, last[0].h * 0.4)) {
            last.push(p);
        } else {
            lines.push([p]);
        }
    }
    const out: string[] = [];
    for (const line of lines) {
        line.sort((a, b) => a.x - b.x);
        let text = '';
        let cursor = line[0].x;
        for (const p of line) {
            const gap = p.x - cursor;
            const em = p.h || 10;
            if (text) {
                if (gap > 1.5 * em) { text += '  '; }
                else if (gap > 0.15 * em && !text.endsWith(' ') && !p.str.startsWith(' ')) { text += ' '; }
            }
            text += p.str;
            cursor = p.x + p.w;
        }
        out.push(text.replace(/[ \t]+$/g, ''));
    }
    return out.join('\n') + '\n';
}
