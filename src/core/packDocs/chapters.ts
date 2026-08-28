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
 * A chapter index from the per-page headings the extractor already found:
 * `11 Reset and clock control (RCC)` on page 480 starts chapter 11, its
 * sections (`11.8.29 …`) follow with their first page, and the chapter
 * ends where the next one starts. Table-of-contents lines (dot leaders,
 * trailing page numbers) are ignored, and a chapter heading that appears
 * both in the contents and at the chapter start resolves to the page just
 * before its first section.
 */

import { PageRecord } from './pageStore';

export interface ChapterSection {
    /** `11.8.29` */
    number: string;
    title: string;
    /** First page (1-based). */
    page: number;
}

export interface Chapter {
    number: number;
    title: string;
    /** Acronyms in the title's parentheses: `(USART/UART)` → USART, UART; `(TIM2/TIM3)` → TIM2, TIM3. */
    acronyms: string[];
    start: number;
    end: number;
    sections: ChapterSection[];
}

const HEADING = /^(\d{1,2})((?:\.\d{1,3})*)\s+(.+?)\s*$/;
const TOC_LINE = /(\.\s*){3,}\s*\d*\s*$|\s\d{1,4}$/;

export function chapterAcronyms(title: string): string[] {
    const out: string[] = [];
    for (const m of title.matchAll(/\(([^()]{1,60})\)/g)) {
        for (const part of m[1].split(/[\/,;&]|\s+and\s+|\s+or\s+|\s+/)) {
            const t = part.trim().replace(/^x|x$/g, m => m);
            if (/^[A-Za-z][A-Za-z0-9_+-]{0,15}$/.test(t) && /[A-Z]/.test(t)) { out.push(t); }
        }
    }
    return [...new Set(out)];
}

/**
 * A chapter title that wrapped onto a second line in the PDF loses its
 * parentheses (`Universal synchronous/asynchronous receiver` /
 * `transmitter (USART/UART)`): take the continuation line from the page.
 */
export function completeTitle(title: string, pageText: string): string {
    if (/\)/.test(title)) { return title; }
    const lines = pageText.split('\n').map(l => l.replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The running header often repeats the whole title on one line: "… receiver transmitter (USART/UART) RM0456".
    const inline = new RegExp(`${escaped}\\s+([^\\n]*?\\([^()]{1,60}\\))`);
    for (const l of lines) {
        const m = l.match(inline);
        if (m && m[1].length <= 70) { return `${title} ${m[1]}`; }
    }
    // Else the line after the numbered heading: "66 Universal … receiver" / "transmitter (USART/UART)".
    const i = lines.findIndex(l => new RegExp(`^\\d{1,2}\\s+${escaped}$`).test(l));
    const next = i >= 0 ? lines[i + 1] : undefined;
    if (next && next.length <= 70 && /\([^()]{1,60}\)\s*$/.test(next) && !/^\d/.test(next)) { return `${title} ${next}`; }
    return title;
}

export function buildChapterIndex(pages: PageRecord[]): Chapter[] {
    const starts = new Map<number, { title: string; page: number }[]>();
    const sections = new Map<number, Map<string, ChapterSection>>();
    const firstSection = new Map<number, number>();
    for (const rec of pages) {
        const h = rec.heading;
        if (!h || TOC_LINE.test(h)) { continue; }
        const m = h.match(HEADING);
        if (!m) { continue; }
        const n = parseInt(m[1], 10);
        const title = m[2] ? m[3] : completeTitle(m[3], rec.text);
        if (!m[2]) {
            const list = starts.get(n) ?? [];
            list.push({ title, page: rec.p });
            starts.set(n, list);
        } else {
            const number = `${m[1]}${m[2]}`;
            const secs = sections.get(n) ?? new Map<string, ChapterSection>();
            if (!secs.has(number)) { secs.set(number, { number, title, page: rec.p }); }
            sections.set(n, secs);
            if (!firstSection.has(n)) { firstSection.set(n, rec.p); }
        }
    }
    const chapters: Chapter[] = [];
    for (const [n, candidates] of starts) {
        const first = firstSection.get(n);
        let pick = candidates[candidates.length - 1];
        if (first !== undefined) {
            const before = candidates.filter(c => c.page <= first);
            if (before.length) { pick = before[before.length - 1]; }
        }
        const secs = [...(sections.get(n)?.values() ?? [])].sort((a, b) => a.page - b.page || a.number.localeCompare(b.number, undefined, { numeric: true }));
        chapters.push({ number: n, title: pick.title, acronyms: chapterAcronyms(pick.title), start: pick.page, end: pick.page, sections: secs });
    }
    // Sections without a chapter heading on any page (heading detection missed it): a chapter from its first section.
    for (const [n, secs] of sections) {
        if (starts.has(n)) { continue; }
        const list = [...secs.values()].sort((a, b) => a.page - b.page);
        chapters.push({ number: n, title: list[0].title, acronyms: chapterAcronyms(list[0].title), start: list[0].page, end: list[0].page, sections: list });
    }
    chapters.sort((a, b) => a.start - b.start || a.number - b.number);
    for (let i = 0; i < chapters.length; i++) {
        const next = chapters[i + 1];
        const lastPage = pages.length ? pages[pages.length - 1].p : chapters[i].start;
        chapters[i].end = next ? Math.max(chapters[i].start, next.start - 1) : lastPage;
    }
    return chapters;
}

/** The chapter containing a page, if any. */
export function chapterOfPage(chapters: Chapter[], page: number): Chapter | undefined {
    return chapters.find(c => page >= c.start && page <= c.end);
}
