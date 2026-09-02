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
 * Slice the debugging guide (docs/agent-resources/debug_instructions.md) into
 * topics for get_debug_instructions.
 *
 * The guide is one Markdown file — the MCP resource serves it whole — with
 * sections fenced by HTML comments that Markdown renderers ignore:
 *
 *     <!-- topic: faults | Decode a HardFault: get_fault_info, the stacked frame -->
 *     ## When it faulted
 *     …
 *     <!-- /topic -->
 *
 * Everything before the first marker is the overview. Pure: no vscode, no I/O.
 */

export const TOPICS = ['overview', 'session', 'build', 'breakpoints', 'inspection', 'faults', 'troubleshooting'] as const;
export type Topic = (typeof TOPICS)[number];

export interface TopicSection {
    name: string;
    /** One line, shown in the overview's topic list. */
    blurb: string;
    body: string;
}

const OPEN_MARKER = /<!--\s*topic:\s*([a-z-]+)\s*\|\s*(.*?)\s*-->/g;
const CLOSE_MARKER = '<!-- /topic -->';

/** Split the guide into its overview and fenced sections, in document order. */
export function parseTopics(doc: string): { preamble: string; sections: TopicSection[] } {
    const sections: TopicSection[] = [];
    const open = new RegExp(OPEN_MARKER.source, 'g');
    let firstMarker = -1;
    let match: RegExpExecArray | null;
    while ((match = open.exec(doc)) !== null) {
        if (firstMarker < 0) { firstMarker = match.index; }
        const bodyStart = open.lastIndex;
        const end = doc.indexOf(CLOSE_MARKER, bodyStart);
        if (end < 0) {
            throw new Error(`instruction topic '${match[1]}' is not closed with ${CLOSE_MARKER}`);
        }
        sections.push({ name: match[1], blurb: match[2], body: doc.slice(bodyStart, end).trim() });
        open.lastIndex = end + CLOSE_MARKER.length;
    }
    const preamble = (firstMarker < 0 ? doc : doc.slice(0, firstMarker)).trim();
    return { preamble, sections };
}

export function listTopics(doc: string): Array<Pick<TopicSection, 'name' | 'blurb'>> {
    return parseTopics(doc).sections.map(({ name, blurb }) => ({ name, blurb }));
}

/**
 * The text get_debug_instructions returns. No topic, `overview`, or an unknown
 * name gives the overview plus the topic list — the tool never errors on a
 * name, it steers.
 */
export function sliceTopic(doc: string, topic?: string): string {
    const { preamble, sections } = parseTopics(doc);
    const index = sections.map((s) => `- \`${s.name}\` — ${s.blurb}`).join('\n');
    const overview = `${preamble}\n\n## Topics\n\n` +
        'Call `get_debug_instructions` with `topic` for one section; the full guide is the ' +
        '`cmsis-developer-assistant://docs/debug_instructions` resource.\n\n' +
        `${index}\n`;

    if (!topic || topic === 'overview') {
        return overview;
    }
    const hit = sections.find((s) => s.name === topic);
    if (!hit) {
        return `Unknown topic '${topic}'. Showing the overview.\n\n${overview}`;
    }
    const others = sections.filter((s) => s.name !== topic).map((s) => `\`${s.name}\``).join(', ');
    return `${hit.body}\n\n_Topic \`${hit.name}\` of the debugging guide — ${hit.blurb}. ` +
        `Other topics: \`overview\`, ${others}._\n`;
}
