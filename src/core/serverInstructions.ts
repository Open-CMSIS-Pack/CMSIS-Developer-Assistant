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
 * The `instructions` of the MCP initialize result, which most clients keep in
 * the system prompt for the whole session. They open with the tool rules of
 * the tool contract (toolContract.ts, #50): a client that shortens long
 * instructions keeps the beginning, and the rules are what must survive.
 * After them come what the tools are for, the skill to invoke first, how to
 * read a result, and one sentence per optional tool group.
 *
 * Nothing here counts towards `tools/list`, which rides along on every turn.
 * Pure: no I/O, no vscode.
 */

/** The switches the instructions follow; the server options have the same fields. */
export interface InstructionOptions {
    packDocsEnabled?: boolean;
    buildInfoEnabled?: boolean;
}

/** What the tools are for. The problem kinds named here are what make an agent reach for them. */
const PURPOSE =
    'With these tools you debug firmware live on an Arm Cortex-M board through the CMSIS Debugger, chasing problems that ' +
    'only show at run time: faults, crashes, hangs, failing tests, variables with wrong or null values, unexpected output, ' +
    'or a board that simply does not behave.';

/** The skill comes first; say what it brings and why that beats improvising. */
const SKILL_FIRST =
    'Before anything else in such an investigation, invoke the Agent Skill "cmsis-help". It checks the session health ' +
    '(the target, the debug windows, recent problems) and names the get_debug_instructions topic and the knowledge ' +
    'procedure that fit the task, so the tools are used with a plan rather than by guesswork or temporary printf/UART ' +
    'logging in the firmware.';

/** After `SKILL_FIRST`: the one skill installed, and where every other procedure comes from. */
const CORE_SKILLS_ONLY =
    'The only Agent Skill installed is cmsis-help. Every other CMSIS procedure is a unit of the knowledge index: ' +
    'knowledge_search finds it, knowledge_get reads it.';

const WITHOUT_SKILLS =
    'Harnesses that do not load skills should call get_debug_instructions instead.';

/** A client may give up on a call before its wait ends (tester feedback, 2.7.0): that loses the reply, not the work. */
const TIMEOUT_OVERRIDE =
    'Use timeoutMs where the tool schema exposes it: most debugging tools accept up to 60 s; cmsis_action, flash, documentation and '
    + 'build-artefact tools accept up to 600 s. Breakpoint tools and stop_debugging use internal waits; restart_debugging uses the '
    + 'configured session-readiness wait rather than its timeoutMs argument. A wait your client gives up on is no failure: the work '
    + 'goes on, and cmsis_action {action:\'status\'} returns its result.';

/** How to read an outcome (#11); it rides in the initialize result, so tools/list does not grow. */
const READING_RESULTS =
    'A failed call is marked isError and its text starts with an [ERROR_CODE] (NO_SESSION, TARGET_RUNNING, TIMEOUT, …), the next step on '
    + 'the line after; a result with structuredContent status "timeout" or "running" is not a failure — the wait ran out or the work goes on. '
    + 'A running target rejects reads and steps: call pause_execution first.';

/**
 * What used to be two of the tool rules (#50): the rules now hold only the
 * scope and the bans, since the user-level rule files carry them into every
 * project, and these two matter in a session alone.
 */
const WINDOWS_AND_INTERNALS =
    'The control server and the registry files of the extension are internal: never call or read them. With several VS Code '
    + 'windows, list_debug_windows shows which one holds the target and select_debug_window pins it.';

const DOCUMENTATION_ON =
    'The documentation tools (list_target_docs, search_target_docs, read_doc_pages, fetch_doc, get_peripheral_docs) answer ' +
    'from the manuals the target\'s packs ship or link, page-cited; they accept timeoutMs up to 600 s because indexing a ' +
    'manual on first use can take minutes. Use them before asking the user for a datasheet or reference manual ' +
    '(list_target_docs, then fetch_doc for a web-linked one) and instead of reading a PDF into your context: a document the ' +
    'user provides belongs in the workspace docs/ folder or the "Import Document for Current Target" command, then search ' +
    'it. Third-party parts on the board (sensors, ADCs, codecs, radios) are documented the same way: for any part number ' +
    'call list_target_docs first, then search_target_docs; if the datasheet is not listed, find its PDF URL on the web and ' +
    'fetch_doc { url } — never read the PDF yourself.';

const DOCUMENTATION_OFF =
    'Page-cited documentation tools (search over the target\'s pack manuals, datasheets, errata and third-party part ' +
    'datasheets) are available behind the setting cmsis-developer-assistant.packDocs.enabled; suggest enabling it rather ' +
    'than asking the user for a document or reading a PDF yourself.';

const BUILD_ARTEFACTS_ON =
    'The build-artefact tools (list_build_artifacts, get_memory_usage, lookup_symbol, get_section_layout, ' +
    'get_build_diagnostics) read the ELF, linker map and build log of the current target.';

const BUILD_ARTEFACTS_OFF =
    'Build-artefact tools (symbols, sections, memory usage and the error lines of the build log, from the ELF, linker map and ' +
    'build log) are available behind the setting cmsis-developer-assistant.buildInfo.enabled; suggest enabling it rather than ' +
    'running nm or size or grepping the map file yourself.';

/**
 * Experimental. What a skill's description did by itself — load the
 * procedure when its task comes up — has to be said in words when the
 * procedures are knowledge units: look the procedure up before the work.
 * It stands first, ahead of the purpose and everything else.
 */
const KNOWLEDGE_FIRST =
    'Knowledge first: before you start a CMSIS task — a new project, a target or a board layer, the debugger or an FVP setup, ' +
    'pack debug or trace content, a debug or flash session that fails — call knowledge_search with the task\'s name in two or ' +
    'three words (new project, board layer, HardFault), read the procedure it finds with knowledge_get and follow it; do not ' +
    'work such a task from memory. The units route-project, ' +
    'route-bring-up, route-pack and route-debug, where the index has them, say which procedure fits and in which order.';

/**
 * The line the first `get_session_status` adds to the tool rules reminder
 * while the knowledge tools are on.
 */
export const KNOWLEDGE_REMINDER = 'Procedures for CMSIS tasks come from knowledge_search and knowledge_get: look one up before you start.';

/** Experimental; the tool rules name a procedure from knowledge_get next to a CMSIS skill. */
const KNOWLEDGE_ON =
    'The knowledge tools (knowledge_search, knowledge_get, knowledge_expand) hold how-to knowledge: procedures, rules, the ' +
    'causes and fixes of csolution, packchk and svdconv messages, and the documentation the installed packs carry as knowledge ' +
    '(a hit says which pack it came from). For an error message of those tools call knowledge_search ' +
    'with the exact text before guessing or searching the web; results are summaries, so read the unit with knowledge_get ' +
    'before acting. Units marked draft are not reviewed: say so when you rely on one.';

/**
 * The line the first `get_session_status` of a session adds after the status,
 * before the call statistics: by then the instructions may lie far back in
 * the conversation, or have been compacted away.
 */
export const TOOL_RULES_REMINDER =
    'Tool rules: board, build, serial and documentation work goes through these tools, not the shell (see the server instructions).';

/**
 * The instructions without the tool rules. The tails follow the two options
 * alone, not whether the session has a documentation dispatch; a group that
 * is off is named with the setting that enables it.
 */
export function composeInstructions(options: Readonly<InstructionOptions>): string {
    const parts = [KNOWLEDGE_FIRST, PURPOSE, SKILL_FIRST, CORE_SKILLS_ONLY, WITHOUT_SKILLS, TIMEOUT_OVERRIDE, READING_RESULTS, WINDOWS_AND_INTERNALS];
    parts.push(options.packDocsEnabled === true ? DOCUMENTATION_ON : DOCUMENTATION_OFF);
    parts.push(options.buildInfoEnabled === true ? BUILD_ARTEFACTS_ON : BUILD_ARTEFACTS_OFF);
    parts.push(KNOWLEDGE_ON);
    return parts.join(' ');
}

/**
 * The instructions a session is given: `rules` — the rules section of the
 * tool contract, heading included — then the text of `composeInstructions`.
 * Without rules (the contract could not be read) the text stands alone.
 */
export function buildServerInstructions(rules: string | undefined, options: Readonly<InstructionOptions>): string {
    const lead = rules?.trim();
    const text = composeInstructions(options);
    return lead ? `${lead}\n\n${text}` : text;
}
