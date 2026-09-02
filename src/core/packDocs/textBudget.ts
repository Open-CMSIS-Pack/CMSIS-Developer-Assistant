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
 * Same helpers as the CMSIS Developer Assistant's `core/textBudget.ts`, so
 * the merge can drop this file and import theirs.
 */

export function clipValue(value: string, maxChars: number): string {
    if (value.length <= maxChars) { return value; }
    return `${value.slice(0, Math.max(0, maxChars))}… (${value.length - maxChars} more chars)`;
}

export function truncateList<T>(items: readonly T[], max: number): { shown: T[]; hidden: number } {
    if (items.length <= max) { return { shown: [...items], hidden: 0 }; }
    return { shown: items.slice(0, max), hidden: items.length - max };
}

export function formatBytes(n: number | undefined): string {
    if (n === undefined) { return '?'; }
    if (n < 1024) { return `${n} B`; }
    if (n < 1024 * 1024) { return `${(n / 1024).toFixed(0)} kB`; }
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
