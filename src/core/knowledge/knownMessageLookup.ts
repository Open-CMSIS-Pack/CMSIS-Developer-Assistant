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
 * The window's link from a failed build to the knowledge index: the build
 * diagnosis asks here for the lines that name the unit of a known error
 * message. The window sets the lookup at activation when the knowledge
 * tools are on; without one there are no lines. No `vscode` import.
 */

/** Lines for the messages the knowledge index has a complete unit for, in the context of the window's active target. */
export type KnownMessageLookup = (messages: readonly string[]) => Promise<string[]>;

let lookup: KnownMessageLookup | undefined;

/** Set, or with undefined clear, the window's lookup. */
export function setKnownMessageLookup(next: KnownMessageLookup | undefined): void {
    lookup = next;
}

/** The lines for `messages`; none without a lookup. */
export function knownMessageLines(messages: readonly string[]): Promise<string[]> {
    return lookup ? lookup(messages) : Promise.resolve([]);
}
