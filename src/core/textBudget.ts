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
 * Small, pure helpers that keep tool results within a token budget without
 * hiding anything the agent cannot ask for: long values are clipped with the
 * clipped length stated, long lists are cut with the remainder counted, and
 * absolute source paths are shortened to workspace-relative ones.
 */

/** Trim `value` to `maxChars`, stating how much was cut. */
export function clipValue(value: string, maxChars: number): string {
    if (maxChars <= 0 || value.length <= maxChars) { return value; }
    return `${value.slice(0, maxChars)}… (+${value.length - maxChars} chars)`;
}

/** The first `max` items and how many were left out. */
export function truncateList<T>(items: readonly T[], max: number): { shown: T[]; hidden: number } {
    if (max <= 0 || items.length <= max) { return { shown: [...items], hidden: 0 }; }
    return { shown: items.slice(0, max), hidden: items.length - max };
}

/**
 * Make `filePath` relative to the first root that contains it. Paths outside
 * every root (pack sources, toolchain headers) are returned unchanged — a
 * shortened path the agent cannot resolve is worse than a long one.
 */
export function shortenPath(filePath: string, roots: readonly string[]): string {
    for (const root of roots) {
        if (!root) { continue; }
        const prefix = root.endsWith('/') || root.endsWith('\\') ? root : root + (root.includes('\\') && !root.includes('/') ? '\\' : '/');
        if (filePath.startsWith(prefix) && filePath.length > prefix.length) {
            return filePath.slice(prefix.length);
        }
    }
    return filePath;
}
