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
 * A minimal, non-validating XML reader — enough for a pdsc: elements,
 * attributes, text, comments, CDATA, processing instructions, the five
 * predefined entities and numeric character references. No namespaces
 * handling beyond keeping the prefix in the tag name, no DTD.
 *
 * Kept dependency-free on purpose: the CMSIS Developer Assistant parses its
 * SVDs the same way, and a pdsc is a few hundred kilobytes at most.
 */

export interface XmlElement {
    tag: string;
    attrs: Record<string, string>;
    children: XmlElement[];
    /** Concatenated direct text nodes, whitespace-trimmed. */
    text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
    if (s.indexOf('&') < 0) { return s; }
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return ENTITIES[body] ?? whole;
    });
}

export class XmlParseError extends Error {
    constructor(message: string, public readonly offset: number) {
        super(`${message} at offset ${offset}`);
    }
}

const NAME_RE = /[A-Za-z_:][\w.:-]*/y;
const ATTR_NAME_RE = /[^\s=/>]+/y;

/** Parse a document and return its root element. */
export function parseXml(src: string): XmlElement {
    const root: XmlElement = { tag: '#document', attrs: {}, children: [], text: '' };
    const stack: XmlElement[] = [root];
    const textParts: string[][] = [[]];
    let i = 0;
    const n = src.length;

    const current = () => stack[stack.length - 1];
    const flushText = () => {
        const parts = textParts[textParts.length - 1];
        if (parts.length) {
            const el = current();
            el.text = (el.text ? el.text + ' ' : '') + decodeEntities(parts.join('')).trim();
            parts.length = 0;
        }
    };

    while (i < n) {
        const lt = src.indexOf('<', i);
        if (lt < 0) {
            textParts[textParts.length - 1].push(src.slice(i));
            break;
        }
        if (lt > i) { textParts[textParts.length - 1].push(src.slice(i, lt)); }

        if (src.startsWith('<!--', lt)) {
            const end = src.indexOf('-->', lt + 4);
            if (end < 0) { throw new XmlParseError('unterminated comment', lt); }
            i = end + 3;
            continue;
        }
        if (src.startsWith('<![CDATA[', lt)) {
            const end = src.indexOf(']]>', lt + 9);
            if (end < 0) { throw new XmlParseError('unterminated CDATA', lt); }
            // CDATA is literal: push already-decoded text by escaping ampersands.
            textParts[textParts.length - 1].push(src.slice(lt + 9, end).replace(/&/g, '&amp;'));
            i = end + 3;
            continue;
        }
        if (src.startsWith('<?', lt)) {
            const end = src.indexOf('?>', lt + 2);
            if (end < 0) { throw new XmlParseError('unterminated processing instruction', lt); }
            i = end + 2;
            continue;
        }
        if (src.startsWith('<!', lt)) {
            const end = src.indexOf('>', lt + 2);
            if (end < 0) { throw new XmlParseError('unterminated declaration', lt); }
            i = end + 1;
            continue;
        }
        if (src.startsWith('</', lt)) {
            flushText();
            NAME_RE.lastIndex = lt + 2;
            const m = NAME_RE.exec(src);
            if (!m) { throw new XmlParseError('bad closing tag', lt); }
            const end = src.indexOf('>', NAME_RE.lastIndex);
            if (end < 0) { throw new XmlParseError('unterminated closing tag', lt); }
            const el = current();
            if (el.tag !== m[0]) { throw new XmlParseError(`closing </${m[0]}> does not match <${el.tag}>`, lt); }
            stack.pop();
            textParts.pop();
            i = end + 1;
            continue;
        }

        // Opening tag.
        flushText();
        NAME_RE.lastIndex = lt + 1;
        const nameMatch = NAME_RE.exec(src);
        if (!nameMatch) { throw new XmlParseError('bad element name', lt); }
        const el: XmlElement = { tag: nameMatch[0], attrs: {}, children: [], text: '' };
        let p = NAME_RE.lastIndex;
        let selfClosing = false;
        for (;;) {
            while (p < n && /\s/.test(src[p])) { p++; }
            if (p >= n) { throw new XmlParseError('unterminated start tag', lt); }
            if (src[p] === '>') { p++; break; }
            if (src[p] === '/' && src[p + 1] === '>') { selfClosing = true; p += 2; break; }
            ATTR_NAME_RE.lastIndex = p;
            const an = ATTR_NAME_RE.exec(src);
            if (!an) { throw new XmlParseError('bad attribute', p); }
            p = ATTR_NAME_RE.lastIndex;
            while (p < n && /\s/.test(src[p])) { p++; }
            let value = '';
            if (src[p] === '=') {
                p++;
                while (p < n && /\s/.test(src[p])) { p++; }
                const q = src[p];
                if (q === '"' || q === "'") {
                    const end = src.indexOf(q, p + 1);
                    if (end < 0) { throw new XmlParseError('unterminated attribute value', p); }
                    value = src.slice(p + 1, end);
                    p = end + 1;
                } else {
                    const m2 = /[^\s>]*/y;
                    m2.lastIndex = p;
                    const vm = m2.exec(src);
                    value = vm ? vm[0] : '';
                    p += value.length;
                }
            }
            el.attrs[an[0]] = decodeEntities(value);
        }
        current().children.push(el);
        if (!selfClosing) {
            stack.push(el);
            textParts.push([]);
        }
        i = p;
    }
    flushText();
    if (stack.length !== 1) { throw new XmlParseError(`unclosed <${current().tag}>`, n); }
    const first = root.children[0];
    if (!first) { throw new XmlParseError('no root element', 0); }
    return first;
}

/** Direct children with the given tag. */
export function childrenOf(el: XmlElement, tag: string): XmlElement[] {
    return el.children.filter(c => c.tag === tag);
}

export function firstChild(el: XmlElement, tag: string): XmlElement | undefined {
    return el.children.find(c => c.tag === tag);
}
