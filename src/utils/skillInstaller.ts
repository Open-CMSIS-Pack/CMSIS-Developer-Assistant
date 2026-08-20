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
 * Copies catalog skills into the user's personal skills directories and
 * removes the ones they deselected — and nothing else.
 *
 * No `vscode` import: the class takes its roots and paths from the caller
 * so the unit tests can run it against temp directories.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillCatalog, SkillCatalogEntry, SkillSource, parseSkillFrontmatter } from './skillCatalog';

/**
 * Written into every skill directory this extension installs. Its presence
 * is what allows a later sync to replace or remove the directory; a skill
 * directory without it belongs to the user and is never touched.
 */
export const SKILL_MARKER_FILE = '.cmsis-developer-assistant.json';

export interface SkillMarker {
    name: string;
    source: SkillSource;
    /** Upstream commit for cmsis-agent skills; the extension version otherwise. */
    sha: string;
    extensionVersion: string;
    installedAt: string;
    /** Installed as a dependency with `user-invocable: false` injected. */
    hidden: boolean;
}

/**
 * Skills earlier releases installed without a marker. They may be replaced
 * or removed despite having none, provided the frontmatter name agrees with
 * the directory — so a user's unrelated skill of the same name is still safe.
 */
const LEGACY_UNMARKED_SKILLS: ReadonlySet<string> = new Set(['cmsis-debug-live']);

export interface SkillInstallRoots {
    /** Directories to install into and to sweep. */
    install: string[];
    /** Directories only swept for leftovers of earlier releases. */
    sweepOnly: string[];
}

export interface SkillInstallRootsOptions {
    env?: NodeJS.ProcessEnv;
    home?: string;
    exists?: (p: string) => boolean;
}

/**
 * Where skills go, per the Agent Skills convention and each harness's
 * documented lookup:
 *
 * - `~/.agents/skills` — the cross-agent location read by Copilot CLI,
 *   Codex, Cursor, Gemini CLI and VS Code Copilot Chat.
 * - `~/.claude/skills` — Claude Code reads only its own directory, so it
 *   gets a copy when a Claude home exists (`CLAUDE_CONFIG_DIR` honoured).
 * - `$COPILOT_HOME/skills` — only when `COPILOT_HOME` is set: the Copilot
 *   CLI then ignores `~/.agents/skills`.
 * - `~/.copilot/skills` — earlier releases copied here unconditionally; it
 *   is swept for our leftovers but no longer written (Copilot CLI reads
 *   `~/.agents/skills` itself, and two copies show up twice in its menu).
 */
export function getSkillInstallRoots(options: SkillInstallRootsOptions = {}): SkillInstallRoots {
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const exists = options.exists ?? fs.existsSync;

    const install = [path.join(home, '.agents', 'skills')];
    const sweepOnly: string[] = [];

    const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    if (exists(claudeHome)) {
        install.push(path.join(claudeHome, 'skills'));
    }

    const defaultCopilotSkills = path.join(home, '.copilot', 'skills');
    if (env.COPILOT_HOME) {
        install.push(path.join(env.COPILOT_HOME, 'skills'));
        if (path.resolve(env.COPILOT_HOME) !== path.resolve(home, '.copilot')) {
            sweepOnly.push(defaultCopilotSkills);
        }
    } else {
        sweepOnly.push(defaultCopilotSkills);
    }

    return { install, sweepOnly: sweepOnly.filter(dir => !install.includes(dir)) };
}

export interface SkillSyncRecord {
    root: string;
    name: string;
}

export interface SkillSyncReport {
    installed: (SkillSyncRecord & { hidden: boolean })[];
    removed: SkillSyncRecord[];
    /** A same-named skill the user installed themselves; left alone. */
    skippedForeign: SkillSyncRecord[];
    failed: { root: string; name?: string; error: string }[];
}

export function summarizeSkillSync(report: SkillSyncReport): string {
    const parts = [
        `${report.installed.length} installed`,
        `${report.removed.length} removed`,
    ];
    if (report.skippedForeign.length > 0) {
        parts.push(`${report.skippedForeign.length} skipped (user-owned)`);
    }
    if (report.failed.length > 0) {
        parts.push(`${report.failed.length} failed`);
    }
    return parts.join(', ');
}

/**
 * Insert (or replace) `user-invocable: false` in SKILL.md frontmatter. The
 * harnesses that honour it (Claude Code, VS Code, Copilot CLI) drop the
 * skill from the `/` menu while the model can still invoke it by
 * description; the rest ignore unknown fields per the Agent Skills spec.
 */
export function hideFromMenu(markdown: string): string {
    const frontmatter = parseSkillFrontmatter(markdown);
    if (!frontmatter) {
        return markdown;
    }
    const fence = /^---\r?\n([\s\S]*?)(\r?\n)---/.exec(markdown);
    if (!fence) {
        return markdown;
    }
    const newline = fence[2];
    const body = fence[1];
    const updated = /^user-invocable:.*$/m.test(body)
        ? body.replace(/^user-invocable:.*$/m, 'user-invocable: false')
        : `${body}${newline}user-invocable: false`;
    return `---${newline}${updated}${newline}---${markdown.slice(fence[0].length)}`;
}

export class SkillInstaller {
    constructor(
        private readonly extensionPath: string,
        private readonly extensionVersion: string,
        private readonly roots: SkillInstallRoots,
    ) {}

    /**
     * Bring every root in line with `explicit` (visible) + `implied`
     * (hidden). Best-effort throughout: each root and each skill fails on
     * its own and is reported, never thrown — not being able to write a
     * skill file must never take activation down with it.
     */
    public async sync(catalog: SkillCatalog, explicit: readonly string[], implied: readonly string[]): Promise<SkillSyncReport> {
        const report: SkillSyncReport = { installed: [], removed: [], skippedForeign: [], failed: [] };
        const byName = new Map(catalog.skills.map(entry => [entry.name, entry]));

        const desired = new Map<string, { entry: SkillCatalogEntry; hidden: boolean }>();
        for (const name of explicit) {
            const entry = byName.get(name);
            if (entry) {
                desired.set(name, { entry, hidden: false });
            }
        }
        for (const name of implied) {
            const entry = byName.get(name);
            if (entry && !desired.has(name)) {
                desired.set(name, { entry, hidden: true });
            }
        }

        for (const root of this.roots.install) {
            try {
                await fs.promises.mkdir(root, { recursive: true });
            } catch (error) {
                report.failed.push({ root, error: describe(error) });
                continue;
            }
            for (const { entry, hidden } of desired.values()) {
                await this.installOne(root, entry, hidden, catalog.source.sha, report);
            }
            await this.sweep(root, desired, report);
        }

        for (const root of this.roots.sweepOnly) {
            await this.sweep(root, new Map(), report);
        }

        return report;
    }

    private async installOne(
        root: string,
        entry: SkillCatalogEntry,
        hidden: boolean,
        upstreamSha: string,
        report: SkillSyncReport,
    ): Promise<void> {
        const source = path.join(this.extensionPath, entry.path);
        const destination = path.join(root, entry.name);
        const staging = path.join(root, `.${entry.name}.tmp-${process.pid}`);

        try {
            if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
                report.failed.push({ root, name: entry.name, error: `bundled skill missing at ${source}` });
                return;
            }

            if (await this.isForeign(destination, entry.name)) {
                report.skippedForeign.push({ root, name: entry.name });
                return;
            }

            await fs.promises.rm(staging, { recursive: true, force: true });
            await fs.promises.cp(source, staging, { recursive: true });

            if (hidden) {
                const skillFile = path.join(staging, 'SKILL.md');
                const content = await fs.promises.readFile(skillFile, 'utf8');
                await fs.promises.writeFile(skillFile, hideFromMenu(content), 'utf8');
            }

            const marker: SkillMarker = {
                name: entry.name,
                source: entry.source,
                sha: entry.source === 'cmsis-agent' ? upstreamSha : this.extensionVersion,
                extensionVersion: this.extensionVersion,
                installedAt: new Date().toISOString(),
                hidden,
            };
            await fs.promises.writeFile(path.join(staging, SKILL_MARKER_FILE), JSON.stringify(marker, null, 2) + '\n', 'utf8');

            // Replace rather than merge: a reference file dropped upstream
            // must not linger in the user's copy.
            await fs.promises.rm(destination, { recursive: true, force: true });
            await fs.promises.rename(staging, destination);
            report.installed.push({ root, name: entry.name, hidden });
        } catch (error) {
            report.failed.push({ root, name: entry.name, error: describe(error) });
            await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /** A skill directory we did not write and may not overwrite. */
    private async isForeign(directory: string, name: string): Promise<boolean> {
        if (!fs.existsSync(path.join(directory, 'SKILL.md'))) {
            return false;
        }
        if (fs.existsSync(path.join(directory, SKILL_MARKER_FILE))) {
            return false;
        }
        return !(await this.isLegacyOurs(directory, name));
    }

    private async isLegacyOurs(directory: string, name: string): Promise<boolean> {
        if (!LEGACY_UNMARKED_SKILLS.has(name)) {
            return false;
        }
        try {
            const frontmatter = parseSkillFrontmatter(await fs.promises.readFile(path.join(directory, 'SKILL.md'), 'utf8'));
            return frontmatter?.name === name;
        } catch {
            return false;
        }
    }

    /** Remove directories we installed that are no longer wanted. */
    private async sweep(root: string, desired: ReadonlyMap<string, unknown>, report: SkillSyncReport): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(root, { withFileTypes: true });
        } catch {
            return; // root does not exist — nothing of ours can be there
        }

        for (const dirent of entries) {
            if (!dirent.isDirectory() || dirent.name.startsWith('.') || desired.has(dirent.name)) {
                continue;
            }
            const directory = path.join(root, dirent.name);
            try {
                if (!(await this.isOurs(directory, dirent.name))) {
                    continue;
                }
                await fs.promises.rm(directory, { recursive: true, force: true });
                report.removed.push({ root, name: dirent.name });
            } catch (error) {
                report.failed.push({ root, name: dirent.name, error: describe(error) });
            }
        }
    }

    private async isOurs(directory: string, name: string): Promise<boolean> {
        const markerPath = path.join(directory, SKILL_MARKER_FILE);
        if (fs.existsSync(markerPath)) {
            try {
                const marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as Partial<SkillMarker>;
                return marker.name === name;
            } catch {
                return false; // unreadable marker: leave it alone
            }
        }
        return this.isLegacyOurs(directory, name);
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
