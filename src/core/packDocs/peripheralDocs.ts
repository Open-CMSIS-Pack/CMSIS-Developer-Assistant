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
 * The deterministic link between a peripheral instance in the SVD and the
 * pages that document it — no LLM, no database:
 *
 *  - chapters: chapter titles whose acronyms name the instance (`TIM2` in
 *    "(TIM2/TIM3/TIM4/TIM5)") or its type (`USART`, or an alias such as
 *    `UART`), else whose title contains a phrase of the type;
 *  - registers: the page whose heading carries the manual's register token
 *    (`USART_CR1`, `TIMx_CR1`, `RCC_APB2ENR`), from the BM25 postings;
 *  - clock/reset: the RCC fields named `<INSTANCE>EN` / `RST` / `LPEN` in
 *    the SVD, with the page of their register;
 *  - interrupts: the SVD's vector numbers, with the vector-table page;
 *  - errata: pages of errata documents that name the instance or type.
 *
 * Every line carries a document id and page, so the agent can read on.
 */

import { Chapter } from './chapters';
import { LoadedDoc } from './pageStore';
import { DocRef } from './pdscBooks';
import { acronymsFor, phrasesFor, stripInstance, typeOf } from './peripheralAliases';
import { SvdInterrupt, SvdPeripheral, SvdRegister, SvdSummary, findPeripheral, groupOf, peripheralsByGroup, registersOf } from './svdLite';
import { clipValue } from './textBudget';

export type Aspect = 'chapters' | 'registers' | 'clock' | 'irq' | 'errata';
export const ALL_ASPECTS: readonly Aspect[] = ['chapters', 'registers', 'clock', 'irq', 'errata'];

export interface DossierDoc {
    loaded: LoadedDoc;
    chapters: Chapter[];
}

export interface PageRef {
    doc: DocRef;
    page: number;
    heading: string;
}

export interface ChapterMatch {
    doc: DocRef;
    chapter: Chapter;
    level: 'instance' | 'type' | 'phrase';
    /** What matched: the acronym or phrase. */
    via: string;
    /** When a section title (not the chapter) named the peripheral: that section and its page range. */
    section?: { number: string; title: string; start: number; end: number };
}

export interface ClockBit {
    kind: 'enable' | 'reset' | 'low-power';
    peripheral: string;
    register: string;
    field: string;
    bit: number;
    page?: PageRef;
}

export interface RegisterPage {
    register: SvdRegister;
    tokens: string[];
    page?: PageRef;
}

export interface IrqRef {
    irq: SvdInterrupt;
    page?: PageRef;
}

export interface Dossier {
    instance: SvdPeripheral;
    group?: string;
    typeKey?: string;
    registers: SvdRegister[];
    aspects: Set<Aspect>;
    chapters: ChapterMatch[];
    clock: ClockBit[];
    registerPages: RegisterPage[];
    irqs: IrqRef[];
    errata: PageRef[];
    errataDocs: number;
    maxRegisters: number;
}

export interface DossierMiss {
    candidates: SvdPeripheral[];
    groups: Map<string, SvdPeripheral[]>;
    typeKey?: string;
}

export interface DossierOptions {
    aspects?: Aspect[];
    maxRegisters?: number;
}

function isErrata(doc: DocRef): boolean {
    return /errata/i.test(doc.title) || /(^|\/)es\d{3,}/i.test(doc.id);
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The postings of a token: 1-based pages with their term frequency. */
function pagesFor(loaded: LoadedDoc, token: string): { page: number; tf: number }[] {
    const list = loaded.index.postings[token];
    if (!list) { return []; }
    const out: { page: number; tf: number }[] = [];
    for (let i = 0; i < list.length; i += 2) { out.push({ page: list[i] + 1, tf: list[i + 1] }); }
    return out;
}

function headingOf(loaded: LoadedDoc, page: number): string {
    return loaded.pages()[page - 1]?.heading ?? '';
}

/** A section-heading line on the page that names the token in parentheses: `66.8.2 USART control register 2 (USART_CR2)`. */
function sectionLineFor(text: string, token: string): string | undefined {
    const re = new RegExp(`^\\s*(\\d{1,2}(?:\\.\\d{1,3})+)\\s+([^\\n]{2,120}?\\(\\s*${escapeRe(token)}\\s*\\)[^\\n]{0,40})\\s*$`, 'gim');
    for (const m of text.matchAll(re)) {
        const rest = m[2];
        // Not a table-of-contents entry: no dot leaders, no trailing page number.
        if (/(\.\s*){3,}/.test(rest) || /\)\s*\.?\s*\d{1,4}\s*$/.test(rest)) { continue; }
        return `${m[1]} ${rest.replace(/\s{2,}/g, ' ').trim()}`;
    }
    return undefined;
}

/**
 * The best page for a register token in one document: a page with a
 * section heading naming the token (inside the matched chapters first),
 * else the page heading, else the most frequent page inside the chapters,
 * else the most frequent page.
 */
function bestPage(loaded: LoadedDoc, token: string, within: Chapter[]): { page: number; heading: string } | undefined {
    const pages = pagesFor(loaded, token);
    if (!pages.length) { return undefined; }
    const inside = (p: number) => within.some(c => p >= c.start && p <= c.end);
    const ordered = [...pages.filter(p => inside(p.page)), ...pages.filter(p => !inside(p.page))];
    const records = loaded.pages();
    for (const p of ordered) {
        const line = sectionLineFor(records[p.page - 1]?.text ?? '', token);
        if (line) { return { page: p.page, heading: line }; }
    }
    const lower = token.toLowerCase();
    const headed = ordered.find(p => headingOf(loaded, p.page).toLowerCase().includes(lower));
    if (headed) { return { page: headed.page, heading: headingOf(loaded, headed.page) }; }
    const inChapter = pages.filter(p => inside(p.page)).sort((a, b) => b.tf - a.tf);
    const pick = inChapter.length ? inChapter[0] : [...pages].sort((a, b) => b.tf - a.tf)[0];
    return { page: pick.page, heading: headingOf(loaded, pick.page) };
}

/** Classify a chapter acronym for an instance: the instance itself, its bare type, a sibling instance of the type, or unrelated. */
function classify(acr: string, inst: string, typeTokens: Set<string>): 'instance' | 'type' | 'sibling' | undefined {
    if (acr === inst) { return 'instance'; }
    if (typeTokens.has(acr) || typeTokens.has(acr.replace(/X$/, ''))) { return 'type'; }
    const bare = acr.replace(/\d+$/, '');
    if (bare !== acr && typeTokens.has(bare)) { return 'sibling'; }
    return undefined;
}

function matchChapters(instance: string, group: string | undefined, docs: DossierDoc[]): ChapterMatch[] {
    const inst = instance.toUpperCase();
    const typeTokens = new Set(acronymsFor(group ?? instance).concat(acronymsFor(instance)));
    const ownType = typeOf(group ?? instance)?.key;
    const phrases = phrasesFor(group ?? instance);
    const out: ChapterMatch[] = [];
    for (const d of docs) {
        if (isErrata(d.loaded.doc)) { continue; }
        const strong: ChapterMatch[] = [];
        const siblings: ChapterMatch[] = [];
        const weak: ChapterMatch[] = [];
        for (const ch of d.chapters) {
            const acr = ch.acronyms.map(a => a.toUpperCase());
            const classes = acr.map(a => ({ a, c: classify(a, inst, typeTokens) }));
            const hit = classes.find(x => x.c === 'instance') ?? classes.find(x => x.c === 'type') ?? classes.find(x => x.c === 'sibling');
            if (hit?.c === 'instance' || hit?.c === 'type') { strong.push({ doc: d.loaded.doc, chapter: ch, level: hit.c, via: hit.a }); continue; }
            if (hit?.c === 'sibling') { siblings.push({ doc: d.loaded.doc, chapter: ch, level: 'type', via: hit.a }); continue; }
            // A phrase only counts when the chapter's own acronyms do not name another type.
            const otherType = acr.some(a => { const t = typeOf(a)?.key; return !!t && t !== ownType; });
            if (otherType) { continue; }
            const title = ch.title.toLowerCase();
            const viaPhrase = phrases.find(p => title.includes(p));
            if (viaPhrase) { weak.push({ doc: d.loaded.doc, chapter: ch, level: 'phrase', via: viaPhrase }); }
        }
        const instanceLevel = strong.some(m => m.level === 'instance');
        const picked = strong.length ? (instanceLevel ? strong : [...strong, ...siblings]) : siblings.length ? siblings : weak;
        // No chapter of its own: a section whose title names the instance or its group
        // ("4.4 System timer, SysTick" in a Generic User Guide, "23.7 USART1 …").
        if (!picked.length) {
            const names = [instance, ...(group ? [group] : [])].map(n => new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(n)}([^A-Za-z0-9_]|$)`, 'i'));
            const found: ChapterMatch[] = [];
            for (const ch of d.chapters) {
                ch.sections.forEach((sec, i) => {
                    if (found.length >= 6 || !names.some(re => re.test(sec.title))) { return; }
                    const next = ch.sections[i + 1];
                    const end = next ? Math.max(sec.page, next.page - 1) : ch.end;
                    found.push({ doc: d.loaded.doc, chapter: ch, level: 'instance', via: 'section title', section: { number: sec.number, title: sec.title, start: sec.page, end } });
                });
            }
            picked.push(...found);
        }
        out.push(...picked);
    }
    return out.sort((a, b) => ({ instance: 0, type: 1, phrase: 2 })[a.level] - ({ instance: 0, type: 1, phrase: 2 })[b.level]);
}

/** Tokens the manual may use for a register: `USART_CR1`, `TIMx_CR1`, `GPIOx_MODER`, `RCC_APB2ENR`. */
function registerTokens(instance: string, group: string | undefined, typeKey: string | undefined, reg: string): string[] {
    const flat = reg.replace(/\./g, '_');
    // ST's SVDs name some registers with the type prefix (`GPIO_MODER`, `RCC_APB2ENR`) or a mode suffix (`CR1_enabled`, `CCMR1_Output`).
    const bases = [...new Set([group, typeKey, stripInstance(instance), instance].filter((b): b is string => !!b).map(b => b.toUpperCase()))];
    let core = flat.replace(/_(enabled|disabled|output|input)$/i, '');
    for (const b of bases) {
        if (core.toUpperCase().startsWith(`${b}_`)) { core = core.slice(b.length + 1); break; }
    }
    const last = reg.includes('.') ? reg.slice(reg.lastIndexOf('.') + 1) : undefined;
    const prefixes = [group, typeKey, stripInstance(instance), `${stripInstance(instance)}x`, instance].filter((b): b is string => !!b);
    const out: string[] = [];
    for (const b of prefixes) {
        out.push(`${b}_${core}`);
        if (last) { out.push(`${b}_${last}`); }
    }
    if (flat !== core) { out.push(flat); }
    return [...new Set(out.map(t => t.toLowerCase()))];
}

function findRegisterPage(tokens: string[], docs: DossierDoc[], chapters: ChapterMatch[]): { token: string; page: PageRef } | undefined {
    for (const d of docs) {
        if (isErrata(d.loaded.doc)) { continue; }
        const within = chapters.filter(c => c.doc.id === d.loaded.doc.id).map(c => (c.section ? { ...c.chapter, start: c.section.start, end: c.section.end } : c.chapter));
        for (const token of tokens) {
            const best = bestPage(d.loaded, token, within);
            if (best) { return { token, page: { doc: d.loaded.doc, page: best.page, heading: best.heading } }; }
        }
    }
    return undefined;
}

function findClockBits(svd: SvdSummary, instance: string, docs: DossierDoc[], rccChapters: ChapterMatch[]): ClockBit[] {
    const inst = escapeRe(instance.toUpperCase());
    const patterns: { kind: ClockBit['kind']; re: RegExp }[] = [
        { kind: 'enable', re: new RegExp(`^${inst}(EN|CLKEN|CKEN|_CLK_EN|_CLKEN)$`, 'i') },
        { kind: 'reset', re: new RegExp(`^${inst}(RST|RESET|_RST)$`, 'i') },
        { kind: 'low-power', re: new RegExp(`^${inst}(SMEN|LPEN|SLPEN|STPEN|LPENR|_SLP_EN)$`, 'i') },
    ];
    const out: ClockBit[] = [];
    const isRcc = (p: SvdPeripheral) => typeOf(groupOf(svd, p) ?? p.name)?.key === 'RCC';
    for (const p of svd.peripherals) {
        if (!isRcc(p)) { continue; }
        // A secure alias (SEC_RCC derivedFrom RCC) repeats the same registers.
        if (p.derivedFrom) {
            const parent = findPeripheral(svd, p.derivedFrom);
            if (parent && isRcc(parent)) { continue; }
        }
        for (const reg of registersOf(svd, p)) {
            for (const f of reg.fields) {
                const hit = patterns.find(x => x.re.test(f.name));
                if (!hit) { continue; }
                const found = findRegisterPage(registerTokens(p.name, groupOf(svd, p), 'RCC', reg.name), docs, rccChapters);
                const register = reg.name.toUpperCase().startsWith(`${p.name.toUpperCase()}_`) ? reg.name : `${p.name}_${reg.name}`;
                out.push({ kind: hit.kind, peripheral: p.name, register, field: f.name, bit: f.bitOffset, ...(found ? { page: found.page } : {}) });
            }
        }
    }
    return out.sort((a, b) => ({ enable: 0, reset: 1, 'low-power': 2 })[a.kind] - ({ enable: 0, reset: 1, 'low-power': 2 })[b.kind]);
}

/**
 * The vector-table page: inside a section whose heading says "vector" (else
 * "interrupt") — a table that runs over pages leaves those pages without a
 * heading of their own, so the section carries over — and whose text names
 * the vector and its number.
 */
function findIrqPage(irq: SvdInterrupt, docs: DossierDoc[]): PageRef | undefined {
    const nameRe = new RegExp(`\\b${escapeRe(irq.name)}\\b`);
    const numRe = new RegExp(`(^|[^\\w.])${irq.value}(?![\\w.])`, 'm');
    const numbered = /^\d{1,2}(\.\d{1,3})*\s/;
    for (const headingRe of [/vector/i, /interrupt/i]) {
        for (const d of docs) {
            if (isErrata(d.loaded.doc)) { continue; }
            let section: string | undefined;
            let since = 0;
            for (const rec of d.loaded.pages()) {
                if (rec.heading && numbered.test(rec.heading)) {
                    section = headingRe.test(rec.heading) ? rec.heading : undefined;
                    since = 0;
                } else if (section) {
                    since++;
                    if (since > 12) { section = undefined; }
                }
                if (!section) { continue; }
                if (nameRe.test(rec.text) && numRe.test(rec.text)) { return { doc: d.loaded.doc, page: rec.p, heading: rec.heading || section }; }
            }
        }
    }
    return undefined;
}

function findErrata(instance: string, group: string | undefined, docs: DossierDoc[], max = 10): PageRef[] {
    const names = [...new Set([instance.toUpperCase(), ...(group ? [group.toUpperCase()] : [])])];
    const re = new RegExp(`\\b(${names.map(escapeRe).join('|')})\\b`, 'i');
    const out: PageRef[] = [];
    for (const d of docs) {
        if (!isErrata(d.loaded.doc)) { continue; }
        for (const rec of d.loaded.pages()) {
            if (out.length >= max) { return out; }
            if (re.test(rec.text)) { out.push({ doc: d.loaded.doc, page: rec.p, heading: rec.heading }); }
        }
    }
    return out;
}

export function buildDossier(name: string, svd: SvdSummary, docs: DossierDoc[], opts: DossierOptions = {}): Dossier | DossierMiss {
    const instance = findPeripheral(svd, name);
    if (!instance) {
        const type = typeOf(name);
        const groups = peripheralsByGroup(svd);
        const wanted = name.trim().toLowerCase();
        const candidates = svd.peripherals.filter(p =>
            p.name.toLowerCase().includes(wanted) ||
            (type && typeOf(groupOf(svd, p) ?? p.name)?.key === type.key));
        return { candidates, groups, ...(type ? { typeKey: type.key } : {}) };
    }
    const aspects = new Set<Aspect>(opts.aspects?.length ? opts.aspects : ALL_ASPECTS);
    const maxRegisters = Math.max(1, Math.min(opts.maxRegisters ?? 40, 200));
    const group = groupOf(svd, instance);
    const typeKey = typeOf(group ?? instance.name)?.key;
    const registers = registersOf(svd, instance);
    const chapters = aspects.has('chapters') || aspects.has('registers') ? matchChapters(instance.name, group, docs) : [];
    const registerPages: RegisterPage[] = aspects.has('registers')
        ? registers.slice(0, maxRegisters).map(reg => {
            const tokens = registerTokens(instance.name, group, typeKey, reg.name);
            const found = findRegisterPage(tokens, docs, chapters);
            return { register: reg, tokens, ...(found ? { page: found.page } : {}) };
        })
        : [];
    return {
        instance,
        ...(group ? { group } : {}),
        ...(typeKey ? { typeKey } : {}),
        registers,
        aspects,
        chapters: aspects.has('chapters') ? chapters : [],
        clock: aspects.has('clock') ? findClockBits(svd, instance.name, docs, matchChapters('RCC', 'RCC', docs)) : [],
        registerPages,
        irqs: aspects.has('irq') ? instance.interrupts.map(irq => { const page = findIrqPage(irq, docs); return { irq, ...(page ? { page } : {}) }; }) : [],
        errata: aspects.has('errata') ? findErrata(instance.name, group, docs) : [],
        errataDocs: docs.filter(d => isErrata(d.loaded.doc)).length,
        maxRegisters,
    };
}

// ---------------------------------------------------------------- render

function cite(ref: PageRef): string {
    const unit = ref.doc.unit === 'section' ? '§' : 'p.';
    return `${ref.doc.id}${ref.doc.revision ? ` ${ref.doc.revision}` : ''} ${unit}${ref.page}${ref.heading ? ` §${ref.heading}` : ''}`;
}

function hex(n: number, width = 8): string {
    return `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;
}

export interface DossierContext {
    target: string;
    svdRel: string;
    maxChars?: number;
    /** Documents that could not be indexed in time. */
    skipped?: { doc: DocRef; reason: string }[];
    /** Why the vendor SVD was not used, etc. */
    notes?: string[];
    /** The Arm documents that describe this (core or NPU) peripheral, with their cache state. */
    armDocs?: DocRef[];
}

export function renderDossier(d: Dossier, ctx: DossierContext): string {
    const lines: string[] = [];
    const inst = d.instance;
    lines.push(`# ${inst.name}${inst.description ? ` — ${inst.description}` : ''}`);
    lines.push(`${ctx.target}; SVD ${ctx.svdRel}`);
    const facts = [`base ${hex(inst.baseAddress)}`, d.group ? `group ${d.group}` : undefined, `${d.registers.length} registers`,
        `${inst.interrupts.length} interrupt${inst.interrupts.length === 1 ? '' : 's'}`, inst.derivedFrom ? `derived from ${inst.derivedFrom}` : undefined]
        .filter(Boolean).join(' · ');
    lines.push(`- ${facts}`);
    for (const n of ctx.notes ?? []) { lines.push(`- Note: ${n}`); }
    for (const s of ctx.skipped ?? []) { lines.push(`- Note: ${s.doc.id} not searched — ${s.reason}`); }

    if (d.aspects.has('chapters')) {
        lines.push('', '## Chapters');
        if (!d.chapters.length) {
            lines.push(`- no chapter or section names ${inst.name}${d.group ? ` or ${d.group}` : ''} in the indexed documents — try search_target_docs { query: '${inst.name}' }`);
        }
        for (const m of d.chapters) {
            const rev = m.doc.revision ? ` ${m.doc.revision}` : '';
            if (m.section) {
                const range = m.section.end > m.section.start ? `p.${m.section.start}–${m.section.end}` : `p.${m.section.start}`;
                lines.push(`- ${m.doc.id}${rev} §${m.section.number} ${m.section.title} ${range} (section of §${m.chapter.number} ${m.chapter.title})`);
                continue;
            }
            const ch = m.chapter;
            const range = ch.end > ch.start ? `p.${ch.start}–${ch.end}` : `p.${ch.start}`;
            lines.push(`- ${m.doc.id}${rev} §${ch.number} ${ch.title} ${range} (${m.level}: ${m.via}, ${ch.sections.length} sections)`);
        }
        if (ctx.armDocs?.length) {
            lines.push('', '## Arm documents for this peripheral');
            for (const a of ctx.armDocs) {
                const state = a.indexed ? 'indexed — searched above' : a.cached ? 'fetched, not indexed yet — call again' : `not fetched — fetch_doc { doc: '${a.id}' }, then call again`;
                lines.push(`- ${a.id} · ${a.kind ?? 'arm'} · ${a.title}${a.revision ? ` (${a.revision})` : ''} — ${state}`);
            }
        }
    }

    if (d.aspects.has('clock')) {
        lines.push('', '## Clock and reset (RCC fields in the SVD → manual page)');
        if (!d.clock.length) { lines.push(`- no RCC field named ${inst.name}EN/RST/LPEN in the SVD`); }
        for (const c of d.clock) {
            lines.push(`- ${c.kind}: ${c.register}.${c.field} bit ${c.bit}${c.page ? ` — ${cite(c.page)}` : ' — page not found'}`);
        }
    }

    if (d.aspects.has('irq')) {
        lines.push('', '## Interrupts (SVD)');
        if (!d.irqs.length) { lines.push('- none listed for this peripheral'); }
        for (const i of d.irqs) {
            lines.push(`- ${i.irq.name} = ${i.irq.value}${i.irq.description ? ` (${i.irq.description})` : ''}${i.page ? ` — ${cite(i.page)}` : ''}`);
        }
    }

    if (d.aspects.has('registers')) {
        lines.push('', `## Registers (SVD → manual page${d.registers.length > d.maxRegisters ? `, first ${d.maxRegisters} of ${d.registers.length}` : ''})`);
        for (const r of d.registerPages) {
            const reg = r.register;
            lines.push(`- ${reg.name} @${hex(reg.offset, 2)}${reg.description ? ` ${reg.description}` : ''}${r.page ? ` — ${cite(r.page)}` : ` — page not found (${r.tokens.slice(0, 3).join(', ')})`}`);
        }
        if (!d.registerPages.length) { lines.push('- no registers in the SVD'); }
    }

    if (d.aspects.has('errata')) {
        lines.push('', '## Errata');
        if (!d.errataDocs) { lines.push('- no errata document in the target\'s set (list_target_docs; fetch_doc if the pdsc links one)'); }
        else if (!d.errata.length) { lines.push(`- ${d.errataDocs} errata document${d.errataDocs === 1 ? '' : 's'} searched, none mentions ${inst.name}`); }
        for (const e of d.errata) { lines.push(`- ${cite(e)}`); }
    }

    const firstRegister = d.registerPages.find(r => r.page)?.page;
    const first: PageRef | undefined = firstRegister ?? (d.chapters[0] ? { doc: d.chapters[0].doc, page: d.chapters[0].section?.start ?? d.chapters[0].chapter.start, heading: '' } : undefined);
    lines.push('');
    lines.push(first
        ? `Next: read_doc_pages { doc: '${first.doc.id}', pages: '${first.page}' }; search_target_docs { query: '<register> <bit>' } for details. Cite as <doc id> <edition> p.<n> §<section>.`
        : `Next: search_target_docs { query: '${inst.name}' }.`);
    return clipValue(lines.join('\n'), ctx.maxChars ?? 8000);
}

export function renderDossierMiss(name: string, miss: DossierMiss, ctx: DossierContext): string {
    const lines: string[] = [`No peripheral named '${name}' in ${ctx.svdRel}.`];
    if (miss.candidates.length) {
        lines.push(`Did you mean${miss.typeKey ? ` (type ${miss.typeKey})` : ''}: ${miss.candidates.slice(0, 12).map(p => p.name).join(', ')}${miss.candidates.length > 12 ? ', …' : ''}? Pass one instance name.`);
    }
    const groups = [...miss.groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    lines.push(`Peripherals by group (${groups.length}): ` + groups.slice(0, 60).map(([g, ps]) => `${g}: ${ps.map(p => p.name).join(', ')}`).join('; ') + (groups.length > 60 ? '; …' : ''));
    return clipValue(lines.join('\n'), ctx.maxChars ?? 8000);
}
