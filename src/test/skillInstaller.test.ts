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

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillCatalog, installSet } from '../utils/skillCatalog';
import {
    SKILL_MARKER_FILE,
    SkillInstaller,
    SkillMarker,
    getProjectSkillInstallRoots,
    getSkillInstallRoots,
    hideFromMenu,
    withoutInstallRoots,
} from '../utils/skillInstaller';

/**
 * The installer writes into the user's home directory, next to skills they
 * installed themselves. The rules that keep that safe — marker-guarded
 * removal, never overwriting a foreign directory, replace-not-merge — are
 * what these tests pin. Everything runs in temp directories; the real home
 * is never touched.
 */
suite('Agent skill installer', () => {

    let tmp: string;
    let extensionPath: string;
    let rootA: string;
    let rootB: string;

    /** Every entry installed, as a release that installs the whole catalog would. */
    const allInstalled = (c: SkillCatalog): SkillCatalog => ({ ...c, skills: c.skills.map(skill => ({ ...skill, installed: true })) });

    const catalog: SkillCatalog = {
        schemaVersion: 1,
        source: { repository: 'r', sha: 'feedface', sourcePath: 'p' },
        skills: [
            { name: 'cmsis-debug-live', description: 'bundled', category: 'debug', kind: 'skill', source: 'bundled', path: 'skills/cmsis-debug-live', dependsOn: [], invocable: true, installed: false },
            { name: 'cmsis-help', description: 'bundled help', category: 'help', kind: 'skill', source: 'bundled', path: 'skills/cmsis-help', dependsOn: [], invocable: true, installed: true },
            { name: 'r-pack', description: 'router', category: 'pack', kind: 'router', source: 'generated', path: 'skills/r-pack', dependsOn: ['gen'], invocable: true, installed: false },
            { name: 'gen', description: 'gen', category: 'pack', kind: 'skill', source: 'cmsis-skills', path: 'skills/cmsis-skills/gen', dependsOn: [], invocable: false, installed: false },
        ],
    };

    const writeSkill = (dir: string, name: string, extraFiles: Record<string, string> = {}): void => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does things.\n---\n# ${name}\n`);
        for (const [rel, content] of Object.entries(extraFiles)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        }
    };

    const homeRoots = () => ({ install: [rootA, rootB], sweepOnly: [] });
    // No pid is alive as far as the installer knows, so staging of the fixture pids is always sweepable.
    const installer = (isAlive: (pid: number) => boolean = () => false): SkillInstaller => new SkillInstaller(extensionPath, '9.9.9', isAlive);

    const readMarker = (root: string, name: string): SkillMarker =>
        JSON.parse(fs.readFileSync(path.join(root, name, SKILL_MARKER_FILE), 'utf8'));

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-skill-installer-test-'));
        extensionPath = path.join(tmp, 'extension');
        rootA = path.join(tmp, 'home', '.agents', 'skills');
        rootB = path.join(tmp, 'home', '.claude', 'skills');
        writeSkill(path.join(extensionPath, 'skills', 'cmsis-debug-live'), 'cmsis-debug-live', { 'references/guide.md': 'guide' });
        writeSkill(path.join(extensionPath, 'skills', 'cmsis-help'), 'cmsis-help');
        writeSkill(path.join(extensionPath, 'skills', 'r-pack'), 'r-pack', { 'agents/openai.yaml': 'interface: {}' });
        writeSkill(path.join(extensionPath, 'skills', 'cmsis-skills', 'gen'), 'gen', { 'references/contract.md': 'v1' });
    });

    teardown(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('a help-only catalog removes obsolete managed skills without their source directories', async () => {
        const previous = installSet(allInstalled(catalog));
        await installer().sync(homeRoots(), catalog, previous.visible, previous.hidden);
        writeSkill(path.join(rootA, 'personal-workflow'), 'personal-workflow');
        const current: SkillCatalog = { schemaVersion: 1, skills: catalog.skills.filter(skill => skill.name === 'cmsis-help') };
        for (const skill of catalog.skills.filter(skill => skill.name !== 'cmsis-help')) {
            fs.rmSync(path.join(extensionPath, skill.path), { recursive: true, force: true });
        }
        const report = await installer().sync(homeRoots(), current, ['cmsis-help'], []);
        assert.deepStrictEqual(report.failed, []);
        for (const root of [rootA, rootB]) {
            assert.ok(fs.existsSync(path.join(root, 'cmsis-help', SKILL_MARKER_FILE)));
            for (const name of ['cmsis-debug-live', 'r-pack', 'gen']) {
                assert.ok(!fs.existsSync(path.join(root, name)), name);
            }
        }
        assert.ok(fs.existsSync(path.join(rootA, 'personal-workflow', 'SKILL.md')));
    });

    test('installs the explicit picks into every root with a marker', async () => {
        const report = await installer().sync(homeRoots(), catalog, ['cmsis-debug-live'], []);
        assert.deepStrictEqual(report.failed, []);
        for (const root of [rootA, rootB]) {
            assert.ok(fs.existsSync(path.join(root, 'cmsis-debug-live', 'SKILL.md')));
            assert.ok(fs.existsSync(path.join(root, 'cmsis-debug-live', 'references', 'guide.md')));
            const marker = readMarker(root, 'cmsis-debug-live');
            assert.strictEqual(marker.name, 'cmsis-debug-live');
            assert.strictEqual(marker.hidden, false);
            assert.strictEqual(marker.extensionVersion, '9.9.9');
            assert.strictEqual(marker.sha, '9.9.9', 'bundled skills are versioned by the extension');
        }
        assert.strictEqual(report.installed.length, 2);
    });

    test('upstream skills carry the upstream commit in their marker', async () => {
        await installer().sync(homeRoots(), catalog, ['gen'], []);
        assert.strictEqual(readMarker(rootA, 'gen').sha, 'feedface');
        assert.strictEqual(readMarker(rootA, 'gen').source, 'cmsis-skills');
    });

    test('implied skills are installed hidden from the slash menu, explicit ones are not', async () => {
        await installer().sync(homeRoots(), catalog, ['r-pack'], ['gen']);
        const router = fs.readFileSync(path.join(rootA, 'r-pack', 'SKILL.md'), 'utf8');
        const member = fs.readFileSync(path.join(rootA, 'gen', 'SKILL.md'), 'utf8');
        assert.ok(!/user-invocable/.test(router), 'the router stays user-invocable');
        assert.match(member, /^user-invocable: false$/m);
        assert.match(member, /^---\nname: gen\ndescription: gen does things\.\nuser-invocable: false\n---\n# gen\n$/,
            'the flag is injected inside the frontmatter and nothing else changes');
        assert.strictEqual(readMarker(rootA, 'gen').hidden, true);
    });

    test('a skill promoted from implied to explicit becomes visible again', async () => {
        await installer().sync(homeRoots(), catalog, ['r-pack'], ['gen']);
        await installer().sync(homeRoots(), catalog, ['r-pack', 'gen'], []);
        assert.ok(!/user-invocable/.test(fs.readFileSync(path.join(rootA, 'gen', 'SKILL.md'), 'utf8')));
        assert.strictEqual(readMarker(rootA, 'gen').hidden, false);
    });

    test('re-sync replaces the directory, so files dropped from the bundle disappear', async () => {
        await installer().sync(homeRoots(), catalog, ['gen'], []);
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'references', 'contract.md')));
        fs.rmSync(path.join(extensionPath, 'skills', 'cmsis-skills', 'gen', 'references'), { recursive: true });
        await installer().sync(homeRoots(), catalog, ['gen'], []);
        assert.ok(!fs.existsSync(path.join(rootA, 'gen', 'references', 'contract.md')), 'stale file survived');
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'SKILL.md')));
        assert.ok(!fs.existsSync(path.join(rootA, `.gen.tmp-${process.pid}`)), 'staging dir left behind');
    });

    test('deselecting removes only directories this extension installed', async () => {
        await installer().sync(homeRoots(), catalog, ['cmsis-debug-live', 'gen'], []);
        // A user's own skill, no marker:
        writeSkill(path.join(rootA, 'my-own-skill'), 'my-own-skill');
        // A user's own skill that happens to share a catalog name, no marker:
        writeSkill(path.join(rootB, 'gen'), 'gen');
        fs.rmSync(path.join(rootB, 'gen', SKILL_MARKER_FILE), { force: true });

        const report = await installer().sync(homeRoots(), catalog, ['cmsis-debug-live'], []);

        assert.ok(!fs.existsSync(path.join(rootA, 'gen')), 'our marked copy should be removed');
        assert.ok(fs.existsSync(path.join(rootA, 'my-own-skill', 'SKILL.md')), 'user skill must survive');
        assert.ok(fs.existsSync(path.join(rootB, 'gen', 'SKILL.md')), 'user skill sharing a catalog name must survive');
        assert.deepStrictEqual(report.removed, [{ root: rootA, name: 'gen' }]);
    });

    test('a skill dropped from the catalog in a later release is removed from every root on the next sync', async () => {
        const whole = installSet(allInstalled(catalog));
        await installer().sync(homeRoots(), catalog, whole.visible, whole.hidden);
        assert.ok(fs.existsSync(path.join(rootA, 'r-pack', 'SKILL.md')));
        assert.strictEqual(readMarker(rootA, 'gen').hidden, true);
        writeSkill(path.join(rootA, 'my-own-skill'), 'my-own-skill');

        const slimmer: SkillCatalog = { ...catalog, skills: catalog.skills.filter(entry => entry.category !== 'pack') };
        const remaining = installSet(allInstalled(slimmer));
        const report = await installer().sync(homeRoots(), slimmer, remaining.visible, remaining.hidden);

        for (const root of [rootA, rootB]) {
            assert.ok(!fs.existsSync(path.join(root, 'r-pack')), 'router should be removed');
            assert.ok(!fs.existsSync(path.join(root, 'gen')), 'member should be removed');
            assert.ok(fs.existsSync(path.join(root, 'cmsis-debug-live', 'SKILL.md')), 'bundled skill stays');
            assert.ok(fs.existsSync(path.join(root, 'cmsis-help', 'SKILL.md')), 'bundled help stays');
        }
        assert.ok(fs.existsSync(path.join(rootA, 'my-own-skill', 'SKILL.md')), 'user skill must survive');
        assert.deepStrictEqual(report.removed.map(r => r.name).sort(), ['gen', 'gen', 'r-pack', 'r-pack']);
    });

    test('never overwrites a foreign skill directory of the same name', async () => {
        writeSkill(path.join(rootA, 'gen'), 'gen', { 'mine.md': 'keep me' });
        const report = await installer().sync(homeRoots(), catalog, ['gen'], []);
        assert.deepStrictEqual(report.skippedForeign, [{ root: rootA, name: 'gen' }]);
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'mine.md')));
        assert.ok(!fs.existsSync(path.join(rootA, 'gen', SKILL_MARKER_FILE)));
        // The other root, where nothing was in the way, is installed normally.
        assert.ok(fs.existsSync(path.join(rootB, 'gen', SKILL_MARKER_FILE)));
    });

    test('an unmarked cmsis-debug-live from an earlier release is replaced and can be removed', async () => {
        writeSkill(path.join(rootA, 'cmsis-debug-live'), 'cmsis-debug-live', { 'old.md': 'from 2.0' });
        await installer().sync(homeRoots(), catalog, ['cmsis-debug-live'], []);
        assert.ok(!fs.existsSync(path.join(rootA, 'cmsis-debug-live', 'old.md')));
        assert.ok(fs.existsSync(path.join(rootA, 'cmsis-debug-live', SKILL_MARKER_FILE)));

        writeSkill(path.join(rootB, 'cmsis-debug-live'), 'cmsis-debug-live');
        fs.rmSync(path.join(rootB, 'cmsis-debug-live', SKILL_MARKER_FILE), { force: true });
        const report = await installer().sync(homeRoots(), catalog, [], []);
        assert.ok(!fs.existsSync(path.join(rootB, 'cmsis-debug-live')));
        assert.ok(report.removed.some(r => r.root === rootB && r.name === 'cmsis-debug-live'));
    });

    test('an unmarked directory named cmsis-debug-live with a different skill inside is left alone', async () => {
        writeSkill(path.join(rootA, 'cmsis-debug-live'), 'something-else');
        const report = await installer().sync(homeRoots(), catalog, ['cmsis-debug-live'], []);
        assert.deepStrictEqual(report.skippedForeign, [{ root: rootA, name: 'cmsis-debug-live' }]);
    });

    test('sweep-only roots lose our leftovers but are not written to', async () => {
        const legacy = path.join(tmp, 'home', '.copilot', 'skills');
        writeSkill(path.join(legacy, 'cmsis-debug-live'), 'cmsis-debug-live');
        writeSkill(path.join(legacy, 'theirs'), 'theirs');
        await installer().sync({ install: [rootA], sweepOnly: [legacy] }, catalog, ['cmsis-debug-live', 'gen'], []);
        assert.ok(!fs.existsSync(path.join(legacy, 'cmsis-debug-live')));
        assert.ok(fs.existsSync(path.join(legacy, 'theirs', 'SKILL.md')));
        assert.ok(!fs.existsSync(path.join(legacy, 'gen')));
    });

    test('a missing bundled skill is reported, not thrown', async () => {
        const broken: SkillCatalog = { ...catalog, skills: [...catalog.skills, { name: 'ghost', description: '', category: 'devops', kind: 'skill', source: 'cmsis-skills', path: 'skills/cmsis-skills/ghost', dependsOn: [], invocable: true, installed: false }] };
        const report = await installer().sync(homeRoots(), broken, ['ghost', 'gen'], []);
        assert.strictEqual(report.failed.filter(f => f.name === 'ghost').length, 2);
        assert.ok(fs.existsSync(path.join(rootA, 'gen', 'SKILL.md')), 'other skills still install');
    });

    test('an unwritable root fails on its own and the others still install', async function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) {
            this.skip();
        }
        const locked = path.join(tmp, 'locked');
        fs.mkdirSync(locked, { mode: 0o500 });
        try {
            const report = await installer().sync({ install: [path.join(locked, 'skills'), rootA], sweepOnly: [] }, catalog, ['gen'], []);
            assert.ok(report.failed.some(f => f.root === path.join(locked, 'skills')));
            assert.ok(fs.existsSync(path.join(rootA, 'gen', 'SKILL.md')));
        } finally {
            fs.chmodSync(locked, 0o700);
        }
    });

    test('staging left by an interrupted sync is removed on the next install of that skill', async () => {
        writeSkill(path.join(rootA, '.gen.tmp-12345'), 'gen');
        writeSkill(path.join(rootA, '.gen.tmp-67890'), 'gen');
        writeSkill(path.join(rootA, '.other.tmp-1'), 'other'); // not ours to judge: a different skill's staging
        await installer().sync(homeRoots(), catalog, ['gen'], []);
        assert.ok(!fs.existsSync(path.join(rootA, '.gen.tmp-12345')));
        assert.ok(!fs.existsSync(path.join(rootA, '.gen.tmp-67890')));
        assert.ok(fs.existsSync(path.join(rootA, '.other.tmp-1')));
        assert.ok(fs.existsSync(path.join(rootA, 'gen', SKILL_MARKER_FILE)));
    });

    test('staging of a window that is still syncing is left alone', async () => {
        writeSkill(path.join(rootA, '.gen.tmp-12345'), 'gen');
        writeSkill(path.join(rootA, '.gen.tmp-67890'), 'gen');
        writeSkill(path.join(rootA, `.gen.tmp-${process.pid}`), 'gen'); // this process's own (a re-entrant sync)
        const report = await installer(pid => pid === 12345).sync(homeRoots(), catalog, ['gen'], []);
        assert.ok(fs.existsSync(path.join(rootA, '.gen.tmp-12345')), 'a live peer keeps its staging');
        assert.ok(!fs.existsSync(path.join(rootA, '.gen.tmp-67890')), 'a dead pid is swept');
        assert.ok(fs.existsSync(path.join(rootA, 'gen', SKILL_MARKER_FILE)));
        assert.deepStrictEqual(report.failed, []);
    });

    test('nothing to install: the roots are swept, never created', async () => {
        const project = path.join(tmp, 'project');
        fs.mkdirSync(project);
        const roots = { install: [path.join(project, '.agents', 'skills'), path.join(project, '.claude', 'skills')], sweepOnly: [] };
        const report = await installer().sync(roots, catalog, [], []);
        assert.deepStrictEqual(report, { installed: [], removed: [], skippedForeign: [], failed: [] });
        assert.deepStrictEqual(fs.readdirSync(project), [], 'no .agents or .claude directory may appear');
    });

    test('the project roots a 2.5.x selection wrote are swept: our marked copies go, the project\'s own skill survives', async () => {
        const project = path.join(tmp, 'project');
        const agents = path.join(project, '.agents', 'skills');
        const claude = path.join(project, '.claude', 'skills');
        writeSkill(path.join(agents, 'theirs'), 'theirs');
        for (const root of [agents, claude]) {
            writeSkill(path.join(root, 'gen'), 'gen');
            fs.writeFileSync(path.join(root, 'gen', SKILL_MARKER_FILE), JSON.stringify({ name: 'gen' }));
        }
        const whole = installSet(allInstalled(catalog));
        const report = await installer().sync({ install: [rootA], sweepOnly: [agents, claude] }, catalog, whole.visible, whole.hidden);
        assert.deepStrictEqual(report.removed.map(r => r.root).sort(), [agents, claude].sort());
        assert.ok(!fs.existsSync(path.join(agents, 'gen')) && !fs.existsSync(path.join(claude, 'gen')));
        assert.ok(fs.existsSync(path.join(agents, 'theirs', 'SKILL.md')), 'the project\'s own skill survives');
        assert.ok(!fs.existsSync(path.join(agents, 'r-pack')), 'a sweep-only root is never written');
        assert.ok(fs.existsSync(path.join(rootA, 'r-pack', SKILL_MARKER_FILE)), 'the personal root gets the catalog');
    });

    suite('hideFromMenu', () => {
        test('appends the flag inside the frontmatter', () => {
            assert.strictEqual(hideFromMenu('---\nname: a\ndescription: b\n---\nbody\n'),
                '---\nname: a\ndescription: b\nuser-invocable: false\n---\nbody\n');
        });

        test('replaces an existing flag and keeps CRLF', () => {
            assert.strictEqual(hideFromMenu('---\r\nname: a\r\nuser-invocable: true\r\ndescription: b\r\n---\r\nbody'),
                '---\r\nname: a\r\nuser-invocable: false\r\ndescription: b\r\n---\r\nbody');
        });

        test('leaves a file without frontmatter untouched', () => {
            assert.strictEqual(hideFromMenu('# no frontmatter\n'), '# no frontmatter\n');
        });
    });

    suite('getSkillInstallRoots', () => {
        const home = '/home/u';
        const roots = (existing: string[], env: NodeJS.ProcessEnv = {}) =>
            getSkillInstallRoots({ env, home, exists: p => existing.includes(p) });

        test('always ~/.agents/skills; ~/.copilot/skills is only swept', () => {
            assert.deepStrictEqual(roots([]), {
                install: [path.join(home, '.agents', 'skills')],
                sweepOnly: [path.join(home, '.copilot', 'skills')],
            });
        });

        test('adds ~/.claude/skills when a Claude home exists, honouring CLAUDE_CONFIG_DIR', () => {
            assert.ok(roots([path.join(home, '.claude')]).install.includes(path.join(home, '.claude', 'skills')));
            const custom = roots(['/cfg/claude'], { CLAUDE_CONFIG_DIR: '/cfg/claude' });
            assert.ok(custom.install.includes(path.join('/cfg/claude', 'skills')));
            assert.ok(!custom.install.includes(path.join(home, '.claude', 'skills')));
        });

        test('project roots of 2.5.x: .agents/skills always; .claude/skills for Claude Code users or a project that has .claude (both only swept now)', () => {
            const folder = '/work/proj';
            const project = (existing: string[], env: NodeJS.ProcessEnv = {}) =>
                getProjectSkillInstallRoots(folder, { env, home, exists: p => existing.includes(p) });
            assert.deepStrictEqual(project([]), {
                install: [path.join(folder, '.agents', 'skills')],
                sweepOnly: [path.join(folder, '.claude', 'skills')],
            });
            assert.deepStrictEqual(project([path.join(home, '.claude')]).install,
                [path.join(folder, '.agents', 'skills'), path.join(folder, '.claude', 'skills')]);
            assert.deepStrictEqual(project(['/cfg/claude'], { CLAUDE_CONFIG_DIR: '/cfg/claude' }).sweepOnly, []);
            assert.deepStrictEqual(project([path.join(folder, '.claude')]).install,
                [path.join(folder, '.agents', 'skills'), path.join(folder, '.claude', 'skills')]);
            assert.ok(!project([]).install.some(root => root.startsWith(home)), 'a project root never points into the home directory');
        });

        test('a workspace folder that is the home directory does not put the personal roots on the sweep list', () => {
            // Platform-neutral stand-in for the real-path lookup: one symlinked spelling, no drive letters.
            const same = (dir: string) => dir.replace(/^\/link\//, '/real/');
            const install = [path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills')];
            const project = getProjectSkillInstallRoots(home, { env: {}, home, exists: p => p === path.join(home, '.claude') });
            const swept = withoutInstallRoots([path.join(home, '.copilot', 'skills'), ...project.install, ...project.sweepOnly], install, same);
            assert.deepStrictEqual(swept, [path.join(home, '.copilot', 'skills')]);
            // Compared by canonical path: a symlinked spelling of an install root is dropped too, and duplicates collapse.
            const viaLink = withoutInstallRoots(['/link/u/.agents/skills', '/work/p/.agents/skills', '/work/p/.agents/skills'], ['/real/u/.agents/skills'], same);
            assert.deepStrictEqual(viaLink, ['/work/p/.agents/skills']);
        });

        test('writes to $COPILOT_HOME/skills only when the variable is set', () => {
            const custom = roots([], { COPILOT_HOME: '/cfg/copilot' });
            assert.ok(custom.install.includes(path.join('/cfg/copilot', 'skills')));
            assert.deepStrictEqual(custom.sweepOnly, [path.join(home, '.copilot', 'skills')]);
            const sameAsDefault = roots([], { COPILOT_HOME: path.join(home, '.copilot') });
            assert.ok(sameAsDefault.install.includes(path.join(home, '.copilot', 'skills')));
            assert.deepStrictEqual(sameAsDefault.sweepOnly, []);
        });
    });
});
