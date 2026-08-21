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
 * The "install the CMSIS AI Skills?" nudge — the decision, not the toast.
 *
 * Pure module (no `vscode`), so the rule that decides whether the prompt is
 * due can be tested without an extension host. The manager gathers the
 * inputs (settings, globalState, which agents have the server registered)
 * and shows the notification; this decides.
 */

/** globalState key: epoch ms of the last time the prompt was shown (or dismissed). */
export const SKILLS_PROMPT_SHOWN_KEY = 'cmsis-developer-assistant.skillsPrompt.lastShownAt';

/** "Monthly": the prompt is not repeated before this much time has passed. */
export const SKILLS_PROMPT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export const SKILL_PROMPT_BUTTONS = {
    select: 'Select Skills',
    later: 'Later',
    never: 'Don\'t ask again',
} as const;

export interface SkillPromptContext {
    /** `aiSkills.promptOnDetect` */
    promptEnabled: boolean;
    /** `aiSkills.enabled` — with the pack off there is nothing to offer. */
    packEnabled: boolean;
    /** The first-run setup has not run yet; it asks the same question itself. */
    firstRunPending: boolean;
    /** Antigravity / Gemini manage MCP servers themselves; our prompts are noise there. */
    hostManaged: boolean;
    /** Display names of the supported agents whose config registers the MCP server. */
    agentsWithServer: readonly string[];
    /** A pack skill (router or individual) is already in `installedSkills`. */
    packSkillSelected: boolean;
    /** Last time the prompt was shown, epoch ms; `undefined` = never. */
    lastShownAt: number | undefined;
    /** Epoch ms. */
    now: number;
}

export type SkillPromptSuppressedReason =
    | 'disabled'
    | 'pack-disabled'
    | 'first-run-pending'
    | 'host-managed'
    | 'no-agent'
    | 'already-selected'
    | 'snoozed';

export type SkillPromptDecision =
    | { show: true }
    | { show: false; reason: SkillPromptSuppressedReason };

/**
 * Whether the install prompt is due. The checks run in this order so the
 * logged reason names the most fundamental blocker — a user who turned the
 * prompt off is told "disabled", not "snoozed".
 */
export function decideSkillPrompt(context: SkillPromptContext): SkillPromptDecision {
    if (!context.promptEnabled) {
        return { show: false, reason: 'disabled' };
    }
    if (!context.packEnabled) {
        return { show: false, reason: 'pack-disabled' };
    }
    if (context.firstRunPending) {
        return { show: false, reason: 'first-run-pending' };
    }
    if (context.hostManaged) {
        return { show: false, reason: 'host-managed' };
    }
    if (context.agentsWithServer.length === 0) {
        return { show: false, reason: 'no-agent' };
    }
    if (context.packSkillSelected) {
        return { show: false, reason: 'already-selected' };
    }
    if (context.lastShownAt !== undefined && context.now - context.lastShownAt < SKILLS_PROMPT_INTERVAL_MS) {
        return { show: false, reason: 'snoozed' };
    }
    return { show: true };
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
    if (names.length <= 1) {
        return names[0] ?? '';
    }
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function skillPromptMessage(agentDisplayNames: readonly string[]): string {
    return `CMSIS Developer Assistant: install the CMSIS AI Skills for ${joinNames(agentDisplayNames)}? ` +
        'They add CMSIS project setup, device debug knowledge and CMSIS-Pack authoring workflows as slash commands.';
}
